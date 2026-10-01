// Shared terrain palette for the faceted low-poly look. Every map paints
// from these swatches so the worlds read as one game. Hex values are picked
// for the rendered result: terrain goes through ACES tone mapping, which
// darkens and desaturates, so the swatches sit brighter and warmer than the
// colour you want on screen.

import * as THREE from 'three';

export const PAL = {
  grass:     new THREE.Color(0x8cc65a),
  grassDark: new THREE.Color(0x6aa84a),
  meadow:    new THREE.Color(0xc4d36e),
  forest:    new THREE.Color(0x47883e),
  sand:      new THREE.Color(0xf2dea4),
  wetSand:   new THREE.Color(0xd2bd8c),
  scrub:     new THREE.Color(0xa8b468),
  rock:      new THREE.Color(0xab9d8d),
  rockDark:  new THREE.Color(0x857870),
  snow:      new THREE.Color(0xfbfcff),
  shallow:   new THREE.Color(0x7fe0cf),
  midwater:  new THREE.Color(0x37a6b8),
  deep:      new THREE.Color(0x1e5f8a),
  urban:     new THREE.Color(0xb3b5b2),
  mangrove:  new THREE.Color(0x4f8a4a),
};

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Seabed below the waterline: turquoise shallows sinking to deep blue. */
export function seabed(h, out) {
  if (h > -8) return out.lerpColors(PAL.shallow, PAL.midwater, smooth(-0.5, -8, h));
  return out.lerpColors(PAL.midwater, PAL.deep, smooth(-8, -45, h));
}

/** Beach band just above the waterline (wet sand at the water's edge). */
export function beach(h, out) {
  return out.lerpColors(PAL.wetSand, PAL.sand, smooth(-0.3, 1.2, h));
}

/**
 * Per-facet variation: a small hashed lightness/hue wobble so neighbouring
 * faces of the same material don't merge into one flat sheet. This is what
 * makes facets visible on gentle ground where lighting alone can't.
 */
export function facetJitter(x, z, out, amount = 0.045) {
  let n = Math.imul(Math.round(x * 3.1), 0x27d4eb2d) ^ Math.imul(Math.round(z * 3.1), 0x165667b1);
  n = Math.imul(n ^ (n >>> 15), 0x85ebca6b); n ^= n >>> 13;
  const r = (n >>> 0) / 4294967296 - 0.5;
  return out.offsetHSL(r * 0.012, 0, r * amount * 2);
}

/**
 * Material for painted ground decals (runway slabs). They sit centimetres
 * above perfectly flat terrain, so at a distance the depth buffer can't tell
 * them apart and they z-fight into a jagged strip; a polygon offset makes the
 * decal win without lifting it visibly off the ground.
 */
export function decalMaterial(tex) {
  return new THREE.MeshLambertMaterial({
    map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  });
}
