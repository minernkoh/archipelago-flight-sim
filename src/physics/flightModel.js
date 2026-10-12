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
    // v12: every entry now has a consequence (see failSystem). power = full
    // engine power available; flaps = flap drive; vacuum = the steam gyros'
    // vacuum pump; static = the static port (altimeter + VSI).
    systems: { engine: true, electrical: true, hydraulics: true, gear: true, pitot: true,
      power: true, flaps: true, vacuum: true, static: true, oil: true },
    altIndicated: opts.pos ? opts.pos.y : 1000, vsIndicated: 0,   // static-port instruments
    gyro: null,            // drifting gyro attitude after a vacuum failure, else null
    // circuit breakers the pilot can pull (cockpit.js): avionics bus, autopilot, flap motor
    breakers: { avn: true, ap: true, flap: true, lts: true, com: true, xpdr: true, tc: true, pitot: true, altFld: true },
    // v5-R3: piston start/electrical state (only exercised for p.startup aircraft).
    // Defaults are ready-to-fly so every existing caller spawns hot.
    // player switch positions (v12: fuel selector and light switches)
    sys: { battery: true, mags: 'BOTH', mixture: 1, fuel: 'BOTH', lights: { land: true, nav: true, strobe: true, beacon: true },
      carbHeat: false, primes: 2, xpdr: 1200, alt: true, avMaster: true },
    carbIce: 0,            // 0..1 carburettor ice (start-up piston aircraft, moist air, low power)
    fuelStarveT: 0,        // seconds the fuel selector has been OFF (the lines run dry after ~12 s)
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

// Systems/failure framework. true = healthy. Consequences (v12, see step and
// updateEngineSystems; failures.js schedules them):
//   engine      total power loss              power     ~50% power, running rough
//   electrical  alternator dead: the battery  pitot     IAS freezes
//               runs the avionics ~7 min      static    altimeter freezes, VSI reads 0
//   vacuum      AI/HI spin down and drift     flaps     flaps jam where they are
//   hydraulics  (jets) flaps jam              gear      reserved: gear is not yet simulated
// Only failed systems take a different code path, so healthy flight (and the
// cruise state hash) is untouched.
export function failSystem(ac, name) {
  if (!ac.systems || !(name in ac.systems)) return;
  ac.systems[name] = false;
  if (name === 'flaps' || name === 'hydraulics') ac._flapJam = ac.flapsEff ?? 0;
  if (name === 'vacuum') {
    const a = attitude(ac);
    ac.gyro = { pitch: a.pitch, roll: a.roll, heading: a.heading, t: 0, dir: Math.sin(a.heading * 7 + a.pitch * 3) >= 0 ? 1 : -1 };
  }
}
export function resetSystems(ac) {
  ac.systems.engine = true;
  ac.systems.electrical = true;  // no-op consequence until a later phase
  ac.systems.hydraulics = true;  // no-op consequence until a later phase
  ac.systems.gear = true;        // no-op consequence until a later phase
  ac.systems.pitot = true;
  ac.systems.power = true; ac.systems.flaps = true; ac.systems.vacuum = true; ac.systems.static = true;
  ac.systems.oil = true;
  ac._flapJam = null; ac.gyro = null;
  ac.oilQty = 1; ac.oilT = null; ac.oilLowT = 0;      // oil warms up again from the next update
  ac.cht = null; ac.chtRate = 0; ac.shockCooling = false; ac.engineWear = 0; ac.pitotIce = 0; ac.screenMist = 0;   // a fresh engine on every respawn
  ac.breakers = { avn: true, ap: true, flap: true, lts: true, com: true, xpdr: true, tc: true, pitot: true, altFld: true };
  // Ready-to-fly: master on, mags BOTH, mixture rich, engine turning, full battery.
  ac.sys = { battery: true, mags: 'BOTH', mixture: 1, fuel: 'BOTH', lights: { land: true, nav: true, strobe: true, beacon: true },
    carbHeat: false, primes: 2, xpdr: 1200, altStatic: false, cabinHeat: false, vent: false,
    pitotHeat: !(ac.p && ac.p.startup), alt: true, avMaster: true };   // transport/fighter probes are always heated
  ac.fuelStarveT = 0; ac.carbIce = 0;
  ac.engineRunning = true; ac.batteryCharge = 1; ac.crankT = 0; ac.avionics = true;
}

// Cold & dark (v5-R3): master OFF, mags OFF, mixture cut, engine stopped. The
// player must run the start sequence. Battery is charged — it's just switched off.
export function setColdStart(ac) {
  ac.sys = { battery: false, mags: 'OFF', mixture: 0, fuel: 'BOTH', lights: { land: false, nav: false, strobe: false, beacon: false },
    carbHeat: false, primes: 0, xpdr: 1200, altStatic: false, cabinHeat: false, vent: false, pitotHeat: false,   // a cold engine wants priming
    alt: true, avMaster: true };
  ac.engineRunning = false; ac.spool = 0; ac.crankT = 0;
  ac.batteryCharge = 1; ac.avionics = false;
  ac.oilT = 59; ac.oilP = 0; ac.oilQty = 1; ac.oilLowT = 0;   // a cold engine: oil at ambient
  ac.cht = [70, 70, 70, 70]; ac.egt = 70;
}

// Oil system (piston engines, v12): pressure follows rpm, reads high on cold
// oil and needs oil in the sump; temperature warms toward a power-dependent
// value and is cooled by airspeed. An oil leak (systems.oil false) pumps the
// sump overboard in ~4 min; starved below 10 psi for 40 s, the engine seizes.
// Gauges only, so healthy flight and the cruise state hash are untouched.
function updateOil(ac, dt, throttle) {
  if (ac.p.engine?.type === 'jet') return;
  if (ac.oilT == null) ac.oilT = ac.engineRunning ? 180 : 59;      // spawned running: already warm
  if (ac.oilP == null) ac.oilP = ac.engineRunning ? 60 : 0;
  if (ac.oilQty == null) ac.oilQty = 1;
  if (ac.oilLowT == null) ac.oilLowT = 0;
  if (ac.systems.oil === false && ac.engineRunning) ac.oilQty = Math.max(0, ac.oilQty - dt / 240);
  const supply = Math.min(1, ac.oilQty / 0.35);
  const cold = Math.max(0, Math.min(1, (180 - ac.oilT) / 120));
  const target = ac.engineRunning ? (25 + 55 * Math.min(1, (ac.rpmNorm || 0) * 1.15) + 18 * cold) * supply : 0;
  ac.oilP += (target - ac.oilP) * Math.min(1, dt / (ac.engineRunning ? 0.8 : 1.5));
  const kt = vLen(ac.vel) * 1.9438;
  const eqT = ac.engineRunning ? 150 + 85 * throttle - 0.3 * Math.max(0, kt - 60) + 90 * (1 - supply) : 59;
  ac.oilT += (eqT - ac.oilT) * Math.min(1, dt / (ac.engineRunning ? 200 : 900));
  ac.oilLowT = ac.engineRunning && ac.oilP < 10 ? ac.oilLowT + dt : 0;
  if (ac.oilLowT > 40) ac.systems.engine = false;              // seized
}

// Mixture (start-up pistons, v12). `r` = mixture setting over the best-power
// setting for this air density (full rich IS best power at sea level and grows
// richer with altitude, so leaning pays off up high). Power peaks at r = 1,
// falls slowly rich and fast lean; the engine runs rough below r 0.75 and
// quits below 0.55. Exhaust gas temperature peaks a little lean of best power.
// Everything is normalised to FULL RICH: at mixture 1 the power and fuel-flow
// multipliers are exactly 1, so healthy flight and the cruise hash are untouched.
const mixPower = (r) => r >= 1 ? Math.max(0, 1 - 0.5 * (r - 1) * (r - 1))
  : r >= 0.8 ? 1 - 2.2 * (1 - r) * (1 - r) : Math.max(0, 0.912 * (r - 0.55) / 0.25);
export function mixtureState(mixture, rho) {
  const ideal = Math.min(1, rho / RHO0);
  const r = mixture / ideal;
  const power = mixPower(r) / mixPower(1 / ideal);
  // EGT (deg F): peak ~1450 at r 0.93, cooler rich (excess fuel) and lean (less heat)
  const dr = r - 0.93;
  const egtShape = 1 - (dr > 0 ? 0.55 : 1.6) * dr * dr;
  return { r, power, fuelFlow: mixture, egtShape, rough: r < 0.75, quits: r < 0.55 };
}

// Cylinder heads (start-up pistons, v12): four CHTs heated by the exhaust and
// cooled by the airflow over the fins, each with its own offset (the rear
// cylinders run hot). Shock cooling (the hottest head falling faster than
// 50 F/min, e.g. a power-off descent at speed) and heads over 460 F add to
// `engineWear` (0..1), which costs power. Healthy flight never wears it, so
// the cruise hash is untouched.
const CHT_OFFSET = [-14, 4, 18, -6];
function updateCylinders(ac, dt, V) {
  const kt = V * 1.9438;
  if (!ac.cht) ac.cht = CHT_OFFSET.map(o => (ac.engineRunning ? 360 : 70) + (ac.engineRunning ? o : 0));
  const hot0 = Math.max(...ac.cht);
  for (let i = 0; i < 4; i++) {
    const target = ac.engineRunning
      ? 70 + (ac.egt - 70) * 0.27 + CHT_OFFSET[i] - 0.9 * Math.max(0, kt - 70)
      : 70;
    // heads heat in ~90 s; the fins shed heat faster at speed
    const tau = target > ac.cht[i] ? 90 : Math.max(25, 160 - kt);
    ac.cht[i] += (target - ac.cht[i]) * Math.min(1, dt / tau);
  }
  const hot = Math.max(...ac.cht);
  const rate = dt > 0 ? (hot - hot0) / dt * 60 : 0;            // F per minute
  ac.chtRate = (ac.chtRate ?? 0) + (rate - (ac.chtRate ?? 0)) * Math.min(1, dt / 3);
  ac.shockCooling = ac.engineRunning && ac.chtRate < -50 && hot > 200;
  let wear = 0;
  if (ac.shockCooling) wear += (-ac.chtRate - 50) * 2e-6 * dt;
  if (hot > 460) wear += (hot - 460) * 4e-6 * dt;
  if (wear > 0) ac.engineWear = Math.min(1, (ac.engineWear || 0) + wear);
}

// Electrical load on the bus (amps) for a start-up aircraft: instruments and
// annunciators, the avionics (radios, AP, transponder) when their master and
// breaker are in, each exterior light that is on, and pitot heat. Battery drain
// without the alternator is proportional to it (game-compressed: ~6 min with
// everything on, ~50 min shed to the essentials).
export const BATT_PER_AMP = 0.0001;
export function electricalLoad(ac) {
  const s = ac.sys || {}, b = ac.breakers || {};
  let a = 3;
  if (s.avMaster !== false && b.avn !== false) a += 7;
  if (b.lts !== false && s.lights) a += (s.lights.land ? 8 : 0) + (s.lights.nav ? 3 : 0) + (s.lights.strobe ? 3 : 0) + (s.lights.beacon ? 2 : 0);
  if (s.pitotHeat && b.pitot !== false) a += 10;
  return a;
}

// Piston start/electrical state machine. Only meaningful for p.startup aircraft;
// everything else just mirrors the engineFailed flag so behaviour is unchanged.
export function updateEngineSystems(ac, dt, env = null, throttle = 0) {
  const p = ac.p;
  if (!p.startup) {
    ac.engineRunning = !ac.engineFailed;
    if (ac.systems.electrical === false) {
      // alternator / generators dead: the battery carries the avionics ~7 min
      ac.batteryCharge = Math.max(0, ac.batteryCharge - 0.0021 * dt);
      ac.avionics = ac.batteryCharge > 0.1;
    } else ac.avionics = true;
    if (ac.sys && ac.sys.avMaster === false) ac.avionics = false;        // avionics master off
    if (ac.breakers && ac.breakers.avn === false) ac.avionics = false;   // breaker pulled
    updateOil(ac, dt, throttle);
    return;
  }
  const s = ac.sys;
  const magsHot = s.mags === 'L' || s.mags === 'R' || s.mags === 'BOTH' || s.mags === 'START';
  const mx = mixtureState(s.mixture, airDensity(ac.pos.y));
  ac.mixRatio = mx.r; ac.mixRough = ac.engineRunning && mx.rough;
  const mixOk = s.mixture > 0.3 && !mx.quits;
  // fuel selector OFF: the engine runs on what is in the lines for ~12 s, then starves
  ac.fuelStarveT = s.fuel === 'OFF' ? (ac.fuelStarveT || 0) + dt : 0;
  const fuelOk = ac.fuelKg > 0 && ac.fuelStarveT < 12;
  // Carburettor ice: moist air (env.carbIceRisk 0..1: the weather) cools the
  // venturi most at low power; ice chokes the engine until it quits. Carb heat
  // melts it at the price of ~10% power. Healthy dry air = risk 0 = untouched.
  const risk = env && env.carbIceRisk ? env.carbIceRisk : 0;
  // Windscreen mist: moist air (the same weather risk) condenses on the cool
  // glass over a few minutes; CABIN HT (the defrost) clears it in ~30 s, and
  // dry air slowly does too. Cosmetic: weather.js draws it in the cockpit.
  ac.screenMist = Math.max(0, Math.min(1, (ac.screenMist || 0) + dt * (
    s.cabinHeat ? -1 / 25 : s.vent ? -1 / 60 : risk > 0 ? risk / 200 : -1 / 120)));
  if (ac.engineRunning && (risk > 0 || ac.carbIce > 0 || s.carbHeat)) {
    if (s.carbHeat) ac.carbIce = Math.max(0, ac.carbIce - 0.02 * dt);
    else ac.carbIce = Math.min(1, ac.carbIce + risk * 0.0045 * (1.15 - 0.75 * throttle) * dt);
  }
  if (ac.engineRunning) {
    // Runs on its own magnetos; quits if mags cut, mixture starved, out of fuel, iced, or failed.
    if (!magsHot || !mixOk || !fuelOk || ac.engineFailed || ac.carbIce > 0.95) ac.engineRunning = false;
  } else if (s.mags === 'START' && s.battery && ac.batteryCharge > 0.12 && mixOk && fuelOk && !ac.engineFailed) {
    ac.crankT += dt;                       // starter cranking
    // primer: 1-3 strokes catch at once; unprimed it takes longer; over-primed it floods
    const pr = s.primes ?? 2, need = pr === 0 ? 3.5 : pr <= 3 ? 1.6 : 6.0;
    if (ac.crankT > need) { ac.engineRunning = true; ac.crankT = 0; s.primes = 0; }
  } else {
    ac.crankT = 0;
  }
  // Battery: the alternator recharges it while running; without the alternator
  // the bus load (electricalLoad) drains it, so shedding load is what buys time.
  // The alternator charges only with the ALT half of the split master on and
  // its field breaker in; the starter draws ~60 A on top.
  const charging = ac.engineRunning && ac.systems.electrical !== false && s.alt !== false && ac.breakers?.altFld !== false;
  ac.charging = !!(s.battery && charging);
  if (s.battery) {
    const rate = charging ? -0.05 : BATT_PER_AMP * electricalLoad(ac) + (s.mags === 'START' ? 0.06 : 0); // per second
    ac.batteryCharge = Math.max(0, Math.min(1, ac.batteryCharge - rate * dt));
  }
  // Instruments have power from the battery (while charged) or the running alternator.
  ac.avionics = s.battery && (ac.batteryCharge > 0.1 || charging);
  if (s.avMaster === false) ac.avionics = false;                        // avionics master off
  if (ac.breakers && ac.breakers.avn === false) ac.avionics = false;   // breaker pulled
  updateOil(ac, dt, throttle);
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
  let flapsEff = flapBlowback(ac.eas, controls.flaps, p);
  // jammed flaps (flap motor, or hydraulics on the jets) stay where they were
  if (ac.systems.flaps === false || (ac.systems.hydraulics === false && p.engine.type === 'jet') || (ac.breakers && ac.breakers.flap === false)) {
    if (ac._flapJam == null) ac._flapJam = ac.flapsEff ?? 0;
    flapsEff = ac._flapJam;
  } else if (ac._flapJam != null) ac._flapJam = null;    // breaker reset: the motor runs again
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
  updateEngineSystems(ac, dt, env, controls.throttle);
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
    // mag check: one magneto fires one plug per cylinder, a slower burn: ~75 rpm drop at run-up
    if (p.startup && ac.engineRunning && (ac.sys.mags === 'L' || ac.sys.mags === 'R')) { ac.rpmNorm *= 0.94; thrust *= 0.95; }
  }
  if (ac.systems.power === false && !noPower) thrust *= 0.5;   // rough-running engine
  if (p.startup && (ac.carbIce > 0 || ac.sys.carbHeat)) thrust *= (1 - 0.6 * ac.carbIce) * (ac.sys.carbHeat ? 0.9 : 1);
  let fuelMix = 1;
  if (p.startup && ac.sys.mixture !== 1) {
    const mx = mixtureState(ac.sys.mixture, rho);
    thrust *= mx.power; fuelMix = mx.fuelFlow;
  }
  if (p.startup) {
    // EGT gauge: rises with power, shaped by the mixture; ambient when stopped
    const mx = mixtureState(ac.sys.mixture, rho);
    const target = ac.engineRunning ? (900 + 600 * (0.3 + 0.7 * ac.spool)) * mx.egtShape : 70;
    ac.egt = (ac.egt ?? target) + (target - (ac.egt ?? target)) * Math.min(1, dt / 6);
    updateCylinders(ac, dt, V);
  }
  // engine wear (shock cooling, over-temperature) costs power; zero when healthy
  if (ac.engineWear > 0) thrust *= 1 - 0.35 * ac.engineWear;
  F = vAdd(F, v3(thrust, 0, 0));
  ac.thrust = thrust;

  // --- Fuel burn: thrust-specific consumption; empty tank flames the engine out.
  // Mass is kept CONSTANT this phase (burned fuel is tracked, not subtracted from
  // p.mass) so the c172 cruise state-hash guard stays byte-identical.
  if (p.fuel) {
    ac.fuelKg = Math.max(0, ac.fuelKg - thrust * p.fuel.tsfc * dt * fuelMix);
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
  // Pitot icing (v12): visible moisture (in cloud, or rain) below +5 C OAT
  // (ISA) ices the pitot tube in about a minute and freezes the airspeed
  // indicator, as a blocked pitot does; PITOT HT prevents and clears it
  // (dead with its breaker out). Never happens in dry or warm air.
  const oat = 15 - 0.0065 * ac.pos.y;
  const moist = Math.max(env.inCloud || 0, 0.35 * (env.carbIceRisk || 0));
  const heat = ac.sys?.pitotHeat && ac.breakers?.pitot !== false;
  if (heat) ac.pitotIce = Math.max(0, (ac.pitotIce || 0) - dt / 15);
  else if (moist > 0 && oat < 5) ac.pitotIce = Math.min(1, (ac.pitotIce || 0) + moist * dt / 60);
  if (ac.systems.pitot !== false && !((ac.pitotIce || 0) > 0.9)) ac.iasIndicated = V * Math.sqrt(densityRatio);
  // Static port: a blocked one freezes the altimeter and zeroes the VSI.
  if (ac.systems.static !== false) { ac.altIndicated = ac.pos.y; ac.vsIndicated = ac.vel.y; }
  else if (ac.sys?.altStatic) {
    // alternate static source: cabin pressure is a little below ambient (the
    // slipstream sucks on the cabin), so the altimeter reads ~50 ft high, the
    // VSI works again (POH: up to 50 ft, a few knots high with vents closed)
    ac.altIndicated = ac.pos.y + 15; ac.vsIndicated = ac.vel.y;
  } else ac.vsIndicated = 0;
  // Vacuum pump: the gyros spin down over a couple of minutes and the
  // attitude and heading indications wander off with growing drift.
  if (ac.gyro) {
    const g = ac.gyro;
    g.t += dt;
    const k = Math.min(1, g.t / 120);                  // spin-down
    g.roll += g.dir * (0.035 * k + 0.004) * dt;                // rad/s, settles into a lazy bank
    g.pitch += (-0.012 * k) * dt * Math.sign(Math.sin(g.t * 0.05) + 0.3);
    g.heading += g.dir * 0.02 * k * dt;
    g.roll = clamp(g.roll, -1.4, 1.4); g.pitch = clamp(g.pitch, -0.6, 0.6);
  }
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
