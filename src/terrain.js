// Generic chunked-terrain streamer. World-specific data (heightfield, vertex
// colours, runway, scenery) lives in a map module — see src/maps/archipelago.js
// and the FlightMap typedef there. createTerrain() consumes map.height +
// map.color and knows nothing else about the world.

import * as THREE from 'three';
import { archipelagoMap } from './maps/archipelago.js';

// ---------- Chunked mesh streaming ----------
//
// TWO TIERS (v6). The fine tier is unchanged: 11x11 chunks of 600 m reaching
// ~3.3 km. That is the problem it used to have on its own — fog runs to
// 4200-5200 m (see environment.js TIMES), so the world visibly ENDED almost
// two kilometres before fog could hide it. Worst on alpine and the streamed
// real-elevation fields, which is exactly where the view matters.
//
// The coarse tier fills 1.8 -> 9 km with 3600 m chunks at RES 18 (200 m
// vertex spacing) for only 24 meshes and ~15.5k triangles. It UNDERLIES the
// fine tier by FAR_DROP metres rather than abutting it: where the two overlap
// the fine mesh always wins, so there is no seam to crack and no need for
// skirts or a nested grid that snaps the fine region to coarse cells.
const CHUNK = 600, RES = 36, VIEW_R = 5;      // fine: 11x11 -> +/-3300 m
const FAR_CHUNK = 3600, FAR_RES = 18, FAR_R = 2; // coarse: 5x5 -> +/-9000 m
const FAR_DROP = 2;                           // metres the coarse tier sits below

/**
 * Which coarse cells to keep for a position — pure, so the tiling is unit
 * tested headlessly (no THREE, no DOM). The cell containing the aircraft is
 * dropped because the fine tier already covers it entirely: a coarse cell
 * spans +/-1800 m about its centre, well inside the fine tier's +/-3300 m.
 */
export function farCellsFor(px, pz) {
  const fx = Math.round(px / FAR_CHUNK), fz = Math.round(pz / FAR_CHUNK);
  const keys = [];
  for (let i = -FAR_R; i <= FAR_R; i++)
    for (let j = -FAR_R; j <= FAR_R; j++) {
      if (i === 0 && j === 0) continue;      // fully covered by the fine tier
      keys.push(`${fx + i},${fz + j}`);
    }
  return keys;
}

/** Metres of terrain either side of the aircraft, fine and coarse. */
export const VIEW_EXTENTS = {
  fine: VIEW_R * CHUNK + CHUNK / 2,          // 3300
  coarse: FAR_R * FAR_CHUNK + FAR_CHUNK / 2, // 9000
};

// Radius a real-world map needs elevation tiles *ready* for before the coarse
// tier can build without deferring. A coarse cell's own readiness gate (see
// update() below) checks map.ready(cellCenter, FAR_CHUNK*0.75); the farthest
// cell centre is FAR_R*FAR_CHUNK out, so the outermost point anyone actually
// queries is FAR_R*FAR_CHUNK + FAR_CHUNK*0.75 = 7200 + 2700 = 9900 m. Both the
// boot/loadMap pre-wait (main.js) and the frame-loop prefetch (main.js) use
// this single constant so they can't drift out of sync with each other or
// with the geometry above; anything short of it just means more cells defer
// through terrain.js's own per-chunk prefetch/re-queue loop instead.
export const COARSE_TILE_RADIUS = FAR_R * FAR_CHUNK + FAR_CHUNK * 0.75; // 9900

// ---------- Vegetation ----------
// Instanced low-poly trees on the fine chunks nearest the aircraft. The ring
// (TREE_R) is smaller than the fine tier: beyond ~1.5 km a tree is a few pixels and
// the map's colour function already darkens woodland, so forests still read
// from altitude. Placement is a jittered grid hashed on WORLD cell coords, so
// a chunk regrows the identical forest every time it streams back in.
const TREE_R = 2;                 // chunks either side -> +/-1500 m
const TREE_STEP = 19;             // metres between candidate sites
export const TREE_RING_M = TREE_R * CHUNK + CHUNK / 2;

function treeHash(ix, iz, k) {
  let n = Math.imul(ix, 0x2c1b3c6d) ^ Math.imul(iz, 0x297a2d39) ^ Math.imul(k, 0x9e3779b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
  n ^= n >>> 13;
  return (n >>> 0) / 4294967296;
}

// Merge a few primitives into one non-indexed geometry with vertex colours.
function mergeColored(parts) {
  const pos = [], nor = [], col = [];
  for (const [geo, hex] of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.computeVertexNormals();
    const c = new THREE.Color(hex);
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    geo.dispose(); if (g !== geo) g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

// Unit-height trees (base at y=0, top at y=1); instances scale them. Kept to
// ~20 triangles each (open-ended, no caps you could ever see from the air):
// thousands are instanced, and software-rendered test runs feel every one.
function coniferGeometry() {
  const trunk = new THREE.CylinderGeometry(0.04, 0.05, 0.3, 4, 1, true); trunk.translate(0, 0.15, 0);
  const lo = new THREE.ConeGeometry(0.3, 0.6, 6, 1, true); lo.translate(0, 0.45, 0);
  const hi = new THREE.ConeGeometry(0.2, 0.45, 5, 1, true); hi.translate(0, 0.77, 0);
  return mergeColored([[trunk, 0x5b4331], [lo, 0x2c5530], [hi, 0x336136]]);
}
function broadleafGeometry() {
  const trunk = new THREE.CylinderGeometry(0.04, 0.06, 0.45, 4, 1, true); trunk.translate(0, 0.225, 0);
  const crown = new THREE.OctahedronGeometry(0.36, 0); crown.scale(1, 0.95, 1); crown.translate(0, 0.68, 0);
  return mergeColored([[trunk, 0x5e4632], [crown, 0x4c7d36]]);
}

export function createTerrain(scene, map = archipelagoMap) {
  const heightFn = map.height;
  const colorFn = map.color;

  const chunks = new Map(); // "n:cx,cz" | "f:cx,cz" -> mesh
  const pending = [];
  let curCx = null, curCz = null;
  let farOn = true;

  // Trees: their own keyed set + pending queue, independent of chunk meshes.
  const trees = new Map();         // "cx,cz" -> THREE.Group (0-2 InstancedMesh)
  const treePending = [];
  let treesOn = !!map.forest;
  let treeCx = null, treeCz = null;
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const coniferGeo = map.forest ? coniferGeometry() : null;
  const broadGeo = map.forest ? broadleafGeometry() : null;
  const coniferP = map.conifer || (() => 0.3);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(),
    _p = new THREE.Vector3(), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);

  function buildTrees(cx, cz) {
    const group = new THREE.Group();
    const half = CHUNK / 2, x0 = cx * CHUNK - half, z0 = cz * CHUNK - half;
    const gx0 = Math.ceil(x0 / TREE_STEP), gz0 = Math.ceil(z0 / TREE_STEP);
    const gx1 = Math.ceil((x0 + CHUNK) / TREE_STEP), gz1 = Math.ceil((z0 + CHUNK) / TREE_STEP);
    const con = [], brd = [];
    for (let gx = gx0; gx < gx1; gx++) for (let gz = gz0; gz < gz1; gz++) {
      const x = (gx + treeHash(gx, gz, 1) * 0.9) * TREE_STEP;
      const z = (gz + treeHash(gx, gz, 2) * 0.9) * TREE_STEP;
      const h = heightFn(x, z);
      if (h < 1.5) continue;
      const hx = heightFn(x + 6, z), hz = heightFn(x, z + 6);
      const slope = Math.min(1, Math.hypot(h - hx, h - hz) / 6);
      const dens = map.forest(x, z, h, slope);
      if (dens <= 0 || treeHash(gx, gz, 3) > dens * 0.95) continue;
      if (map.obstacleTop(x, z) > h - 1) continue;          // never inside a building
      const r = treeHash(gx, gz, 4);
      (treeHash(gx, gz, 5) < coniferP(h) ? con : brd).push([x, h, z, r]);
    }
    for (const [list, geo, tall] of [[con, coniferGeo, 13], [brd, broadGeo, 10]]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, treeMat, list.length);
      list.forEach(([x, h, z, r], i) => {
        const sc = tall * (0.65 + r * 0.7);
        _q.setFromAxisAngle(_up, r * 40);
        _s.set(sc * (0.85 + ((r * 7) % 1) * 0.35), sc, sc * (0.85 + ((r * 13) % 1) * 0.35));
        _p.set(x, h - 0.4, z);
        im.setMatrixAt(i, _m.compose(_p, _q, _s));
        _c.setHSL(0.27 + (((r * 17) % 1) - 0.5) * 0.06, 0.25, 0.42 + (((r * 29) % 1) - 0.5) * 0.18);
        im.setColorAt(i, _c.multiplyScalar(2.2));
      });
      // No shadow-map casting: the shadow box is only ~280 m across, and the
      // extra pass over every instance cost more than it showed.
      im.castShadow = false;
      im.computeBoundingSphere();
      group.add(im);
    }
    return group;
  }

  function wantTrees(px, pz) {
    if (!treesOn) {
      if (trees.size) { for (const g of trees.values()) disposeTrees(g); trees.clear(); }
      treePending.length = 0; treeCx = treeCz = null;
      return;
    }
    const cx = Math.round(px / CHUNK), cz = Math.round(pz / CHUNK);
    if (cx === treeCx && cz === treeCz) return;
    treeCx = cx; treeCz = cz;
    const need = new Set();
    for (let i = -TREE_R; i <= TREE_R; i++)
      for (let j = -TREE_R; j <= TREE_R; j++) need.add(`${cx + i},${cz + j}`);
    for (const [k, g] of trees) if (!need.has(k)) { disposeTrees(g); trees.delete(k); }
    treePending.length = 0;
    for (const k of need) if (!trees.has(k)) treePending.push(k);
    const d = (k) => { const [a, b] = k.split(',').map(Number); return Math.abs(a - cx) + Math.abs(b - cz); };
    treePending.sort((a, b) => d(a) - d(b));
  }
  function disposeTrees(g) {
    scene.remove(g);
    for (const im of g.children) im.dispose?.();   // geometry + material are shared
  }

  // One material per tier instead of one per chunk — every chunk used its own
  // identical MeshLambertMaterial, so a full view was 121 redundant materials.
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const farMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

  function buildChunk(cx, cz, size = CHUNK, res = RES, drop = 0) {
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const x0 = cx * size, z0 = cz * size;
    // Slope is sampled over the chunk's own vertex spacing, so the coarse tier
    // reads its own relief rather than 8 m detail it cannot resolve.
    const step = Math.max(8, size / res / 2);
    for (let i = 0; i < pos.count; i++) {
      const wx = x0 + pos.getX(i), wz = z0 + pos.getZ(i);
      const h = heightFn(wx, wz);
      pos.setY(i, h);
      const hx = heightFn(wx + step, wz), hz = heightFn(wx, wz + step);
      const slope = Math.min(1, Math.hypot(h - hx, h - hz) / step);
      colorFn(h, slope, wx, wz, c);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, drop ? farMat : mat);
    mesh.position.set(x0, -drop, z0);
    mesh.receiveShadow = !drop;   // shadows only land on the fine tier
    return mesh;
  }

  // Keys are tier-prefixed ("n:" fine, "f:" coarse) so one map holds both.
  function want(px, pz) {
    const cx = Math.round(px / CHUNK), cz = Math.round(pz / CHUNK);
    if (cx === curCx && cz === curCz) return;
    curCx = cx; curCz = cz;
    const need = new Set();
    for (let i = -VIEW_R; i <= VIEW_R; i++)
      for (let j = -VIEW_R; j <= VIEW_R; j++)
        need.add(`n:${cx + i},${cz + j}`);
    if (farOn) for (const k of farCellsFor(px, pz)) need.add(`f:${k}`);
    for (const key of chunks.keys()) {
      if (!need.has(key)) {
        const m = chunks.get(key);
        scene.remove(m); m.geometry.dispose();   // materials are shared per tier
        chunks.delete(key);
      }
    }
    pending.length = 0;
    for (const key of need) if (!chunks.has(key)) pending.push(key);
    // Fine tier first, then nearest-first inside each tier: the ground under
    // the aircraft must never be the thing that is still missing.
    const rank = (k) => {
      const fine = k.startsWith('n:');
      const [ax, az] = k.slice(2).split(',').map(Number);
      const scale = fine ? 1 : FAR_CHUNK / CHUNK;
      const d = Math.abs(ax * scale - cx) + Math.abs(az * scale - cz);
      return (fine ? 0 : 10000) + d;
    };
    pending.sort((a, b) => rank(a) - rank(b));
  }

  return {
    // Call each frame; builds a couple of chunks per call to avoid hitches.
    // `force` skips the coarse-tier tile wait — used by loadMap after its
    // elevation timeout so a stalled network cannot spin pending forever.
    update(px, pz, budget = 2, force = false) {
      want(px, pz);
      for (let n = 0; n < budget && pending.length; n++) {
        const key = pending.shift();
        if (chunks.has(key)) continue;
        const fine = key.startsWith('n:');
        const [cx, cz] = key.slice(2).split(',').map(Number);
        // Real-world maps return sea level for tiles that have not arrived, so
        // a coarse chunk built too early bakes a flat plate that never
        // corrects. Defer it (re-queued at the back) until its tiles land.
        if (!force && !fine && map.ready && !map.ready(cx * FAR_CHUNK, cz * FAR_CHUNK, FAR_CHUNK * 0.75)) {
          map.prefetch?.(cx * FAR_CHUNK, cz * FAR_CHUNK, FAR_CHUNK * 0.75);
          pending.push(key);
          continue;
        }
        const mesh = fine ? buildChunk(cx, cz)
          : buildChunk(cx, cz, FAR_CHUNK, FAR_RES, FAR_DROP);
        chunks.set(key, mesh);
        scene.add(mesh);
      }
      // Trees ride the same per-call budget, but only after the ground under
      // the aircraft exists (a forest floating over a missing chunk is worse
      // than a bare one for a few frames).
      wantTrees(px, pz);
      if (pending.length === 0 || force) {
        for (let n = 0; n < Math.max(1, budget >> 1) && treePending.length; n++) {
          const k = treePending.shift();
          if (trees.has(k)) continue;
          const [cx, cz] = k.split(',').map(Number);
          const g = buildTrees(cx, cz);
          trees.set(k, g);
          scene.add(g);
        }
      }
    },
    /** Coarse tier off = the old single-tier behaviour (quality: LOW). */
    setFarTier(on) { farOn = !!on; curCx = null; curCz = null; },
    /** Vegetation on/off (quality knob). A map with no `forest` never grows any. */
    setTrees(on) { treesOn = !!on && !!map.forest; treeCx = treeCz = null; },
    counts() {
      let fine = 0, coarse = 0, treeInstances = 0;
      for (const k of chunks.keys()) k.startsWith('n:') ? fine++ : coarse++;
      for (const g of trees.values()) for (const im of g.children) treeInstances += im.count;
      return { fine, coarse, treeChunks: trees.size, treeInstances };
    },
    pendingCount: () => pending.length + treePending.length,
    prime(px, pz) { want(px, pz); wantTrees(px, pz); }, // fill pending lists without building
    // Tear down every chunk and reset streaming state so the next update()
    // rebuilds from scratch (used when swapping maps).
    disposeAll() {
      for (const m of chunks.values()) { scene.remove(m); m.geometry.dispose(); }
      mat.dispose(); farMat.dispose();   // shared: disposed once, at teardown
      chunks.clear();
      pending.length = 0;
      curCx = null; curCz = null;
      for (const g of trees.values()) disposeTrees(g);
      trees.clear(); treePending.length = 0; treeCx = treeCz = null;
      treeMat.dispose(); coniferGeo?.dispose(); broadGeo?.dispose();
    },
  };
}

// ---------- Back-compat re-exports (removed during integration) ----------
// Untouched callers still import these world-specific names from './terrain.js'.
export { getTerrainHeight, isRunway, RUNWAY, createAirfield } from './maps/archipelago.js';
