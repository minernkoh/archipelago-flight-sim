// Force-based flight dynamics for a Cessna-172-class light aircraft.
// Pure JS, no rendering deps — unit-testable under Node.
//
// Body frame: +x forward, +y up, +z right (right-handed).
// Body rates: p about +x (positive = roll right), q about +z (positive = pitch up),
//             r about +y (positive = yaw LEFT by right-hand rule — signs below account for it).

import {
  v3, vAdd, vSub, vScale, vDot, vCross, vLen, vNorm,
  qIdent, qMul, qRot, qRotInv, qIntegrate, qAxisAngle, clamp,
} from './vecmath.js';
import { gearForces } from './groundContact.js';
import { machDragRise, flapBlowback, updateDamage, speedOfSound } from './envelope.js';
import { AIRCRAFT } from '../aircraft/params.js';

export const G = 9.81;
export const RHO0 = 1.225;          // sea-level air density kg/m^3
export const KT = 1.94384;          // m/s -> knots
export const FT = 3.28084;          // m -> feet
// See the spanwise gust sampling in step(); tuned so the "gusty" preset gives
// the continuous 5-15 deg bank corrections that flying a light aircraft in
// wind actually involves.
const GUST_ROLL_GAIN = 8;

// The C172 preset doubles as the default aircraft and the v1-compat export.
export const PARAMS = AIRCRAFT.c172;


export function airDensity(alt) {
  const h = clamp(alt, 0, 11000);
  return RHO0 * Math.pow(1 - 2.2558e-5 * h, 4.2559);
}

// Lift coefficient with a soft stall break past alphaStall.
export function liftCoeff(alpha, flaps, p = PARAMS) {
  const aStall = p.alphaStall + p.flapStallShift * flaps;
  const cl0 = p.CL0 + p.flapCL * flaps;
  const a = alpha;
  const lin = cl0 + p.CLalpha * a;
  const clMax = cl0 + p.CLalpha * aStall;
  const clMin = cl0 - p.CLalpha * (aStall + 0.04); // inverted stall slightly later
  if (a > aStall) {
    // Post-stall: fall from CLmax toward ~55% over ~12 degrees, then hold.
    const t = clamp((a - aStall) / 0.21, 0, 1);
    return clMax * (1 - 0.45 * t);
  }
  if (a < -(aStall + 0.04)) {
    const t = clamp((-a - (aStall + 0.04)) / 0.21, 0, 1);
    return clMin * (1 - 0.45 * t);
  }
  return clamp(lin, clMin, clMax);
}

export function createAircraft(opts = {}) {
  // A full preset (see aircraft/params.js); partial opts.params still layers
  // over the C172 so v1 callers/tests keep working.
  const p = opts.params ? { ...AIRCRAFT.c172, ...opts.params } : { ...AIRCRAFT.c172 };
  const ac = {
    p,
    pos: opts.pos ? { ...opts.pos } : v3(0, 1000, 0),
    vel: opts.vel ? { ...opts.vel } : v3(55, 0, 0),
    q: opts.q ? { ...opts.q } : qIdent(),      // body -> world
    omega: v3(),                                // body rates rad/s
    // live telemetry (filled by step)
    alpha: 0, beta: 0, airspeed: 0, gLoad: 1, stalled: false,
    onGround: false, groundSpeed: 0, agl: 0,
    touchdown: null,        // {fpm, speedKt, onRunway} set on gear first contact
    crashed: false, crashReason: '',
    thrust: 0, rpmNorm: 0, spool: 0, abOn: false,
    // v4: fuel state (mass kept constant this phase — see step()), indicated
    // airspeed (freezes on pitot failure), and the systems/failure framework.
    fuelKg: p.fuel ? p.fuel.capacityKg : Infinity,
    fuelFrac: 1,
    iasIndicated: 0,
    eas: 0, mach: 0, damage: 0, damageCause: '', flapsEff: 0,
    systems: { engine: true, electrical: true, hydraulics: true, gear: true, pitot: true },
    // v5-R3: piston start/electrical state (only exercised for p.startup aircraft).
    // Defaults are ready-to-fly so every existing caller spawns hot.
    sys: { battery: true, mags: 'BOTH', mixture: 1 }, // player switch positions
    engineRunning: true,   // is the engine actually turning under its own power
    batteryCharge: 1,      // 0..1; alternator recharges, loads drain
    crankT: 0,             // seconds the starter has been engaged
    avionics: true,        // electrical power to instruments (battery or alternator)
  };
  // `ac.engineFailed` is a bidirectional alias of `systems.engine === false` so
  // existing callers (training.js lessons 8-9, wind.js, the reset path, the fuel
  // flameout below) keep reading and writing it unchanged.
  Object.defineProperty(ac, 'engineFailed', {
    get() { return ac.systems.engine === false; },
    set(v) { ac.systems.engine = !v; },
    enumerable: true, configurable: true,
  });
  return ac;
}

// Systems/failure framework. true = healthy. Engine + pitot have live
// consequences (see step); electrical/hydraulics/gear are wired as no-ops here
// and land their consequences in a later phase.
export function failSystem(ac, name) {
  if (ac.systems && name in ac.systems) ac.systems[name] = false;
}
export function resetSystems(ac) {
  ac.systems.engine = true;
  ac.systems.electrical = true;  // no-op consequence until a later phase
  ac.systems.hydraulics = true;  // no-op consequence until a later phase
  ac.systems.gear = true;        // no-op consequence until a later phase
  ac.systems.pitot = true;
  // Ready-to-fly: master on, mags BOTH, mixture rich, engine turning, full battery.
  ac.sys = { battery: true, mags: 'BOTH', mixture: 1 };
  ac.engineRunning = true; ac.batteryCharge = 1; ac.crankT = 0; ac.avionics = true;
}

// Cold & dark (v5-R3): master OFF, mags OFF, mixture cut, engine stopped. The
// player must run the start sequence. Battery is charged — it's just switched off.
export function setColdStart(ac) {
  ac.sys = { battery: false, mags: 'OFF', mixture: 0 };
  ac.engineRunning = false; ac.spool = 0; ac.crankT = 0;
  ac.batteryCharge = 1; ac.avionics = false;
}

// Piston start/electrical state machine. Only meaningful for p.startup aircraft;
// everything else just mirrors the engineFailed flag so behaviour is unchanged.
export function updateEngineSystems(ac, dt) {
  const p = ac.p;
  if (!p.startup) { ac.engineRunning = !ac.engineFailed; ac.avionics = true; return; }
  const s = ac.sys;
  const magsHot = s.mags === 'L' || s.mags === 'R' || s.mags === 'BOTH' || s.mags === 'START';
  const mixOk = s.mixture > 0.3;
  const fuelOk = ac.fuelKg > 0;
  if (ac.engineRunning) {
    // Runs on its own magnetos; quits if mags cut, mixture starved, out of fuel, or failed.
    if (!magsHot || !mixOk || !fuelOk || ac.engineFailed) ac.engineRunning = false;
  } else if (s.mags === 'START' && s.battery && ac.batteryCharge > 0.12 && mixOk && fuelOk && !ac.engineFailed) {
    ac.crankT += dt;                       // starter cranking
    if (ac.crankT > 1.6) { ac.engineRunning = true; ac.crankT = 0; }
  } else {
    ac.crankT = 0;
  }
  // Battery: alternator recharges while running; loads (and the starter) drain it when off.
  if (s.battery) {
    const rate = ac.engineRunning ? -0.05 : (0.008 + (s.mags === 'START' ? 0.06 : 0)); // per second
    ac.batteryCharge = Math.max(0, Math.min(1, ac.batteryCharge - rate * dt));
  }
  // Instruments have power from the battery (while charged) or the running alternator.
  ac.avionics = s.battery && (ac.batteryCharge > 0.1 || ac.engineRunning);
}

// controls: { elevator -1..1 (+=nose up), aileron -1..1 (+=roll right),
//             rudder -1..1 (+=nose right), throttle 0..1, flaps 0..1, brakes bool }
// env: { groundHeight(x,z)->m, isRunway(x,z)->bool }
export function step(ac, controls, env, dt) {
  if (ac.crashed) return;
  const p = ac.p;

  const rho = airDensity(ac.pos.y);
  // Aerodynamics see air-relative velocity; gear/ground speed stay inertial.
  const wind = env.wind ? env.wind(ac.pos.x, ac.pos.y, ac.pos.z) : null;
  const vBody = qRotInv(ac.q, wind ? vSub(ac.vel, wind) : ac.vel);
  const V = Math.max(vLen(vBody), 1e-3);
  const alpha = Math.atan2(-vBody.y, vBody.x);
  const beta = Math.asin(clamp(vBody.z / V, -1, 1));
  const qbar = 0.5 * rho * V * V;
  const qS = qbar * p.wingArea;
  // Equivalent airspeed and Mach drive every structural limit below. EAS is
  // computed unconditionally (unlike iasIndicated, which freezes on a pitot
  // failure) because the airframe feels the load whether the gauge shows it.
  const densityRatio0 = rho / RHO0;
  ac.eas = V * Math.sqrt(densityRatio0);
  ac.mach = V / speedOfSound(ac.pos.y);
  // Above Vfe the flaps blow back toward retracted rather than failing — the
  // aero reads flapsEff from here on, never controls.flaps. Exactly identity
  // at or below Vfe, so nothing in normal flight changes.
  const flapsEff = flapBlowback(ac.eas, controls.flaps, p);
  ac.flapsEff = flapsEff;
  // A stopped or windmilling propeller is a large flat-plate drag source. It
  // is why the POH glide (9.0 : 1) is so much worse than the clean airframe
  // (10.8 : 1) — modelling them as one number was what forced the old 12.4.
  const eng0 = p.engine;
  const windmillFrac = eng0.type === 'prop'
    ? (ac.engineFailed || (p.startup && !ac.engineRunning)
        ? 1 : Math.max(0, 1 - controls.throttle / 0.25))
    : 0;

  // --- Ground effect: reduce induced drag near the surface ---
  // Terrain-only height: overflying a rooftop shouldn't fake ground effect.
  const groundY = (env.terrainHeight ?? env.groundHeight)(ac.pos.x, ac.pos.z);
  const agl = ac.pos.y - groundY;
  const hb = clamp(agl / p.span, 0.03, 2);
  const geFactor = hb < 1 ? (16 * hb) ** 2 / (1 + (16 * hb) ** 2) : 1;
  // Small lift bump in ground effect: up to +5% at the surface, fading linearly
  // to identity (1.0) by agl = span, so it never adds energy above one span.
  const geLift = 1 + 0.05 * clamp(1 - hb, 0, 1);

  // --- Aerodynamic forces (computed in body frame) ---
  const CL = liftCoeff(alpha, flapsEff, p);
  // Angle of attack past the stall break. BOTH post-stall terms (separation
  // drag here, roll-damping reversal below) are built on `sep` and are
  // provably zero at or below the break, so nothing in normal flight — the
  // trimmed-cruise state hash included — ever sees them.
  const aStall = p.alphaStall + p.flapStallShift * flapsEff;
  const sep = Math.max(0, Math.abs(alpha) - aStall);
  // A separated wing behaves like a flat plate, CD climbing toward
  // 2*sin^2(alpha). Without this the polar stayed clean past the break (CD
  // ~0.10 at 24 deg alpha), so a stalled aircraft kept most of its lift, paid
  // almost no drag penalty and could mush indefinitely at 900 fpm instead of
  // falling out of the sky. Fully separated ~7 deg past the break.
  const sepBlend = clamp(sep / 0.12, 0, 1);
  const CD = p.CD0 + flapsEff * p.flapCD + p.kInduced * CL * CL * geFactor
           + 0.06 * Math.abs(beta)                     // sideslip drag
           + sepBlend * (p.CDstall ?? 2.0) * Math.sin(alpha) ** 2
           + machDragRise(ac.mach, p)    // transonic wave drag; zero below Mcrit
           + (eng0.windmillCD ?? 0) * windmillFrac;   // stopped/windmilling prop
  const wHat = vScale(vBody, 1 / V);                   // direction of motion (body)
  let side = vCross(wHat, v3(0, 1, 0));                // spanwise unit vector
  side = vLen(side) > 1e-4 ? vNorm(side) : v3(0, 0, 1);
  const liftDir = vNorm(vCross(side, wHat));           // perp to wind, in symmetry plane

  let F = vScale(liftDir, CL * qS * geLift);
  F = vAdd(F, vScale(wHat, -CD * qS));
  F = vAdd(F, vScale(v3(0, 0, 1), p.CYbeta * beta * qS));

  // --- Thrust: engine spools toward commanded throttle with lag tau ---
  const densityRatio = rho / RHO0;
  const eng = p.engine;
  // v5-R3: update the piston start/electrical state (no-op for hot aircraft).
  updateEngineSystems(ac, dt);
  // A startup aircraft only makes power when actually running; failed engine cuts all.
  const noPower = ac.engineFailed || (p.startup && !ac.engineRunning);
  const cmdThrottle = noPower ? 0 : controls.throttle;
  ac.spool += (cmdThrottle - ac.spool) * (1 - Math.exp(-dt / eng.tau));
  let thrust;
  if (eng.type === 'jet') {
    thrust = ac.spool * eng.maxThrust * densityRatio;
    ac.abOn = !!(eng.afterburner && ac.spool > 0.95 && controls.throttle > 0.95);
    if (ac.abOn) thrust *= eng.afterburner.mult;
    ac.rpmNorm = ac.spool;
  } else {
    const thrustAvail = Math.min(eng.staticThrust, eng.propEff * eng.powerW / Math.max(V, 12));
    thrust = ac.spool * thrustAvail * densityRatio;
    ac.abOn = false;
    if (p.startup && !ac.engineRunning) ac.rpmNorm = ac.crankT > 0 ? 0.1 : 0; // cranking blip or dead prop
    else ac.rpmNorm = 0.25 + 0.75 * ac.spool;
  }
  F = vAdd(F, v3(thrust, 0, 0));
  ac.thrust = thrust;

  // --- Fuel burn: thrust-specific consumption; empty tank flames the engine out.
  // Mass is kept CONSTANT this phase (burned fuel is tracked, not subtracted from
  // p.mass) so the c172 cruise state-hash guard stays byte-identical.
  if (p.fuel) {
    ac.fuelKg = Math.max(0, ac.fuelKg - thrust * p.fuel.tsfc * dt);
    ac.fuelFrac = ac.fuelKg / p.fuel.capacityKg;
    if (ac.fuelKg <= 0) ac.engineFailed = true; // flameout -> cmdThrottle 0 next step
  }

  // --- Moments (body frame) ---
  const b = p.span, c = p.chord;
  const pr = ac.omega.x, yr = ac.omega.y, qr = ac.omega.z; // roll, yaw, pitch rates
  const V2 = Math.max(V, 8);                                // control authority floor
  let stallMoment = 0;
  if (alpha > aStall) stallMoment = -0.35 * (alpha - p.alphaStall);

  // Control-authority softener (fly-by-wire q-scheduling): fast jets scale their
  // deflections down as dynamic pressure climbs past a reference so full stick at
  // high speed doesn't rip the airframe apart. Identity below qRef (min(1,...)),
  // so low-speed rotation/roll are untouched. Composes with the SAS block below.
  // Elevator scales the elevator+trim SUM so trim authority tracks stick authority.
  let elev = controls.elevator + (controls.trim || 0);
  let ail = controls.aileron;
  let rud = controls.rudder;
  if (p.controlSoften) {
    const r = Math.min(1, p.controlSoften.qRef / qbar);
    const soft = Math.pow(r, p.controlSoften.exp ?? 0.7);
    // Roll gets its own, gentler exponent. The softener is there to bound G,
    // which is an elevator problem; applying the same curve to aileron left
    // the Hornet rolling 163 deg/s against a real ~220 at 350 kt.
    const softAil = Math.pow(r, p.controlSoften.ailExp ?? p.controlSoften.exp ?? 0.7);
    elev *= soft; rud *= soft; ail *= softAil;
  }

  // Propwash: the tail of a single-engine prop sits in the slipstream, so both
  // elevator authority and pitch damping rise with power and fall away in the
  // glide. Capped, because the ratio diverges at the low-speed floor and an
  // uncapped value makes the elevator absurd on the takeoff roll.
  // Capped at 1.0, not 2.5: qWash scales Cmde, and CLAUDE.md's hard-won note
  // is that effective Cmde above ~0.55 over-rotates and strikes the tail. At
  // washFrac 0.20 and a 2.5 cap the C172's 0.50 became 0.72 and every takeoff
  // ended in a wing strike after rotation.
  const qWash = eng.type === 'prop' && p.washFrac
    ? 1 + p.washFrac * Math.min(1.0, 2 * thrust / (rho * (eng.discArea ?? 4.6) * Math.max(V, 8) ** 2))
    : 1;
  // Pitch about +z (positive = nose up). CmThrust is the nose-up moment that
  // comes with the slipstream itself — this whole coupling was missing, so
  // power changes did not move the nose at all.
  const Cm = p.Cm0 + p.Cmalpha * alpha + p.Cmq * qWash * (qr * c / (2 * V2))
           + p.Cmde * qWash * elev
           + p.CmFlap * flapsEff + stallMoment
           + (p.CmThrust ?? 0) * (qWash - 1);
  // Roll about +x (positive = roll right). Aileron + = roll right.
  //
  // Roll damping is evaluated as TWO WING STATIONS on the real lift curve
  // rather than the single linear `Clp * (pb/2V)` term, because a rolling
  // stalled wing is the whole mechanism behind autorotation: the down-going
  // wing sits at a higher local alpha, and once it is past the break it loses
  // lift while the up-going wing gains it, so damping first collapses and then
  // goes positive. That is a spin. The old linear term could not represent it,
  // which is why the stall was perfectly symmetric — measured roll 0.0 deg.
  //
  // Below the stall this is NOT an approximation of the old model, it IS the
  // old model: in the linear range clL - clR = -2*CLalpha*dA exactly, so
  // Cl_roll = -CLalpha*pr*rEff/(4*V2), and substituting rEff collapses it to
  // Clp*pr*b/(2*V2), term for term. That identity is what keeps normal
  // handling and the trimmed-cruise state hash untouched, and it is asserted
  // to 1e-12 in the physics suite.
  //
  // rEff is derived from Clp, not tuned: it is the spanwise station where the
  // strip pair reproduces the stored roll-damping derivative. The 1/8 is
  // textbook strip theory — two half-wings of area S/2 acting at +-b/4.
  const rEff = -2 * p.Clp * b / p.CLalpha;
  // A gust that differs across the span tilts the aircraft, and it does it
  // through the same two stations as the roll damping — so it inherits the
  // post-stall nonlinearity and CL saturation for free, with the right sign.
  // The wind used to be sampled once at the CG, so both wings always saw
  // identical air and turbulence could not roll you at all: hands-off in the
  // "gusty" 16G28 preset the total bank excursion was 5 degrees.
  //
  // The two samples are averaged nowhere — only their DIFFERENCE is used, and
  // the translational aerodynamics above still use the single CG sample. A
  // uniform wind field therefore contributes exactly zero here, which is what
  // keeps the airspeed/groundspeed split test structurally immune.
  let dAGust = 0;
  if (env.wind) {
    // Sampled at the WINGTIPS, not at rEff: a 1.9 m half-span sample on an
    // 11 m wing barely separates the two points, so the field looked uniform
    // whatever its content. Scaling the result back by rEff/(b/2) makes this
    // exactly equivalent for a linear gust gradient while capturing the real
    // spanwise structure of a non-linear one.
    const half = b / 2;
    const spanW = qRot(ac.q, v3(0, 0, half));
    const wR = env.wind(ac.pos.x + spanW.x, ac.pos.y + spanW.y, ac.pos.z + spanW.z);
    const wL = env.wind(ac.pos.x - spanW.x, ac.pos.y - spanW.y, ac.pos.z - spanW.z);
    // GUST_ROLL_GAIN compensates for the wind field being a smooth
    // interpolated noise function: real turbulence carries far more energy at
    // span scale than value noise does, so the raw two-point differential
    // comes out at only ~7% of full aileron at its peak and the aircraft
    // barely moves. The gain lives HERE, on the differential alone, and
    // deliberately not on the wind field itself — raising the field amplitude
    // to get the same roll would have doubled the vertical gust loading (g
    // swings of 0.0-2.4) to buy a couple of degrees of bank.
    dAGust = qRotInv(ac.q, vSub(wR, wL)).y / (2 * V2) * (rEff / half) * GUST_ROLL_GAIN;
  }
  const dA = pr * rEff / V2 + dAGust;               // local alpha increment, right wing
  const clR = liftCoeff(alpha + dA, flapsEff, p);
  const clL = liftCoeff(alpha - dA, flapsEff, p);
  const ClRoll = (clL - clR) / 8;
  // No real wing stalls perfectly symmetrically — rigging tolerance and the
  // propeller slipstream mean one wing always lets go a fraction before the
  // other, and which one is a fixed property of the airframe. The strip pair
  // above is symmetric at zero roll rate, so it needs something to amplify;
  // without a seed the aircraft just mushed wings-level forever at idle power.
  // Negative drops the LEFT wing, matching slipstream and torque on a single
  // prop. Gated on sepBlend, so it is exactly zero in normal flight.
  const Cl = p.Clbeta * beta + ClRoll + p.Clda * ail
           + p.Clr * (-yr * b / (2 * V2))
           + (p.stallAsym ?? 0) * sepBlend;
  // Yaw about +y (positive = nose LEFT). Rudder + = nose right -> negative Cn_y.
  // CnAdverse: rolling right drags the nose left (adverse yaw) -> positive M.y.
  // Pro-spin yaw: past the break the dropping wing's drag is dominated by the
  // separation term, so the same two stations give the drag differential that
  // yaws the nose toward the low wing and sustains the rotation. Uses the same
  // sepBlend gate, so it contributes exactly nothing below the stall.
  const sepAt = (a) => clamp((Math.max(0, Math.abs(a) - aStall)) / 0.12, 0, 1)
                     * (p.CDstall ?? 2.0) * Math.sin(a) ** 2;
  const stallYaw = sepBlend > 0
    ? (p.stallYawGain ?? 0.04) * (sepAt(alpha + dA) - sepAt(alpha - dA))
    : 0;
  // Rudder effectiveness fades as sideslip builds: at large slip the fin is
  // working in its own wake and the rudder stalls. Without it the fleet's
  // Cndr/Cnbeta ratio let full rudder settle at 39-57 deg of steady sideslip
  // (a real forward slip in a light single is 15-20), which made the yaw axis
  // feel loose and slips cartoonish. Faded here rather than by cutting Cndr,
  // because Cndr also buys the crosswind de-crab that flight-school lesson 7
  // grades — at the ~12 deg of slip that needs, 67% of rudder authority
  // remains. rud is zero in the trimmed-cruise case, so this cannot move the
  // state hash.
  const rudFade = 1 / (1 + (Math.abs(beta) / (p.betaRudFade ?? 0.30)) ** 2);
  const CnAero = p.Cnbeta * beta + p.Cndr * rud * rudFade - p.CnAdverse * ail + stallYaw;
  const CnY = -CnAero + p.Cnr * (yr * b / (2 * V2)); // Cnr < 0 opposes yaw rate
  // Left-turning tendency. The old single term produced ~6.6 N.m at full
  // power against ~7,400 N.m of full rudder — 0.09% of rudder authority — so
  // the aircraft tracked the centreline hands-off and no rudder was ever
  // needed. Four real effects now, all sized against rudder authority:
  //   swirl    slipstream corkscrewing onto the fin; strongest slow and loud
  //   pFactor  descending blade bites harder at high alpha
  //   torque   the airframe rolls against the propeller
  //   gyro     precession: pitching the tail up yaws the nose left
  const fx = p.propfx;
  let propYaw = 0, gyroPitch = 0;
  if (eng.type === 'prop' && fx) {
    // Slipstream swirl falls away steeply with speed: an airframe is rigged
    // (wing washout, offset fin) to fly straight at CRUISE, so what the pilot
    // actually feels is a takeoff/climb/slow-flight effect. The falloff has to
    // be this steep — a gentler 25/V left a standing 0.1 deg sideslip at
    // cruise which the dihedral effect turned into 12 deg of bank in 20 s
    // hands-off. Real aircraft answer that with rudder trim; this one has none.
    const slow = Math.min(1, 18 / Math.max(V, 1)) ** 4;
    const raw = fx.swirl * ac.thrust * slow * 1.25
              + fx.pFactor * ac.thrust * Math.sin(Math.max(0, alpha)) * 0.5;
    // Bounded by the rudder authority available to correct it — which is what
    // certification actually guarantees. Unbounded, the couple exceeded full
    // rudder below ~15 kt and swung the aircraft off the runway before it
    // reached flying speed.
    const rudderAuth = p.Cndr * qbar * p.wingArea * b;
    propYaw = Math.min(raw, 0.05 * rudderAuth);
    // NOTE: engine torque roll is deliberately NOT modelled. It is a constant
    // rolling moment and this sim gives the player no aileron trim to hold
    // against it — hands-off it just integrates into bank (17 deg in 20 s at
    // cruise power) and rolls a wing into the ground shortly after rotation.
    // The stall departure it would have seeded is handled deterministically by
    // p.stallAsym instead. Revisit if an aileron-trim axis is ever added.
    const h = (fx.gyroH ?? 0) * ac.rpmNorm;   // angular momentum of the prop, +x
    gyroPitch = yr * h;                        // M.z += r*h
    propYaw -= qr * h;                         // M.y -= q*h  (tail up -> nose left)
  }

  // Stability augmentation (fly-by-wire): artificial damping/stiffness for
  // airframes with none of their own. Gated off at taxi speed so it doesn't
  // fight the gear. Signs: M.y positive = nose LEFT.
  let sasCn = 0, sasCm = 0;
  if (p.sas && V > 25) {
    sasCn = -p.sas.yawDamper * (yr * b / (2 * V2)) - (p.sas.betaGain || 0) * beta;
    sasCm = -(p.sas.pitchDamper || 0) * (qr * c / (2 * V2));
  }

  let M = v3(
    Cl * qbar * p.wingArea * b,
    (CnY + sasCn) * qbar * p.wingArea * b + propYaw,
    (Cm + sasCm) * qbar * p.wingArea * c + gyroPitch - thrust * (p.thrustArmY ?? 0),
  );

  // --- Gravity ---
  let Fworld = qRot(ac.q, F);
  Fworld = vAdd(Fworld, v3(0, -p.mass * G, 0));

  // --- Landing gear / ground contact ---
  const gear = gearForces(ac, controls, env, dt);
  Fworld = vAdd(Fworld, gear.force);
  M = vAdd(M, gear.momentBody);

  // --- Integrate (semi-implicit Euler) ---
  const acc = vScale(Fworld, 1 / p.mass);
  ac.vel = vAdd(ac.vel, vScale(acc, dt));
  ac.pos = vAdd(ac.pos, vScale(ac.vel, dt));

  // Euler's equations with diagonal inertia
  const I = { x: p.Ix, y: p.Iy, z: p.Iz };
  const w = ac.omega;
  const gyro = vCross(w, v3(I.x * w.x, I.y * w.y, I.z * w.z));
  ac.omega = vAdd(w, vScale(v3(
    (M.x - gyro.x) / I.x,
    (M.y - gyro.y) / I.y,
    (M.z - gyro.z) / I.z,
  ), dt));
  // Numerical safety: hard-clamp runaway rates so a departure can't blow the
  // integrator up. This is a NUMERICAL guard, not a flight-model limit — it
  // used to sit at 6 rad/s, which silently capped the Extra 300 (a real one
  // rolls at ~7.3 rad/s) and the Hornet, so the clamp rather than aerodynamics
  // was setting their maximum roll rate. 12 rad/s clears every legitimate rate
  // in the fleet while still catching genuine divergence.
  const wl = vLen(ac.omega);
  if (wl > 12) ac.omega = vScale(ac.omega, 12 / wl);
  ac.q = qIntegrate(ac.q, ac.omega, dt);

  // --- Telemetry ---
  ac.alpha = alpha; ac.beta = beta; ac.airspeed = V;
  // Indicated airspeed (EAS ~ TAS * sqrt(rho/rho0)). A failed pitot freezes the
  // gauge at its last value while true airspeed keeps updating.
  if (ac.systems.pitot !== false) ac.iasIndicated = V * Math.sqrt(densityRatio);
  ac.agl = agl;
  ac.groundSpeed = Math.hypot(ac.vel.x, ac.vel.z);
  ac.stalled = V > 15 && alpha > aStall && !ac.onGround;
  // How much angle of attack is left before the break. Negative = stalled.
  // Drives the stall WARNING annunciator, which the model had no concept of —
  // the red STALL light was the first and only cue, with no margin ahead of it.
  ac.alphaMargin = aStall - alpha;
  const upBody = qRot(ac.q, v3(0, 1, 0));
  const nonGravF = vSub(Fworld, v3(0, -p.mass * G, 0));
  ac.gLoad = vDot(nonGravF, upBody) / (p.mass * G); // ~1 in level flight
  ac.onGround = gear.contacts > 0;

  // Structural limits: Vne and g. Reads telemetry, never touches forces.
  updateDamage(ac, dt);

  if (gear.crash) { ac.crashed = true; ac.crashReason = gear.crash; }
  if (!Number.isFinite(ac.pos.x + ac.pos.y + ac.pos.z + ac.vel.x + ac.vel.y + ac.vel.z)) {
    ac.crashed = true; ac.crashReason = 'numerical';
  }
}

// Convenience: yaw-pitch-roll (heading rad from +x east toward -z north CW... game uses it for HUD)
export function attitude(ac) {
  const fwd = qRot(ac.q, v3(1, 0, 0));
  const up = qRot(ac.q, v3(0, 1, 0));
  const right = qRot(ac.q, v3(0, 0, 1));
  const pitch = Math.asin(clamp(fwd.y, -1, 1));
  const heading = Math.atan2(-fwd.z, fwd.x); // 0 = east, increases turning north(ccw from above)
  const roll = Math.atan2(right.y, up.y) * -1;
  return { pitch, roll, heading };
}

export function resetOnRunway(ac, runway) {
  // runway: { x, z, y, headingRad } — place at threshold, engine idle, stationary.
  // Rest attitude comes from the aircraft (taildraggers sit tail-low), and rest
  // height puts the lowest gear point just on the surface.
  const pitch = ac.p.spawn?.pitch ?? 0;
  ac.q = qMul(qAxisAngle(v3(0, 1, 0), runway.headingRad), qAxisAngle(v3(0, 0, 1), pitch));
  let lowest = -ac.p.gearHeight;
  for (const g of ac.p.gear) {
    const local = qRot(qAxisAngle(v3(0, 0, 1), pitch), g.r); // pitch only; yaw doesn't change y
    lowest = Math.min(lowest, local.y);
  }
  ac.pos = v3(runway.x, runway.y - lowest + 0.02, runway.z);
  ac.vel = v3(0, 0, 0);
  ac.omega = v3();
  ac.crashed = false; ac.crashReason = '';
  ac.touchdown = null; ac.stalled = false;
  ac.spool = 0; ac.abOn = false;
  resetSystems(ac);           // clears engineFailed (alias) + all system failures
  if (ac.p.fuel) { ac.fuelKg = ac.p.fuel.capacityKg; ac.fuelFrac = 1; }
  ac.iasIndicated = 0;
  ac._airTime = 0; // spawning on the gear is not a landing
}
