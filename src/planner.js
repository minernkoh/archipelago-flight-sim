// Flight planner (v5-R4): a PLAN screen with a top-down terrain map you click
// to lay waypoints, a leg list with distances/bearings, DIRECT-TO, and a saved
// plan per map (archipelago.plan.{mapId}). Feeds autopilot.setPlan; the HUD CDI
// + NAV mode and the minimap's route overlay do the in-flight work.

const SIZE = 560;     // css px of the plan canvas (square)
const GRID = 160;     // terrain sample grid for the bake (O(GRID²) height calls, click-time only)
const STYLE_ID = 'planner-style';
const keyFor = (mapId) => `archipelago.plan.${mapId}`;

export function loadPlan(mapId) {
  try {
    const v = JSON.parse(localStorage.getItem(keyFor(mapId)) || 'null');
    return Array.isArray(v) && v.every(p => Array.isArray(p) && p.length >= 2) ? v : null;
  } catch { return null; }
}
export function savePlan(mapId, pts) {
  try {
    if (pts && pts.length) localStorage.setItem(keyFor(mapId), JSON.stringify(pts));
    else localStorage.removeItem(keyFor(mapId));
  } catch { /* storage unavailable */ }
}

// Span of world the plan map shows: cover the race course + runway generously.
function computeBounds(map) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const eat = (x, z) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  };
  eat(map.runway.spawn.x, map.runway.spawn.z);
  // raceCourse entries are [x, z, desiredY] — index 1 is z, index 2 is altitude.
  for (const [x, z] of map.raceCourse || []) eat(x, z);
  const span = Math.max(maxX - minX, maxZ - minZ, 6000) * 1.35;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  return { minX: cx - span / 2, minZ: cz - span / 2, span };
}

export function createPlanner({ getMap, getAc, autopilot, onFlyPlan }) {
  let mountEl = null, canvas = null, listEl = null, hintEl = null;
  let bounds = null, bakedId = null, terrainCanvas = null;
  let pts = [];        // [[x, z, y], ...]
  let map = null;
  let dragIdx = -1;    // waypoint being dragged, -1 = none
  let downOnFix = false; // pointerdown landed on a fix -> the click must not add one

  const toPx = (x, z) => [
    (x - bounds.minX) / bounds.span * SIZE,
    (z - bounds.minZ) / bounds.span * SIZE,
  ];
  const toWorld = (px, py) => [
    bounds.minX + px / SIZE * bounds.span,
    bounds.minZ + py / SIZE * bounds.span,
  ];

  function bakeTerrain() {
    terrainCanvas = document.createElement('canvas');
    terrainCanvas.width = GRID; terrainCanvas.height = GRID;
    const tctx = terrainCanvas.getContext('2d');
    const img = tctx.createImageData(GRID, GRID);
    const step = bounds.span / (GRID - 1);
    for (let iz = 0; iz < GRID; iz++) {
      const z = bounds.minZ + iz * step;
      for (let ix = 0; ix < GRID; ix++) {
        const x = bounds.minX + ix * step;
        const h = map.height(x, z);
        const o = (iz * GRID + ix) * 4;
        let r, g, b;
        if (h < 0.6) { r = 26; g = 58; b = 76; }                    // sea
        else if (h < 400) { r = 68; g = 102; b = 58; }              // low land
        else if (h < 1400) { r = 104; g = 112; b = 78; }            // hills
        else if (h < 2600) { r = 120; g = 112; b = 100; }           // rock
        else { r = 214; g = 220; b = 220; }                          // snow
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    tctx.putImageData(img, 0, 0);
    bakedId = map.id;
  }

  // Cruise fix 300 m above whichever is higher: the ground here or the field.
  const altFor = (wx, wz) => Math.max(map.height(wx, wz) + 300, map.runway.y + 300);

  const distNm = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]) / 1852;
  const brgDeg = (a, b) => {
    // world +x = east, +z = south -> compass bearing
    const d = Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180 / Math.PI;
    return Math.round((d + 360) % 360);
  };

  function draw() {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(terrainCanvas, 0, 0, SIZE, SIZE);
    // runway tick
    const r = map.runway;
    const [rx, ry] = toPx(r.spawn.x, r.spawn.z);
    ctx.save();
    ctx.translate(rx, ry); ctx.rotate(-(r.headingRad ?? 0));
    ctx.fillStyle = '#e8edf2'; ctx.fillRect(-7, -1.6, 14, 3.2);
    ctx.restore();
    // route
    if (pts.length) {
      ctx.strokeStyle = '#ff4fd8'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      for (const p of pts) { const [x, y] = toPx(p[0], p[1]); ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
      pts.forEach((p, i) => {
        const [x, y] = toPx(p[0], p[1]);
        ctx.fillStyle = '#ff4fd8';
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0c1116';
        ctx.font = 'bold 8px "B612 Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), x, y);
      });
    }
  }

  function renderList() {
    let prev = [map.runway.spawn.x, map.runway.spawn.z];
    listEl.innerHTML = pts.map((p, i) => {
      const row = `<li><span class="no">${i + 1}</span> ` +
        `<span class="leg">${brgDeg(prev, p).toString().padStart(3, '0')}° · ${distNm(prev, p).toFixed(1)} nm · ${Math.round(p[2] * 3.28084 / 100) * 100} ft</span>` +
        `<button class="btn pl-dct" data-i="${i}">DCT</button>` +
        `<button class="btn pl-del" data-i="${i}">✕</button></li>`;
      prev = p;
      return row;
    }).join('') || '<li class="pl-empty">Click the map to add waypoints.</li>';
    hintEl.textContent = pts.length
      ? `${pts.length} waypoint${pts.length > 1 ? 's' : ''} — FLY PLAN loads it; engage NAV (N) in flight.`
      : 'Plans persist per map. DCT = direct to that fix now.';
  }

  function commit() {
    savePlan(map.id, pts);
    renderList();
    draw();
  }

  function refresh() {
    map = getMap();
    if (!map) return;
    if (bakedId !== map.id) { bounds = computeBounds(map); bakeTerrain(); }
    pts = loadPlan(map.id) || [];
    renderList();
    draw();
  }

  function mount(el) {
    mountEl = el;
    injectStyles();
    el.innerHTML = `
      <div class="inner">
        <div class="kicker">NAVIGATION</div>
        <h1>FLIGHT PLAN</h1>
        <div class="sub" id="pl-hint"></div>
        <div class="pl-wrap">
          <canvas id="pl-canvas" width="${SIZE}" height="${SIZE}"></canvas>
          <div class="pl-side">
            <ul id="pl-list"></ul>
            <div class="btnrow">
              <button class="btn" id="pl-fly"><span class="no">&#9992;</span> FLY PLAN</button>
              <button class="btn" id="pl-clear"><span class="no">&#10006;</span> CLEAR</button>
              <button class="btn" data-act="menu"><span class="no">&larr;</span> BACK</button>
            </div>
          </div>
        </div>
      </div>`;
    canvas = el.querySelector('#pl-canvas');
    listEl = el.querySelector('#pl-list');
    hintEl = el.querySelector('#pl-hint');
    // Canvas coords in the canvas's own 0..SIZE space (it's CSS-scaled).
    const atEvent = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width * SIZE, (e.clientY - r.top) / r.height * SIZE];
    };
    // Grab an existing fix to drag it; empty space adds one on click.
    canvas.addEventListener('pointerdown', (e) => {
      const [px, py] = atEvent(e);
      dragIdx = pts.findIndex(p => {
        const [x, y] = toPx(p[0], p[1]);
        return Math.hypot(x - px, y - py) <= 9;
      });
      downOnFix = dragIdx >= 0;
      if (dragIdx >= 0) canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragIdx < 0) return;
      const [wx, wz] = toWorld(...atEvent(e));
      pts[dragIdx] = [wx, wz, altFor(wx, wz)];
      draw();                       // live feedback; the save waits for pointerup
    });
    canvas.addEventListener('pointerup', (e) => {
      if (dragIdx < 0) return;
      canvas.releasePointerCapture?.(e.pointerId);
      dragIdx = -1;
      commit();                     // persist the moved fix + refresh its leg
    });
    canvas.addEventListener('click', (e) => {
      // A click that grabbed a fix moves it — it must never also add one.
      if (downOnFix) { downOnFix = false; return; }
      const [wx, wz] = toWorld(...atEvent(e));
      pts.push([wx, wz, altFor(wx, wz)]);
      commit();
    });
    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const i = +b.dataset.i;
      if (b.classList.contains('pl-del')) { pts.splice(i, 1); commit(); }
      if (b.classList.contains('pl-dct')) {
        const ac = getAc();
        autopilot.setPlan([pts[i]], [ac.pos.x, ac.pos.z]);
        onFlyPlan?.('direct');
      }
    });
    el.querySelector('#pl-fly').addEventListener('click', () => {
      if (!pts.length) return;
      autopilot.setPlan(pts, [map.runway.spawn.x, map.runway.spawn.z]);
      onFlyPlan?.('plan');
    });
    el.querySelector('#pl-clear').addEventListener('click', () => { pts = []; commit(); });
  }

  return { mount, refresh, getPoints: () => pts.slice() };
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* .inner is sized for a column of buttons; the plan map needs the width. */
    #plan .inner { max-width: min(64rem, 92vw); max-height: 92vh; overflow-y: auto;
      padding-right: 1rem; }
    #plan h1 { font-size: clamp(2rem, 4vw, 3rem); }
    #plan .sub { margin-bottom: 1rem; max-width: none; }
    .pl-wrap { display: flex; gap: 1.2rem; margin-top: 1.2rem; flex-wrap: wrap; }
    #pl-canvas { width: min(${SIZE}px, 92vw); height: auto; aspect-ratio: 1;
      border: 1px solid rgba(232,237,242,.3); background: #0c1116; cursor: crosshair;
      pointer-events: auto; image-rendering: pixelated; }
    .pl-side { flex: 1; min-width: 15rem; }
    #pl-list { margin: 0 0 1rem; padding: 0; max-height: 24rem; overflow-y: auto; }
    #pl-list li { list-style: none; display: flex; gap: .6rem; align-items: baseline;
      font-family: "B612 Mono", ui-monospace, monospace; font-size: .68rem;
      letter-spacing: .08em; color: #e8edf2; padding: .3rem 0;
      border-bottom: 1px solid rgba(232,237,242,.12); }
    #pl-list .no { color: #ff4fd8; }
    #pl-list .leg { flex: 1; }
    #pl-list .pl-empty { color: #9aa7b2; border: none; }
    .pl-dct, .pl-del { pointer-events: auto; font-size: .6rem !important;
      padding: .15rem .4rem !important; }
  `;
  document.head.appendChild(style);
}
