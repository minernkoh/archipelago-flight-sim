// Shared heightfield -> canvas bake.
//
// Three places want a top-down raster of a map's terrain: the in-flight minimap
// (src/minimap.js), the flight planner's chart (src/planner.js) and the menu's
// map preview (src/menupreview.js). Sampling map.height on a grid is O(grid²),
// so per CLAUDE.md this must NEVER run inside a rAF loop — callers bake once per
// map and cache the result by map id.
//
// The shade callback keeps the palette with the caller: the planner and the menu
// want an editorial chart ramp, the minimap wants its own urban tint.

/**
 * Bake map.height over a square world region into an offscreen canvas.
 *
 * @param {object}   map    FlightMap (only .height is read)
 * @param {object}   bounds { minX, minZ, span } — square world window in metres
 * @param {number}   grid   samples per side (O(grid²) height calls — keep ≤128)
 * @param {(h:number, slope:number, out:{r,g,b}) => void} shade
 *        writes 0-255 channels for a sample; slope is a normalised 0..1 estimate
 * @returns {HTMLCanvasElement} grid×grid canvas, ready to drawImage
 */
export function bakeHeightfield(map, bounds, grid, shade) {
  const cv = document.createElement('canvas');
  cv.width = grid; cv.height = grid;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(grid, grid);
  const step = bounds.span / (grid - 1);
  const out = { r: 0, g: 0, b: 0 };
  for (let iz = 0; iz < grid; iz++) {
    const z = bounds.minZ + iz * step;
    for (let ix = 0; ix < grid; ix++) {
      const x = bounds.minX + ix * step;
      const h = map.height(x, z);
      // Cheap slope estimate one step east/south — the same trick terrain.js
      // uses for vertex colour, so shading reads consistently with the world.
      const hx = map.height(x + step, z), hz = map.height(x, z + step);
      const slope = Math.min(1, Math.hypot(h - hx, h - hz) / (step * 0.5));
      shade(h, slope, out);
      const o = (iz * grid + ix) * 4;
      img.data[o] = out.r; img.data[o + 1] = out.g; img.data[o + 2] = out.b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Square world window covering a map's runway and race course, with padding.
 * Shared by the planner and the menu preview so both frame a map identically.
 * NOTE raceCourse entries are [x, z, desiredY] — index 1 is z, index 2 is
 * ALTITUDE. Reading index 2 as z frames the map on altitudes (a real bug once).
 */
export function courseBounds(map, minSpan = 6000, pad = 1.35) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const eat = (x, z) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  };
  eat(map.runway.spawn.x, map.runway.spawn.z);
  for (const [x, z] of map.raceCourse || []) eat(x, z);
  const span = Math.max(maxX - minX, maxZ - minZ, minSpan) * pad;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  return { minX: cx - span / 2, minZ: cz - span / 2, span };
}

/**
 * Editorial chart ramp — sea through lowland, hills, rock, snow, lifted where
 * the ground is steep so ridgelines read. Shared by planner + menu preview.
 */
export function chartShade(h, slope, out) {
  let r, g, b;
  if (h < 0.6) { r = 26; g = 58; b = 76; }              // sea
  else if (h < 400) { r = 68; g = 102; b = 58; }        // low land
  else if (h < 1400) { r = 104; g = 112; b = 78; }      // hills
  else if (h < 2600) { r = 120; g = 112; b = 100; }     // rock
  else { r = 214; g = 220; b = 220; }                   // snow
  const lift = 1 + slope * 0.38;                        // relief shading
  out.r = Math.min(255, r * lift);
  out.g = Math.min(255, g * lift);
  out.b = Math.min(255, b * lift);
}
