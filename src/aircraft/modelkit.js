// Model kit for the aircraft meshes: lofted fuselages and airfoil-section
// lifting surfaces, built as non-indexed geometry with ONE colour per face
// (vertex colours), the same crisp faceted look as the terrain. The livery is
// painted through a callback evaluated at each face's centroid, so stripes,
// windows and panels fall exactly on facet edges and cost no textures.
//
// Model frame: +x forward, +y up, +z right (the physics body frame).
//
// Everything here is plain geometry construction: no per-frame work, no
// allocation after build.

import * as THREE from 'three';

const _col = new THREE.Color();

// Collects triangles and per-face colours, then emits a BufferGeometry.
class Tris {
  constructor() { this.p = []; this.c = []; }
  tri(a, b, c, hex) {
    // drop degenerate triangles (collapsed loft ends)
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-12) return;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    _col.setHex(hex);
    for (let i = 0; i < 3; i++) this.c.push(_col.r, _col.g, _col.b);
  }
  quad(a, b, c, d, hex) { this.tri(a, b, c, hex); this.tri(a, c, d, hex); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const centroid = (...pts) => {
  const o = [0, 0, 0];
  for (const p of pts) { o[0] += p[0]; o[1] += p[1]; o[2] += p[2]; }
  return [o[0] / pts.length, o[1] / pts.length, o[2] / pts.length];
};

// ------------------------------------------------------------ profiles --

// Half cross-section, top centre to bottom centre on the RIGHT (+z) side, as
// [z, y] in -1..1. Mirrored for the left. Explicit rows (rather than evenly
// spaced angles) put facet edges where the paint wants them.
export const PROFILE = {
  // rounded box: light-aircraft cabins
  cabin: [[0, 1], [0.5, 0.98], [0.82, 0.88], [0.96, 0.66], [1, 0.36], [1, 0.08],
    [1, -0.18], [0.97, -0.45], [0.86, -0.72], [0.6, -0.93], [0, -1]],
  // superellipse-ish fighter section: flat-ish top/belly, chined sides
  jet: [[0, 1], [0.45, 0.95], [0.78, 0.78], [0.95, 0.5], [1, 0.15], [0.98, -0.2],
    [0.88, -0.55], [0.62, -0.86], [0.3, -0.98], [0, -1]],
};
// Circle with n half-segments (n = 12 => 15 degree facets).
export function roundProfile(n = 12) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = Math.PI * i / n;
    out.push([Math.sin(a), Math.cos(a)]);
  }
  return out;
}

// --------------------------------------------------------------- lofts --

// Linear interpolation of lofting sections so long constant parts can be
// subdivided (window rows, panel lines).
function subdivide(sections, maxDx) {
  if (!maxDx) return sections;
  const out = [sections[0]];
  for (let i = 1; i < sections.length; i++) {
    const a = sections[i - 1], b = sections[i];
    const n = Math.max(1, Math.ceil(Math.abs(a.x - b.x) / maxDx));
    for (let k = 1; k <= n; k++) {
      const t = k / n, s = {};
      for (const key of Object.keys(b)) s[key] = a[key] + (b[key] - a[key]) * t;
      out.push(s);
    }
  }
  return out;
}

/**
 * Lofted body along x. sections: [{ x, y, w, t, b, z? }] — centre (x, y, z),
 * half-width w, height above centre t, depth below centre b. Ends with w > 0
 * are capped. paint({x,y,z, row, k, side}) -> hex, where row is the profile
 * segment index from the top centre (0) downwards, k the section index.
 */
export function loft(sections, { profile = PROFILE.cabin, paint, maxDx = 0 } = {}) {
  const secs = subdivide(sections, maxDx);
  const half = profile.length - 1;
  // full ring: right side top->bottom, then left side bottom->top (no dup ends)
  const ringIdx = [];
  for (let i = 0; i <= half; i++) ringIdx.push([i, 1]);
  for (let i = half - 1; i >= 1; i--) ringIdx.push([i, -1]);
  const rings = secs.map(s => ringIdx.map(([i, side]) => {
    const [pz, py] = profile[i];
    return [s.x, s.y + (py >= 0 ? s.t : s.b) * py, (s.z || 0) + side * s.w * pz];
  }));
  const T = new Tris();
  const N = ringIdx.length;
  for (let k = 0; k < secs.length - 1; k++) {
    const r0 = rings[k], r1 = rings[k + 1];
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      const row = Math.min(ringIdx[j][0], ringIdx[j1][0]);
      const c = centroid(r0[j], r0[j1], r1[j1], r1[j]);
      const side = c[2] >= (secs[k].z || 0) ? 1 : -1;
      const hex = paint ? paint({ x: c[0], y: c[1], z: c[2], row, k, side }) : 0xcccccc;
      T.quad(r0[j], r1[j], r1[j1], r0[j1], hex);
    }
  }
  for (const end of [0, secs.length - 1]) {
    const s = secs[end];
    if (s.w < 1e-4) continue;
    const ring = rings[end], ctr = [s.x, s.y, s.z || 0];
    const hex = paint ? paint({ x: s.x, y: s.y, z: s.z || 0, row: -1, k: end, side: 0, cap: true }) : 0xcccccc;
    for (let j = 0; j < N; j++) T.tri(ctr, ring[(j + 1) % N], ring[j], hex);
  }
  return T.geometry();
}

// ------------------------------------------------------------- airfoils --

const CHORD_PTS = [0, 0.02, 0.07, 0.16, 0.3, 0.46, 0.62, 0.78, 0.9, 1];
// NACA 4-digit thickness (closed trailing edge) and a parabolic camber line.
const thick = (c, t) => c >= 1 ? 0
  : 5 * t * (0.2969 * Math.sqrt(c) - 0.126 * c - 0.3516 * c * c + 0.2843 * c ** 3 - 0.1036 * c ** 4);
const camberAt = (c, m) => m * 4 * c * (1 - c);

// Closed loop of [c, s] pairs (s = +1 upper, -1 lower, 0 camber line) for the
// chord slice c0..c1. half: 'upper' | 'lower' keeps one side, closed along the
// camber line (split drag rudders).
function airfoilLoop(c0, c1, half) {
  const cs = [c0, ...CHORD_PTS.filter(c => c > c0 + 1e-3 && c < c1 - 1e-3), c1];
  const up = cs.slice().reverse().map(c => [c, 1]);        // TE -> LE along the top
  const lo = cs.map(c => [c, -1]);                          // LE -> TE along the bottom
  const mid = cs.map(c => [c, 0]);                          // LE -> TE on the camber line
  // Coincident points (sharp LE/TE) are harmless: Tris drops the zero-area
  // half of each quad that touches them.
  if (half === 'upper') return [...up, ...mid];
  if (half === 'lower') return [...mid.slice().reverse(), ...lo];
  return [...up, ...lo];
}

/**
 * Point on a lifting surface. station: { x, y, z } = leading edge, chord, t
 * (thickness/chord). tdir: thickness axis ([0,1,0] wings, [0,0,1] fins).
 */
export function surfacePoint(st, c, s, camber = 0, tdir = [0, 1, 0]) {
  const off = (camberAt(c, camber) + s * thick(c, st.t)) * st.chord;
  return [st.x - c * st.chord + tdir[0] * off, st.y + tdir[1] * off, st.z + tdir[2] * off];
}

// Interpolate a station at spanwise coordinate v along `axis` ('z' or 'y').
export function stationAt(stations, v, axis = 'z') {
  const key = axis;
  const sgn = Math.sign(stations[stations.length - 1][key] - stations[0][key]) || 1;
  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1], b = stations[i];
    if ((v - a[key]) * sgn >= -1e-6 && (b[key] - v) * sgn >= -1e-6) {
      const t = (v - a[key]) / ((b[key] - a[key]) || 1);
      const o = {};
      for (const k of ['x', 'y', 'z', 'chord', 't']) o[k] = a[k] + (b[k] - a[k]) * t;
      return o;
    }
  }
  return { ...stations[v * sgn < stations[0][key] * sgn ? 0 : stations.length - 1] };
}

/**
 * Lofted lifting surface through `stations` (root first), chord slice c0..c1.
 * paint({x,y,z, up}) -> hex. spanDiv subdivides between stations (livery).
 */
export function surface(stations, { c0 = 0, c1 = 1, camber = 0, tdir = [0, 1, 0], paint, half, spanDiv = 1, caps = true } = {}) {
  let sts = stations;
  if (spanDiv > 1) {
    sts = [stations[0]];
    for (let i = 1; i < stations.length; i++) {
      for (let k = 1; k <= spanDiv; k++) {
        const t = k / spanDiv, a = stations[i - 1], b = stations[i], o = {};
        for (const key of ['x', 'y', 'z', 'chord', 't']) o[key] = a[key] + (b[key] - a[key]) * t;
        sts.push(o);
      }
    }
  }
  const loop = airfoilLoop(c0, c1, half);
  const rings = sts.map(st => loop.map(([c, s]) => surfacePoint(st, c, s, camber, tdir)));
  const T = new Tris();
  const N = loop.length;
  for (let k = 0; k < sts.length - 1; k++) {
    for (let j = 0; j < N; j++) {
      const j1 = (j + 1) % N;
      const a = rings[k][j], b = rings[k][j1], c = rings[k + 1][j1], d = rings[k + 1][j];
      const ce = centroid(a, b, c, d);
      const up = loop[j][1] + loop[j1][1] > 0;
      T.quad(a, b, c, d, paint ? paint({ x: ce[0], y: ce[1], z: ce[2], up }) : 0xcccccc);
    }
  }
  if (caps) {
    for (const end of [0, sts.length - 1]) {
      const ring = rings[end], ctr = centroid(...ring);
      const hex = paint ? paint({ x: ctr[0], y: ctr[1], z: ctr[2], up: true, cap: true }) : 0xcccccc;
      for (let j = 0; j < N; j++) T.tri(ctr, ring[j], ring[(j + 1) % N], hex);
    }
  }
  return T.geometry();
}

/**
 * Control surface hinged on the line A->B (model coords). The geometry is
 * re-centred on A; set(angle) rotates about A->B (right-hand rule), so with
 * A at the root and B at the tip the same sign moves both sides' surfaces the
 * same way relative to their own span direction.
 */
export function hinged(geo, mat, A, B) {
  const pivot = new THREE.Group();
  pivot.position.set(A[0], A[1], A[2]);
  geo.translate(-A[0], -A[1], -A[2]);
  const mesh = new THREE.Mesh(geo, mat);
  pivot.add(mesh);
  const axis = new THREE.Vector3(B[0] - A[0], B[1] - A[1], B[2] - A[2]).normalize();
  const slide = new THREE.Vector3();
  return {
    obj: pivot, mesh, axis,
    set(a) { pivot.quaternion.setFromAxisAngle(axis, a); },
    // Fowler-style aft travel (flaps): metres along -x
    slide(d) { slide.set(A[0] - d, A[1], A[2]); pivot.position.copy(slide); },
  };
}

/**
 * A complete wing (or tail) half: fixed box LE..hingeC plus trailing pieces —
 * hinged `surfaces` ([{ from, to, key }] in spanwise coords) and fixed fill
 * everywhere else. Returns { group, [key]: hinged } in model coordinates.
 */
export function wingHalf(stations, { hingeC = 0.74, surfaces = [], camber = 0, tdir = [0, 1, 0],
  axis = 'z', paint, mat, spanDiv = 1 }) {
  const group = new THREE.Group();
  const out = { group };
  group.add(new THREE.Mesh(surface(stations, { c1: hingeC, camber, tdir, paint, spanDiv }), mat));
  const s0 = stations[0][axis], s1 = stations[stations.length - 1][axis];
  const sgn = Math.sign(s1 - s0) || 1;
  // spanwise slices between the given stations and the surface edges
  const cuts = new Set([s0, s1]);
  stations.forEach(s => cuts.add(s[axis]));
  surfaces.forEach(s => { cuts.add(s.from); cuts.add(s.to); });
  const sorted = [...cuts].sort((a, b) => (a - b) * sgn);
  const within = (v, s) => (v - s.from) * sgn >= -1e-6 && (s.to - v) * sgn >= -1e-6;
  // fixed trailing fill: consecutive slices not covered by any surface
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const sts = run.map(v => stationAt(stations, v, axis));
      group.add(new THREE.Mesh(surface(sts, { c0: hingeC, camber, tdir, paint }), mat));
    }
    run = [];
  };
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    const mid = i < sorted.length - 1 ? (v + sorted[i + 1]) / 2 : null;
    const covered = mid != null && surfaces.some(s => within(mid, s));
    run.push(v);
    if (covered || mid == null) flush();
    if (covered) run = [];
  }
  for (const s of surfaces) {
    if (s.skip) continue;                      // caller builds this span itself
    const vs = sorted.filter(v => within(v, s));
    const sts = vs.map(v => stationAt(stations, v, axis));
    const geo = surface(sts, { c0: hingeC + 0.012, camber, tdir, paint });   // small hinge gap
    const A = surfacePoint(sts[0], hingeC, 0, camber, tdir);
    const B = surfacePoint(sts[sts.length - 1], hingeC, 0, camber, tdir);
    const h = hinged(geo, mat, A, B);
    group.add(h.obj);
    out[s.key] = h;
  }
  return out;
}

// Mirror a list of right-side stations to the left (z -> -z).
export const mirrorZ = (sts) => sts.map(s => ({ ...s, z: -s.z }));

// ---------------------------------------------------------------- parts --

const _up = new THREE.Vector3(0, 1, 0);
/** Cylinder between two points (struts, gear legs, pylons). */
export function rod(a, b, r, mat, seg = 6) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_up, B.sub(A).normalize());
  return m;
}

/** Tyre + hub, axle along z, centred at (x, y, z). Returns the spinning group. */
export function wheel(R, W, tireMat, hubMat, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(R, R, W, 14), tireMat);
  tire.rotation.x = Math.PI / 2;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.5, R * 0.5, W * 1.08, 8), hubMat);
  hub.rotation.x = Math.PI / 2;
  g.add(tire, hub);
  return g;
}

/** Wheel-centre height for a gear contact point: tyre radius + a little static squash. */
export const wheelY = (gearPt, R, squash = 0.06) => gearPt.r.y + R + squash;

/** Prop blade: a twisted, tapered airfoil from the hub outwards along +y. */
export function bladeGeo(radius, rootChord, tipChord, color, tipColor = color) {
  const sts = [
    { x: rootChord * 0.4, y: 0.12, z: 0, chord: rootChord, t: 0.2 },
    { x: rootChord * 0.45, y: radius * 0.55, z: 0, chord: rootChord * 1.1, t: 0.1 },
    { x: tipChord * 0.45, y: radius * 0.9, z: 0, chord: tipChord * 1.2, t: 0.09 },
    { x: tipChord * 0.4, y: radius, z: 0, chord: tipChord, t: 0.08 },
  ];
  const g = surface(sts, { tdir: [0, 0, 1], paint: ({ y }) => y > radius * 0.9 ? tipColor : color });
  // chord into the plane of rotation, then a coarse pitch
  g.rotateY(Math.PI / 2 - 0.35);
  return g;
}
