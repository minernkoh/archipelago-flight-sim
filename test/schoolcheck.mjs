// Flight-school check: flies the lessons whose pass criteria cannot be verified
// by a unit test, because the bug class here is "the lesson grades something
// different from what it instructs" — the code does exactly what it says, and
// it is the instruction and the criterion that disagree. Two real bugs were
// found this way: lesson 3 was passable by parking on the runway, and lesson 7
// actively failed the de-crab technique it spends a paragraph teaching.
//
// Run: node test/schoolcheck.mjs   (static server on :8123; takes a few minutes,
// because holdFor counts SIM time and the lessons are flown in real time).
import { launch } from './browser.mjs';
const browser = await launch({ headless: true, protocolTimeout: 600000,
  args: ['--window-size=1440,900', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const sim = e => page.evaluate(new Function(`return (${e});`));
const ev = (t, k) => page.evaluate(([t, k]) => window.dispatchEvent(new KeyboardEvent(t, { key: k })), [t, k]);
const wait = ms => new Promise(r => setTimeout(r, ms));
const instr = () => sim('(document.querySelector("#instructor")?.textContent||"").replace(/\\s+/g," ").trim().slice(0,80)');
const prog = () => sim('localStorage.getItem("archipelago.training")||""');
let fails = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? '  ok  ' : 'FAIL  '}${n}${d ? ' — ' + d : ''}`); if (!ok) fails++; };

await page.goto('http://localhost:8123/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu.show', { timeout: 60000 });
await page.waitForFunction('(window.__sim.frames||0)>3', { timeout: 120000, polling: 1000 });
await page.evaluate(() => document.querySelector('#menu-foot [data-act="settings"]').click());
await page.evaluate(() => { const b = document.querySelector('#settings [data-setting="atc"]'); if (b) b.click(); });
await page.evaluate(() => document.querySelector('#settings [data-act="menu"]').click());

await page.evaluate(() => {
  window.__fd = { on: false, t: {} };
  setInterval(() => {
    const s = window.__sim; if (!s || !window.__fd.on) return;
    const ac = s.ac, cs = s.controls.state, t = window.__fd.t;
    if (t.throttle !== undefined) cs.throttle = t.throttle;
    if (t.flaps !== undefined) cs.flaps = t.flaps;
    if (t.kt !== undefined) {
      const h = t.hdg ?? 0, v = t.kt / 1.94384;
      ac.vel.x = Math.cos(h) * v; ac.vel.z = -Math.sin(h) * v; ac.vel.y = t.vs ?? 0;
      ac.omega = { x: 0, y: 0, z: 0 };
      const p = t.pitch ?? 0, hh = h + (t.crab ?? 0);
      const cy = Math.cos(hh / 2), sy = Math.sin(hh / 2), c2 = Math.cos(p / 2), s2 = Math.sin(p / 2);
      ac.q = { w: cy * c2, x: sy * s2, y: sy * c2, z: cy * s2 };
    }
    if (t.rudderHold !== undefined) {
      // "Kick it straight and HOLD it": with the nose aligned and the aircraft
      // drifting, directional stability weathervanes it back into the wind, so
      // the alignment has to be actively flown through the flare.
      const q = ac.q;
      const fx = 1 - 2*(q.y*q.y + q.z*q.z), fz = 2*(q.x*q.z - q.w*q.y);
      const cd = r => (90 - r*180/Math.PI + 360) % 360;
      const off = ((cd(Math.atan2(-fz, fx)) - cd(t.rudderHold) + 540) % 360) - 180;
      cs.rudder = Math.max(-1, Math.min(1, -off * 0.06));
    }
    if (t.alt !== undefined) ac.pos.y = t.alt;
    if (t.at) { ac.pos.x = t.at.x; ac.pos.z = t.at.z; }
  }, 30);
});
const fd = t => page.evaluate(t => { window.__fd.t = t; window.__fd.on = true; }, t);
const fdOff = () => page.evaluate(() => { window.__fd.on = false; window.__fd.t = {}; });

async function begin(id) {
  await page.evaluate(() => { window.__sim.game.toMenu?.(); });
  await wait(300);
  await page.evaluate(() => window.__sim.game.select({ mode: 'training' }));
  await page.evaluate(() => document.querySelector('#btn-start').click());
  await wait(500);
  await page.evaluate(id => window.__sim.game.beginLesson(id), id);
  await wait(1200);
}
// Poll for the instructor text to change — holdFor counts SIM time, which only
// tracks wall time when the frame loop keeps up (see CLAUDE.md).
async function untilStep(prev, ms) {
  if (prev === null) return null;   // a previous step already timed out; do not cascade
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const t = await instr(); if (t !== prev) return t; await wait(400); }
  return null;
}
const rwy = await sim('({x:__sim.map.runway.spawn.x,z:__sim.map.runway.spawn.z,y:__sim.map.runway.y,hdg:__sim.map.runway.headingRad})');
const FT = 3.28084;

// ---- NEGATIVE: lesson 3 must NOT be passable by parking on the runway ----
await page.evaluate(() => localStorage.removeItem('archipelago.training'));
await begin('level-turns');
await wait(1500);
const parkStart = await instr();
await wait(30000);                        // >20 s of the old hold window
const parkNow = await instr();
check('lesson 3 cannot be passed by parking on the runway',
  /Take off and climb/.test(parkNow) && !/level-turns/.test(await prog()),
  `after 30 s parked, still on: "${parkNow.slice(0, 46)}"`);

// ---- POSITIVE: lesson 3 flown, using the sim's own autopilot ----
let step = await instr();
await fd({ throttle: 1, kt: 75, hdg: rwy.hdg, vs: 6, alt: rwy.y + 40, at: rwy });
for (let i = 0; i < 80; i++) {
  const agl = await sim('__sim.ac.agl * 3.28084');
  if (agl >= 1600) break;
  await fd({ throttle: 1, kt: 75, hdg: rwy.hdg, vs: 6, alt: rwy.y + 12 + i * 8 });
  await wait(120);
}
step = await untilStep(step, 20000);
check('lesson 3 climb step completes', !!step, step ? `-> "${step.slice(0, 46)}"` : 'stuck');
await fd({ throttle: 0.6, kt: 95, hdg: rwy.hdg, vs: 0, alt: await sim('__sim.ac.pos.y') });
await wait(4000);                         // settle genuinely level first
await fdOff();
await ev('keydown', 'p');                 // AP master: HDG + ALT at current state
await wait(500);
check('autopilot engaged for the level segment', await sim('__sim.autopilot.on'));
step = await untilStep(step, 90000);
check('lesson 3 level segment completes on autopilot', !!step, step ? `-> "${step.slice(0, 46)}"` : 'stuck');
for (const dir of [-1, +1]) {
  await page.evaluate(d => { const a = window.__sim.autopilot; a.sel.hdg = (a.sel.hdg + d * 95 + 360) % 360; }, dir);
  step = await untilStep(step, 120000);
  check(`lesson 3 ${dir < 0 ? 'left' : 'right'} turn completes`, !!step, step ? `-> "${step.slice(0, 46)}"` : 'stuck');
}
await ev('keydown', 'p');
check('lesson 3 recorded as passed', /level-turns/.test(await prog()));

// ---- lesson 7: aligned vs crabbed touchdown ----
async function crosswindLanding(crabRad) {
  await begin('crosswind');
  const fwdx = Math.cos(rwy.hdg), fwdz = -Math.sin(rwy.hdg);
  const gy = await page.evaluate(([x, z]) => window.__sim.map.height(x, z), [rwy.x + fwdx * 150, rwy.z + fwdz * 150]);
  let s = await instr();
  await fd({ throttle: 0.7, kt: 70, hdg: rwy.hdg, vs: 3, alt: gy + 130, at: { x: rwy.x + fwdx * 200, z: rwy.z + fwdz * 200 } });
  s = await untilStep(s, 40000);                       // step 1: 300 ft AGL
  await fd({ throttle: 0.35, kt: 66, hdg: rwy.hdg, vs: -1.5, flaps: 0.66, alt: gy + 40, at: { x: rwy.x + fwdx * 200, z: rwy.z + fwdz * 200 } });
  s = await untilStep(s, 40000);                       // step 2: established
  await fdOff();
  await page.evaluate(([hh, xx, zz, hd, v, pitch, crab]) => {
    const ac = window.__sim.ac;
    ac.touchdown = null; ac._airTime = 5;
    ac.pos.y = hh; ac.pos.x = xx; ac.pos.z = zz;
    ac.vel.x = Math.cos(hd) * v * Math.cos(pitch); ac.vel.z = -Math.sin(hd) * v * Math.cos(pitch); ac.vel.y = -0.12;
    ac.omega = { x: 0, y: 0, z: 0 };
    const h2 = hd + crab, cy = Math.cos(h2 / 2), sy = Math.sin(h2 / 2), c2 = Math.cos(pitch / 2), s2 = Math.sin(pitch / 2);
    ac.q = { w: cy * c2, x: sy * s2, y: sy * c2, z: cy * s2 };
    window.__sim.controls.state.throttle = 0;
  }, [gy + 1.33, rwy.x + fwdx * 150, rwy.z + fwdz * 150, rwy.hdg, 66 / 1.94384, 0.118, crabRad]);
  if (crabRad === 0) await fd({ rudderHold: rwy.hdg });   // fly the taught technique
  await ev('keydown', 'b');
  const t0 = Date.now();
  let passed = false;
  while (Date.now() - t0 < 25000) { if (/crosswind/.test(await prog())) { passed = true; break; } await wait(400); }
  await ev('keyup', 'b');
  await fdOff();
  const td = await sim(`(() => {
    const ac = __sim.ac, q = ac.q;
    const fx = 1 - 2*(q.y*q.y + q.z*q.z), fz = 2*(q.x*q.z - q.w*q.y);
    const cd = r => (90 - r*180/Math.PI + 360) % 360;
    const off = ((cd(Math.atan2(-fz, fx)) - cd(__sim.map.runway.headingRad) + 540) % 360) - 180;
    return JSON.stringify(Object.assign({}, ac.touchdown||{}, {
      gs: +ac.groundSpeed.toFixed(1), hdgOffDeg: +off.toFixed(1) }));
  })()`);
  return { passed, td, text: await instr() };
}
let r = await crosswindLanding(0);        // nose straight = aligned with runway
check('lesson 7 PASSES when the nose is straightened in the flare', r.passed,
  `${r.td} | step: "${r.text.slice(0, 70)}"`);
await page.evaluate(() => localStorage.removeItem('archipelago.training'));
r = await crosswindLanding(-14 * Math.PI / 180);   // touched down still crabbed
check('lesson 7 FAILS when it lands still crossed up', !r.passed, r.text.slice(0, 60));

console.log(fails === 0 ? '\nAll lesson checks passed.' : `\n${fails} lesson check(s) FAILED.`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
