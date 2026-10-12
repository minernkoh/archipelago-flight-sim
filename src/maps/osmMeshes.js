// Meshes for the OpenStreetMap scenery (data from osm.js). Everything is
// merged into a handful of draw calls per ~1 km tile so the whole town costs
// little more than one building would; the facade shader from sgLandmarks.js
// draws windows (and lights them at night) without any textures.

import * as THREE from 'three';
import { facade } from './sgLandmarks.js';
import { runwayDressing } from './runwayPaint.js';
import { LC } from './osm.js';

const TILE = 1024;
const decal = (color, units = -8) => new THREE.MeshLambertMaterial({
  color, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: units,
});

/** Growable float arrays for non-indexed triangle soup with colours. */
class Soup {
  constructor() { this.p = []; this.n = []; this.c = []; }
  tri(a, b, c, col, nrm) {
    let nx, ny, nz;
    if (nrm) [nx, ny, nz] = nrm;
    else {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    }
    for (const v of [a, b, c]) { this.p.push(v[0], v[1], v[2]); this.n.push(nx, ny, nz); this.c.push(col.r, col.g, col.b); }
  }
  quad(a, b, c, d, col, nrm) { this.tri(a, b, c, col, nrm); this.tri(a, c, d, col, nrm); }
  geometry() {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const ROOFS_FLAT = [0x6d6e6c, 0x7d7b76, 0x5f6163, 0x8a8781, 0x9a978f];
const ROOFS_TILE = [0x8e4f3c, 0x7a4636, 0x5c5a5a, 0x6b4a3d, 0x4f5559];
const tmpC = new THREE.Color();

/**
 * Buildings: extruded walls + flat or gabled roofs. Ground level per building
 * = the lowest terrain under its outline, so nothing floats on a slope; the
 * walls start a metre under it. Sets b.base / b.top (used for collision).
 */
export function buildingMeshes(buildings, heightFn) {
  const tiles = new Map();
  const soupFor = (b, key) => {
    const tk = Math.floor(b.ring[0][0] / TILE) + ',' + Math.floor(b.ring[0][1] / TILE);
    let t = tiles.get(tk); if (!t) tiles.set(tk, t = { glass: new Soup(), punched: new Soup(), plain: new Soup(), roof: new Soup() });
    return t[key];
  };
  for (const b of buildings) {
    const ring = b.ring;
    let gMin = Infinity, gSum = 0;
    for (const p of ring) { const h = heightFn(p[0], p[1]); gMin = Math.min(gMin, h); gSum += h; }
    const gMean = gSum / ring.length;
    if (gMean < -0.5) continue;                                   // mapped over water (piers, ships): skip
    b.base = gMin + b.minHeight;
    b.top = gMean + b.height;
    const y0 = b.minHeight > 0 ? b.base : gMin - 1, y1 = b.top;
    const wallCol = tmpC.setHex(b.colour).clone();
    const walls = soupFor(b, b.kind === 0 ? 'glass' : b.kind === 1 ? 'punched' : 'plain');
    // gabled roof only for simple four-cornered houses
    const gabled = b.roof === 'gabled' && ring.length === 4;
    const eave = gabled ? y1 - Math.min(3, b.height * 0.35) : y1;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      // CCW ring in (x, z) with +z south: outward normal is (dz, -dx)
      const dx = c[0] - a[0], dz = c[1] - a[1], l = Math.hypot(dx, dz) || 1;
      const nrm = [dz / l, 0, -dx / l];
      walls.quad([a[0], y0, a[1]], [a[0], eave, a[1]], [c[0], eave, c[1]], [c[0], y0, c[1]], wallCol, nrm);
    }
    const roofCol = tmpC.setHex((gabled ? ROOFS_TILE : ROOFS_FLAT)[(b.id >>> 3) % 5]).clone();
    const roof = soupFor(b, 'roof');
    if (gabled) {
      // ridge along the longer axis, over the midpoints of the two short sides
      const e = (i) => Math.hypot(ring[(i + 1) % 4][0] - ring[i][0], ring[(i + 1) % 4][1] - ring[i][1]);
      const s = e(0) < e(1) ? 0 : 1;                                // short sides s and s+2
      const mid = (i) => [(ring[i][0] + ring[(i + 1) % 4][0]) / 2, (ring[i][1] + ring[(i + 1) % 4][1]) / 2];
      const r0 = mid(s), r1 = mid(s + 2);
      const R0 = [r0[0], y1, r0[1]], R1 = [r1[0], y1, r1[1]];
      const P = (i) => [ring[i % 4][0], eave, ring[i % 4][1]];
      // two slopes + two gable ends (gable ends in the wall colour)
      roof.quad(P(s + 1), P(s + 2), R1, R0, roofCol);
      roof.quad(P(s + 3), P(s + 4), R0, R1, roofCol);
      walls.tri(P(s), P(s + 1), R0, wallCol);
      walls.tri(P(s + 2), P(s + 3), R1, wallCol);
    } else {
      const contour = ring.map(p => new THREE.Vector2(p[0], p[1]));
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { tris = []; }
      for (const [i, j, k] of tris) {
        roof.tri([ring[i][0], y1, ring[i][1]], [ring[k][0], y1, ring[k][1]], [ring[j][0], y1, ring[j][1]], roofCol, [0, 1, 0]);
      }
    }
  }
  const mats = {
    glass: facade(new THREE.MeshLambertMaterial({ vertexColors: true }), 0),
    punched: facade(new THREE.MeshLambertMaterial({ vertexColors: true }), 1),
    plain: new THREE.MeshLambertMaterial({ vertexColors: true }),
    roof: new THREE.MeshLambertMaterial({ vertexColors: true }),
  };
  const g = new THREE.Group();
  g.name = 'osm-buildings';
  for (const t of tiles.values()) {
    for (const k of Object.keys(mats)) {
      const geo = t[k].geometry();
      if (!geo) continue;
      const m = new THREE.Mesh(geo, mats[k]);
      m.castShadow = k !== 'roof'; m.receiveShadow = true;
      g.add(m);
    }
  }
  return g;
}

/** Draped ribbon along a polyline (roads, taxiways): `lift` metres above heightFn. */
function ribbon(soup, pts, half, yAt, col) {
  // densify so the ribbon follows the ground between sparse OSM nodes
  const P = [];
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, az] = pts[s], [bx, bz] = pts[s + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 20));
    for (let k = 0; k < n; k++) P.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  P.push(pts[pts.length - 1]);
  const up = [0, 1, 0];
  let prevL = null, prevR = null;
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const y = yAt(P[i][0], P[i][1]);
    const L = [P[i][0] + dz * half, y, P[i][1] - dx * half], R = [P[i][0] - dz * half, y, P[i][1] + dx * half];
    if (prevL) soup.quad(prevL, L, R, prevR, col, up);
    prevL = L; prevR = R;
  }
}

/**
 * Airport pavement + roads + the airport's other runways + lakes.
 * `flat` = the terrain was flattened under pavement (data committed before the
 * terrain was built); pavement and lakes only draw then, roads always do.
 */
export function groundMeshes(data, { heightFn, elev, flat, skipRunway, lakeLevel }) {
  const g = new THREE.Group();
  g.name = 'osm-ground';
  const col = (hex) => tmpC.setHex(hex).clone();
  if (flat) {
    // aprons: concrete; taxiways: asphalt with a yellow centreline
    const apron = new Soup(), taxi = new Soup(), line = new Soup();
    for (const a of data.areas) {
      if (a.cls !== LC.PAVED) continue;
      const contour = a.ring.map(p => new THREE.Vector2(p[0], p[1]));
      let tris; try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { tris = []; }
      const c = col(0x8f918e), r = a.ring, y = elev + 0.05;
      for (const [i, j, k] of tris) apron.tri([r[i][0], y, r[i][1]], [r[k][0], y, r[k][1]], [r[j][0], y, r[j][1]], c, [0, 1, 0]);
    }
    for (const l of data.lines) {
      if (l.kind !== 'taxiway') continue;
      ribbon(taxi, l.pts, l.width / 2, () => elev + 0.07, col(0x56595b));
      ribbon(line, l.pts, 0.2, () => elev + 0.1, col(0xe0b021));
    }
    const add = (soup, units) => { const geo = soup.geometry(); if (geo) { const m = new THREE.Mesh(geo, decal(0xffffff, units)); m.material.vertexColors = true; m.receiveShadow = true; g.add(m); } };
    add(apron, -6); add(taxi, -10); add(line, -14);
    // the airport's other runways, with real markings and designators
    for (const rw of data.runways) {
      if (skipRunway(rw)) continue;
      const dx = rw.b[0] - rw.a[0], dz = rw.b[1] - rw.a[1], L = Math.hypot(dx, dz);
      if (L < 300) continue;
      const labels = String(rw.ref).split('/').map(s => s.trim());
      const strip = runwayDressing({ length: L, halfWidth: Math.max(15, rw.width / 2), tone: 0x4a4c4d, labels: [labels[0] || '', labels[1] || ''] });
      strip.rotation.y = Math.atan2(-dz, dx);
      strip.position.set(rw.a[0], elev + 0.08, rw.a[1]);
      g.add(strip);
    }
    // lakes above sea level: a flat water sheet at the shoreline height
    const water = new Soup();
    for (const a of data.areas) {
      if (a.cls !== LC.WATER || a.area < 4000) continue;
      const level = lakeLevel(a.ring);
      if (!(level > 1.5)) continue;                                  // sea-level water is the ocean
      const contour = a.ring.map(p => new THREE.Vector2(p[0], p[1]));
      let tris; try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { tris = []; }
      const c = col(0xffffff), r = a.ring, y = level + 0.4;
      for (const [i, j, k] of tris) water.tri([r[i][0], y, r[i][1]], [r[k][0], y, r[k][1]], [r[j][0], y, r[j][1]], c, [0, 1, 0]);
    }
    const wgeo = water.geometry();
    if (wgeo) {
      const m = new THREE.Mesh(wgeo, new THREE.MeshStandardMaterial({
        color: 0x1f4a5c, roughness: 0.06, metalness: 0, envMapIntensity: 1.1,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
      }));
      m.receiveShadow = true;
      m.name = 'osm-lakes';
      g.add(m);
    }
  }
  // roads: draped on the terrain (bridges ride at least at sea level). Big
  // roads get painted edge lines from three stacked ribbons: full-width
  // asphalt, a light ribbon 15 cm in, and the asphalt core 50 cm in on top;
  // polygon offset decides the stacking, so no ribbon needs lifting.
  const layers = [new Soup(), new Soup(), new Soup()];   // shoulder, line, core
  for (const l of data.lines) {
    if (l.kind !== 'road' || l.tunnel) continue;
    const yAt = (x, z) => Math.max(heightFn(x, z), l.bridge ? 6 : 0) + 0.45;
    const tone = col(l.cls.startsWith('motorway') || l.cls === 'trunk' ? 0x4c4f52 : 0x5a5c5d);
    if (l.width >= 12) {
      ribbon(layers[0], l.pts, l.width / 2, yAt, tone);
      ribbon(layers[1], l.pts, l.width / 2 - 0.15, yAt, col(0xc4c4bc));
      ribbon(layers[2], l.pts, l.width / 2 - 0.5, yAt, tone);
    } else ribbon(layers[2], l.pts, l.width / 2, yAt, tone);
  }
  layers.forEach((soup, i) => {
    const geo = soup.geometry();
    if (!geo) return;
    const m = new THREE.Mesh(geo, decal(0xffffff, -6 - 3 * i));
    m.material.vertexColors = true; m.receiveShadow = true; m.name = 'osm-roads';
    g.add(m);
  });
  return g;
}
