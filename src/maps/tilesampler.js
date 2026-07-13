// Pure Web-Mercator + Terrarium tile math for the real-world map. NO THREE, NO
// DOM — so the node test suite can verify the projection and elevation decode.
// The browser-only parts (fetch PNG -> canvas -> pixels, tile cache) live in
// realworld.js and call into these.
//
// Coordinate conventions match the sim's world + HUD:
//   world +x = East, world +z = South  (so North = -z), matching hud.js's
//   compass formula `(90 - heading*180/PI)`. bearingToHeadingRad is its inverse.

export const EARTH_CIRCUMFERENCE = 40075016.6856; // m, WGS84 equatorial
const D2R = Math.PI / 180;

// Slippy-map world width in pixels at a zoom level (256 px tiles).
export const worldPx = (zoom) => 256 * 2 ** zoom;

// Longitude/latitude -> global pixel coordinates (Web Mercator), y increases
// southward. Fractional; callers floor for the integer pixel grid.
export function lonToPx(lon, wpx) { return (lon + 180) / 360 * wpx; }
export function latToPy(lat, wpx) {
  const s = Math.sin(lat * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * wpx;
}

// Ground resolution (metres per pixel) at a latitude for this zoom. Web
// Mercator stretches with latitude; within ~100 km of the origin a single
// value is accurate to well under a metre, so the map linearises around it.
export function metresPerPixel(lat, zoom) {
  return Math.cos(lat * D2R) * EARTH_CIRCUMFERENCE / worldPx(zoom);
}

// Everything a map needs to turn local ENU metres into global tile pixels.
export function makeProjection(lat, lon, zoom) {
  const wpx = worldPx(zoom);
  return {
    zoom, worldPx: wpx,
    gpx0: lonToPx(lon, wpx),
    gpy0: latToPy(lat, wpx),
    mpp: metresPerPixel(lat, zoom),
    // world (x=East m, z=South m) -> fractional global pixel
    toPixel(x, z) { return { gpx: this.gpx0 + x / this.mpp, gpy: this.gpy0 + z / this.mpp }; },
  };
}

// Which tile a global pixel index belongs to, and the local pixel within it.
export function tileOfPixel(i, j) {
  const tx = Math.floor(i / 256), ty = Math.floor(j / 256);
  return { tx, ty, lx: i - tx * 256, ly: j - ty * 256 };
}

// Terrarium RGB -> metres MSL. Ocean encodes as ~0; bathymetry can go negative.
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

// Bilinear blend of the four corner heights (a=NW, b=NE, c=SW, d=SE).
export function bilerp(a, b, c, d, fx, fy) {
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}

// True runway bearing (deg) -> the yaw the sim spawns the aircraft at, such
// that hud.js renders that same bearing on the heading tape. Inverse of the
// HUD's `compass = (90 - heading*180/PI)`.
export function bearingToHeadingRad(bearingDeg) {
  return (90 - bearingDeg) * D2R;
}
