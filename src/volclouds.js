// Volumetric cumulus (v12). The same clusters as the billboard clouds in
// environment.js (shared centres, cover and palette uniforms), but each one
// is raymarched: a box proxy per cloud, and its fragment shader marches the
// view ray through a density field (a domed cumulus profile eroded by tiling
// 3D Worley noise), marches toward the sun for self-shadowing (Beer-Lambert),
// and lights each sample with a forward-scattering phase (the silver lining
// when you look toward the sun) and the "powder" darkening of thin edges
// facing the light. One draw call for clouds seen from outside, one for the
// cloud the camera is inside (its back faces), so flying through a cumulus
// stays inside the volume instead of popping out of existence.
//
// It costs real fill rate, so it only runs on the full-detail path (HIGH
// quality, GROUND_DETAIL 1). The lite path and headless tests keep the
// billboards. Output is an on-screen colour run through displayMatch, exactly
// like the billboard material, so both look the same with and without post FX.

import * as THREE from 'three';
import { displayMatch } from './display.js';

const N = 64;   // noise volume resolution (tiles in all three axes)

/** Tileable 3D Worley fBm (inverted: 1 = cell centre), N^3 bytes. */
export function cloudNoise(n = N, seed = 1) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  const octave = (cells) => {
    const pts = new Float32Array(cells * cells * cells * 3);
    for (let i = 0; i < pts.length; i++) pts[i] = rnd();
    const out = new Float32Array(n * n * n);
    const k = cells / n;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const px = x * k, py = y * k, pz = z * k;
      const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
      let best = 9;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const ix = cx + dx, iy = cy + dy, iz = cz + dz;
        const wx = ((ix % cells) + cells) % cells, wy = ((iy % cells) + cells) % cells, wz = ((iz % cells) + cells) % cells;
        const o = (wx + wy * cells + wz * cells * cells) * 3;
        const ddx = ix + pts[o] - px, ddy = iy + pts[o + 1] - py, ddz = iz + pts[o + 2] - pz;
        const d = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d < best) best = d;
      }
      out[x + y * n + z * n * n] = 1 - Math.min(1, Math.sqrt(best));
    }
    return out;
  };
  const a = octave(4), b = octave(8), c = octave(16);
  const data = new Uint8Array(n * n * n);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(255 * Math.min(1, Math.max(0, a[i] * 0.6 + b[i] * 0.28 + c[i] * 0.12)));
  return data;
}

/**
 * @param {object} o
 * @param {THREE.Scene} o.scene
 * @param {object} o.uniforms the billboard cloud material's uniforms (shared refs)
 * @param {{w:number,h:number}[]} o.dims per-cluster footprint width and height (m)
 * @param {number} o.max number of clusters (array size in the shader)
 */
export function createVolumetricClouds({ scene, uniforms, dims, max }) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  let built = false, meshes = [], insideAttr = null;

  function build() {
    built = true;
    const tex = new THREE.Data3DTexture(cloudNoise(), N, N, N);
    tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;

    const box = new THREE.BoxGeometry(2, 1, 2); box.translate(0, 0.5, 0);   // x,z in -1..1, y in 0..1
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = box.index;
    geo.setAttribute('position', box.attributes.position);
    const idx = new Float32Array(dims.length), rad = new Float32Array(dims.length * 3);
    dims.forEach((d, i) => { idx[i] = i; rad[i * 3] = d.w * 0.5; rad[i * 3 + 1] = d.h; rad[i * 3 + 2] = d.w * 0.42; });
    geo.setAttribute('aCluster', new THREE.InstancedBufferAttribute(idx, 1));
    geo.setAttribute('aRad', new THREE.InstancedBufferAttribute(rad, 3));
    insideAttr = new THREE.InstancedBufferAttribute(new Float32Array(dims.length), 1);
    insideAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aInside', insideAttr);
    geo.instanceCount = dims.length;

    const vert = `
      attribute float aCluster, aInside; attribute vec3 aRad;
      uniform vec3 centers[${max}]; uniform float cover, uMode;
      varying vec3 vWorld, vC, vR;
      void main(){
        vC = centers[int(aCluster + 0.5)]; vR = aRad;
        vec3 w = vC + position * vec3(aRad.x, aRad.y, aRad.z) * vec3(1.02, 1.02, 1.02);
        vWorld = w;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        if (aCluster >= cover || abs(aInside - uMode) > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`;
    const frag = `
      precision highp sampler3D;
      uniform sampler3D noise3; uniform vec3 lit, sunDir, sunColor, fogColor;
      uniform float fogNear, fogFar, night, time;
      varying vec3 vWorld, vC, vR;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float dens(vec3 p, bool detail){
        vec3 q = (p - vC) / vR;                 // x,z in -1..1, y 0..1 (base .. top)
        float h = q.y;
        if (h < 0.0 || h > 1.0) return 0.0;
        float prof = sqrt(max(0.0, 1.0 - h * h)) * (0.9 + 0.1 * smoothstep(0.0, 0.25, h)) * (1.0 - 0.35 * h);
        vec3 drift = vec3(time * 2.2, 0.0, 0.0);
        float n = texture(noise3, (p + drift) / 1300.0).r;
        float shape = prof - length(q.xz) + (n - 0.5) * 0.85;
        float d = shape - 0.08;
        if (detail && d > -0.2) d -= (1.0 - texture(noise3, (p + drift) / 260.0).r) * 0.32;
        d *= smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(0.86, 1.0, h));
        return clamp(d * 3.2, 0.0, 1.0);
      }
      void main(){
        vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
        vec3 bmin = vC - vec3(vR.x, 0.0, vR.z), bmax = vC + vR;
        vec3 inv = 1.0 / rd;
        vec3 ta = (bmin - ro) * inv, tb = (bmax - ro) * inv;
        vec3 t0v = min(ta, tb), t1v = max(ta, tb);
        float t0 = max(max(t0v.x, t0v.y), max(t0v.z, 0.0)), t1 = min(min(t1v.x, t1v.y), t1v.z);
        if (t1 <= t0) discard;
        const int STEPS = 28;
        float dt = (t1 - t0) / float(STEPS);
        float t = t0 + dt * hash(gl_FragCoord.xy);
        float T = 1.0; vec3 acc = vec3(0.0);
        float mu = dot(rd, sunDir);
        float g = 0.55, hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) / 12.566;
        float phase = 0.6 + 7.0 * hg;                                   // forward scattering: silver lining
        vec3 under = lit * vec3(0.55, 0.6, 0.7);
        float sigma = 0.012;                                           // extinction per metre at density 1
        float lstep = vR.y * 0.16;
        for (int i = 0; i < STEPS; i++) {
          vec3 p = ro + rd * t;
          float d = dens(p, true);
          if (d > 0.003) {
            float ld = 0.0;
            for (int j = 1; j <= 3; j++) ld += dens(p + sunDir * lstep * float(j), false);
            float beer = exp(-ld * lstep * sigma * 1.6);
            float powder = 1.0 - exp(-d * 4.0);
            float h = clamp((p.y - vC.y) / vR.y, 0.0, 1.0);
            vec3 amb = mix(under, lit * 0.95, h);
            vec3 L = amb * 0.74 + lit * sunColor * beer * phase * (0.35 + 0.65 * powder) * 0.62 * (1.0 - 0.85 * night);
            float a = 1.0 - exp(-d * sigma * dt);
            acc += T * L * a;
            T *= 1.0 - a;
            if (T < 0.03) break;
          }
          t += dt;
        }
        float alpha = 1.0 - T;
        if (alpha < 0.004) discard;
        vec3 c = acc / alpha;
        float f = smoothstep(fogNear, fogFar * 1.2, t0 + (t1 - t0) * 0.3);
        c = mix(c, fogColor, f);
        gl_FragColor = vec4(c, alpha * (1.0 - f * 0.35));
      }`;
    const base = {
      noise3: { value: tex }, time: { value: 0 },
      lit: uniforms.lit, sunDir: uniforms.sunDir, sunColor: uniforms.sunColor, fogColor: uniforms.fogColor,
      fogNear: uniforms.fogNear, fogFar: uniforms.fogFar, night: uniforms.night, cover: uniforms.cover,
      centers: uniforms.centers,
    };
    for (const mode of [0, 1]) {
      const mat = displayMatch(new THREE.ShaderMaterial({
        uniforms: { ...base, uMode: { value: mode } },
        vertexShader: vert, fragmentShader: frag,
        transparent: true, depthWrite: false, fog: false,
        side: mode ? THREE.BackSide : THREE.FrontSide,
        depthTest: true,
      }));
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 2;
      group.add(m);
      meshes.push(m);
    }
    shared.time = base.time;
  }

  const shared = { time: null };
  return {
    group,
    get on() { return group.visible; },
    setOn(on) {
      if (on && !built) build();
      group.visible = !!on;
    },
    /** Per frame: which cloud (if any) the camera is inside, and the drift clock. */
    update(camPos, elapsed) {
      if (!group.visible || !insideAttr) return;
      shared.time.value = elapsed;
      const c = uniforms.centers.value, a = insideAttr.array;
      let changed = false;
      for (let i = 0; i < dims.length; i++) {
        const d = dims[i], p = c[i];
        const inside = Math.abs(camPos.x - p.x) < d.w * 0.5 && Math.abs(camPos.z - p.z) < d.w * 0.42
          && camPos.y > p.y && camPos.y < p.y + d.h ? 1 : 0;
        if (a[i] !== inside) { a[i] = inside; changed = true; }
      }
      if (changed) insideAttr.needsUpdate = true;
    },
  };
}
