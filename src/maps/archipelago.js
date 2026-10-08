// ARCHIPELAGO — the original island world, packaged as a self-contained map
// module. A "map" bundles everything world-specific that the generic engine
// (terrain streamer, rings, environment) needs: a heightfield, vertex colours,
// a runway, scenery dressing, a race course, and optional solid obstacles.
//
// getTerrainHeight() is the single source of truth for ground elevation —
// physics ground contact and the rendered chunks both call it (via map.height).

import * as THREE from 'three';
import { makeNoise, woodland } from './noise.js';
import { PAL, seabed, beach, facetJitter, decalMaterial } from './palette.js';

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
 * @property {(x:number, z:number, h:number, slope:number) => number} [forest]
 *           Cosmetic tree density 0..1 at a point (terrain.js scatters instanced
 *           trees from it on the near chunks). Must return 0 on runways, aprons
 *           and water. Maps without it simply grow no trees.
 * @property {(h:number) => number} [conifer]
 *           Probability 0..1 that a tree at elevation h is a conifer rather
 *           than a broadleaf. Defaults to 0.3.
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

// ---------- Terrain colours (faceted: called once per triangle) ----------
// Cosmetic layers (forest + meadow) use their own noise so heights stay put.
const NZ = makeNoise(SEED ^ 0x5eed);
function forestDensity(x, z, h, slope) {
  if (h < 3 || h > 125 || slope > 0.55) return 0;
  const d = runwayDist(x, z);
  if (d < 220) return 0;
  const fade = smoothstep(220, 420, d) * (1 - smoothstep(95, 125, h)) * (1 - smoothstep(0.4, 0.55, slope));
  const f = woodland(NZ, x, z, 520, 0.85) * fade;
  return f > 0 ? f * villageClear(x, z) : 0;
}

function vertexColor(h, slope, x, z, out) {
  if (h < -0.6) return facetJitter(x, z, seabed(h, out), 0.02);
  if (h < 1.6) return facetJitter(x, z, beach(h, out), 0.03);
  // lowland grass -> scrubby highland -> rock -> snow
  out.lerpColors(PAL.grass, PAL.grassDark, smoothstep(10, 70, h));
  out.lerp(PAL.scrub, smoothstep(70, 120, h));
  out.lerp(PAL.rock, smoothstep(110, 165, h));
  if (h < 95) {
    // sun-dried meadow patches break up the uniform green
    out.lerp(PAL.meadow, smoothstep(0.5, 0.72, NZ.fbm(x / 380 + 40, z / 380 - 12, 3)) * 0.7);
    const f = forestDensity(x, z, h, slope);
    if (f > 0.08) out.lerp(PAL.forest, Math.min(1, f * 1.1));   // woodland reads beyond tree range
  }
  // steep faces are bare rock; snow only holds on the gentler high faces
  if (h > 2) out.lerp(slope > 0.9 ? PAL.rockDark : PAL.rock, smoothstep(0.5, 0.85, slope));
  if (h > 185) out.lerp(PAL.snow, smoothstep(185, 235, h) * (1 - smoothstep(0.75, 1.0, slope)));
  return facetJitter(x, z, out);
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
    decalMaterial(tex),
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

// ---------- Villages, piers, lighthouses (cosmetic, seeded, instanced) ----------
// Everything here only READS getTerrainHeight; heights (and the state hashes
// that depend on them) are untouched. Placement is deterministic: the same
// world every load. Draw calls: houses 2, piers 1, lighthouses ~6 each.
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slopeAt(x, z, e = 8) {
  const dx = getTerrainHeight(x + e, z) - getTerrainHeight(x - e, z);
  const dz = getTerrainHeight(x, z + e) - getTerrainHeight(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

// Fraction of n compass samples at radius r that are open water.
function waterRing(x, z, r, n = 8) {
  let w = 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    if (getTerrainHeight(x + Math.cos(a) * r, z + Math.sin(a) * r) < -1) w++;
  }
  return w / n;
}

// Pitched-roof prism: ridge along x, eaves overhang slightly. Unit footprint.
function roofGeometry() {
  const hw = 0.56, hd = 0.56, rise = 1;
  const v = [[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd], [-hw, rise, 0], [hw, rise, 0]];
  const tris = [[0, 1, 5], [0, 5, 4], [3, 5, 2], [3, 4, 5], [0, 4, 3], [1, 2, 5]];
  const pos = [];
  for (const t of tris) for (let k = 2; k >= 0; k--) pos.push(...v[t[k]]);   // outward-facing winding
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// Gentle land just above the beach, off the airfield, spread out.
function placeVillages(rand) {
  const cands = [];
  for (let x = -6000; x <= 7000; x += 200) {
    for (let z = -6000; z <= 6000; z += 200) {
      const jx = x + (rand() - 0.5) * 120, jz = z + (rand() - 0.5) * 120;
      const h = getTerrainHeight(jx, jz);
      if (h < 2.5 || h > 16 || runwayDist(jx, jz) < 450) continue;
      if (slopeAt(jx, jz, 20) > 0.1) continue;
      const shore = Math.max(waterRing(jx, jz, 140), waterRing(jx, jz, 260));
      cands.push({ x: jx, z: jz, h, k: rand() + (shore > 0 ? 1 : 0) });
    }
  }
  cands.sort((a, b) => b.k - a.k);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= 9) break;
    if (picked.some(p => Math.hypot(p.x - c.x, p.z - c.z) < 1300)) continue;
    picked.push(c);
  }
  return picked;
}

// Village sites are needed by the forest layer too (no trees on the houses),
// so they are computed once, lazily, from their own seeded stream.
let VILLAGE_SITES = null;
function villageSites() {
  return VILLAGE_SITES || (VILLAGE_SITES = placeVillages(rng32(SEED ^ 0x71a9e)));
}
// 0 inside a village, ramping to 1 by ~150 m out.
function villageClear(x, z) {
  let c = 1;
  const sites = villageSites();
  for (let i = 0; i < sites.length; i++) {
    const d = Math.hypot(x - sites[i].x, z - sites[i].z);
    if (d < 150) c = Math.min(c, smoothstep(95, 150, d));
  }
  return c;
}

function buildVillages(g, rand) {
  const sites = villageSites();
  const houses = [];   // {x,y,z,w,d,h,rot,wall,roof}
  const piers = [];    // {x0,z0,dx,dz,len}
  const wallCols = [PAL.sand, PAL.snow, PAL.urban, PAL.meadow];
  const roofCols = [0xc4573a, 0x3d6f9e, 0xa8452c, 0x2f8a86, 0x8a3b2e].map(c => new THREE.Color(c));

  for (const s of sites) {
    // orient the street grid toward the nearest water so houses face the sea
    let bestA = 0, bestD = 1e9;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (let d = 20; d <= 320; d += 20) {
        if (getTerrainHeight(s.x + Math.cos(a) * d, s.z + Math.sin(a) * d) < -0.5) {
          if (d < bestD) { bestD = d; bestA = a; }
          break;
        }
      }
    }
    const coastal = bestD < 1e9;
    const base = coastal ? bestA : rand() * Math.PI;
    const n = 5 + Math.floor(rand() * 16);
    const placed = [];
    const gold = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; placed.length < n && i < n * 6; i++) {
      const r = 10 + Math.sqrt(i) * 17 + rand() * 6;
      const a = i * gold + rand() * 0.4;
      const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
      const w = 7 + rand() * 4, d = 5.5 + rand() * 3;
      const rot = -base + (rand() - 0.5) * 0.35 + (rand() < 0.5 ? 0 : Math.PI / 2);
      // footprint corners + centre: all gentle, all above the beach, none on the apron
      const cr = Math.cos(rot), sr = Math.sin(rot);
      let lo = 1e9, hi = -1e9, ok = true;
      for (const [u, v] of [[0, 0], [w / 2, d / 2], [-w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]]) {
        const px = x + u * cr + v * sr, pz = z - u * sr + v * cr;
        if (isRunway(px, pz)) { ok = false; break; }
        const h = getTerrainHeight(px, pz);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      if (!ok || lo < 2 || hi > 22 || hi - lo > 2.2) continue;
      if (placed.some(p => Math.hypot(p.x - x, p.z - z) < (p.w + w) * 0.62)) continue;
      placed.push({
        x, y: lo, z, w, d, h: 3 + rand() * 1.2, rot,
        wall: wallCols[Math.floor(rand() * wallCols.length)],
        roof: roofCols[Math.floor(rand() * roofCols.length)],
      });
    }
    if (placed.length < 5) continue;
    houses.push(...placed);

    // Pier at coastal villages: from the beach, out along the line to the sea.
    if (coastal) {
      const dx = Math.cos(bestA), dz = Math.sin(bestA);
      let t = 0;
      while (t < 340 && getTerrainHeight(s.x + dx * t, s.z + dz * t) > 1.0) t += 3;
      if (t < 340) piers.push({ x0: s.x + dx * (t - 4), z0: s.z + dz * (t - 4), dx, dz, len: 20 + rand() * 12 });
    }
  }

  const lamb = () => new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const finish = (im) => { im.frustumCulled = false; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; g.add(im); };

  // Houses: walls and roofs as two instanced meshes (per-instance colour).
  if (houses.length) {
    const wallGeo = new THREE.BoxGeometry(1, 1, 1);
    wallGeo.translate(0, 0.5, 0);
    const walls = new THREE.InstancedMesh(wallGeo, lamb(), houses.length);
    const roofs = new THREE.InstancedMesh(roofGeometry(), lamb(), houses.length);
    houses.forEach((h, i) => {
      q.setFromAxisAngle(up, h.rot);
      // walls reach 1.6 m below the lowest corner so slopes never show a gap
      p.set(h.x, h.y - 1.6, h.z); sc.set(h.w, h.h + 1.6, h.d);
      m.compose(p, q, sc); walls.setMatrixAt(i, m); walls.setColorAt(i, h.wall);
      p.set(h.x, h.y + h.h, h.z); sc.set(h.w, 1.6 + (h.d - 5) * 0.25, h.d);
      m.compose(p, q, sc); roofs.setMatrixAt(i, m); roofs.setColorAt(i, h.roof);
    });
    finish(walls); finish(roofs);
  }

  // Piers: unit boxes (deck, piles, T-head), one instanced mesh.
  if (piers.length) {
    const boxes = [];
    const deck = new THREE.Color(0x9a7650), pile = new THREE.Color(0x5e472f);
    for (const pr of piers) {
      const rot = Math.atan2(-pr.dz, pr.dx);
      boxes.push({ x: pr.x0 + pr.dx * pr.len / 2, y: 1.15, z: pr.z0 + pr.dz * pr.len / 2, sx: pr.len, sy: 0.3, sz: 2.4, rot, c: deck });
      for (let t = 1.5; t < pr.len; t += 5) {
        for (const side of [-1, 1]) {
          boxes.push({ x: pr.x0 + pr.dx * t - pr.dz * side, y: -0.6, z: pr.z0 + pr.dz * t + pr.dx * side, sx: 0.35, sy: 3.2, sz: 0.35, rot, c: pile });
        }
      }
      boxes.push({ x: pr.x0 + pr.dx * pr.len, y: 1.15, z: pr.z0 + pr.dz * pr.len, sx: 2.4, sy: 0.3, sz: 7, rot, c: deck });
    }
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), lamb(), boxes.length);
    boxes.forEach((b, i) => {
      q.setFromAxisAngle(up, b.rot); p.set(b.x, b.y, b.z); sc.set(b.sx, b.sy, b.sz);
      m.compose(p, q, sc); im.setMatrixAt(i, m); im.setColorAt(i, b.c);
    });
    finish(im);
  }
  return houses;
}

// Lighthouses on headlands (land ringed by water). The beam is an additive
// double cone that only exists at night (toggled by nightGlow).
function buildLighthouses(g, rand) {
  const cands = [];
  for (let x = -6500; x <= 7500; x += 150) {
    for (let z = -6500; z <= 6500; z += 150) {
      const h = getTerrainHeight(x, z);
      if (h < 5 || h > 70 || runwayDist(x, z) < 600) continue;
      const w = waterRing(x, z, 260, 12);
      if (w < 0.4 || slopeAt(x, z, 10) > 0.45) continue;
      cands.push({ x, z, h, k: w + rand() * 0.15 });
    }
  }
  cands.sort((a, b) => b.k - a.k);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= 2) break;
    if (picked.some(p => Math.hypot(p.x - c.x, p.z - c.z) < 3500)) continue;
    picked.push(c);
  }
  const LH_SCALE = 1.7;
  const beams = new THREE.Group();
  beams.visible = false;
  g.add(beams);
  const white = new THREE.MeshLambertMaterial({ color: 0xf2f0ea, flatShading: true });
  const red = new THREE.MeshLambertMaterial({ color: 0xc8372d, flatShading: true });
  const glass = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xfff1c4, vertexColors: true, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const geos = {
    base: new THREE.CylinderGeometry(2.0, 3.2, 12, 8),
    band: new THREE.CylinderGeometry(1.6, 2.0, 7, 8),
    gallery: new THREE.CylinderGeometry(2.4, 2.4, 0.6, 8),
    lantern: new THREE.CylinderGeometry(1.15, 1.15, 2.2, 8),
    cap: new THREE.ConeGeometry(1.7, 1.8, 8),
  };
  const beamGeo = new THREE.ConeGeometry(70, 1100, 14, 1, true);
  beamGeo.translate(0, -550, 0); beamGeo.rotateZ(Math.PI / 2);   // apex at origin, opens along +x
  {
    // fade the beam with range (additive, so black = invisible)
    const bp = beamGeo.attributes.position, bc = [];
    for (let i = 0; i < bp.count; i++) { const f = Math.pow(Math.max(0, 1 - bp.getX(i) / 1100), 1.6); bc.push(f, f, f); }
    beamGeo.setAttribute('color', new THREE.Float32BufferAttribute(bc, 3));
  }
  const rotors = [];
  for (const c of picked) {
    const lh = new THREE.Group();
    lh.position.set(c.x, c.h - 2.5, c.z);
    lh.scale.setScalar(LH_SCALE);
    const add = (geo, mat, y) => { const mm = new THREE.Mesh(geo, mat); mm.position.y = y; lh.add(mm); };
    add(geos.base, white, 6); add(geos.band, red, 15.5); add(geos.gallery, red, 19.3);
    add(geos.lantern, glass, 20.7); add(geos.cap, red, 22.7);
    g.add(lh);

    const rot = new THREE.Group();
    rot.position.set(c.x, c.h - 2.5 + 20.7 * LH_SCALE, c.z);
    for (let k = 0; k < 2; k++) {
      const b = new THREE.Mesh(beamGeo, beamMat);
      b.rotation.y = k * Math.PI;
      b.renderOrder = 5;
      // never a shadow caster (environment.onMapLoaded marks every scenery mesh)
      Object.defineProperty(b, 'castShadow', { get: () => false, set() {} });
      rot.add(b);
    }
    rot.rotation.y = rand() * Math.PI * 2;
    beams.add(rot); rotors.push(rot);
  }
  return { beams, rotors };
}

export function createArchipelagoScenery(scene) {
  const g = createAirfield(scene);
  const rand = rng32(SEED ^ 0x4b1d3);
  try {
    g.userData.houses = buildVillages(g, rand);
    const lh = buildLighthouses(g, rand);
    g.userData.nightGlow = (night) => { lh.beams.visible = !!night && lh.rotors.length > 0; };
    g.userData.tick = (t) => { for (let i = 0; i < lh.rotors.length; i++) lh.rotors[i].rotation.y = t * 0.55 + i * 2; };
  } catch (e) {
    console.error('scenery dressing failed', e);   // dressing is optional, never block the map
  }
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
  createScenery: createArchipelagoScenery,
  raceCourse,
  obstacleTop() { return -Infinity; },  // no solid obstacles on this map
  forest: forestDensity,
  conifer: (h) => smoothstep(40, 100, h) * 0.8 + 0.1,
};
