// Ambient world life: boats, pattern traffic, bird flocks. Visual only (no
// collision, never touches physics) and map-agnostic: it only reads
// map.height and map.runway.
//
// Everything is a pure function of (cell, time), so there is no per-entity
// state to drift and nothing pops when the camera moves: the world is cut into
// CELL-sized squares, each deterministically owns at most one boat route and
// one coastal bird anchor, and the nearest few are mapped onto fixed pools of
// instanced meshes. Routes are validated once per cell (cached) with
// map.height, so boats only exist where water exists. The frame loop does no
// allocation and no Math.random.

import * as THREE from 'three';

const CELL = 2000;
const BOAT_RANGE = 3;            // cells (6 km) around the camera
const MAX_BOATS = 14;
const MAX_FLOCKS = 4;
const BIRDS_PER_FLOCK = 14;
const REFRESH_S = 1.0;

function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cellSeed = (ix, iz, salt) => (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ salt) >>> 0;

// Merge coloured, transformed primitives into one non-indexed geometry.
function mergeParts(parts) {
  const pos = [], col = [];
  const m = new THREE.Matrix4(), c = new THREE.Color();
  for (const { geo, color, pos: p = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    m.compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scale));
    g.applyMatrix4(m);
    c.set(color);
    const a = g.attributes.position;
    for (let i = 0; i < a.count; i++) { pos.push(a.getX(i), a.getY(i), a.getZ(i)); col.push(c.r, c.g, c.b); }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeVertexNormals();
  return out;
}

const flat = (extra = {}) => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x3a3a3a, ...extra });

// ---------------------------------------------------------------- geometry --
// Boats point along +x, y up.
function sailHull() {
  return mergeParts([
    { geo: new THREE.BoxGeometry(7.5, 1.1, 2.4), color: 0xf4f1ea, pos: [0, 0.55, 0] },
    { geo: new THREE.ConeGeometry(1.2, 2.6, 4), color: 0xf4f1ea, pos: [4.8, 0.55, 0], rot: [0, 0, -Math.PI / 2], scale: [1, 1, 1.0] },
    { geo: new THREE.BoxGeometry(7.5, 0.25, 2.4), color: 0x2b4f7a, pos: [0, 1.15, 0] },
    { geo: new THREE.CylinderGeometry(0.08, 0.08, 9, 4), color: 0xdddddd, pos: [0.4, 5.4, 0] },
  ]);
}
function sailCloth() {
  // two triangular sails (main + jib), double sided via the material
  const g = new THREE.BufferGeometry();
  const v = [
    0.2, 1.4, 0,  0.2, 9.6, 0,  -3.3, 1.4, 0,
    0.7, 1.4, 0,  0.7, 8.2, 0,  4.2, 1.4, 0,
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}
function motorHull() {
  return mergeParts([
    { geo: new THREE.BoxGeometry(6.2, 1.0, 2.1), color: 0xf2f4f6, pos: [0, 0.5, 0] },
    { geo: new THREE.ConeGeometry(1.05, 2.6, 4), color: 0xf2f4f6, pos: [4.2, 0.5, 0], rot: [0, 0, -Math.PI / 2] },
    { geo: new THREE.BoxGeometry(6.2, 0.2, 2.1), color: 0xc8372d, pos: [0, 1.05, 0] },
    { geo: new THREE.BoxGeometry(2.4, 1.2, 1.7), color: 0xe9eef2, pos: [-0.4, 1.7, 0] },
    { geo: new THREE.BoxGeometry(1.5, 0.45, 1.75), color: 0x28323c, pos: [0.2, 1.85, 0] },
  ]);
}
function wakeGeometry() {
  // long V-shaped foam streak trailing in -x, unit length/width
  const g = new THREE.BufferGeometry();
  const v = [
    0, 0, 0,  -1, 0, -0.5,  -0.82, 0, -0.34,
    0, 0, 0,  -0.82, 0, 0.34,  -1, 0, 0.5,
    0, 0, 0,  -1, 0, -0.18,  -1, 0, 0.18,
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const n = []; for (let i = 0; i < 9; i++) n.push(0, 1, 0);
  g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  return g;
}
function lightPlane() {
  const W = 0xf1f1ee, R = 0xc8372d;
  return mergeParts([
    { geo: new THREE.CylinderGeometry(0.55, 0.75, 6.4, 6), color: W, pos: [0, 0, 0], rot: [0, 0, -Math.PI / 2] },
    { geo: new THREE.ConeGeometry(0.58, 1.3, 6), color: R, pos: [3.8, -0.02, 0], rot: [0, 0, -Math.PI / 2] },
    { geo: new THREE.BoxGeometry(1.6, 0.14, 10.4), color: W, pos: [0.4, 0.75, 0] },
    { geo: new THREE.BoxGeometry(0.9, 0.14, 3.8), color: W, pos: [-3.0, 0.15, 0] },
    { geo: new THREE.BoxGeometry(1.0, 1.5, 0.12), color: R, pos: [-3.1, 0.9, 0] },
    { geo: new THREE.BoxGeometry(1.1, 0.5, 1.15), color: 0x28323c, pos: [0.7, 0.5, 0] },
    { geo: new THREE.BoxGeometry(0.1, 2.0, 0.14), color: 0x333333, pos: [4.5, 0, 0] },
  ]);
}
function birdGeometry() {
  // swept V, wings raised; flapping scales y about the body line
  const g = new THREE.BufferGeometry();
  const v = [
    0.6, 0, 0,  -0.35, 0.5, -1.5,  -0.45, 0, 0,
    0.6, 0, 0,  -0.45, 0, 0,  -0.35, 0.5, 1.5,
    0.7, 0, 0,  -0.1, 0.12, 0.12,  -0.1, 0.12, -0.12,
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ module --
export function createTraffic(scene, map, opts = {}) {
  const group = new THREE.Group();
  group.name = 'traffic';
  scene.add(group);
  let enabled = opts.enabled !== false;
  group.visible = enabled;

  const H = (x, z) => map.height(x, z);
  // Open water: below the surface with margin. Streamed real-world maps are
  // flat sea at ~0 (no bathymetry), so they accept anything at or under 0.2.
  const WET = map.latLon ? 0.2 : -1.5;
  const isReady = (x, z, r) => !map.ready || map.ready(x, z, r);

  // ---------- boats ----------
  const hullS = new THREE.InstancedMesh(sailHull(), flat(), MAX_BOATS);
  const hullM = new THREE.InstancedMesh(motorHull(), flat(), MAX_BOATS);
  const sails = new THREE.InstancedMesh(sailCloth(), new THREE.MeshLambertMaterial({ color: 0xfaf7ee, side: THREE.DoubleSide, flatShading: true, emissive: 0x6a6a6a }), MAX_BOATS);
  const wakes = new THREE.InstancedMesh(wakeGeometry(), new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), MAX_BOATS);
  for (const im of [hullS, hullM, sails, wakes]) { im.frustumCulled = false; im.count = 0; group.add(im); }
  wakes.renderOrder = 2;

  const routeCache = new Map();    // "ix,iz" -> route | null
  function routeFor(ix, iz) {
    const key = ix + ',' + iz;
    if (routeCache.has(key)) return routeCache.get(key);
    const cx0 = ix * CELL, cz0 = iz * CELL;
    if (!isReady(cx0 + CELL / 2, cz0 + CELL / 2, CELL)) return null;   // streamed map not loaded yet: retry later
    const rand = rng32(cellSeed(ix, iz, 0xb0a7));
    let route = null;
    for (let tries = 0; tries < 8 && !route; tries++) {
      const cx = cx0 + 300 + rand() * (CELL - 600), cz = cz0 + 300 + rand() * (CELL - 600);
      const a = 110 + rand() * 170, b = 70 + rand() * 120, phi = rand() * Math.PI;
      const cp = Math.cos(phi), sp = Math.sin(phi);
      let ok = true;
      for (let k = 0; k < 16 && ok; k++) {
        const t = (k / 16) * Math.PI * 2;
        const ex = Math.cos(t) * (a + 40), ez = Math.sin(t) * (b + 40);
        if (H(cx + ex * cp - ez * sp, cz + ex * sp + ez * cp) > WET) ok = false;
      }
      if (!ok) continue;
      const motor = rand() < 0.4;
      route = {
        cx, cz, a, b, cp, sp, motor,
        dir: rand() < 0.5 ? -1 : 1,
        // angular speed from linear speed over the mean radius
        w: (motor ? 6 + rand() * 3 : 2.6 + rand() * 1.8) / ((a + b) * 0.5),
        phase: rand() * Math.PI * 2,
      };
    }
    routeCache.set(key, route);
    return route;
  }

  // ---------- coast anchors for birds ----------
  const anchorCache = new Map();
  function anchorFor(ix, iz) {
    const key = ix + ',' + iz;
    if (anchorCache.has(key)) return anchorCache.get(key);
    if (!isReady(ix * CELL + CELL / 2, iz * CELL + CELL / 2, CELL)) return null;
    const rand = rng32(cellSeed(ix, iz, 0xb12d));
    let res = null;
    for (let tries = 0; tries < 10 && !res; tries++) {
      const x = ix * CELL + rand() * CELL, z = iz * CELL + rand() * CELL;
      const h = H(x, z);
      if (h < WET || h > 40) continue;
      let wet = false;
      for (let k = 0; k < 6 && !wet; k++) {
        const a = k * 1.047;
        wet = H(x + Math.cos(a) * 260, z + Math.sin(a) * 260) < WET;
      }
      if (wet) res = { x, z, r: 160 + rand() * 220, w: 0.05 + rand() * 0.05, phase: rand() * 6.28, alt: 35 + rand() * 50, seed: (rand() * 1e9) | 0, dir: rand() < 0.5 ? -1 : 1 };
    }
    anchorCache.set(key, res);
    return res;
  }

  // ---------- pattern traffic ----------
  const rwy = map.runway;
  const hasRunway = !!(rwy && rwy.spawn && Number.isFinite(rwy.headingRad));
  const planes = [];
  let pat = null;
  if (hasRunway) {
    const hd = rwy.headingRad;
    const fx = Math.cos(hd), fz = -Math.sin(hd);       // runway forward (world x/z)
    const rx = Math.sin(hd), rz = Math.cos(hd);        // runway right
    const len = Math.max(600, (rwy.x1 || 1000) - (rwy.x0 || 0));
    const cx = rwy.spawn.x + fx * (len / 2 - 60), cz = rwy.spawn.z + fz * (len / 2 - 60);
    const R = 380;
    const L = len / 2 + 800 - R;       // half straight length along the runway
    const Wd = 45;                     // half straight length across; loop spans v = -1000..-150 (left of the runway)
    const vc = -575;
    pat = {
      cx: cx + rx * vc, cz: cz + rz * vc, fx, fz, rx, rz, R, L, Wd,
      y: (rwy.y || 0) + 300, speed: 52,
      total: 4 * L + 4 * Wd + 2 * Math.PI * R,
    };
  }
  // Rounded-rectangle left-hand circuit in the runway frame (u forward, v right):
  // upwind +u, crosswind -v, downwind -u, base/final +v, left turns only.
  const pose = { x: 0, y: 0, z: 0, yaw: 0, bank: 0 };
  function patternPose(s0) {
    const { cx, cz, fx, fz, rx, rz, R, L, Wd } = pat;
    const sL = 2 * L, sW = 2 * Wd, sA = Math.PI / 2 * R;
    let s = ((s0 % pat.total) + pat.total) % pat.total;
    let u, v, hu, hv, turn = 0, t;
    if (s < sL) { u = -L + s; v = Wd + R; hu = 1; hv = 0; }
    else if ((s -= sL) < sA) { t = s / R; u = L + Math.sin(t) * R; v = Wd + Math.cos(t) * R; hu = Math.cos(t); hv = -Math.sin(t); turn = 1; }
    else if ((s -= sA) < sW) { u = L + R; v = Wd - s; hu = 0; hv = -1; }
    else if ((s -= sW) < sA) { t = s / R; u = L + Math.cos(t) * R; v = -Wd - Math.sin(t) * R; hu = -Math.sin(t); hv = -Math.cos(t); turn = 1; }
    else if ((s -= sA) < sL) { u = L - s; v = -(Wd + R); hu = -1; hv = 0; }
    else if ((s -= sL) < sA) { t = s / R; u = -L - Math.sin(t) * R; v = -Wd - Math.cos(t) * R; hu = -Math.cos(t); hv = Math.sin(t); turn = 1; }
    else if ((s -= sA) < sW) { u = -L - R; v = -Wd + s; hu = 0; hv = 1; }
    else { s -= sW; t = s / R; u = -L - Math.cos(t) * R; v = Wd + Math.sin(t) * R; hu = Math.sin(t); hv = Math.cos(t); turn = 1; }
    pose.x = cx + fx * u + rx * v;
    pose.z = cz + fz * u + rz * v;
    pose.y = pat.y;
    pose.yaw = Math.atan2(-(fz * hu + rz * hv), fx * hu + rx * hv);
    pose.bank = turn ? -Math.atan2(pat.speed * pat.speed, R * 9.81) : 0;   // left turn = left wing down
    return pose;
  }

  const planeGeo = hasRunway ? lightPlane() : null;
  const planeMat = flat();
  const planeMeshes = [];
  if (hasRunway) {
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(planeGeo, planeMat);
      mesh.scale.setScalar(1.35);
      mesh.rotation.order = 'YXZ';
      mesh.frustumCulled = false;
      group.add(mesh);
      planeMeshes.push(mesh);
    }
  }
  let bank0 = 0, bank1 = 0;

  // ---------- birds ----------
  const birds = new THREE.InstancedMesh(birdGeometry(), new THREE.MeshLambertMaterial({ color: 0xf6f6f4, side: THREE.DoubleSide, flatShading: true }), MAX_FLOCKS * BIRDS_PER_FLOCK);
  birds.frustumCulled = false; birds.count = 0;
  group.add(birds);

  // ---------- per-frame scratch ----------
  const m4 = new THREE.Matrix4(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const pv = new THREE.Vector3(), sv = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), RX = new THREE.Vector3(1, 0, 0);
  const boatList = new Array(MAX_BOATS).fill(null);
  const boatD = new Float64Array(MAX_BOATS);
  let nBoats = 0;
  const flockList = new Array(MAX_FLOCKS).fill(null);
  const flockD = new Float64Array(MAX_FLOCKS);
  let nFlocks = 0;
  let refreshT = 1e9, lastIx = 1e9, lastIz = 1e9;

  // Insert into a small fixed-size nearest-first list (no allocation).
  function pushNearest(list, dist, n, max, item, d) {
    if (n === max && d >= dist[n - 1]) return n;
    let i = n < max ? n : n - 1;
    while (i > 0 && dist[i - 1] > d) { list[i] = list[i - 1]; dist[i] = dist[i - 1]; i--; }
    list[i] = item; dist[i] = d;
    return n < max ? n + 1 : n;
  }

  function refresh(camX, camZ) {
    const ix0 = Math.floor(camX / CELL), iz0 = Math.floor(camZ / CELL);
    nBoats = 0; nFlocks = 0;
    for (let dz = -BOAT_RANGE; dz <= BOAT_RANGE; dz++) {
      for (let dx = -BOAT_RANGE; dx <= BOAT_RANGE; dx++) {
        const ix = ix0 + dx, iz = iz0 + dz;
        const d = dx * dx + dz * dz;
        const r = routeFor(ix, iz);
        if (r) nBoats = pushNearest(boatList, boatD, nBoats, MAX_BOATS, r, d);
        if (d <= 9) {
          const a = anchorFor(ix, iz);
          if (a) nFlocks = pushNearest(flockList, flockD, nFlocks, MAX_FLOCKS, a, d);
        }
      }
    }
  }

  function writeBoats(t) {
    let ns = 0, nm = 0, nw = 0;
    for (let i = 0; i < nBoats; i++) {
      const r = boatList[i];
      const th = r.phase + r.dir * r.w * t;
      const ct = Math.cos(th), st = Math.sin(th);
      const ex = ct * r.a, ez = st * r.b;
      const x = r.cx + ex * r.cp - ez * r.sp, z = r.cz + ex * r.sp + ez * r.cp;
      // velocity direction (derivative of the ellipse, times dir)
      const tx = -st * r.a * r.dir, tz = ct * r.b * r.dir;
      const vx = tx * r.cp - tz * r.sp, vz = tx * r.sp + tz * r.cp;
      const yaw = Math.atan2(-vz, vx);
      const bob = Math.sin(t * 1.3 + r.phase * 3) * 0.08;
      const heel = r.motor ? 0 : 0.12 * r.dir;
      qa.setFromAxisAngle(UP, yaw);
      qb.setFromAxisAngle(RX, heel);
      qa.multiply(qb);
      pv.set(x, 0.12 + bob, z); sv.set(1, 1, 1);
      m4.compose(pv, qa, sv);
      if (r.motor) { hullM.setMatrixAt(nm++, m4); } else { hullS.setMatrixAt(ns, m4); sails.setMatrixAt(ns, m4); ns++; }
      // wake sits flat on the water, behind the stern
      qa.setFromAxisAngle(UP, yaw);
      const len = r.motor ? 30 : 11, wid = r.motor ? 8 : 3.2;
      pv.set(x - Math.cos(yaw) * 3, 0.2, z + Math.sin(yaw) * 3); sv.set(len, 1, wid);
      m4.compose(pv, qa, sv);
      wakes.setMatrixAt(nw++, m4);
    }
    hullS.count = ns; sails.count = ns; hullM.count = nm; wakes.count = nw;
    hullS.instanceMatrix.needsUpdate = hullM.instanceMatrix.needsUpdate = sails.instanceMatrix.needsUpdate = wakes.instanceMatrix.needsUpdate = true;
  }

  function writeBirds(t) {
    let n = 0;
    for (let f = 0; f < nFlocks; f++) {
      const a = flockList[f];
      const th = a.phase + a.dir * a.w * t;
      const cx = a.x + Math.cos(th) * a.r + Math.cos(th * 0.37) * 80;
      const cz = a.z + Math.sin(th) * a.r * 0.8 + Math.sin(th * 0.53) * 80;
      const hx = -Math.sin(th) * a.dir, hz = Math.cos(th) * 0.8 * a.dir;
      const yaw = Math.atan2(-hz, hx);
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      for (let i = 0; i < BIRDS_PER_FLOCK; i++) {
        const rb = rng32(a.seed + i * 7919);
        // loose V formation with per-bird jitter (deterministic)
        const row = 1 + (i >> 1), sideSign = (i & 1) ? 1 : -1;
        const fwd = -row * 6 + (rb() - 0.5) * 4, lat = sideSign * row * 5 + (rb() - 0.5) * 4;
        const alt = a.alt + Math.sin(t * 0.4 + i) * 3 + (rb() - 0.5) * 8;
        const flap = Math.sin(t * (7 + (i % 3)) + i * 1.7);
        pv.set(cx + cy * fwd - sy * lat, alt, cz - sy * fwd - cy * lat);
        // heading: yaw about up; flap scales wing height
        qa.setFromAxisAngle(UP, yaw);
        sv.set(1.4, 0.2 + 1.8 * (flap * 0.5 + 0.5), 1.4);
        m4.compose(pv, qa, sv);
        birds.setMatrixAt(n++, m4);
      }
    }
    birds.count = n;
    birds.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ API --
  function update(dt, camPos, t) {
    if (!enabled) return;
    const ix = Math.floor(camPos.x / CELL), iz = Math.floor(camPos.z / CELL);
    refreshT += dt;
    if (ix !== lastIx || iz !== lastIz || refreshT > 4) {
      if (refreshT > REFRESH_S || ix !== lastIx || iz !== lastIz) {
        refresh(camPos.x, camPos.z);
        lastIx = ix; lastIz = iz; refreshT = 0;
      }
    }
    writeBoats(t);
    writeBirds(t);
    if (hasRunway) {
      for (let i = 0; i < planeMeshes.length; i++) {
        const mesh = planeMeshes[i];
        const near = Math.hypot(camPos.x - pat.cx, camPos.z - pat.cz) < 9000;
        mesh.visible = near;
        if (!near) continue;
        const p = patternPose(pat.speed * t + i * pat.total * 0.5);
        mesh.position.set(p.x, p.y, p.z);
        // smooth the bank so it rolls in and out of turns instead of snapping
        const target = p.bank;
        if (i === 0) { bank0 += (target - bank0) * Math.min(1, dt * 1.5); mesh.rotation.set(bank0, p.yaw, 0); }
        else { bank1 += (target - bank1) * Math.min(1, dt * 1.5); mesh.rotation.set(bank1, p.yaw, 0); }
      }
    }
  }

  return {
    update,
    get enabled() { return enabled; },
    get counts() { return { boats: nBoats, flocks: nFlocks, planes: planeMeshes.length }; },
    setEnabled(on) { enabled = !!on; group.visible = enabled; },
    dispose() {
      scene.remove(group);
      group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      routeCache.clear(); anchorCache.clear();
    },
    group,
  };
}
