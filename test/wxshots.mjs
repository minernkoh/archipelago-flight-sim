// Weather art review: cockpit rain, a forced lightning strike and the in-cloud
// whiteout, in the STORM preset. Not part of `verify`.
//   node test/wxshots.mjs [outDir]
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
const shot = async (name) => { try { await page.screenshot({ path: `${out}/wx-${name}.png` }); console.log('shot', name); } catch (e) { console.log('fail', name, e.message); } };
await page.evaluate(() => window.__sim.game.select({ map: 'archipelago', time: 'day', mode: 'free', aircraft: 'c172', weather: 'storm' }));
await page.evaluate(() => document.querySelector('#btn-start').click());
await page.waitForFunction('window.__sim.game.state === "flying"', { timeout: 120000, polling: 500 });
const hold = (alt) => page.evaluate((alt) => {
  const s = window.__sim, ac = s.ac;
  ac.pos.x = 2500; ac.pos.z = 0; ac.pos.y = s.map.runway.y + alt;
  ac.vel.x = 55; ac.vel.y = 0; ac.vel.z = 0; ac.q.x = 0; ac.q.y = 0; ac.q.z = 0; ac.q.w = 1; ac.onGround = false;
}, alt);
await hold(200);
await page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' })); window.dispatchEvent(new KeyboardEvent('keyup', { key: 'c' })); });
for (let i = 0; i < 6; i++) { await hold(200); await wait(500); }
await shot('cockpit-rain');
await page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' })); window.dispatchEvent(new KeyboardEvent('keyup', { key: 'c' })); });
await page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' })); window.dispatchEvent(new KeyboardEvent('keyup', { key: 'c' })); });
// lightning: force strikes and grab frames right after
let caught = 0;
for (let k = 0; k < 4 && caught < 2; k++) {
  await hold(200);
  await page.evaluate(() => window.__sim.weatherFx.strike());
  await wait(250);
  const st = await page.evaluate(() => window.__sim.env.skyState);
  if (st.flash > 0.05) { await shot('lightning-' + caught); caught++; }
}
await hold(200);
await page.evaluate(() => window.__sim.weatherFx.strike(true));
await wait(1500);
console.log('bolt', JSON.stringify(await page.evaluate(() => window.__sim.weatherFx.lastBolt)));
await shot('bolt');
console.log('strikes', await page.evaluate(() => window.__sim.weatherFx.strikes));
await hold(430 + 200);   // inside the deck
await wait(2500);
console.log('inCloud', await page.evaluate(() => window.__sim.env.skyState.inCloud));
await shot('in-cloud');
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
