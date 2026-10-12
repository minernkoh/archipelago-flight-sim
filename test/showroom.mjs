// Art review: renders each aircraft parked on the runway from a few fixed
// angles (menu hidden, camera pinned) and writes PNGs. Not part of `verify`.
//   node test/showroom.mjs [outDir] [aircraft,...] [time]
import { launch } from './browser.mjs';
const out = process.argv[2] || 'test/shots';
const list = (process.argv[3] || 'c172,extra300,hornet,heavy,spirit').split(',');
const time = process.argv[4] || 'day';
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
await page.evaluate(() => {
  document.querySelector('#menu').style.display = 'none';
  const s = window.__sim;
  s.camRig.updateMenu = (ac) => {
    const v = s.view || { az: 0.6, el: 0.18, r: 20 };
    const cam = s.camera;
    cam.position.set(ac.pos.x + Math.cos(v.az) * v.r * Math.cos(v.el), ac.pos.y + v.r * Math.sin(v.el), ac.pos.z + Math.sin(v.az) * v.r * Math.cos(v.el));
    cam.up.set(0, 1, 0);
    cam.lookAt(ac.pos.x, ac.pos.y + (v.dy || 0), ac.pos.z);
    cam.fov = 40; cam.updateProjectionMatrix();
  };
});
const R = { c172: 15, extra300: 13, hornet: 30, heavy: 110, spirit: 85 };
for (const id of list) {
  await page.evaluate((id, t) => window.__sim.world.preview({ aircraft: id, time: t }), id, time);
  for (const [name, az, el] of [['front', 0.55, 0.12], ['rear', 2.6, 0.22], ['side', -1.57, 0.05]]) {
    await page.evaluate((az, el, r) => { window.__sim.view = { az, el, r }; }, az, el, R[id] || 20);
    await wait(+(process.env.SHOT_WAIT || 3000));
    try { await page.screenshot({ path: `${out}/show-${id}-${name}.png` }); console.log('shot', id, name); }
    catch (e) { console.log('shot failed', id, name, e.message); }
  }
}
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
