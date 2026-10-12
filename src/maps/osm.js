// OpenStreetMap scenery for the real-world airfields: buildings, airport
// pavement, roads, lakes and land cover, fetched once per map load from the
// Overpass API (keyless, CORS) and turned into plain data here. NO THREE and
// NO DOM, so the node tests can feed it an Overpass JSON fixture.
//
// Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
// The map shows that attribution whenever OSM scenery is on screen.
//
// What uses what:
//   landCover(x, z)   -> class code from a 16 m raster: terrain colour and
//                        forests (map.color / map.forest) in realworld.js
//   flatten(x, z)     -> airport pavement level, so aprons/taxiways sit flat
//   obstacleTop(x, z) -> building roofs for collision
//   buildings / lines / areas / runways / lakes -> meshes (osmMeshes.js)
//
// Everything that changes height(), color() or forest() only applies when the
// data arrived BEFORE terrain was built (`commit()` in realworld.js); data
// that arrives later only adds buildings, so render and collision never
// disagree.

import { lonToPx, latToPy } from './tilesampler.js';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

// land-cover classes (raster codes)
export const LC = { NONE: 0, FOREST: 1, URBAN: 2, FARM: 3, GRASS: 4, WATER: 5, ROCK: 6, ICE: 7, SAND: 8, SCRUB: 9, PAVED: 10, INDUSTRIAL: 11 };

const LANDUSE = {
  forest: LC.FOREST, orchard: LC.FARM, vineyard: LC.FARM, farmland: LC.FARM, farmyard: LC.FARM, allotments: LC.FARM,
  meadow: LC.GRASS, grass: LC.GRASS, recreation_ground: LC.GRASS, cemetery: LC.GRASS, village_green: LC.GRASS,
  residential: LC.URBAN, commercial: LC.URBAN, retail: LC.URBAN, industrial: LC.INDUSTRIAL, railway: LC.INDUSTRIAL,
  construction: LC.INDUSTRIAL, quarry: LC.ROCK, reservoir: LC.WATER, basin: LC.WATER,
};
const NATURAL = {
  wood: LC.FOREST, scrub: LC.SCRUB, heath: LC.SCRUB, grassland: LC.GRASS, water: LC.WATER, wetland: LC.GRASS,
  bare_rock: LC.ROCK, scree: LC.ROCK, glacier: LC.ICE, beach: LC.SAND, sand: LC.SAND,
};
const LEISURE = { park: LC.GRASS, golf_course: LC.GRASS, pitch: LC.GRASS, garden: LC.GRASS, nature_reserve: LC.NONE };
const ROAD_WIDTH = { motorway: 22, trunk: 17, primary: 12, secondary: 9, tertiary: 7, motorway_link: 7, trunk_link: 7, primary_link: 7 };

/** Bounding box (s, w, n, e) of a square of `r` metres around lat/lon. */
export function bbox(lat, lon, r) {
  const dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(v => +v.toFixed(5)).join(',');
}

/** The one Overpass query a map load makes: buildings close in, land cover wide. */
export function overpassQuery(lat, lon, { buildings = 2800, pavement = 4500, roads = 6000, cover = 7000 } = {}) {
  const B = bbox(lat, lon, buildings), A = bbox(lat, lon, pavement), R = bbox(lat, lon, roads), L = bbox(lat, lon, cover);
  return `[out:json][timeout:45][maxsize:120000000];
(
  way["building"](${B});
  relation["building"]["type"="multipolygon"](${B});
  way["aeroway"~"^(runway|taxiway|apron|terminal|hangar)$"](${A});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link)$"](${R});
  way["landuse"](${L});
  way["natural"~"^(wood|scrub|heath|grassland|water|wetland|bare_rock|scree|glacier|beach|sand)$"](${L});
  way["leisure"~"^(park|golf_course|pitch|garden)$"](${L});
  relation["landuse"]["type"="multipolygon"](${L});
  relation["natural"~"^(wood|water|scrub|glacier|bare_rock)$"]["type"="multipolygon"](${L});
);
out geom(${L});`;
}

/** lat/lon -> world metres (x = East, z = South) in the map's own linearised Web Mercator. */
export function makeLL(proj) {
  const wpx = proj.worldPx, mpp = proj.mpp;
  return (lat, lon) => [(lonToPx(lon, wpx) - proj.gpx0) * mpp, (latToPy(lat, wpx) - proj.gpy0) * mpp];
}

const num = (v) => { if (v == null) return NaN; const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
function hash32(n) { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0; }

export function ringArea(r) {          // signed, shoelace (x, z)
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

function toPts(geom, ll) {
  const out = [];
  for (const g of geom || []) if (g && Number.isFinite(g.lat)) out.push(ll(g.lat, g.lon));
  return out;
}

function closeRing(pts) {
  if (pts.length > 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01) pts.pop();
  }
  return pts.length >= 3 ? pts : null;
}

/** Join a relation's outer member ways (in any order/direction) into closed rings. */
export function joinRings(ways) {
  const left = ways.filter(w => w.length >= 2).map(w => w.slice());
  const rings = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05;
  while (left.length) {
    let ring = left.shift();
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const w = left[i], end = ring[ring.length - 1];
        if (same(end, w[0])) ring = ring.concat(w.slice(1));
        else if (same(end, w[w.length - 1])) ring = ring.concat(w.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1); grew = true; break;
      }
    }
    const r = closeRing(ring);          // clipped (open) rings close with a chord
    if (r) rings.push(r);
  }
  return rings;
}

function buildingHeight(tags, id) {
  const h = num(tags.height);
  const lv = num(tags['building:levels']);
  const roofH = num(tags['roof:height']);
  const minH = num(tags.min_height) || (num(tags['building:min_level']) * 3.2) || 0;
  let height;
  if (Number.isFinite(h) && h > 1) height = h;
  else if (Number.isFinite(lv) && lv > 0) height = lv * 3.2 + (Number.isFinite(roofH) ? roofH : 0.6);
  else {
    const kind = tags.building, a = tags.aeroway;
    const base = a === 'terminal' ? 18 : a === 'hangar' || kind === 'hangar' ? 13
      : kind === 'house' || kind === 'detached' || kind === 'semidetached_house' || kind === 'bungalow' ? 6.5
      : kind === 'garage' || kind === 'garages' || kind === 'shed' || kind === 'roof' || kind === 'carport' ? 3
      : kind === 'apartments' || kind === 'residential' ? 13 : kind === 'industrial' || kind === 'warehouse' ? 9
      : kind === 'commercial' || kind === 'office' || kind === 'retail' ? 12 : kind === 'church' ? 16 : 7;
    height = base * (0.85 + 0.3 * (hash32(id) / 4294967296));
  }
  return { height: Math.min(Math.max(height, 2.5), 600), minHeight: Math.max(0, Math.min(minH || 0, height - 1)) };
}

// what the facade shader should draw: 0 = glass curtain wall, 1 = punched windows, 2 = plain (sheds, hangars)
function facadeKind(tags, height) {
  const k = tags.building;
  if (k === 'hangar' || tags.aeroway === 'hangar' || k === 'garage' || k === 'garages' || k === 'shed' || k === 'roof' || k === 'industrial' || k === 'warehouse') return 2;
  if (height > 40 && (k === 'commercial' || k === 'office' || k === 'yes')) return 0;
  return 1;
}
const WALLS = [0xd8d2c4, 0xc9c3b8, 0xe2ddd2, 0xb9b4ab, 0xcfc6b4, 0xd6cfc3, 0xa9a8a4, 0xe8e4dc];
const WALLS_PLAIN = [0xb4b8bb, 0x9ea4a8, 0xc4c6c4, 0x8f979c];
function wallColour(tags, id, kind) {
  const c = tags['building:colour'];
  if (c && /^#[0-9a-f]{6}$/i.test(c)) return parseInt(c.slice(1), 16);
  const set = kind === 2 ? WALLS_PLAIN : WALLS;
  return set[hash32(id + 17) % set.length];
}

/**
 * Overpass JSON -> plain scenery data in world metres.
 * @returns {{ buildings, areas, lines, runways }}
 */
export function parseOverpass(json, ll) {
  const buildings = [], areas = [], lines = [], runways = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    let rings;
    if (el.type === 'way') {
      const pts = toPts(el.geometry, ll);
      const closed = el.geometry && el.geometry.length > 3 && el.geometry[0] && el.geometry[el.geometry.length - 1]
        && el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat && el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon;
      // linear features first
      if (t.highway && ROAD_WIDTH[t.highway] && !closed) {
        if (pts.length >= 2) lines.push({ kind: 'road', pts, width: num(t.width) || ROAD_WIDTH[t.highway], cls: t.highway, bridge: t.bridge === 'yes', tunnel: t.tunnel === 'yes' });
        continue;
      }
      if (t.aeroway === 'runway' && !closed) {
        if (pts.length >= 2) runways.push({ a: pts[0], b: pts[pts.length - 1], width: num(t.width) || 45, ref: t.ref || '' });
        continue;
      }
      if (t.aeroway === 'taxiway' && !closed) {
        if (pts.length >= 2) lines.push({ kind: 'taxiway', pts, width: Math.min(num(t.width) || 20, 40) });
        continue;
      }
      if (!closed) continue;
      const r = closeRing(pts);
      rings = r ? [r] : [];
    } else if (el.type === 'relation') {
      const outer = (el.members || []).filter(m => m.type === 'way' && (m.role === 'outer' || m.role === '')).map(m => toPts(m.geometry, ll));
      rings = joinRings(outer);
    } else continue;

    for (const ring of rings) {
      const a = ringArea(ring);
      if (Math.abs(a) < 6) continue;
      if (a < 0) ring.reverse();                       // CCW in (x, z)
      if (t.building || t.aeroway === 'terminal' || t.aeroway === 'hangar') {
        if (t.building === 'no' || t.building === 'construction') continue;
        const { height, minHeight } = buildingHeight(t, el.id);
        const kind = facadeKind(t, height);
        buildings.push({ ring, height, minHeight, kind, colour: wallColour(t, el.id, kind), id: el.id,
          roof: t['roof:shape'] || (height < 9 && (t.building === 'house' || t.building === 'detached') ? 'gabled' : 'flat') });
        continue;
      }
      if (t.aeroway === 'apron' || t.aeroway === 'taxiway' || t.aeroway === 'runway') { areas.push({ cls: LC.PAVED, ring, area: Math.abs(a), id: el.id, aeroway: t.aeroway }); continue; }
      const cls = t.landuse != null ? LANDUSE[t.landuse] : t.natural != null ? NATURAL[t.natural] : t.leisure != null ? LEISURE[t.leisure] : undefined;
      if (cls === undefined || cls === LC.NONE) continue;
      areas.push({ cls, ring, area: Math.abs(a), id: el.id });
    }
  }
  return { buildings, areas, lines, runways };
}

// ---------------- rasters + spatial indices ----------------

/** Even-odd scanline fill of a ring into a grid (cell centres). */
function fillRing(grid, n, cell, half, ring, fn) {
  let z0 = Infinity, z1 = -Infinity;
  for (const p of ring) { if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; }
  const j0 = Math.max(0, Math.ceil((z0 + half) / cell - 0.5)), j1 = Math.min(n - 1, Math.floor((z1 + half) / cell - 0.5));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = (j + 0.5) * cell - half;
    xs.length = 0;
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const a = ring[k], b = ring[i];
      if ((a[1] <= z) !== (b[1] <= z)) xs.push(a[0] + (z - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      const i0 = Math.max(0, Math.ceil((xs[m] + half) / cell - 0.5)), i1 = Math.min(n - 1, Math.floor((xs[m + 1] + half) / cell - 0.5));
      for (let i = i0; i <= i1; i++) fn(j * n + i);
    }
  }
}

/** Point in polygon (even-odd). */
export function inRing(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/**
 * Turn parsed data into the queryable world: land-cover raster (+ a per-field
 * tone byte for farmland patchwork), pavement mask, building obstacle grid.
 */
export function buildOsmWorld(data, { half = 8192, cell = 16 } = {}) {
  const n = Math.round(2 * half / cell);
  const cover = new Uint8Array(n * n), tone = new Uint8Array(n * n);
  // big polygons first so smaller ones (a wood inside farmland) win; water and
  // pavement painted last because they are the ones that must be exact
  const order = data.areas.slice().sort((a, b) =>
    (a.cls === LC.WATER || a.cls === LC.PAVED) - (b.cls === LC.WATER || b.cls === LC.PAVED) || b.area - a.area);
  for (const ar of order) {
    const tn = hash32(ar.id) & 255;
    fillRing(cover, n, cell, half, ar.ring, (k) => { cover[k] = ar.cls; tone[k] = tn; });
  }
  // taxiway centrelines rasterised at their width as pavement
  for (const l of data.lines) {
    if (l.kind !== 'taxiway') continue;
    stampLine(l.pts, l.width / 2 + 4, cell, half, n, (k) => { cover[k] = LC.PAVED; });
  }
  for (const rw of data.runways) stampLine([rw.a, rw.b], rw.width / 2 + 10, cell, half, n, (k) => { cover[k] = LC.PAVED; });
  for (const b of data.buildings) fillRing(cover, n, cell, half, b.ring, (k) => { if (cover[k] === LC.NONE || cover[k] === LC.GRASS || cover[k] === LC.FARM) cover[k] = LC.URBAN; });

  // building obstacle grid: 64 m cells holding building indices
  const BC = 64, bn = Math.round(2 * half / BC);
  const bgrid = new Map();
  data.buildings.forEach((b, idx) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of b.ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    b.box = [x0, x1, z0, z1];
    for (let i = Math.floor((x0 + half) / BC); i <= Math.floor((x1 + half) / BC); i++) {
      for (let j = Math.floor((z0 + half) / BC); j <= Math.floor((z1 + half) / BC); j++) {
        if (i < 0 || j < 0 || i >= bn || j >= bn) continue;
        const k = j * bn + i;
        let arr = bgrid.get(k); if (!arr) bgrid.set(k, arr = []);
        arr.push(idx);
      }
    }
  });

  const at = (x, z) => {
    const i = Math.floor((x + half) / cell), j = Math.floor((z + half) / cell);
    return (i < 0 || j < 0 || i >= n || j >= n) ? -1 : j * n + i;
  };
  return {
    n, cell, half, cover, tone,
    landCover(x, z) { const k = at(x, z); return k < 0 ? LC.NONE : cover[k]; },
    fieldTone(x, z) { const k = at(x, z); return k < 0 ? 0 : tone[k]; },
    /** Building index under (x, z), or -1. */
    buildingAt(x, z) {
      const i = Math.floor((x + half) / BC), j = Math.floor((z + half) / BC);
      const arr = bgrid.get(j * bn + i);
      if (!arr) return -1;
      for (const idx of arr) {
        const b = data.buildings[idx], [x0, x1, z0, z1] = b.box;
        if (x >= x0 && x <= x1 && z >= z0 && z <= z1 && inRing(b.ring, x, z)) return idx;
      }
      return -1;
    },
  };
}

function stampLine(pts, r, cell, half, n, fn) {
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, az] = pts[s], [bx, bz] = pts[s + 1];
    const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
    for (let k = 0; k <= steps; k++) {
      const x = ax + (bx - ax) * k / steps, z = az + (bz - az) * k / steps;
      const rc = Math.ceil(r / cell);
      const ci = Math.floor((x + half) / cell), cj = Math.floor((z + half) / cell);
      for (let dj = -rc; dj <= rc; dj++) for (let di = -rc; di <= rc; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const cx = (i + 0.5) * cell - half, cz = (j + 0.5) * cell - half;
        if ((cx - x) ** 2 + (cz - z) ** 2 <= r * r) fn(j * n + i);
      }
    }
  }
}

/**
 * Fetch + parse with a timeout. Resolves null on any failure (offline,
 * blocked, rate limited). GET, so the Cache API can keep the answer: a second
 * visit to the same field loads its scenery instantly and offline.
 */
export async function fetchOsm(lat, lon, ll, { timeoutMs = 60000, url = OVERPASS_URL, fetchFn = globalThis.fetch } = {}) {
  const req = url + '?data=' + encodeURIComponent(overpassQuery(lat, lon));
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  let cache = null;
  try {
    try { cache = globalThis.caches ? await globalThis.caches.open('archipelago-osm-v1') : null; } catch { cache = null; }
    let res = null;
    if (cache) { try { res = await cache.match(req); } catch { res = null; } }
    if (!res) {
      res = await fetchFn(req, { mode: 'cors', signal: ctl?.signal });
      if (!res.ok) return null;
      if (cache) { try { await cache.put(req, res.clone()); } catch { /* quota: just don't cache */ } }
    }
    return parseOverpass(await res.json(), ll);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
