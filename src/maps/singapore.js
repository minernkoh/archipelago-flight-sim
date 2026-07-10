// SINGAPORE — stylized 1:2-scale tribute map. Authored coastline (main island,
// Sentosa, Tekong) baked into a signed-distance grid at load; Changi 02L at the
// origin heading 020; solid city landmarks via a spatial obstacle hash.
// Implements the FlightMap contract documented in archipelago.js.

import * as THREE from 'three';
import {
  addMBS, addFlyer, addEsplanade, addCBD, addHDBEstate, addPort, addShips, addChangi,
  setNightGlow, addBeacon,
} from './sgLandmarks.js';

const RWY_Y = 7;
const RWY_HEADING = (90 - 20) * Math.PI / 180;   // compass 020
const FWD = { x: Math.cos(RWY_HEADING), z: -Math.sin(RWY_HEADING) };  // (0.342, -0.940)
const PERP = { x: -FWD.z, z: FWD.x };                                  // (0.940, 0.342)
const RWY_LEN = 2000, RWY_HALFW = 22.5;

const toRunwayFrame = (x, z) => ({ u: x * FWD.x + z * FWD.z, v: x * PERP.x + z * PERP.z });

// ---------- Authored coastline (km, x east / z south, origin at Changi) ----------
const MAIN = [
  [1.6, 1.3], [1.5, 0.5], [0.5, -1.2], [-2, -2.2], [-5, -2.8], [-8, -3.4],
  [-11, -3.2], [-14, -3.8], [-17, -3.0], [-19, -2.0], [-21, -0.5], [-22, 1.0],
  [-21.5, 2.5], [-19, 3.2], [-16, 3.6], [-13, 3.4], [-10.5, 4.0], [-8.5, 4.4],
  [-7, 4.2], [-5.5, 4.6], [-4, 4.2], [-2.5, 3.6], [-1, 2.8], [0.5, 2.0],
].map(([a, b]) => [a * 1000, b * 1000]);
const SENTOSA = [[-9.8, 5.0], [-8.6, 4.9], [-8.2, 5.4], [-9.0, 5.8], [-9.9, 5.6]]
  .map(([a, b]) => [a * 1000, b * 1000]);
const TEKONG = [[1.5, -2.5], [2.5, -3.0], [3.0, -2.2], [2.2, -1.7]]
  .map(([a, b]) => [a * 1000, b * 1000]);
const POLYS = [MAIN, SENTOSA, TEKONG];

// ---------- Signed-distance grid (positive = inland, metres) ----------
const GX0 = -23500, GX1 = 4500, GZ0 = -6500, GZ1 = 8500, GNX = 256, GNZ = 176;
const CW = (GX1 - GX0) / (GNX - 1), CH = (GZ1 - GZ0) / (GNZ - 1);
const SDF = new Float32Array(GNX * GNZ);

function inPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function edgeDist(poly, x, z) {
  let d2 = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, z1] = poly[j], [x2, z2] = poly[i];
    const dx = x2 - x1, dz = z2 - z1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / (dx * dx + dz * dz)));
    const px = x1 + t * dx - x, pz = z1 + t * dz - z;
    d2 = Math.min(d2, px * px + pz * pz);
  }
  return Math.sqrt(d2);
}
(function bake() {
  for (let iz = 0; iz < GNZ; iz++) {
    for (let ix = 0; ix < GNX; ix++) {
      const x = GX0 + ix * CW, z = GZ0 + iz * CH;
      let dist = Infinity, inside = false;
      for (const p of POLYS) {
        if (inPoly(p, x, z)) inside = true;
        dist = Math.min(dist, edgeDist(p, x, z));
      }
      SDF[iz * GNX + ix] = inside ? dist : -dist;
    }
  }
})();
function sdf(x, z) {
  const fx = Math.min(Math.max((x - GX0) / CW, 0), GNX - 1.001);
  const fz = Math.min(Math.max((z - GZ0) / CH, 0), GNZ - 1.001);
  const ix = fx | 0, iz = fz | 0, u = fx - ix, v = fz - iz;
  const a = SDF[iz * GNX + ix], b = SDF[iz * GNX + ix + 1];
  const c = SDF[(iz + 1) * GNX + ix], d = SDF[(iz + 1) * GNX + ix + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// ---------- Noise (independent seed from the archipelago) ----------
const SEED = 65020;
function hash2(ix, iz) {
  let n = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ SEED;
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n ^= n >>> 13;
  return (n >>> 0) / 4294967296;
}
const sstep = t => t * t * t * (t * (t * 6 - 15) + 10);
function noise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const u = sstep(x - ix), v = sstep(z - iz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z, oct) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) { sum += amp * noise2(x * f, z * f); norm += amp; amp *= 0.5; f *= 2; }
  return sum / norm;
}
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (x, z, cx, cz, sigma) => {
  const dx = x - cx, dz = z - cz;
  return Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
};

// ---------- Heightfield ----------
export function height(x, z) {
  const d = sdf(x, z);
  let h;
  if (d <= 0) {
    h = Math.max(-38, d * 0.06);                      // shallow strait shelf
  } else {
    h = 3 + 9 * smoothstep(0, 500, d) + (fbm(x * 0.002 + 5, z * 0.002 + 11, 3) - 0.5) * 14;
    h += 300 * gauss(x, z, -10000, 800, 1250);        // Bukit Timah (2x vertical)
    h += 130 * gauss(x, z, -8800, -400, 2100);        // central catchment ridge
    h = Math.max(h, 0.8);
  }
  // Changi flatten
  const { u, v } = toRunwayFrame(x, z);
  const du = Math.max(-900 - u, 0, u - 2200);
  const dv = Math.max(Math.abs(v) - 950, 0);
  const dd = Math.hypot(du, dv);
  if (dd < 1500) {
    const w = 1 - smoothstep(0, 1500, dd);
    h = h * (1 - w) + RWY_Y * w;
    if (dd === 0) h = RWY_Y;
  }
  return h;
}

// ---------- Vertex colours: tropical + urban ----------
const COL = {
  sand: new THREE.Color(0xd9cba0), green: new THREE.Color(0x5d9455),
  green2: new THREE.Color(0x467a44), mangrove: new THREE.Color(0x3d6647),
  urban: new THREE.Color(0x9aa0a3), rock: new THREE.Color(0x8d8578),
  sea: new THREE.Color(0x2e7a80), shore: new THREE.Color(0x53a3a0),
};
// Urban districts double as HDB estate anchors (x, z, radius)
const DISTRICTS = [
  [-2600, 600, 1500], [-4100, 1900, 1400], [-7400, 2300, 1500], [-13000, -2100, 1600],
  [-15800, 1900, 1700], [-3400, -600, 1200], [-9000, 1500, 1200],
  [-6000, 4300, 1600] /* CBD/Marina */,
];
function color(h, slope, x, z, out) {
  const jitter = (hash2(Math.round(x * 7), Math.round(z * 7)) - 0.5) * 0.05;
  if (h < -1) { out.copy(COL.sea); if (h > -7) out.lerp(COL.shore, (h + 7) / 6 * 0.7); }
  else if (h < 1.5) out.copy(COL.sand);
  else {
    out.lerpColors(COL.green, COL.green2, smoothstep(6, 120, h));
    if (z < -2400 && h < 9) out.lerp(COL.mangrove, 0.6);        // north-coast mangrove
    let urban = 0;
    for (const [dx, dz, r] of DISTRICTS) {
      const g = 1 - smoothstep(r * 0.45, r, Math.hypot(x - dx, z - dz));
      if (g > urban) urban = g;
    }
    if (urban > 0) out.lerp(COL.urban, urban * 0.65);
    if (slope > 0.6) out.lerp(COL.rock, smoothstep(0.6, 0.95, slope));
  }
  out.offsetHSL(0, 0, jitter);
  return out;
}

// ---------- Runway / spawn ----------
export const runway = {
  spawn: { x: 60 * FWD.x, z: 60 * FWD.z },
  headingRad: RWY_HEADING,
  y: RWY_Y,
  name: '02L',
  x0: 0, x1: RWY_LEN, halfWidth: RWY_HALFW,
};

const RWY2_V = -800; // parallel 02C, decorative but landable
export function isRunway(x, z) {
  const { u, v } = toRunwayFrame(x, z);
  if (u > -30 && u < RWY_LEN + 30) {
    if (Math.abs(v) < RWY_HALFW + 6) return true;
    if (Math.abs(v - RWY2_V) < RWY_HALFW + 6) return true;
  }
  return false;
}

// ---------- Solid obstacles: spatial hash of AABBs ----------
const CELL = 64;
let obstacles = new Map();
const cellKey = (cx, cz) => cx * 100000 + cz;
function reg(x0, x1, z0, z1, top) {
  const box = { x0, x1, z0, z1, top };
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
      const k = cellKey(cx, cz);
      let arr = obstacles.get(k);
      if (!arr) obstacles.set(k, arr = []);
      arr.push(box);
    }
}
export function obstacleTop(x, z) {
  const arr = obstacles.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!arr) return -Infinity;
  let top = -Infinity;
  for (const b of arr) {
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.top > top) top = b.top;
  }
  return top;
}

// ---------- Scenery ----------
function mulberry(seed) {
  let s = seed;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runwayStrip(g, vOffset, label1, label2) {
  const canvas = document.createElement('canvas');
  canvas.width = 4096; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.scale(4096 / 1024, 192 / 64);
  ctx.fillStyle = '#3a3d42'; ctx.fillRect(0, 0, 1024, 64);
  ctx.fillStyle = '#c9cdd2';
  for (let x = 40; x < 984; x += 48) ctx.fillRect(x, 30.5, 26, 3);
  for (let i = 0; i < 6; i++) { ctx.fillRect(8, 6 + i * 9, 22, 5); ctx.fillRect(994, 6 + i * 9, 22, 5); }
  ctx.fillRect(0, 0, 1024, 1.4); ctx.fillRect(0, 62.6, 1024, 1.4);
  ctx.font = 'bold 22px sans-serif';
  ctx.save(); ctx.translate(78, 32); ctx.rotate(Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(label1, 0, 8); ctx.restore();
  ctx.save(); ctx.translate(946, 32); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(label2, 0, 8); ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(RWY_LEN, RWY_HALFW * 2),
    new THREE.MeshLambertMaterial({ map: tex }),
  );
  strip.rotation.x = -Math.PI / 2;
  // Euler XYZ applies Z (in-plane) before X (lay flat): local +x -> world (cos h, 0, -sin h)
  strip.rotation.z = RWY_HEADING;
  const cx = (RWY_LEN / 2) * FWD.x + vOffset * PERP.x;
  const cz = (RWY_LEN / 2) * FWD.z + vOffset * PERP.z;
  strip.position.set(cx, RWY_Y + 0.06, cz);
  g.add(strip);
}

export function createScenery(scene) {
  obstacles = new Map(); // fresh registry per load (avoid duplicates on map swap)
  const g = new THREE.Group();
  const rng = mulberry(SEED);

  runwayStrip(g, 0, '02L', '20R');
  runwayStrip(g, RWY2_V, '02C', '20C');
  addChangi(g, reg, RWY_Y, FWD);

  const gy = (x, z) => height(x, z);
  addMBS(g, reg, -5600, 4350, gy(-5600, 4350));
  addFlyer(g, reg, -5150, 3950, gy(-5150, 3950));
  addEsplanade(g, reg, -5850, 4150, gy(-5850, 4150));
  addCBD(g, reg, -6350, 4550, gy(-6350, 4550), rng);
  addPort(g, reg, -10600, 4050, gy(-10600, 4050), rng);
  for (const [dx, dz] of DISTRICTS.slice(0, 7)) addHDBEstate(g, reg, dx, dz, gy(dx, dz), rng);
  addShips(g, reg, rng, 0, [[-7300, 5600, 7], [-4500, 5500, 5]]);

  // Night content: red obstruction beacons atop the three MBS towers + the
  // Changi control tower. The environment shows/blinks them after dark.
  const mbsY = gy(-5600, 4350) + 200 + 20;
  const beacons = [
    addBeacon(g, -5690, mbsY, 4350), addBeacon(g, -5600, mbsY, 4350), addBeacon(g, -5510, mbsY, 4350),
    addBeacon(g, -260, RWY_Y + 98, 330),
  ];
  g.userData.beacons = beacons;
  g.userData.nightGlow = setNightGlow;

  scene.add(g);
  return g;
}

// ---------- City tour race course ----------
const raceCourse = [
  [-450, -1600, 170], [-2200, -1100, 260], [-4000, 900, 240], [-5150, 3600, 150],
  [-6350, 4500, 150], [-5600, 5000, 100], [-4900, 4200, 120], [-7300, 5500, 70],
  [-9000, 5200, 110], [-11000, 3600, 220], [-7000, 1500, 260], [-1100, 2900, 130],
];

/** @type {import('./archipelago.js').FlightMap} */
export const singaporeMap = {
  id: 'singapore',
  name: 'SINGAPORE',
  height,
  color,
  isRunway,
  runway,
  createScenery,
  raceCourse,
  finalGateDir: { x: FWD.x, z: FWD.z },  // last gate faces down 02L
  obstacleTop,
};
