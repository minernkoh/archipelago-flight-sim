// Sky dome, sun light, procedural ocean, drifting low-poly clouds, blob shadow.
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
    skyHorizon: C(0xe8955a), skyZenith: C(0x35406e),
    oceanDeep: C(0x233046), oceanShallow: C(0x46515e),
    cloud: C(0xf0c090), cloudOpacity: 0.9,
  },
  night: {
    label: 'NIGHT', night: true, exposure: 0.95,
    sunDir: sunDir(40, 34), sunColor: C(0x5a6b8c), sunI: 0.24,
    hemiSky: C(0x1a2436), hemiGround: C(0x080c12), hemiI: 0.26,
    ambient: C(0x24304a), ambientI: 0.10,
    fog: C(0x090f18), fogNear: 900, fogFar: 4200,
    skyHorizon: C(0x0e1622), skyZenith: C(0x04070d),
    oceanDeep: C(0x050a12), oceanShallow: C(0x0d2130),
    cloud: C(0x2a3446), cloudOpacity: 0.85,
  },
};

// Back-compat exports (day baseline).
export const SUN_DIR = TIMES.day.sunDir.clone();
export const FOG_COLOR = TIMES.day.fog.clone();

const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

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
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      horizon: { value: tod.skyHorizon.clone() }, zenith: { value: tod.skyZenith.clone() },
      sunDir: { value: tod.sunDir.clone() }, sunI: { value: 1.0 },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir=normalize(position);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 horizon,zenith,sunDir; uniform float sunI;
      void main(){
        float t=pow(max(vDir.y,0.0),0.55);
        vec3 c=mix(horizon,zenith,t);
        float s=max(dot(vDir,sunDir),0.0);
        c+=vec3(1.0,0.86,0.62)*pow(s,350.0)*1.4*sunI;   // disc
        c+=vec3(1.0,0.9,0.7)*pow(s,8.0)*0.12*sunI;      // glow
        gl_FragColor=vec4(c,1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 24, 12), skyMat);
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

  // --- Clouds: clustered low-poly blobs drifting slowly ---
  const cloudMat = new THREE.MeshLambertMaterial({
    color: tod.cloud.clone(), flatShading: true, transparent: true, opacity: tod.cloudOpacity,
  });
  const clouds = new THREE.Group();
  const rng = (() => { let s = 99; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  for (let i = 0; i < 42; i++) {
    const cluster = new THREE.Group();
    const nBlob = 3 + Math.floor(rng() * 4);
    for (let b = 0; b < nBlob; b++) {
      const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(30 + rng() * 45, 0), cloudMat);
      blob.position.set((rng() - 0.5) * 160, (rng() - 0.5) * 22, (rng() - 0.5) * 90);
      blob.scale.y = 0.45;
      cluster.add(blob);
    }
    cluster.position.set((rng() - 0.5) * 9000, 380 + rng() * 550, (rng() - 0.5) * 9000);
    clouds.add(cluster);
  }
  scene.add(clouds);

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
    skyMat.uniforms.sunI.value = tod.sunI / 1.9;
    oceanMat.uniforms.sunDir.value.copy(tod.sunDir);
    oceanMat.uniforms.deep.value.copy(tod.oceanDeep);
    oceanMat.uniforms.shallow.value.copy(tod.oceanShallow);
    oceanMat.uniforms.fogColor.value.copy(tod.fog);
    oceanMat.uniforms.fogNear.value = tod.fogNear;
    oceanMat.uniforms.fogFar.value = tod.fogFar;
    oceanMat.uniforms.glint.value = tod.night ? 0.3 : 1.0;
    cloudMat.color.copy(tod.cloud); cloudMat.opacity = tod.cloudOpacity;
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
    cloudMat.opacity = tod.cloudOpacity * wx.cloudF;
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
    update(ac, dt, elapsed) {
      oceanMat.uniforms.time.value = elapsed;
      ocean.position.x = ac.pos.x;
      ocean.position.z = ac.pos.z;
      sky.position.set(ac.pos.x, 0, ac.pos.z);

      // wrap clouds around the player
      for (const c of clouds.children) {
        c.position.x += dt * 2.2;
        if (c.position.x - ac.pos.x > 5000) c.position.x -= 10000;
        if (ac.pos.x - c.position.x > 5000) c.position.x += 10000;
        if (c.position.z - ac.pos.z > 5000) c.position.z -= 10000;
        if (ac.pos.z - c.position.z > 5000) c.position.z += 10000;
      }

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
