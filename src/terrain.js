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

export function createTerrain(scene, map = archipelagoMap) {
  const heightFn = map.height;
  const colorFn = map.color;

  const chunks = new Map(); // "n:cx,cz" | "f:cx,cz" -> mesh
  const pending = [];
  let curCx = null, curCz = null;
  let farOn = true;

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
    },
    /** Coarse tier off = the old single-tier behaviour (quality: LOW). */
    setFarTier(on) { farOn = !!on; curCx = null; curCz = null; },
    counts() {
      let fine = 0, coarse = 0;
      for (const k of chunks.keys()) k.startsWith('n:') ? fine++ : coarse++;
      return { fine, coarse };
    },
    pendingCount: () => pending.length,
    prime(px, pz) { want(px, pz); }, // fill pending list without building
    // Tear down every chunk and reset streaming state so the next update()
    // rebuilds from scratch (used when swapping maps).
    disposeAll() {
      for (const m of chunks.values()) { scene.remove(m); m.geometry.dispose(); }
      mat.dispose(); farMat.dispose();   // shared: disposed once, at teardown
      chunks.clear();
      pending.length = 0;
      curCx = null; curCz = null;
    },
  };
}

// ---------- Back-compat re-exports (removed during integration) ----------
// Untouched callers still import these world-specific names from './terrain.js'.
export { getTerrainHeight, isRunway, RUNWAY, createAirfield } from './maps/archipelago.js';
