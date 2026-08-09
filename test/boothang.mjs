// Boot must survive elevation tiles that never arrive.
//
// Real-world maps stream elevation over the network (realworld.js loadTile).
// Two ways that goes wrong, and neither had any coverage:
//
//   1. Tiles that never SETTLE — a tracker blocker swallowing the request
//      rather than failing it. ready() stays false, terrain.js re-queues every
//      coarse chunk, pendingCount() sits at a fixed point, and loadMap's
//      pre-gen loop spins forever on the INITIALISING TERRAIN overlay.
//   2. Tiles that fail normally — already handled, because ready() counts
//      'error' as settled.
//
// This test drives case 1 by stubbing window.fetch, the same technique the
// live-weather block in e2e.mjs uses. Without the boot-hardening fix it hangs
// instead of failing, which is exactly the regression worth pinning.
//
// Run: node test/boothang.mjs   (static server on :8123)
import { launch } from './browser.mjs';

const FIELD = 'changi';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await launch({
  headless: true,
  protocolTimeout: 300000,
  args: ['--window-size=1280,800', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});

async function bootField({ hangTiles }) {
  const page = await browser.newPage();
  // evaluateOnNewDocument so the stub is in place before ANY module runs —
  // the menu preview starts pulling tiles as soon as a real-world map is
  // selected (modes.js polls elevationReady every 900 ms while the menu is up).
  if (hangTiles) {
    await page.evaluateOnNewDocument(() => {
      window.__origFetch = window.fetch;
      window.__tileReqs = 0;
      window.fetch = (u, o) => {
        if (String(u).includes('elevation-tiles-prod')) {
          window.__tileReqs++;
          return new Promise(() => {});      // never settles, never rejects
        }
        return window.__origFetch(u, o);
      };
    });
  }
  await page.goto('http://localhost:8123/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu.show', { timeout: 90000 });
  await page.waitForFunction('(window.__sim.frames || 0) > 3', { timeout: 120000, polling: 500 });

  await page.evaluate((id) => window.__sim.game.select(
    { mode: 'free', map: id, aircraft: 'c172', time: 'day' }), FIELD);
  await page.evaluate(() => document.querySelector('#btn-start').click());

  const t0 = Date.now();
  let flying = true;
  try {
    // The whole point: loadMap caps its elevation wait at 12 s and its build
    // loop at 8 s, so even with nothing ever arriving this must complete.
    await page.waitForFunction(
      '!document.querySelector("#loading").classList.contains("show") && window.__sim.game.state === "flying"',
      { timeout: 40000, polling: 500 });
  } catch { flying = false; }
  const secs = (Date.now() - t0) / 1000;

  const state = await page.evaluate(() => {
    const s = window.__sim;
    const m = s.map;
    // Sample elevation across the map to tell a real surface from a flat plate.
    const r = m.runway.spawn;
    let lo = Infinity, hi = -Infinity;
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) {
        const h = m.height(r.x + i * 900, r.z + j * 900);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
    }
    return {
      id: m.id,
      offline: !!m.elevationOffline,
      relief: +(hi - lo).toFixed(1),
      tileReqs: window.__tileReqs ?? null,
    };
  });
  await page.close();
  return { flying, secs, ...state };
}

console.log('stalled tiles (fetches that never settle)…');
const hung = await bootField({ hangTiles: true });
check('boot completes even when no elevation tile ever arrives',
  hung.flying, hung.flying ? `flying after ${hung.secs.toFixed(1)} s` : `still loading after ${hung.secs.toFixed(0)} s`);
check('the stall was genuinely exercised', hung.tileReqs > 0, `${hung.tileReqs} tile requests hung`);
check('a stalled world is flagged offline', hung.offline, `elevationOffline=${hung.offline}`);
// Not zero: the runway plateau is flattened into the terrain and blends out
// over a few hundred metres, so even with no tiles at all there is ~7 m of
// relief near the field. Real streamed terrain here gives ~39 m.
check('a stalled world boots flat', hung.relief < 15, `${hung.relief} m of relief`);
check('boot stayed inside its own 12 s + 8 s budget', hung.secs < 30, `${hung.secs.toFixed(1)} s`);

console.log('healthy network…');
const ok = await bootField({ hangTiles: false });
check('boot completes normally', ok.flying, `flying after ${ok.secs.toFixed(1)} s`);
// Guard against the force-flush quietly masking a working network: with tiles
// available the world must NOT be flat and must NOT be flagged offline.
if (ok.offline) {
  console.log('  -- skipped: no elevation network available on this machine');
} else {
  check('a healthy world is not flagged offline', !ok.offline);
  check('a healthy world has real terrain relief', ok.relief > 20, `${ok.relief} m of relief`);
}

await browser.close();
console.log(failures === 0 ? '\nAll boot checks passed.' : `\n${failures} boot check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
