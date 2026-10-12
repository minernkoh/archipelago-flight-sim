// Cloud shadows on the ground (v12). Shared uniforms: environment.js points
// them at the cumulus clusters (the same centres the clouds use) and the sun;
// terrain.js's ground shader projects each cloud along the sun onto the
// fragment and dims only the DIRECT light, so shade stays coloured by the sky.
// On only with the volumetric clouds (full detail), so the lite path pays nothing.
import * as THREE from 'three';

export const MAX_SHADOW_CLOUDS = 34;
export const CLOUD_SHADOW = {
  csOn: { value: 0 },
  csCover: { value: MAX_SHADOW_CLOUDS },
  csCenters: { value: Array.from({ length: MAX_SHADOW_CLOUDS }, () => new THREE.Vector3(0, -1e5, 0)) },
  csDims: { value: Array.from({ length: MAX_SHADOW_CLOUDS }, () => new THREE.Vector3(1, 1, 1)) },
  csSun: { value: new THREE.Vector3(0, 1, 0) },
};

export const CLOUD_SHADOW_GLSL = `
uniform float csOn, csCover; uniform vec3 csCenters[${MAX_SHADOW_CLOUDS}]; uniform vec3 csDims[${MAX_SHADOW_CLOUDS}]; uniform vec3 csSun;
float cloudShadow(vec3 w){
  if (csOn < 0.5 || csSun.y < 0.06) return 1.0;
  float sh = 1.0;
  for (int i = 0; i < ${MAX_SHADOW_CLOUDS}; i++) {
    if (float(i) >= csCover) break;
    vec3 c = csCenters[i], d = csDims[i];
    float baseY = c.y + d.y * 0.35;                       // the cloud's dense middle
    vec2 p = w.xz + csSun.xz * (baseY - w.y) / csSun.y;   // follow the sun ray up to it
    vec2 q = (p - c.xz) / d.xz;
    sh *= 1.0 - 0.6 * (1.0 - smoothstep(0.2, 0.8, dot(q, q)));
  }
  return sh;
}`;
