// Menu map preview — the selected world drawn as a navigation chart.
//
// Not a screenshot: a shaded heightfield with the runway laid over it as a real
// runway symbol at its true heading, plus margin callouts (field elevation,
// runway designator, ICAO for the streamed real-world fields). That reads as
// avionics rather than as a thumbnail, which is the house style, and it is the
// only place the v5-R1 real elevation is visible before you take off.
//
// Baking is O(grid²) map.height calls, so it happens ONCE per map and is cached
// by map id — never inside a rAF loop (CLAUDE.md).

import { bakeHeightfield, courseBounds, chartShade } from './heightbake.js';
import { runwayFrame } from './runwayUtil.js';
import { AIRPORTS } from './maps/airports.js';

const GRID = 112;        // sample resolution of the bake (O(grid²) height calls)
const AIRPORT_BY_ID = Object.fromEntries(AIRPORTS.map(a => [a.id, a]));

export function createMenuPreview(canvas, captionEl) {
  const cache = new Map();   // mapId -> { terrain, bounds }
  let pendingId = null;      // real-world map whose tiles we are still waiting on

  function chartFor(map) {
    if (cache.has(map.id)) return cache.get(map.id);
    const bounds = courseBounds(map);
    const terrain = bakeHeightfield(map, bounds, GRID, chartShade);
    const entry = { terrain, bounds };
    cache.set(map.id, entry);
    return entry;
  }

  // Real-world maps return 0 (sea level) for tiles that have not arrived, so a
  // preview baked too early is a flat blue square that never corrects itself.
  // Ask for the tiles, and stay on the placeholder until they land.
  function elevationReady(map, bounds) {
    if (!map.prefetch) return true;                 // fictional map — always ready
    if (map.elevationOffline) return false;         // offline: placeholder forever
    const cx = bounds.minX + bounds.span / 2, cz = bounds.minZ + bounds.span / 2;
    const r = bounds.span * 0.6;
    map.prefetch(cx, cz, r);
    return !!map.ready?.(cx, cz, r);
  }

  function drawPlaceholder(ctx, w, h, map) {
    ctx.fillStyle = '#0c1116';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(232,237,242,.10)';
    ctx.lineWidth = 1;
    for (let g = 0; g < w; g += 28) {               // faint chart graticule
      ctx.beginPath(); ctx.moveTo(g + .5, 0); ctx.lineTo(g + .5, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, g + .5); ctx.lineTo(w, g + .5); ctx.stroke();
    }
    ctx.fillStyle = '#ffb300';
    ctx.font = '600 10px "B612 Mono", ui-monospace, monospace';
    ctx.letterSpacing = '3px';
    ctx.fillText(map.elevationOffline ? 'ELEVATION OFFLINE' : 'STREAMING ELEVATION…', 14, h - 16);
  }

  function draw(map) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const bounds = courseBounds(map);

    if (!elevationReady(map, bounds)) {
      pendingId = map.id;
      drawPlaceholder(ctx, w, h, map);
      caption(map, false);
      return;
    }
    pendingId = null;

    const { terrain } = chartFor(map);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(terrain, 0, 0, w, h);

    const toPx = (x, z) => [
      (x - bounds.minX) / bounds.span * w,
      (z - bounds.minZ) / bounds.span * h,
    ];

    // Race course, faint — shows the shape of the world's flying
    const rc = map.raceCourse || [];
    if (rc.length) {
      ctx.strokeStyle = 'rgba(255,79,216,.30)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      rc.forEach(([gx, gz], i) => {
        const [px, py] = toPx(gx, gz);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    }

    // Runway drawn as a runway: a bar along its true heading, with a centreline
    const r = map.runway, f = runwayFrame(r);
    const len = (r.x1 - r.x0) || 1000;
    const [ax, ay] = toPx(r.spawn.x, r.spawn.z);
    const [bx, by] = toPx(r.spawn.x + f.fwd.x * len, r.spawn.z + f.fwd.z * len);
    ctx.strokeStyle = '#e8edf2';
    ctx.lineWidth = 4; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.strokeStyle = 'rgba(12,17,22,.9)';
    ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);

    // Threshold tick + designator, positioned off the approach end
    ctx.fillStyle = '#ffb300';
    ctx.beginPath(); ctx.arc(ax, ay, 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = '700 11px "B612 Mono", ui-monospace, monospace';
    ctx.fillStyle = '#ffb300';
    const lx = Math.max(8, Math.min(w - 34, ax - 6)), ly = Math.max(16, Math.min(h - 8, ay - 10));
    ctx.fillText(String(r.name ?? ''), lx, ly);

    caption(map, true);
  }

  // Margin callouts under the chart. Real fields get ICAO + their editorial
  // line from airports.js; fictional maps get elevation + runway only.
  function caption(map, ready) {
    if (!captionEl) return;
    const ap = AIRPORT_BY_ID[map.id];
    const elevFt = Math.round((map.runway.y || 0) * 3.28084);
    // Each bit is its own nowrap span so a narrow column breaks BETWEEN
    // callouts rather than through the middle of one ("ELEV / 20 FT").
    const bits = [
      ap ? `<b>${ap.icao}</b>` : '<b>FICTIONAL</b>',
      `RWY ${map.runway.name ?? '—'}`,
      `ELEV ${elevFt} FT`,
    ].map(s => `<span>${s}</span>`);
    captionEl.innerHTML =
      `<div class="mp-row">${bits.join('<i>·</i>')}</div>` +
      (ap ? `<div class="mp-note">${ap.desc}</div>` : '') +
      (ready ? '' : '<div class="mp-note mp-wait">streaming real elevation…</div>');
  }

  return {
    /** Draw the given map. Cheap on a cache hit; one bake on a miss. */
    show(map) { if (map) draw(map); },
    /**
     * Real-world tiles arrive asynchronously. modes.js polls this from the menu
     * on a slow timer (never rAF) so the placeholder upgrades to a live chart
     * once the elevation lands. Returns true when a redraw happened.
     */
    retryIfPending(map) {
      if (!map || pendingId !== map.id) return false;
      const bounds = courseBounds(map);
      if (!elevationReady(map, bounds)) return false;
      draw(map);
      return true;
    },
    get awaiting() { return pendingId; },
  };
}
