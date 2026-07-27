// Lean, standalone verification of the v5-R4 flight planner + moving-map GPS,
// isolated from the full e2e (which is compositor-stall-flaky on this machine).
// Uses only page.evaluate (no screenshots / rendering), so it runs even when the
// SwiftShader compositor is stalled. A focused probe for the new R4 code.
// Run: node test/plancheck.mjs (server on :8123).
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 300000,
  args: ['--window-size=1440,900', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const sim = (expr) => page.evaluate(new Function(`return (${expr});`));
const keyEv = (t, k) => page.evaluate(([a, b]) => window.dispatchEvent(new KeyboardEvent(a, { key: b })), [t, k]);
const press = async (k) => { await keyEv('keydown', k); await keyEv('keyup', k); };
const settle = (ms) => new Promise(r => setTimeout(r, ms));

console.log('loading…');
await page.goto('http://localhost:8123/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__sim && (window.__sim.frames||0) > 3', { timeout: 120000, polling: 500 });

// Start from a known map with no stored plan.
await page.evaluate(() => localStorage.removeItem('archipelago.plan.archipelago'));
await page.evaluate(() => window.__sim.game.select({ mode: 'free', aircraft: 'c172', map: 'archipelago' }));
await settle(300);

// --- PLAN screen opens off the menu with its baked map canvas ---
await page.evaluate(() => document.querySelector('#menu-foot [data-act="plan"]').click());
await settle(600);
const open = await page.evaluate(() => ({
  shown: document.querySelector('#plan').classList.contains('show'),
  canvas: !!document.querySelector('#pl-canvas'),
  empty: !!document.querySelector('#pl-list .pl-empty'),
}));
check('PLAN screen opens with the map canvas and an empty route',
  open.shown && open.canvas && open.empty, JSON.stringify(open));

// --- clicking the map lays waypoints that persist per map ---
const clickAt = (fx, fy) => page.evaluate(([x, y]) => {
  const cv = document.querySelector('#pl-canvas');
  const r = cv.getBoundingClientRect();
  cv.dispatchEvent(new MouseEvent('click', {
    clientX: r.left + r.width * x, clientY: r.top + r.height * y, bubbles: true }));
}, [fx, fy]);
await clickAt(0.62, 0.42);
await clickAt(0.72, 0.60);
await settle(200);
const laid = await page.evaluate(() => ({
  rows: document.querySelectorAll('#pl-list li:not(.pl-empty)').length,
  saved: JSON.parse(localStorage.getItem('archipelago.plan.archipelago') || '[]').length,
  leg: document.querySelector('#pl-list li .leg')?.textContent || '',
}));
check('two clicked waypoints appear in the list and persist',
  laid.rows === 2 && laid.saved === 2, JSON.stringify(laid));
check('leg row shows bearing, distance and altitude',
  /^\d{3}° · [\d.]+ nm · \d+ ft$/.test(laid.leg.trim()), laid.leg);

// Waypoints must land inside the mapped world, not at some altitude-derived
// bogus centre — the bounds bug this probe was written to catch.
const inBounds = await page.evaluate(() => {
  const pts = JSON.parse(localStorage.getItem('archipelago.plan.archipelago') || '[]');
  const rc = window.__sim.map.raceCourse || [];
  const zs = rc.map(g => g[1]);
  const lo = Math.min(...zs) - 6000, hi = Math.max(...zs) + 6000;
  return { pts: pts.map(p => [Math.round(p[0]), Math.round(p[1])]), lo, hi,
    ok: pts.every(p => p[1] > lo && p[1] < hi) };
});
check('clicked waypoints map into the course area (bounds use z, not altitude)',
  inBounds.ok, JSON.stringify(inBounds));

// --- dragging a fix moves it instead of adding another ---
const before = await sim('JSON.parse(localStorage.getItem("archipelago.plan.archipelago"))');
const dragged = await page.evaluate((wp) => {
  const cv = document.querySelector('#pl-canvas');
  const r = cv.getBoundingClientRect();
  // Screen position of fix #1, from the same transform the planner draws with.
  const at = (fx, fy) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy,
    bubbles: true, pointerId: 1 });
  cv.dispatchEvent(new PointerEvent('pointerdown', at(0.62, 0.42)));
  cv.dispatchEvent(new PointerEvent('pointermove', at(0.40, 0.30)));
  cv.dispatchEvent(new PointerEvent('pointerup', at(0.40, 0.30)));
  cv.dispatchEvent(new MouseEvent('click', at(0.40, 0.30)));
  return JSON.parse(localStorage.getItem('archipelago.plan.archipelago'));
}, null);
check('dragging a fix moves it and does not add one',
  dragged.length === 2 && Math.hypot(dragged[0][0] - before[0][0], dragged[0][1] - before[0][1]) > 100,
  `count ${dragged.length}, moved ${Math.round(Math.hypot(dragged[0][0] - before[0][0], dragged[0][1] - before[0][1]))} m`);

// --- FLY PLAN hands the route to the autopilot ---
await page.evaluate(() => document.querySelector('#pl-fly').click());
await settle(200);
const ap = await sim('({ len: __sim.autopilot.planLength, fix: __sim.autopilot.activeFix })');
check('FLY PLAN loads the route into the autopilot', ap.len === 2 && ap.fix === 0, JSON.stringify(ap));

// --- a saved plan survives a reload and beats the demo plan ---
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__sim && (window.__sim.frames||0) > 3', { timeout: 120000, polling: 500 });
const reloaded = await sim('__sim.autopilot.planLength');
check('the saved plan is restored on reload', reloaded === 2, `planLength ${reloaded}`);

// --- moving-map GPS: M cycles off -> chart -> GPS -> off ---
await page.evaluate(() => window.__sim.game.select({ mode: 'free', aircraft: 'c172', map: 'archipelago' }));
await page.evaluate(() => document.querySelector('#btn-start').click());
await settle(800);
const modes = [];
for (let i = 0; i < 3; i++) {
  await press('m');
  await settle(300);
  modes.push(await page.evaluate(() => ({
    mode: window.__sim.minimap.mode,
    on: document.querySelector('#minimap').classList.contains('on'),
  })));
}
check('M cycles off -> chart -> GPS -> off',
  modes[0].mode === 1 && modes[0].on && modes[1].mode === 2 && modes[1].on
  && modes[2].mode === 0 && !modes[2].on, JSON.stringify(modes));

// GPS mode draws an aircraft-centered window every frame — fly a bit with it up
// and assert the frame loop survives it (the draw path is where a bad blit throws).
await press('m'); await press('m');           // back to GPS
const framesBefore = await sim('__sim.frames');
await settle(1200);
const framesAfter = await sim('__sim.frames');
check('frame loop keeps running with the GPS map up',
  framesAfter > framesBefore, `${framesBefore} -> ${framesAfter}`);

check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll R4 plan checks passed.');
process.exit(failures ? 1 : 0);
