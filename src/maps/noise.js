// Shared seeded value-noise for COSMETIC map layers only: forest masks, meadow
// patches, tree scatter. Terrain HEIGHT keeps each map's own private noise —
// physics ground contact (and the headless state hashes) depend on it, so
// nothing here may ever feed map.height().
//
// THREE-free on purpose, so headless tests can sample it.

export function makeNoise(seed) {
  function hash2(ix, iz) {
    let n = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ seed;
    n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
    n ^= n >>> 13;
    return (n >>> 0) / 4294967296;
  }
  const sstep = t => t * t * (3 - 2 * t);
  function noise2(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const u = sstep(fx), v = sstep(fz);
    const a = hash2(ix, iz), b = hash2(ix + 1, iz);
    const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, z, oct = 3) {
    let amp = 0.5, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * noise2(x * f, z * f);
      norm += amp; amp *= 0.5; f *= 2;
    }
    return sum / norm; // 0..1
  }
  return { hash2, noise2, fbm };
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Generic woodland mask: big contiguous forests from low-frequency fbm, plus a
 * thin scatter of lone trees so open meadow is not perfectly bare. 0..1.
 * `scale` is metres per noise cell (bigger = larger forests).
 */
export function woodland(nz, x, z, scale = 450, cover = 0.5) {
  const f = nz.fbm(x / scale, z / scale, 3);
  const lo = 0.62 - cover * 0.2;
  return Math.max(smoothstep(lo, lo + 0.12, f), 0.02);
}
