// Minimal 3D math for the flight model — plain objects, no Three.js,
// so the physics can run headless under Node for testing.
// World frame: x east, y up, z south (matches Three.js).
// Body frame:  x forward, y up, z right (right-handed).

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });

export function vAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
export function vSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function vScale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
export function vDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function vCross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
export function vLen(a) { return Math.hypot(a.x, a.y, a.z); }
export function vNorm(a) {
  const l = vLen(a);
  return l > 1e-9 ? vScale(a, 1 / l) : v3();
}

// Quaternion {x,y,z,w}, body -> world rotation.
export const qIdent = () => ({ x: 0, y: 0, z: 0, w: 1 });

export function qMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function qNormalize(q) {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

export function qConj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }

// Rotate vector by quaternion (body -> world when q is orientation).
export function qRot(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

export function qRotInv(q, v) { return qRot(qConj(q), v); }

// Quaternion from axis-angle about a world axis.
export function qAxisAngle(axis, angle) {
  const h = angle / 2, s = Math.sin(h);
  return qNormalize({ x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) });
}

// Integrate body angular velocity into orientation: q' = q + 0.5*q*(0,w)*dt
export function qIntegrate(q, omegaBody, dt) {
  const w = { x: omegaBody.x, y: omegaBody.y, z: omegaBody.z, w: 0 };
  const dq = qMul(q, w);
  return qNormalize({
    x: q.x + 0.5 * dq.x * dt,
    y: q.y + 0.5 * dq.y * dt,
    z: q.z + 0.5 * dq.z * dt,
    w: q.w + 0.5 * dq.w * dt,
  });
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;
