// Taxiway network for the AI airliner (v12). THREE-free so the headless tests
// and the pure-function-of-time traffic can use it.
//
// A layout is a set of taxiway centrelines in world metres ([x, z] points)
// plus a stand. buildTaxiGraph() merges shared vertices (OSM ways share their
// junction nodes, the synthetic layout shares them by construction) and splits
// a segment where another line's free end lands on it (a T junction).
// route() is Dijkstra over that graph; timedPath() fillets the corners and
// builds a speed profile (slow in the turns, gentle acceleration and braking)
// so the aircraft is a pure function of time along it.

const hyp = Math.hypot;

/**
 * The fictional maps' airfield: a parallel taxiway on the LEFT of the runway
 * (the club apron and hangar are on the right), connectors at the departure
 * point (spawn + 400 m, the same intersection the airliner always used), the
 * far end and, on a long runway, half way, and a remote stand on the parallel
 * between the departure connector and the exits. Every map flattens +-90 m
 * around its runway, so all of it sits on the runway plane.
 */
export function defaultTaxiLayout(rwy, { side = -1, offset = 78, width = 23 } = {}) {
  const h = rwy.headingRad;
  const fx = Math.cos(h), fz = -Math.sin(h), rx = Math.sin(h), rz = Math.cos(h);
  const W = (u, v) => [fx * u + rx * v, fz * u + rz * v];
  const spawnU = rwy.spawn.x * fx + rwy.spawn.z * fz;
  const x0 = Number.isFinite(rwy.x0) ? rwy.x0 : spawnU - 60;
  const x1 = Number.isFinite(rwy.x1) ? rwy.x1 : spawnU + 2500;
  const V = side * offset, hw = rwy.halfWidth || 15;
  const uDep = Math.min(spawnU + 400, x1 - 400), uEnd = x1 - 40;
  const conn = [uDep, uEnd];
  if (uEnd - uDep > 1100) conn.splice(1, 0, (uDep + uEnd) / 2);
  const uStand = uDep + Math.min(170, (conn[1] - uDep) * 0.45);
  // the parallel carries a vertex at every connector and at the stand
  const us = [...new Set([uDep - 60, ...conn, uStand])].sort((a, b) => a - b);
  const lines = [us.map(u => W(u, V))];
  for (const u of conn) lines.push([W(u, 0), W(u, V * 0.5), W(u, V)]);
  // hold short bar: well clear of the runway edge, yet far enough from the
  // parallel that a heavy can stop with its nose behind it
  const holdV = side * Math.min(hw + 25, offset - width / 2 - 4);
  return {
    kind: 'default', width, lines,
    // parked facing back toward the departure connector, so the taxi-out
    // simply carries on along the parallel: no pushback needed
    stand: { x: W(uStand, V)[0], z: W(uStand, V)[1], yaw: h + Math.PI },
    holds: [W(uDep, holdV)], holdDist: Math.abs(holdV),
    connectors: conn,
    frame: { fx, fz, rx, rz, V, uStand, uDep, holdV },
  };
}

/** Graph from polylines. Vertices closer than `snap` m merge. */
export function buildTaxiGraph(lines, snap = 6) {
  const nodes = [], adj = [];
  const cell = new Map();
  const key = (x, z) => `${Math.floor(x / snap)},${Math.floor(z / snap)}`;
  function nodeAt(x, z) {
    const cx = Math.floor(x / snap), cz = Math.floor(z / snap);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const list = cell.get(`${cx + i},${cz + j}`);
      if (list) for (const n of list) if (hyp(nodes[n].x - x, nodes[n].z - z) < snap) return n;
    }
    const id = nodes.length;
    nodes.push({ x, z }); adj.push([]);
    const k = key(x, z);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(id);
    return id;
  }
  const link = (a, b) => {
    if (a === b || adj[a].some(e => e.to === b)) return;
    const len = hyp(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
    adj[a].push({ to: b, len }); adj[b].push({ to: a, len });
  };
  const unlink = (a, b) => { adj[a] = adj[a].filter(e => e.to !== b); adj[b] = adj[b].filter(e => e.to !== a); };
  for (const line of lines) {
    let prev = -1;
    for (const p of line) {
      const n = nodeAt(p[0], p[1]);
      if (prev >= 0) link(prev, n);
      prev = n;
    }
  }
  // T junctions: a free end lying on another segment splits that segment
  for (let n = 0; n < nodes.length; n++) {
    if (adj[n].length !== 1) continue;
    const P = nodes[n];
    let best = null;
    for (let a = 0; a < nodes.length; a++) for (const e of adj[a]) {
      const b = e.to;
      if (b < a || a === n || b === n) continue;
      const A = nodes[a], B = nodes[b];
      const dx = B.x - A.x, dz = B.z - A.z, L2 = dx * dx + dz * dz;
      if (L2 < 1) continue;
      const t = ((P.x - A.x) * dx + (P.z - A.z) * dz) / L2;
      if (t <= 0.02 || t >= 0.98) continue;
      const d = hyp(A.x + dx * t - P.x, A.z + dz * t - P.z);
      if (d < snap * 2 && (!best || d < best.d)) best = { a, b, d };
    }
    if (best) { unlink(best.a, best.b); link(best.a, n); link(n, best.b); }
  }
  return { nodes, adj };
}

export function nearestNode(g, x, z, accept = null) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < g.nodes.length; i++) {
    if (!g.adj[i].length || (accept && !accept(g.nodes[i], i))) continue;
    const d = hyp(g.nodes[i].x - x, g.nodes[i].z - z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Dijkstra: node ids from a to b, or null when they are not connected. */
export function route(g, a, b) {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const heap = [[0, a]];
  dist[a] = 0;
  while (heap.length) {
    // binary heap pop
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]]; i = m;
      }
    }
    const [d, u] = top;
    if (d > dist[u]) continue;
    if (u === b) break;
    for (const e of g.adj[u]) {
      const nd = d + e.len;
      if (nd < dist[e.to]) {
        dist[e.to] = nd; prev[e.to] = u;
        heap.push([nd, e.to]);
        for (let i = heap.length - 1; i > 0;) {
          const p = (i - 1) >> 1;
          if (heap[p][0] <= heap[i][0]) break;
          [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
        }
      }
    }
  }
  if (!Number.isFinite(dist[b])) return null;
  const ids = [];
  for (let v = b; v >= 0; v = prev[v]) ids.push(v);
  return ids.reverse();
}

/** Round every corner of a polyline with an arc of radius up to R. */
export function fillet(pts, R = 35) {
  const P = pts.filter((p, i) => i === 0 || hyp(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
  if (P.length < 3) return P.slice();
  const out = [P[0]];
  for (let i = 1; i < P.length - 1; i++) {
    const A = P[i - 1], B = P[i], C = P[i + 1];
    const l1 = hyp(B[0] - A[0], B[1] - A[1]), l2 = hyp(C[0] - B[0], C[1] - B[1]);
    const d1 = [(A[0] - B[0]) / l1, (A[1] - B[1]) / l1], d2 = [(C[0] - B[0]) / l2, (C[1] - B[1]) / l2];
    const cos = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]));
    const theta = Math.acos(cos);                      // interior angle at B
    if (theta > Math.PI - 0.02) { out.push(B); continue; }   // straight on
    // tangent distance for radius R, limited to under half of each leg
    let t = R / Math.tan(theta / 2);
    t = Math.min(t, l1 * 0.48, l2 * 0.48);
    const r = t * Math.tan(theta / 2);
    const T1 = [B[0] + d1[0] * t, B[1] + d1[1] * t], T2 = [B[0] + d2[0] * t, B[1] + d2[1] * t];
    // arc centre along the bisector
    const bx = d1[0] + d2[0], bz = d1[1] + d2[1], bl = hyp(bx, bz) || 1;
    const cd = r / Math.sin(theta / 2);
    const O = [B[0] + bx / bl * cd, B[1] + bz / bl * cd];
    const a0 = Math.atan2(T1[1] - O[1], T1[0] - O[0]);
    let a1 = Math.atan2(T2[1] - O[1], T2[0] - O[0]);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    const n = Math.max(2, Math.ceil(Math.abs(da) / 0.12));
    for (let k = 0; k <= n; k++) {
      const a = a0 + da * k / n;
      out.push([O[0] + Math.cos(a) * r, O[1] + Math.sin(a) * r]);
    }
  }
  out.push(P[P.length - 1]);
  return out;
}

/**
 * A path with a speed profile: `vmax` on the straights, sqrt(alat * radius)
 * in the turns, accelerating at `acc` and braking at `dec`, from `v0` to `v1`.
 * at(t) -> { x, z, yaw (sim convention), speed, s }.
 */
export function timedPath(pts, { vmax = 9, alat = 0.9, acc = 0.6, dec = 0.8, v0 = 0, v1 = 0, vmin = 2.5 } = {}) {
  // resample every ~2 m
  const S = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const A = pts[i - 1], B = pts[i], L = hyp(B[0] - A[0], B[1] - A[1]);
    const n = Math.max(1, Math.ceil(L / 2));
    for (let k = 1; k <= n; k++) S.push([A[0] + (B[0] - A[0]) * k / n, A[1] + (B[1] - A[1]) * k / n]);
  }
  const n = S.length;
  const s = new Float64Array(n), v = new Float64Array(n), t = new Float64Array(n), yaw = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + hyp(S[i][0] - S[i - 1][0], S[i][1] - S[i - 1][1]);
  for (let i = 0; i < n; i++) {
    const a = S[Math.max(0, i - 1)], b = S[Math.min(n - 1, i + 1)];
    yaw[i] = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
  }
  // curvature limit from the heading change over +-6 m
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 3), i1 = Math.min(n - 1, i + 3);
    let dh = yaw[i1] - yaw[i0];
    while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    const ds = Math.max(1e-3, s[i1] - s[i0]);
    const k = Math.abs(dh) / ds;
    v[i] = Math.max(vmin, Math.min(vmax, k > 1e-4 ? Math.sqrt(alat / k) : vmax));
  }
  v[0] = Math.min(v[0], v0); v[n - 1] = Math.min(v[n - 1], v1);
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * acc * (s[i] - s[i - 1])));
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * dec * (s[i + 1] - s[i])));
  for (let i = 1; i < n; i++) t[i] = t[i - 1] + (s[i] - s[i - 1]) / Math.max(0.3, (v[i] + v[i - 1]) / 2);
  const out = { x: 0, z: 0, yaw: 0, speed: 0, s: 0 };
  return {
    length: s[n - 1], duration: t[n - 1], points: S,
    at(tt) {
      tt = Math.max(0, Math.min(t[n - 1], tt));
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= tt) lo = m; else hi = m; }
      const f = (tt - t[lo]) / Math.max(1e-6, t[hi] - t[lo]);
      out.x = S[lo][0] + (S[hi][0] - S[lo][0]) * f;
      out.z = S[lo][1] + (S[hi][1] - S[lo][1]) * f;
      let dy = yaw[hi] - yaw[lo];
      while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
      out.yaw = yaw[lo] + dy * f;
      out.speed = v[lo] + (v[hi] - v[lo]) * f;
      out.s = s[lo] + (s[hi] - s[lo]) * f;
      return out;
    },
    /** First time the path comes within `dist` of the runway centreline (|v| <= dist). */
    timeToReach(pred) { for (let i = 0; i < n; i++) if (pred(S[i][0], S[i][1])) return t[i]; return t[n - 1]; },
  };
}

/**
 * Plan the airliner's ground movements on a layout: rollout exit, taxi-in to
 * the stand, taxi-out to the hold short line, line-up. Returns null when the
 * layout cannot serve this runway (no connector ahead of the touchdown, the
 * stand is not connected), so the caller keeps its simple turn-off.
 */
export function planGround(rwy, layout, { aim, vapp, minRoll = 700 } = {}) {
  if (!layout || !layout.lines?.length || !layout.stand) return null;
  const h = rwy.headingRad;
  const fx = Math.cos(h), fz = -Math.sin(h), rx = Math.sin(h), rz = Math.cos(h);
  const U = (x, z) => x * fx + z * fz, Vf = (x, z) => x * rx + z * rz;
  const W = (u, v) => [fx * u + rx * v, fz * u + rz * v];
  const hw = rwy.halfWidth || 20;
  const spawnU = rwy.spawn.x * fx + rwy.spawn.z * fz;
  const x1 = Number.isFinite(rwy.x1) ? rwy.x1 : aim + 2500;
  const g = buildTaxiGraph(layout.lines);
  const onRwy = (p) => Math.abs(Vf(p.x, p.z)) < hw + 12 && U(p.x, p.z) > spawnU - 200 && U(p.x, p.z) < x1 + 30;
  const rwyNodes = g.nodes.map((p, i) => i).filter(i => g.adj[i].length && onRwy(g.nodes[i]));
  if (!rwyNodes.length) return null;
  const standNode = nearestNode(g, layout.stand.x, layout.stand.z);
  if (standNode < 0 || hyp(g.nodes[standNode].x - layout.stand.x, g.nodes[standNode].z - layout.stand.z) > 250) return null;
  // exit: the first connector past the minimum rollout, else the last one ahead
  const ahead = rwyNodes.map(i => ({ i, u: U(g.nodes[i].x, g.nodes[i].z) })).filter(e => e.u > aim + 350).sort((a, b) => a.u - b.u);
  if (!ahead.length) return null;
  const exit = ahead.find(e => e.u >= aim + minRoll) || ahead[ahead.length - 1];
  // the runway node must lead off the runway (not just be another runway vertex)
  const inIds = route(g, exit.i, standNode);
  if (!inIds) return null;
  const pt = (i) => [g.nodes[i].x, g.nodes[i].z];
  const centre = (u) => W(u, 0);
  const inPts = [W(exit.u - 60, 0), centre(exit.u), ...inIds.map(pt)];
  if (hyp(inPts.at(-1)[0] - layout.stand.x, inPts.at(-1)[1] - layout.stand.z) > 1) inPts.push([layout.stand.x, layout.stand.z]);
  // departure: the connector nearest spawn + 400 that leaves a usable roll
  const dep = rwyNodes.map(i => ({ i, u: U(g.nodes[i].x, g.nodes[i].z) }))
    .filter(e => e.u > spawnU + 100 && e.u < x1 - 350)
    .sort((a, b) => Math.abs(a.u - (spawnU + 400)) - Math.abs(b.u - (spawnU + 400)))[0];
  if (!dep) return null;
  const outIds = route(g, standNode, dep.i);
  if (!outIds) return null;
  const outPts = [[layout.stand.x, layout.stand.z], ...outIds.map(pt)];
  // up to the hold short line, then the line-up onto the centreline
  const holdDist = layout.holdDist ?? hw + 60;
  const taxiOut = timedPath(fillet(outPts), {});
  // cut the taxi-out at the hold: stop where the NOSE (~32 m ahead of the
  // reference point) reaches the bar
  const P = taxiOut.points, NOSE = 34;
  let k = P.findIndex((p, i) => {
    const q = P[Math.min(P.length - 1, i + 1)], o = P[Math.max(0, i - 1)];
    const L = hyp(q[0] - o[0], q[1] - o[1]) || 1;
    const nx = p[0] + (q[0] - o[0]) / L * NOSE, nz = p[1] + (q[1] - o[1]) / L * NOSE;   // straight ahead of the heading
    return Math.abs(Vf(nx, nz)) < holdDist && U(nx, nz) > spawnU - 200;
  });
  if (k < 1) k = P.length - 1;
  const toHold = timedPath(taxiOut.points.slice(0, k + 1), {});
  const holdP = taxiOut.points[k];
  const lineup = timedPath(fillet([holdP, centre(dep.u), W(dep.u + 80, 0)], 30), { vmax: 6, v1: 0 });
  const standYaw = (() => {
    const p = inPts.at(-1), q = inPts.at(-2);
    return Math.atan2(-(p[1] - q[1]), p[0] - q[0]);
  })();
  const outYaw = toHold.at(0.5).yaw;
  let turn = outYaw - standYaw;
  while (turn > Math.PI) turn -= 2 * Math.PI; while (turn < -Math.PI) turn += 2 * Math.PI;
  return {
    graph: g, exitU: exit.u, depU: dep.u + 80,
    taxiIn: timedPath(fillet(inPts), { v0: 12, vmax: 9 }),
    toHold, lineup, standYaw,
    // a parked aircraft facing away from its route out is pushed back and
    // turned on the stand first (a tug, 25 s)
    pushback: Math.abs(turn) > 1.2 ? 25 : 0, pushTurn: turn,
    rwyFrame: { U, V: Vf },
  };
}
