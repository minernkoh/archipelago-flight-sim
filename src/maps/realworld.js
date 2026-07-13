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
import { makeProjection, tileOfPixel, decodeTerrarium, bilerp, bearingToHeadingRad } from './tilesampler.js';

const TILE_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_CAP = 220;      // LRU cap on decoded tiles (~14 MB of Float32 at 256²)
const MAX_PARALLEL = 6;

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- global stylised colour banding (works from sea level to alpine snow) ----
const COL = {
  sea: new THREE.Color(0x27536b), shallow: new THREE.Color(0x3a7d8c),
  sand: new THREE.Color(0xc9b98c), grass: new THREE.Color(0x5f8f4e),
  grass2: new THREE.Color(0x47703a), brush: new THREE.Color(0x7c8552),
  scree: new THREE.Color(0x8d8578), rock: new THREE.Color(0x746b60),
  snow: new THREE.Color(0xf4f6f5),
};

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
        .then((data) => { t.data = data; t.state = 'ready'; })
        .catch(() => { t.data = null; t.state = 'error'; offline = true; })
        .finally(() => { fetching--; pump(); });
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
    return h;
  }

  function isRunway(x, z) {
    const { u, v } = toRunway(x, z);
    return Math.abs(u) < halfLen + 20 && Math.abs(v) < halfWidth + 6;
  }

  function color(h, slope, x, z, out) {
    if (h < 0.5) { out.copy(COL.sea); return out; }
    if (h < 2) { out.lerpColors(COL.shallow, COL.sand, smoothstep(0.5, 2, h)); return out; }
    if (h < 120) out.lerpColors(COL.sand, COL.grass, smoothstep(2, 40, h));
    else if (h < 700) out.lerpColors(COL.grass, COL.grass2, smoothstep(120, 700, h));
    else if (h < 1300) out.lerpColors(COL.grass2, COL.brush, smoothstep(700, 1300, h));
    else if (h < 2000) out.lerpColors(COL.brush, COL.scree, smoothstep(1300, 2000, h));
    else if (h < 2600) out.lerpColors(COL.scree, COL.rock, smoothstep(2000, 2600, h));
    else out.lerpColors(COL.rock, COL.snow, smoothstep(2600, 3200, h));
    if (slope > 0.5 && h > 40) out.lerp(COL.rock, smoothstep(0.5, 0.85, slope));
    if (h > 2900 && slope < 0.4) out.lerp(COL.snow, smoothstep(2900, 3400, h));
    return out;
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
    halfWidth, x0: 0, x1: preset.lengthM, // x0/x1 nominal — fixes[] drives the demo plan
  };

  function createScenery(scene) {
    const g = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });

    // Runway slab with painted centreline / thresholds, rotated to the bearing.
    const cv = document.createElement('canvas');
    cv.width = 2048; cv.height = 128;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#43464150'; ctx.fillStyle = '#454842'; ctx.fillRect(0, 0, 2048, 128);
    ctx.fillStyle = '#c9cdd2';
    for (let x = 80; x < 1968; x += 96) ctx.fillRect(x, 61, 52, 6);          // centreline
    for (let i = 0; i < 6; i++) { ctx.fillRect(16, 12 + i * 18, 44, 10); ctx.fillRect(1988, 12 + i * 18, 44, 10); }
    ctx.fillRect(0, 0, 2048, 3); ctx.fillRect(0, 125, 2048, 3);              // edges
    ctx.fillStyle = '#c9cdd2'; ctx.font = 'bold 52px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(preset.rwyName, 150, 82);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const geo = new THREE.PlaneGeometry(preset.lengthM, halfWidth * 2);
    geo.rotateX(-Math.PI / 2); geo.rotateY(headingRad); // long axis -> runway forward
    const strip = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    strip.position.set(0, elev + 0.08, 0);
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

    scene.add(g);
    return g;
  }

  return {
    id: preset.id, name: preset.name,
    height, color, isRunway, runway, createScenery, raceCourse, fixes,
    obstacleTop() { return -Infinity; },
    // real-world extras used by main.js / modes.js
    latLon: { lat: preset.lat, lon: preset.lon },
    prefetch, ready,
    get elevationOffline() { return offline; },
    _debug: { proj, headingRad, spawn, toRunway, rawHeight, tiles },
  };
}
