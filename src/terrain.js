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
// Fine-tier LOD (v9). Software-rendered runs spent ~40% of every frame on the
// fine tier's ~140k visible triangles, most of them in chunks a kilometre or
// more away where a 17 m facet is a pixel or two. Chunks LOD_R or more rings
// out build every other grid line (33 m facets, a quarter of the triangles);
// their EDGES keep every fine vertex, so they stitch crack-free to any
// neighbour (see buildChunk). SHADOW_R: only the chunks the ~280 m shadow box
// can reach receive shadows; the rest skip the shadow-map lookups entirely.
const LOD_R = 3, SHADOW_R = 1;

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
  return mergeColored([[trunk, 0x7a5a40], [lo, 0x3f8a45], [hi, 0x4f9d52]]);
}
function broadleafGeometry() {
  const trunk = new THREE.CylinderGeometry(0.04, 0.06, 0.45, 4, 1, true); trunk.translate(0, 0.225, 0);
  const crown = new THREE.OctahedronGeometry(0.36, 0); crown.scale(1, 0.95, 1); crown.translate(0, 0.68, 0);
  return mergeColored([[trunk, 0x7d5c40], [crown, 0x72b04a]]);
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
    for (const [list, geo, tall] of [[con, coniferGeo, 17], [brd, broadGeo, 13]]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, treeMat, list.length);
      list.forEach(([x, h, z, r], i) => {
        const sc = tall * (0.65 + r * 0.7);
        _q.setFromAxisAngle(_up, r * 40);
        _s.set(sc * (0.85 + ((r * 7) % 1) * 0.35), sc, sc * (0.85 + ((r * 13) % 1) * 0.35));
        _p.set(x, h - 0.4, z);
        im.setMatrixAt(i, _m.compose(_p, _q, _s));
        // per-tree tint around 1.0: a little lighter/darker, a little warmer/cooler
        const lt = 0.88 + ((r * 29) % 1) * 0.3, warm = (((r * 17) % 1) - 0.5) * 0.16;
        _c.setRGB(lt * (1 + warm), lt, lt * (1 - warm * 0.5));
        im.setColorAt(i, _c);
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
  // The coarse tier interpolates over 200 m, so on rugged ground it can rise
  // ABOVE the fine surface in valleys and poke through it (FAR_DROP alone is
  // only 2 m). Inside the fine tier's reach, sink it well out of the way; the
  // fine tier always covers at least ~3000 m from the aircraft.
  farMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 fw = modelMatrix * vec4(transformed, 1.0);
      transformed.y -= (1.0 - smoothstep(2500.0, 2950.0, distance(fw.xz, cameraPosition.xz))) * 250.0;`);
  };

  // The coarse tier (200 m cells, 1.8-9 km out) keeps smooth per-vertex
  // colour: facets that big read as crude slabs, and at that range fog and
  // distance want soft gradients anyway.
  function buildSmooth(hgt, n, cell, half, x0, z0, drop) {
    const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, h = hgt[k];
      const hx = hgt[j * n + Math.min(n - 1, i + 1)], hz = hgt[Math.min(n - 1, j + 1) * n + i];
      const slope = Math.min(1, Math.hypot(h - hx, h - hz) / cell);
      const lx = -half + i * cell, lz = -half + j * cell;
      colorFn(h, slope, x0 + lx, z0 + lz, _fc);
      pos[k * 3] = lx; pos[k * 3 + 1] = h; pos[k * 3 + 2] = lz;
      col[k * 3] = _fc.r; col[k * 3 + 1] = _fc.g; col[k * 3 + 2] = _fc.b;
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, farMat);
    mesh.position.set(x0, -drop, z0);
    return mesh;
  }

  // FACETED: one colour per triangle, sampled at the triangle's centroid with
  // the slope of the face itself. Per-vertex colours used to smear across
  // every face, which made the ground read as a blurry low-res texture rather
  // than low-poly; a flat colour per facet is what gives the style its crisp
  // cut-paper look. Costs a non-indexed geometry (6 verts per quad).
  const _fc = new THREE.Color();
  function buildChunk(cx, cz, size = CHUNK, res = RES, drop = 0, step = 1) {
    const x0 = cx * size, z0 = cz * size;
    const n = res + 1, cell = size / res, half = size / 2;
    const hgt = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      hgt[j * n + i] = heightFn(x0 - half + i * cell, z0 - half + j * cell);
    }
    if (drop) return buildSmooth(hgt, n, cell, half, x0, z0, drop);
    // Triangles are emitted by grid index so a decimated chunk (step 2) uses
    // bit-identical positions and heights to its full-res neighbour.
    const m = res / step;
    const tris = m * m * 2 + (step > 1 ? m * 4 : 0);   // + one split per edge cell
    const pos = new Float32Array(tris * 9);
    const col = new Float32Array(tris * 9);
    let p = 0;
    const tri = (ai, aj, bi, bj, qi, qj) => {
      const ax = -half + ai * cell, az = -half + aj * cell, ah = hgt[aj * n + ai];
      const bx = -half + bi * cell, bz = -half + bj * cell, bh = hgt[bj * n + bi];
      const qx = -half + qi * cell, qz = -half + qj * cell, qh = hgt[qj * n + qi];
      // face normal (y-up) -> slope as rise/run, same scale the maps expect
      const ux = bx - ax, uy = bh - ah, uz = bz - az, vx = qx - ax, vy = qh - ah, vz = qz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const slope = Math.min(1, Math.hypot(nx, nz) / Math.max(1e-6, Math.abs(ny)));
      const mx = (ax + bx + qx) / 3, mz = (az + bz + qz) / 3, mh = (ah + bh + qh) / 3;
      colorFn(mh, slope, x0 + mx, z0 + mz, _fc);
      pos[p] = ax; pos[p + 1] = ah; pos[p + 2] = az;
      pos[p + 3] = bx; pos[p + 4] = bh; pos[p + 5] = bz;
      pos[p + 6] = qx; pos[p + 7] = qh; pos[p + 8] = qz;
      for (let k = 0; k < 9; k += 3) { col[p + k] = _fc.r; col[p + k + 1] = _fc.g; col[p + k + 2] = _fc.b; }
      p += 9;
    };
    // An edge lying on the chunk border and spanning two fine cells is split at
    // its fine midpoint, so the border matches a full-res neighbour exactly.
    const onBorder = (ai, aj, bi, bj) => (ai === bi && (ai === 0 || ai === res)) || (aj === bj && (aj === 0 || aj === res));
    const face = (ai, aj, bi, bj, qi, qj) => {
      if (step > 1) {
        const e = [[ai, aj, bi, bj, qi, qj], [bi, bj, qi, qj, ai, aj], [qi, qj, ai, aj, bi, bj]];
        for (const [a1, a2, b1, b2, c1, c2] of e) {
          if (Math.abs(a1 - b1) + Math.abs(a2 - b2) > 1 && onBorder(a1, a2, b1, b2)) {
            const mi = (a1 + b1) >> 1, mj = (a2 + b2) >> 1;
            face(a1, a2, mi, mj, c1, c2); face(mi, mj, b1, b2, c1, c2);
            return;
          }
        }
      }
      tri(ai, aj, bi, bj, qi, qj);
    };
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const ia = i * step, ib = ia + step, ja = j * step, jb = ja + step;
      // alternate the diagonal so facets don't all lean the same way
      if ((i + j) & 1) {
        face(ia, ja, ia, jb, ib, ja);
        face(ib, ja, ia, jb, ib, jb);
      } else {
        face(ia, ja, ia, jb, ib, jb);
        face(ia, ja, ib, jb, ib, ja);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p < pos.length ? pos.slice(0, p) : pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(p < col.length ? col.slice(0, p) : col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x0, 0, z0);
    mesh.userData.step = step;
    return mesh;
  }
  // Chebyshev ring of a fine chunk about the aircraft's chunk -> grid step.
  const ringOf = (cx, cz) => Math.max(Math.abs(cx - curCx), Math.abs(cz - curCz));
  const stepFor = (cx, cz) => (ringOf(cx, cz) >= LOD_R ? 2 : 1);

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
    for (const key of need) {
      const m = chunks.get(key);
      if (!m) { pending.push(key); continue; }
      if (key.startsWith('n:')) {
        const [ax, az] = key.slice(2).split(',').map(Number);
        m.receiveShadow = ringOf(ax, az) <= SHADOW_R;
        // Wrong LOD: rebuild in place. The old mesh stays up until the new one
        // replaces it, so a swap never opens a hole.
        if (m.userData.step !== stepFor(ax, az)) pending.push(key);
      }
    }
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
        const fine = key.startsWith('n:');
        const [cx, cz] = key.slice(2).split(',').map(Number);
        const old = chunks.get(key);
        if (old && (!fine || old.userData.step === stepFor(cx, cz))) continue;
        // Real-world maps return sea level for tiles that have not arrived, so
        // a coarse chunk built too early bakes a flat plate that never
        // corrects. Defer it (re-queued at the back) until its tiles land.
        if (!force && !fine && map.ready && !map.ready(cx * FAR_CHUNK, cz * FAR_CHUNK, FAR_CHUNK * 0.75)) {
          map.prefetch?.(cx * FAR_CHUNK, cz * FAR_CHUNK, FAR_CHUNK * 0.75);
          pending.push(key);
          continue;
        }
        const mesh = fine ? buildChunk(cx, cz, CHUNK, RES, 0, stepFor(cx, cz))
          : buildChunk(cx, cz, FAR_CHUNK, FAR_RES, FAR_DROP);
        if (fine) mesh.receiveShadow = ringOf(cx, cz) <= SHADOW_R;
        if (old) { scene.remove(old); old.geometry.dispose(); }
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
