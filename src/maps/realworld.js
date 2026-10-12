// REAL-WORLD terrain: streams actual elevation for a chosen airfield from AWS
// Terrain Tiles (public, keyless, CORS) and samples it synchronously for the
// FlightMap contract, so src/terrain.js + physics need zero changes. Rendered
// in the sim's stylised low-poly palette — real shapes, not satellite imagery.
//
// Async tiles behind a sync sampler: height() returns sea level (0) for any
// pixel whose tile isn't loaded yet and enqueues a fetch; loadMap awaits
// ready() near the spawn before building terrain, and the frame loop prefetches
// ahead of the aircraft. If the network is unreachable the map still boots as a
// flat ocean with the runway plateau (see `elevationOffline`).

import * as THREE from 'three';
import { makeNoise, woodland } from './noise.js';
import { PAL, seabed, beach, facetJitter } from './palette.js';
import { runwayDressing, reciprocal } from './runwayPaint.js';
import { makeProjection, tileOfPixel, decodeTerrarium, bilerp, bearingToHeadingRad } from './tilesampler.js';
import { fetchOsm, buildOsmWorld, makeLL, LC, OSM_ATTRIBUTION } from './osm.js';
import { buildingMeshes, groundMeshes } from './osmMeshes.js';
import { setFacadeNight } from './sgLandmarks.js';

const TILE_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_CAP = 220;      // LRU cap on decoded tiles (~14 MB of Float32 at 256²)
const MAX_PARALLEL = 6;

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- global stylised colour banding (works from sea level to alpine snow) ----

export function createRealWorldMap(preset) {
  const Z = preset.zoom;
  const proj = makeProjection(preset.lat, preset.lon, Z);
  const headingRad = bearingToHeadingRad(preset.bearingDeg);
  const elev = preset.elev;
  const halfLen = preset.lengthM / 2;
  const halfWidth = Math.max(15, preset.widthM / 2);
  // runway forward / right unit vectors in world (x=East, z=South)
  const fwd = { x: Math.cos(headingRad), z: -Math.sin(headingRad) };
  const right = { x: Math.sin(headingRad), z: Math.cos(headingRad) };
  const start = -halfLen + Math.min(60, preset.lengthM * 0.12);
  const spawn = { x: fwd.x * start, z: fwd.z * start };
  const toRunway = (x, z) => ({ u: x * fwd.x + z * fwd.z, v: x * right.x + z * right.z });

  // ---------------- tile cache ----------------
  const tiles = new Map(); // "tx,ty" -> { state:'queued'|'loading'|'ready'|'error', data }
  const queue = [];
  let fetching = 0;
  let offline = false;
  const key = (tx, ty) => tx + ',' + ty;

  async function loadTile(tx, ty) {
    const n = 2 ** Z;
    const wx = ((tx % n) + n) % n; // wrap longitude
    const res = await fetch(`${TILE_BASE}/${Z}/${wx}/${ty}.png`, { mode: 'cors' });
    if (!res.ok) throw new Error('tile ' + res.status);
    const bmp = await createImageBitmap(await res.blob());
    const cv = new OffscreenCanvas(256, 256);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const px = ctx.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(256 * 256);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = decodeTerrarium(px[p], px[p + 1], px[p + 2]);
    return out;
  }

  function pump() {
    while (fetching < MAX_PARALLEL && queue.length) {
      const k = queue.shift();
      const t = tiles.get(k);
      if (!t || t.state !== 'queued') continue;
      t.state = 'loading'; fetching++;
      const [tx, ty] = k.split(',').map(Number);
      loadTile(tx, ty)
        .then((data) => { if (!t.abandoned) { t.data = data; t.state = 'ready'; } })
        .catch(() => { if (!t.abandoned) { t.data = null; t.state = 'error'; offline = true; } })
        // abandonPending() already released this tile's slot (and may have
        // reused it for another fetch) — if the hung promise eventually
        // settles here, skip the decrement so `fetching` cannot go negative
        // or be double-released.
        .finally(() => { if (!t.abandoned) fetching--; pump(); });
    }
  }

  function ensureTile(tx, ty) {
    const k = key(tx, ty);
    let t = tiles.get(k);
    if (t) { tiles.delete(k); tiles.set(k, t); return t; } // LRU touch
    t = { state: 'queued', data: null };
    tiles.set(k, t);
    queue.push(k);
    if (tiles.size > TILE_CAP) {
      for (const kk of tiles.keys()) {
        const tt = tiles.get(kk);
        if (tt.state === 'ready' || tt.state === 'error') { tiles.delete(kk); break; }
      }
    }
    return t;
  }

  function pixelHeight(i, j) {
    const { tx, ty, lx, ly } = tileOfPixel(i, j);
    const t = ensureTile(tx, ty);
    return (t.state === 'ready' && t.data) ? t.data[ly * 256 + lx] : 0;
  }

  function rawHeight(x, z) {
    const { gpx, gpy } = proj.toPixel(x, z);
    const i0 = Math.floor(gpx), j0 = Math.floor(gpy);
    const fx = gpx - i0, fy = gpy - j0;
    return bilerp(pixelHeight(i0, j0), pixelHeight(i0 + 1, j0),
                  pixelHeight(i0, j0 + 1), pixelHeight(i0 + 1, j0 + 1), fx, fy);
  }

  function tileRange(x, z, radius, fn) {
    const a = proj.toPixel(x - radius, z - radius), b = proj.toPixel(x + radius, z + radius);
    const tx0 = Math.floor(a.gpx / 256), tx1 = Math.floor(b.gpx / 256);
    const ty0 = Math.floor(a.gpy / 256), ty1 = Math.floor(b.gpy / 256);
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) fn(tx, ty);
  }

  function prefetch(x, z, radius = 3500) { tileRange(x, z, radius, ensureTile); pump(); }
  function ready(x, z, radius = 3500) {
    let ok = true;
    tileRange(x, z, radius, (tx, ty) => {
      const t = tiles.get(key(tx, ty));
      if (!t || (t.state !== 'ready' && t.state !== 'error')) ok = false;
    });
    return ok;
  }
  // loadMap caps its wait at 12 s; stalled fetches (tracker blockers that never
  // settle the request) would otherwise leave tiles in queued/loading forever,
  // and the coarse-tier builder in terrain.js re-queues those cells forever.
  // Mark them failed so ready() returns and the world boots flat.
  //
  // 'loading' tiles hold one of the MAX_PARALLEL `fetching` slots (incremented
  // in pump(), only ever decremented in the .finally there). A hung fetch's
  // .finally never runs, so without releasing it here `fetching` stays pinned
  // and pump() can never start another tile — the very first stall would kill
  // this map for the rest of the page session, even after the queue refills
  // from the frame-loop prefetch. We release the slot by decrementing here and
  // flag the tile `abandoned` so that IF the hung promise ever does settle
  // later, its .finally sees the flag and skips its own decrement — one
  // release per slot, never two, and `fetching` can't be driven negative.
  function abandonPending() {
    let n = 0;
    for (const t of tiles.values()) {
      if (t.state === 'queued') {
        t.state = 'error'; t.data = null; n++;
      } else if (t.state === 'loading') {
        t.state = 'error'; t.data = null; t.abandoned = true;
        fetching = Math.max(0, fetching - 1);
        n++;
      }
    }
    queue.length = 0;
    if (n) offline = true;
    return n;
  }

  // ---------------- FlightMap contract ----------------
  function runwayDist(x, z) {
    const { u, v } = toRunway(x, z);
    return Math.hypot(Math.max(0, Math.abs(u) - (halfLen + 140)), Math.max(0, Math.abs(v) - 100));
  }

  function height(x, z) {
    let h = rawHeight(x, z);
    const d = runwayDist(x, z);
    if (d < 900) {
      const w = 1 - smoothstep(60, 900, d);
      h = h * (1 - w) + elev * w;
      if (d < 60) h = elev;
    }
    // OSM airport pavement (aprons, taxiways, the other runways) sits flat at
    // field elevation, eased in over ~40 m. Only once committed: see osm.js.
    if (osm.committed && x * x + z * z < 4600 * 4600) {
      let k = 0;
      for (let dz = -24; dz <= 24; dz += 24) for (let dx = -24; dx <= 24; dx += 24) if (osm.world.landCover(x + dx, z + dz) === LC.PAVED) k++;
      if (k) h += (elev - h) * smoothstep(0, 5, k);
    }
    return h;
  }

  function isRunway(x, z) {
    const { u, v } = toRunway(x, z);
    return Math.abs(u) < halfLen + 20 && Math.abs(v) < halfWidth + 6;
  }

  // Cosmetic woodland (no land-cover data, so a plausible noise mask) below a
  // ~1800 m treeline, clear of the field.
  const NZ = makeNoise(Math.round(preset.lat * 1000) ^ Math.round(preset.lon * 1000) << 8);
  // With OSM land cover the trees grow where the real forests are.
  const COVER_TREES = { [LC.FOREST]: 0.95, [LC.SCRUB]: 0.3, [LC.GRASS]: 0.05, [LC.URBAN]: 0.07, [LC.FARM]: 0.01 };
  function forestDensity(x, z, h, slope) {
    if (h < 3 || h > 1850 || slope > 0.6) return 0;
    const d = runwayDist(x, z);
    if (d < 240) return 0;
    const fade = smoothstep(240, 450, d) * (1 - smoothstep(1650, 1850, h)) * (1 - smoothstep(0.45, 0.6, slope));
    if (osm.committed) {
      const c = osm.world.landCover(x, z);
      if (c !== LC.NONE || osm.inside(x, z)) return (COVER_TREES[c] || 0) * fade;
    }
    return woodland(NZ, x, z, 480, 0.75) * fade;
  }

  function color(h, slope, x, z, out) {
    if (h < -0.6) return facetJitter(x, z, seabed(h, out), 0.02);
    if (h < 2) return facetJitter(x, z, beach(h, out), 0.03);
    out.lerpColors(PAL.grass, PAL.grassDark, smoothstep(40, 600, h));
    out.lerp(PAL.scrub, smoothstep(900, 1500, h));
    out.lerp(PAL.rock, smoothstep(1700, 2400, h));
    const f = forestDensity(x, z, h, slope);
    if (f > 0.08) out.lerp(PAL.forest, Math.min(1, f));
    if (osm.committed) coverColour(x, z, h, out);
    if (h > 40) out.lerp(PAL.rock, smoothstep(0.5, 0.85, slope));
    if (h > 2700) out.lerp(PAL.snow, smoothstep(2700, 3200, h) * (1 - smoothstep(0.7, 1.0, slope)));
    return facetJitter(x, z, out);
  }

  // ---------------- OpenStreetMap scenery (osm.js) ----------------
  const ll = makeLL(proj);
  const osm = {
    data: null, world: null, committed: false, promise: null, status: 'idle',
    inside: (x, z) => Math.abs(x) < 6800 && Math.abs(z) < 6800,   // inside the land-cover query box
  };
  function loadScenery() {
    if (!osm.promise) {
      osm.status = 'loading';
      osm.promise = fetchOsm(preset.lat, preset.lon, ll).then((data) => {
        if (!data || (!data.buildings.length && !data.areas.length)) { osm.status = 'failed'; return false; }
        osm.data = data;
        osm.world = buildOsmWorld(data);
        osm.status = 'ready';
        return true;
      });
    }
    return osm.promise;
  }
  // Land cover may only change height/colour/trees BEFORE terrain is built.
  function commitScenery() { if (osm.world) osm.committed = true; return osm.committed; }

  const FIELDS = [0xc7b467, 0x87a34f, 0x8b7357, 0xa8b06a, 0x6a8e43, 0xb8a272].map(c => new THREE.Color(c));
  const COVER = {
    [LC.URBAN]: new THREE.Color(0x9c9d96), [LC.INDUSTRIAL]: new THREE.Color(0xa5a7a6), [LC.WATER]: new THREE.Color(0x2c5566),
    [LC.ROCK]: PAL.rock, [LC.ICE]: PAL.snow, [LC.SAND]: PAL.sand, [LC.SCRUB]: PAL.scrub, [LC.PAVED]: new THREE.Color(0x6c6e6d),
    [LC.GRASS]: PAL.meadow,
  };
  const tmpCol = new THREE.Color();
  function coverColour(x, z, h, out) {
    const c = osm.world.landCover(x, z);
    // PAVED is left alone: the pavement meshes draw it crisply, and tinting the
    // terrain under them only smeared grey bands along every taxiway edge
    if (c === LC.NONE || c === LC.FOREST || c === LC.PAVED) return;
    if (c === LC.FARM) {
      const t = osm.world.fieldTone(x, z);
      tmpCol.copy(FIELDS[t % FIELDS.length]).offsetHSL(0, 0, ((t >> 3) / 32 - 0.5) * 0.06);
      out.lerp(tmpCol, 0.8);
    } else if (c === LC.URBAN) {
      out.lerp(COVER[c], 0.55);              // gardens and street trees keep some green
    } else out.lerp(COVER[c], c === LC.GRASS ? 0.45 : 0.85);
  }

  // Race gates + demo-plan fixes generated in the runway frame around the field.
  const rf = (along, cross, agl) => [
    fwd.x * along + right.x * cross, elev + agl, fwd.z * along + right.z * cross,
  ];
  const raceCourse = [
    rf(halfLen + 500, 0, 140), rf(halfLen + 1500, 350, 280), rf(halfLen + 2400, -150, 420),
    rf(1400, -1800, 520), rf(-300, -2200, 560), rf(-2000, -1600, 520),
    rf(-2600, 200, 440), rf(-2000, 1700, 360), rf(-300, 2200, 320),
    rf(1500, 1700, 280), rf(2000, 500, 220), rf(-halfLen + 100, 0, 150),
  ];
  const fixes = [
    { x: rf(halfLen + 1400, 0, 220)[0], z: rf(halfLen + 1400, 0, 220)[2], y: elev + 220 },
    { x: rf(0, -2200, 400)[0], z: rf(0, -2200, 400)[2], y: elev + 400 },
    { x: rf(-2200, 0, 340)[0], z: rf(-2200, 0, 340)[2], y: elev + 340 },
    { x: spawn.x, z: spawn.z, y: elev + 140 },
  ];

  const runway = {
    spawn, y: elev, headingRad, name: preset.rwyName,
    halfWidth, x0: -halfLen, x1: halfLen, // centred on the origin (lights/minimap use x0..x1)
  };

  function createScenery(scene) {
    const g = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

    // Asphalt + ICAO markings as geometry (runwayPaint.js), rotated to the
    // bearing. The runway is centred on the origin, so start half a length back.
    const strip = runwayDressing({ length: preset.lengthM, halfWidth, tone: 0x45484a,
      labels: [preset.rwyName, reciprocal(preset.rwyName)] });
    strip.rotation.y = headingRad;
    strip.position.set(-fwd.x * halfLen, elev + 0.08, -fwd.z * halfLen);
    g.add(strip);

    // Simple control tower + windsock beside the strip.
    const tower = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(6, 16, 6), mat(0xb9bec4)); shaft.position.y = 8;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 10), mat(0x2b3a44)); cab.position.y = 18;
    tower.add(shaft, cab);
    const toff = { x: right.x * (halfWidth + 40) + fwd.x * -halfLen * 0.3, z: right.z * (halfWidth + 40) + fwd.z * -halfLen * 0.3 };
    tower.position.set(toff.x, elev, toff.z);
    g.add(tower);

    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6.5), mat(0xcccccc));
    const pOff = { x: right.x * (halfWidth + 12), z: right.z * (halfWidth + 12) };
    pole.position.set(pOff.x, elev + 3.25, pOff.z);
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.75, 3, 6), mat(0xd8632a));
    sock.rotation.z = Math.PI / 2; sock.position.set(pOff.x + 1.6, elev + 6.1, pOff.z);
    g.add(pole, sock);
    g.userData.windsock = sock;

    // OpenStreetMap buildings, pavement, roads and lakes: now if the data
    // is here, or when it lands (buildings and roads only, see osm.js)
    const addOsm = () => {
      if (!osm.data) return;
      const b = buildingMeshes(osm.data.buildings, height);
      const gr = groundMeshes(osm.data, {
        heightFn: height, elev, flat: osm.committed,
        skipRunway: (rw) => {
          const m = toRunway((rw.a[0] + rw.b[0]) / 2, (rw.a[1] + rw.b[1]) / 2);
          const dx = rw.b[0] - rw.a[0], dz = rw.b[1] - rw.a[1];
          const cross = Math.abs(dx * fwd.z - dz * fwd.x) / (Math.hypot(dx, dz) || 1);
          return Math.abs(m.u) < halfLen && Math.abs(m.v) < halfWidth + 40 && cross < 0.18;
        },
        lakeLevel: (ring) => {
          const hs = [];
          const step = Math.max(1, Math.floor(ring.length / 64));
          for (let i = 0; i < ring.length; i += step) hs.push(height(ring[i][0], ring[i][1]));
          hs.sort((p, q) => p - q);
          return hs[Math.floor(hs.length * 0.2)];
        },
      });
      g.add(b, gr);
      if (osm.data.buildings.length > 20) tower.visible = false;   // the real tower is in the data
      g.userData.osm = { buildings: osm.data.buildings.length, roads: osm.data.lines.length, areas: osm.data.areas.length, committed: osm.committed };
    };
    if (osm.data) addOsm();
    else if (osm.promise) osm.promise.then((ok) => { if (ok && g.parent) addOsm(); });
    g.userData.nightGlow = (on) => setFacadeNight(on);

    scene.add(g);
    return g;
  }

  return {
    id: preset.id, name: preset.name,
    height, color, isRunway, runway, createScenery, raceCourse, fixes,
    forest: forestDensity, conifer: (h) => smoothstep(250, 900, h) * 0.85 + 0.1,
    obstacleTop(x, z) {
      if (!osm.world) return -Infinity;
      const i = osm.world.buildingAt(x, z);
      const b = i >= 0 ? osm.data.buildings[i] : null;
      return b && b.top !== undefined ? b.top : -Infinity;
    },
    loadScenery, commitScenery,
    /** The airliner's taxiway network (taxinet.js) from the OSM taxiways, parked
     *  on the biggest apron near the runway; null without scenery. */
    taxiLayout() {
      if (!osm.data) return null;
      const lines = osm.data.lines.filter(l => l.kind === 'taxiway' && l.pts.length >= 2).map(l => l.pts);
      if (!lines.length) return null;
      let best = null;
      for (const a of osm.data.areas) {
        if (a.aeroway !== 'apron') continue;
        let cx = 0, cz = 0;
        for (const p of a.ring) { cx += p[0]; cz += p[1]; }
        cx /= a.ring.length; cz /= a.ring.length;
        const m = toRunway(cx, cz);
        if (Math.abs(m.u) > halfLen + 1500 || Math.abs(m.v) > 3000) continue;
        if (!best || a.area > best.area) best = { area: a.area, x: cx, z: cz };
      }
      if (!best) return null;
      return { kind: 'osm', width: 23, lines, stand: { x: best.x, z: best.z, yaw: 0 }, holds: [] };
    },
    get osmStatus() { return osm.status; },
    get attribution() { return osm.data ? 'Elevation: Mapzen Terrain Tiles · Scenery ' + OSM_ATTRIBUTION : 'Elevation: Mapzen Terrain Tiles'; },
    // real-world extras used by main.js / modes.js
    latLon: { lat: preset.lat, lon: preset.lon },
    prefetch, ready, abandonPending,
    get elevationOffline() { return offline; },
    _debug: { proj, headingRad, spawn, toRunway, rawHeight, tiles, osm },
  };
}
