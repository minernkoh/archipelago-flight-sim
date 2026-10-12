// AI circuit traffic (v12): a club aircraft flying real touch-and-goes on the
// map's runway, so the tower has someone to sequence you with. THREE-free and
// a pure function of time (like the rest of traffic.js), which makes it free
// to evaluate from the ATC state machine and from the headless tests.
//
// The path is a closed Catmull-Rom loop through waypoints in the runway frame
// (u along the runway, v to the right, y above the runway): touchdown at the
// same aim point as the PAPI and the APR glideslope (spawn + 300 m), a ground
// roll, lift-off, upwind, a left crosswind and downwind at 300 m, base, and a
// 3 degree final. It never collides with anything (visual + radio only).

const GS = Math.tan(3 * Math.PI / 180);

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return p1 + 0.5 * ((p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
}

/**
 * @param {object} rwy map.runway ({ spawn, headingRad, y, x0, x1 })
 * @param {object} [o] { speed m/s, type label for the radio }
 */
export function createCircuitTraffic(rwy, { speed = 40, type = 'Cessna' } = {}) {
  const h = rwy.headingRad;
  const fx = Math.cos(h), fz = -Math.sin(h), rx = Math.sin(h), rz = Math.cos(h);
  const spawnU = rwy.spawn.x * fx + rwy.spawn.z * fz;
  const aim = spawnU + 300;
  const x1 = Number.isFinite(rwy.x1) ? rwy.x1 : aim + 1200;
  const lift = Math.max(aim + 120, Math.min(aim + 450, x1 - 60));
  // [u, v, y, phase of the leg that STARTS at this waypoint]
  const W = [
    [aim, 0, 0, 'runway'], [lift, 0, 0, 'upwind'],
    [lift + 700, 0, 70, 'upwind'], [lift + 1500, 0, 160, 'crosswind'],
    [lift + 2100, -400, 240, 'crosswind'], [lift + 2100, -1100, 300, 'downwind'],
    [aim + 400, -1250, 300, 'downwind'], [aim - 1200, -1250, 300, 'base'],
    [aim - 2200, -1000, 250, 'base'], [aim - 2500, -350, 190, 'final'],
    [aim - 2400, 0, 2400 * GS, 'final'], [aim - 1200, 0, 1200 * GS, 'final'], [aim - 400, 0, 400 * GS, 'final'],
  ];
  // dense arc-length table
  const pts = [];
  const n = W.length, SUB = 40;
  for (let i = 0; i < n; i++) {
    const a = W[(i - 1 + n) % n], b = W[i], c = W[(i + 1) % n], d = W[(i + 2) % n];
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB;
      let y = catmull(a[2], b[2], c[2], d[2], t);
      // the ground roll is ON the runway, and nothing dips below it
      if (b[3] === 'runway') y = 0;
      pts.push({ u: catmull(a[0], b[0], c[0], d[0], t), v: catmull(a[1], b[1], c[1], d[1], t), y: Math.max(0, y), phase: b[3] });
    }
  }
  const cum = new Float64Array(pts.length + 1);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    cum[i + 1] = cum[i] + Math.hypot(q.u - p.u, q.v - p.v, q.y - p.y);
  }
  const total = cum[pts.length];

  const out = { x: 0, y: 0, z: 0, u: 0, v: 0, yaw: 0, pitch: 0, bank: 0, phase: 'final', onRunway: false, toAim: 0, type };
  function locate(s) {
    s = ((s % total) + total) % total;
    let lo = 0, hi = pts.length;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const p = pts[lo], q = pts[(lo + 1) % pts.length];
    const f = (s - cum[lo]) / Math.max(1e-6, cum[lo + 1] - cum[lo]);
    return { u: p.u + (q.u - p.u) * f, v: p.v + (q.v - p.v) * f, y: p.y + (q.y - p.y) * f, phase: p.phase };
  }
  return {
    total, speed, type,
    /** Pose and radio-relevant state at time t (seconds). Reuses one object. */
    at(t) {
      const s = t * speed;
      const a = locate(s), b = locate(s + 8), c = locate(s + 40);
      out.u = a.u; out.v = a.v;
      out.x = fx * a.u + rx * a.v; out.z = fz * a.u + rz * a.v; out.y = (rwy.y || 0) + a.y;
      const du = b.u - a.u, dv = b.v - a.v, dy = b.y - a.y;
      const wx = fx * du + rx * dv, wz = fz * du + rz * dv;
      out.yaw = Math.atan2(-wz, wx);                              // sim heading convention
      out.pitch = Math.atan2(dy, Math.hypot(du, dv));
      // bank from the turn rate: heading change over the next 40 m
      const h1 = Math.atan2(dv, du), h2 = Math.atan2(c.v - b.v, c.u - b.u);
      let dh = h2 - h1; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      const turnRate = dh / (32 / speed);
      out.bank = a.y > 2 ? Math.max(-0.6, Math.min(0.6, Math.atan(speed * turnRate / 9.81))) : 0;
      out.phase = a.phase;
      out.onRunway = a.phase === 'runway' || (a.phase === 'final' && a.y < 15);
      out.toAim = aim - a.u;                                      // + = before the aim point
      return out;
    },
  };
}

/** "two o'clock": clock position of (dx, dz) relative to a heading (sim convention). */
export function clockOf(headingRad, dx, dz) {
  const brg = Math.atan2(-dz, dx);                               // same convention as heading
  let rel = headingRad - brg;                                    // + = to the right
  while (rel < 0) rel += 2 * Math.PI;
  const c = Math.round(rel / (Math.PI / 6)) % 12;
  return c === 0 ? 12 : c;
}

/**
 * An airliner's cycle (v12): a straight-in ILS arrival from `out` m on the
 * 3 deg glideslope to the aim point, rollout, and a taxi turn off the runway
 * to the right; then, half a cycle later, a departure: it lines up 400 m
 * down the runway (ahead of the player's spawn), takes off and climbs out.
 * The circuit traffic repeats every half cycle, so the departure falls in
 * the same clear window the arrival was slotted into (slotStraightIn).
 */
export function createStraightInTraffic(rwy, { out = 14000, vapp = 72, period = 596, offset = 0, type = 'Heavy jet' } = {}) {
  const h = rwy.headingRad;
  const fx = Math.cos(h), fz = -Math.sin(h), rx = Math.sin(h), rz = Math.cos(h);
  const spawnU = rwy.spawn.x * fx + rwy.spawn.z * fz;
  const aim = spawnU + 300;
  const x1 = Number.isFinite(rwy.x1) ? rwy.x1 : aim + 2500;
  const GSL = Math.tan(3 * Math.PI / 180);
  const tFinal = out / vapp;                                  // seconds on the glideslope
  const decel = 2.2, vTaxi = 12;
  const rollLen = Math.max(200, Math.min((vapp * vapp - vTaxi * vTaxi) / (2 * decel), x1 - aim - 150));
  const tRoll = (vapp - Math.sqrt(Math.max(vTaxi * vTaxi, vapp * vapp - 2 * decel * rollLen))) / decel;
  const uExit = aim + vapp * tRoll - 0.5 * decel * tRoll * tRoll;
  const TR = 45, tTurn = (Math.PI / 2 * TR) / vTaxi, tTaxi = tTurn + 160 / vTaxi;
  // departure: start of its roll (cycle time), acceleration, rotate speed, climb
  const dep0 = tFinal - 20 + period / 2, accel = 2.0, vRot = 68, uDep = spawnU + 400;
  const tTO = vRot / accel, tClimb = 4000 / 75, climb = Math.tan(8 * Math.PI / 180);
  const out_ = { x: 0, y: 0, z: 0, u: 0, v: 0, yaw: h, pitch: 0, bank: 0, phase: 'gone', onRunway: false, toAim: 1e9,
    type, heavy: true, speed: 0, agl: 0, visible: false, departing: false };
  const put = (u, v, y, yaw, spd) => {
    out_.visible = true; out_.u = u; out_.v = v; out_.speed = spd; out_.agl = y;
    out_.x = fx * u + rx * v; out_.z = fz * u + rz * v; out_.y = (rwy.y || 0) + y; out_.yaw = yaw; out_.bank = 0;
    return out_;
  };
  return {
    period, tFinal, tRoll, tTaxi, dep0, tTO, tClimb,
    /** Cycle time (s) at absolute time t; 0 = the arrival appears on the extended centreline. */
    cycle(t) { return (((t + offset) % period) + period) % period; },
    at(t) {
      const c = this.cycle(t);
      out_.departing = false;
      if (c < tFinal) {                                          // final
        const u = aim - out + vapp * c;
        let y = (aim - u) * GSL;
        if (aim - u < 400) y *= 0.55 + 0.45 * (aim - u) / 400;   // the flare: shallower over the threshold
        out_.phase = 'final'; out_.pitch = aim - u < 400 ? 0.05 : 0.035;
        put(u, 0, y, h, vapp);
        out_.onRunway = y < 15; out_.toAim = aim - u;
        return out_;
      }
      if (c < tFinal + tRoll) {                                  // landing roll
        const tr = c - tFinal;
        out_.phase = 'runway'; out_.pitch = 0;
        put(aim + vapp * tr - 0.5 * decel * tr * tr, 0, 0, h, vapp - decel * tr);
        out_.onRunway = true; out_.toAim = aim - out_.u;
        return out_;
      }
      if (c < tFinal + tRoll + tTaxi) {                          // turn off to the right and taxi clear
        const tt = c - tFinal - tRoll;
        out_.phase = 'taxi'; out_.pitch = 0;
        if (tt < tTurn) {
          const a = tt * vTaxi / TR;                             // 0 .. pi/2
          put(uExit + TR * Math.sin(a), TR * (1 - Math.cos(a)), 0, h - a, vTaxi);
        } else put(uExit + TR, TR + (tt - tTurn) * vTaxi, 0, h - Math.PI / 2, vTaxi);
        out_.onRunway = out_.v < 40; out_.toAim = 1e9;
        return out_;
      }
      if (c >= dep0 && c < dep0 + tTO + tClimb) {                // departure
        const td = c - dep0;
        out_.departing = true;
        if (td < tTO) {
          out_.phase = 'departure'; out_.pitch = 0;
          put(uDep + 0.5 * accel * td * td, 0, 0, h, accel * td);
          out_.onRunway = true;
        } else {
          const tc = td - tTO, d = vRot * tc;
          out_.phase = 'climb'; out_.pitch = 0.14;
          put(uDep + 0.5 * accel * tTO * tTO + d, 0, d * climb, h, vRot);
          out_.onRunway = out_.agl < 15;
        }
        out_.toAim = 1e9;
        return out_;
      }
      out_.phase = 'gone'; out_.visible = false; out_.onRunway = false; out_.toAim = 1e9; out_.speed = 0;
      return out_;
    },
  };
}

/**
 * The airliner, timed into the circuit: its last 1.5 km and rollout must fall
 * in a gap where neither club aircraft (`circuit` at t and t + spacing) is on
 * short final or the runway. Both cycles repeat every two circuit laps.
 */
export function slotStraightIn(rwy, circuit, spacing) {
  const clubPeriod = circuit.total / circuit.speed;
  const busy = (t) => [0, spacing].some(o => { const a = circuit.at(t + o); return a.onRunway || (a.phase === 'final' && a.toAim < 1500); });
  const probe = createStraightInTraffic(rwy, { period: 2 * clubPeriod });
  const t0 = probe.tFinal - 1500 / 72 - 6, t1 = Math.max(probe.tFinal + probe.tRoll + 10, probe.dep0 - probe.period / 2 + probe.tTO + 8);
  for (let off = 0; off < 2 * clubPeriod; off += 2) {
    let ok = true;
    // with offset `off` the jet's cycle time c happens at absolute t = c - off
    for (let c = t0; c <= t1 && ok; c += 0.5) if (busy(c - off)) ok = false;
    if (ok) return Object.assign(createStraightInTraffic(rwy, { period: 2 * clubPeriod, offset: off }), { slotted: true });
  }
  return Object.assign(createStraightInTraffic(rwy, { period: 2 * clubPeriod }), { slotted: false });   // no gap: still fly it
}
