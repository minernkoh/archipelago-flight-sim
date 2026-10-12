// Writes overpass-changi.json: a HAND-WRITTEN test fixture in Overpass JSON
// format (out geom), laid out around the sim's Changi runway. It is not real
// OpenStreetMap data; it exists so the OSM pipeline (osm.js, osmMeshes.js,
// realworld.js) can be tested without network access. Regenerate with
// `node test/fixtures/make-osm-fixture.mjs`.
import { writeFileSync } from 'node:fs';

const LAT = 1.3592, LON = 103.9894, H = (90 - 23) * Math.PI / 180;
const fwd = [Math.cos(H), -Math.sin(H)], right = [Math.sin(H), Math.cos(H)];
// runway frame (along, across) metres -> lat/lon
const at = (u, v) => {
  const x = fwd[0] * u + right[0] * v, z = fwd[1] * u + right[1] * v;
  return { lat: +(LAT - z / 111320).toFixed(7), lon: +(LON + x / (111320 * Math.cos(LAT * Math.PI / 180))).toFixed(7) };
};
let id = 1000;
const els = [];
const way = (tags, pts, close = true) => {
  const g = pts.map(([u, v]) => at(u, v));
  if (close) g.push(g[0]);
  els.push({ type: 'way', id: id++, tags, geometry: g });
};
const rect = (u, v, w, d) => [[u - w / 2, v - d / 2], [u + w / 2, v - d / 2], [u + w / 2, v + d / 2], [u - w / 2, v + d / 2]];

// buildings east of the field: a street of houses, flats with levels, a glass
// office tower with a height tag, a terminal and a hangar
for (let i = 0; i < 12; i++) way({ building: 'house' }, rect(-600 + i * 22, 900, 12, 9));
for (let i = 0; i < 6; i++) way({ building: 'apartments', 'building:levels': String(10 + i * 2) }, rect(-400 + i * 70, 1000, 40, 14));
way({ building: 'office', height: '62 m' }, rect(200, 1020, 36, 36));
way({ building: 'yes', aeroway: 'terminal' }, rect(-200, 620, 260, 70));
way({ building: 'hangar' }, rect(350, 600, 60, 45));
// a multipolygon building whose outline is split over two member ways
{
  const ring = rect(500, 1000, 50, 30).map(([u, v]) => at(u, v));
  els.push({ type: 'relation', id: id++, tags: { type: 'multipolygon', building: 'retail', 'building:levels': '3' },
    members: [
      { type: 'way', ref: id++, role: 'outer', geometry: [ring[0], ring[1], ring[2]] },
      { type: 'way', ref: id++, role: 'outer', geometry: [ring[0], ring[3], ring[2]] },   // reversed half
    ] });
}
// airport: apron, a taxiway from the runway to it, a parallel runway
way({ aeroway: 'apron' }, rect(0, 470, 700, 160));
way({ aeroway: 'taxiway', ref: 'A' }, [[0, 0], [0, 200], [0, 390]], false);
way({ aeroway: 'taxiway', ref: 'B' }, [[-1500, 200], [1500, 200]], false);
way({ aeroway: 'runway', ref: '02R/20L', width: '60' }, [[-1500, 1650], [1500, 1650]], false);
// the sim's own runway is in the data too and must not be drawn twice
way({ aeroway: 'runway', ref: '02L/20R', width: '60' }, [[-2000, 0], [2000, 0]], false);
// roads, one of them a bridge
way({ highway: 'primary', name: 'Airport Boulevard' }, [[-2500, 1300], [0, 1250], [2500, 1300]], false);
way({ highway: 'motorway', bridge: 'yes' }, [[-3000, 2200], [3000, 2400]], false);
// land cover west of the field
way({ landuse: 'forest' }, rect(0, -1600, 1400, 600));
for (let i = 0; i < 4; i++) way({ landuse: 'farmland' }, rect(-1800 + i * 260, -900, 240, 300));
way({ landuse: 'residential' }, rect(-200, 950, 1200, 250));
way({ natural: 'water' }, rect(1800, -1500, 500, 300));

writeFileSync(new URL('./overpass-changi.json', import.meta.url),
  JSON.stringify({ _note: 'Hand-written test fixture in Overpass JSON format. Not real OpenStreetMap data.', version: 0.6, elements: els }, null, 0));
console.log(els.length, 'elements');
