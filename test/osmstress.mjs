// Stress test for the OSM pipeline: a SYNTHETIC dense city (not real data) of
// N buildings in the Overpass JSON shape, timed through parse -> land-cover
// raster -> meshes in Node. `node test/osmstress.mjs [buildings]`.
// Also exports makeCity() so the browser probe can serve the same city.
import { parseOverpass, buildOsmWorld, makeLL } from '../src/maps/osm.js';
import { buildingMeshes, groundMeshes } from '../src/maps/osmMeshes.js';
import { makeProjection } from '../src/maps/tilesampler.js';

export function makeCity(lat, lon, N = 40000, R = 2800) {
  let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  const k = 1 / (111320 * Math.cos(lat * Math.PI / 180));
  const P = (x, z) => ({ lat: lat - z / 111320, lon: lon + x * k });
  const els = []; let id = 1;
  while (els.length < N) {
    const x = (rnd() * 2 - 1) * R, z = (rnd() * 2 - 1) * R;
    if (Math.abs(z) < 400 || x * x + z * z > R * R) continue;     // keep the runway strip clear
    const w = 8 + rnd() * 30, d = 8 + rnd() * 20, a = rnd() * Math.PI;
    const c = Math.cos(a), sn = Math.sin(a);
    const pts = [[-w, -d], [w, -d], [w, d], [-w, d]].map(([u, v]) => P(x + (u * c - v * sn) / 2, z + (u * sn + v * c) / 2));
    pts.push(pts[0]);
    const tags = rnd() < 0.5 ? { building: 'house' } : { building: 'apartments', 'building:levels': String(2 + Math.floor(rnd() * 20)) };
    els.push({ type: 'way', id: id++, tags, geometry: pts });
  }
  for (let i = 0; i < 1500; i++) {                                   // a road grid
    const x0 = (rnd() * 2 - 1) * 6000, z0 = (rnd() * 2 - 1) * 6000, h = rnd() < 0.5;
    const pts = []; for (let j = 0; j < 8; j++) pts.push(P(x0 + (h ? j * 120 : 0), z0 + (h ? 0 : j * 120)));
    els.push({ type: 'way', id: id++, tags: { highway: rnd() < 0.1 ? 'primary' : 'tertiary' }, geometry: pts });
  }
  for (let i = 0; i < 600; i++) {                                    // land-use blocks
    const x = (rnd() * 2 - 1) * 6500, z = (rnd() * 2 - 1) * 6500, w = 150 + rnd() * 500;
    const pts = [[0, 0], [w, 0], [w, w * 0.7], [0, w * 0.7]].map(([u, v]) => P(x + u, z + v)); pts.push(pts[0]);
    els.push({ type: 'way', id: id++, tags: rnd() < 0.4 ? { landuse: 'residential' } : rnd() < 0.6 ? { landuse: 'forest' } : { landuse: 'farmland' }, geometry: pts });
  }
  return { elements: els };
}

if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  const N = +(process.argv[2] || 40000);
  const lat = 37.6189, lon = -122.375;
  const json = makeCity(lat, lon, N);
  const bytes = JSON.stringify(json).length;
  const ll = makeLL(makeProjection(lat, lon, 12));
  const t = (label, f) => { const t0 = performance.now(); const r = f(); console.log(label.padEnd(18), (performance.now() - t0).toFixed(0).padStart(6), 'ms'); return r; };
  const parsed = t('JSON.parse', () => JSON.parse(JSON.stringify(json)));
  const data = t('parseOverpass', () => parseOverpass(parsed, ll));
  t('buildOsmWorld', () => buildOsmWorld(data));
  const bm = t('buildingMeshes', () => buildingMeshes(data.buildings, () => 4));
  t('groundMeshes', () => groundMeshes(data, { heightFn: () => 4, elev: 4, flat: true, lakeLevel: () => 0, skipRunway: () => false }));
  let tris = 0; bm.traverse(m => { if (m.isMesh) tris += m.geometry.attributes.position.count / 3; });
  console.log(`${data.buildings.length} buildings, ${(bytes / 1e6).toFixed(1)} MB JSON, ${bm.children.length} draw calls, ${(tris / 1e3).toFixed(0)}k triangles`);
}
