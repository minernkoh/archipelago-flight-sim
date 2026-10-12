// Instant replay review: fly a short approach, open the replay, cycle the
// cinematic cameras, scrub and close. Writes PNGs. Not part of `verify`.
//   node test/replayshots.mjs [outDir]
import { launch } from './browser.mjs';
const out = process.argv[2] || 'test/shots';
const W = 1280, H = 720;
const browser = await launch({ headless: true, protocolTimeout: 180000,
  args: ['--enable-unsafe-swiftshader', `--window-size=${W},${H}`], defaultViewport: { width: W, height: H } });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('archipelago.toured', '1');
  localStorage.setItem('archipelago.settings', JSON.stringify({ atc: false, autoRes: false, pixelRatioCap: 1 }));
});
await page.goto('http://localhost:8123/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu.show', { timeout: 90000 });
await page.waitForFunction('(window.__sim.frames || 0) > 3', { timeout: 90000, polling: 500 });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const key = (k) => page.evaluate((k) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })); window.dispatchEvent(new KeyboardEvent('keyup', { key: k })); }, k);
const shot = async (name) => { try { await page.screenshot({ path: `${out}/rp-${name}.png` }); console.log('shot', name); } catch (e) { console.log('fail', name, e.message); } };
await page.evaluate(() => window.__sim.game.select({ map: 'archipelago', time: 'dusk', mode: 'free', aircraft: 'c172', weather: 'calm' }));
await page.evaluate(() => document.querySelector('#btn-start').click());
await page.waitForFunction('window.__sim.game.state === "flying"', { timeout: 120000, polling: 500 });
// put it on a short final, power on, and let the physics fly it for a while
await page.evaluate(() => {
  const s = window.__sim, ac = s.ac, r = s.map.runway;
  ac.pos.x = r.x0 - 500; ac.pos.z = 0; ac.pos.y = r.y + 30;
  ac.vel.x = 38; ac.vel.y = -1.5; ac.vel.z = 0;
  ac.q.x = 0; ac.q.y = 0; ac.q.z = 0; ac.q.w = 1; ac.onGround = false;
  s.controls.state.throttle = 0.25;
});
await wait(9000);
const rec = await page.evaluate(() => ({ n: window.__sim.replay.recorder.count, dur: window.__sim.replay.duration }));
console.log('recorded', JSON.stringify(rec));
await key('x');
await wait(800);
console.log('state after X', await page.evaluate(() => window.__sim.game.state));
for (const [i, name] of [[1, 'chase'], [2, 'tower'], [3, 'flyby'], [4, 'onboard'], [5, 'orbit']]) {
  await page.evaluate((i) => { window.__sim.replay.setCam(i); window.__sim.replay.seek(2); }, i);
  await wait(2500);
  await shot(name);
}
await page.evaluate(() => window.__sim.replay.setCam(0));
await key(' '); await wait(300);
const paused = await page.evaluate(() => window.__sim.replay.playing);
await key(' ');
await key('ArrowUp');
const sp = await page.evaluate(() => window.__sim.replay.speed);
console.log('space pauses', paused === false, 'speed up ->', sp);
await key('Escape');
await wait(600);
console.log('state after ESC', await page.evaluate(() => window.__sim.game.state), 'bar hidden', await page.evaluate(() => !document.querySelector('#replay-ui') || getComputedStyle(document.querySelector('#replay-ui')).display === 'none'));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
