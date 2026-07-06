// Wind field: steady vector + gusts + low-altitude mechanical turbulence.
// THREE-free (headless tests drive it). Compass dirDeg = direction the wind
// blows FROM (aviation convention); world: x east, z south.

const KT2MS = 0.514444;

function hash(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5;
}
// smooth 1D value noise over time, seeded per channel
function noise1(t, seed) {
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  return hash(i * 7 + seed) * (1 - u) + hash((i + 1) * 7 + seed) * u;
}

export const WEATHER = {
  calm:   { kts: 0,  gustKts: 0,  turb: 0 },
  breezy: { kts: 8,  gustKts: 5,  turb: 0.35 },
  gusty:  { kts: 16, gustKts: 12, turb: 1.0 },
};

export function createWind() {
  let dirDeg = 270, kts = 0, gustKts = 0, turb = 0;
  let ux = 0, uz = 0;   // unit vector the wind blows TOWARD
  let t = 0;

  function recompute() {
    const c = dirDeg * Math.PI / 180;
    ux = -Math.sin(c);  // from-north (0°) blows toward south (+z)
    uz = Math.cos(c);
  }
  recompute();

  return {
    set(opts = {}) {
      if (opts.dirDeg != null) dirDeg = opts.dirDeg;
      if (opts.kts != null) kts = opts.kts;
      if (opts.gustKts != null) gustKts = opts.gustKts;
      if (opts.turb != null) turb = opts.turb;
      recompute();
    },
    setTime(elapsed) { t = elapsed; },
    get() { return { dirDeg, kts, gustKts, turb }; },
    // world-frame wind velocity (m/s) at a position
    at(x, y, z) {
      const gust = gustKts * KT2MS * (0.5 + 0.5 * noise1(t * 0.25, 11)) * noise1(t * 0.7, 23) * 2;
      const speed = kts * KT2MS + gust;
      // mechanical turbulence: strongest near the surface, dies off by ~500 m
      const tk = turb * Math.max(0, 1 - y / 500) * 1.8;
      return {
        x: ux * speed + tk * noise1(t * 1.9 + x * 0.01, 31),
        y: tk * 0.7 * noise1(t * 2.3 + z * 0.01, 47),
        z: uz * speed + tk * noise1(t * 1.7 + x * 0.013, 59),
      };
    },
  };
}
