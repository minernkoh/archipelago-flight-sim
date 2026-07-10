// ALPINE — a high mountain airstrip. A tight valley cuts between several
// jagged summits (~2500-3500 m); the runway sits on a flattened plateau on
// the valley floor (~1350 m MSL). Implements the FlightMap contract
// documented in archipelago.js (see the @typedef there).

import * as THREE from 'three';

const SEED = 20260709;

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

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- Runway ----------
// Valley runs along +x; the strip sits on the flattened plateau and takes
// off heading +x — straight down the open, descending mouth of the valley,
// away from the peaks that flank the canyon head (x < 0).
export const RUNWAY = {
  x0: 0, x1: 1200, y: 1350, halfWidth: 18,
  headingRad: 0,                       // pointing +x, down-valley
  spawn: { x: 60, z: 0 },
  name: '15',
};

export function isRunway(x, z) {
  return x > RUNWAY.x0 - 20 && x < RUNWAY.x1 + 20 && Math.abs(z) < RUNWAY.halfWidth + 6;
}

// Distance outside the runway apron rectangle
function runwayDist(x, z) {
  const dx = Math.max(RUNWAY.x0 - 140 - x, 0, x - (RUNWAY.x1 + 140));
  const dz = Math.max(Math.abs(z) - 90, 0);
  return Math.hypot(dx, dz);
}

// ---------- Valley channel ----------
// Half-width of the open (low) channel as a function of down-valley distance:
// pinches into a tight box canyon toward the head (x very negative) and
// flares open toward the mouth (x large positive).
function valleyHalfWidth(x) {
  const up = smoothstep(0, -2600, x);
  const down = smoothstep(1200, 4200, x);
  return 620 - 300 * up + 500 * down;
}

// General elevation drift of the valley floor: climbs gently toward the
// canyon head, and drops away toward the open mouth (lower terrain beyond).
function valleyFloorTrend(x) {
  const up = smoothstep(-200, -2600, x);
  const down = smoothstep(1200, 4200, x);
  return RUNWAY.y + 350 * up - 750 * down;
}

const WALL_RISE = 350; // generic canyon-wall relief outside the channel

// Named summits: ridged gaussian bumps flanking the valley, alternating
// sides. All sit well outside the channel half-width at their own x.
const PEAKS = [
  { x: -2600, z: 700, r: 950, h: 3450 },
  { x: -2000, z: -950, r: 850, h: 3050 },
  { x: -1200, z: 1100, r: 900, h: 3250 },
  { x: -500, z: -1300, r: 850, h: 2700 },
  { x: 700, z: 1400, r: 1000, h: 3450 },
  { x: 1500, z: -1450, r: 900, h: 2900 },
  { x: 2300, z: 1350, r: 1000, h: 3150 },
  { x: 2600, z: -1550, r: 950, h: 2750 },
  { x: 3400, z: 950, r: 900, h: 2550 },
];

export function getTerrainHeight(x, z) {
  const floor = valleyFloorTrend(x);
  const hw = valleyHalfWidth(x);
  const outside = Math.max(0, Math.abs(z) - hw);
  const wallT = smoothstep(0, 900, outside);

  const base = floor + wallT * WALL_RISE;

  // Blend toward the dominant nearby summit's own target elevation, rather
  // than summing overlapping bumps (which would stack into unrealistic
  // spires) or scaling off the local valley floor (which would starve peaks
  // near the low-lying mouth). Falls back smoothly to the base terrain
  // (valley floor / canyon wall) away from every summit.
  let gmax = 0, peakVal = 0;
  for (const p of PEAKS) {
    const dx = x - p.x, dz2 = z - p.z;
    const rr = p.r * p.r;
    const distSq = dx * dx + dz2 * dz2;
    if (distSq > rr * 6) continue; // cheap cull far outside the bump
    const g = Math.exp(-distSq / (2 * rr));
    if (g > gmax) {
      gmax = g;
      const ridge = 1 - Math.abs(2 * fbm(x * 0.0022 + p.x * 0.013, z * 0.0022 + p.z * 0.013, 3) - 1);
      peakVal = p.h * (0.85 + 0.15 * ridge);
    }
  }
  let h = base * (1 - gmax) + peakVal * gmax;

  // Fine surface detail
  h += (fbm(x * 0.012 + 3, z * 0.012 - 9, 3) - 0.5) * 20;

  // Flatten the plateau under/around the runway
  const d = runwayDist(x, z);
  if (d < 1100) {
    const w = 1 - smoothstep(80, 1100, d);
    h = h * (1 - w) + RUNWAY.y * w;
    if (d < 80) h = RUNWAY.y;
  }
  return h;
}

// ---------- Vertex colours ----------
const COL = {
  grass: new THREE.Color(0x5f8f4e),
  grass2: new THREE.Color(0x4a7a3c),
  scree: new THREE.Color(0x8d8578),
  rock: new THREE.Color(0x746b60),
  snow: new THREE.Color(0xf4f6f5),
};

function vertexColor(h, slope, x, z, out) {
  const jitter = (hash2(Math.round(x * 7), Math.round(z * 7)) - 0.5) * 0.05;
  if (h < 1550) out.lerpColors(COL.grass, COL.grass2, smoothstep(1350, 1550, h));
  else if (h < 2100) out.lerpColors(COL.grass2, COL.scree, smoothstep(1550, 2100, h));
  else if (h < 2800) out.lerpColors(COL.scree, COL.rock, smoothstep(2100, 2800, h));
  else out.lerpColors(COL.rock, COL.snow, smoothstep(2800, 3400, h));
  if (slope > 0.5 && h > 1600) out.lerp(COL.rock, smoothstep(0.5, 0.85, slope));
  if (h > 3200 && slope < 0.4) out.lerp(COL.snow, smoothstep(3200, 3600, h)); // snow caps even on gentle summits
  out.offsetHSL(0, 0, jitter);
  return out;
}

// ---------- Airfield dressing: runway slab, markings, hut, windsock ----------
export function createAirfield(scene) {
  const g = new THREE.Group();

  const canvas = document.createElement('canvas');
  canvas.width = 4096; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  const sx = 4096 / 1024, sy = 192 / 64;
  ctx.scale(sx, sy);
  ctx.fillStyle = '#4a4d47'; ctx.fillRect(0, 0, 1024, 64);
  ctx.fillStyle = '#c9cdd2';
  for (let x = 40; x < 984; x += 48) ctx.fillRect(x, 30.5, 26, 3);        // centerline
  for (let i = 0; i < 6; i++) { ctx.fillRect(8, 6 + i * 9, 22, 5); ctx.fillRect(994, 6 + i * 9, 22, 5); } // thresholds
  ctx.fillRect(0, 0, 1024, 1.4); ctx.fillRect(0, 62.6, 1024, 1.4);        // edges
  ctx.font = 'bold 26px sans-serif'; ctx.fillStyle = '#c9cdd2';
  ctx.save(); ctx.translate(70, 32); ctx.rotate(Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('15', 0, 9); ctx.restore();
  ctx.save(); ctx.translate(954, 32); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('33', 0, 9); ctx.restore();
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

  // Small alpine hut/hangar
  const hut = new THREE.Group();
  const shed = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 10), mat(0x7a5a3e));
  shed.position.y = 3;
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 6.5, 15, 3, 1, false, 0, Math.PI), mat(0x3d3d40));
  roof.rotation.z = Math.PI / 2; roof.rotation.y = Math.PI / 2; roof.position.y = 6; roof.scale.set(1, 1, 0.7);
  hut.add(shed, roof);
  hut.position.set(90, RUNWAY.y, 55);
  g.add(hut);

  // Windsock
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6.5), mat(0xcccccc));
  pole.position.set(20, RUNWAY.y + 3.25, 35);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.75, 3, 6), mat(0xd8632a));
  sock.rotation.z = Math.PI / 2; sock.position.set(21.6, RUNWAY.y + 6.1, 35);
  g.add(pole, sock);
  g.userData.windsock = sock; // main.js orients it from the live wind field

  scene.add(g);
  return g;
}

// ---------- Race course ----------
// A mountain slalom: gates leave the runway threshold, sweep down-valley
// (increasing x) weaving between the flanking summits, then loop back to
// line up with the runway on final approach.
const raceCourse = [
  [300, 250, 1420], [850, -350, 1480], [1450, 500, 1560], [2000, -700, 1620],
  [2550, 650, 1680], [3050, -550, 1560], [3550, 300, 1420], [3950, -450, 1280],
  [3500, -1050, 1220], [2700, -150, 1340], [1700, 250, 1400], [750, 0, 1370],
];

// ---------- Map object ----------
/** @type {import('./archipelago.js').FlightMap} */
export const alpineMap = {
  id: 'alpine',
  name: 'ALPINE',
  height: getTerrainHeight,
  color: vertexColor,
  isRunway,
  runway: RUNWAY,
  createScenery: createAirfield,
  raceCourse,
  obstacleTop() { return -Infinity; }, // no solid obstacles, mountains are terrain
};
