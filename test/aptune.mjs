// Headless autopilot harness: each aircraft at cruise, ALT+HDG engaged a few
// metres off the selected altitude, flown for 90 s (optionally in gusty air).
// Prints the altitude excursion after capture and the bank wander.
//   node test/aptune.mjs
import { createAircraft, step, attitude } from '../src/physics/flightModel.js';
import { AIRCRAFT } from '../src/aircraft/params.js';
import { createAutopilot } from '../src/autopilot.js';
import { createWind, WEATHER } from '../src/physics/wind.js';
import { v3 } from '../src/physics/vecmath.js';

export function flyAltHold(id, { turb = false, secs = 90, offset = 15, recentre = 0 } = {}) {
  const p = AIRCRAFT[id];
  // a sensible cruise for each type: ~1.5x the clean stall speed
  const cruise = { c172: 55, extra300: 70, hornet: 160, heavy: 125, spirit: 140 }[id] ?? 60;
  const ac = createAircraft({ pos: v3(0, 1500, 0), vel: v3(cruise, 0, 0) });
  ac.p = { ...p };
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

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const id of Object.keys(AIRCRAFT)) {
    console.log(JSON.stringify(flyAltHold(id)), JSON.stringify(flyAltHold(id, { turb: true })));
  }
}
