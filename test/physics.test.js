// Headless sanity checks for the flight model. Run: node test/physics.test.js
import { createAircraft, step, PARAMS, attitude, KT, RHO0, G,
         airDensity, failSystem, resetSystems } from '../src/physics/flightModel.js';
import { v3, qAxisAngle } from '../src/physics/vecmath.js';
import { comfortFromRates, createComfortMeter, createManeuverDetector,
         buildGauntletCourse, GAUNTLET } from '../src/activities.js';
import { emptyLogbook, accumulate, computeBadges } from '../src/logbook.js';

const DT = 1 / 120;
const flat = { groundHeight: () => 0, isRunway: () => true };
const ctl = (o = {}) => ({ elevator: 0, aileron: 0, rudder: 0, throttle: 0, flaps: 0, brakes: false, ...o });

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function fly(ac, controls, seconds, env = flat, each = null) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    step(ac, typeof controls === 'function' ? controls(ac, i * DT) : controls, env, DT);
    if (each) each(ac, i * DT);
    if (ac.crashed) break;
  }
  return ac;
}

// ---- 1. Analytic stall speed from model params ----
{
  const clMax = PARAMS.CL0 + PARAMS.CLalpha * PARAMS.alphaStall;
  const vs = Math.sqrt((2 * PARAMS.mass * G) / (RHO0 * PARAMS.wingArea * clMax)) * KT;
  check('stall speed (clean) 45-60 kt', vs > 45 && vs < 60, `${vs.toFixed(1)} kt`);
  const clMaxF = PARAMS.CL0 + PARAMS.flapCL + PARAMS.CLalpha * (PARAMS.alphaStall + PARAMS.flapStallShift);
  const vsF = Math.sqrt((2 * PARAMS.mass * G) / (RHO0 * PARAMS.wingArea * clMaxF)) * KT;
  check('flaps lower stall speed', vsF < vs - 3, `${vsF.toFixed(1)} kt with flaps`);
}

// ---- 2. Full throttle climbs ----
{
  const ac = createAircraft({ pos: v3(0, 800, 0), vel: v3(50, 0, 0) });
  const alt0 = ac.pos.y;
  fly(ac, ctl({ throttle: 1 }), 40);
  check('full-throttle climb gains altitude', !ac.crashed && ac.pos.y - alt0 > 100,
    `${(ac.pos.y - alt0).toFixed(0)} m in 40 s, V=${(ac.airspeed * KT).toFixed(0)} kt`);
  check('climb airspeed sane', ac.airspeed > 25 && ac.airspeed < 80, `${(ac.airspeed * KT).toFixed(0)} kt`);
}

// ---- 3. Power-off glide is stable, not a dive ----
{
  const ac = createAircraft({ pos: v3(0, 1500, 0), vel: v3(50, 0, 0) });
  let sampled = [];
  fly(ac, ctl({ throttle: 0 }), 60, flat, (a, t) => { if (t > 30) sampled.push({ vs: a.vel.y, v: a.airspeed }); });
  const avgVs = sampled.reduce((s, x) => s + x.vs, 0) / sampled.length;
  const avgV = sampled.reduce((s, x) => s + x.v, 0) / sampled.length;
  const angle = Math.atan2(-avgVs, avgV) * 180 / Math.PI;
  check('glide descends', !ac.crashed && avgVs < -0.5, `avg VS ${avgVs.toFixed(2)} m/s`);
  check('glide angle 2-15 deg', angle > 2 && angle < 15, `${angle.toFixed(1)} deg at ${(avgV * KT).toFixed(0)} kt`);
  check('glide speed stable (pitch stability)', avgV > 20 && avgV < 60, `${(avgV * KT).toFixed(0)} kt`);
}

// ---- 4. Pulling into a stall stalls (and doesn't NaN) ----
{
  const ac = createAircraft({ pos: v3(0, 1200, 0), vel: v3(55, 0, 0) });
  let sawStall = false, minV = 999;
  fly(ac, ctl({ throttle: 0.25, elevator: 0.85 }), 30, flat, a => {
    if (a.stalled) sawStall = true;
    minV = Math.min(minV, a.airspeed);
  });
  check('sustained pull enters stall', sawStall, `min speed ${(minV * KT).toFixed(0)} kt`);
  check('stall stays numerically sane', Number.isFinite(ac.pos.y) && ac.crashReason !== 'numerical');
}

// ---- 5. Takeoff roll from standstill ----
{
  const ac = createAircraft({ pos: v3(0, 1.27, 0), vel: v3(0, 0, 0) });
  let liftoffX = null;
  fly(ac, (a) => ctl({ throttle: 1, elevator: a.airspeed > 32 ? 0.5 : 0 }), 60, flat, a => {
    if (liftoffX === null && a.agl > 5) liftoffX = a.pos.x;
  });
  check('takes off from standstill', liftoffX !== null && !ac.crashed,
    liftoffX !== null ? `liftoff after ${liftoffX.toFixed(0)} m ground roll` : `never lifted (V=${(ac.airspeed * KT).toFixed(0)} kt, crash=${ac.crashReason})`);
  if (liftoffX !== null) check('ground roll < 1500 m', liftoffX < 1500, `${liftoffX.toFixed(0)} m`);
}

// ---- 6. Sits still on the ground ----
{
  const ac = createAircraft({ pos: v3(0, 1.27, 0), vel: v3(0, 0, 0) });
  fly(ac, ctl(), 20);
  const drift = Math.hypot(ac.pos.x, ac.pos.z);
  const { roll, pitch } = attitude(ac);
  check('parked aircraft stays put', !ac.crashed && drift < 2, `drift ${drift.toFixed(2)} m`);
  check('parked aircraft stays upright', Math.abs(roll) < 0.05 && Math.abs(pitch) < 0.1,
    `roll ${(roll * 57.3).toFixed(1)} deg pitch ${(pitch * 57.3).toFixed(1)} deg`);
}

// ---- 7. Landing detection: shallow powered descent to touchdown ----
{
  const ac = createAircraft({ pos: v3(0, 60, 0), vel: v3(36, -1.5, 0) });
  let td = null;
  fly(ac, ctl({ throttle: 0.25, flaps: 0.66, elevator: 0.12 }), 40, flat, a => {
    if (a.touchdown && !td) td = { ...a.touchdown };
  });
  check('gentle descent produces a recorded touchdown', td !== null && !ac.crashed,
    td ? `${td.fpm} fpm at ${td.speedKt} kt` : `crash=${ac.crashReason}`);
}

// ================= v2: multi-aircraft =================
import { AIRCRAFT } from '../src/aircraft/params.js';
import { resetOnRunway } from '../src/physics/flightModel.js';

const flatRunway = { x: 0, z: 0, y: 0, headingRad: 0 };

// ---- 8. Engine spool lag ----
{
  const ac = createAircraft({ params: AIRCRAFT.hornet, pos: v3(0, 2000, 0), vel: v3(150, 0, 0) });
  fly(ac, ctl({ throttle: 1 }), 0.5);
  const early = ac.spool;
  fly(ac, ctl({ throttle: 1 }), 3.5);
  check('hornet spools with lag', early < 0.6 && ac.spool > 0.95,
    `spool ${early.toFixed(2)} @0.5s -> ${ac.spool.toFixed(2)} @4s`);
  const hv = createAircraft({ params: AIRCRAFT.heavy, pos: v3(0, 2000, 0), vel: v3(100, 0, 0) });
  fly(hv, ctl({ throttle: 1 }), 4);
  const hvEarly = hv.spool;
  fly(hv, ctl({ throttle: 1 }), 8);
  check('heavy spools much slower', hvEarly < 0.7 && hv.spool > 0.9,
    `spool ${hvEarly.toFixed(2)} @4s -> ${hv.spool.toFixed(2)} @12s`);
}

// ---- 9. Every type rests, rolls, and takes off ----
{
  const profiles = {
    c172:     { vr: 32, dist: 1500, time: 60 },
    extra300: { vr: 30, dist: 1200, time: 60 },
    hornet:   { vr: 80, dist: 2500, time: 90 },
    heavy:    { vr: 78, dist: 3500, time: 150 },
    spirit:   { vr: 75, dist: 3000, time: 120 },
  };
  // Shared closed-loop climb law — IDENTICAL for all 5 aircraft (no per-type
  // tuning). After rotation speed, a proportional pitch-hold drives elevator
  // toward CLIMB_PITCH. This replaces the old open-loop constant-elevator hold,
  // which porpoised pathologically (~12 g even at baseline); a controllable
  // climb is both more realistic and a stronger test, and because the law is
  // uniform it cannot mask a real regression in any single airframe.
  const CLIMB_PITCH = 0.14;   // rad target climb attitude (~8 deg)
  const PITCH_GAIN = 4.0;     // proportional gain on pitch error
  const ELEV_LO = -0.5, ELEV_HI = 0.8;  // elevator command clamp
  const climbElev = (a, vr) => {
    if (a.airspeed <= vr) return 0;  // ground roll / rotation
    const e = PITCH_GAIN * (CLIMB_PITCH - attitude(a).pitch);
    return Math.max(ELEV_LO, Math.min(ELEV_HI, e));
  };
  for (const [id, prof] of Object.entries(profiles)) {
    const ac = createAircraft({ params: AIRCRAFT[id] });
    resetOnRunway(ac, flatRunway);
    const restPitch = AIRCRAFT[id].spawn.pitch;
    fly(ac, ctl(), 10);
    const att = attitude(ac);
    const drift = Math.hypot(ac.pos.x, ac.pos.z);
    check(`${id} rests quietly at spawn attitude`, !ac.crashed && drift < 3 && Math.abs(att.pitch - restPitch) < 0.06,
      `drift ${drift.toFixed(1)} m, pitch ${(att.pitch * 57.3).toFixed(1)} deg (want ${(restPitch * 57.3).toFixed(1)}), crash=${ac.crashReason}`);
    let liftoffX = null;
    fly(ac, (a) => ctl({ throttle: 1, elevator: climbElev(a, prof.vr) }), prof.time, flat, a => {
      if (liftoffX === null && a.agl > 60) liftoffX = a.pos.x;
    });
    check(`${id} takes off and climbs through 60 m`, liftoffX !== null && !ac.crashed,
      liftoffX !== null ? `through 60 m AGL by x=${liftoffX.toFixed(0)} m` : `V=${(ac.airspeed * KT).toFixed(0)} kt crash=${ac.crashReason}`);
  }
}

// ---- 10. Ground steering: rudder right yaws the nose right, tricycle AND taildragger ----
// Sign check via yaw RATE (omega.y positive = nose left), immune to heading wrap.
{
  const rates = {};
  for (const id of ['c172', 'extra300']) {
    const ac = createAircraft({ params: AIRCRAFT[id] });
    resetOnRunway(ac, flatRunway);
    fly(ac, ctl({ throttle: 0.25 }), 6);                       // roll to taxi speed
    fly(ac, ctl({ throttle: 0.2, rudder: 1 }), 1.5);
    rates[id] = ac.omega.y;
  }
  check('c172 ground rudder right turns nose right', rates.c172 < -0.01, `yaw rate ${rates.c172.toFixed(3)} rad/s`);
  check('taildragger steers the same way', rates.extra300 < -0.01,
    `yaw rate ${rates.extra300.toFixed(3)} rad/s`);
}

// ---- 11. Stall speed bands per type ----
{
  const band = (p, flaps, lo, hi, label) => {
    const clMax = p.CL0 + p.flapCL * flaps + p.CLalpha * (p.alphaStall + p.flapStallShift * flaps);
    const vs = Math.sqrt((2 * p.mass * G) / (RHO0 * p.wingArea * clMax)) * KT;
    check(label, vs > lo && vs < hi, `${vs.toFixed(0)} kt`);
  };
  band(AIRCRAFT.extra300, 0, 50, 65, 'extra300 clean stall 50-65 kt');
  band(AIRCRAFT.hornet, 0, 110, 140, 'hornet clean stall 110-140 kt');
  band(AIRCRAFT.heavy, 1, 105, 130, 'heavy full-flap stall 105-130 kt');
}

// ---- 12. Hornet exceeds 400 kt on afterburner ----
{
  const ac = createAircraft({ params: AIRCRAFT.hornet, pos: v3(0, 500, 0), vel: v3(200, 0, 0) });
  let vMax = 0, sawAB = false;
  fly(ac, ctl({ throttle: 1 }), 60, flat, a => { vMax = Math.max(vMax, a.airspeed); sawAB = sawAB || a.abOn; });
  check('hornet reaches 400+ kt with AB', vMax * KT > 400 && sawAB && Number.isFinite(ac.pos.y),
    `${(vMax * KT).toFixed(0)} kt, AB=${sawAB}`);
}

// ---- 13. Spirit: SAS keeps it pointed; without SAS it departs ----
{
  const mk = (sas) => {
    const ac = createAircraft({ params: { ...AIRCRAFT.spirit, sas } });
    ac.pos = v3(0, 2000, 0); ac.vel = v3(90, 0, 0); ac.omega = v3(0, 0.02, 0);
    return ac;
  };
  const on = mk(AIRCRAFT.spirit.sas);
  let maxBetaOn = 0, maxRollOn = 0;
  fly(on, ctl({ throttle: 0.6 }), 60, flat, a => {
    maxBetaOn = Math.max(maxBetaOn, Math.abs(a.beta));
    maxRollOn = Math.max(maxRollOn, Math.abs(attitude(a).roll));
  });
  check('spirit SAS-on holds itself together', !on.crashed && maxBetaOn < 0.08 && maxRollOn < 0.6,
    `max |beta| ${(maxBetaOn * 57.3).toFixed(1)} deg, max roll ${(maxRollOn * 57.3).toFixed(0)} deg`);
  const off = mk(null);
  let departed = false;
  fly(off, ctl({ throttle: 0.6 }), 90, flat, a => {
    if (Math.abs(a.beta) > 0.3 || Math.abs(attitude(a).roll) > 1.05) departed = true;
  });
  check('spirit without SAS departs controlled flight', departed || off.crashed, departed ? 'diverged' : `crash=${off.crashReason}`);
}

// ---- 14. Heavy flies a 140 kt full-flap approach ----
{
  const ac = createAircraft({ params: AIRCRAFT.heavy, pos: v3(0, 800, 0), vel: v3(72, 0, 0) });
  ac.spool = 0.6;
  let sinkSum = 0, n = 0, stalledEver = false;
  fly(ac, ctl({ throttle: 0.6, flaps: 1, elevator: 0.15 }), 30, flat, a => {
    sinkSum += a.vel.y; n++; stalledEver = stalledEver || a.stalled;
  });
  const avgSink = sinkSum / n;
  check('heavy holds a 140 kt approach', !ac.crashed && !stalledEver && avgSink > -8,
    `avg VS ${avgSink.toFixed(1)} m/s, V ${(ac.airspeed * KT).toFixed(0)} kt`);
}

// ================= v3-B: wind, gusts, trim =================
import { createWind, WEATHER } from '../src/physics/wind.js';

// ---- 15. Headwind: airspeed exceeds groundspeed by the wind speed ----
// (A hands-off stable aircraft weathervanes out of a crosswind — correct
// behavior — so the deterministic check is the airspeed/groundspeed split.)
{
  const windEnv = { ...flat, wind: () => ({ x: -10, y: 0, z: 0 }) }; // 10 m/s headwind for eastbound flight
  const ac = createAircraft({ pos: v3(0, 1500, 0), vel: v3(50, 0, 0) });
  fly(ac, ctl({ throttle: 0.6 }), 10, windEnv);
  const split = ac.airspeed - ac.groundSpeed;
  check('headwind splits airspeed from groundspeed', !ac.crashed && split > 8 && split < 12,
    `IAS-GS = ${split.toFixed(1)} m/s (wind 10)`);
}

// ---- 16. Gusty air is uncomfortable but flyable ----
{
  const wf = createWind();
  wf.set({ ...WEATHER.gusty, dirDeg: 250 });
  const windEnv = { ...flat, wind: (x, y, z) => wf.at(x, y, z) };
  const ac = createAircraft({ pos: v3(0, 1500, 0), vel: v3(50, 0, 0) });
  let maxRoll = 0, t = 0;
  fly(ac, ctl({ throttle: 0.7 }), 60, windEnv, (a, tt) => {
    wf.setTime(tt);
    maxRoll = Math.max(maxRoll, Math.abs(attitude(a).roll));
  });
  check('gusty air stays flyable', !ac.crashed && Number.isFinite(ac.pos.y)
    && ac.pos.y > 900 && ac.pos.y < 2100 && maxRoll < 1.05,
    `alt ${ac.pos.y.toFixed(0)} m, max roll ${(maxRoll * 57.3).toFixed(0)} deg`);
}

// ---- 17. Nose-up trim slows the hands-off trim speed ----
{
  const trimSpeed = (trim) => {
    const ac = createAircraft({ pos: v3(0, 2000, 0), vel: v3(46, 0, 0) });
    let sum = 0, n = 0;
    fly(ac, ctl({ throttle: 0.55, trim }), 40, flat, (a, t) => { if (t > 30) { sum += a.airspeed; n++; } });
    return sum / n;
  };
  const v0 = trimSpeed(0), vUp = trimSpeed(0.12);
  check('nose-up trim slows hands-off speed', vUp < v0 - 4,
    `${(v0 * KT).toFixed(0)} kt -> ${(vUp * KT).toFixed(0)} kt with +12% trim`);
}

// ---- 18. Hornet control-softening: high-speed handling stays sane (U8) ----
{
  // Full aft stick at 500 kt must not rip past 9 g or depart controlled flight.
  const kt = 1 / KT;
  const ac = createAircraft({ params: AIRCRAFT.hornet, pos: v3(0, 6000, 0), vel: v3(500 * kt, 0, 0) });
  ac.spool = 1;
  let maxG = 0, maxBeta = 0;
  fly(ac, ctl({ throttle: 1, elevator: 1 }), 4, flat, a => {
    maxG = Math.max(maxG, a.gLoad);
    maxBeta = Math.max(maxBeta, Math.abs(a.beta));
  });
  check('hornet full aft stick at 500 kt pulls < 9 g', !ac.crashed && maxG < 9 && maxG > 1.5,
    `peak ${maxG.toFixed(1)} g`);
  check('hornet does not depart at 500 kt full stick', !ac.crashed && Number.isFinite(ac.pos.y) && maxBeta < 0.25,
    `max |beta| ${(maxBeta * 57.3).toFixed(1)} deg, crash=${ac.crashReason}`);

  // Peak roll rate at 500 kt must not exceed 1.5x the 250-kt roll rate — the
  // softener keeps roll authority bounded as dynamic pressure climbs.
  const peakRoll = (kts) => {
    const r = createAircraft({ params: AIRCRAFT.hornet, pos: v3(0, 6000, 0), vel: v3(kts * kt, 0, 0) });
    r.spool = 1;
    let pk = 0;
    fly(r, ctl({ throttle: 1, aileron: 1 }), 2.5, flat, a => { pk = Math.max(pk, Math.abs(a.omega.x)); });
    return pk;
  };
  const roll250 = peakRoll(250), roll500 = peakRoll(500);
  check('hornet roll rate at 500 kt <= 1.5x its 250 kt roll rate', roll500 <= 1.5 * roll250,
    `${roll500.toFixed(2)} vs ${roll250.toFixed(2)} rad/s (ratio ${(roll500 / roll250).toFixed(2)})`);
}

// ---- 19. C172 trimmed cruise is byte-identical (softening must not touch it) ----
{
  const ac = createAircraft({ pos: v3(0, 2000, 0), vel: v3(55, 0, 0) });
  fly(ac, ctl({ throttle: 0.55, trim: 0.05 }), 20);
  const hash = [
    ac.pos.x, ac.pos.y, ac.pos.z, ac.vel.x, ac.vel.y, ac.vel.z,
    ac.q.w, ac.q.x, ac.q.y, ac.q.z, ac.omega.x, ac.omega.y, ac.omega.z,
  ].map(v => v.toFixed(6)).join('|');
  const EXPECTED = '882.940147|2039.258833|-1.113957|48.143129|-7.669935|-0.202756|0.998710|-0.001058|0.002202|-0.050718|-0.000069|0.000381|0.020425';
  check('c172 trimmed-cruise state hash unchanged', hash === EXPECTED, hash);
}

// ================= v4-F: fuel, ground effect, systems/failures =================

// ---- 20. Fuel burns monotonically in cruise; an empty tank flames out ----
{
  const ac = createAircraft({ pos: v3(0, 1500, 0), vel: v3(55, 0, 0) });
  const f0 = ac.fuelKg;
  let mono = true, prev = f0;
  fly(ac, ctl({ throttle: 0.6 }), 20, flat, a => { if (a.fuelKg > prev + 1e-9) mono = false; prev = a.fuelKg; });
  check('cruise burns fuel monotonically', f0 > 0 && ac.fuelKg < f0 && mono && ac.fuelFrac < 1,
    `${f0.toFixed(0)} -> ${ac.fuelKg.toFixed(2)} kg (frac ${ac.fuelFrac.toFixed(3)})`);

  const g = createAircraft({ pos: v3(0, 1500, 0), vel: v3(55, 0, 0) });
  g.fuelKg = 0.0001;                 // a whiff of fuel: burns out on the first step
  const alt0 = g.pos.y;
  fly(g, ctl({ throttle: 1 }), 15, flat);
  check('empty tank flames the engine out', g.engineFailed === true && g.systems.engine === false,
    `fuel ${g.fuelKg.toFixed(4)} kg`);
  check('flamed-out aircraft loses thrust and descends', !g.crashed && g.pos.y < alt0 && g.thrust < 1,
    `alt ${alt0} -> ${g.pos.y.toFixed(0)} m, thrust ${g.thrust.toFixed(1)} N`);
}

// ---- 21. Ground effect: near the surface the c172 sinks less (floats) ----
// Identical state + identical controls; the ONLY difference is terrain height,
// so any altitude gap is purely the ground-effect lift bump + induced-drag drop.
{
  const controls = ctl({ throttle: 0.55, elevator: 0.06 });
  const run = (groundY) => {
    const a = createAircraft({ pos: v3(0, 6, 0), vel: v3(40, 0, 0) });
    return fly(a, controls, 5, { groundHeight: () => groundY, isRunway: () => true });
  };
  const inGE = run(3);        // agl ~3 m (< span 11) -> ground effect active
  const baseline = run(-200); // agl huge -> ground effect is identity
  check('ground effect makes the c172 float (higher than no-GE baseline)',
    !inGE.crashed && !baseline.crashed && inGE.pos.y > baseline.pos.y,
    `GE y=${inGE.pos.y.toFixed(3)} vs base y=${baseline.pos.y.toFixed(3)} (agl ${inGE.agl.toFixed(1)} m)`);
  check('ground-effect lift bump is bounded (floats level, does not balloon up)',
    inGE.pos.y < 6 + 1, `GE climbed to ${inGE.pos.y.toFixed(3)} m from 6.0 m start`);
}

// ---- 22. Systems framework: pitot freeze + engineFailed alias ----
{
  const ac = createAircraft({ pos: v3(0, 1500, 0), vel: v3(55, 0, 0) });
  fly(ac, ctl({ throttle: 0.6 }), 3, flat);
  const expectIas = ac.airspeed * Math.sqrt(airDensity(ac.pos.y) / RHO0);
  check('IAS tracks true airspeed while pitot healthy', Math.abs(ac.iasIndicated - expectIas) < 0.5,
    `IAS ${ac.iasIndicated.toFixed(2)} vs EAS ${expectIas.toFixed(2)}`);

  failSystem(ac, 'pitot');
  const iasAtFail = ac.iasIndicated;
  const trueAtFail = ac.airspeed;
  fly(ac, ctl({ throttle: 1, elevator: -0.15 }), 8, flat);   // accelerate hard
  check('pitot failure freezes indicated airspeed', ac.iasIndicated === iasAtFail,
    `IAS frozen ${ac.iasIndicated.toFixed(3)}`);
  check('true airspeed keeps updating after pitot fail', Math.abs(ac.airspeed - trueAtFail) > 2,
    `true ${trueAtFail.toFixed(1)} -> ${ac.airspeed.toFixed(1)} m/s`);

  const b = createAircraft();
  failSystem(b, 'engine');
  const aliasFwd = b.engineFailed === true && b.systems.engine === false;
  b.engineFailed = false;               // writing the alias heals systems.engine
  const aliasBack = b.systems.engine === true;
  resetSystems(b);
  check('engineFailed <-> systems.engine alias works both ways and resets',
    aliasFwd && aliasBack && b.engineFailed === false && b.systems.engine === true);
}

// ---- 23. Phase C: airline comfort score ----
{
  const dt = 1 / 120;
  const smooth = createComfortMeter();
  for (let i = 0; i < 900; i++) smooth.sample(1 + 0.015 * Math.sin(i * 0.03), 0.1 * Math.sin(i * 0.01), dt);
  const bumpy = createComfortMeter();
  for (let i = 0; i < 900; i++) bumpy.sample(1 + 0.7 * Math.sin(i * 0.6), 6 * Math.sin(i * 0.6), dt);
  const ss = smooth.score(), bs = bumpy.score();
  check('comfort: smooth cruise scores high', ss >= 80, `score ${ss}`);
  check('comfort: bumpy ride scores well below smooth', bs < ss - 20, `bumpy ${bs} vs smooth ${ss}`);
  check('comfort: score clamps to 0..100', comfortFromRates(0, 0) === 100 && comfortFromRates(9, 9) === 0 && ss <= 100 && bs >= 0);
}

// ---- 24. Phase C: gauntlet gate layout ----
{
  const rwy = { spawn: { x: 60, z: 0 }, headingRad: 0, y: 6 };
  const c = buildGauntletCourse(rwy);
  check('gauntlet: gate count matches config', c.length === GAUNTLET.gates, `${c.length} gates`);
  check('gauntlet: gates march forward down the runway heading',
    c[0][0] > 60 && c.every((g, i) => i === 0 || g[0] > c[i - 1][0]));
  check('gauntlet: gate centres are low (near terrain + clearance)',
    c.every(g => g[2] <= rwy.y + GAUNTLET.clearance + 1e-6), `first centre y ${c[0][2]}`);
  check('gauntlet: ceiling clears the gates', GAUNTLET.ceilingAgl > GAUNTLET.clearance + 40);
}

// ---- 25. Phase C: maneuver detector (attitude/rate history) ----
{
  const dt = 1 / 120;
  const level = createManeuverDetector();
  for (let i = 0; i < 900; i++) level.sample({ x: 0.02, y: 0, z: 0.02 }, dt); // below rate gate
  check('maneuver: straight-and-level names nothing', level.count === 0, `count ${level.count}`);

  const loop = createManeuverDetector();
  const pr = (Math.PI * 2) / 6; let loopHit = null;
  for (let i = 0; i < 6 / dt; i++) { const h = loop.sample({ x: 0, y: 0, z: pr }, dt); if (h) loopHit = h; }
  check('maneuver: a full pitch rotation reads as LOOP', loopHit === 'LOOP', `got ${loopHit}`);

  const roll = createManeuverDetector();
  const rr = (Math.PI * 2) / 4; let rollHit = null;
  for (let i = 0; i < 4 / dt; i++) { const h = roll.sample({ x: rr, y: 0, z: 0 }, dt); if (h) rollHit = h; }
  check('maneuver: a full roll rotation reads as AILERON ROLL', rollHit === 'AILERON ROLL', `got ${rollHit}`);

  const barrel = createManeuverDetector(); let bHit = null;
  for (let i = 0; i < 6 / dt; i++) { const h = barrel.sample({ x: pr, y: 0, z: pr }, dt); if (h) bHit = h; }
  check('maneuver: simultaneous pitch+roll reads as BARREL ROLL', bHit === 'BARREL ROLL', `got ${bHit}`);
}

// ---- 26. Phase C: logbook accumulation + badge logic ----
{
  const lb = emptyLogbook();
  accumulate(lb, { aircraft: 'c172', seconds: 120, landing: { fpm: 180, night: false }, apUsed: true });
  accumulate(lb, { aircraft: 'extra300', seconds: 60, landing: { fpm: 90, night: true } });
  accumulate(lb, { aircraft: 'hornet', seconds: 200, gauntletDone: true });
  accumulate(lb, { aircraft: 'heavy', seconds: 80, comfort: 95 });
  check('logbook: hours accumulate per aircraft type', lb.hours.c172 === 120 && lb.hours.extra300 === 60);
  check('logbook: total + per-type landings count', lb.landings === 2 && lb.landingsByType.extra300 === 1);
  check('logbook: best fpm tracks the softest landing', lb.bestFpm === 90, `bestFpm ${lb.bestFpm}`);

  const badges = computeBadges(lb, { lessonsDone: 10, lessonsTotal: 10 });
  const by = (id) => badges.find(b => b.id === id).earned;
  check('badge: PPL earned when all lessons done', by('ppl'));
  check('badge: TAILWHEEL from an Extra 300 landing', by('tailwheel'));
  check('badge: JET from a gauntlet clear', by('jet'));
  check('badge: NIGHT from a night landing', by('night'));
  check('badge: AUTOPILOT from an AP-flown leg', by('autopilot'));
  check('badge: SMOOTH OPERATOR from a comfort ≥ 90 leg', by('smooth'));
  const none = computeBadges(emptyLogbook(), { lessonsDone: 0, lessonsTotal: 10 });
  check('badge: nothing earned on an empty logbook', none.every(b => !b.earned));
}

// ---- Real-world tile math (v5-R1): pure projection + Terrarium decode ----
import { makeProjection, worldPx, decodeTerrarium, bilerp, bearingToHeadingRad, metresPerPixel }
  from '../src/maps/tilesampler.js';
{
  // Terrarium decode: 128,0,0 = exactly sea level; +100 g adds 100 m.
  check('tilesampler: decode sea level', decodeTerrarium(128, 0, 0) === 0);
  check('tilesampler: decode +100 m', decodeTerrarium(128, 100, 0) === 100, `${decodeTerrarium(128,100,0)}`);
  check('tilesampler: decode bathymetry', decodeTerrarium(127, 156, 0) === -100, `${decodeTerrarium(127,156,0)}`);

  // Bilinear blend corners + centre.
  check('tilesampler: bilerp corner', bilerp(10, 20, 30, 40, 0, 0) === 10);
  check('tilesampler: bilerp centre', bilerp(0, 10, 20, 30, 0.5, 0.5) === 15, `${bilerp(0,10,20,30,0.5,0.5)}`);

  // Bearing -> spawn yaw is the inverse of hud.js's compass formula.
  const compass = (h) => ((90 - h * 180 / Math.PI) % 360 + 360) % 360;
  check('tilesampler: bearing 023 round-trips through the HUD formula',
    Math.abs(compass(bearingToHeadingRad(23)) - 23) < 1e-9, `${compass(bearingToHeadingRad(23))}`);
  check('tilesampler: bearing 284 round-trips', Math.abs(compass(bearingToHeadingRad(284)) - 284) < 1e-9);

  // Web-Mercator projection: origin maps to its own pixel; z0 equator resolution
  // is the textbook 156543 m/px; local ENU offset scales by metres-per-pixel.
  check('tilesampler: z0 equator resolution', Math.abs(metresPerPixel(0, 0) - 156543.03392) < 0.01, `${metresPerPixel(0,0)}`);
  const proj = makeProjection(45.3967, 6.6347, 13); // Courchevel
  const o = proj.toPixel(0, 0);
  check('tilesampler: ENU origin maps to origin pixel',
    Math.abs(o.gpx - proj.gpx0) < 1e-9 && Math.abs(o.gpy - proj.gpy0) < 1e-9);
  const east = proj.toPixel(proj.mpp, 0);  // 1 pixel east
  check('tilesampler: +east moves +1 px, +south moves +1 py',
    Math.abs(east.gpx - (proj.gpx0 + 1)) < 1e-9 && Math.abs(proj.toPixel(0, proj.mpp).gpy - (proj.gpy0 + 1)) < 1e-9);
  check('tilesampler: worldPx z13', worldPx(13) === 256 * 8192);
}

// ---- Live weather mapping (v5-R2): Open-Meteo current -> wind/vis ----
import { mapWeather } from '../src/liveweather.js';
{
  const w = mapWeather({ wind_speed_10m: 6, wind_direction_10m: 210, wind_gusts_10m: 9, visibility: 8000, cloud_cover: 75 });
  check('liveweather: m/s wind -> knots', w.wind.kts === 12, `${w.wind.kts}`);          // 6 m/s ~ 11.66 -> 12
  check('liveweather: gust is delta above steady', w.wind.gustKts === 6, `${w.wind.gustKts}`); // (9-6) m/s ~ 5.83 -> 6
  check('liveweather: direction passes through', w.wind.dirDeg === 210);
  check('liveweather: gusty air adds turbulence', w.wind.turb > 0);
  check('liveweather: visibility + cloud carried for the sky', w.vis.visibilityM === 8000 && w.vis.cloudCover === 75);

  const gale = mapWeather({ wind_speed_10m: 30, wind_direction_10m: 40, wind_gusts_10m: 45 });
  check('liveweather: extreme wind clamps to the flyable cap', gale.wind.kts <= 34 && gale.clamped === true, JSON.stringify(gale.wind));
  const still = mapWeather({});
  check('liveweather: empty response -> calm, no NaNs', still.wind.kts === 0 && still.wind.gustKts === 0 && Number.isFinite(still.wind.turb));
}

// ---- Study-level C172 start/electrical (v5-R3) ----
import { setColdStart } from '../src/physics/flightModel.js';
{
  const flatEnv = { groundHeight: () => 0, isRunway: () => true };
  const mk = () => {
    const a = createAircraft({ params: AIRCRAFT.c172, pos: v3(0, 1.3, 0), vel: v3(0, 0, 0) });
    setColdStart(a);
    return a;
  };
  const run = (a, c, secs) => { for (let i = 0; i < secs * 120; i++) step(a, { throttle: 0, elevator: 0, aileron: 0, rudder: 0, flaps: 0, trim: 0, brakes: true, ...c }, flatEnv, 1 / 120); };

  // Cold & dark: nothing happens without the sequence.
  const a1 = mk();
  run(a1, { throttle: 1 }, 3);
  check('coldstart: throttle alone does nothing cold & dark', !a1.engineRunning && a1.thrust < 1, `thrust ${a1.thrust.toFixed(1)}`);

  // Starter without battery: no crank.
  const a2 = mk();
  a2.sys.mags = 'START'; a2.sys.mixture = 1;
  run(a2, {}, 3);
  check('coldstart: starter needs the battery master ON', !a2.engineRunning);

  // Starter without mixture: cranks but never catches.
  const a3 = mk();
  a3.sys.battery = true; a3.sys.mags = 'START'; a3.sys.mixture = 0;
  run(a3, {}, 3);
  check('coldstart: no mixture -> cranks, never catches', !a3.engineRunning);

  // Full correct sequence: battery ON, mixture rich, mags START ~2 s -> running.
  const a4 = mk();
  a4.sys.battery = true; a4.sys.mixture = 1; a4.sys.mags = 'START';
  run(a4, {}, 2.5);
  a4.sys.mags = 'BOTH'; // release the key
  run(a4, { throttle: 0.3 }, 2);
  check('coldstart: correct sequence starts the engine', a4.engineRunning && a4.thrust > 100, `thrust ${a4.thrust.toFixed(0)}`);

  // Cutting the mags kills a running engine.
  a4.sys.mags = 'OFF';
  run(a4, { throttle: 0.5 }, 1.5);
  check('coldstart: mags OFF kills the engine', !a4.engineRunning && a4.thrust < 50, `thrust ${a4.thrust.toFixed(0)}`);

  // Battery drains with master on + engine off; avionics die on a dead battery.
  const a5 = mk();
  a5.sys.battery = true;
  a5.batteryCharge = 0.12;
  run(a5, {}, 10);
  check('coldstart: master-on engine-off drains the battery', a5.batteryCharge < 0.12, `charge ${a5.batteryCharge.toFixed(3)}`);
  a5.batteryCharge = 0.05;
  run(a5, {}, 0.2);
  check('coldstart: dead battery -> avionics unpowered', a5.avionics === false);

  // Alternator recharges in flight; resetOnRunway restores ready-to-fly.
  const a6 = mk();
  a6.sys.battery = true; a6.sys.mixture = 1; a6.sys.mags = 'BOTH';
  a6.engineRunning = true; a6.batteryCharge = 0.5;
  run(a6, { throttle: 0.6, brakes: false }, 5);
  check('coldstart: alternator recharges while running', a6.batteryCharge > 0.5, `charge ${a6.batteryCharge.toFixed(3)}`);
  resetOnRunway(a6, { x: 0, z: 0, y: 0, headingRad: 0 });
  check('coldstart: resetOnRunway restores ready-to-fly', a6.engineRunning && a6.sys.mags === 'BOTH' && a6.avionics);

  // Hot aircraft without p.startup are untouched by the machinery.
  const hot = createAircraft({ params: AIRCRAFT.hornet, pos: v3(0, 1000, 0), vel: v3(150, 0, 0) });
  run(hot, { throttle: 1, brakes: false }, 2);
  check('coldstart: non-startup aircraft unaffected', hot.engineRunning && hot.thrust > 1000);
}

import { createAtc, callsignFor, sayRunway } from '../src/atc.js';

// ---- ATC-lite phrase + sequencing (v5-R5) ----
// The tower is a pure state machine over the debrief's own geometry, so the
// whole circuit is testable here with no browser and no speech synthesis.
{
  const said = [];
  const mkAtc = () => {
    said.length = 0;
    return createAtc({ field: 'SINGAPORE CHANGI', rwyName: '02L',
      callsign: callsignFor('c172'), say: (t, id) => said.push({ t, id }) });
  };

  check('atc: runway read digit by digit', sayRunway('02L') === 'zero two left', sayRunway('02L'));
  check('atc: niner, not nine', sayRunway('09') === 'zero niner', sayRunway('09'));
  check('atc: unknown aircraft still gets a callsign', callsignFor('nope').length > 0);

  const a = mkAtc();
  // Holding short: the first call is takeoff clearance naming the real runway.
  a.update({ onGround: true, agl: 0, vsFpm: 0, cross: 0 }, 0);
  check('atc: clearance names the field and runway',
    said[0]?.id === 'clearance' && /Changi/.test(said[0].t) && /zero two left/.test(said[0].t),
    said[0]?.t);

  // Airborne -> departure, then pattern once properly climbing.
  a.update({ onGround: false, agl: 50, vsFpm: 600, cross: 0 }, 5);
  check('atc: departure call once the wheels are off', said[1]?.id === 'departure', said[1]?.t);
  a.update({ onGround: false, agl: 300, vsFpm: 600, cross: 0 }, 5);
  check('atc: pattern call on the climb-out', said[2]?.id === 'pattern', said[2]?.t);

  // Radio discipline: a call cannot step on the one before it.
  const before = said.length;
  a.update({ onGround: false, agl: 300, vsFpm: -400, cross: 0 }, 0.1);
  check('atc: never steps on the previous call', said.length === before);

  // Descending, lined up -> inbound, then cleared to land on a stable final.
  a.update({ onGround: false, agl: 300, vsFpm: -400, cross: 20 }, 5);
  check('atc: inbound call when descending on the centerline', said[3]?.id === 'inbound', said[3]?.t);
  a.update({ onGround: false, agl: 120, vsFpm: -400, cross: 20 }, 5);
  check('atc: cleared to land on a stable final', said[4]?.id === 'clearLand', said[4]?.t);
  a.update({ onGround: true, agl: 0, vsFpm: 0, cross: 5,
    touchdown: { onRunway: true, fpm: 120 } }, 5);
  check('atc: landing call after touchdown', said[5]?.id === 'landed', said[5]?.t);

  // Respawn reality: the first tick after resetOnRunway reports onGround false
  // (gear contact is computed by the physics step, which has not run yet) while
  // the aircraft sits on the pavement at agl 0. The tower must keep holding
  // rather than assume an airborne start and skip to the approach — that bug
  // made the spawn call come out as "report midfield downwind".
  const f = mkAtc();
  f.update({ onGround: false, agl: 0, vsFpm: 0, cross: 0 }, 0);
  check('atc: agl-0 tick with onGround false is still holding short',
    said.length === 0 && f.phase === 'hold', `${f.phase} ${JSON.stringify(said.map(s => s.id))}`);
  f.update({ onGround: true, agl: 0, vsFpm: 0, cross: 0 }, 0.1);
  check('atc: clearance lands once gear contact settles', said[0]?.id === 'clearance', said[0]?.t);

  // A genuine mid-air start (teleport/reset in flight) skips the ground phase.
  const g = mkAtc();
  g.update({ onGround: false, agl: 800, vsFpm: 0, cross: 0 }, 0);
  check('atc: a real airborne start skips takeoff clearance',
    said.length === 0 && g.phase === 'cruise', `${g.phase} ${JSON.stringify(said.map(s => s.id))}`);

  // A hot, off-centerline final earns a go-around instead of a landing clearance.
  const b = mkAtc();
  b.update({ onGround: true, agl: 0, vsFpm: 0, cross: 0 }, 0);
  b.update({ onGround: false, agl: 50, vsFpm: 600, cross: 0 }, 5);
  b.update({ onGround: false, agl: 300, vsFpm: 600, cross: 0 }, 5);
  b.update({ onGround: false, agl: 300, vsFpm: -400, cross: 20 }, 5);
  b.update({ onGround: false, agl: 120, vsFpm: -1600, cross: 20 }, 5);
  check('atc: sinking hot on short final gets a go-around',
    said[said.length - 1]?.id === 'goAround', said[said.length - 1]?.t);
  check('atc: go-around returns to the en-route phase', b.phase === 'cruise', b.phase);

  const c = mkAtc();
  c.update({ onGround: true, agl: 0, vsFpm: 0, cross: 0 }, 0);
  c.update({ onGround: false, agl: 50, vsFpm: 600, cross: 0 }, 5);
  c.update({ onGround: false, agl: 300, vsFpm: 600, cross: 0 }, 5);
  c.update({ onGround: false, agl: 300, vsFpm: -400, cross: 900 }, 5);
  check('atc: descending far off the centerline is not an approach',
    !said.some(s => s.id === 'inbound'), JSON.stringify(said.map(s => s.id)));

  // Off-field arrival is acknowledged differently from a runway landing.
  const d = mkAtc();
  d.update({ onGround: true, agl: 0, vsFpm: 0, cross: 0 }, 0);
  d.update({ onGround: false, agl: 200, vsFpm: 300, cross: 0 }, 5);
  d.update({ onGround: false, agl: 300, vsFpm: 300, cross: 0 }, 5);
  d.update({ onGround: true, agl: 0, vsFpm: 0, cross: 4000,
    touchdown: { onRunway: false, fpm: 400 } }, 5);
  check('atc: off-field arrival is called differently',
    said[said.length - 1]?.id === 'offField', said[said.length - 1]?.t);

  // Disarming (settings OFF / lesson running) silences the tower entirely.
  const e = mkAtc();
  e.setArmed(false);
  e.update({ onGround: true, agl: 0, vsFpm: 0, cross: 0 }, 0);
  e.update({ onGround: false, agl: 300, vsFpm: 600, cross: 0 }, 5);
  check('atc: disarmed tower says nothing', said.length === 0, JSON.stringify(said));
}

// ---- Terrain draw distance / coarse tier tiling (v6) ----
// Pure selection maths, so the tiling is verified without THREE or a browser.
{
  const { farCellsFor, VIEW_EXTENTS } = await import('../src/terrain.js');

  check('terrain: fine tier still reaches 3300 m', VIEW_EXTENTS.fine === 3300, String(VIEW_EXTENTS.fine));
  check('terrain: coarse tier reaches 9000 m — past the 5200 m fog limit',
    VIEW_EXTENTS.coarse === 9000 && VIEW_EXTENTS.coarse > 5200, String(VIEW_EXTENTS.coarse));

  const cells = farCellsFor(0, 0);
  check('terrain: coarse ring is 24 cells (5x5 minus the covered centre)',
    cells.length === 24, `${cells.length} cells`);
  check('terrain: the cell under the aircraft is dropped, not drawn twice',
    !cells.includes('0,0'), cells.slice(0, 3).join(' '));

  // No duplicates, and the ring is symmetric about the aircraft.
  check('terrain: no duplicate coarse cells', new Set(cells).size === cells.length);
  const has = (x, z) => cells.includes(`${x},${z}`);
  check('terrain: ring is symmetric', has(2, 2) && has(-2, -2) && has(2, -2) && has(-2, 2));

  // The excluded centre cell spans +/-1800 m, comfortably inside the fine
  // tier's +/-3300 m — that containment is what makes dropping it safe.
  check('terrain: dropped centre is fully inside the fine tier', 1800 < VIEW_EXTENTS.fine);

  // Cells follow the aircraft: far out, the set is centred on the new position.
  const far = farCellsFor(36000, 0);          // 10 coarse cells east
  check('terrain: coarse ring follows the aircraft',
    far.includes('12,0') && !far.includes('10,0'), far.slice(0, 3).join(' '));
  check('terrain: still 24 cells wherever you are', far.length === 24, `${far.length}`);

  // Coarse geometry must stay cheap: 24 chunks at RES 18 is ~15.5k triangles
  // against the fine tier's 121 x 2592 = 313,632.
  const coarseTris = 24 * 18 * 18 * 2;
  check('terrain: coarse tier costs under 6% of the fine tier',
    coarseTris < 121 * 36 * 36 * 2 * 0.06, `${coarseTris} tris`);
}

// ---- Audio buses: master / sfx / music + mute ----
// createAudio() only touches WebAudio inside init(), so the level bookkeeping
// is testable headlessly — no AudioContext, no browser.
{
  const { createAudio } = await import('../src/audio.js');
  const { DEFAULTS } = await import('../src/settings.js');

  check('audio: master defaults to 50%', DEFAULTS.volume === 0.5, String(DEFAULTS.volume));
  check('audio: sfx and music have their own defaults',
    DEFAULTS.sfxVolume === 1 && DEFAULTS.musicVolume === 0.6,
    `sfx ${DEFAULTS.sfxVolume}, music ${DEFAULTS.musicVolume}`);
  check('audio: not muted by default', DEFAULTS.muted === false);

  const a = createAudio();
  check('audio: three independent buses', a.levels.master === 0.5 && a.levels.sfx === 1 && a.levels.music === 0.6,
    JSON.stringify(a.levels));

  a.setVolume(0.8); a.setSfxVolume(0.25); a.setMusicVolume(0);
  check('audio: buses set independently',
    a.levels.master === 0.8 && a.levels.sfx === 0.25 && a.levels.music === 0,
    JSON.stringify(a.levels));

  a.setVolume(5); a.setSfxVolume(-3);
  check('audio: levels clamp to 0..1', a.levels.master === 1 && a.levels.sfx === 0, JSON.stringify(a.levels));

  // Mute must not destroy the levels it silences.
  a.setVolume(0.65);
  a.setMuted(true);
  check('audio: mute is on and keeps the underlying level',
    a.muted === true && a.levels.master === 0.65, JSON.stringify(a.levels));
  a.setMuted(false);
  check('audio: unmute restores exactly the previous level',
    a.muted === false && a.levels.master === 0.65, JSON.stringify(a.levels));

  check('audio: exposes a music hook for a future soundtrack',
    typeof a.connectMusic === 'function');
}

console.log(failures === 0 ? '\nAll physics checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
