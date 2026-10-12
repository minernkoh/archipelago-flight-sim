// Headless autopilot harness: each aircraft at cruise, ALT+HDG engaged a few
// metres off the selected altitude, flown for 90 s (optionally in gusty air).
// Prints the altitude excursion after capture and the bank wander.
//   node test/aptune.mjs
import { createAircraft, step, attitude } from '../src/physics/flightModel.js';
import { AIRCRAFT } from '../src/aircraft/params.js';
import { createAutopilot } from '../src/autopilot.js';
import { createWind, WEATHER } from '../src/physics/wind.js';
import { v3 } from '../src/physics/vecmath.js';
import { vSpeeds } from '../src/physics/envelope.js';

export function flyAltHold(id, { turb = false, secs = 90, offset = 15, recentre = 0 } = {}) {
  const p = AIRCRAFT[id];
  // a sensible cruise for each type: ~1.5x the clean stall speed
  const cruise = { c172: 55, extra300: 70, hornet: 160, heavy: 125, spirit: 140 }[id] ?? 60;
  const ac = createAircraft({ pos: v3(0, 1500, 0), vel: v3(cruise, 0, 0) });
  ac.p = { ...p };
  if (p.fuel) ac.fuelKg = p.fuel.capacityKg;   // createAircraft fuelled it as the default type
  const wind = createWind();
  if (turb) wind.set({ ...WEATHER.breezy, dirDeg: 200 });
  const env = { groundHeight: () => 0, terrainHeight: () => 0, isRunway: () => false, wind: (x, y, z) => wind.at(x, y, z) };
  const controls = { state: { elevator: 0, aileron: 0, rudder: 0, throttle: 0.6, flaps: 0, brakes: false, trim: 0 }, axisActive: () => false };
  const ap = createAutopilot();
  const DT = 1 / 120;
  // settle 3 s hands-off-ish, then engage with an offset target
  let t = 0, maxErr = 0, maxBank = 0, sumSq = 0, n = 0;
  step(ac, controls.state, env, DT);           // populate airspeed/iasIndicated before engaging
  ap.toggleMaster(ac, controls);
  ap.toggleIas(ac, controls);
  ap.sel.alt = ac.pos.y + offset;
  for (let i = 0; i < secs * 120; i++) {
    // recentre: what controls.poll() does to untouched keyboard axes once per
    // rendered frame (complete on a slow frame)
    if (recentre && i % Math.round(recentre * 120) === 0) { controls.state.elevator = 0; controls.state.aileron = 0; }
    ap.update(ac, controls, DT); wind.setTime(t);
    step(ac, controls.state, env, DT);
    t += DT;
    if (ac.crashed) return { id, crashed: true };
    if (t > 25) {
      const e = Math.abs(ac.pos.y - ap.sel.alt);
      maxErr = Math.max(maxErr, e); sumSq += e * e; n++;
      maxBank = Math.max(maxBank, Math.abs(attitude(ac).roll) * 57.3);
    }
  }
  return { id, maxErrFt: +(maxErr * 3.281).toFixed(1), rmsFt: +(Math.sqrt(sumSq / n) * 3.281).toFixed(1), maxBankDeg: +maxBank.toFixed(1), on: ap.modes.alt };
}

// Coupled approach (APR, v12): runway along +x through the origin at y = 0,
// spawn at x = -1500 (aim point -1200). Start `out` m before the aim point,
// `offset` m right of the centreline, heading parallel to the runway, below the
// glideslope at `startAlt`. Flies APR + IAS at the type's approach speed until
// the AP hands over at minimums. Reports the deviations it handed over with.
export function flyApproach(id, { out = 12000, offset = 1500, startAlt = 500, windKt = 0, windFrom = 0, turb = false, secs = 500 } = {}) {
  const p = AIRCRAFT[id];
  // approach config: the type's approach flaps and 1.3 x the stall speed in
  // that configuration (Vref), from the same envelope.js the HUD uses
  const flaps = { c172: 0.5, extra300: 0, hornet: 0.5, heavy: 1, spirit: 0 }[id] ?? 0;
  const v = vSpeeds(p), vsKt = v.vs1Kt + (v.vs0Kt - v.vs1Kt) * flaps;
  const vapp = 1.3 * vsKt / 1.94384;
  const aimX = -1500 + 300;
  const ac = createAircraft({ pos: v3(aimX - out, startAlt, offset), vel: v3(vapp, 0, 0) });
  ac.p = { ...p };
  if (p.fuel) ac.fuelKg = p.fuel.capacityKg;   // createAircraft fuelled it as the default type
  const wind = createWind();
  if (windKt || turb) wind.set({ ...(turb ? WEATHER.breezy : {}), kts: windKt, dirDeg: windFrom });
  const env = { groundHeight: () => 0, terrainHeight: () => 0, isRunway: () => false, wind: (x, y, z) => wind.at(x, y, z) };
  const controls = { state: { elevator: 0, aileron: 0, rudder: 0, throttle: 0.5, flaps, brakes: false, trim: 0 }, axisActive: () => false };
  const ap = createAutopilot();
  ap.setRunway({ headingRad: 0, y: 0, spawn: { x: -1500, z: 0 } });
  const DT = 1 / 120;
  step(ac, controls.state, env, DT);
  ap.toggleIas(ac, controls); ap.sel.ias = vapp;
  ap.toggleApr(ac, controls);
  let t = 0, locT = null, gsT = null, worstLoc = 0, worstGs = 0, last = null;
  for (let i = 0; i < secs * 120; i++) {
    ap.update(ac, controls, DT); wind.setTime(t);
    step(ac, controls.state, env, DT);
    t += DT;
    if (ac.crashed) return { id, crashed: true, t: +t.toFixed(1) };
    const a = ap.approach(ac);
    if (a.loc && locT === null) locT = t;
    if (a.gs && gsT === null) gsT = t;
    // judge tracking once established (30 s after GS capture)
    if (gsT !== null && t > gsT + 30) { worstLoc = Math.max(worstLoc, Math.abs(a.locDots)); worstGs = Math.max(worstGs, Math.abs(a.gsDots)); }
    if (!ap.modes.apr) { last = a; break; }
  }
  if (!last) return { id, timeout: true, loc: locT, gs: gsT };
  return {
    id, locCapS: locT && +locT.toFixed(0), gsCapS: gsT && +gsT.toFixed(0),
    handoverFt: +((ac.pos.y) * 3.281).toFixed(0), xtkM: +last.xtk.toFixed(1), aboveGsM: +last.above.toFixed(1),
    worstLocDots: +worstLoc.toFixed(2), worstGsDots: +worstGs.toFixed(2),
    bankDeg: +(attitude(ac).roll * 57.3).toFixed(1), vsFpm: +(ac.vel.y * 196.85).toFixed(0), iasKt: +((ac.iasIndicated || ac.airspeed) * 1.944).toFixed(0),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const id of Object.keys(AIRCRAFT)) {
    if (process.argv[2] === 'apr') console.log(JSON.stringify(flyApproach(id)), JSON.stringify(flyApproach(id, { windKt: 15, windFrom: 180, turb: true })));
    else console.log(JSON.stringify(flyAltHold(id)), JSON.stringify(flyAltHold(id, { turb: true })));
  }
}
