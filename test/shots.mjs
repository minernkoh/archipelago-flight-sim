// Visual review harness: boots, starts a flight, poses the aircraft at a few
// scripted spots and writes screenshots. Not part of `verify`; for art passes.
//   node test/shots.mjs [outDir] [map] [time]
import { launch } from './browser.mjs';
const out = process.argv[2] || 'test/shots';
const map = process.argv[3] || 'archipelago';
const time = process.argv[4] || 'day';
const weather = process.argv[5] || 'calm';
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
const shot = async (name) => {
  await wait(+(process.env.SHOT_WAIT || 4000));
  try { await page.screenshot({ path: `${out}/${map}-${time}${weather === 'calm' ? '' : '-' + weather}-${name}.png` }); console.log('shot', name); }
  catch (e) { console.log('shot failed', name, e.message); }
};
await shot('menu');
await page.evaluate((m, t, w) => window.__sim.game.select({ map: m, time: t, mode: 'free', aircraft: 'c172', weather: w }), map, time, weather);
await page.evaluate(() => document.querySelector('#btn-start').click());
await page.waitForFunction('window.__sim.game.state === "flying"', { timeout: 120000, polling: 500 });
await shot('runway');
// pose: airborne, heading along runway, given altitude
const pose = (dx, alt, pitchDeg = 0, yawOff = 0) => page.evaluate((dx, alt, pitchDeg, yawOff) => {
  const s = window.__sim, ac = s.ac, r = s.map.runway;
  const h = r.headingRad + yawOff;
  const fx = Math.cos(h), fz = -Math.sin(h);
  ac.pos.x = r.spawn.x + fx * dx; ac.pos.z = r.spawn.z + fz * dx;
  ac.pos.y = (dx < 0 ? s.map.runway.y : s.map.height(ac.pos.x, ac.pos.z)) + alt;
  const sp = 55; ac.vel.x = fx * sp; ac.vel.y = 0; ac.vel.z = fz * sp;
  const qy = [0, Math.sin(h / 2), 0, Math.cos(h / 2)];
  const p = pitchDeg * Math.PI / 360; const qz = [0, 0, Math.sin(p), Math.cos(p)];
  const m = (a, b) => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
  const q = m(qy, qz); ac.q.x = q[0]; ac.q.y = q[1]; ac.q.z = q[2]; ac.q.w = q[3];
  ac.onGround = false; s.controls.state && (s.controls.state.throttle = 0.7);
}, dx, alt, pitchDeg, yawOff);
await pose(-420, 480 * Math.tan(3 * Math.PI / 180) + 4, -3); await shot('final');
console.log('papi whites', await page.evaluate(() => window.__sim.env.papiWhites()));
await pose(1500, 250); await shot('low');
await pose(4000, 900, 0, 0.8); await shot('high');
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' })));
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'c' })));
await shot('cockpit');
await pose(1500, 250);
await wait(2000);
const f0 = await page.evaluate(() => window.__sim.frames);
await wait(8000);
const f1 = await page.evaluate(() => window.__sim.frames);
console.log('fps (8 s probe, low pose, render scale 1):', ((f1 - f0) / 8).toFixed(2));
console.log('fps-ish frames', await page.evaluate(() => window.__sim.frames), 'res', await page.evaluate(() => window.__sim.world.resScale));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
