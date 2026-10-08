// Sky dome (scattering-style gradient, halo, stars), sun light, procedural ocean,
// low-poly faceted cumulus, blob shadow.
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

// Low-poly cumulus, matching the faceted terrain: each cloud is a handful of
// subdivided icosahedra merged into one flat-shaded mesh, with the underside
// sheared flat at a common base (that flat bottom is what makes it read as
// cumulus rather than a pile of rocks). Shading is stylised rather than lit by
// the scene: bright sunlit tops, cool blue-grey undersides, a warm rim toward
// the sun. Opaque, so there is nothing to sort and no overdraw to pay for.
function buildClouds(scene, tod) {
  let seed = 99;
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      lit: { value: tod.cloud.clone() }, sunDir: { value: tod.sunDir.clone() },
      sunColor: { value: tod.sunColor.clone() },
      fogColor: { value: tod.fog.clone() }, fogNear: { value: tod.fogNear }, fogFar: { value: tod.fogFar },
      opacity: { value: 1 }, night: { value: 0 },
    },
    vertexShader: `varying vec3 vN; varying vec3 vWorld;
      void main(){ vN=normal; vec4 w=modelMatrix*vec4(position,1.0); vWorld=w.xyz;
        gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform vec3 lit,sunDir,sunColor,fogColor; uniform float fogNear,fogFar,night;
      varying vec3 vN; varying vec3 vWorld;
      void main(){
        vec3 n=normalize(vN);
        vec3 under=lit*vec3(0.66,0.72,0.84);
        vec3 c=mix(under,lit,smoothstep(-0.55,0.75,n.y));
        float sun=max(dot(n,sunDir),0.0);
        c*=0.86+0.22*sun;
        vec3 toCam=normalize(cameraPosition-vWorld);
        float rim=pow(1.0-max(dot(n,toCam),0.0),3.0)*max(dot(-toCam,sunDir),0.0);
        c+=sunColor*rim*0.35*(1.0-night);
        float d=distance(cameraPosition,vWorld);
        c=mix(c,fogColor,smoothstep(fogNear,fogFar*1.2,d));
        gl_FragColor=vec4(c,1.0);
      }`,
  });

  const group = new THREE.Group();
  const clusters = [];
  for (let i = 0; i < 34; i++) {
    const W = 220 + rng() * 420, H = W * (0.32 + rng() * 0.18);
    const parts = [];
    const n = 5 + Math.floor(rng() * 5);
    for (let b = 0; b < n; b++) {
      const u = (rng() - 0.5) * 2, dome = 1 - u * u;
      const r = W * (0.16 + rng() * 0.12) * (0.65 + 0.5 * dome);
      const g = new THREE.IcosahedronGeometry(r, 1);
      g.translate(u * W * 0.42, r * 0.55 + H * dome * rng() * 0.5, (rng() - 0.5) * W * 0.4);
      parts.push(g.toNonIndexed());
      g.dispose();
    }
    // merge + shear the bottom flat at y = 0
    let count = 0;
    for (const g of parts) count += g.attributes.position.count;
    const pos = new Float32Array(count * 3);
    let o = 0;
    for (const g of parts) {
      const a = g.attributes.position.array;
      for (let k = 0; k < a.length; k += 3) {
        pos[o++] = a[k]; pos[o++] = Math.max(a[k + 1], 0) * 0.85; pos[o++] = a[k + 2];
      }
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();                   // non-indexed -> flat facets
    const m = new THREE.Mesh(geo, mat);
    m.position.set((rng() - 0.5) * CLOUD_WRAP * 2, 520 + rng() * 650, (rng() - 0.5) * CLOUD_WRAP * 2);
    m.rotation.y = rng() * Math.PI * 2;
    group.add(m);
    clusters.push(m);
  }
  scene.add(group);

  function updateClouds(ac, dt) {
    for (const c of clusters) {
      c.position.x += dt * 2.2;
      if (c.position.x - ac.pos.x > CLOUD_WRAP) c.position.x -= CLOUD_WRAP * 2;
      if (ac.pos.x - c.position.x > CLOUD_WRAP) c.position.x += CLOUD_WRAP * 2;
      if (c.position.z - ac.pos.z > CLOUD_WRAP) c.position.z -= CLOUD_WRAP * 2;
      if (ac.pos.z - c.position.z > CLOUD_WRAP) c.position.z += CLOUD_WRAP * 2;
    }
  }
  // Cloud cover (live weather): show a fraction of the clusters.
  function setCover(f) {
    const k = Math.round(clusters.length * Math.max(0, Math.min(1, f)));
    clusters.forEach((c, i) => { c.visible = i < k; });
  }
  return { clouds: group, cloudMat: mat, updateClouds, setCover };
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

  const oceanMat = new THREE.ShaderMaterial({
    fog: false, transparent: true, side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 }, sunDir: { value: tod.sunDir.clone() },
      deep: { value: tod.oceanDeep.clone() }, shallow: { value: tod.oceanShallow.clone() },
      skyCol: { value: tod.skyHorizon.clone() }, sunColor: { value: tod.sunColor.clone() },
      fogColor: { value: tod.fog.clone() }, fogNear: { value: tod.fogNear }, fogFar: { value: tod.fogFar },
      glint: { value: 1.0 },
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
      uniform float time,fogNear,fogFar,glint,depthOn; uniform vec3 sunDir,deep,shallow,skyCol,sunColor,fogColor;
      uniform sampler2D depthTex; uniform vec3 depthRect;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float vnoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
      void main(){
        vec2 p=vWorld.xz;
        // flat facet normal from screen derivatives; fades toward a soft analytic
        // ripple where the swell has faded out (shallows, distance)
        vec3 nf=normalize(cross(dFdy(vWorld),dFdx(vWorld)));
        if(nf.y<0.0) nf=-nf;
        vec3 ns=normalize(vec3(
          sin(p.x*0.018-time*0.35)*0.035+sin((p.x+p.y)*0.011+time*0.27)*0.03,
          1.0,
          sin(p.y*0.015+time*0.3)*0.035+sin((p.y-p.x)*0.009-time*0.22)*0.03));
        vec3 n=normalize(mix(ns,nf,vSwell*0.9));
        vec3 view=normalize(cameraPosition-vWorld);
        float fres=pow(1.0-max(dot(view,n),0.0),3.0);
        vec3 c=mix(deep,shallow,0.25);
        c=mix(c,skyCol,fres*0.75);                                      // sky reflection
        vec3 r=reflect(-sunDir,n);
        float sp=max(dot(r,view),0.0);
        c+=sunColor*(pow(sp,400.0)*2.2+pow(sp,24.0)*0.12)*glint;        // sun path + sheen
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
  });
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

  // --- Clouds: low-poly cumulus (see buildClouds) ---
  const { clouds, cloudMat, updateClouds, setCover } = buildClouds(scene, tod);

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
    oceanMat.uniforms.skyCol.value.copy(tod.skyHorizon);
    oceanMat.uniforms.sunColor.value.copy(tod.sunColor);
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
    setCover(wx.cloudF);
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
    /** Ocean shallows/foam read the active map's height (cosmetic, read-only). */
    setHeightFn(fn) { heightFn = fn; depthValid = false; build = null; oceanMat.uniforms.depthOn.value = 0; },
    update(ac, dt, elapsed, camPos) {
      oceanMat.uniforms.time.value = elapsed;
      skyMat.uniforms.time.value = elapsed;
      ocean.position.x = ac.pos.x;
      ocean.position.z = ac.pos.z;
      updateDepth(ac.pos.x, ac.pos.z);
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
