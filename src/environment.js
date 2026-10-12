// Sky dome (scattering-style gradient, halo, stars), sun light, procedural ocean,
// low-poly faceted cumulus, blob shadow.
// Time-of-day aware: DAWN / DAY / DUSK / NIGHT swap the whole lighting rig at
// once (never per-frame). Night adds lit runway edge lights, a PAPI bar, a
// landing-light cone from the aircraft, and toggles city window glow/beacons.

import * as THREE from 'three';
import { getTerrainHeight as archipelagoHeight } from './maps/archipelago.js';
import { createRunwayLights } from './runwayLights.js';
import { DISPLAY, displayMatch, displayOf } from './display.js';
import { createVolumetricClouds } from './volclouds.js';

const D2R = Math.PI / 180;
// Sun/moon direction from azimuth (deg, 0 = +x, increasing toward -z) and
// elevation (deg above the horizon).
function sunDir(azDeg, elDeg) {
  const e = elDeg * D2R, a = azDeg * D2R;
  return new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a)).normalize();
}
const C = (hex) => new THREE.Color(hex);

// One palette per time-of-day. Every visible knob lives here so setTimeOfDay is
// a pure table lookup + uniform/property writes — no branching in the frame loop.
export const TIMES = {
  dawn: {
    label: 'DAWN', night: false, exposure: 1.02,
    sunDir: sunDir(200, 9), sunColor: C(0xffb27a), sunI: 1.25,
    hemiSky: C(0xe6c6ac), hemiGround: C(0x4a4638), hemiI: 0.6,
    ambient: C(0xffe6cf), ambientI: 0.16,
    fog: C(0xe7c6b0), fogNear: 1200, fogFar: 4600,
    skyHorizon: C(0xf3c99f), skyZenith: C(0x3f5a86),
    oceanDeep: C(0x27384f), oceanShallow: C(0x51636e),
    cloud: C(0xf1d7c2), cloudOpacity: 0.9,
  },
  day: {
    label: 'DAY', night: false, exposure: 1.05,
    sunDir: sunDir(126, 38), sunColor: C(0xfff0d2), sunI: 2.5,
    hemiSky: C(0xb4cdf0), hemiGround: C(0x6f7d55), hemiI: 0.62,
    ambient: C(0xffffff), ambientI: 0.04,
    fog: C(0xcfdde6), fogNear: 1400, fogFar: 5200,
    skyHorizon: C(0xd7e3ea), skyZenith: C(0x5e8fc4),
    oceanDeep: C(0x15507a), oceanShallow: C(0x2f8fa8),
    cloud: C(0xffffff), cloudOpacity: 0.92,
  },
  dusk: {
    label: 'DUSK', night: false, exposure: 1.0,
    sunDir: sunDir(-30, 8), sunColor: C(0xff8a4a), sunI: 1.15,
    hemiSky: C(0xd7a488), hemiGround: C(0x3a343a), hemiI: 0.55,
    ambient: C(0xffd9be), ambientI: 0.14,
    fog: C(0xd79a72), fogNear: 1200, fogFar: 4400,
    skyHorizon: C(0xeea06a), skyZenith: C(0x3b5d96),
    oceanDeep: C(0x233046), oceanShallow: C(0x46515e),
    cloud: C(0xf0c090), cloudOpacity: 0.9,
  },
  night: {
    label: 'NIGHT', night: true, exposure: 1.15,
    sunDir: sunDir(40, 34), sunColor: C(0x8fa6d6), sunI: 0.75,
    hemiSky: C(0x3a5078), hemiGround: C(0x121a26), hemiI: 0.55,
    ambient: C(0x2a3856), ambientI: 0.14,
    fog: C(0x16202f), fogNear: 900, fogFar: 4200,
    skyHorizon: C(0x22324b), skyZenith: C(0x070d1a),
    oceanDeep: C(0x081322), oceanShallow: C(0x1a3248),
    cloud: C(0x46546e), cloudOpacity: 0.8,
  },
};

// Back-compat exports (day baseline).
export const SUN_DIR = TIMES.day.sunDir.clone();
export const FOG_COLOR = TIMES.day.fog.clone();

const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

const CLOUD_WRAP = 5000;     // clusters live in a 10 km box that follows the aircraft

// Cumulus (v10): soft billboard puffs, one instanced draw call for the whole
// sky. Each cloud is a dozen-plus camera-facing puffs heaped on a flat base;
// a procedural puff texture gives them billowed, feathered edges. Shading is
// stylised physical: grey-blue bases, bright tops, the sun side lit, a silver
// lining when you look toward the sun, all fading into the fog. Puffs fade as
// the camera closes on them, so flying through a cloud never fills the screen
// with one flat sprite. Uniform names match the old material (lit, sunDir,
// sunColor, fogColor, fogNear, fogFar, night), so the palette code drives it.
const MAX_CLUSTERS = 34;
function puffTexture() {
  if (typeof document === 'undefined') return null;
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // a heap of soft blobs: billows on top of a dense core
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * S * 0.26;
    const cx = S / 2 + Math.cos(a) * r, cy = S / 2 + Math.sin(a) * r * 0.85;
    const rad = S * (0.1 + rnd() * 0.16);
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
    const v = 200 + Math.round(rnd() * 55);
    g.addColorStop(0, `rgba(${v},${v},${v},0.55)`);
    g.addColorStop(0.6, `rgba(${v},${v},${v},0.25)`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    x.fillStyle = g;
    x.fillRect(0, 0, S, S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function buildClouds(scene, tod) {
  let seed = 99;
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const offs = [], sizes = [], shades = [], clusterIdx = [], rots = [];
  const centers = [], dims = [];
  for (let i = 0; i < MAX_CLUSTERS; i++) {
    const W = 260 + rng() * 460, H = W * (0.38 + rng() * 0.2);
    dims.push({ w: W * 1.15, h: H * 1.05 });          // the volumetric renderer's box (volclouds.js)
    centers.push(new THREE.Vector3((rng() - 0.5) * CLOUD_WRAP * 2, 520 + rng() * 650, (rng() - 0.5) * CLOUD_WRAP * 2));
    const n = 18 + Math.floor(rng() * 10);
    for (let b = 0; b < n; b++) {
      const u = (rng() - 0.5) * 2, w = (rng() - 0.5) * 2, dome = Math.max(0, 1 - u * u - w * w * 0.6);
      const up = b < n * 0.45 ? rng() * 0.12 : 0.12 + dome * rng() * 0.88;      // first puffs sit on the base
      const size = W * (0.34 + rng() * 0.26) * (0.75 + 0.5 * dome);
      offs.push(u * W * 0.38, size * 0.12 + up * H, w * W * 0.28);
      sizes.push(size);
      shades.push(Math.min(1, up * 1.1 + 0.1));
      clusterIdx.push(i);
      rots.push(rng() * Math.PI * 2);
    }
  }
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(offs), 3));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(sizes), 1));
  geo.setAttribute('aShade', new THREE.InstancedBufferAttribute(new Float32Array(shades), 1));
  geo.setAttribute('aCluster', new THREE.InstancedBufferAttribute(new Float32Array(clusterIdx), 1));
  geo.setAttribute('aRot', new THREE.InstancedBufferAttribute(new Float32Array(rots), 1));
  geo.instanceCount = sizes.length;
  const mat = displayMatch(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: {
      lit: { value: tod.cloud.clone() }, sunDir: { value: tod.sunDir.clone() },
      sunColor: { value: tod.sunColor.clone() },
      fogColor: { value: tod.fog.clone() }, fogNear: { value: tod.fogNear }, fogFar: { value: tod.fogFar },
      opacity: { value: 1 }, night: { value: 0 }, cover: { value: MAX_CLUSTERS },
      centers: { value: centers }, puff: { value: puffTexture() },
    },
    vertexShader: `
      attribute vec3 aOffset; attribute float aSize, aShade, aCluster, aRot;
      uniform vec3 centers[${MAX_CLUSTERS}]; uniform float cover; uniform vec3 sunDir;
      varying vec2 vUv; varying float vShade, vSun, vNear; varying vec3 vW;
      varying float vY, vBase;
      void main(){
        vec3 c = centers[int(aCluster + 0.5)];
        vec3 w = c + aOffset;
        vec4 mv = viewMatrix * vec4(w, 1.0);
        float cr = cos(aRot), sr = sin(aRot);
        vec2 q = position.xy;
        mv.xy += vec2(q.x * cr - q.y * sr, q.x * sr + q.y * cr) * aSize;
        gl_Position = projectionMatrix * mv;
        vY = (inverse(viewMatrix) * mv).y;      // world height of this corner: flat cloud bases
        vBase = c.y;
        if (aCluster >= cover) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vUv = uv; vShade = aShade; vW = w;
        vSun = dot(normalize(aOffset - vec3(0.0, aSize * 0.3, 0.0) + vec3(0.0, 1.0, 0.0)), sunDir);
        vNear = smoothstep(aSize * 0.35, aSize * 1.1, -mv.z);
      }`,
    fragmentShader: `
      uniform vec3 lit, sunDir, sunColor, fogColor; uniform float fogNear, fogFar, night, opacity;
      uniform sampler2D puff;
      varying vec2 vUv; varying float vShade, vSun, vNear; varying vec3 vW;
      varying float vY, vBase;
      void main(){
        vec4 t = texture2D(puff, vUv);
        float a = t.a * vNear * opacity * smoothstep(vBase - 4.0, vBase + 22.0, vY);
        if (a < 0.01) discard;
        vec3 under = lit * vec3(0.6, 0.65, 0.74);
        vec3 c = mix(under, lit, smoothstep(0.0, 0.85, vShade));
        c *= 0.82 + 0.3 * max(vSun, 0.0);
        c *= 0.86 + 0.24 * t.r;                                        // billows
        vec3 toCam = normalize(cameraPosition - vW);
        float fwd = max(dot(-toCam, sunDir), 0.0);
        c += sunColor * pow(fwd, 8.0) * (1.0 - t.a) * 1.2 * (1.0 - night);   // silver lining
        float d = distance(cameraPosition, vW);
        c = mix(c, fogColor, smoothstep(fogNear, fogFar * 1.2, d));
        gl_FragColor = vec4(c, a);
      }`,
  }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  const group = new THREE.Group();
  group.add(mesh);
  scene.add(group);

  function updateClouds(ac, dt) {
    for (const c of centers) {
      c.x += dt * 2.2;
      if (c.x - ac.pos.x > CLOUD_WRAP) c.x -= CLOUD_WRAP * 2;
      if (ac.pos.x - c.x > CLOUD_WRAP) c.x += CLOUD_WRAP * 2;
      if (c.z - ac.pos.z > CLOUD_WRAP) c.z -= CLOUD_WRAP * 2;
      if (ac.pos.z - c.z > CLOUD_WRAP) c.z += CLOUD_WRAP * 2;
    }
  }
  // Cloud cover (live weather): show a fraction of the clusters.
  function setCover(f) {
    mat.uniforms.cover.value = Math.round(MAX_CLUSTERS * Math.max(0, Math.min(1, f)));
  }
  return { clouds: group, cloudMat: mat, updateClouds, setCover, dims };
}

export function createEnvironment(scene, renderer) {
  // Ground elevation source for the blob shadow. Defaults to the archipelago
  // heightfield; swap via setGround(fn) when another map is active.
  let groundFn = archipelagoHeight;
  let tod = TIMES.day;           // current time-of-day palette
  let scenery = null;            // current map's dressing group (for glow/beacons)

  scene.fog = new THREE.Fog(tod.fog.clone(), tod.fogNear, tod.fogFar);
  scene.background = tod.fog.clone();

  const hemi = new THREE.HemisphereLight(tod.hemiSky.clone(), tod.hemiGround.clone(), tod.hemiI);
  const sun = new THREE.DirectionalLight(tod.sunColor.clone(), tod.sunI);
  sun.position.copy(tod.sunDir).multiplyScalar(1000);
  const ambient = new THREE.AmbientLight(tod.ambient.clone(), tod.ambientI);
  // v6 shadows: a tight orthographic box that rides with the aircraft. Only
  // the fine terrain tier and the scenery receive; the box is deliberately
  // small (SHADOW_HALF metres) so 1-2k of map covers the area you can actually
  // judge height against, which is what a shadow is for on approach.
  const SHADOW_HALF = 140;
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -SHADOW_HALF; sun.shadow.camera.right = SHADOW_HALF;
  sun.shadow.camera.top = SHADOW_HALF; sun.shadow.camera.bottom = -SHADOW_HALF;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 1600;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.6;
  scene.add(hemi, sun, sun.target, ambient);

  // Landing light: a single spotlight cast forward from the aircraft nose.
  // No shadow map (cheap). Off (intensity 0) except at night while flying.
  const landing = new THREE.SpotLight(0xfff4e0, 0, 320, Math.PI / 7, 0.45, 1.1);
  landing.castShadow = false;
  scene.add(landing, landing.target);
  const fwdV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();

  // --- Sky dome ---
  // A cheap stand-in for real scattering: zenith->horizon gradient, a warm
  // forward-scatter band along the horizon on the sun side, a Mie halo around
  // the disc, and a haze floor that meets the fog colour so the terrain edge
  // dissolves into the sky instead of meeting it at a hard line. At night the
  // "sun" is the moon (pale disc, no halo warmth) and a procedural star field
  // fades in above the haze.
  const skyMat = displayMatch(new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      horizon: { value: tod.skyHorizon.clone() }, zenith: { value: tod.skyZenith.clone() },
      sunDir: { value: tod.sunDir.clone() }, sunI: { value: 1.0 },
      sunColor: { value: tod.sunColor.clone() }, haze: { value: tod.fog.clone() },
      night: { value: 0 }, time: { value: 0 }, flash: { value: 0 },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir=normalize(position);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vDir;
      uniform vec3 horizon,zenith,sunDir,sunColor,haze; uniform float sunI,night,time,flash;
      float h31(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      void main(){
        vec3 d=normalize(vDir);
        float y=d.y;
        float up=max(y,0.0);
        vec3 c=mix(horizon,zenith,pow(up,0.45));
        // forward-scatter warmth hugging the horizon on the sun side
        vec2 dxz=normalize(d.xz+1e-5), sxz=normalize(sunDir.xz+1e-5);
        float side=0.5+0.5*dot(dxz,sxz);
        float band=exp(-up*7.0);
        c=mix(c,c*0.55+sunColor*0.6,band*side*side*0.45*(1.0-night));
        float s=max(dot(d,sunDir),0.0);
        // disc + Mie halo (moon at night: crisp pale disc, faint halo)
        float disc=smoothstep(mix(0.99955,0.99965,night),mix(0.9998,0.99985,night),s);
        vec3 discCol=mix(mix(vec3(1.0,0.93,0.8),sunColor,0.35)*3.0,vec3(0.86,0.9,1.0)*1.6,night);
        c+=discCol*disc*sunI*(1.0-0.3*night)+discCol*disc*night*1.2;
        c+=sunColor*(pow(s,10.0)*0.22+pow(s,60.0)*0.35)*sunI*(1.0-0.75*night);
        // stars
        if(night>0.0){
          vec3 g=d*260.0; vec3 cell=floor(g); vec3 f=fract(g)-0.5;
          float r=h31(cell);
          float star=step(0.9965,r)*smoothstep(0.32,0.0,length(f));
          float tw=0.65+0.35*sin(time*(2.0+r*7.0)+r*60.0);
          c+=vec3(0.9,0.95,1.0)*star*tw*night*smoothstep(0.02,0.2,y)*1.4;
        }
        // haze floor: below/at the horizon the sky becomes the fog colour
        c=mix(c,haze,smoothstep(0.10,-0.02,y));
        c+=vec3(0.75,0.8,1.0)*flash*0.9;                              // lightning
        gl_FragColor=vec4(c,1.0);
      }`,
  }));
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), skyMat);
  sky.renderOrder = -1;
  scene.add(sky);

  // --- Environment map (v10): the same sky, plus a ground hemisphere below
  // the horizon, prefiltered with PMREM into scene.environment. Every PBR
  // material (aircraft paint and glass) reflects it. Rebuilt only when the
  // palette changes (time of day, weather), never per frame.
  const pmrem = renderer ? new THREE.PMREMGenerator(renderer) : null;
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat));
  const envGroundMat = new THREE.MeshBasicMaterial({ color: 0x404a38, side: THREE.DoubleSide });
  const envGround = new THREE.Mesh(new THREE.CircleGeometry(49, 32), envGroundMat);
  envGround.rotation.x = -Math.PI / 2; envGround.position.y = -4;
  envScene.add(envGround);
  let envRT = null, envDirty = true, envAt = -1, envMs = 0;
  function regenEnv(elapsed) {
    if (!pmrem) return;
    envGroundMat.color.copy(hemi.groundColor).multiplyScalar(0.55).lerp(scene.fog.color, 0.25);
    // the sun itself is the directional light: keep the disc out of the
    // reflections or every clear-coated panel facing it blooms to white
    const sunI0 = skyMat.uniforms.sunI.value;
    skyMat.uniforms.sunI.value = 0;
    // 64 px cube: the sky is a smooth gradient and the paint is semi-rough;
    // the default 256 costs ~16x more (PMREM filters with 256 GGX samples a
    // texel), a visible stall on a software rasterizer at every palette change
    const t0 = performance.now();
    const rt = pmrem.fromScene(envScene, 0.015, 0.1, 200, { size: 64 });
    envMs = performance.now() - t0;
    skyMat.uniforms.sunI.value = sunI0;
    envRT?.dispose();
    envRT = rt;
    // NOT scene.environment: three applies that to Lambert/Phong too, which
    // put an env lookup (and a sky tint) on every pixel of terrain and trees.
    // Only the registered PBR materials (aircraft, traffic) reflect it.
    for (const set of envUsers.values()) for (const m of set) { m.envMap = rt.texture; m.needsUpdate = true; }
    envDirty = false; envAt = elapsed;
  }
  const envUsers = new Map();   // key -> Set of PBR materials that reflect the sky

  // --- Ocean ---
  // Semi-transparent: the faceted seabed (maps/palette.js seabed()) shows
  // through as turquoise shallows near shore and deep blue offshore, so the
  // coastline grades naturally instead of meeting a hard sand stripe. Grazing
  // angles turn opaque and reflect the sky (fresnel).
  // v8: low-poly swell. A radial grid that follows the aircraft (fine at the
  // camera, coarse at the horizon) is displaced by a few summed directional
  // sines; normals come from screen derivatives so every facet is flat and
  // catches the sun on its own. Amplitude fades out over shallows and far away.
  // Shallowness comes from a small R8 depth texture sampled from map.height on a
  // coarse grid around the aircraft: rebuilt a few rows per frame whenever we
  // move 500 m, so there is no hitch. It is read-only cosmetics and never feeds
  // back into map.height.
  const DEPTH_N = 128, DEPTH_SPAN = 4000, DEPTH_ROWS = 12;
  const DEPTH_LO = -40, DEPTH_HI = 10; // metres mapped to byte 0..255
  const depthShown = new Uint8Array(DEPTH_N * DEPTH_N).fill(0);
  const depthBuild = new Uint8Array(DEPTH_N * DEPTH_N);
  const depthTex = new THREE.DataTexture(depthShown, DEPTH_N, DEPTH_N, THREE.RedFormat, THREE.UnsignedByteType);
  depthTex.minFilter = depthTex.magFilter = THREE.LinearFilter;
  depthTex.wrapS = depthTex.wrapT = THREE.ClampToEdgeWrapping;
  depthTex.needsUpdate = true;
  let heightFn = null, depthValid = false;
  let build = null; // { cx, cz, row } while a rebuild is in flight
  let shownX = 0, shownZ = 0;
  function buildRows(n) {
    const cell = DEPTH_SPAN / DEPTH_N, x0 = build.cx - DEPTH_SPAN / 2, z0 = build.cz - DEPTH_SPAN / 2;
    for (let k = 0; k < n && build.row < DEPTH_N; k++, build.row++) {
      const z = z0 + (build.row + 0.5) * cell;
      for (let i = 0; i < DEPTH_N; i++) {
        const h = heightFn(x0 + (i + 0.5) * cell, z);
        depthBuild[build.row * DEPTH_N + i] = Math.round(clamp01((h - DEPTH_LO) / (DEPTH_HI - DEPTH_LO)) * 255);
      }
    }
    if (build.row >= DEPTH_N) {
      depthShown.set(depthBuild); depthTex.needsUpdate = true;
      oceanMat.uniforms.depthRect.value.set(build.cx, build.cz, DEPTH_SPAN);
      shownX = build.cx; shownZ = build.cz; depthValid = true; build = null;
      oceanMat.uniforms.depthOn.value = 1;
    }
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function updateDepth(x, z) {
    if (!heightFn) return;
    if (!build && (!depthValid || Math.hypot(x - shownX, z - shownZ) > 500)) build = { cx: x, cz: z, row: 0 };
    if (build) buildRows(depthValid ? DEPTH_ROWS : DEPTH_N); // first build is synchronous
  }

  const oceanMat = displayMatch(new THREE.ShaderMaterial({
    fog: false, transparent: true, side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 }, sunDir: { value: tod.sunDir.clone() },
      deep: { value: tod.oceanDeep.clone() }, shallow: { value: tod.oceanShallow.clone() },
      skyCol: { value: tod.skyHorizon.clone() }, sunColor: { value: tod.sunColor.clone() },
      fogColor: { value: tod.fog.clone() }, fogNear: { value: tod.fogNear }, fogFar: { value: tod.fogFar },
      glint: { value: 1.0 }, detail: { value: 1.0 },
      reflTex: { value: null }, reflMatrix: { value: new THREE.Matrix4() }, reflOn: { value: 0 },
      depthTex: { value: depthTex }, depthRect: { value: new THREE.Vector3(0, 0, DEPTH_SPAN) }, depthOn: { value: 0 },
    },
    vertexShader: `varying vec3 vWorld; varying float vSwell;
      uniform float time,depthOn; uniform sampler2D depthTex; uniform vec3 depthRect;
      // four directional sines, ~90 / 55 / 35 / 22 m, deep-water dispersion w=sqrt(g k)
      float swell(vec2 p){
        float h=0.0;
        h+=0.42*sin(dot(p,vec2(0.9,0.44))*0.0698-time*0.83);
        h+=0.26*sin(dot(p,vec2(-0.34,0.94))*0.1142-time*1.06);
        h+=0.14*sin(dot(p,vec2(0.62,-0.78))*0.1795-time*1.33);
        h+=0.07*sin(dot(p,vec2(-0.97,0.24))*0.2856-time*1.67);
        return h;
      }
      void main(){
        vec4 w=modelMatrix*vec4(position,1.0);
        float amp=1.0;
        if(depthOn>0.5){
          vec2 uv=(w.xz-depthRect.xy)/depthRect.z+0.5;
          float h=texture2D(depthTex,uv).r*50.0-40.0;
          float edge=max(abs(uv.x-0.5),abs(uv.y-0.5));
          amp=mix(smoothstep(-2.0,-9.0,h),1.0,smoothstep(0.42,0.5,edge));
        }
        // fade the swell out with distance: far facets would only shimmer
        float dc=distance(w.xz,cameraPosition.xz);
        amp*=1.0-smoothstep(1800.0,4200.0,dc);
        vSwell=amp;
        w.y+=swell(w.xz)*amp;
        vWorld=w.xyz;
        gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `varying vec3 vWorld; varying float vSwell;
      uniform float time,fogNear,fogFar,glint,depthOn,detail; uniform vec3 sunDir,deep,shallow,skyCol,sunColor,fogColor;
      uniform sampler2D reflTex; uniform mat4 reflMatrix; uniform float reflOn;
      uniform sampler2D depthTex; uniform vec3 depthRect;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
      void main(){
        vec2 p=vWorld.xz;
        // v10: smooth analytic normal: the gradient of the same four swell
        // sines the vertex shader displaces with (scaled by the swell fade),
        // plus two layers of fine moving ripples for sparkle close in.
        vec2 g=vec2(0.0);
        g+=0.42*0.0698*vec2(0.9,0.44)*cos(dot(p,vec2(0.9,0.44))*0.0698-time*0.83);
        g+=0.26*0.1142*vec2(-0.34,0.94)*cos(dot(p,vec2(-0.34,0.94))*0.1142-time*1.06);
        g+=0.14*0.1795*vec2(0.62,-0.78)*cos(dot(p,vec2(0.62,-0.78))*0.1795-time*1.33);
        g+=0.07*0.2856*vec2(-0.97,0.24)*cos(dot(p,vec2(-0.97,0.24))*0.2856-time*1.67);
        g*=vSwell;
        float dc=distance(cameraPosition,vWorld);
        float rk=(1.0-smoothstep(150.0,1400.0,dc))*detail;
        if(rk>0.001){
        vec2 r1=vec2(vnoise(p*0.35+vec2(time*0.6,time*0.2)),vnoise(p*0.35+vec2(-time*0.3,time*0.55)+9.0))-0.5;
        vec2 r2=vec2(vnoise(p*1.3+vec2(time*1.1,-time*0.4)+3.0),vnoise(p*1.3+vec2(time*0.5,time*0.9)+13.0))-0.5;
        g+=(r1*0.09+r2*0.05)*rk;
        }
        g+=vec2(sin(p.x*0.018-time*0.35)*0.035+sin((p.x+p.y)*0.011+time*0.27)*0.03,
                sin(p.y*0.015+time*0.3)*0.035+sin((p.y-p.x)*0.009-time*0.22)*0.03)*0.6;
        vec3 n=normalize(vec3(-g.x,1.0,-g.y));
        vec3 view=normalize(cameraPosition-vWorld);
        float fres=pow(1.0-max(dot(view,n),0.0),3.0);
        vec3 c=mix(deep,shallow,0.25);
        vec3 reflC=skyCol;
        #ifdef OCEAN_REFL
        if(reflOn>0.5){
          // planar reflection of the world above the waterline, perturbed by
          // the swell/ripple normal (a few metres of offset) so it shimmers
          vec4 rc=reflMatrix*vec4(vWorld.x+n.x*6.0,0.0,vWorld.z+n.z*6.0,1.0);
          vec2 ruv=rc.xy/rc.w;
          vec3 r=dmToScreen(texture2D(reflTex,ruv).rgb);
          float edge=smoothstep(0.0,0.04,min(min(ruv.x,ruv.y),min(1.0-ruv.x,1.0-ruv.y)));
          reflC=mix(skyCol,r,edge*(1.0-smoothstep(3500.0,6000.0,distance(cameraPosition,vWorld))));
        }
        #endif
        c=mix(c,reflC,fres*0.82+0.08*reflOn);                          // sky / world reflection
        vec3 r=reflect(-sunDir,n);
        float sp=max(dot(r,view),0.0);
        c+=sunColor*(pow(sp,600.0)*3.0+pow(sp,60.0)*0.25+pow(sp,8.0)*0.06)*glint;   // sun glitter + sheen
        float d=distance(cameraPosition,vWorld);
        // shallows only near the aircraft: far off the seabed is coarse and
        // smooth-shaded, and showing it through would paint glowing bands
        float a=mix(mix(0.5,0.96,fres),1.0,smoothstep(900.0,2400.0,d));
        // coastal foam: a soft band over the shallows, drifting in and out
        float foam=0.0;
        if(depthOn>0.5){
          vec2 uv=(p-depthRect.xy)/depthRect.z+0.5;
          float dep=-(texture2D(depthTex,uv).r*50.0-40.0);
          float edge=max(abs(uv.x-0.5),abs(uv.y-0.5));
          float inside=1.0-smoothstep(0.40,0.48,edge);
          float nz=vnoise(p*0.09+vec2(time*0.05,-time*0.04));
          float shore=1.0-smoothstep(0.0,3.0+nz*2.5,dep);               // wet edge
          float lines=sin(dep*0.9-time*0.9+nz*5.0)*0.5+0.5;
          float band=(1.0-smoothstep(2.0,12.0,dep))*smoothstep(0.55,0.95,lines)*(0.35+0.65*nz);
          foam=clamp(shore*0.9+band*0.65,0.0,1.0)*inside*step(-0.05,dep+0.05);
          foam*=1.0-smoothstep(1500.0,3000.0,d);
        }
        c=mix(c,vec3(0.93,0.97,1.0)*(0.3+0.7*glint),foam);
        a=max(a,foam*0.95);
        float fg=smoothstep(fogNear,fogFar,d);
        c=mix(c,fogColor,fg);
        gl_FragColor=vec4(c,max(a,fg));
      }`,
  }));
  // Radial grid in the xz plane: ring radii grow geometrically (~6 m spacing at
  // the centre, ~600 m at the 12 km rim), so a few thousand vertices cover it.
  function radialGrid(rings, segs, rMin, rMax) {
    const pos = new Float32Array((rings * segs + 1) * 3);
    let o = 3; // vertex 0 = centre
    const k = Math.log(rMax / rMin + 1);
    for (let i = 1; i <= rings; i++) {
      const r = rMin * (Math.exp(k * i / rings) - 1);
      for (let j = 0; j < segs; j++) {
        const a = j / segs * Math.PI * 2;
        pos[o++] = Math.cos(a) * r; pos[o++] = 0; pos[o++] = Math.sin(a) * r;
      }
    }
    const idx = [];
    for (let j = 0; j < segs; j++) idx.push(0, 1 + (j + 1) % segs, 1 + j);
    for (let i = 1; i < rings; i++) {
      const a0 = 1 + (i - 1) * segs, b0 = 1 + i * segs;
      for (let j = 0; j < segs; j++) {
        const j1 = (j + 1) % segs;
        idx.push(a0 + j, b0 + j1, b0 + j, a0 + j, a0 + j1, b0 + j1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }
  const ocean = new THREE.Mesh(radialGrid(72, 120, 40, 12000), oceanMat);
  ocean.frustumCulled = false;
  ocean.position.y = 0;
  scene.add(ocean);

  // --- Planar water reflection (v11) ---
  // A mirrored camera renders the world above the waterline into a low-res
  // target; an oblique near plane (Lengyel, as three's Reflector does) clips
  // everything below y = 0, so the seabed never paints over the reflection.
  // Full detail only: a whole extra scene pass is what a slow GPU can't spare.
  let reflWanted = true;
  const refl = { on: false, rt: null, cam: new THREE.PerspectiveCamera(), w: 0, h: 0 };
  const _rp = new THREE.Vector3(), _rn = new THREE.Vector3(0, 1, 0), _rv = new THREE.Vector3(),
    _rt = new THREE.Vector3(), _rl = new THREE.Vector3(), _rm = new THREE.Matrix4(),
    _rplane = new THREE.Plane(), _rclip = new THREE.Vector4(), _rq = new THREE.Vector4();
  const RBIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  // The reflection code is compiled in only while reflections run (a define):
  // a software rasterizer pays for an untaken branch over the whole ocean.
  function setReflDefine(on) {
    const has = !!oceanMat.defines?.OCEAN_REFL;
    if (has === on) return;
    oceanMat.defines = oceanMat.defines || {};
    if (on) oceanMat.defines.OCEAN_REFL = 1; else delete oceanMat.defines.OCEAN_REFL;
    oceanMat.needsUpdate = true;
  }
  function renderReflection(camera) {
    setReflDefine(refl.on);
    if (!refl.on || !renderer || !ocean.visible) { oceanMat.uniforms.reflOn.value = 0; return; }
    const cp = camera.getWorldPosition(_rv.set(0, 0, 0)).clone();
    if (cp.y < 0.5 || cp.y > 4500) { oceanMat.uniforms.reflOn.value = 0; return; }
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.round(size.x / 3)), h = Math.max(64, Math.round(size.y / 3));
    if (!refl.rt || refl.w !== w || refl.h !== h) {
      refl.rt?.dispose();
      refl.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
      refl.w = w; refl.h = h;
      oceanMat.uniforms.reflTex.value = refl.rt.texture;
    }
    const vc = refl.cam;
    _rp.set(cp.x, 0, cp.z);                                       // plane point under the camera
    _rm.extractRotation(camera.matrixWorld);
    _rl.set(0, 0, -1).applyMatrix4(_rm).add(cp);
    vc.position.set(cp.x, -cp.y, cp.z);
    _rt.copy(_rl); _rt.y = -_rt.y;
    vc.up.set(0, 1, 0).applyMatrix4(_rm).reflect(_rn);
    vc.lookAt(_rt);
    vc.near = camera.near; vc.far = camera.far;
    vc.fov = camera.fov; vc.aspect = camera.aspect;
    vc.updateMatrixWorld();
    vc.updateProjectionMatrix();
    oceanMat.uniforms.reflMatrix.value.copy(RBIAS).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    // oblique near plane = the water plane
    _rplane.setFromNormalAndCoplanarPoint(_rn, _rp).applyMatrix4(vc.matrixWorldInverse);
    _rclip.set(_rplane.normal.x, _rplane.normal.y, _rplane.normal.z, _rplane.constant);
    const pe = vc.projectionMatrix.elements;
    _rq.set((Math.sign(_rclip.x) + pe[8]) / pe[0], (Math.sign(_rclip.y) + pe[9]) / pe[5], -1, (1 + pe[10]) / pe[14]);
    _rclip.multiplyScalar(2 / _rclip.dot(_rq));
    pe[2] = _rclip.x; pe[6] = _rclip.y; pe[10] = _rclip.z + 1 - 0.003; pe[14] = _rclip.w;
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();
    // NB: do not switch shadowMap.autoUpdate off for this pass to "reuse" the
    // shadow map. Doing so left shadow-receiving draws bound to a texture of
    // the wrong type (GL_INVALID_OPERATION: sampler mismatch) and every
    // opaque mesh vanished from the main view for the rest of the session.
    const prevRT = renderer.getRenderTarget();
    ocean.visible = false;
    renderer.setRenderTarget(refl.rt);
    renderer.clear();
    renderer.render(scene, vc);
    renderer.setRenderTarget(prevRT);
    ocean.visible = true;
    oceanMat.uniforms.reflOn.value = 1;
  }

  // --- Clouds: low-poly cumulus (see buildClouds) ---
  const { clouds, cloudMat, updateClouds, setCover, dims: cloudDims } = buildClouds(scene, tod);
  // Volumetric cumulus over the same clusters (volclouds.js): full detail only.
  const vol = createVolumetricClouds({ scene, uniforms: cloudMat.uniforms, dims: cloudDims, max: MAX_CLUSTERS });
  let volWanted = true, volDetail = true, cloudsShown = true;
  const applyCloudMode = () => {
    const v = volWanted && volDetail;
    clouds.visible = cloudsShown && !v;
    vol.setOn(cloudsShown && v);
  };

  // --- Blob shadow under the aircraft (no shadow maps needed) ---
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(3.1, 20),
    new THREE.MeshBasicMaterial({ color: 0x10180f, transparent: true, opacity: 0.24, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1.35, 1, 1); // wingspan-ish ellipse
  scene.add(shadow);

  // --- Airfield lighting (runwayLights.js): edge/centreline/threshold
  // lights, approach lights with sequenced flashers, and a live PAPI. Lit at
  // dawn, dusk and night or whenever the weather pulls visibility in; the PAPI
  // shows in daylight too.
  let rwyLights = null;
  const disposeRwy = () => {
    if (!rwyLights) return;
    scene.remove(rwyLights.group);
    rwyLights.dispose();
    rwyLights = null;
  };
  function buildRunwayLights(map) {
    disposeRwy();
    rwyLights = createRunwayLights(map);
    scene.add(rwyLights.group);
  }
  function lightLevel() {
    const todK = tod.night ? 1 : tod === TIMES.day ? 0 : 0.75;
    return Math.max(todK, wx.visF * wxSky.vis < 0.75 || wxSky.overcast > 0.5 ? 0.8 : 0);
  }

  // Re-apply night content (glow, beacons, runway lights, landing light gate)
  // to whatever scenery/map is current. Called on time change and map load.
  function applyNightContent() {
    if (rwyLights) { rwyLights.setMode(lightLevel()); rwyLights.setFog(scene.fog.far); }
    if (scenery && scenery.userData) {
      scenery.userData.nightGlow?.(tod.night);
      const beacons = scenery.userData.beacons;
      if (beacons) for (const b of beacons) b.visible = tod.night;
    }
  }

  // Precipitation sky (weather.js drives it per frame): `overcast` greys and
  // darkens the whole palette, `vis` multiplies visibility, `inCloud` is the
  // whiteout while the camera is inside the deck, `flash` a lightning flash.
  const wxSky = { overcast: 0, vis: 1, inCloud: 0, flash: 0, cloudCol: new THREE.Color(0x8d949c) };
  const _c = new THREE.Color(), _hsl = { h: 0, s: 0, l: 0 };
  // Grey a colour toward a storm tone: desaturate and darken by k.
  function storm(out, src, k, dark = 0.3) {
    src.getHSL(_hsl);
    out.setHSL(_hsl.h, _hsl.s * (1 - 0.85 * k), _hsl.l * (1 - dark * k));
    return out;
  }

  function setTimeOfDay(name) {
    tod = TIMES[name] || TIMES.day;
    applyPalette();
  }
  let lastEnvKey = '';
  function applyPalette() {
    const k = wxSky.overcast;
    // in-cloud whiteout is fog, not sky: no env regen while crossing the deck
    const envKey = `${tod.label}|${k.toFixed(1)}`;
    if (envKey !== lastEnvKey) { lastEnvKey = envKey; envDirty = true; }
    if (renderer) renderer.toneMappingExposure = tod.exposure * (1 - 0.08 * k);
    DISPLAY.exposure.value = renderer ? renderer.toneMappingExposure : tod.exposure;
    storm(scene.fog.color, tod.fog, k, 0.32);
    scene.background.copy(scene.fog.color);
    storm(hemi.color, tod.hemiSky, k, 0.2); storm(hemi.groundColor, tod.hemiGround, k, 0.2);
    hemi.intensity = tod.hemiI * (1 - 0.15 * k) + wxSky.flash * 2.5;
    sun.color.copy(tod.sunColor); sun.intensity = tod.sunI * (1 - 0.82 * k);
    sun.position.copy(tod.sunDir).multiplyScalar(1000);
    ambient.color.copy(tod.ambient); ambient.intensity = tod.ambientI + wxSky.flash * 1.5;
    storm(skyMat.uniforms.horizon.value, tod.skyHorizon, k, 0.3);
    storm(skyMat.uniforms.zenith.value, tod.skyZenith, k, 0.15);
    skyMat.uniforms.sunDir.value.copy(tod.sunDir);
    skyMat.uniforms.sunI.value = (tod.night ? 1.0 : tod.sunI / 1.9) * (1 - k);
    skyMat.uniforms.sunColor.value.copy(tod.sunColor);
    skyMat.uniforms.haze.value.copy(scene.fog.color);
    skyMat.uniforms.night.value = tod.night ? 1 : 0;
    skyMat.uniforms.flash.value = wxSky.flash;
    oceanMat.uniforms.sunDir.value.copy(tod.sunDir);
    storm(oceanMat.uniforms.deep.value, tod.oceanDeep, k, 0.25);
    storm(oceanMat.uniforms.shallow.value, tod.oceanShallow, k, 0.3);
    oceanMat.uniforms.skyCol.value.copy(skyMat.uniforms.horizon.value);
    oceanMat.uniforms.sunColor.value.copy(tod.sunColor);
    oceanMat.uniforms.fogColor.value.copy(scene.fog.color);
    oceanMat.uniforms.glint.value = (tod.night ? 0.3 : 1.0) * (1 - 0.9 * k);
    const cu = cloudMat.uniforms;
    storm(cu.lit.value, tod.cloud, k, 0.35); cu.sunDir.value.copy(tod.sunDir); cu.sunColor.value.copy(tod.sunColor);
    cu.fogColor.value.copy(scene.fog.color); cu.night.value = tod.night ? 1 : 0;
    applyWeather();
    applyNightContent();
  }

  // Live-weather modifiers layered on top of the time-of-day palette: haze
  // pulls the fog in with falling visibility, cloud cover scales the overcast.
  // The precipitation sky multiplies in, and inside the cloud deck the fog
  // closes to a whiteout.
  let wx = { visF: 1, cloudF: 1 };
  const screenFog = new THREE.Color();
  function applyWeather() {
    const visF = wx.visF * wxSky.vis;
    let near = tod.fogNear * Math.min(1, visF), far = tod.fogFar * visF;
    const ic = wxSky.inCloud;
    if (ic > 0) {
      near = near * (1 - ic) + 4 * ic;
      far = far * (1 - ic) + 140 * ic;
      _c.copy(wxSky.cloudCol);
      scene.fog.color.lerp(_c, ic);
      scene.background.copy(scene.fog.color);
      oceanMat.uniforms.fogColor.value.copy(scene.fog.color);
      cloudMat.uniforms.fogColor.value.copy(scene.fog.color);
    }
    scene.fog.near = near; scene.fog.far = far;
    oceanMat.uniforms.fogNear.value = near;
    oceanMat.uniforms.fogFar.value = far;
    setCover(wxSky.overcast > 0.3 ? 0 : wx.cloudF);
    cloudMat.uniforms.fogNear.value = near;
    cloudMat.uniforms.fogFar.value = far;
    cloudsShown = wx.cloudF > 0.06 && wxSky.overcast <= 0.3;
    applyCloudMode();
    // Custom shaders fade toward the fog as it is DISPLAYED on built-in
    // materials (display.js), so sky, sea and clouds meet the terrain haze.
    displayOf(scene.fog.color, screenFog);
    skyMat.uniforms.haze.value.copy(screenFog);
    oceanMat.uniforms.fogColor.value.copy(screenFog);
    cloudMat.uniforms.fogColor.value.copy(screenFog);
    if (rwyLights) { rwyLights.setMode(lightLevel()); rwyLights.setFog(far); }
  }

  return {
    // Weather visibility/cloud overlay (see liveweather.js). null-safe fields.
    setWeather({ visibilityM, cloudCover } = {}) {
      if (visibilityM != null) wx.visF = Math.max(0.35, Math.min(1.3, visibilityM / 15000));
      if (cloudCover != null) wx.cloudF = Math.max(0, Math.min(1.15, cloudCover / 70));
      applyWeather();
    },
    resetWeather() { wx = { visF: 1, cloudF: 1 }; applyWeather(); },
    /**
     * Precipitation sky from weather.js. Cheap to call every frame: the
     * palette is only rewritten when something moved noticeably.
     */
    setSky({ overcast = wxSky.overcast, vis = wxSky.vis, inCloud = wxSky.inCloud, flash = wxSky.flash, cloudCol } = {}) {
      if (cloudCol) wxSky.cloudCol.copy(cloudCol);
      const changed = Math.abs(overcast - wxSky.overcast) > 0.01 || Math.abs(vis - wxSky.vis) > 0.01
        || Math.abs(inCloud - wxSky.inCloud) > 0.01 || Math.abs(flash - wxSky.flash) > 0.01
        || (flash === 0 && wxSky.flash !== 0) || (inCloud === 0 && wxSky.inCloud !== 0);
      if (!changed) return;
      wxSky.overcast = overcast; wxSky.vis = vis; wxSky.inCloud = inCloud; wxSky.flash = flash;
      applyPalette();
    },
    get skyState() { return { ...wxSky, cloudCol: undefined }; },
    /** Milliseconds the last environment-map rebuild took (perf probe). */
    get envMs() { return envMs; },
    /** The fog colour as built-in materials display it (for custom shaders). */
    get screenFog() { return screenFog; },
    // Swap the heightfield used for the blob shadow (called on map change).
    setGround(fn) { groundFn = fn; },
    // Called after a map's scenery is (re)built: rebuild runway lights and grab
    // the map's night-content hooks (window glow toggle + beacon meshes).
    onMapLoaded(map, sceneryGroup) {
      scenery = sceneryGroup || null;
      // Airfield dressing casts and receives, so hangars and the tower read as
      // solid rather than pasted on (v6 shadows).
      scenery?.traverse(o => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      buildRunwayLights(map);
      applyNightContent();
    },
    /** Quality knob: real shadow maps on/off (the blob decal is the fallback). */
    setShadows(on) {
      sun.castShadow = !!on;
      if (!on) sun.position.copy(tod.sunDir).multiplyScalar(1000);
    },
    get shadowsOn() { return sun.castShadow; },
    /**
     * Give every PBR material under `root` the sky environment map (and keep
     * it current across time-of-day changes). `key` replaces an earlier set,
     * e.g. the previous aircraft's materials on a swap.
     */
    applyEnv(root, key) {
      const set = new Set();
      root?.traverse(o => {
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of ms) if (m.isMeshStandardMaterial) { set.add(m); if (envRT) { m.envMap = envRT.texture; m.needsUpdate = true; } }
      });
      envUsers.set(key, set);
    },
    /** Detail level for the ocean (1 full, 0 lite: no ripple layers, no reflection). */
    setDetail(k) {
      oceanMat.uniforms.detail.value = k; refl.on = k > 0.5 && reflWanted; if (!refl.on) oceanMat.uniforms.reflOn.value = 0;
      volDetail = k > 0.5; applyCloudMode();
    },
    /** Raymarched cumulus on/off (still needs full detail); off = billboard clouds. */
    setVolumetricClouds(on) { volWanted = !!on; applyCloudMode(); },
    get volumetricClouds() { return vol.on; },
    /** Planar water reflection on/off (still needs full detail). */
    setReflections(on) { reflWanted = !!on; refl.on = reflWanted && oceanMat.uniforms.detail.value > 0.5; if (!refl.on) oceanMat.uniforms.reflOn.value = 0; },
    get reflecting() { return oceanMat.uniforms.reflOn.value > 0.5; },
    renderReflection,
    /** White PAPI units seen from the camera (null before a map loads). */
    papiWhites() { return rwyLights ? rwyLights.papiWhites() : null; },
    setTimeOfDay,
    sunDirection() { return tod.sunDir.clone(); },
    // DOM/state probe for tests: string + darkening scalars (not pixels).
    state() {
      return {
        timeOfDay: tod.label.toLowerCase(),
        night: tod.night,
        sunIntensity: sun.intensity,
        fogLum: lum(scene.fog.color),
        exposure: renderer ? renderer.toneMappingExposure : null,
      };
    },
    /** Ocean shallows/foam read the active map's height (cosmetic, read-only). */
    setHeightFn(fn) { heightFn = fn; depthValid = false; build = null; oceanMat.uniforms.depthOn.value = 0; },
    update(ac, dt, elapsed, camPos, cam) {
      oceanMat.uniforms.time.value = elapsed;
      if (envDirty && (envAt < 0 || elapsed - envAt > 0.5)) regenEnv(elapsed);
      if (rwyLights && cam && renderer) rwyLights.update(cam, elapsed, renderer);
      skyMat.uniforms.time.value = elapsed;
      ocean.position.x = ac.pos.x;
      ocean.position.z = ac.pos.z;
      updateDepth(ac.pos.x, ac.pos.z);
      sky.position.set(ac.pos.x, 0, ac.pos.z);

      updateClouds(ac, dt, camPos);
      if (camPos) vol.update(camPos, elapsed);

      // Landing-light cone: nose-mounted spotlight pointing along body +x. Only
      // lit at night; a single no-shadow light, so it stays cheap.
      if (tod.night) {
        tmpQ.set(ac.q.x, ac.q.y, ac.q.z, ac.q.w);
        fwdV.set(1, 0, 0).applyQuaternion(tmpQ);
        landing.position.set(ac.pos.x, ac.pos.y, ac.pos.z);
        landing.target.position.set(
          ac.pos.x + fwdV.x * 200, ac.pos.y + fwdV.y * 200 - 12, ac.pos.z + fwdV.z * 200);
        landing.intensity = 8;
      } else {
        landing.intensity = 0;
      }

      // Beacon blink (night city towers): pulse emissive intensity.
      if (tod.night && scenery && scenery.userData && scenery.userData.beacons) {
        const pulse = 0.35 + 0.65 * Math.max(0, Math.sin(elapsed * 3.2));
        for (const b of scenery.userData.beacons) if (b.material) b.material.emissiveIntensity = pulse;
      }

      // Keep the shadow box on the aircraft; the light stays a direction, so
      // move both the source and its target together.
      if (sun.castShadow) {
        sun.target.position.set(ac.pos.x, 0, ac.pos.z);
        sun.target.updateMatrixWorld();
        sun.position.set(
          ac.pos.x + tod.sunDir.x * 900,
          tod.sunDir.y * 900,
          ac.pos.z + tod.sunDir.z * 900);
      }

      const gy = groundFn(ac.pos.x, ac.pos.z);
      shadow.position.set(ac.pos.x, Math.max(gy, 0) + 0.15, ac.pos.z);
      const agl = Math.max(ac.pos.y - gy, 0);
      const k = Math.max(0, 1 - agl / 120);
      // The painted ellipse is the fallback for when real shadows are off; with
      // shadow maps on it would double up under the aircraft.
      shadow.material.opacity = (tod.night ? 0.18 : 0.32) * k;
      const s = 1 + agl * 0.02;
      shadow.scale.set(s * 1.35, s, s);
      shadow.visible = !sun.castShadow && k > 0.01;
    },
  };
}
