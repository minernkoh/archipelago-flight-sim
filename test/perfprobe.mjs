// Render-cost probe: per-layer frame cost under SwiftShader (the headless e2e path).
// Server must be running on :8123. Times synchronous renders (readPixels forces
// completion) at three viewpoints, then the saving from hiding each top-level
// layer, turning shadows off, and dropping to the 0.6 dynamic-res floor.
// Medians of --n renders; single-layer savings under ~10 ms are noise.
//   node test/perfprobe.mjs [--res 1280x800] [--n 6] [--pr 0.6] [--quick] [--url http://localhost:8123/]
// --pr measures layers at that pixel ratio (0.1 isolates the per-vertex/draw cost);
// --quick prints only frame times (A/B two checkouts served on different ports).
import { launch } from './browser.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [W, H] = arg('--res', '1280x800').split('x').map(Number);
const N = +arg('--n', 6);
const URL = arg('--url', 'http://localhost:8123/');
const PR = +arg('--pr', 0);                        // >0: measure layers at this pixel ratio
const QUICK = process.argv.includes('--quick');   // frame time only, no per-layer breakdown
const browser = await launch({ headless: true, protocolTimeout: 600000,
  args: ['--enable-unsafe-swiftshader', `--window-size=${W},${H}`], defaultViewport: { width: W, height: H } });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 300)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu.show', { timeout: 90000 });
await page.waitForFunction('(window.__sim.frames || 0) > 3', { timeout: 90000, polling: 500 });
await page.evaluate(() => { const s = window.__sim; s.world.setAutoRes(false); s.world.setPost(false); s.game.select({ aircraft: 'c172', mode: 'free', map: 'archipelago', time: 'day' }); });
await page.evaluate(() => document.querySelector('#btn-start').click());
await page.waitForFunction('window.__sim.game.state === "flying"', { timeout: 60000, polling: 200 });
await sleep(1500);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
await sleep(500);

await page.evaluate((q, pr) => { window.__quick = q; if (pr) window.__sim.renderer.setPixelRatio(pr); }, QUICK, PR);
// Classify top-level scene children into layers.
await page.evaluate(() => {
  const s = window.__sim, sc = s.scene;
  window.__layer = (o) => {
    if (o.isLight || o.isCamera) return null;
    const m = o.material;
    if (o.isMesh && m?.isShaderMaterial && m.side === 1) return 'sky';
    if (o.isMesh && m?.isShaderMaterial && m.transparent) return 'ocean';
    if (o.isGroup && o.children.length > 20 && o.children.every(c => c.material?.isShaderMaterial)) return 'clouds';
    if (o.isMesh && m?.isMeshLambertMaterial && m.vertexColors && o.geometry?.attributes?.color && !o.isInstancedMesh)
      return o.geometry.index ? 'terrainFar' : 'terrainFine';   // coarse tier is the indexed one
    if (o.isGroup && o.children.length && o.children.every(c => c.isInstancedMesh) && o.children[0].material?.vertexColors) return 'trees';
    if (o === s.traffic?.group || o.userData?.traffic) return 'traffic';
    return 'other:' + (o.name || o.type) + '#' + o.children.length;
  };
});

async function measure(label) {
  return page.evaluate(async (label, N) => {
    const s = window.__sim, r = s.renderer, sc = s.scene, cam = sc.children.find(c => c.isCamera);
    const gl = r.getContext(); const px = new Uint8Array(4);
    const time = () => { // median of N synchronous renders
      const t = [];
      r.render(sc, cam); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < N; i++) { const t0 = performance.now(); r.render(sc, cam); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - t0); }
      t.sort((a, b) => a - b); return t[t.length >> 1];
    };
    const groups = {};
    for (const o of sc.children) { const l = window.__layer(o); if (l) (groups[l.split(':')[0] === 'other' ? l : l] ||= []).push(o); }
    const base = time();
    r.info.autoReset = true; r.render(sc, cam);
    const info = { calls: r.info.render.calls, tris: r.info.render.triangles };
    const out = { label, base: +base.toFixed(1), ...info, layers: {} };
    if (window.__quick) { const pr = r.getPixelRatio(); r.setPixelRatio(0.6); time(); out.at06 = +time().toFixed(1); r.setPixelRatio(pr); time(); delete out.layers; return out; }
    for (const [k, objs] of Object.entries(groups)) {
      const vis = objs.map(o => o.visible); objs.forEach(o => o.visible = false);
      const t = time(); objs.forEach((o, i) => o.visible = vis[i]);
      out.layers[k] = { n: objs.length, saved: +(base - t).toFixed(1) };
    }
    const sh = r.shadowMap.enabled; r.shadowMap.enabled = false; sc.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); });
    time(); out.layers.shadowsOff = { saved: +(base - time()).toFixed(1) };
    r.shadowMap.enabled = sh; sc.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); }); time();
    const pr = r.getPixelRatio(); r.setPixelRatio(0.6); time(); out.at06 = +time().toFixed(1); r.setPixelRatio(pr); time();
    return out;
  }, label, N);
}

async function teleport(x, y, z, hdgDeg, pitchDeg = 0) {
  await page.evaluate((x, y, z, h, p) => {
    const ac = window.__sim.ac; ac.pos.x = x; ac.pos.y = y; ac.pos.z = z;
    const yaw = -h * Math.PI / 180, pit = p * Math.PI / 180;
    // yaw about +y then pitch about body +z
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pit / 2), sp = Math.sin(pit / 2);
    ac.q.w = cy * cp; ac.q.x = -sy * sp; ac.q.y = sy * cp; ac.q.z = cy * sp;
    ac.vel.x = 0; ac.vel.y = 0; ac.vel.z = 0;
  }, x, y, z, hdgDeg, pitchDeg);
  let prev = '', same = 0;
  for (let i = 0; i < 80 && same < 4; i++) {
    await sleep(500);
    const c = JSON.stringify(await page.evaluate(() => window.__sim.terrainCounts()));
    same = c === prev ? same + 1 : 0; prev = c;
  }
}

const results = [];
results.push(await measure('runway chase'));
const sp = await page.evaluate(() => ({ ...window.__sim.map.runway.spawn, y: window.__sim.map.runway.y }));
await teleport(sp.x + 1500, 350, sp.z, 0, -8); results.push(await measure('350 m, nose down'));
await teleport(sp.x + 3000, 1200, sp.z + 800, 90, 3); results.push(await measure('1200 m, horizon'));
for (const r of results) console.log(JSON.stringify(r));
await browser.close();
