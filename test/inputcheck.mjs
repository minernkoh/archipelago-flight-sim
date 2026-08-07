// Lean, standalone verification of the Phase E input/settings deliverables,
// isolated from the full e2e (compositor-stall-flaky). page.evaluate only —
// runs even when the SwiftShader compositor is stalled. NOT part of the gate
// suite. Run: node test/inputcheck.mjs (server on :8123).
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
const settle = (ms) => new Promise(r => setTimeout(r, ms));

console.log('loading…');
await page.goto('http://localhost:8123/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__sim && (window.__sim.frames||0) > 3', { timeout: 120000, polling: 500 });

// --- settings screen + persistence ---
await page.evaluate(() => document.querySelector('#menu-foot [data-act="settings"]').click());
await settle(200);
const s1 = await page.evaluate(() => ({
  shown: document.querySelector('#settings').classList.contains('show'),
  rows: document.querySelectorAll('#settings .set-row').length,
}));
// Was `=== 5`, which has been wrong since the settings screen grew past five
// rows — it failed on a clean checkout of main, unrelated to anything here.
check('settings screen opens with rows', s1.shown && s1.rows >= 5, JSON.stringify(s1));

await page.evaluate(() => document.querySelector('#settings [data-setting="invertPitch"]').click());
const s2 = await page.evaluate(() => JSON.parse(localStorage.getItem('archipelago.settings') || '{}'));
check('invertPitch edit persists', s2.invertPitch === true, JSON.stringify(s2));

// --- mouse-fly with invert ON: drag up should now push the nose DOWN ---
// Pure controls-layer behaviour (poll writes state regardless of game mode),
// so no flight/map load is needed — immune to compositor load stalls.
await page.evaluate(() => document.querySelector('#settings [data-act="menu"]').click());
const mf = await page.evaluate(() => {
  const ev = (t, x, y) => window.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, button: 2 }));
  ev('mousedown', 400, 400);
  ev('mousemove', 400, 250); // drag up 150 px
  window.__sim.controls.poll(1 / 60);
  const inverted = window.__sim.controls.state.elevator;
  ev('mouseup', 400, 250);
  return { inverted };
});
check('mouse-fly respects INVERT (drag up = nose down)', mf.inverted < -0.5, JSON.stringify(mf));

// restore invert OFF, then plain mouse-fly: drag up = nose up; AP yields
await page.evaluate(() => document.querySelector('#settings [data-setting="invertPitch"]').click());
const mf2 = await page.evaluate(() => {
  const ev = (t, x, y) => window.dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, button: 2 }));
  ev('mousedown', 400, 400);
  ev('mousemove', 400, 250);
  window.__sim.controls.poll(1 / 60);
  const held = window.__sim.controls.state.elevator;
  const apYields = window.__sim.controls.axisActive('elevator');
  ev('mouseup', 400, 250);
  window.__sim.controls.poll(1 / 60);
  return { held, apYields };
});
check('mouse-fly RMB drag drives the elevator directly', mf2.held > 0.5, JSON.stringify(mf2));
check('axisActive reports mouse-fly (AP yields)', mf2.apYields === true, JSON.stringify(mf2));

// volume + settings apply path doesn't throw with audio not yet initialized
const vol = await page.evaluate(() => {
  document.querySelector('#menu-foot [data-act="settings"]')?.click?.();
  const el = document.querySelector('#settings [data-setting="volume"]');
  el.click(); // cycle volume — applies audio.setVolume pre-init (must not throw)
  return JSON.parse(localStorage.getItem('archipelago.settings') || '{}').volume;
});
check('volume cycles and persists without audio ctx', typeof vol === 'number', `volume=${vol}`);

check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nAll input checks passed.' : `\n${failures} input check(s) FAILED.`);
process.exit(failures ? 1 : 0);
