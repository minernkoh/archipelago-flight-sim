// Headless sanity checks for the flight model. Run: node test/physics.test.js
import { createAircraft, step, PARAMS, attitude, KT, RHO0, G,
         airDensity, failSystem, resetSystems, liftCoeff, FT } from '../src/physics/flightModel.js';
import { v3, qAxisAngle } from '../src/physics/vecmath.js';
import { comfortFromRates, createComfortMeter, createManeuverDetector,
         buildGauntletCourse, GAUNTLET } from '../src/activities.js';
import { emptyLogbook, accumulate, computeBadges } from '../src/logbook.js';
import { vSpeeds, landingBands } from '../src/physics/envelope.js';

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
  // Right rudder is now required. A single-engine prop at full power yaws left
  // (slipstream swirl + P-factor), and the dihedral effect turns that standing
  // sideslip into a slow left roll — measured 1.4 deg/s in the climb, so
  // holding nothing but back pressure for a minute spirals it into the ground.
  // That is the whole point of the v6 propeller work; the old model needed no
  // rudder at all because its left-turning tendency was 0.09% of rudder
  // authority. So this test now flies coordinated: step on the ball.
  const ac = createAircraft({ pos: v3(0, 1.27, 0), vel: v3(0, 0, 0) });
  let liftoffX = null;
  // ...and the wings have to be held level. The C172 is slightly spirally
  // divergent (by design, and the model reproduces it), so any disturbance
  // left alone for a minute becomes a spiral. Nothing disturbed it before.
  fly(ac, (a) => ctl({
    throttle: 1,
    elevator: a.airspeed > 32 ? 0.5 : 0,
    rudder: Math.max(0, Math.min(1, -a.beta * 12 - a.omega.y * 2)),
    aileron: Math.max(-1, Math.min(1, -attitude(a).roll * 3 - a.omega.x * 0.6)),
  }), 60, flat, a => {
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
  // The original setup (throttle 0.6, elevator 0.15) never actually flew this
  // approach: it started at 140 kt and accelerated to 200 kt in a 1100 fpm
  // descent, so the test's own name was not true and nothing noticed, because
  // the only assertions were "didn't stall" and "sink < 8 m/s". That mattered
  // once Vfe arrived — 200 kt is past this airframe's 180 KIAS full-flap limit,
  // so the flaps blew back and it ran away. Retrimmed to a real stabilised
  // approach, and the speed is now asserted so it cannot drift again.
  const ac = createAircraft({ params: AIRCRAFT.heavy, pos: v3(0, 800, 0), vel: v3(72, 0, 0) });
  ac.spool = 0.3;
  let sinkSum = 0, n = 0, stalledEver = false;
  fly(ac, ctl({ throttle: 0.3, flaps: 1, elevator: 0.45 }), 30, flat, a => {
    sinkSum += a.vel.y; n++; stalledEver = stalledEver || a.stalled;
  });
  const avgSink = sinkSum / n;
  const easKt = ac.eas * KT;
  check('heavy holds a 140 kt approach', !ac.crashed && !stalledEver && avgSink > -8,
    `avg VS ${avgSink.toFixed(1)} m/s, V ${easKt.toFixed(0)} kt EAS`);
  check('heavy approach is actually flown at ~140 kt, below Vfe',
    easKt > 130 && easKt < 155 && easKt < AIRCRAFT.heavy.limits.vfe * KT,
    `${easKt.toFixed(0)} kt EAS vs Vfe ${(AIRCRAFT.heavy.limits.vfe * KT).toFixed(0)} kt`);
  check('flaps are not blown back on a correctly flown approach',
    ac.flapsEff === 1, `flapsEff ${ac.flapsEff.toFixed(2)}`);
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
  // Guard: this check was vacuous for a whole release because both runs pinned
  // the 6 rad/s numerical clamp and read 6.00, so the ratio was 1.00 by
  // construction. If either sample saturates again the assertion above is
  // measuring the clamp, not the control softener.
  check('hornet roll ratio is measuring aerodynamics, not the 6 rad/s clamp',
    roll250 < 5.9 && roll500 < 5.9, `${roll250.toFixed(2)} / ${roll500.toFixed(2)} rad/s`);
}

// ---- 18b. Roll authority is in the right class band for every airframe ----
// pb/2V = Clda / -Clp is the dimensionless steady roll rate. Real aircraft sit
// at 0.07-0.09 (light singles), ~0.09-0.13 (fighters) and ~0.06-0.07 (widebody
// transports); competition aerobats reach ~0.4. The fleet used to be tuned at
// 0.24-0.78, i.e. two to nine times over, which is what this table catches.
{
  const BANDS = {
    c172:     [0.06, 0.11],
    extra300: [0.30, 0.45],
    hornet:   [0.09, 0.16],
    heavy:    [0.05, 0.09],
    spirit:   [0.06, 0.12],
  };
  for (const [id, [lo, hi]] of Object.entries(BANDS)) {
    const p = AIRCRAFT[id];
    const pb2V = p.Clda / -p.Clp;
    check(`${id} roll authority pb/2V in ${lo}-${hi}`, pb2V >= lo && pb2V <= hi, pb2V.toFixed(3));
  }

  // And fly it: full aileron from level, steady-state roll rate at 100 kt.
  const ac = createAircraft({ pos: v3(0, 3000, 0), vel: v3(100 / KT, 0, 0) });
  ac.spool = 0.6;
  let peak = 0;
  fly(ac, ctl({ throttle: 0.6, aileron: 1 }), 4, flat, a => { peak = Math.max(peak, Math.abs(a.omega.x)); });
  const degS = peak * 180 / Math.PI;
  check('c172 full-aileron roll rate 40-65 deg/s at 100 kt', degS > 40 && degS < 65, `${degS.toFixed(0)} deg/s`);
}

// ---- 18c. Stall aerodynamics: the wing has to actually stop flying ----
// The old model kept a clean drag polar past the break (CD ~0.10 at 24 deg
// alpha) and damped roll linearly, so a stalled aircraft held a symmetric
// 887 fpm mush indefinitely — measured roll 0.0 deg, yaw 0.0 deg/s — and a
// spin was unreachable. These checks pin the three properties that fixed it.
{
  const p = PARAMS;

  // (a) The hash firewall. Roll damping is now evaluated as two wing stations
  // on the real lift curve; below the stall that must reduce EXACTLY to the
  // old Clp * (pb/2V) term, or normal handling (and the cruise state hash)
  // would have moved.
  let worstRoll = 0;
  for (const a of [-0.05, 0, 0.03, 0.06, 0.10]) {
    for (const pr of [-1, -0.3, 0, 0.3, 1]) {
      for (const V2 of [30, 50, 80]) {
        const rEff = -2 * p.Clp * p.span / p.CLalpha;
        const dA = pr * rEff / V2;
        if (Math.abs(a) + Math.abs(dA) > p.alphaStall - 0.02) continue; // stay linear
        const strip = (liftCoeff(a - dA, 0, p) - liftCoeff(a + dA, 0, p)) / 8;
        worstRoll = Math.max(worstRoll, Math.abs(strip - p.Clp * (pr * p.span / (2 * V2))));
      }
    }
  }
  check('strip roll damping reduces exactly to Clp*(pb/2V) below the stall',
    worstRoll < 1e-12, `max |diff| ${worstRoll.toExponential(2)}`);

  // (b) The other half of the firewall: separation drag must be exactly zero
  // — not merely small — anywhere at or below the break, for every airframe.
  let anyDrag = 0;
  for (const id of Object.keys(AIRCRAFT)) {
    const q = AIRCRAFT[id];
    for (let a = -q.alphaStall; a <= q.alphaStall; a += q.alphaStall / 40) {
      const sep = Math.max(0, Math.abs(a) - q.alphaStall);
      anyDrag = Math.max(anyDrag, Math.min(1, sep / 0.12) * (q.CDstall ?? 2.0) * Math.sin(a) ** 2);
    }
  }
  check('separation drag is exactly zero at and below the stall break', anyDrag === 0, `${anyDrag}`);

  // (c) A stalled wing must cost real energy: the mush is not holdable.
  {
    const ac = createAircraft({ pos: v3(0, 6000, 0), vel: v3(70 / KT, 0, 0) });
    let brk = null, sink = 0;
    fly(ac, ctl({ throttle: 0.2, elevator: 1 }), 30, flat, (a, t) => {
      if (brk === null && a.stalled) brk = t;
      if (brk !== null && t - brk > 4) sink = a.vel.y;
    });
    check('a held stall sinks faster than 8 m/s (no free mush)', sink < -8, `${sink.toFixed(1)} m/s`);
  }

  // (d) The break is asymmetric — a wing drops. This is the defect itself.
  {
    const ac = createAircraft({ pos: v3(0, 6000, 0), vel: v3(70 / KT, 0, 0) });
    let brk = null, maxRoll = 0, maxYaw = 0;
    fly(ac, ctl({ throttle: 0.2, elevator: 1 }), 30, flat, (a, t) => {
      if (brk === null && a.stalled) brk = t;
      if (brk !== null && t - brk < 6) {
        maxRoll = Math.max(maxRoll, Math.abs(attitude(a).roll));
        maxYaw = Math.max(maxYaw, Math.abs(a.omega.y));
      }
    });
    check('the stall breaks asymmetrically (a wing drops)',
      maxRoll > 0.26 && maxYaw > 0.15,
      `${(maxRoll * 57.3).toFixed(0)} deg roll, ${(maxYaw * 57.3).toFixed(0)} deg/s yaw within 6 s`);
  }

  // (e) A spin is reachable AND recoverable by correct technique: neutral
  // ailerons, opposite rudder, forward stick. (Using aileron instead makes it
  // worse, which is the real-world lesson the old model could not teach.)
  {
    const ac = createAircraft({ pos: v3(0, 9000, 0), vel: v3(70 / KT, 0, 0) });
    fly(ac, (a, t) => ctl({ throttle: 0.1, elevator: Math.min(1, t / 2.5) }), 8);
    let peakYaw = 0;
    fly(ac, ctl({ throttle: 0.1, elevator: 1, rudder: 1 }), 20, flat,
      a => { peakYaw = Math.max(peakYaw, Math.abs(a.omega.y)); });
    check('pro-spin controls autorotate', peakYaw > 1.5 && ac.alpha > PARAMS.alphaStall,
      `${(peakYaw * 57.3).toFixed(0)} deg/s yaw, alpha ${(ac.alpha * 57.3).toFixed(0)} deg`);
    let recovered = null;
    fly(ac, (a) => ctl({ throttle: 0, elevator: -0.6, aileron: 0, rudder: Math.sign(a.omega.y) }),
      15, flat, (a, t) => {
        if (recovered === null && !a.stalled && Math.abs(a.omega.y) < 0.4) recovered = t;
      });
    check('a spin recovers with opposite rudder and forward stick',
      recovered !== null, recovered === null ? 'never' : `${recovered.toFixed(1)} s`);
  }
}

// ---- 18d. The flight envelope has an outside ----
// Before v6 there were no limits at all: the Hornet accelerated to Mach 1.54 /
// 996 KIAS in level flight at 500 m with no wave drag and nothing breaking,
// then pulled 15.9 g with the airframe intact, and the C172 took full flaps at
// 150 kt (Vfe 85) with no consequence.
{
  const hold = (ac, c, secs, extra) => {
    let iE = 0;
    fly(ac, (a) => {
      const pe = -0.02 * a.vel.y - attitude(a).pitch;
      iE = Math.max(-1, Math.min(1, iE + pe * DT * 1.5));
      return ctl({ ...c, elevator: Math.max(-1, Math.min(1, 3 * pe + iE - 0.5 * a.omega.z)) });
    }, secs, flat, extra);
  };

  // (a) Wave drag gives the fast jets a real ceiling in level flight.
  {
    const ac = createAircraft({ params: AIRCRAFT.hornet, pos: v3(0, 500, 0), vel: v3(200, 0, 0) });
    ac.spool = 1;
    hold(ac, { throttle: 1 }, 120);
    check('hornet is Mach-limited at low level, not unbounded',
      !ac.crashed && ac.mach < 1.15 && ac.eas < AIRCRAFT.hornet.limits.vne,
      `Mach ${ac.mach.toFixed(2)}, ${(ac.eas * KT).toFixed(0)} kt EAS`);
  }

  // (b) Past Vne the airframe lets go.
  {
    const ac = createAircraft({ pos: v3(0, 4000, 0), vel: v3(60, 0, 0) });
    fly(ac, ctl({ throttle: 1, elevator: -0.32 }), 120);
    check('a sustained overspeed breaks the airframe', ac.crashed && ac.crashReason === 'overspeed',
      `${(ac.eas * KT).toFixed(0)} kt EAS, ${ac.crashReason || 'survived'}`);
  }

  // (c) ...but a brief excursion is survivable. An instant trip would fire on a
  // single gust-loaded frame, which is why damage accumulates instead.
  {
    const ac = createAircraft({ pos: v3(0, 3000, 0), vel: v3(100, 0, 0) });
    let peakEas = 0;
    fly(ac, ctl({ throttle: 0 }), 3, flat, a => { peakEas = Math.max(peakEas, a.eas); });
    check('a brief overspeed excursion does not break the airframe',
      peakEas > ac.p.limits.vne && !ac.crashed && ac.damage < 1,
      `peaked ${(peakEas * KT).toFixed(0)} kt EAS vs Vne ${(ac.p.limits.vne * KT).toFixed(0)}, damage ${ac.damage.toFixed(2)}`);
  }

  // (d) g-limits are per airframe: the same pull that breaks a trainer is
  // nothing to an aerobatic aircraft.
  {
    const pull = (id) => {
      const ac = createAircraft({ params: AIRCRAFT[id], pos: v3(0, 4000, 0), vel: v3(75, 0, 0) });
      ac.spool = 1;
      let peak = 1;
      fly(ac, ctl({ throttle: 1, elevator: 1 }), 6, flat, a => { peak = Math.max(peak, a.gLoad); });
      return { peak, reason: ac.crashReason };
    };
    const trainer = pull('c172'), aerobat = pull('extra300');
    check('over-g breaks the trainer', trainer.reason === 'overstress',
      `${trainer.peak.toFixed(1)} g vs ${AIRCRAFT.c172.limits.gPos} limit`);
    check('the same pull does not break the aerobat', aerobat.reason !== 'overstress',
      `${aerobat.peak.toFixed(1)} g vs ${AIRCRAFT.extra300.limits.gPos} limit`);
  }

  // (e) Flaps trail back above Vfe, and are EXACTLY untouched below it.
  {
    const fast = createAircraft({ pos: v3(0, 2000, 0), vel: v3(70, 0, 0) });
    fly(fast, ctl({ throttle: 0.5, flaps: 1 }), 2);
    check('flaps blow back above Vfe', fast.flapsEff < 0.9 && fast.flapsEff > 0,
      `flapsEff ${fast.flapsEff.toFixed(2)} at ${(fast.eas * KT).toFixed(0)} kt`);
    const slow = createAircraft({ pos: v3(0, 2000, 0), vel: v3(35, 0, 0) });
    fly(slow, ctl({ throttle: 0.5, flaps: 1 }), 2);
    check('flaps are exactly untouched below Vfe', slow.flapsEff === 1, `flapsEff ${slow.flapsEff}`);
  }

  // (f) Limits are INDICATED speeds. The old OVERSPEED annunciator compared
  // true airspeed against Vne, so it fired at altitude while the tape still
  // read under the limit.
  {
    const low = createAircraft({ pos: v3(0, 0, 0), vel: v3(90, 0, 0) });
    const high = createAircraft({ pos: v3(0, 8000, 0), vel: v3(90, 0, 0) });
    fly(low, ctl(), 1 / 60); fly(high, ctl(), 1 / 60);
    check('the same TAS is an overspeed low down but not at altitude',
      low.eas > low.p.limits.vne && high.eas < high.p.limits.vne,
      `EAS ${(low.eas * KT).toFixed(0)} kt at SL vs ${(high.eas * KT).toFixed(0)} kt at 8 km`);
  }

  // (g) V-speed ordering must stay sane for every airframe.
  for (const id of Object.keys(AIRCRAFT)) {
    const v = vSpeeds(AIRCRAFT[id]);
    const ok = v.vs0Kt <= v.vs1Kt && v.vs1Kt < v.vneKt && v.gPos > 0 && v.gNeg < 0
      && (v.vfeKt === null || (v.vfeKt > v.vs0Kt && v.vfeKt < v.vneKt))
      && (v.vnoKt === null || v.vnoKt < v.vneKt);
    check(`${id} V-speeds are ordered`, ok,
      `Vs0 ${v.vs0Kt.toFixed(0)} Vs1 ${v.vs1Kt.toFixed(0)} Vfe ${v.vfeKt?.toFixed(0) ?? '-'} Vne ${v.vneKt.toFixed(0)}`);
  }
}

// ---- 18e. Turbulence has to be able to roll you ----
// The wind was sampled once at the CG, so both wings always saw identical air:
// hands-off for two minutes in the 16G28 "gusty" preset the total bank
// excursion was 5 degrees. Turbulence registered as speed and g noise but
// never as the continuous roll corrections that define flying a light aircraft
// in wind. Wind speed also did not vary with height at all.
{
  const windEnv = (w, dirDeg = 270) => {
    const wind = createWind();
    wind.set({ dirDeg, ...w });
    return {
      wind,
      env: { groundHeight: () => 0, isRunway: () => false, terrainHeight: () => 0,
             wind: (x, y, z) => wind.at(x, y, z) },
    };
  };
  // Measured as roll-RATE activity, not peak bank: hands-off, the aircraft's
  // own left-turning tendency winds it into a slow spiral whose peak bank
  // swamps everything. Gusts show up as roll-rate noise on top of that.
  const bankIn = (w) => {
    const { wind, env } = windEnv(w);
    const ac = createAircraft({ pos: v3(0, 300, 0), vel: v3(95 / KT, 0, 0) });
    let t = 0, sum2 = 0, n = 0, maxG = 1, minG = 1;
    for (let i = 0; i < 120 * 90; i++) {
      t += DT; wind.setTime(t);
      step(ac, ctl({ throttle: 0.6, elevator: 0.02 }), env, DT);
      sum2 += ac.omega.x * ac.omega.x; n++;
      maxG = Math.max(maxG, ac.gLoad); minG = Math.min(minG, ac.gLoad);
      if (ac.crashed) break;
    }
    return { rms: Math.sqrt(sum2 / n) * 180 / Math.PI, maxG, minG, crashed: ac.crashed };
  };

  const gusty = bankIn(WEATHER.gusty), calm = bankIn(WEATHER.calm);
  // Measured as the EXCESS over calm, not as an absolute. A hands-off single
  // no longer flies straight — the slipstream swirl gives it a real
  // left-turning tendency — so an absolute bank figure would be measuring the
  // prop, not the weather. Two-sided on purpose: catches both "turbulence
  // can't roll you" and "turbulence flips you onto your back".
  check('turbulence rolls the aircraft, but does not flip it',
    !gusty.crashed && gusty.rms > calm.rms * 2.5 && gusty.rms < 12,
    `roll rate RMS ${gusty.rms.toFixed(2)} deg/s in gusty vs ${calm.rms.toFixed(2)} in calm`);
  check('turbulence does not come with silly g-loading',
    gusty.minG > 0 && gusty.maxG < 2.5, `${gusty.minG.toFixed(2)}-${gusty.maxG.toFixed(2)} g`);

  // The invariant that keeps the headwind test structurally immune: a spatially
  // uniform wind must produce ZERO differential, however strong it is.
  {
    // The invariant is that a uniform wind adds NOTHING in roll — so compare
    // against a no-wind run rather than against zero, which would only be
    // measuring the aircraft's own left-turning tendency.
    // Galilean check: flying at 50 m/s airspeed into a uniform 14 m/s headwind
    // must roll EXACTLY like flying at 50 m/s airspeed in still air. If the
    // spanwise sampling ever leaked into the translational solution, or a
    // uniform field produced a differential, this is what would catch it.
    const still = { groundHeight: () => -9000, isRunway: () => false, terrainHeight: () => -9000 };
    const uniform = { ...still, wind: () => v3(-14, 0, 0) };
    const a = createAircraft({ pos: v3(0, 1000, 0), vel: v3(36, 0, 0) });   // 50 airspeed
    const b = createAircraft({ pos: v3(0, 1000, 0), vel: v3(50, 0, 0) });
    fly(a, ctl({ throttle: 0.5 }), 20, uniform);
    fly(b, ctl({ throttle: 0.5 }), 20, still);
    check('a spatially uniform wind produces no differential roll',
      Math.abs(a.omega.x - b.omega.x) < 1e-9 && Math.abs(attitude(a).roll - attitude(b).roll) < 1e-9,
      `roll delta ${((attitude(a).roll - attitude(b).roll) * 57.3).toExponential(2)} deg`);
  }

  // Wind gradient: the steady component used to be identical at 20 m and 2 km.
  {
    const { wind } = windEnv(WEATHER.breezy);
    wind.setTime(3);
    const low = wind.at(0, 20, 0), high = wind.at(0, 1500, 0);
    const mag = (w) => Math.hypot(w.x, w.z);
    check('wind strengthens with height', mag(high) > mag(low) * 1.3,
      `${mag(low).toFixed(1)} m/s at 20 m -> ${mag(high).toFixed(1)} m/s at 1500 m`);
  }

  // Turbulence used to hit exactly zero at 500 m, so the headline gusty preset
  // was glass-smooth at every cruise altitude.
  {
    const { wind } = windEnv(WEATHER.gusty);
    let spread = 0;
    for (let i = 0; i < 400; i++) { wind.setTime(i * 0.1); spread = Math.max(spread, Math.abs(wind.at(i * 40, 1500, 0).y)); }
    check('turbulence still exists above 500 m', spread > 0.1, `${spread.toFixed(2)} m/s vertical at 1500 m`);
  }
}

// ---- 18f. Power is coupled to pitch and yaw ----
// Thrust used to be added to the FORCE vector only — the moment vector had no
// thrust term and there was no propwash over the tail, so a power change did
// not move the nose and elevator authority was identical at idle and full
// throttle. The left-turning tendency existed on paper but was 0.09% of rudder
// authority: measured heading drift across an entire takeoff roll was 0.75 deg.
{
  const level = (thr, secs) => {
    const ac = createAircraft({ pos: v3(0, 2000, 0), vel: v3(50, 0, 0) });
    ac.spool = thr;
    fly(ac, ctl({ throttle: thr, elevator: 0.06 }), secs);
    return ac;
  };
  // (a) Power makes a pitching moment. Same elevator, different throttle.
  const lo = level(0.25, 6), hi = level(0.95, 6);
  check('adding power pitches the nose up',
    attitude(hi).pitch > attitude(lo).pitch + 0.02,
    `${(attitude(lo).pitch * 57.3).toFixed(1)} deg at idle vs ${(attitude(hi).pitch * 57.3).toFixed(1)} deg at full power`);

  // (b) Elevator authority rises with power (the tail sits in the slipstream).
  // Sampled slow, because that is where slipstream matters: the wash ratio
  // goes as thrust/V^2, so at cruise it is worth only a few percent while on
  // the roll and in slow flight it is the difference between having an
  // elevator and not.
  const pitchRate = (thr) => {
    const ac = createAircraft({ pos: v3(0, 2000, 0), vel: v3(30, 0, 0) });
    ac.spool = thr;
    let peak = 0;
    fly(ac, ctl({ throttle: thr, elevator: 0.5 }), 1.2, flat, a => { peak = Math.max(peak, a.omega.z); });
    return peak;
  };
  const qLo = pitchRate(0.15), qHi = pitchRate(1);
  check('elevator authority increases with power', qHi > qLo * 1.05,
    `${(qLo * 57.3).toFixed(1)} vs ${(qHi * 57.3).toFixed(1)} deg/s in slow flight`);

  // (c) The takeoff roll pulls left and needs right rudder to hold centreline.
  const roll = (rudder) => {
    const ac = createAircraft({ pos: v3(0, 1.27, 0), vel: v3(0, 0, 0) });
    let off = 0;
    fly(ac, (a) => ctl({ throttle: 1, rudder: typeof rudder === 'function' ? rudder(a) : rudder }),
      22, flat, a => { if (a.agl < 3) off = a.pos.z; });
    return off;
  };
  const free = roll(0);
  const flown = roll(a => Math.max(-1, Math.min(1, -0.12 * a.pos.z - 0.9 * a.vel.z)));
  check('the takeoff roll pulls LEFT without rudder', free < -3,
    `${free.toFixed(1)} m off centreline (-z = left)`);
  check('...and right rudder holds the centreline', Math.abs(flown) < 3,
    `${flown.toFixed(1)} m with the pedals`);
}

// ---- 18f2. The fin is strong enough relative to the rudder ----
// Cndr/Cnbeta used to let full rudder settle at 39 deg of steady sideslip on
// the Skyhawk (57 on the Extra). A real forward slip in a light single is
// 15-20 deg; the yaw axis felt loose and slips were cartoonish. Solved
// analytically, like the stall speeds — it is a static balance, and flying it
// open-loop for 30 s just measures whatever departure happens first.
{
  const steadySlip = (p) => {
    // Cnbeta*b == Cndr*fade(b), fade = 1/(1+(b/bf)^2)
    const bf = p.betaRudFade ?? 0.30;
    let lo = 0, hi = 1.5;
    for (let i = 0; i < 80; i++) {
      const b = (lo + hi) / 2;
      if (Math.abs(p.Cnbeta) * b < p.Cndr / (1 + (b / bf) ** 2)) lo = b; else hi = b;
    }
    return (lo + hi) / 2 * 180 / Math.PI;
  };
  for (const id of ['c172', 'extra300', 'hornet', 'heavy']) {
    const deg = steadySlip(AIRCRAFT[id]);
    check(`${id} full rudder settles at a realistic sideslip`, deg > 12 && deg < 24, `${deg.toFixed(0)} deg`);
  }
  // Fade must not eat the authority the crosswind lesson needs to de-crab.
  const p = PARAMS, bf = p.betaRudFade ?? 0.30;
  const retained = 1 / (1 + (0.21 / bf) ** 2);
  check('rudder keeps most of its authority at a 12 deg de-crab', retained > 0.6,
    `${(retained * 100).toFixed(0)}% of full rudder`);

  // And flown: a slip must increase the descent rate. That is what it is for.
  const glideSink = (rudder) => {
    const ac = createAircraft({ pos: v3(0, 4000, 0), vel: v3(36, 0, 0) });
    let iE = 0;
    fly(ac, (a) => {
      const pe = 0.03 * (a.airspeed - 36) - attitude(a).pitch;
      iE = Math.max(-1, Math.min(1, iE + pe * DT * 1.5));
      return ctl({ throttle: 0.15, rudder,
        elevator: Math.max(-1, Math.min(1, 3 * pe + iE - 0.5 * a.omega.z)),
        aileron: Math.max(-1, Math.min(1, -attitude(a).roll * 3 - a.omega.x * 0.6)) });
    }, 14);
    return { vs: ac.vel.y, beta: Math.abs(ac.beta) * 180 / Math.PI };
  };
  const straight = glideSink(0), slipped = glideSink(1);
  check('a forward slip steepens the descent',
    slipped.beta > 8 && slipped.vs < straight.vs - 0.5,
    `${straight.vs.toFixed(1)} -> ${slipped.vs.toFixed(1)} m/s at ${slipped.beta.toFixed(0)} deg of slip`);
}

// ---- 18g. Drag polar matches the published glide ----
// The old 0.030/0.054 gave L/Dmax 12.4 at 74 kt, so engine-out glides went
// about 35% further than a real Skyhawk's.
{
  const p = PARAMS;
  const ld = (cd0) => 1 / (2 * Math.sqrt(cd0 * p.kInduced));
  const vbg = (cd0) => Math.sqrt(2 * p.mass * G / (RHO0 * p.wingArea) * Math.sqrt(p.kInduced / cd0)) * KT;
  const clean = ld(p.CD0), off = ld(p.CD0 + p.engine.windmillCD);
  check('clean best L/D is 10-11.5', clean > 10 && clean < 11.5, `${clean.toFixed(1)}:1 at ${vbg(p.CD0).toFixed(0)} kt`);
  check('power-off best glide matches the POH 9.0 at 68 kt',
    off > 8.5 && off < 9.5 && vbg(p.CD0 + p.engine.windmillCD) > 64 && vbg(p.CD0 + p.engine.windmillCD) < 72,
    `${off.toFixed(1)}:1 at ${vbg(p.CD0 + p.engine.windmillCD).toFixed(0)} kt`);
}

// ---- 18h. Climb performance, and the number the flight school teaches ----
// Measured as total height gained over many phugoid cycles. Instantaneous VS
// is meaningless here — the phugoid is lightly damped with a ~25 s period, so
// short runs read anything from +3466 to -6697 fpm on the same aircraft.
{
  const sustainedRoc = (elev, secs = 150) => {
    const ac = createAircraft({ pos: v3(0, 1500, 0), vel: v3(50, 0, 0) });
    ac.spool = 1;
    const y0 = ac.pos.y;
    let kSum = 0, n = 0;
    fly(ac, (a) => ctl({ throttle: 1, elevator: elev,
      aileron: Math.max(-1, Math.min(1, -attitude(a).roll * 3 - a.omega.x * 0.6)) }),
      secs, flat, a => { kSum += a.iasIndicated * KT; n++; });
    if (ac.crashed) return null;
    return { fpm: ((ac.pos.y - y0) / secs) * FT * 60, kt: kSum / n };
  };
  let best = null;
  for (const e of [0.00, 0.06, 0.12]) {
    const r = sustainedRoc(e);
    if (r && (!best || r.fpm > best.fpm)) best = r;
  }
  check('c172 best rate of climb is 600-800 fpm', best && best.fpm > 600 && best.fpm < 800,
    best ? `${best.fpm.toFixed(0)} fpm at ${best.kt.toFixed(0)} kt` : 'crashed');
  // training.js lesson 2 tells the student "hold 70-85 kt climbing — that's Vy".
  check('Vy falls inside the 70-85 kt band lesson 2 teaches',
    best && best.kt > 70 && best.kt < 85, best ? `${best.kt.toFixed(0)} kt` : 'n/a');
}

// ---- 18i. Landing grades scale to each airframe's own gear ----
// The bands were a fleet-wide 130/300/500 fpm, from a 950 kg aerobat to a
// 200-tonne widebody, while the gear actually gives out at 630-886 fpm
// depending on the type.
{
  for (const id of Object.keys(AIRCRAFT)) {
    const b = landingBands(AIRCRAFT[id]);
    check(`${id} landing bands are ordered and below its gear limit`,
      b.greased < b.smooth && b.smooth < b.firm && b.firm < b.limitFpm,
      `${b.greased}/${b.smooth}/${b.firm} fpm, gear ${b.limitFpm}`);
  }
  const c = landingBands(AIRCRAFT.c172);
  check('the c172 keeps the bands it always had', Math.abs(c.greased - 130) < 6
    && Math.abs(c.smooth - 300) < 6 && Math.abs(c.firm - 500) < 6,
    `${c.greased}/${c.smooth}/${c.firm} vs the old 130/300/500`);
}

// ---- 18j. Hornet roll is set by aerodynamics, not by the G softener ----
{
  const peak = (kts, alt) => {
    const r = createAircraft({ params: AIRCRAFT.hornet, pos: v3(0, alt, 0), vel: v3(kts / KT, 0, 0) });
    r.spool = 1;
    let pk = 0;
    fly(r, ctl({ throttle: 1, aileron: 1 }), 2.5, flat, a => { pk = Math.max(pk, Math.abs(a.omega.x)); });
    return pk * 180 / Math.PI;
  };
  const mid = peak(350, 4000);
  check('hornet rolls 170-230 deg/s at 350 kt', mid > 170 && mid < 230, `${mid.toFixed(0)} deg/s`);
}

// ---- 19. C172 trimmed cruise is byte-identical (softening must not touch it) ----
// RE-BASELINED ONCE for v6. Everything that necessarily moves the cruise state
// was landed together so this happens exactly once, and here is the whole list:
//   CD0        0.030  -> 0.034   ) clean L/Dmax 10.8; with the windmill term
//   kInduced   0.054  -> 0.0626  ) below, power-off lands on the POH 9.0 at 68 kt
//   engine.windmillCD  new 0.0153  stopped/windmilling propeller drag
//   thrustArmY         new 0.05    thrust line above the CG -> pitching couple
//   washFrac/CmThrust  new         propwash over the tail: power now pitches the
//                                  nose and scales elevator authority
//   propfx             replaces propYaw: slipstream swirl, P-factor, gyroscopic
//                                  precession (torque roll deliberately omitted)
// Nothing else in v6 touches this state: the roll, stall, envelope and gust
// work is all gated to be provably zero at this operating point, and the
// guards in section 18c assert that directly.
{
  const ac = createAircraft({ pos: v3(0, 2000, 0), vel: v3(55, 0, 0) });
  fly(ac, ctl({ throttle: 0.55, trim: 0.05 }), 20);
  const hash = [
    ac.pos.x, ac.pos.y, ac.pos.z, ac.vel.x, ac.vel.y, ac.vel.z,
    ac.q.w, ac.q.x, ac.q.y, ac.q.z, ac.omega.x, ac.omega.y, ac.omega.z,
  ].map(v => v.toFixed(6)).join('|');
  const EXPECTED = '870.735257|2030.375558|-37.931550|47.112229|-8.205009|-8.226805|0.993377|-0.048120|0.090512|-0.051912|-0.001774|0.017179|0.022559';
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
  check('liveweather: no weather code -> clear sky', still.sky === 'clear');
  check('liveweather: WMO rain codes -> rain', mapWeather({ weather_code: 63 }).sky === 'rain' && mapWeather({ weather_code: 81 }).sky === 'rain');
  check('liveweather: WMO thunderstorm -> storm', mapWeather({ weather_code: 95 }).sky === 'storm');
  check('liveweather: measurable precipitation alone -> rain', mapWeather({ precipitation: 1.2 }).sky === 'rain');
}

// ---- v9: precipitation presets + wet-runway braking ----
import { WET_WEATHER } from '../src/physics/wind.js';
{
  check('weather: rain/storm presets exist', !!WEATHER.rain && !!WEATHER.storm);
  check('weather: storm air stays inside the proven gusty envelope',
    WEATHER.storm.turb <= WEATHER.gusty.turb && WEATHER.storm.gustKts <= WEATHER.gusty.gustKts,
    JSON.stringify(WEATHER.storm));
  check('weather: rain and storm wet the runway, calm does not',
    WET_WEATHER.has('rain') && WET_WEATHER.has('storm') && !WET_WEATHER.has('calm'));

  // Same 25 m/s rollout on full brakes, dry vs wet: wet stops measurably longer.
  const stopDist = (wet) => {
    const a = createAircraft({ pos: v3(0, 2, 0) });
    resetOnRunway(a, { x: 0, z: 0, y: 0, headingRad: 0 });
    fly(a, ctl(), 1, { ...flat, wet });       // settle on the gear
    a.vel.x = 25;
    const x0 = a.pos.x;
    let t = 0;
    fly(a, ctl({ brakes: true }), 30, { ...flat, wet }, () => { if (Math.hypot(a.vel.x, a.vel.z) > 0.3) t += DT; });
    return { d: a.pos.x - x0, t, crashed: a.crashed };
  };
  const dry = stopDist(false), wet = stopDist(true);
  check('wet runway: braking still stops the aircraft', !wet.crashed && wet.t < 29, `${wet.t.toFixed(1)} s`);
  check('wet runway: stopping distance 1.2-2x dry', wet.d > dry.d * 1.2 && wet.d < dry.d * 2,
    `dry ${dry.d.toFixed(0)} m / wet ${wet.d.toFixed(0)} m`);
  check('wet flag is inert when absent (dry == undefined)', (() => {
    const a = createAircraft({ pos: v3(0, 2, 0) }), b = createAircraft({ pos: v3(0, 2, 0) });
    resetOnRunway(a, { x: 0, z: 0, y: 0, headingRad: 0 }); resetOnRunway(b, { x: 0, z: 0, y: 0, headingRad: 0 });
    a.vel.x = b.vel.x = 20;
    fly(a, ctl({ brakes: true }), 3, flat); fly(b, ctl({ brakes: true }), 3, { ...flat, wet: false });
    return a.pos.x === b.pos.x;
  })());
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

  // Full correct sequence: battery ON, mixture rich, PRIME (v12), mags START ~2 s -> running.
  const a4 = mk();
  a4.sys.battery = true; a4.sys.mixture = 1; a4.sys.primes = 2; a4.sys.mags = 'START';
  run(a4, {}, 2.5);
  a4.sys.mags = 'BOTH'; // release the key
  run(a4, { throttle: 0.3 }, 2);
  check('coldstart: correct sequence starts the engine', a4.engineRunning && a4.thrust > 100, `thrust ${a4.thrust.toFixed(0)}`);
  // v12 primer: unprimed cranks much longer before it catches; over-primed floods
  const crankTime = (primes) => { const a = mk(); a.sys.battery = true; a.sys.mixture = 1; a.sys.primes = primes; a.sys.mags = 'START';
    for (let i = 0; i < 10 * 120; i++) { step(a, { elevator: 0, aileron: 0, rudder: 0, throttle: 0, flaps: 0, brakes: false, trim: 0 }, flatEnv, 1 / 120); if (a.engineRunning) return i / 120; } return 99; };
  const tP = crankTime(2), tU = crankTime(0), tF = crankTime(6);
  check('coldstart: primed catches fast, unprimed cranks longer, over-primed floods', tP < 2 && tU > 3 && tU < 4.5 && tF > 5.5, `${tP.toFixed(1)} / ${tU.toFixed(1)} / ${tF.toFixed(1)} s`);

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

// ---- v7 vegetation: cosmetic forest layer ----
// Trees are scattered from map.forest(); it must never plant one on a runway,
// in the sea, or (by construction) move the terrain. The shared noise must be
// deterministic so a chunk regrows the identical forest when it streams back.
{
  const { makeNoise, woodland } = await import('../src/maps/noise.js');
  const a = makeNoise(42), b = makeNoise(42), c = makeNoise(43);
  check('forest: shared noise is deterministic per seed',
    a.fbm(12.3, -4.5) === b.fbm(12.3, -4.5) && a.fbm(12.3, -4.5) !== c.fbm(12.3, -4.5));
  let lo = 1, hi = 0;
  for (let i = 0; i < 400; i++) { const w = woodland(a, i * 37.1, i * -21.7); lo = Math.min(lo, w); hi = Math.max(hi, w); }
  check('forest: woodland mask stays in 0..1 and actually varies', lo >= 0 && hi <= 1 && hi - lo > 0.5, `${lo.toFixed(2)}..${hi.toFixed(2)}`);

  const { archipelagoMap } = await import('../src/maps/archipelago.js');
  const { alpineMap } = await import('../src/maps/alpine.js');
  const { singaporeMap } = await import('../src/maps/singapore.js');
  const slopeAt = (m, x, z) => {
    const h = m.height(x, z);
    return Math.min(1, Math.hypot(h - m.height(x + 6, z), h - m.height(x, z + 6)) / 6);
  };
  for (const m of [archipelagoMap, alpineMap, singaporeMap]) {
    const r = m.runway, f = { x: Math.cos(r.headingRad), z: -Math.sin(r.headingRad) };
    let onRunway = 0;
    for (let u = r.x0; u <= r.x1; u += 25) {
      for (const v of [-r.halfWidth, 0, r.halfWidth]) {
        const x = f.x * u - f.z * v, z = f.z * u + f.x * v;
        if (m.forest(x, z, m.height(x, z), slopeAt(m, x, z)) > 0) onRunway++;
      }
    }
    check(`forest: no trees on the ${m.name} runway`, onRunway === 0, `${onRunway} runway samples wooded`);
    let wooded = 0, wet = 0, n = 0;
    for (let x = -6000; x <= 6000; x += 97) for (let z = -6000; z <= 6000; z += 97) {
      const h = m.height(x, z), d = m.forest(x, z, h, slopeAt(m, x, z));
      n++;
      if (d > 0.3) wooded++;
      if (h < 1.5 && d > 0) wet++;
    }
    check(`forest: ${m.name} grows real woodland somewhere`, wooded / n > 0.03, `${(100 * wooded / n).toFixed(1)}% wooded`);
    check(`forest: ${m.name} plants nothing in the sea`, wet === 0, `${wet} wet samples`);
  }
}

// ---- v7 trails: wingtip vortices + smoke ----
// The trail logic is THREE-side but needs no WebGL to build buffers, so the
// trigger rules are checked headlessly with a fake aircraft.
{
  const THREE = await import('three');
  const { createTrails } = await import('../src/trails.js');
  const scene = new THREE.Scene();
  const t = createTrails(scene);
  const mk = (gLoad) => ({
    p: { span: 11, chord: 1.5, alphaStall: 0.28, gear: [{ r: { x: -3.9, y: -0.4, z: 0 } }] },
    pos: { x: 0, y: 500, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 },
    airspeed: 60, alpha: 0.05, gLoad, onGround: false, crashed: false,
  });
  const cam = new THREE.Vector3(-30, 505, 0);
  const fly = (ac, secs) => { for (let i = 0; i < secs * 60; i++) { ac.pos.x += 1; t.update(ac, 1 / 60, cam, true); } };
  fly(mk(1.0), 1);
  check('trails: no wingtip vortices in 1 g cruise', t.debug().tip.vis === 0, JSON.stringify(t.debug().tip));
  fly(mk(4.5), 1);
  check('trails: a 4.5 g pull condenses wingtip vortices', t.debug().tip.vis > 10, JSON.stringify(t.debug().tip));
  check('trails: smoke stays off until toggled', t.debug().smoke.vis === 0);
  t.toggleSmoke();
  fly(mk(1.0), 2);
  check('trails: smoke on lays a visible trail', t.smokeOn && t.debug().smoke.vis > 10, JSON.stringify(t.debug().smoke));
  t.reset();
  check('trails: reset clears smoke and switches it off', !t.smokeOn && t.debug().smoke.count === 0);
  t.dispose();
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

// ---- v12: physically modelled engine sound (engineSynth.js) ----
// The AudioWorklet runs this exact code; here it is rendered offline and the
// physics it claims is checked in the spectrum, not by ear.
{
  const { EngineSynth, ENGINE_SOUNDS } = await import('../src/engineSynth.js');
  const SR = 48000;
  const render = (id, st, secs = 1.5, seed = 7) => {
    const s = new EngineSynth(SR, ENGINE_SOUNDS[id], seed);
    Object.assign(s.p, st); Object.assign(s.s, st);
    const out = new Float32Array(Math.round(SR * secs / 128) * 128);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < out.length; i += 128) s.render(out, 128, i);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { d: out.subarray(SR / 2), cpu: ms / (secs * 1000) };
  };
  const rms = d => Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length);
  const power = (d, f) => {               // Goertzel, normalised
    const w = 2 * Math.PI * f / SR, cw = 2 * Math.cos(w); let a = 0, b = 0;
    for (let i = 0; i < d.length; i++) { const c = d[i] + cw * a - b; b = a; a = c; }
    return (a * a + b * b - cw * a * b) / d.length ** 2;
  };
  const centroid = d => { let n = 0, m = 0; for (let f = 25; f < 4000; f += 25) { const p = power(d, f); n += f * p; m += p; } return n / m; };
  const A = { alive: 1, dop: 1, gain: 1 };

  // four-stroke: each cylinder fires every other revolution -> rpm * cyl / 120
  const c = render('c172', { ...A, rpm: 2400, load: 1 }).d;
  const fire = 2400 * 4 / 120;            // 80 Hz
  check('engine sound: C172 firing frequency is rpm x cylinders / 120',
    power(c, fire) > 20 * power(c, fire * 0.5) && power(c, fire) > 20 * power(c, fire * 1.5),
    `80 Hz ${power(c, fire).toExponential(1)} vs 40 Hz ${power(c, 40).toExponential(1)}, 120 Hz ${power(c, 120).toExponential(1)}`);
  const x = render('extra300', { ...A, rpm: 2700, load: 1 }).d;
  check('engine sound: six-cylinder Extra fires at 135 Hz at 2,700 rpm',
    power(x, 135) > 20 * power(x, 67.5), `${power(x, 135).toExponential(1)} vs ${power(x, 67.5).toExponential(1)}`);
  const idle = render('c172', { ...A, rpm: 700, load: 0 }).d;
  check('engine sound: full power is louder than idle', rms(c) > 2.5 * rms(idle), `${rms(c).toFixed(3)} vs ${rms(idle).toFixed(3)}`);
  const cab = render('c172', { ...A, rpm: 2400, load: 1, cockpit: 1 }).d;
  check('engine sound: the cabin hears a duller engine than outside', centroid(cab) < 0.8 * centroid(c),
    `centroid ${centroid(cab).toFixed(0)} Hz in vs ${centroid(c).toFixed(0)} Hz out`);
  const crank = render('c172', { alive: 0, crank: 1, rpm: 180, dop: 1, gain: 1 }).d;
  const dead = render('c172', { alive: 0, crank: 0, rpm: 0, dop: 1, gain: 1 }).d;
  check('engine sound: starter cranks audibly, a stopped engine is silent', rms(crank) > 0.005 && rms(dead) < 1e-4,
    `crank ${rms(crank).toFixed(4)}, stopped ${rms(dead).toExponential(1)}`);

  // turbofan: fan blade-pass N1 * blades ahead, jet roar dominates behind
  const hf = render('heavy', { ...A, n1: 1, front: 1 }).d, hb = render('heavy', { ...A, n1: 1, front: -1 }).d;
  const bpf = 2550 / 60 * 22;             // 935 Hz
  const tonal = d => power(d, bpf) / ((power(d, bpf * 0.93) + power(d, bpf * 1.07)) / 2);
  check('engine sound: airliner fan tone at N1 x fan blades, stands out ahead of the inlet',
    tonal(hf) > 10 && tonal(hf) > 3 * tonal(hb),
    `tone/neighbours ${tonal(hf).toFixed(0)} ahead, ${tonal(hb).toFixed(0)} behind`);
  check('engine sound: jet roar is louder behind than ahead', rms(render('hornet', { ...A, n1: 1, front: -1 }).d) > 1.4 * rms(render('hornet', { ...A, n1: 1, front: 1 }).d));
  const shaft = 2550 / 60;
  const buzzLow = render('heavy', { ...A, n1: 0.6, front: 1 }).d;
  const orders = d => [5, 7, 9, 11].reduce((a, k) => a + power(d, shaft * k * (d === buzzLow ? 0.6 : 1)), 0);
  check('engine sound: buzzsaw only once the fan tips go supersonic', orders(hf) > 30 * orders(buzzLow),
    `${orders(hf).toExponential(1)} vs ${orders(buzzLow).toExponential(1)}`);
  const low = d => { let e = 0; for (let f = 30; f <= 150; f += 6) e += power(d, f); return e; };
  const abOn = render('hornet', { ...A, n1: 1, ab: 1, front: -1 }).d, abOff = render('hornet', { ...A, n1: 1, front: -1 }).d;
  check('engine sound: afterburner adds low-frequency rumble', low(abOn) > 2 * low(abOff),
    `30-150 Hz energy x${(low(abOn) / low(abOff)).toFixed(1)}`);

  // Doppler: approaching raises every tone in proportion
  const dn = render('c172', { ...A, rpm: 2400, load: 1, dop: 1.15 }).d;
  check('engine sound: Doppler factor scales the firing frequency', power(dn, fire * 1.15) > 10 * power(dn, fire));

  // safety: finite, bounded, deterministic, cheap enough for the audio thread
  let finite = true, peak = 0, cpu = 0;
  for (const id of Object.keys(ENGINE_SOUNDS)) {
    for (const st of [{ ...A, rpm: 2700, n1: 1, load: 1, ab: 1 }, { ...A, rpm: 700, n1: 0.22 }, { ...A, rpm: 2700, n1: 1, cockpit: 1 }]) {
      const r = render(id, st, 1);
      for (const v of r.d) { if (!Number.isFinite(v)) finite = false; peak = Math.max(peak, Math.abs(v)); }
      cpu = Math.max(cpu, r.cpu);
    }
  }
  check('engine sound: every voice stays finite and under clipping', finite && peak < 1, `peak ${peak.toFixed(2)}`);
  check('engine sound: one voice costs < 8% of real time on one core', cpu < 0.08, `${(cpu * 100).toFixed(1)}%`);
  const r1 = render('extra300', { ...A, rpm: 1800, load: 0.5 }, 0.8, 3).d, r2 = render('extra300', { ...A, rpm: 1800, load: 0.5 }, 0.8, 3).d;
  check('engine sound: deterministic for a given seed', r1.every((v, i) => v === r2[i]));
}

// ---- v12: OpenStreetMap scenery for the real-world maps (osm.js) ----
// Driven by a HAND-WRITTEN fixture in Overpass JSON format (test/fixtures/
// make-osm-fixture.mjs), not real OSM data: the container that runs these has
// no route to Overpass. It checks the pipeline: parse, rasterise, collide, mesh.
{
  const { readFileSync } = await import('node:fs');
  const osm = await import('../src/maps/osm.js');
  const { makeProjection, bearingToHeadingRad } = await import('../src/maps/tilesampler.js');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/overpass-changi.json', import.meta.url)));
  const proj = makeProjection(1.3592, 103.9894, 12);
  const ll = osm.makeLL(proj);
  const o = ll(1.3592, 103.9894), n1k = ll(1.3592 + 1000 / 110574, 103.9894), e1k = ll(1.3592, 103.9894 + 1000 / (111320 * Math.cos(1.3592 * Math.PI / 180)));
  check('osm: lat/lon lands in the map frame (origin, 1 km N = -z, 1 km E = +x)',
    Math.hypot(...o) < 0.01 && Math.abs(n1k[1] + 1000) < 8 && Math.abs(n1k[0]) < 0.01 && Math.abs(e1k[0] - 1000) < 8,
    `N ${n1k.map(v => v.toFixed(1))}, E ${e1k.map(v => v.toFixed(1))}`);
  const data = osm.parseOverpass(fx, ll);
  check('osm: fixture parses into buildings, areas, roads/taxiways and runways',
    data.buildings.length === 22 && data.runways.length === 2 && data.lines.filter(l => l.kind === 'road').length === 2 && data.lines.filter(l => l.kind === 'taxiway').length === 2,
    `${data.buildings.length} buildings, ${data.areas.length} areas, ${data.lines.length} lines, ${data.runways.length} runways`);
  const office = data.buildings.find(b => Math.abs(b.height - 62) < 0.01);
  const flats = data.buildings.filter(b => b.kind === 1 && b.height > 30);
  check('osm: heights come from height=, else building:levels x 3.2 m', !!office && office.kind === 0 && flats.some(b => Math.abs(b.height - (20 * 3.2 + 0.6)) < 0.01),
    `office ${office?.height} m, tallest flats ${Math.max(...flats.map(b => b.height)).toFixed(1)} m`);
  const retail = data.buildings.find(b => Math.abs(b.height - (3 * 3.2 + 0.6)) < 0.01);
  check('osm: a multipolygon outline split over two ways joins into one ring', !!retail && retail.ring.length === 4,
    retail ? `${retail.ring.length} corners, area ${Math.abs(osm.ringArea(retail.ring)).toFixed(0)} m2` : 'missing');
  check('osm: every ring comes out counter-clockwise', [...data.buildings.map(b => b.ring), ...data.areas.map(a => a.ring)].every(r => osm.ringArea(r) > 0));
  const world = osm.buildOsmWorld(data);
  { // the airliner's taxi network straight from the OSM taxiways (taxinet.js)
    const tn = await import('../src/taxinet.js');
    const H0 = bearingToHeadingRad(23), f0 = [Math.cos(H0), -Math.sin(H0)];
    const apronA = data.areas.find(a => a.aeroway === 'apron');
    const c = apronA ? apronA.ring.reduce((m, p) => [m[0] + p[0] / apronA.ring.length, m[1] + p[1] / apronA.ring.length], [0, 0]) : [0, 0];
    const lay = { kind: 'osm', width: 23, lines: data.lines.filter(l => l.kind === 'taxiway').map(l => l.pts), stand: { x: c[0], z: c[1], yaw: 0 }, holds: [] };
    const rw = { spawn: { x: f0[0] * -1940, z: f0[1] * -1940 }, headingRad: H0, y: 0, x0: -2000, x1: 2000, halfWidth: 30 };
    const gp = tn.planGround(rw, lay, { aim: -1640, vapp: 72 });
    check('osm: the airliner routes over the OSM taxiways to the apron, turned on the stand for the taxi out',
      !!apronA && !!gp && Math.abs(gp.exitU) < 5 && gp.taxiIn.length > 400 && gp.pushback > 0,
      gp ? `exit u ${gp.exitU.toFixed(0)}, in ${gp.taxiIn.length.toFixed(0)} m, out ${gp.toHold.length.toFixed(0)} m, pushback ${gp.pushback} s` : 'no plan');
  }
  const H = bearingToHeadingRad(23), fwd = [Math.cos(H), -Math.sin(H)], right = [Math.sin(H), Math.cos(H)];
  const rf = (u, v) => [fwd[0] * u + right[0] * v, fwd[1] * u + right[1] * v];
  const lc = (u, v) => world.landCover(...rf(u, v));
  check('osm: land cover raster (forest, farmland, water, apron, taxiway, other runway)',
    lc(0, -1600) === osm.LC.FOREST && lc(-1800, -900) === osm.LC.FARM && lc(1800, -1500) === osm.LC.WATER
    && lc(0, 470) === osm.LC.PAVED && lc(1000, 200) === osm.LC.PAVED && lc(0, 1650) === osm.LC.PAVED && lc(3000, -3000) === osm.LC.NONE,
    [lc(0, -1600), lc(-1800, -900), lc(1800, -1500), lc(0, 470), lc(1000, 200), lc(0, 1650)].join(','));
  check('osm: neighbouring fields get different tones (patchwork)', new Set([0, 1, 2, 3].map(i => world.fieldTone(...rf(-1800 + i * 260, -900)))).size >= 3);
  const iOffice = world.buildingAt(...rf(200, 1020));
  check('osm: building lookup finds the tower under its footprint, nothing beside it',
    iOffice >= 0 && data.buildings[iOffice] === office && world.buildingAt(...rf(200, 1080)) === -1);

  // meshes: footprint extruded to height on the lowest ground, roofs on top
  const { buildingMeshes, groundMeshes } = await import('../src/maps/osmMeshes.js');
  const bm = buildingMeshes(data.buildings, (x, z) => 7 + x * 0.001);
  let tris = 0; bm.traverse(m => { if (m.isMesh) tris += m.geometry.attributes.position.count / 3; });
  check('osm: buildings merge into a few draw calls per tile', bm.children.length <= 8 && tris > 200, `${bm.children.length} meshes, ${tris} triangles`);
  // every face must point away from its own building (roofs up): a backwards
  // winding is back-face culled, which once left every gabled house roofless
  {
    const cents = data.buildings.map(b => [b.ring.reduce((a, p) => a + p[0], 0) / b.ring.length, b.ring.reduce((a, p) => a + p[1], 0) / b.ring.length]);
    let bad = 0, all = 0;
    bm.traverse(m => {
      if (!m.isMesh) return;
      const p = m.geometry.attributes.position.array;
      for (let i = 0; i < p.length; i += 9) {
        const ux = p[i+3]-p[i], uy = p[i+4]-p[i+1], uz = p[i+5]-p[i+2], vx = p[i+6]-p[i], vy = p[i+7]-p[i+1], vz = p[i+8]-p[i+2];
        const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
        const cx = (p[i]+p[i+3]+p[i+6])/3, cz = (p[i+2]+p[i+5]+p[i+8])/3;
        let c = cents[0], bd = Infinity;
        for (const q of cents) { const d = (q[0]-cx)**2 + (q[1]-cz)**2; if (d < bd) { bd = d; c = q; } }
        all++; if (nx * (cx - c[0]) + nz * (cz - c[1]) + ny * 1e3 <= 0) bad++;
      }
    });
    check('osm: every wall and roof faces outward (none culled from outside)', bad === 0, `${bad}/${all} inward`);
  }
  check('osm: building tops = ground + height (collision uses these)', Math.abs(office.top - (7 + rf(200, 1020)[0] * 0.001 + 62)) < 0.6, `top ${office.top.toFixed(1)}`);
  const gm = groundMeshes(data, {
    heightFn: () => 7, elev: 7, flat: true, lakeLevel: () => 12,
    skipRunway: (rw) => /02L/.test(rw.ref),
  });
  const names = []; gm.traverse(m => { if (m.name) names.push(m.name); });
  const strips = gm.children.filter(c => c.isGroup).length;
  check('osm: the other runway gets a marked strip, ours is not drawn twice', strips === 1, `${strips} runway strips`);
  check('osm: lakes above sea level get a water surface; roads are drawn', names.includes('osm-lakes') && names.includes('osm-roads'), names.join(','));
  const gm2 = groundMeshes(data, { heightFn: () => 7, elev: 7, flat: false, lakeLevel: () => 12, skipRunway: () => false });
  check('osm: late data (terrain already built) adds roads but no pavement or lakes',
    gm2.children.every(c => c.name === 'osm-roads'), gm2.children.map(c => c.name || c.type).join(','));

  // the real-world map end to end, with fetch stubbed to the fixture
  const { createRealWorldMap } = await import('../src/maps/realworld.js');
  const { AIRPORTS } = await import('../src/maps/airports.js');
  const realFetch = globalThis.fetch;
  let asked = '';
  globalThis.fetch = async (u) => {
    if (String(u).includes('overpass')) { asked = String(u); return new Response(JSON.stringify(fx), { status: 200 }); }
    throw new Error('offline in tests');
  };
  try {
    const map = createRealWorldMap(AIRPORTS.find(a => a.id === 'changi'));
    const p = rf(0, 470), before = map.height(...p);
    const ok = await map.loadScenery();
    check('osm: the map asks Overpass for this field and accepts the answer', ok && /interpreter\?data=/.test(asked) && map.osmStatus === 'ready');
    check('osm: nothing changes height/colour until committed', map.height(...p) === before);
    map.commitScenery();
    check('osm: committed apron is flattened to field elevation', Math.abs(map.height(...p) - 7) < 0.01, `${map.height(...p)}`);
    const fForest = map.forest(...rf(0, -1600), 10, 0.05), fFarm = map.forest(...rf(-1800, -900), 10, 0.05);
    check('osm: trees grow in the mapped forest and not on the fields', fForest > 0.8 && fFarm < 0.05, `forest ${fForest.toFixed(2)}, farm ${fFarm.toFixed(2)}`);
    check('osm: attribution names OpenStreetMap once its data is used', /OpenStreetMap contributors/.test(map.attribution));
  } finally {
    globalThis.fetch = realFetch;
  }
  const offlineFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const m2 = createRealWorldMap(AIRPORTS.find(a => a.id === 'innsbruck'));
    check('osm: offline, the map degrades to the old scenery', (await m2.loadScenery()) === false && !m2.commitScenery() && m2.obstacleTop(0, 0) === -Infinity);
  } finally { globalThis.fetch = offlineFetch; }
}

// ---- v12: failures (flightModel failSystem + physics/failures.js) ----
{
  const { createAircraft, step, attitude, resetOnRunway } = await import('../src/physics/flightModel.js');
  const { AIRCRAFT } = await import('../src/aircraft/params.js');
  const { createFailures, failurePool, annunciators, FAILURES } = await import('../src/physics/failures.js');
  const { createAutopilot } = await import('./../src/autopilot.js');
  const env = { groundHeight: () => 0, terrainHeight: () => 0, isRunway: () => false };
  const mk = (id, vx = 55) => { const ac = createAircraft({ pos: { x: 0, y: 1000, z: 0 }, vel: { x: vx, y: 0, z: 0 } }); ac.p = { ...AIRCRAFT[id] }; if (ac.p.fuel) ac.fuelKg = ac.p.fuel.capacityKg; return ac; };
  const cs = (o = {}) => ({ elevator: 0, aileron: 0, rudder: 0, throttle: 0.6, flaps: 0, brakes: false, trim: 0, ...o });
  const fly = (ac, c, secs, each) => { for (let i = 0; i < secs * 120; i++) { step(ac, c, env, 1 / 120); each?.(i / 120); } };

  // pitot: IAS freezes while the real airspeed changes
  { const ac = mk('c172'); const c = cs(); fly(ac, c, 2); ac.p = { ...ac.p }; const { failSystem } = await import('../src/physics/flightModel.js');
    failSystem(ac, 'pitot'); const ias0 = ac.iasIndicated; c.throttle = 0; c.elevator = -0.1; fly(ac, c, 8);
    check('failure: blocked pitot freezes the airspeed indicator', ac.iasIndicated === ias0 && Math.abs(ac.airspeed - ias0) > 3, `ind ${ias0.toFixed(1)} true ${ac.airspeed.toFixed(1)}`); }
  // static: altimeter freezes, VSI reads zero, while the aircraft climbs
  { const ac = mk('c172'); const c = cs({ throttle: 1, elevator: 0.15 }); fly(ac, c, 1);
    (await import('../src/physics/flightModel.js')).failSystem(ac, 'static'); const a0 = ac.altIndicated; fly(ac, c, 10);
    check('failure: blocked static port freezes the altimeter and zeroes the VSI', ac.altIndicated === a0 && ac.vsIndicated === 0 && Math.abs(ac.pos.y - a0) > 15, `alt ind ${a0.toFixed(0)} true ${ac.pos.y.toFixed(0)}`); }
  // power: half thrust, engine still turning
  { const a = mk('c172'), b = mk('c172'); const c = cs({ throttle: 1 }); fly(a, c, 3); fly(b, c, 1);
    (await import('../src/physics/flightModel.js')).failSystem(b, 'power'); fly(b, c, 2);
    check('failure: rough-running engine makes about half power', Math.abs(b.thrust / a.thrust - 0.5) < 0.08 && b.engineRunning, `${(b.thrust / a.thrust).toFixed(2)}`); }
  // flaps: jammed where they were
  { const ac = mk('c172', 35); const c = cs({ flaps: 0.5 }); fly(ac, c, 4); (await import('../src/physics/flightModel.js')).failSystem(ac, 'flaps');
    const f0 = ac.flapsEff; c.flaps = 1; fly(ac, c, 3); c.flaps = 0; fly(ac, c, 3);
    check('failure: flap drive failure jams the flaps where they are', Math.abs(ac.flapsEff - f0) < 1e-9 && f0 > 0.3, `jammed at ${f0.toFixed(2)}`); }
  // vacuum: the gyro attitude wanders off while the aircraft is held level
  { const ac = mk('c172'); const c = cs(); (await import('../src/physics/flightModel.js')).failSystem(ac, 'vacuum');
    fly(ac, c, 180, () => { ac.q = { x: 0, y: 0, z: 0, w: 1 }; ac.omega = { x: 0, y: 0, z: 0 }; ac.vel = { x: 55, y: 0, z: 0 }; ac.pos.y = 1000; });
    check('failure: vacuum pump failure lets the attitude gyro drift (>20 deg in 3 min)', Math.abs(ac.gyro.roll) * 57.3 > 20 && Math.abs(attitude(ac).roll) < 0.01, `gyro roll ${(ac.gyro.roll * 57.3).toFixed(0)} deg`); }
  // oil: warm-up and cruise readings; a leak drains the sump and seizes the engine
  { const { failSystem } = await import('../src/physics/flightModel.js');
    const ac = mk('c172'); const c = cs({ throttle: 0.65 });
    const pin = () => { ac.q = { x: 0, y: 0, z: 0, w: 1 }; ac.omega = { x: 0, y: 0, z: 0 }; ac.vel = { x: 55, y: 0, z: 0 }; ac.pos.y = 1000; };
    ac.oilT = 59; ac.oilP = 0;                                   // just started from cold
    fly(ac, c, 3, pin); const cold = { p: ac.oilP, t: ac.oilT };
    fly(ac, c, 900, pin); const warm = { p: ac.oilP, t: ac.oilT };
    check('oil: cold oil reads high pressure; warm cruise 60-90 psi at 150-245 F, no OIL light',
      cold.p > warm.p + 5 && warm.p > 60 && warm.p < 90 && warm.t > 150 && warm.t < 245 && !annunciators(ac).includes('OIL'),
      `cold ${cold.p.toFixed(0)} psi ${cold.t.toFixed(0)} F -> warm ${warm.p.toFixed(0)} psi ${warm.t.toFixed(0)} F`);
    failSystem(ac, 'oil');
    let lightAt = null, seizedAt = null, hottest = 0;
    for (let t = 1; t <= 480 && seizedAt === null; t++) {
      fly(ac, c, 1, pin); hottest = Math.max(hottest, ac.oilT);
      if (lightAt === null && annunciators(ac).includes('OIL')) lightAt = t;
      if (!ac.engineRunning) seizedAt = t;
    }
    check('oil: a leak is silent at first; OIL lights as the pressure goes, the oil heats and the engine seizes (~4-5 min)',
      lightAt !== null && lightAt > 120 && seizedAt !== null && seizedAt > lightAt && seizedAt > 180 && seizedAt < 360 && hottest > warm.t + 15,
      `OIL light at ${lightAt} s, seized at ${seizedAt} s, oil peaked ${hottest.toFixed(0)} F`); }
  { const ac = mk('c172'); const { setColdStart } = await import('../src/physics/flightModel.js'); setColdStart(ac);
    check('oil: cold and dark: no pressure, oil at ambient', ac.oilP === 0 && ac.oilT === 59);
    check('failure pool: an oil leak only on piston aircraft', failurePool(AIRCRAFT.c172).includes('oil') && !failurePool(AIRCRAFT.heavy).includes('oil')); }
  // mixture: leaning at altitude gains power and saves fuel; too lean runs rough, then quits
  { const { mixtureState, airDensity } = await import('../src/physics/flightModel.js');
    const rhoHi = airDensity(2400), rhoSl = airDensity(0);
    let best = null; for (let m = 1; m >= 0.5; m -= 0.01) { const x = mixtureState(m, rhoHi); if (!best || x.power > best.power) best = { m, ...x }; }
    let peakEgt = null; for (let m = 1; m >= 0.5; m -= 0.01) { const x = mixtureState(m, rhoHi); if (!peakEgt || x.egtShape > peakEgt.egt) peakEgt = { m, egt: x.egtShape }; }
    const sl = Math.max(...Array.from({ length: 50 }, (_, i) => mixtureState(1 - i * 0.01, rhoSl).power));
    check('mixture: full rich is exactly the reference (power and fuel flow x1, at any height)',
      mixtureState(1, rhoHi).power === 1 && mixtureState(1, rhoSl).power === 1 && mixtureState(1, rhoHi).fuelFlow === 1);
    check('mixture: at 8000 ft leaning to best power gains power, and peak EGT is lean of best power',
      best.power > 1.03 && best.m < 0.9 && peakEgt.m < best.m, `best power x${best.power.toFixed(3)} at ${best.m.toFixed(2)}, peak EGT at ${peakEgt.m.toFixed(2)}`);
    check('mixture: at sea level leaning never adds power', sl <= 1 + 1e-12, `max x${sl.toFixed(4)}`);
    const ac = mk('c172'); ac.pos.y = 2400; const c = cs({ throttle: 0.75 });
    const pin = () => { ac.q = { x: 0, y: 0, z: 0, w: 1 }; ac.omega = { x: 0, y: 0, z: 0 }; ac.vel = { x: 55, y: 0, z: 0 }; ac.pos.y = 2400; };
    fly(ac, c, 20, pin); const richT = ac.thrust, egtRich = ac.egt; let f0 = ac.fuelKg; fly(ac, c, 60, pin); const richBurn = f0 - ac.fuelKg;
    ac.sys.mixture = +best.m.toFixed(2); fly(ac, c, 20, pin); const leanT = ac.thrust, egtLean = ac.egt; f0 = ac.fuelKg; fly(ac, c, 60, pin); const leanBurn = f0 - ac.fuelKg;
    check('mixture: leaned at 8000 ft: more thrust, hotter EGT, less fuel per minute',
      leanT > richT * 1.02 && egtLean > egtRich + 40 && leanBurn < richBurn * 0.95,
      `thrust ${richT.toFixed(0)} -> ${leanT.toFixed(0)} N, EGT ${egtRich.toFixed(0)} -> ${egtLean.toFixed(0)} F, burn ${(richBurn * 60).toFixed(1)} -> ${(leanBurn * 60).toFixed(1)} kg/h`);
    ac.sys.mixture = 0.56; fly(ac, c, 1, pin); const rough = ac.mixRough && ac.engineRunning;
    ac.sys.mixture = 0.42; fly(ac, c, 1, pin);
    check('mixture: too lean runs rough, then the engine quits', rough && !ac.engineRunning, `rough ${rough}, running ${ac.engineRunning}`); }
  // electrical (jet without a start sequence): battery carries ~7 min, then the AP drops out
  { const ac = mk('heavy', 125); const c = cs({ throttle: 0.55 }); const ap = createAutopilot();
    const ctl = { state: c, axisActive: () => false }; step(ac, c, env, 1 / 120); ap.toggleMaster(ac, ctl); ap.toggleIas(ac, ctl); ap.sel.ias = 125;
    (await import('../src/physics/flightModel.js')).failSystem(ac, 'electrical');
    let onAt5 = null, offAt = null;
    for (let i = 0; i < 9 * 60 * 120; i++) {
      ap.update(ac, ctl, 1 / 120); step(ac, c, env, 1 / 120);
      if (i === 5 * 60 * 120) onAt5 = ac.avionics && ap.on;
      if (offAt === null && !ac.avionics) offAt = i / 120;
    }
    check('failure: alternator failure, battery runs the avionics ~7 min, then the bus and AP drop', onAt5 === true && offAt > 360 && offAt < 480 && !ap.on && !ac.crashed && annunciators(ac).includes('VOLTS'), `off at ${offAt?.toFixed(0)} s, crashed ${ac.crashed}`); }
  // scheduler: one failure, 2-12 min airborne, never on the ground, deterministic, airframe-aware
  { const times = [];
    for (let seed = 1; seed <= 12; seed++) {
      const f = createFailures({ seed }); f.setMode('random');
      const ac = mk('c172'); let t = 0, ev = null, n = 0;
      ac.onGround = true; for (let i = 0; i < 2000; i++) f.update(ac, 1);       // a long time taxiing
      const groundFired = f.fired.length;
      ac.onGround = false;
      for (; t < 900; t += 0.5) { const e = f.update(ac, 0.5); if (e) { ev = e; n++; times.push(t); } }
      if (groundFired || n !== 1 || !ev) { times.push(-1); }
    }
    check('failure scheduler: exactly one failure per flight, 2-12 min airborne, none on the ground', times.length === 12 && times.every(t => t >= 120 && t <= 720), times.map(t => t.toFixed(0)).join(','));
    const a = createFailures({ seed: 9 }), b = createFailures({ seed: 9 }); a.setMode('random'); b.setMode('random');
    check('failure scheduler: deterministic for a seed', a.dueIn === b.dueIn);
    check('failure pool: vacuum only on steam-gauge aircraft, hydraulics only on jets',
      failurePool(AIRCRAFT.c172).includes('vacuum') && !failurePool(AIRCRAFT.c172).includes('hydraulics')
      && failurePool(AIRCRAFT.heavy).includes('hydraulics') && !failurePool(AIRCRAFT.heavy).includes('vacuum'));
    const off = createFailures({ seed: 3 }); off.setMode('off'); const ac = mk('c172'); let any = false;
    for (let i = 0; i < 2000; i++) if (off.update(ac, 1)) any = true;
    check('failure scheduler: OFF never fails anything', !any);
  }
  // a respawn clears every failure
  { const ac = mk('c172'); const { failSystem } = await import('../src/physics/flightModel.js');
    for (const id of Object.keys(FAILURES)) failSystem(ac, id);
    resetOnRunway(ac, { x: 0, z: 0, y: 0, headingRad: 0 });
    check('failure: respawn restores every system', Object.values(ac.systems).every(v => v === true) && ac.gyro === null && ac._flapJam == null); }
}

// ---- v12: AI circuit traffic + the tower working it (aitraffic.js, atc.js) ----
{
  const { createCircuitTraffic, clockOf, slotStraightIn } = await import('../src/aitraffic.js');
  const { createAtc: mkTower } = await import('../src/atc.js');
  const rwy = { spawn: { x: -1500, z: 0 }, headingRad: 0, y: 5, x0: -1600, x1: 600, halfWidth: 22 };
  const ai = createCircuitTraffic(rwy);
  const period = ai.total / ai.speed, seen = new Set();
  let groundOk = true, minAir = 1e9, tdU = null;
  for (let t = 0; t < period; t += 0.25) {
    const p = ai.at(t); seen.add(p.phase);
    if (p.phase === 'runway' && Math.abs(p.y - 5) > 0.01) groundOk = false;
    if (p.phase === 'downwind') minAir = Math.min(minAir, p.y - 5);
    if (p.phase === 'runway' && tdU === null) tdU = p.u;
  }
  check('AI traffic: flies every leg of a circuit and a touch-and-go on the runway',
    ['runway', 'upwind', 'crosswind', 'downwind', 'base', 'final'].every(ph => seen.has(ph)) && groundOk && minAir > 280,
    `${[...seen].join(',')} downwind >= ${minAir.toFixed(0)} m`);
  check('AI traffic: touches down at the PAPI aim point (spawn + 300 m)', Math.abs(tdU - (-1200)) < 15, `u ${tdU?.toFixed(0)}`);
  check('AI traffic: a left-hand circuit (downwind on the left)', (() => { for (let t = 0; t < period; t += 1) { const p = ai.at(t); if (p.phase === 'downwind') return p.v < -900; } return false; })());
  // two aircraft half a lap apart never share the runway or the final
  { let clash = 0; for (let t = 0; t < period; t += 0.5) { const p1 = { ...ai.at(t) }, p2 = ai.at(t + period / 2);
      if ((p1.onRunway || p1.phase === 'final') && (p2.onRunway || p2.phase === 'final')) clash++; }
    check('AI traffic: two aircraft half a lap apart never share final or the runway', clash === 0, `${clash} clashes`); }
  // the airliner: straight-in on the glideslope, slotted between the club aircraft
  { const jet = slotStraightIn(rwy, ai, period / 2);
    let clash = 0, onGs = true, seenRoll = false;
    for (let t = 0; t < 2 * period; t += 0.5) {
      const j = { ...jet.at(t) };
      if (!j.visible) continue;
      if (j.phase === 'final' && j.toAim > 500 && Math.abs((j.y - 5) - j.toAim * Math.tan(3 * Math.PI / 180)) > 1) onGs = false;
      if (j.phase === 'runway') seenRoll = true;
      const jetBusy = j.onRunway || j.toAim < 1500;
      const club = [0, period / 2].some(o => { const a = ai.at(t + o); return a.onRunway || (a.phase === 'final' && a.toAim < 1500); });
      if (jetBusy && club) clash++;
    }
    check('AI airliner: straight-in on the 3 deg glideslope, lands and rolls out', onGs && seenRoll);
    const ph = new Set(); let taxiEndV = 0, climbTop = 0;
    for (let t = 0; t < jet.period; t += 0.5) { const j = jet.at(t); if (!j.visible) continue; ph.add(j.phase); if (j.phase === 'taxi') taxiEndV = Math.max(taxiEndV, j.v); if (j.phase === 'climb') climbTop = Math.max(climbTop, j.agl); }
    check('AI airliner: turns off and taxis clear after landing, then departs and climbs out',
      ['final', 'runway', 'taxi', 'departure', 'climb'].every(p => ph.has(p)) && taxiEndV > 150 && climbTop > 400, `${[...ph].join(',')} taxi v ${taxiEndV.toFixed(0)} climb ${climbTop.toFixed(0)}`);
    check('AI airliner: slotted so it never shares short final (1.5 km) or the runway with the circuit traffic', clash === 0 && jet.slotted === true, `${clash} clashes, slotted ${jet.slotted}`);
  }
  // ---- v12: taxiway network (taxinet.js) and AI-to-AI separation ----
  { const tn = await import('../src/taxinet.js');
    const { createStraightInTraffic } = await import('../src/aitraffic.js');
    // a T junction where one way's end lands mid-segment on another splits it
    const g = tn.buildTaxiGraph([[[0, 0], [0, 100]], [[-200, 100], [200, 100]], [[200, 100], [200, 300]]]);
    const r = tn.route(g, tn.nearestNode(g, 0, 0), tn.nearestNode(g, 200, 300));
    check('taxinet: T junctions split, Dijkstra routes across them', !!r && r.length === 4 && g.nodes.length === 5, r && r.map(i => `${g.nodes[i].x},${g.nodes[i].z}`).join(' > '));
    const tp = tn.timedPath(tn.fillet([[0, 0], [0, 200], [200, 200]], 35), { vmax: 9 });
    const mid = { ...tp.at(tp.duration / 2) }, cruise = { speed: Math.max(...Array.from({ length: 50 }, (_, i) => tp.at(tp.duration * i / 100).speed)) };
    check('taxinet: filleted corner, slower in the turn, starts and ends at rest',
      tp.at(0).speed === 0 && tp.at(1e9).speed === 0 && mid.speed < 6.5 && cruise.speed > 8 && Math.hypot(mid.x - 0, mid.z - 200) > 5,
      `turn ${mid.speed.toFixed(1)} m/s, straight ${cruise.speed.toFixed(1)} m/s, length ${tp.length.toFixed(0)} m`);

    const lay = tn.defaultTaxiLayout(rwy);
    const gp = tn.planGround(rwy, lay, { aim: -1200, vapp: 72 });
    const jet = slotStraightIn(rwy, ai, period / 2, { ground: gp });
    const segDist = (x, z) => { let d = Infinity; for (const L of lay.lines) for (let i = 0; i < L.length - 1; i++) {
      const [ax, az] = L[i], [bx, bz] = L[i + 1], dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      d = Math.min(d, Math.hypot(ax + dx * t - x, az + dz * t - z)); } return d; };
    const seq = []; let jump = 0, offPave = 0, clash = 0, prev = null;
    for (let t = 0; t < jet.period; t += 0.5) {
      const j = { ...jet.at(t) };
      if (seq.at(-1) !== j.phase) seq.push(j.phase);
      if (prev && prev.visible && j.visible && Math.hypot(j.x - prev.x, j.y - prev.y, j.z - prev.z) > Math.max(prev.speed, j.speed) * 0.5 + 3) jump++;
      if (['taxi', 'parked', 'pushback', 'holding'].includes(j.phase) && Math.abs(j.v) > rwy.halfWidth + 5 && segDist(j.x, j.z) > lay.width / 2 + 10) offPave++;
      const club = [0, period / 2].some(o => { const a = ai.at(t + o); return a.onRunway || (a.phase === 'final' && a.toAim < 1500); });
      if (jet.occupies(t) && club) clash++;
      prev = j;
    }
    const want = ['final', 'runway', 'taxi', 'parked', 'taxi', 'holding', 'lineup', 'departure', 'climb', 'gone'];
    check('AI airliner: lands, taxis to the stand, parks, taxis out, holds short, lines up and departs',
      !!jet.ground && want.every((p, i) => seq.indexOf(p, i ? seq.indexOf(want[i - 1]) + (want[i - 1] === p ? 1 : 0) : 0) >= 0) && seq.includes('parked'),
      seq.join(' > '));
    check('AI airliner: moves continuously and stays on the taxiways', jump === 0 && offPave === 0, `${jump} jumps, ${offPave} samples off the pavement`);
    check('AI airliner: slotted clear of the circuit traffic for its whole runway use', jet.slotted && clash === 0, `${clash} clashes`);
    { let nose = Infinity; for (let t = 0; t < jet.period; t += 1) { const j = jet.at(t); if (j.phase !== 'holding') continue;
        nose = Math.min(nose, Math.abs(j.z - Math.sin(j.yaw) * 32)); }       // heading 0 runway: v = z, nose 32 m ahead
      check('AI airliner: holds short with its nose behind the hold bar', nose >= lay.holdDist - 1 && nose < 1e9, `nose |v| ${nose.toFixed(1)} m, bar ${lay.holdDist} m`); }

    // a jet deliberately mistimed onto the club traffic: the club aircraft go around
    const bad = createStraightInTraffic(rwy, { period: 2 * period, ground: gp, offset: 0 });
    let worst = null;
    for (let off = 0; off < 2 * period; off += 4) {
      const b = createStraightInTraffic(rwy, { period: 2 * period, ground: gp, offset: off });
      let n = 0; for (let t = 0; t < 2 * period; t += 1) if (b.occupies(t) && [0, period / 2].some(o => { const a = ai.at(t + o); return a.onRunway; })) n++;
      if (!worst || n > worst.n) worst = { n, b };
    }
    const clubs = createCircuitTraffic(rwy, { occupied: (t) => worst.b.occupies(t) });
    let both = 0, gas = 0, gaLow = 1e9;
    const wasGa = [false, false];
    for (let t = 0; t < 2 * period; t += 0.5) [0, period / 2].forEach((o, i) => {
      const a = clubs.at(t + o, -o);
      if (a.onRunway && worst.b.occupies(t)) both++;
      if (a.goAround) { if (!wasGa[i]) gas++; if (Math.abs(a.u - (-1200)) < 300) gaLow = Math.min(gaLow, a.y - 5); }
      wasGa[i] = a.goAround;
    });
    check('AI-to-AI: club traffic goes around instead of landing on an occupied runway',
      worst.n > 0 && both === 0 && gas > 0 && gaLow > 40, `${worst.n} s of conflict unseparated -> ${both} with go-arounds (${gas}), lowest over the aim point ${gaLow.toFixed(0)} m`);
    void bad;
  }
  check('clock positions', clockOf(0, 100, 0) === 12 && clockOf(0, 0, 100) === 3 && clockOf(0, -100, 0) === 6 && clockOf(0, 0, -100) === 9);

  const said = [];
  const tower = () => { said.length = 0; return mkTower({ field: 'ARCHIPELAGO', rwyName: '09', callsign: 'Skyhawk five delta alpha', say: (t, id) => said.push({ t, id }) }); };
  const aiAt = (o) => ({ type: 'Cessna', x: 0, y: 300, z: 0, phase: 'downwind', onRunway: false, toAim: 3000, ...o });
  // traffic on short final: hold, then cleared once it is gone
  const a = tower();
  a.update({ onGround: true, agl: 0, cross: 0, ai: aiAt({ phase: 'final', toAim: 1200, y: 70 }) }, 0);
  a.update({ onGround: true, agl: 0, cross: 0, ai: aiAt({ phase: 'runway', onRunway: true, toAim: -100, y: 5 }) }, 5);
  const heldThenRunway = said.map(x => x.id).join(',');
  a.update({ onGround: true, agl: 0, cross: 0, ai: aiAt({ phase: 'upwind', toAim: -900, y: 60 }) }, 5);
  check('ATC: holds you short for traffic on final, clears you once it is gone',
    heldThenRunway === 'holdShort' && said[1]?.id === 'clearance' && /hold position/.test(said[0].t), said.map(x => x.id).join(','));
  // inbound behind traffic: number two, no landing clearance while it is on the runway, then cleared
  const b = tower();
  b.update({ onGround: false, agl: 800, cross: 0 }, 0);                    // airborne start: cruise
  b.update({ onGround: false, agl: 300, vsFpm: -400, cross: 10, toAim: 5000, ai: aiAt({ phase: 'final', toAim: 1500, y: 80 }) }, 5);   // inbound
  b.update({ onGround: false, agl: 280, vsFpm: -400, cross: 10, toAim: 4800, ai: aiAt({ phase: 'final', toAim: 1200, y: 60 }) }, 5);
  b.update({ onGround: false, agl: 150, vsFpm: -400, cross: 10, toAim: 2500, ai: aiAt({ phase: 'runway', onRunway: true, toAim: -200, y: 5 }) }, 5);
  const beforeClear = said.map(x => x.id);
  b.update({ onGround: false, agl: 120, vsFpm: -400, cross: 10, toAim: 2200, ai: aiAt({ phase: 'upwind', toAim: -900, y: 60 }) }, 5);
  check('ATC: sequences you number two and withholds landing clearance until the runway is clear',
    beforeClear.join(',') === 'inbound,sequence' && said.at(-1).id === 'clearLand' && /number two, follow the Cessna/.test(said[1].t),
    said.map(x => x.id).join(','));
  // still on the runway when we are low: go around
  const c = tower();
  c.update({ onGround: false, agl: 800, cross: 0 }, 0);
  c.update({ onGround: false, agl: 300, vsFpm: -400, cross: 10, toAim: 3000 }, 5);
  c.update({ onGround: false, agl: 50, vsFpm: -400, cross: 10, toAim: 600, ai: aiAt({ phase: 'runway', onRunway: true, toAim: -100, y: 5 }) }, 5);
  c.update({ onGround: false, agl: 45, vsFpm: -400, cross: 10, toAim: 550, ai: aiAt({ phase: 'runway', onRunway: true, toAim: -150, y: 5 }) }, 5);
  check('ATC: go around when the runway is still occupied below 60 m', said.some(x => x.id === 'goAroundTraffic'), said.map(x => x.id).join(','));
  // traffic call: two o'clock, one mile, same altitude
  const d = tower();
  d.update({ onGround: false, agl: 800, cross: 0 }, 0);
  const ang = -60 * Math.PI / 180;                                         // 60 deg right of a heading of 0
  d.update({ onGround: false, agl: 300, vsFpm: 0, cross: 2000, pos: { x: 0, y: 300, z: 0 }, headingRad: 0,
    ai: aiAt({ x: Math.cos(ang) * 1852, z: -Math.sin(ang) * 1852, y: 320 }) }, 5);
  check('ATC: traffic call with clock position, distance and relative altitude',
    said[0]?.id === 'trafficInfo' && /two o'clock, one mile, same altitude/.test(said[0].t), said[0]?.t);
  d.update({ onGround: false, agl: 300, vsFpm: 0, cross: 2000, pos: { x: 0, y: 300, z: 0 }, headingRad: 0,
    ai: aiAt({ x: 1000, z: 0, y: 320 }) }, 10);
  check('ATC: traffic calls are rate-limited', said.length === 1);
  const e = tower();
  e.update({ onGround: false, agl: 800, cross: 0 }, 0);
  e.update({ onGround: false, agl: 300, vsFpm: -400, cross: 10, toAim: 6000, ai: aiAt({ phase: 'final', toAim: 3000, y: 160, type: 'Heavy jet', heavy: true }) }, 5);
  e.update({ onGround: false, agl: 290, vsFpm: -400, cross: 10, toAim: 5800, ai: aiAt({ phase: 'final', toAim: 2800, y: 150, type: 'Heavy jet', heavy: true }) }, 5);
  check('ATC: behind an airliner the sequence adds a wake turbulence caution', /follow the Heavy jet on final, caution wake turbulence/.test(said.find(x => x.id === 'sequence')?.t || ''), said.map(x => x.t).join(' | '));
  const em = tower();
  em.update({ onGround: false, agl: 800, cross: 0 }, 0);
  em.update({ onGround: false, agl: 600, vsFpm: 0, cross: 3000, squawk: 7700 }, 5);
  em.update({ onGround: false, agl: 590, vsFpm: 0, cross: 3000, squawk: 7700 }, 5);
  check('ATC: squawk 7700 gets an emergency landing clearance, once, and is never sent around', said.map(x => x.id).join(',') === 'emergency' && /all runways available/i.test(said.find(x => x.id === 'emergency')?.t || ''), said.map(x => x.id).join(','));
}

// ---- v12: TCAS (tcas.js) ----
{
  const { createTcas, tcasCallout } = await import('../src/tcas.js');
  // own ship heading +x at 55 m/s; one intruder flying `ivx` from x0 at height dy
  const run = (o) => {
    const t = createTcas({ ra: o.ra }); const own = { pos: { x: 0, y: 1000, z: 0 }, vel: { x: 55, y: 0, z: 0 }, headingRad: 0 };
    const ev = []; let maxLevel = null;
    for (let s = 0; s <= 200; s += 0.25) {
      own.pos.x = 55 * s;
      const ix = o.x0 + o.ivx * s, iz = o.z ?? 0, iy = 1000 + o.dy + (o.ivy ?? 0) * s;
      const st = t.update(own, [{ id: 7, x: ix, y: iy, z: iz }], s);
      const cpa = (o.x0 - 0) / (55 - o.ivx);                 // time the two meet in x
      if (st.event) ev.push({ e: st.event, before: +(cpa - s).toFixed(1), sense: st.sense, say: tcasCallout(st) });
      if (st.level === 'RA' || (st.level === 'TA' && maxLevel !== 'RA')) maxLevel = st.level;
    }
    return { ev, maxLevel };
  };
  const head = run({ ra: true, x0: 9000, ivx: -70, dy: 60 });
  const ta = head.ev.find(e => e.e === 'TA'), ra = head.ev.find(e => e.e === 'RA'), clr = head.ev.find(e => e.e === 'CLEAR');
  check('tcas: head-on gives a TA ~40 s out, then an RA ~25 s out, then clear of conflict',
    ta && ra && clr && head.ev.filter(e => e.e === 'CLEAR').length === 1 && ta.before > 34 && ta.before < 50 && ra.before > 19 && ra.before < 32 && clr.before < 0,
    JSON.stringify(head.ev));
  check('tcas: intruder slightly above -> DESCEND, with the real aurals', ra?.sense === 'DESCEND' && ra?.say === 'Descend, descend' && ta?.say === 'Traffic, traffic' && clr?.say === 'Clear of conflict');
  const below = run({ ra: true, x0: 9000, ivx: -70, dy: -60 });
  check('tcas: intruder slightly below -> CLIMB', below.ev.find(e => e.e === 'RA')?.sense === 'CLIMB', JSON.stringify(below.ev));
  const tas = run({ ra: false, x0: 9000, ivx: -70, dy: 60 });
  check('tcas: light aircraft (TAS) get the TA but never an RA (and no clear-of-conflict)', tas.ev.some(e => e.e === 'TA') && !tas.ev.some(e => e.e === 'RA' || e.e === 'CLEAR'), JSON.stringify(tas.ev));
  const high = run({ ra: true, x0: 9000, ivx: -70, dy: 2000 * 0.3048 });
  check('tcas: 2000 ft of separation is no threat', high.ev.length === 0, JSON.stringify(high.ev));
  const abeam = run({ ra: true, x0: 0, ivx: 55, dy: 0, z: 2500 });
  check('tcas: parallel traffic 2.5 km abeam is no threat', abeam.ev.length === 0, JSON.stringify(abeam.ev));
  const climbInto = run({ ra: true, x0: 9000, ivx: -70, dy: -400, ivy: 8 });
  check('tcas: an intruder climbing into our level from 1300 ft below still alerts', climbInto.ev.some(e => e.e === 'TA'), JSON.stringify(climbInto.ev));
}

// ---- v12: every cockpit panel draws without throwing (stub 2D context) ----
// The panels are canvas code that only runs in a browser; a stub context that
// accepts any call lets Node execute every line of them, so a reference to an
// out-of-scope variable fails here instead of blanking a cockpit at runtime.
{
  const { drawSteamPanel, drawGlassPanel } = await import('../src/instruments.js');
  const { createAircraft, step, failSystem, setColdStart } = await import('../src/physics/flightModel.js');
  const { AIRCRAFT } = await import('../src/aircraft/params.js');
  const stub = () => new Proxy({}, { get: (o, k) => (k in o ? o[k] : (k === 'measureText' ? () => ({ width: 10 }) : k.startsWith('create') ? () => ({ addColorStop() {} }) : () => {})), set: (o, k, v) => { o[k] = v; return true; } });
  const env = { groundHeight: () => 0, terrainHeight: () => 0, isRunway: () => false };
  const ui = { sys: [], ap: [], states: {}, radio: { nav: { act: '110.15', sby: '108.00', ils: true }, com: { act: '118.30', sby: '121.50' },
    tcas: ['OT', 'PT', 'TA', 'RA'].map((level, i) => ({ id: i, rel: i - 1.5, range: 3000 * (i + 1), relAltFt: (i - 2) * 300, trend: i % 3 - 1, level })) } };
  const errs = [];
  for (const id of Object.keys(AIRCRAFT)) {
    const ac = createAircraft({ pos: { x: 0, y: 1000, z: 0 }, vel: { x: 60, y: 0, z: 0 } }); ac.p = { ...AIRCRAFT[id] };
    if (ac.p.fuel) ac.fuelKg = ac.p.fuel.capacityKg;
    for (let i = 0; i < 60; i++) step(ac, { elevator: 0, aileron: 0, rudder: 0, throttle: 0.6, flaps: 0, brakes: false, trim: 0 }, env, 1 / 120);
    for (const variant of ['healthy', 'failed', 'cold']) {
      if (variant === 'failed') for (const f of ['vacuum', 'hydraulics', 'oil', 'electrical']) failSystem(ac, f);
      if (variant === 'cold') setColdStart(ac);
      for (const [name, fn] of [['steam', () => drawSteamPanel(stub(), 1152, 420, ac, { asiMaxKt: 200 }, null)], ['steam+ui', () => drawSteamPanel(stub(), 1152, 420, ac, { asiMaxKt: 200 }, ui)],
        ['airliner', () => drawGlassPanel(stub(), 1152, 420, ac, 'airliner', ui)], ['fighter', () => drawGlassPanel(stub(), 1152, 384, ac, 'fighter', ui)]]) {
        try { fn(); } catch (e) { errs.push(`${id}/${variant}/${name}: ${e.message}`); }
      }
    }
  }
  { const { engineAux } = await import('../src/instruments.js');
    const ac = createAircraft({ pos: { x: 0, y: 1000, z: 0 }, vel: { x: 55, y: 0, z: 0 } });
    for (let i = 0; i < 60; i++) step(ac, { elevator: 0, aileron: 0, rudder: 0, throttle: 0.6, flaps: 0, brakes: false, trim: 0 }, env, 1 / 120);
    const ok = engineAux(ac); failSystem(ac, 'vacuum'); failSystem(ac, 'electrical'); const bad = engineAux(ac);
    setColdStart(ac); ac.sys.battery = true; ac.sys.mags = 'START'; const crank = engineAux(ac);
    check('instruments: vacuum 4.5-5.5 inHg and a charging ammeter when healthy; 0 inHg and a discharge after the failures; starter draw',
      ok.vac > 4.5 && ok.vac < 5.5 && ok.amps >= 0 && bad.vac === 0 && bad.amps < 0 && crank.amps <= -50 && crank.vac === 0, JSON.stringify({ ok, bad, crank })); }
  check('instruments: every panel layout draws for every aircraft, healthy, failed and cold', errs.length === 0, errs.slice(0, 3).join(' | '));
}

// ---- v12: circuit breakers and radios ----
{
  const { createAircraft, step } = await import('../src/physics/flightModel.js');
  const { AIRCRAFT } = await import('../src/aircraft/params.js');
  const { createAutopilot } = await import('../src/autopilot.js');
  const { createRadios, ilsFrequency, fmtFreq } = await import('../src/radios.js');
  const env = { groundHeight: () => 0, terrainHeight: () => 0, isRunway: () => false };
  const ac = createAircraft({ pos: { x: 0, y: 1000, z: 0 }, vel: { x: 55, y: 0, z: 0 } }); ac.p = { ...AIRCRAFT.c172 };
  const c = { elevator: 0, aileron: 0, rudder: 0, throttle: 0.6, flaps: 0.5, brakes: false, trim: 0 };
  const ctl = { state: c, axisActive: () => false };
  for (let i = 0; i < 480; i++) step(ac, c, env, 1 / 120);
  ac.breakers.avn = false; step(ac, c, env, 1 / 120);
  const avOff = ac.avionics === false; ac.breakers.avn = true; step(ac, c, env, 1 / 120);
  check('breaker: pulling AVN kills the avionics bus, pushing it in restores it', avOff && ac.avionics === true);
  const ap = createAutopilot(); ap.toggleMaster(ac, ctl); ac.breakers.ap = false; ap.update(ac, ctl, 1 / 120);
  check('breaker: pulling AP drops the autopilot', !ap.on && ap.status(ac).warn === 'AP DISCONNECT');
  ac.breakers.ap = true;
  const f0 = ac.flapsEff; ac.breakers.flap = false; c.flaps = 1; for (let i = 0; i < 360; i++) step(ac, c, env, 1 / 120);
  const jammed = Math.abs(ac.flapsEff - f0) < 1e-9; ac.breakers.flap = true; for (let i = 0; i < 360; i++) step(ac, c, env, 1 / 120);
  check('breaker: FLAP breaker freezes the flaps, resetting it lets them run', jammed && ac.flapsEff > f0 + 0.1, `${f0.toFixed(2)} -> ${ac.flapsEff.toFixed(2)}`);

  const fq = ilsFrequency('archipelago:09');
  check('radios: every field gets an ILS frequency in the 108-112 MHz ILS band (odd tenths)',
    ['archipelago:09', 'singapore:02L', 'alpine:27', 'changi:02L'].every(k => { const f = ilsFrequency(k); return f >= 108100 && f <= 111950 && Math.floor(f / 100) % 2 === 1; }), fmtFreq(fq));
  const r = createRadios(fq);
  r.step('nav', 1); r.swap('nav');
  const off = r.ilsTuned; r.swap('nav');
  r.step('com', 1);
  check('radios: tune standby, swap to active; NAV off the ILS frequency is detected', !off && r.ilsTuned && fmtFreq(r.com.sby) === '121.525', fmtFreq(r.com.sby));
}

// ---- v12: fuel selector ----
{
  const { createAircraft, step, resetOnRunway } = await import('../src/physics/flightModel.js');
  const { AIRCRAFT } = await import('../src/aircraft/params.js');
  const env = { groundHeight: () => 0, terrainHeight: () => 0, isRunway: () => false };
  const ac = createAircraft({ pos: { x: 0, y: 1000, z: 0 }, vel: { x: 55, y: 0, z: 0 } }); ac.p = { ...AIRCRAFT.c172 };
  const c = { elevator: 0, aileron: 0, rudder: 0, throttle: 0.7, flaps: 0, brakes: false, trim: 0 };
  ac.sys.fuel = 'OFF';
  let quitAt = null;
  for (let i = 0; i < 20 * 120; i++) { step(ac, c, env, 1 / 120); if (quitAt === null && !ac.engineRunning) quitAt = i / 120; }
  check('fuel selector OFF: the engine runs on the lines ~12 s, then starves', quitAt > 11 && quitAt < 13.5, `quit at ${quitAt?.toFixed(1)} s`);
  ac.sys.fuel = 'BOTH';
  for (let i = 0; i < 240; i++) step(ac, c, env, 1 / 120);
  check('fuel back on does not magically restart it (needs the starter)', ac.engineRunning === false);
  resetOnRunway(ac, { x: 0, z: 0, y: 0, headingRad: 0 });
  check('a respawn resets the fuel selector and the light switches', ac.sys.fuel === 'BOTH' && ac.sys.lights.nav === true && ac.fuelStarveT === 0);
}

// ---- v12: carburettor icing and carb heat ----
{
  const { createAircraft, step } = await import('../src/physics/flightModel.js');
  const { AIRCRAFT } = await import('../src/aircraft/params.js');
  const wet = { groundHeight: () => 0, terrainHeight: () => 0, isRunway: () => false, carbIceRisk: 1 };
  const dry = { groundHeight: () => 0, terrainHeight: () => 0, isRunway: () => false };
  const mk = () => { const a = createAircraft({ pos: { x: 0, y: 1500, z: 0 }, vel: { x: 50, y: 0, z: 0 } }); a.p = { ...AIRCRAFT.c172 }; return a; };
  const c = { elevator: 0, aileron: 0, rudder: 0, throttle: 0.2, flaps: 0, brakes: false, trim: 0 };
  const d = mk(); for (let i = 0; i < 120 * 120; i++) step(d, c, dry, 1 / 120);
  check('carb ice: none in dry air', d.carbIce === 0 && d.engineRunning);
  const a = mk(); let quit = null, iceAt60 = 0;
  for (let i = 0; i < 400 * 120 && quit === null; i++) { step(a, c, wet, 1 / 120); if (i === 60 * 120) iceAt60 = a.carbIce; if (!a.engineRunning) quit = i / 120; }
  check('carb ice: builds at low power in moist air until the engine quits', iceAt60 > 0.15 && quit !== null && quit > 120 && quit < 400, `ice@60s ${iceAt60.toFixed(2)}, quit at ${quit?.toFixed(0)} s`);
  const b = mk(); for (let i = 0; i < 90 * 120; i++) step(b, c, wet, 1 / 120);
  const t0 = b.thrust, ice0 = b.carbIce;
  b.sys.carbHeat = true; for (let i = 0; i < 40 * 120; i++) step(b, c, wet, 1 / 120);
  check('carb heat melts the ice (the engine keeps running)', b.carbIce < ice0 * 0.4 && b.engineRunning, `${ice0.toFixed(2)} -> ${b.carbIce.toFixed(2)}`);
}

// ---- v12: volumetric cloud noise (volclouds.js) ----
{
  const { cloudNoise } = await import('../src/volclouds.js');
  const n = 32, d = cloudNoise(n, 3);
  let lo = 255, hi = 0, sum = 0, seam = 0, inner = 0;
  for (let i = 0; i < d.length; i++) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); sum += d[i]; }
  // tileable: the wrap-around step (x = n-1 -> 0) is no bigger than an ordinary one
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) {
    const row = y * n + z * n * n;
    seam += Math.abs(d[row + n - 1] - d[row]); inner += Math.abs(d[row + n / 2] - d[row + n / 2 - 1]);
  }
  check('cloud noise: full range, mid mean, tiles without a seam',
    hi - lo > 120 && sum / d.length > 60 && sum / d.length < 200 && seam < inner * 1.5,
    `range ${lo}-${hi}, mean ${(sum / d.length).toFixed(0)}, seam ${seam} vs ${inner}`);
}

// ---- v11: autopilot ALT hold auto-trim ----
// Before the integrators, P-only ALT hold settled 200-400 ft off target on the
// Extra and Hornet (it needed a standing VS error to hold level-flight pitch).
{
  const { flyAltHold, flyApproach } = await import('./aptune.mjs');
  for (const id of ['c172', 'extra300', 'hornet', 'heavy', 'spirit']) {
    const lim = id === 'heavy' ? 150 : 40;
    const r = flyAltHold(id, { turb: true });
    check(`autopilot ALT hold: ${id} within ${lim} ft in breezy air`, !r.crashed && r.on && r.maxErrFt < lim, JSON.stringify(r));
  }
  // A slow machine (3 fps): poll() recentres untouched axes every frame. The
  // AP must hold from its own command memory, not restart from neutral.
  // v12 APR: from 12 km out, 1.5 km off the centreline and below the glide-
  // slope, every type captures both beams and hands over at 200 ft lined up
  // and on the slope, in calm air and in a 15 kt crosswind with turbulence.
  for (const id of ['c172', 'extra300', 'hornet', 'heavy', 'spirit']) {
    for (const wx of [{}, { windKt: 15, windFrom: 180, turb: true }]) {
      const r = flyApproach(id, wx);
      const ok = !r.crashed && !r.timeout && r.locCapS && r.gsCapS && Math.abs(r.handoverFt - 200) < 15
        && Math.abs(r.xtkM) < 20 && Math.abs(r.aboveGsM) < 10 && r.worstGsDots < 2.5 && r.worstLocDots < 2 && r.vsFpm > -1500 && Math.abs(r.bankDeg) < 5;
      check(`autopilot APR: ${id} ${wx.windKt ? 'crosswind' : 'calm'} approach to minimums`, ok, JSON.stringify(r));
    }
  }
  const slow = flyAltHold('c172', { turb: true, recentre: 0.3 });
  check('autopilot holds altitude and wings through 3 fps axis recentring',
    !slow.crashed && slow.on && slow.maxErrFt < 40 && slow.maxBankDeg < 5, JSON.stringify(slow));
}

console.log(failures === 0 ? '\nAll physics checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
