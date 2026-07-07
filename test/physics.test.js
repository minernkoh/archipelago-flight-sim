// Headless sanity checks for the flight model. Run: node test/physics.test.js
import { createAircraft, step, PARAMS, attitude, KT, RHO0, G } from '../src/physics/flightModel.js';
import { v3, qAxisAngle } from '../src/physics/vecmath.js';

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

console.log(failures === 0 ? '\nAll physics checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
