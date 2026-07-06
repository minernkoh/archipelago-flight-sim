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
import { AIRCRAFT } from '../aircraft/params.js';

export const G = 9.81;
export const RHO0 = 1.225;          // sea-level air density kg/m^3
export const KT = 1.94384;          // m/s -> knots
export const FT = 3.28084;          // m -> feet

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
  return {
    // A full preset (see aircraft/params.js); partial opts.params still layers
    // over the C172 so v1 callers/tests keep working.
    p: opts.params ? { ...AIRCRAFT.c172, ...opts.params } : { ...AIRCRAFT.c172 },
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
  };
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

  // --- Ground effect: reduce induced drag near the surface ---
  // Terrain-only height: overflying a rooftop shouldn't fake ground effect.
  const groundY = (env.terrainHeight ?? env.groundHeight)(ac.pos.x, ac.pos.z);
  const agl = ac.pos.y - groundY;
  const hb = clamp(agl / p.span, 0.03, 2);
  const geFactor = hb < 1 ? (16 * hb) ** 2 / (1 + (16 * hb) ** 2) : 1;

  // --- Aerodynamic forces (computed in body frame) ---
  const CL = liftCoeff(alpha, controls.flaps, p);
  const CD = p.CD0 + controls.flaps * p.flapCD + p.kInduced * CL * CL * geFactor
           + 0.06 * Math.abs(beta);                    // sideslip drag
  const wHat = vScale(vBody, 1 / V);                   // direction of motion (body)
  let side = vCross(wHat, v3(0, 1, 0));                // spanwise unit vector
  side = vLen(side) > 1e-4 ? vNorm(side) : v3(0, 0, 1);
  const liftDir = vNorm(vCross(side, wHat));           // perp to wind, in symmetry plane

  let F = vScale(liftDir, CL * qS);
  F = vAdd(F, vScale(wHat, -CD * qS));
  F = vAdd(F, vScale(v3(0, 0, 1), p.CYbeta * beta * qS));

  // --- Thrust: engine spools toward commanded throttle with lag tau ---
  const densityRatio = rho / RHO0;
  const eng = p.engine;
  const cmdThrottle = ac.engineFailed ? 0 : controls.throttle; // trainer can fail the engine
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
    ac.rpmNorm = 0.25 + 0.75 * ac.spool;
  }
  F = vAdd(F, v3(thrust, 0, 0));
  ac.thrust = thrust;

  // --- Moments (body frame) ---
  const b = p.span, c = p.chord;
  const pr = ac.omega.x, yr = ac.omega.y, qr = ac.omega.z; // roll, yaw, pitch rates
  const V2 = Math.max(V, 8);                                // control authority floor
  let stallMoment = 0;
  if (alpha > p.alphaStall + p.flapStallShift * controls.flaps) stallMoment = -0.35 * (alpha - p.alphaStall);

  // Pitch about +z (positive = nose up)
  const Cm = p.Cm0 + p.Cmalpha * alpha + p.Cmq * (qr * c / (2 * V2))
           + p.Cmde * (controls.elevator + (controls.trim || 0))
           + p.CmFlap * controls.flaps + stallMoment;
  // Roll about +x (positive = roll right). Aileron + = roll right.
  const Cl = p.Clbeta * beta + p.Clp * (pr * b / (2 * V2)) + p.Clda * controls.aileron
           + p.Clr * (-yr * b / (2 * V2));
  // Yaw about +y (positive = nose LEFT). Rudder + = nose right -> negative Cn_y.
  // CnAdverse: rolling right drags the nose left (adverse yaw) -> positive M.y.
  const CnAero = p.Cnbeta * beta + p.Cndr * controls.rudder - p.CnAdverse * controls.aileron;
  const CnY = -CnAero + p.Cnr * (yr * b / (2 * V2)); // Cnr < 0 opposes yaw rate
  // Prop left-turning tendency: nose left at high power / low speed.
  const propYaw = eng.type === 'prop'
    ? 0.004 * ac.spool * eng.staticThrust * b / Math.max(V, 15)
    : 0;

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
    (Cm + sasCm) * qbar * p.wingArea * c,
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
  // Numerical safety: bleed residual rates, hard-clamp spins
  const wl = vLen(ac.omega);
  if (wl > 6) ac.omega = vScale(ac.omega, 6 / wl);
  ac.q = qIntegrate(ac.q, ac.omega, dt);

  // --- Telemetry ---
  ac.alpha = alpha; ac.beta = beta; ac.airspeed = V;
  ac.agl = agl;
  ac.groundSpeed = Math.hypot(ac.vel.x, ac.vel.z);
  ac.stalled = V > 15 && alpha > (p.alphaStall + p.flapStallShift * controls.flaps) && !ac.onGround;
  const upBody = qRot(ac.q, v3(0, 1, 0));
  const nonGravF = vSub(Fworld, v3(0, -p.mass * G, 0));
  ac.gLoad = vDot(nonGravF, upBody) / (p.mass * G); // ~1 in level flight
  ac.onGround = gear.contacts > 0;

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
  ac.spool = 0; ac.abOn = false; ac.engineFailed = false;
  ac._airTime = 0; // spawning on the gear is not a landing
}
