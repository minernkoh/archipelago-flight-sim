// ARCHIPELAGO — the original island world, packaged as a self-contained map
// module. A "map" bundles everything world-specific that the generic engine
// (terrain streamer, rings, environment) needs: a heightfield, vertex colours,
// a runway, scenery dressing, a race course, and optional solid obstacles.
//
// getTerrainHeight() is the single source of truth for ground elevation —
// physics ground contact and the rendered chunks both call it (via map.height).

import * as THREE from 'three';

/**
 * The map contract. Every world (archipelago, singapore, …) exports one object
 * matching this shape; the engine consumes only these fields. The first nine
 * are required — every map implements them. The rest are optional extras that
 * only some maps implement; the engine always guards them (`map.prefetch?.()`,
 * `map.fixes?.length`, …) except where noted.
 *
 * @typedef {Object} FlightMap
 * @property {string} id                Stable machine id, e.g. 'archipelago'.
 * @property {string} name              Display name, e.g. 'ARCHIPELAGO'.
 * @property {(x:number, z:number) => number} height
 *           Terrain elevation (MSL, metres) at world x/z. Includes any runway
 *           flattening. Must be cheap — called per vertex and per physics tick.
 * @property {(h:number, slope:number, x:number, z:number, out:THREE.Color) => THREE.Color} color
 *           Writes the vertex colour for elevation h / slope (0..1) at x/z into
 *           `out` and returns it.
 * @property {(x:number, z:number) => boolean} isRunway
 *           True over the paved runway apron (used for landing-surface tests).
 * @property {{spawn:{x:number,z:number}, headingRad:number, y:number,
 *             name:string, x0:number, x1:number, halfWidth:number}} runway
 *           Spawn placement + runway extent. headingRad is the takeoff heading.
 * @property {(scene:THREE.Scene) => THREE.Group} createScenery
 *           Builds static dressing (runway slab, buildings, …), adds it to the
 *           scene, and returns the group so callers can dispose/toggle it.
 * @property {Array<[number, number, number]>} raceCourse
 *           Ordered gate centres as [x, z, desiredY]; desiredY is floored above
 *           terrain by the rings module.
 * @property {(x:number, z:number) => number} obstacleTop
 *           Top surface (MSL) of any solid obstacle at x/z (buildings, etc.),
 *           or -Infinity where nothing solid stands. Archipelago has none.
 *
 * --- optional: streamed-elevation maps only (currently realworld.js) ---
 * @property {(x:number, z:number, radius?:number) => void} [prefetch]
 *           Enqueue elevation tiles covering a radius around x/z. If a map
 *           implements this, it MUST also implement `ready` — main.js calls
 *           `map.ready(...)` unguarded right after checking `map.prefetch`
 *           (see main.js ~109), so a `prefetch`-only map would throw.
 * @property {(x:number, z:number, radius?:number) => boolean} [ready]
 *           True once every tile covering that radius has settled (state
 *           'ready' or 'error' — a failed fetch counts as settled so offline
 *           play still resolves). See the `prefetch` note above: required
 *           whenever `prefetch` is present.
 * @property {() => number} [abandonPending]
 *           Force-settle any tile still stuck in 'queued'/'loading' (marks it
 *           'error' and releases its fetch slot) so a stalled/blocked request
 *           that never resolves can't wedge `ready()` forever. Returns the
 *           number of tiles abandoned. Only meaningful where `prefetch`/`ready`
 *           exist; main.js calls it optionally (`map.abandonPending?.()`).
 * @property {boolean} [elevationOffline]
 *           True once any tile fetch has failed (or been abandoned) — signals
 *           the menu preview and in-flight HUD that this map is showing a
 *           flat/placeholder world rather than real elevation.
 * @property {{lat:number, lon:number}} [latLon]
 *           Real-world coordinates of the field, for live-weather lookups
 *           (main.js falls back to a per-map nominal lat/lon table when this
 *           is absent).
 * @property {Array<{x:number, z:number, y:number}>} [fixes]
 *           Named waypoints for the demo flight plan, in the runway frame.
 *           When absent, main.js derives a generic plan from `raceCourse`.
 *
 * --- optional: any map may set this ---
 * @property {{x:number, z:number}} [finalGateDir]
 *           Unit vector the last race gate should face (e.g. down a runway
 *           heading) instead of the rings module's default inferred facing.
 *           Currently only singapore.js sets this.
 */

const SEED = 20260703;

function hash2(ix, iz) {
  let n = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ SEED;
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n ^= n >>> 13;
  return (n >>> 0) / 4294967296;
}

const sstep = t => t * t * t * (t * (t * 6 - 15) + 10);

function noise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = sstep(fx), v = sstep(fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, z, oct, lac = 2, gain = 0.5) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(x * f, z * f);
    norm += amp; amp *= gain; f *= lac;
  }
  return sum / norm; // 0..1
}

// ---------- Runway ----------
export const RUNWAY = {
  x0: 0, x1: 1000, y: 6, halfWidth: 15,
  headingRad: 0,                       // pointing +x
  spawn: { x: 60, z: 0 },
  name: '09',
};

export function isRunway(x, z) {
  return x > RUNWAY.x0 - 20 && x < RUNWAY.x1 + 20 && Math.abs(z) < RUNWAY.halfWidth + 6;
}

// Distance outside the runway apron rectangle
function runwayDist(x, z) {
  const dx = Math.max(RUNWAY.x0 - 140 - x, 0, x - (RUNWAY.x1 + 140));
  const dz = Math.max(-90 - z, 0, z - 90);
  return Math.hypot(dx, dz);
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function getTerrainHeight(x, z) {
  const continent = fbm(x * 0.00085 + 7.3, z * 0.00085 - 2.1, 4);
  let h = (continent - 0.52) * 340;
  if (h > 0) {
    const detail = fbm(x * 0.006 + 31, z * 0.006 + 17, 4);
    h += (detail - 0.5) * 70 * Math.min(1, h / 35 + 0.25);
    // Ridged peaks on the big landmasses
    const ridgeMask = smoothstep(0.60, 0.72, continent);
    if (ridgeMask > 0) {
      const r = 1 - Math.abs(2 * fbm(x * 0.0025 - 11, z * 0.0025 + 5, 3) - 1);
      h += r * r * 210 * ridgeMask;
    }
  } else {
    h *= 0.45; // gentle shelf under the sea
  }

  // Spawn island: pull terrain flat under/around the runway
  const d = runwayDist(x, z);
  if (d < 1400) {
    const w = 1 - smoothstep(120, 1400, d);
    const islandH = RUNWAY.y + (fbm(x * 0.004 + 3, z * 0.004 + 9, 3) - 0.4) * 18 * smoothstep(60, 900, d);
    h = h * (1 - w) + islandH * w;
    if (d < 120) h = RUNWAY.y;
  }
  return h;
}

// ---------- Vertex colours ----------
const COL = {
  sand:  new THREE.Color(0xd9c79a),
  grass: new THREE.Color(0x6f9e5a),
  grass2:new THREE.Color(0x557f46),
  rock:  new THREE.Color(0x8d8578),
  snow:  new THREE.Color(0xf2f4f0),
  sea:   new THREE.Color(0x3d6b58),
};

function vertexColor(h, slope, x, z, out) {
  const jitter = (hash2(Math.round(x * 7), Math.round(z * 7)) - 0.5) * 0.06;
  if (h < 1.4) out.copy(COL.sand);
  else if (h < 60) out.lerpColors(COL.grass, COL.grass2, smoothstep(4, 60, h));
  else if (h < 130) out.lerpColors(COL.grass2, COL.rock, smoothstep(60, 130, h));
  else if (h < 190) out.copy(COL.rock);
  else out.lerpColors(COL.rock, COL.snow, smoothstep(190, 240, h));
  if (slope > 0.55 && h > 2) out.lerp(COL.rock, smoothstep(0.55, 0.9, slope));
  if (h < -1) out.copy(COL.sea);
  out.offsetHSL(0, 0, jitter);
  return out;
}

// ---------- Airfield dressing: runway slab, markings, hangar, tower, windsock ----------
export function createAirfield(scene) {
  const g = new THREE.Group();

  const canvas = document.createElement('canvas');
  canvas.width = 4096; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  const sx = 4096 / 1024, sy = 192 / 64;
  ctx.scale(sx, sy);
  ctx.fillStyle = '#3a3d42'; ctx.fillRect(0, 0, 1024, 64);
  ctx.fillStyle = '#c9cdd2';
  for (let x = 40; x < 984; x += 48) ctx.fillRect(x, 30.5, 26, 3);        // centerline
  for (let i = 0; i < 6; i++) { ctx.fillRect(8, 6 + i * 9, 22, 5); ctx.fillRect(994, 6 + i * 9, 22, 5); } // thresholds
  ctx.fillRect(0, 0, 1024, 1.4); ctx.fillRect(0, 62.6, 1024, 1.4);        // edges
  ctx.font = 'bold 26px sans-serif'; ctx.fillStyle = '#c9cdd2';
  ctx.save(); ctx.translate(70, 32); ctx.rotate(Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('09', 0, 9); ctx.restore();
  ctx.save(); ctx.translate(954, 32); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('27', 0, 9); ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(RUNWAY.x1 - RUNWAY.x0, RUNWAY.halfWidth * 2),
    new THREE.MeshLambertMaterial({ map: tex }),
  );
  strip.rotation.x = -Math.PI / 2;
  strip.position.set((RUNWAY.x0 + RUNWAY.x1) / 2, RUNWAY.y + 0.06, 0);
  g.add(strip);

  const mat = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });

  const hangar = new THREE.Group();
  const shed = new THREE.Mesh(new THREE.BoxGeometry(26, 8, 18), mat(0x9aa2ab));
  shed.position.y = 4;
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 26, 3, 1, false, 0, Math.PI), mat(0x77502e));
  roof.rotation.z = Math.PI / 2; roof.rotation.y = Math.PI / 2; roof.position.y = 8; roof.scale.set(1, 1, 0.6);
  hangar.add(shed, roof);
  hangar.position.set(120, RUNWAY.y, 60);
  g.add(hangar);

  const tower = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(4, 14, 4), mat(0xb8bdc4));
  shaft.position.y = 7;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, 7), mat(0x2c3844));
  cab.position.y = 15.5;
  tower.add(shaft, cab);
  tower.position.set(210, RUNWAY.y, 55);
  g.add(tower);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 7), mat(0xcccccc));
  pole.position.set(30, RUNWAY.y + 3.5, 40);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.8, 3.2, 6), mat(0xe8722a));
  sock.rotation.z = Math.PI / 2; sock.position.set(31.8, RUNWAY.y + 6.6, 40);
  g.add(pole, sock);
  g.userData.windsock = sock; // main.js orients it from the live wind field

  scene.add(g);
  return g;
}

// ---------- Race course ----------
// x/z layout relative to the runway (heading +x); y is desired MSL, floored
// above terrain by the rings module. 12 gates leaving the runway, sweeping over
// the sea and returning to final approach.
const raceCourse = [
  [1700,     0, 130], [2600,  -180, 240], [3300,  -650, 330], [3500, -1350, 400],
  [3100, -1950, 300], [2300, -2350, 170], [1350, -2450,  75], [ 400, -2250,  60],
  [-500, -1800, 140], [-1150, -1050, 240], [-1400,  -300, 170], [-850,     0,  95],
];

// ---------- Map object ----------
/** @type {FlightMap} */
export const archipelagoMap = {
  id: 'archipelago',
  name: 'ARCHIPELAGO',
  height: getTerrainHeight,
  color: vertexColor,
  isRunway,
  runway: RUNWAY,
  createScenery: createAirfield,
  raceCourse,
  obstacleTop() { return -Infinity; },  // no solid obstacles on this map
};
