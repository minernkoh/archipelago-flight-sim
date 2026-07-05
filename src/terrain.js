// Generic chunked-terrain streamer. World-specific data (heightfield, vertex
// colours, runway, scenery) lives in a map module — see src/maps/archipelago.js
// and the FlightMap typedef there. createTerrain() consumes map.height +
// map.color and knows nothing else about the world.

import * as THREE from 'three';
import { archipelagoMap } from './maps/archipelago.js';

// ---------- Chunked mesh streaming ----------
const CHUNK = 600, RES = 36, VIEW_R = 5; // 11x11 chunks ~ 6.6 km square

export function createTerrain(scene, map = archipelagoMap) {
  const heightFn = map.height;
  const colorFn = map.color;

  const chunks = new Map(); // "cx,cz" -> mesh
  const pending = [];
  let curCx = null, curCz = null;

  function buildChunk(cx, cz) {
    const geo = new THREE.PlaneGeometry(CHUNK, CHUNK, RES, RES);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (let i = 0; i < pos.count; i++) {
      const wx = x0 + pos.getX(i), wz = z0 + pos.getZ(i);
      const h = heightFn(wx, wz);
      pos.setY(i, h);
      // cheap slope estimate
      const hx = heightFn(wx + 8, wz), hz = heightFn(wx, wz + 8);
      const slope = Math.min(1, Math.hypot(h - hx, h - hz) / 8);
      colorFn(h, slope, wx, wz, c);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x0, 0, z0);
    return mesh;
  }

  function want(px, pz) {
    const cx = Math.round(px / CHUNK), cz = Math.round(pz / CHUNK);
    if (cx === curCx && cz === curCz) return;
    curCx = cx; curCz = cz;
    const need = new Set();
    for (let i = -VIEW_R; i <= VIEW_R; i++)
      for (let j = -VIEW_R; j <= VIEW_R; j++)
        need.add(`${cx + i},${cz + j}`);
    for (const key of chunks.keys()) {
      if (!need.has(key)) {
        const m = chunks.get(key);
        scene.remove(m); m.geometry.dispose(); m.material.dispose();
        chunks.delete(key);
      }
    }
    pending.length = 0;
    for (const key of need) if (!chunks.has(key)) pending.push(key);
    // build nearest first
    pending.sort((a, b) => {
      const [ax, az] = a.split(','), [bx, bz] = b.split(',');
      return (Math.abs(ax - cx) + Math.abs(az - cz)) - (Math.abs(bx - cx) + Math.abs(bz - cz));
    });
  }

  return {
    // Call each frame; builds a couple of chunks per call to avoid hitches.
    update(px, pz, budget = 2) {
      want(px, pz);
      for (let n = 0; n < budget && pending.length; n++) {
        const key = pending.shift();
        if (chunks.has(key)) continue;
        const [cx, cz] = key.split(',').map(Number);
        const mesh = buildChunk(cx, cz);
        chunks.set(key, mesh);
        scene.add(mesh);
      }
    },
    pendingCount: () => pending.length,
    prime(px, pz) { want(px, pz); }, // fill pending list without building
    // Tear down every chunk and reset streaming state so the next update()
    // rebuilds from scratch (used when swapping maps).
    disposeAll() {
      for (const m of chunks.values()) {
        scene.remove(m); m.geometry.dispose(); m.material.dispose();
      }
      chunks.clear();
      pending.length = 0;
      curCx = null; curCz = null;
    },
  };
}

// ---------- Back-compat re-exports (removed during integration) ----------
// Untouched callers still import these world-specific names from './terrain.js'.
export { getTerrainHeight, isRunway, RUNWAY, createAirfield } from './maps/archipelago.js';
