// U7 — north-up minimap. A ~180px panel-styled canvas, bottom-right.
//
// The terrain silhouette is BAKED ONCE per map load onto a coarse offscreen
// canvas (map.height sampled on a grid capped at 96×96 — it's O(grid²) height
// calls, so the bake MUST run inside main.js's loadMap pre-gen/setTimeout path,
// never rAF). Per-frame work is cheap: blit the cached terrain, then overlay
// the runway, race/training gates, and a north-up aircraft arrow.
//
// North-up mapping: compass North is world -z, East is world +x (see hud.js
// heading math), so screen-up = -z and screen-right = +x, i.e. px grows with x
// and py grows with z. That keeps north at the top of the panel.

import { attitude } from './physics/flightModel.js';
import { runwayFrame } from './runwayUtil.js';

const SIZE = 180;   // CSS px (square)
const GRID = 96;    // bake resolution cap — O(grid²) height() calls

function computeBounds(map) {
  const xs = [], zs = [];
  const r = map.runway, f = runwayFrame(r);
  xs.push(r.spawn.x, r.spawn.x + f.fwd.x * (r.x1 - r.x0));
  zs.push(r.spawn.z, r.spawn.z + f.fwd.z * (r.x1 - r.x0));
  for (const g of (map.raceCourse || [])) { xs.push(g[0]); zs.push(g[1]); }
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const span = Math.max(Math.max(maxX - minX, maxZ - minZ) * 1.3, 1800);
  return { minX: cx - span / 2, minZ: cz - span / 2, span };
}

export function createMinimap() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const el = document.createElement('canvas');
  el.id = 'minimap';
  el.width = SIZE * dpr;
  el.height = SIZE * dpr;
  document.body.appendChild(el);
  const ctx = el.getContext('2d');
  ctx.scale(dpr, dpr);

  let bounds = null, terrain = null; // baked offscreen canvas
  let userShown = false, forced = false;

  const toPx = (x, z) => [
    (x - bounds.minX) / bounds.span * SIZE,
    (z - bounds.minZ) / bounds.span * SIZE,
  ];

  // Sample map.height (and map.obstacleTop for urban tint) on a coarse grid.
  function bake(map) {
    bounds = computeBounds(map);
    const off = document.createElement('canvas');
    off.width = GRID; off.height = GRID;
    const octx = off.getContext('2d');
    const img = octx.createImageData(GRID, GRID);
    const d = img.data;
    const step = bounds.span / (GRID - 1);
    for (let iz = 0; iz < GRID; iz++) {
      const z = bounds.minZ + iz * step;
      for (let ix = 0; ix < GRID; ix++) {
        const x = bounds.minX + ix * step;
        const h = map.height(x, z);
        const top = map.obstacleTop ? map.obstacleTop(x, z) : -Infinity;
        let r, g, b;
        if (h < 0.6) {          // sea
          r = 32; g = 78; b = 88;
        } else if (top > h + 3) { // urban / solid obstacle footprint
          r = 118; g = 123; b = 130;
        } else {                 // land: green low → rock high
          const t = Math.min(1, h / 220);
          r = 74 + t * 66; g = 128 - t * 26; b = 72 + t * 44;
        }
        const o = (iz * GRID + ix) * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    terrain = off;
  }

  function arrow(ac) {
    const [px, py] = toPx(ac.pos.x, ac.pos.z);
    // World nose direction for heading h is (cos h, -sin h); on screen +x→right,
    // +z→down, so the screen-space heading angle is atan2(-sin h, cos h) = -h.
    const ang = -attitude(ac).heading;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, 3.4);
    ctx.lineTo(-4, -3.4);
    ctx.closePath();
    ctx.fillStyle = '#e8edf2';
    ctx.strokeStyle = 'rgba(9,13,17,0.9)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function dot(x, z, color, rad) {
    const [px, py] = toPx(x, z);
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function draw(map, ac, rings, trainGates, showGates) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (terrain) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(terrain, 0, 0, SIZE, SIZE);
    }

    // runway tick
    const r = map.runway, f = runwayFrame(r);
    const [ax, ay] = toPx(r.spawn.x, r.spawn.z);
    const [bx, by] = toPx(r.spawn.x + f.fwd.x * (r.x1 - r.x0), r.spawn.z + f.fwd.z * (r.x1 - r.x0));
    ctx.strokeStyle = '#e8edf2';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();

    // race gates: active highlighted magenta, passed dim green, upcoming grey
    if (showGates && rings && map.raceCourse) {
      const active = rings.active;
      map.raceCourse.forEach((g, i) => {
        const passed = i < active, cur = i === active;
        dot(g[0], g[1], passed ? '#3f7a4f' : cur ? '#ff5fd2' : '#7a828c', cur ? 3.2 : 2);
      });
    }

    // amber training gates (from the live rings instance)
    if (trainGates && trainGates.group?.visible) {
      const kids = trainGates.group.children;
      const active = trainGates.active;
      kids.forEach((m, i) => dot(m.position.x, m.position.z, i === active ? '#ffb43a' : '#7a5a1e', i === active ? 3.2 : 2));
    }

    arrow(ac);
  }

  return {
    el,
    bake,
    toggle() { userShown = !userShown; },
    show(on) { userShown = on; },
    setForced(on) { forced = on; },
    get visible() { return userShown || forced; },
    // Called every frame from main.js. Hidden entirely unless flying.
    frame({ flying, map, ac, rings, trainGates, raceMode }) {
      forced = !!raceMode;
      const vis = flying && (userShown || forced);
      el.classList.toggle('on', vis);
      if (!vis || !bounds) return;
      draw(map, ac, rings, trainGates, raceMode);
    },
  };
}
