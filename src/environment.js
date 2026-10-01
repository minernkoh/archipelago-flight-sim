// Sky dome (scattering-style gradient, halo, stars), sun light, procedural ocean,
// instanced billboard cumulus, blob shadow.
// Time-of-day aware: DAWN / DAY / DUSK / NIGHT swap the whole lighting rig at
// once (never per-frame). Night adds lit runway edge lights, a PAPI bar, a
// landing-light cone from the aircraft, and toggles city window glow/beacons.

import * as THREE from 'three';
import { getTerrainHeight as archipelagoHeight } from './maps/archipelago.js';

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
    sunDir: sunDir(126, 31), sunColor: C(0xfff1d6), sunI: 1.9,
    hemiSky: C(0xbcd3e8), hemiGround: C(0x6b7a5c), hemiI: 0.85,
    ambient: C(0xffffff), ambientI: 0.12,
    fog: C(0xcfdde6), fogNear: 1400, fogFar: 5200,
    skyHorizon: C(0xd7e3ea), skyZenith: C(0x5e8fc4),
    oceanDeep: C(0x1a4a5e), oceanShallow: C(0x2e7a80),
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
    sunDir: sunDir(40, 34), sunColor: C(0x7d92bd), sunI: 0.42,
    hemiSky: C(0x2c3d5e), hemiGround: C(0x0b1018), hemiI: 0.42,
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

// Soft cloud puff: a radial falloff broken up by value noise, built per pixel
// so there are no gradient rings for overlapping puffs to stack into visible
// "bubbles". Alpha only; colour comes from the shader.
function puffTexture() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  const G = 9, grid = [];
  let s = 7;
  for (let i = 0; i < G * G; i++) grid.push((s = (s * 16807) % 2147483647) / 2147483647);
  const vn = (x, y) => {               // bilinear value noise on a GxG lattice
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const g = (a, b) => grid[((b % G) + G) % G * G + ((a % G) + G) % G];
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return (g(ix, iy) * (1 - u) + g(ix + 1, iy) * u) * (1 - v) + (g(ix, iy + 1) * (1 - u) + g(ix + 1, iy + 1) * u) * v;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const nx = x / S * 2 - 1, ny = y / S * 2 - 1;
    const d = Math.hypot(nx, ny);
    const n = 0.55 * vn(x / S * 4, y / S * 4) + 0.3 * vn(x / S * 8 + 3, y / S * 8 + 5) + 0.15 * vn(x / S * 16, y / S * 16);
    const edge = d + (n - 0.5) * 0.55;            // noisy silhouette
    let a = 1 - Math.min(1, Math.max(0, (edge - 0.25) / 0.7));
    a = a * a * (3 - 2 * a) * (0.8 + 0.2 * n);
    const k = (y * S + x) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
    img.data[k + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const CLOUD_WRAP = 5000;     // clusters live in a 10 km box that follows the aircraft

function buildClouds(scene, tod) {
  let seed = 99;
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const clusters = [];       // { x, y, z } centres (drift + wrap in JS)
  const puffs = [];          // { c: clusterIndex, ox, oy, oz, size, shade, rot }
  for (let i = 0; i < 36; i++) {
    const W = 200 + rng() * 400, H = W * (0.28 + rng() * 0.2);
    clusters.push({
      x: (rng() - 0.5) * CLOUD_WRAP * 2, y: 420 + rng() * 700, z: (rng() - 0.5) * CLOUD_WRAP * 2,
    });
    const n = 9 + Math.floor(rng() * 9);
    for (let b = 0; b < n; b++) {
      const u = (rng() - 0.5) * 2;                 // -1..1 across the cloud
      const dome = 1 - u * u;                      // taller in the middle
      const oy = rng() * H * dome;
      puffs.push({
        c: i, ox: u * W * 0.5, oy, oz: (rng() - 0.5) * W * 0.55,
        size: (0.32 + rng() * 0.3) * W * (0.6 + 0.6 * dome),
        shade: Math.min(1, oy / Math.max(1, H) * 0.9 + rng() * 0.2),
        rot: rng() * Math.PI * 2,
      });
    }
  }
  const N = puffs.length;

  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('uv', base.attributes.uv);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  const iData = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3); // size, shade, rot
  iPos.setUsage(THREE.DynamicDrawUsage); iData.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iData', iData);
  geo.instanceCount = N;

  const cloudMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: {
      map: { value: puffTexture() },
      lit: { value: tod.cloud.clone() }, sunDir: { value: tod.sunDir.clone() },
      sunColor: { value: tod.sunColor.clone() },
      fogColor: { value: tod.fog.clone() }, fogNear: { value: tod.fogNear }, fogFar: { value: tod.fogFar },
      opacity: { value: tod.cloudOpacity }, night: { value: 0 },
    },
    vertexShader: `attribute vec3 iPos; attribute vec3 iData;
      varying vec2 vUv; varying float vShade; varying vec3 vWorld;
      void main(){
        float sz=iData.x, rot=iData.z;
        vec2 p=position.xy; float cr=cos(rot), sr=sin(rot);
        p=vec2(p.x*cr-p.y*sr, p.x*sr+p.y*cr)*sz;
        vec4 mv=viewMatrix*vec4(iPos,1.0);
        mv.xy+=p;
        vUv=uv; vShade=iData.y; vWorld=iPos;
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 lit,sunDir,sunColor,fogColor;
      uniform float fogNear,fogFar,opacity,night;
      varying vec2 vUv; varying float vShade; varying vec3 vWorld;
      void main(){
        float a=texture2D(map,vUv).a;
        // vertical shading inside the puff + across the cluster
        float sh=clamp(vShade*0.75+vUv.y*0.35,0.0,1.0);
        vec3 under=lit*vec3(0.58,0.62,0.70);
        vec3 c=mix(under,lit,sh);
        vec3 toCam=normalize(cameraPosition-vWorld);
        float back=pow(max(dot(-toCam,sunDir),0.0),6.0);       // looking into the sun
        c+=sunColor*back*0.35*(1.0-night);                      // glow when looking toward the sun
        float d=distance(cameraPosition,vWorld);
        c=mix(c,fogColor,smoothstep(fogNear,fogFar*1.15,d));
        a*=opacity*smoothstep(25.0,140.0,d);                    // never a screen-filling wall
        if(a<0.01) discard;
        gl_FragColor=vec4(c,a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, cloudMat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);

  const order = Array.from({ length: N }, (_, i) => i);
  const dist = new Float32Array(N);
  let sortT = 1e9;
  function updateClouds(ac, dt, camPos) {
    for (const c of clusters) {
      c.x += dt * 2.2;
      if (c.x - ac.pos.x > CLOUD_WRAP) c.x -= CLOUD_WRAP * 2;
      if (ac.pos.x - c.x > CLOUD_WRAP) c.x += CLOUD_WRAP * 2;
      if (c.z - ac.pos.z > CLOUD_WRAP) c.z -= CLOUD_WRAP * 2;
      if (ac.pos.z - c.z > CLOUD_WRAP) c.z += CLOUD_WRAP * 2;
    }
    sortT += dt;
    if (sortT > 0.4 && camPos) {          // back-to-front, a few times a second
      sortT = 0;
      for (let i = 0; i < N; i++) {
        const p = puffs[i], c = clusters[p.c];
        const dx = c.x + p.ox - camPos.x, dy = c.y + p.oy - camPos.y, dz = c.z + p.oz - camPos.z;
        dist[i] = dx * dx + dy * dy + dz * dz;
      }
      order.sort((a, b) => dist[b] - dist[a]);
    }
    const P = iPos.array, D = iData.array;
    for (let k = 0; k < N; k++) {
      const p = puffs[order[k]], c = clusters[p.c];
      P[k * 3] = c.x + p.ox; P[k * 3 + 1] = c.y + p.oy; P[k * 3 + 2] = c.z + p.oz;
      D[k * 3] = p.size; D[k * 3 + 1] = p.shade; D[k * 3 + 2] = p.rot;
    }
    iPos.needsUpdate = true; iData.needsUpdate = true;
  }
  return { clouds: mesh, cloudMat, updateClouds };
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
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      horizon: { value: tod.skyHorizon.clone() }, zenith: { value: tod.skyZenith.clone() },
      sunDir: { value: tod.sunDir.clone() }, sunI: { value: 1.0 },
      sunColor: { value: tod.sunColor.clone() }, haze: { value: tod.fog.clone() },
      night: { value: 0 }, time: { value: 0 },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir=normalize(position);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vDir;
      uniform vec3 horizon,zenith,sunDir,sunColor,haze; uniform float sunI,night,time;
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
        gl_FragColor=vec4(c,1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), skyMat);
  sky.renderOrder = -1;
  scene.add(sky);

  // --- Ocean ---
  const oceanMat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      time: { value: 0 }, sunDir: { value: tod.sunDir.clone() },
      deep: { value: tod.oceanDeep.clone() }, shallow: { value: tod.oceanShallow.clone() },
      fogColor: { value: tod.fog.clone() }, fogNear: { value: tod.fogNear }, fogFar: { value: tod.fogFar },
      glint: { value: 1.0 },
    },
    vertexShader: `varying vec3 vWorld;
      void main(){ vec4 w=modelMatrix*vec4(position,1.0); vWorld=w.xyz;
        gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `varying vec3 vWorld;
      uniform float time,fogNear,fogFar,glint; uniform vec3 sunDir,deep,shallow,fogColor;
      void main(){
        vec2 p=vWorld.xz;
        vec3 n=normalize(vec3(
          sin(p.x*0.11+time*1.1)*0.05+sin(p.x*0.021-time*0.4)*0.09+sin((p.x+p.y)*0.05+time*0.7)*0.04,
          1.0,
          sin(p.y*0.13+time*0.9)*0.05+sin(p.y*0.017+time*0.5)*0.09));
        vec3 view=normalize(cameraPosition-vWorld);
        float fres=pow(1.0-max(dot(view,n),0.0),2.2);
        vec3 c=mix(deep,shallow,fres*0.9+0.1);
        vec3 r=reflect(-sunDir,n);
        c+=vec3(1.0,0.93,0.75)*pow(max(dot(r,view),0.0),120.0)*1.1*glint; // glint
        c=mix(c,fogColor*0.98,fres*0.35);
        float d=distance(cameraPosition,vWorld);
        c=mix(c,fogColor,smoothstep(fogNear,fogFar,d));
        gl_FragColor=vec4(c,1.0);
      }`,
  });
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000, 1, 1), oceanMat);
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = 0;
  scene.add(ocean);

  // --- Clouds: soft billboard cumulus ---
  // Each cumulus is a cluster of camera-facing puffs: a flat base, a domed top,
  // shaded dark underneath and bright on top, with a silver lining when you
  // look toward the sun. All puffs are ONE instanced mesh (one draw call),
  // re-sorted back-to-front a few times a second so the alpha blends right.
  const { clouds, cloudMat, updateClouds } = buildClouds(scene, tod);

  // --- Blob shadow under the aircraft (no shadow maps needed) ---
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(3.1, 20),
    new THREE.MeshBasicMaterial({ color: 0x10180f, transparent: true, opacity: 0.24, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1.35, 1, 1); // wingspan-ish ellipse
  scene.add(shadow);

  // --- Night runway lighting (built generically from map.runway) ---
  // Edge lights down both sides + a 4-box PAPI abeam the touchdown zone. Cheap
  // MeshBasic emissive-look quads, fog-fading; hidden except at night.
  let rwyLights = null;
  const disposeRwy = () => {
    if (!rwyLights) return;
    scene.remove(rwyLights);
    rwyLights.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    rwyLights = null;
  };
  function buildRunwayLights(map) {
    disposeRwy();
    const r = map.runway;
    rwyLights = new THREE.Group();
    const h = r.headingRad;
    const fwd = { x: Math.cos(h), z: -Math.sin(h) };
    const right = { x: -fwd.z, z: fwd.x };
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xfff0c8 });
    const endMat = new THREE.MeshBasicMaterial({ color: 0x3fd06a });   // threshold (green)
    const geo = new THREE.SphereGeometry(1.3, 6, 4);
    const at = (u, v, mat, y = 1.0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(fwd.x * u + right.x * v, r.y + y, fwd.z * u + right.z * v);
      rwyLights.add(m);
    };
    const len = r.x1 - r.x0, nSeg = 26;
    for (let i = 0; i <= nSeg; i++) {
      const u = r.x0 + len * (i / nSeg);
      const mat = (i === 0 || i === nSeg) ? endMat : edgeMat;
      at(u, r.halfWidth, mat); at(u, -r.halfWidth, mat);
    }
    // PAPI bar: 4 lights left of the touchdown zone (~300 m in from threshold)
    const papiRed = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
    const papiWhite = new THREE.MeshBasicMaterial({ color: 0xf4f6ff });
    for (let k = 0; k < 4; k++) at(r.x0 + 300, -(r.halfWidth + 12 + k * 6), k < 2 ? papiWhite : papiRed, 1.4);
    rwyLights.visible = tod.night;
    scene.add(rwyLights);
  }

  // Re-apply night content (glow, beacons, runway lights, landing light gate)
  // to whatever scenery/map is current. Called on time change and map load.
  function applyNightContent() {
    if (rwyLights) rwyLights.visible = tod.night;
    if (scenery && scenery.userData) {
      scenery.userData.nightGlow?.(tod.night);
      const beacons = scenery.userData.beacons;
      if (beacons) for (const b of beacons) b.visible = tod.night;
    }
  }

  function setTimeOfDay(name) {
    tod = TIMES[name] || TIMES.day;
    if (renderer) renderer.toneMappingExposure = tod.exposure;
    scene.fog.color.copy(tod.fog);
    scene.fog.near = tod.fogNear; scene.fog.far = tod.fogFar;
    scene.background.copy(tod.fog);
    hemi.color.copy(tod.hemiSky); hemi.groundColor.copy(tod.hemiGround); hemi.intensity = tod.hemiI;
    sun.color.copy(tod.sunColor); sun.intensity = tod.sunI;
    sun.position.copy(tod.sunDir).multiplyScalar(1000);
    ambient.color.copy(tod.ambient); ambient.intensity = tod.ambientI;
    skyMat.uniforms.horizon.value.copy(tod.skyHorizon);
    skyMat.uniforms.zenith.value.copy(tod.skyZenith);
    skyMat.uniforms.sunDir.value.copy(tod.sunDir);
    skyMat.uniforms.sunI.value = tod.night ? 1.0 : tod.sunI / 1.9;
    skyMat.uniforms.sunColor.value.copy(tod.sunColor);
    skyMat.uniforms.haze.value.copy(tod.fog);
    skyMat.uniforms.night.value = tod.night ? 1 : 0;
    oceanMat.uniforms.sunDir.value.copy(tod.sunDir);
    oceanMat.uniforms.deep.value.copy(tod.oceanDeep);
    oceanMat.uniforms.shallow.value.copy(tod.oceanShallow);
    oceanMat.uniforms.fogColor.value.copy(tod.fog);
    oceanMat.uniforms.fogNear.value = tod.fogNear;
    oceanMat.uniforms.fogFar.value = tod.fogFar;
    oceanMat.uniforms.glint.value = tod.night ? 0.3 : 1.0;
    const cu = cloudMat.uniforms;
    cu.lit.value.copy(tod.cloud); cu.sunDir.value.copy(tod.sunDir); cu.sunColor.value.copy(tod.sunColor);
    cu.fogColor.value.copy(tod.fog); cu.night.value = tod.night ? 1 : 0;
    applyWeather();
    applyNightContent();
  }

  // Live-weather modifiers layered on top of the time-of-day palette: haze
  // pulls the fog in with falling visibility, cloud cover scales the overcast.
  let wx = { visF: 1, cloudF: 1 };
  function applyWeather() {
    scene.fog.near = tod.fogNear * Math.min(1, wx.visF);
    scene.fog.far = tod.fogFar * wx.visF;
    oceanMat.uniforms.fogNear.value = scene.fog.near;
    oceanMat.uniforms.fogFar.value = scene.fog.far;
    cloudMat.uniforms.opacity.value = tod.cloudOpacity * Math.min(1, wx.cloudF);
    cloudMat.uniforms.fogNear.value = scene.fog.near;
    cloudMat.uniforms.fogFar.value = scene.fog.far;
    clouds.visible = wx.cloudF > 0.06;
  }

  return {
    // Weather visibility/cloud overlay (see liveweather.js). null-safe fields.
    setWeather({ visibilityM, cloudCover } = {}) {
      if (visibilityM != null) wx.visF = Math.max(0.35, Math.min(1.3, visibilityM / 15000));
      if (cloudCover != null) wx.cloudF = Math.max(0, Math.min(1.15, cloudCover / 70));
      applyWeather();
    },
    resetWeather() { wx = { visF: 1, cloudF: 1 }; applyWeather(); },
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
    update(ac, dt, elapsed, camPos) {
      oceanMat.uniforms.time.value = elapsed;
      skyMat.uniforms.time.value = elapsed;
      ocean.position.x = ac.pos.x;
      ocean.position.z = ac.pos.z;
      sky.position.set(ac.pos.x, 0, ac.pos.z);

      updateClouds(ac, dt, camPos);

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
