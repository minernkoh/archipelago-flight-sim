// Lean, standalone verification of the v5-R5 ATC-lite wiring — the transcript
// line, the settings gate, and lesson suppression — isolated from the full e2e
// (which is compositor-stall-flaky on this machine). Uses only page.evaluate,
// no screenshots and no waiting on rendered frames, so it runs through a stall.
// The phrase/sequencing logic itself is covered headlessly in physics.test.js.
// Run: node test/atccheck.mjs (server on :8123).
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
const settle = (ms) => new Promise(r => setTimeout(r, ms));
const atcState = () => page.evaluate(() => ({
  shown: document.querySelector('#atc').classList.contains('show'),
  text: document.querySelector('#atc').textContent,
}));

console.log('loading…');
await page.goto('http://localhost:8123/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__sim && (window.__sim.frames||0) > 3', { timeout: 120000, polling: 500 });

// ATC on, cold & dark off — a plain ready-to-fly Skyhawk.
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('archipelago.settings') || '{}');
  localStorage.setItem('archipelago.settings', JSON.stringify({ ...s, atc: true, coldDark: false }));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__sim && (window.__sim.frames||0) > 3', { timeout: 120000, polling: 500 });

check('the ATC element exists in the HUD', await sim('!!document.querySelector("#atc")'));

// --- spawn: takeoff clearance naming the real runway ---
await page.evaluate(() => window.__sim.game.select({ mode: 'free', map: 'archipelago', aircraft: 'c172', time: 'day' }));
await page.evaluate(() => document.querySelector('#btn-start').click());
await settle(1200);
const spawn = await atcState();
check('tower clears you for takeoff on spawn',
  spawn.shown && /cleared for takeoff/i.test(spawn.text), JSON.stringify(spawn));
check('clearance reads the runway phonetically (09 -> zero niner)',
  /runway zero niner/i.test(spawn.text), spawn.text);
check('transcript is tagged TWR', /TWR/.test(spawn.text), spawn.text);

// Changi is 02L — a different field/runway must produce a different clearance.
await page.evaluate(() => window.__sim.game.toMenu());
await settle(300);
await page.evaluate(() => window.__sim.game.select({ mode: 'free', map: 'singapore', aircraft: 'c172' }));
await page.evaluate(() => document.querySelector('#btn-start').click());
await settle(1500);
const sg = await atcState();
check('clearance is per-field (Changi 02L)',
  /zero two left/i.test(sg.text), sg.text);

// --- lessons keep the frequency: the instructor talks, the tower does not ---
await page.evaluate(() => window.__sim.game.toMenu());
await settle(300);
await page.evaluate(() => window.__sim.game.select({ mode: 'training' }));
await page.evaluate(() => window.__sim.game.beginLesson('controls-taxi'));
await settle(1800);
const lesson = await atcState();
check('tower stays quiet during a lesson', lesson.shown === false, JSON.stringify(lesson));

// --- settings gate: ATC OFF means silence on the next flight ---
await page.evaluate(() => window.__sim.game.toMenu());
await settle(300);
await page.evaluate(() => document.querySelector('#menu-foot [data-act="settings"]').click());
await settle(300);
const rowExists = await sim('!!document.querySelector("#settings [data-setting=\\"atc\\"]")');
check('SETTINGS exposes an ATC row', rowExists === true);
await page.evaluate(() => document.querySelector('#settings [data-setting="atc"]').click());
await page.evaluate(() => document.querySelector('#settings [data-act="menu"]').click());
await settle(200);
const stored = await sim('JSON.parse(localStorage.getItem("archipelago.settings")||"{}").atc');
check('ATC row persists OFF', stored === false, `atc=${stored}`);

await page.evaluate(() => window.__sim.game.select({ mode: 'free', map: 'archipelago', aircraft: 'c172' }));
await page.evaluate(() => document.querySelector('#btn-start').click());
await settle(1500);
const off = await atcState();
check('ATC OFF silences the tower', off.shown === false, JSON.stringify(off));

// --- speech is best-effort: any voice count must work, none may throw ---
// (This box reports ~180 voices inside the app; a bare about:blank context
// reports 0. Both paths have to be non-fatal, so assert the fallback contract
// rather than a specific count.)
const voice = await page.evaluate(() => {
  const out = { hasSynth: typeof speechSynthesis !== 'undefined' };
  out.voices = out.hasSynth ? speechSynthesis.getVoices().length : -1;
  return out;
});
check('speech is best-effort and never fatal, whatever the voice count',
  voice.hasSynth && voice.voices >= 0 && errors.length === 0, JSON.stringify(voice));

check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll R5 ATC checks passed.');
process.exit(failures ? 1 : 0);
