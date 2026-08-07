// Lean, standalone verification of the Phase H autopilot + NAV assertions,
// isolated from the full e2e (which is compositor-stall-flaky tonight). Uses
// only page.evaluate (no screenshots / rendering), so it runs even when the
// SwiftShader compositor is stalled. NOT part of the gate suite — a focused
// probe for the new AP/NAV code. Run: node test/apcheck.mjs (server on :8123).
import { launch } from './browser.mjs';
const browser = await launch({
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

await page.evaluate(() => window.__sim.game.select({ mode: 'free', aircraft: 'c172', map: 'archipelago' }));
await page.evaluate(() => document.querySelector('#btn-start').click());
await settle(1000);

// stable level cruise, then engage ALT-hold (g) + IAS-hold (j)
await page.evaluate(() => {
  const ac = window.__sim.ac;
  ac.pos = { x: 0, y: 500, z: 0 }; ac.vel = { x: 55, y: 0, z: 0 };
  ac.q = { x: 0, y: 0, z: 0, w: 1 }; ac.omega = { x: 0, y: 0, z: 0 };
  window.__sim.controls.state.throttle = 0.6;
});
await settle(400);
const apY0 = await sim('__sim.ac.pos.y');
await press('g'); await settle(120); await press('j');
await settle(200);
const apEng = await sim('({alt: __sim.autopilot.modes.alt, ias: __sim.autopilot.modes.ias})');
check('AP ALT+IAS engage via keys (g/j)', apEng.alt && apEng.ias, JSON.stringify(apEng));
let apMin = 1e9, apMax = -1e9;
for (let i = 0; i < 14; i++) { await settle(1000); const y = await sim('__sim.ac.pos.y'); apMin = Math.min(apMin, y); apMax = Math.max(apMax, y); }
check('AP ALT-hold keeps altitude within +-75 m over ~14 s',
  (apMax - apY0) < 75 && (apY0 - apMin) < 75, `set=${apY0.toFixed(0)} min=${apMin.toFixed(0)} max=${apMax.toFixed(0)}`);

// NAV: 2-wp plan, engage, heading target turns toward wp1, sequences to wp2
await page.evaluate(() => {
  const ac = window.__sim.ac;
  ac.pos = { x: 0, y: 500, z: 0 }; ac.vel = { x: 55, y: 0, z: 0 };
  ac.q = { x: 0, y: 0, z: 0, w: 1 }; ac.omega = { x: 0, y: 0, z: 0 };
  window.__sim.autopilot.setPlan([[1500, -1500, 500], [3000, -3000, 500]], [0, 0]);
});
await press('h'); await press('g'); await press('n');
await settle(400);
const nav0 = await sim('({idx: __sim.autopilot.status(__sim.ac).navData.idx, sel: __sim.autopilot.sel.hdg})');
check('NAV engages, targets wp1 (bearing ~045)', nav0.idx === 1 && nav0.sel > 25 && nav0.sel < 65, JSON.stringify(nav0));
await page.evaluate(() => {
  const ac = window.__sim.ac;
  ac.pos = { x: 1400, y: 500, z: -1450 }; ac.vel = { x: 40, y: 0, z: -40 }; ac.omega = { x: 0, y: 0, z: 0 };
});
await settle(600);
const navSeq = await sim('__sim.autopilot.status(__sim.ac).navData.idx');
check('NAV sequences to wp2 on capture radius', navSeq === 2, `idx=${navSeq}`);

// Envelope guard: force a high-alpha state under ALT-hold -> should DISCONNECT alt.
await page.evaluate(() => {
  const ac = window.__sim.ac, p = ac.p;
  ac.pos = { x: 0, y: 500, z: 0 };
  ac.q = { x: 0, y: 0, z: 0, w: 1 }; ac.omega = { x: 0, y: 0, z: 0 };
  window.__sim.autopilot.toggleNav(ac);                 // NAV off
  window.__sim.autopilot.sel.alt = 900;                 // command a big climb
  window.__sim.autopilot.modes.alt = true;
  ac.alpha = p.alphaStall;                               // sitting at the stall AoA
});
await settle(300);
const guard = await sim('({alt: __sim.autopilot.modes.alt, warn: __sim.autopilot.status(__sim.ac).warn})');
check('envelope guard DISCONNECTs ALT-hold at stall AoA', guard.alt === false && guard.warn === 'AP DISCONNECT', JSON.stringify(guard));

check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));
await browser.close();
console.log(failures === 0 ? '\nAll AP checks passed.' : `\n${failures} AP check(s) FAILED.`);
process.exit(failures ? 1 : 0);
