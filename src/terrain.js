// Generic chunked-terrain streamer. World-specific data (heightfield, vertex
// colours, runway, scenery) lives in a map module — see src/maps/archipelago.js
// and the FlightMap typedef there. createTerrain() consumes map.height +
// map.color and knows nothing else about the world.

import * as THREE from 'three';
import { CLOUD_SHADOW, CLOUD_SHADOW_GLSL } from './cloudshadow.js';
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

// Merge a few primitives into one indexed geometry with vertex colours and
// smooth normals.
function mergeColored(parts) {
  const pos = [], nor = [], col = [], idx = [];
  for (const [geo, hex, jitter = 0] of parts) {
    geo.computeVertexNormals();
    const c = new THREE.Color(hex), base = pos.length / 3;
    const p = geo.attributes.position, n = geo.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      // a little per-vertex light/dark so a crown reads as clumps of leaves
      const k = 1 + (treeHash(i, p.count, 7) - 0.5) * jitter;
      col.push(c.r * k, c.g * k, c.b * k);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) idx.push(base + geo.index.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  return out;
}

// Lumpy sphere: a crown or a needle tier, displaced so it isn't a ball.
function lumpy(geo, amt, seed) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (treeHash(Math.round(x * 97), Math.round(z * 97), seed + Math.round(y * 53)) - 0.5) * amt;
    p.setXYZ(i, x * k, y * (1 + (k - 1) * 0.5), z * k);
  }
  return geo;
}

// Unit-height trees (base at y=0, top at y=1); instances scale them. Smooth
// shaded, a few hundred triangles at most: thousands are instanced.
function coniferGeometry() {
  const trunk = new THREE.CylinderGeometry(0.03, 0.05, 0.35, 4, 1, true); trunk.translate(0, 0.17, 0);
  const t1 = lumpy(new THREE.ConeGeometry(0.33, 0.42, 7, 1, true), 0.25, 1); t1.translate(0, 0.38, 0);
  const t2 = lumpy(new THREE.ConeGeometry(0.26, 0.38, 7, 1, true), 0.25, 2); t2.translate(0, 0.6, 0);
  const t3 = lumpy(new THREE.ConeGeometry(0.17, 0.34, 6, 1, true), 0.2, 3); t3.translate(0, 0.83, 0);
  return mergeColored([[trunk, 0x5a4232], [t1, 0x2c4a2a, 0.35], [t2, 0x31522e, 0.35], [t3, 0x375a32, 0.3]]);
}
// Lite trees (detail 0): the pre-v10 ~20-triangle shapes, natural colours.
function coniferLite() {
  const trunk = new THREE.CylinderGeometry(0.04, 0.05, 0.3, 4, 1, true); trunk.translate(0, 0.15, 0);
  const lo = new THREE.ConeGeometry(0.3, 0.6, 6, 1, true); lo.translate(0, 0.45, 0);
  const hi = new THREE.ConeGeometry(0.2, 0.45, 5, 1, true); hi.translate(0, 0.77, 0);
  return mergeColored([[trunk, 0x5a4232], [lo, 0x2e4c2b], [hi, 0x355631]]);
}
function broadleafLite() {
  const trunk = new THREE.CylinderGeometry(0.04, 0.06, 0.45, 4, 1, true); trunk.translate(0, 0.225, 0);
  const crown = new THREE.OctahedronGeometry(0.36, 0); crown.scale(1, 0.95, 1); crown.translate(0, 0.68, 0);
  return mergeColored([[trunk, 0x5e4634], [crown, 0x4d6f33]]);
}
function broadleafGeometry() {
  const trunk = new THREE.CylinderGeometry(0.035, 0.06, 0.5, 4, 1, true); trunk.translate(0, 0.25, 0);
  const c1 = lumpy(new THREE.IcosahedronGeometry(0.3, 1), 0.3, 4); c1.translate(0, 0.66, 0);
  const c2 = lumpy(new THREE.IcosahedronGeometry(0.22, 0), 0.3, 5); c2.translate(0.17, 0.58, 0.08);
  const c3 = lumpy(new THREE.IcosahedronGeometry(0.21, 0), 0.3, 6); c3.translate(-0.14, 0.6, -0.12);
  return mergeColored([[trunk, 0x5e4634], [c1, 0x4d6f33, 0.4], [c2, 0x46682f, 0.4], [c3, 0x52763a, 0.4]]);
}

// ---------- Ground shading ----------
// Lambert (one light evaluation, cheap at full screen) with vertex colours
// from the map, plus world-space procedural detail injected into the shader:
//  - macro (~250 m) and mid (~30 m) tone variation so fields and slopes are
//    never one flat swatch, with dry/yellowed patches on vegetation,
//  - fine grain (~3 m) and a bump normal close to the camera,
//  - rock strata on steep faces.
// Everything near-field fades out with distance (and fwidth) so nothing
// shimmers. `far` adds the coarse tier's sink-under-the-fine-tier trick.
// Shared by both ground materials: 1 = full per-pixel detail, 0 = lite
// (per-vertex tone only). main.js drops it when the GPU can't keep up.
export const GROUND_DETAIL = { value: 1 };
const GROUND_NOISE = `
  uniform float uDetail;
  float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float gn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(gh(i), gh(i + vec2(1, 0)), u.x), mix(gh(i + vec2(0, 1)), gh(i + vec2(1, 1)), u.x), u.y); }
  float gfbm(vec2 p){ return gn(p) * 0.57 + gn(p * 2.03 + 17.1) * 0.29 + gn(p * 4.1 + 3.7) * 0.14; }
`;
function terrainMaterial(far) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = GROUND_DETAIL;
    Object.assign(sh.uniforms, CLOUD_SHADOW);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTW; varying vec3 vTN; varying float vMacro;' + GROUND_NOISE)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 tw0 = modelMatrix * vec4(transformed, 1.0);
        ${far ? 'transformed.y -= (1.0 - smoothstep(2500.0, 2950.0, distance(tw0.xz, cameraPosition.xz))) * 250.0;' : ''}
        vTW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTN = normalize(mat3(modelMatrix) * objectNormal);
        vMacro = gfbm(vTW.xz * 0.0042);                 // ~250 m: vertices sample it fine`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTW; varying vec3 vTN; varying float vMacro;' + GROUND_NOISE + CLOUD_SHADOW_GLSL)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        if (uDetail > 0.5) reflectedLight.directDiffuse *= cloudShadow(vTW);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uDetail < 0.5) {
          diffuseColor.rgb *= 1.0 + (vMacro - 0.5) * 0.42;
        } else {
          vec3 c = diffuseColor.rgb;
          float dist = length(vTW - cameraPosition);
          float nearK = 1.0 - smoothstep(80.0, 520.0, dist);
          float midK = 1.0 - smoothstep(900.0, 4200.0, dist);
          float slope = 1.0 - clamp(vTN.y, 0.0, 1.0);
          float veg = smoothstep(0.015, 0.09, c.g - max(c.r, c.b));
          float macro = vMacro;
          float mid = gn(vTW.xz * 0.031 + 5.3) * 0.65 + gn(vTW.xz * 0.07 + 1.3) * 0.35;
          float fine = gn(vTW.xz * 0.42) * 0.6 + gn(vTW.xz * 1.7) * 0.4;
          c *= 1.0 + (macro - 0.5) * 0.42 + (mid - 0.5) * 0.24 * midK + (fine - 0.5) * 0.12 * nearK;
          // sun-dried patches and darker damp hollows on vegetation
          c = mix(c, c * vec3(1.18, 1.06, 0.7), veg * smoothstep(0.55, 0.78, macro) * 0.55);
          c = mix(c, c * vec3(0.78, 0.86, 0.8), veg * smoothstep(0.6, 0.85, mid) * 0.4 * midK);
          // snowfields: bright and unsaturated, so the multiplicative detail above
          // barely survives tone mapping; give them their own structure: bluish
          // wind-packed / shadowed patches, and rock outcrops breaking through on
          // the macro scale (visible from altitude, where a flat white sheet read
          // as paper)
          float snow = smoothstep(0.6, 0.74, min(c.r, min(c.g, c.b))) * (1.0 - veg);
          if (snow > 0.01) {
            c = mix(c, c * vec3(0.8, 0.86, 0.97), snow * smoothstep(0.42, 0.78, mid * 0.6 + macro * 0.4) * 0.65);
            float outcrop = smoothstep(0.66, 0.74, macro * 0.55 + mid * 0.3 + fine * 0.15 * nearK + slope * 0.35);
            c = mix(c, vec3(0.3, 0.29, 0.28), snow * outcrop * 0.85);
          }
          // crags on steep faces: noise projected on the two vertical planes
          // (triplanar minus the top), blended by the surface normal
          float rockK = smoothstep(0.22, 0.5, slope);
          if (rockK > 0.01) {
            vec3 an = abs(vTN);
            float rx = gn(vTW.zy * vec2(0.07, 0.11)) * 0.55 + gn(vTW.zy * 0.38) * 0.45;
            float rz = gn(vTW.xy * vec2(0.07, 0.11) + 7.0) * 0.55 + gn(vTW.xy * 0.38 + 7.0) * 0.45;
            float crag = (rx * an.x + rz * an.z) / (an.x + an.z + 1e-3);
            c = mix(c, c * (0.68 + 0.64 * crag), rockK * 0.7);
          }
          diffuseColor.rgb = c;
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float dist = length(vTW - cameraPosition);
          float bk = (1.0 - smoothstep(60.0, 900.0, dist)) * 0.45;
          if (uDetail > 0.5 && bk > 0.001) {
            vec2 p = vTW.xz;
            float e = 0.6;
            float b0 = gn(p * 0.3);
            float bx = gn((p + vec2(e, 0.0)) * 0.3);
            float bz = gn((p + vec2(0.0, e)) * 0.3);
            vec3 gw = vec3(-(bx - b0), 0.0, -(bz - b0)) * 2.2 * bk;
            normal = normalize(normal + (viewMatrix * vec4(gw, 0.0)).xyz);
          }
        }`);
  };
  m.customProgramCacheKey = () => far ? 'ground-far' : 'ground';
  return m;
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
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const coniferFull = map.forest ? coniferGeometry() : null;
  const broadFull = map.forest ? broadleafGeometry() : null;
  const coniferThin = map.forest ? coniferLite() : null;
  const broadThin = map.forest ? broadleafLite() : null;
  let coniferGeo = coniferFull, broadGeo = broadFull;
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

  // One material per tier instead of one per chunk (shared, disposed once).
  // Both carry the realistic ground shader (terrainShading below): world-space
  // detail noise for grass/soil/rock, rock strata on steep faces, and a bump
  // normal, all faded with distance before it can alias.
  const matFull = terrainMaterial(false);
  const farFull = terrainMaterial(true);
  // Lite coarse tier: plain Lambert plus only the sink-under-the-fine-tier snippet.
  const farLite = new THREE.MeshLambertMaterial({ vertexColors: true });
  farLite.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 fw = modelMatrix * vec4(transformed, 1.0);
      transformed.y -= (1.0 - smoothstep(2500.0, 2950.0, distance(fw.xz, cameraPosition.xz))) * 250.0;`);
  };
  farLite.customProgramCacheKey = () => 'ground-far-lite';
  // Lite (detail 0): plain Lambert for the fine tier, no injected shading at
  // all — on a software rasterizer even an untaken branch costs.
  const matLite = new THREE.MeshLambertMaterial({ vertexColors: true });
  let lite = GROUND_DETAIL.value < 0.5;
  let mat = lite ? matLite : matFull;
  let farMat = lite ? farLite : farFull;

  // Smooth, SEAMLESS chunks: heights are sampled one cell beyond the chunk
  // edge so every vertex normal (central differences) and slope sees the same
  // neighbours as the vertex shared with the next chunk. computeVertexNormals
  // per chunk would light each 600 m tile a little differently at its border.
  const _fc = new THREE.Color();
  function buildChunk(cx, cz, size = CHUNK, res = RES, drop = 0) {
    const x0 = cx * size, z0 = cz * size;
    const n = res + 1, cell = size / res, half = size / 2, m = n + 2;
    const hgt = new Float32Array(m * m);
    for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) {
      hgt[(j + 1) * m + (i + 1)] = heightFn(x0 - half + i * cell, z0 - half + j * cell);
    }
    const H = (i, j) => hgt[(j + 1) * m + (i + 1)];
    const pos = new Float32Array(n * n * 3), nor = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3, h = H(i, j);
      const dx = H(i + 1, j) - H(i - 1, j), dz = H(i, j + 1) - H(i, j - 1);
      const nx = -dx, ny = 2 * cell, nz = -dz, il = 1 / Math.hypot(nx, ny, nz);
      const slope = Math.min(1, Math.hypot(dx, dz) / (2 * cell));
      const lx = -half + i * cell, lz = -half + j * cell;
      colorFn(h, slope, x0 + lx, z0 + lz, _fc);
      pos[k] = lx; pos[k + 1] = h; pos[k + 2] = lz;
      nor[k] = nx * il; nor[k + 1] = ny * il; nor[k + 2] = nz * il;
      col[k] = _fc.r; col[k + 1] = _fc.g; col[k + 2] = _fc.b;
    }
    const idx = new (n * n > 65535 ? Uint32Array : Uint16Array)((n - 1) * (n - 1) * 6);
    let o = 0;
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      // split each quad along the diagonal that follows the terrain better
      if (Math.abs(H(i, j) - H(i + 1, j + 1)) < Math.abs(H(i + 1, j) - H(i, j + 1))) {
        idx[o++] = a; idx[o++] = c; idx[o++] = d; idx[o++] = a; idx[o++] = d; idx[o++] = b;
      } else {
        idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
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
    // The ground under the aircraft first (fine ring of radius 2), then the
    // whole coarse tier — 24 cheap 18x18 meshes that fill the horizon, so a
    // teleport never shows bare fog where the world should be — then the rest
    // of the fine tier, nearest first.
    const rank = (k) => {
      const fine = k.startsWith('n:');
      const [ax, az] = k.slice(2).split(',').map(Number);
      const scale = fine ? 1 : FAR_CHUNK / CHUNK;
      const d = Math.abs(ax * scale - cx) + Math.abs(az * scale - cz);
      if (fine) return (Math.max(Math.abs(ax - cx), Math.abs(az - cz)) <= 2 ? 0 : 20000) + d;
      return 10000 + d;
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
    /**
     * Detail level: 1 full ground shader + full trees, 0 lite (plain Lambert,
     * ~20-triangle trees). Swaps materials on live chunks and regrows trees.
     */
    setDetail(k) {
      const nl = k < 0.5;
      if (nl === lite) return;
      lite = nl;
      mat = lite ? matLite : matFull;
      farMat = lite ? farLite : farFull;
      for (const [key, m] of chunks) m.material = key.startsWith('n:') ? mat : farMat;
      coniferGeo = lite ? coniferThin : coniferFull;
      broadGeo = lite ? broadThin : broadFull;
      for (const g of trees.values()) disposeTrees(g);
      trees.clear(); treePending.length = 0; treeCx = treeCz = null;
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
      for (const m of [matFull, matLite, farFull, farLite]) m.dispose();   // shared: disposed once, at teardown
      chunks.clear();
      pending.length = 0;
      curCx = null; curCz = null;
      for (const g of trees.values()) disposeTrees(g);
      trees.clear(); treePending.length = 0; treeCx = treeCz = null;
      treeMat.dispose();
      for (const g of [coniferFull, broadFull, coniferThin, broadThin]) g?.dispose();
    },
  };
}

// ---------- Back-compat re-exports (removed during integration) ----------
// Untouched callers still import these world-specific names from './terrain.js'.
export { getTerrainHeight, isRunway, RUNWAY, createAirfield } from './maps/archipelago.js';
