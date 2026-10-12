// Precipitation weather: the SKY half of the RAIN / STORM presets (the wind
// half is WEATHER in physics/wind.js).
//
//  - an overcast deck: a faceted cloud ceiling that follows the aircraft, with
//    a lumpy dark base and a sunlit top. Below it the whole palette greys and
//    visibility closes in; climb into it and the world whites out; break out
//    on top and you are in sunshine.
//  - rain: line streaks wrapped in a box around the camera, stretched along
//    the rain's velocity RELATIVE to the camera, so they slant and lengthen
//    as you speed up (one draw call, all motion in the vertex shader).
//  - windscreen rain in the cockpit view: procedural beads that the airflow
//    drags up the glass as airspeed builds.
//  - lightning (storm): a branching bolt between the deck and the ground, a
//    sky/ambient flash, and thunder delayed by distance / speed of sound.
//
// Visual only. The wet runway's lower braking friction is physics
// (groundContact reads env.wet, main.js sets it from WET_WEATHER).

import * as THREE from 'three';
import { cloudNoiseTexture } from './volclouds.js';
import { RUNWAY_WX } from './maps/runwayPaint.js';
import { displayMatch } from './display.js';

export const SKY_PRESETS = {
  clear: { overcast: 0, rain: 0, lightning: 0, deck: 0, vis: 1 },
  rain:  { overcast: 0.72, rain: 0.55, lightning: 0, deck: 640, vis: 0.5 },
  storm: { overcast: 1, rain: 1, lightning: 1, deck: 430, vis: 0.34 },
};
const DECK_THICK = 380;

// ------------------------------------------------------------------ deck --
function deckMaterial(top) {
  return displayMatch(new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog: false,
    uniforms: {
      base: { value: 500 }, col: { value: new THREE.Color() }, fogColor: { value: new THREE.Color() },
      fogNear: { value: 500 }, fogFar: { value: 3000 }, flash: { value: 0 }, time: { value: 0 },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      // v12 volumetric shading (full detail): the shared 3D cloud noise
      noise3: { value: null }, vol: { value: 0 },
    },
    vertexShader: `
      uniform float base, time; varying vec3 vW; varying vec3 vN;
      float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
      float lump(vec2 p){ return n2(p / 520.0) * 0.65 + n2(p / 190.0) * 0.35; }
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vec2 p = w.xz + vec2(time * 3.0, time * 1.2);
        float n = lump(p);
        float e = 12.0;
        vec2 gr = vec2(lump(p + vec2(e, 0.0)) - n, lump(p + vec2(0.0, e)) - n) / e;
        ${top ? 'w.y = base + ' + DECK_THICK + '.0 - 60.0 + n * 150.0; vN = normalize(vec3(-gr.x * 150.0, 1.0, -gr.y * 150.0));'
              : 'w.y = base + 40.0 - n * 130.0; vN = normalize(vec3(-gr.x * 130.0, -1.0, -gr.y * 130.0));'}
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      precision highp sampler3D;
      uniform vec3 col, fogColor, sunDir; uniform float fogNear, fogFar, flash, vol, time, base;
      uniform sampler3D noise3;
      varying vec3 vW; varying vec3 vN;
      float dn(vec3 p){ return texture(noise3, (p + vec3(time * 3.0, 0.0, time * 1.2)) / 1100.0).r * 0.7
                              + texture(noise3, (p + vec3(time * 3.0, 0.0, time * 1.2)) / 240.0).r * 0.3; }
      void main(){
        vec3 n = normalize(vN);
        float l = ${top ? '0.82 + 0.25 * max(dot(n, sunDir), 0.0)' : '0.78 + 0.32 * (1.0 + n.y) + 0.12 * abs(n.x)'};
        if (vol > 0.5) {
          // volumetric shading: march into the deck to see how much cloud
          // stands between this point and the light (sun above the top, the
          // whole deck above the base), Beer-Lambert, plus billowed detail
          float od = 0.0;
          ${top
            ? `for (int i = 1; i <= 4; i++) od += dn(vW + sunDir * 45.0 * float(i) - vec3(0.0, 30.0, 0.0));
               float beer = exp(-od * 0.55);
               float billow = dn(vW);
               l = 0.62 + 0.5 * beer * max(sunDir.y + 0.25, 0.0) + 0.22 * billow;`
            : `for (int i = 1; i <= 4; i++) od += dn(vW + vec3(0.0, 70.0 * float(i), 0.0));
               float billow = dn(vW);
               l = (1.02 - 0.42 * smoothstep(1.2, 3.2, od)) * (0.82 + 0.3 * billow) + 0.1 * abs(n.x);`}
        }
        vec3 c = col * l + vec3(0.7, 0.75, 0.9) * flash;
        float d = distance(cameraPosition, vW);
        c = mix(c, fogColor, smoothstep(fogNear, fogFar, d));
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
}

// ------------------------------------------------------- volumetric deck --
// Full detail (v12): the overcast as a real volume. A camera-following box
// stands in for an infinite slab (deck base - 140 m .. top + 160 m); the
// shader intersects the ray with the slab analytically and marches the shared
// 3D cloud noise through it. The density is a vertical envelope plus noise,
// so the core of the layer is solid while its base hangs down in ragged scud
// and its top boils up in turrets. Light: Beer-Lambert toward the sun with
// forward scattering on top, ambient from grey underside to white top, and
// the lightning flash. Front faces from outside, back faces when the camera
// is inside the layer (same scheme as volclouds.js).
const SLAB_LO = 140, SLAB_HI = 160;
function deckVolumeMaterial(noise3) {
  return displayMatch(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, fog: false, side: THREE.FrontSide,
    uniforms: {
      noise3: { value: noise3 }, base: { value: 500 }, cover: { value: 1 }, time: { value: 0 },
      lo: { value: new THREE.Color() }, hi: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) },
      fogColor: { value: new THREE.Color() }, fogNear: { value: 500 }, fogFar: { value: 3000 }, flash: { value: 0 }, sun: { value: 1 },
    },
    vertexShader: `
      varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      precision highp sampler3D;
      uniform sampler3D noise3; uniform float base, cover, time, fogNear, fogFar, flash, sun;
      uniform vec3 lo, hi, sunDir, fogColor;
      varying vec3 vW;
      const float THICK = ${DECK_THICK}.0, Y0OFF = ${SLAB_LO}.0, Y1OFF = ${SLAB_HI}.0;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      // base and top are noise heightfields over the layer (ragged scud below,
      // turrets above); the detail noise erodes the edges
      float farK = 1.0;                     // 1 near .. 0 far: calms detail with distance
      vec2 layer(vec3 q){
        float a = texture(noise3, vec3(q.x, 37.0, q.z) / 2100.0).r, b = texture(noise3, vec3(q.x, 811.0, q.z) / 700.0).r;
        float hb = 0.12 + 0.2 * (a * 0.6 + b * 0.4);                     // base (fraction of the slab)
        float ht = 0.52 + 0.44 * smoothstep(0.2, 0.95, a * 0.62 + b * 0.38 * farK) * (0.55 + 0.45 * cover);
        return vec2(hb, ht);
      }
      float dens(vec3 p, bool detail){
        float y0 = base - Y0OFF, y1 = base + THICK + Y1OFF;
        float hf = (p.y - y0) / (y1 - y0);
        if (hf < 0.0 || hf > 1.0) return 0.0;
        vec3 q = p + vec3(time * 3.0, 0.0, time * 1.2);
        vec2 L = layer(q);
        float n = texture(noise3, q / 380.0).r;
        float d = smoothstep(L.x - 0.08, L.x + 0.06, hf) * (1.0 - smoothstep(L.y - 0.12, L.y, hf));
        d = d * (0.7 + 0.5 * cover) - (1.0 - n) * 0.45;
        if (detail && d > -0.1 && d < 0.45) d -= (1.0 - texture(noise3, q / 120.0).r) * 0.2 * farK;
        return clamp(d * 2.6, 0.0, 1.0);
      }
      void main(){
        vec3 ro = cameraPosition, rd = normalize(vW - ro);
        float y0 = base - Y0OFF, y1 = base + THICK + Y1OFF;
        float t0, t1;
        if (abs(rd.y) < 1e-4) {
          if (ro.y < y0 || ro.y > y1) discard;
          t0 = 0.0; t1 = 14000.0;
        } else {
          float ta = (y0 - ro.y) / rd.y, tb = (y1 - ro.y) / rd.y;
          t0 = max(min(ta, tb), 0.0); t1 = min(max(ta, tb), 14000.0);
        }
        if (t1 <= t0) discard;
        const int STEPS = 48;
        float dt = clamp((t1 - t0) / 24.0, 8.0, 260.0);
        bool fine = false;
        float t = t0 + dt * hash(gl_FragCoord.xy);
        farK = 1.0 - smoothstep(2500.0, 8000.0, t0);
        float T = 1.0, tHit = -1.0; vec3 acc = vec3(0.0), lastL = vec3(0.0);
        float mu = dot(rd, sunDir);
        float g = 0.5, hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) / 12.566;
        float phase = 0.55 + 6.0 * hg;
        float sigma = 0.02;
        for (int i = 0; i < STEPS; i++) {
          if (t > t1) break;
          vec3 p = ro + rd * t;
          float d = dens(p, true);
          if (d > 0.004 && !fine && dt > 12.0) {
            // first contact on a coarse step: back up and march the surface
            // finely, so long steps never slice it into stripes
            fine = true; t -= dt; dt = clamp(dt * 0.22, 6.0, 18.0); t += dt; farK = 1.0 - smoothstep(2500.0, 8000.0, t); continue;
          }
          if (d > 0.004) {
            if (tHit < 0.0) tHit = t;
            float ld = 0.0;
            for (int j = 1; j <= 3; j++) ld += dens(p + sunDir * 45.0 * float(j), false);
            // the march sees the turrets; the rest of the layer above (to its
            // mean top) is added analytically, so the base is never sunlit
            vec2 Lh = layer(p + vec3(time * 3.0, 0.0, time * 1.2));
            float topY = y0 + (y1 - y0) * Lh.y;
            float column = max(0.0, topY - p.y - 135.0) / max(sunDir.y, 0.12);
            float beer = exp(-ld * 45.0 * sigma * 0.9 - column * sigma * 0.55) * smoothstep(-0.05, 0.25, sunDir.y);
            float hf = clamp((p.y - y0) / (y1 - y0), 0.0, 1.0);
            // ambient: grey underside, brighter toward the tops, darker in the folds
            float occl = smoothstep(Lh.x, Lh.y, hf);
            vec3 amb = mix(lo, hi * 0.78, occl * occl);
            vec3 L = amb * (0.85 + 0.2 * (1.0 - exp(-d * 3.0))) + hi * beer * phase * 0.62 * sun + vec3(0.7, 0.75, 0.9) * flash;
            float a = 1.0 - exp(-d * sigma * dt);
            acc += T * L * a;
            T *= 1.0 - a;
            lastL = L;
            if (T < 0.02) break;
          }
          t += dt;
        }
        // out of steps while still inside the layer and in cloud: the rest of
        // this (grazing) path is cloud too, so close it rather than let the
        // sky show through between the turrets
        if (tHit > 0.0 && T >= 0.02 && t < t1 - 1.0) { acc += T * lastL; T = 0.0; }
        // fog by the first hit up close, by the (smooth) layer entry far away,
        // where the hit distance jumps from turret to turret pixel by pixel
        float fogT = tHit < 0.0 ? t0 : min(tHit, t0 + 1200.0);
        float f = smoothstep(fogNear, fogFar, fogT);
        // far away the layer is a solid grey ceiling (and the step jitter would
        // otherwise show as grain where the steps are long)
        // and beyond ~4 km it reads as a closed layer from either side
        float solid = max(smoothstep(0.35, 0.9, f), smoothstep(4000.0, 9000.0, t0)) * step(0.5, cover);
        // a closed layer has a solid core: any ray from above going down (or
        // from below going up) that slipped between the turrets within the
        // march would still meet it further on
        if (cover >= 0.5 && ((ro.y > y1 && rd.y < 0.0) || (ro.y < y0 && rd.y > 0.0))) solid = 1.0;
        vec3 far = ro.y > y1 ? hi * 0.9 : lo;
        float hitA = 1.0 - T;
        float alpha = max(hitA, solid);
        if (alpha < 0.004) discard;
        vec3 c = hitA > 0.004 ? mix(far, acc / hitA, hitA / alpha) : far;
        c = mix(c, fogColor, f);
        gl_FragColor = vec4(c, alpha);
      }`,
  }));
}

// ------------------------------------------------------------------ rain --
const RAIN_N = 5000, RAIN_BOX = 46;
function buildRain() {
  const seed = new Float32Array(RAIN_N * 2 * 4);
  const pos = new Float32Array(RAIN_N * 2 * 3);
  for (let i = 0; i < RAIN_N; i++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()];
    for (let e = 0; e < 2; e++) {
      seed.set([s[0], s[1], s[2], e === 0 ? s[3] : -1 - s[3]], (i * 2 + e) * 4);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  const mat = displayMatch(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: {
      camPos: { value: new THREE.Vector3() }, fall: { value: new THREE.Vector3(0, -9, 0) },
      rel: { value: new THREE.Vector3(0, -9, 0) }, time: { value: 0 }, amount: { value: 0 },
      col: { value: new THREE.Color(0xb9c4cf) }, flash: { value: 0 },
    },
    vertexShader: `
      attribute vec4 seed; uniform vec3 camPos, fall, rel; uniform float time, amount;
      varying float vA;
      void main(){
        float box = ${RAIN_BOX.toFixed(1)};
        float endp = seed.w < 0.0 ? 1.0 : 0.0;
        float density = seed.w < 0.0 ? -seed.w - 1.0 : seed.w;
        vec3 p = seed.xyz * box + fall * time;
        p = mod(p - camPos + box * 0.5, box) - box * 0.5 + camPos;
        // trailing end: back along the drop's velocity relative to the camera
        float len = clamp(length(rel) * 0.028, 0.35, 3.0);
        p -= normalize(rel) * len * endp;
        float d = length(p - camPos);
        vA = (1.0 - smoothstep(box * 0.28, box * 0.5, d)) * step(density, amount) * (1.0 - endp * 0.8);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 col; uniform float flash; varying float vA;
      void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(col + flash, 0.22 * vA); }`,
  }));
  const lines = new THREE.LineSegments(g, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 5;
  return lines;
}

// ---------------------------------------------------- windscreen beads --
function buildScreenRain() {
  const mat = displayMatch(new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, fog: false,
    uniforms: { time: { value: 0 }, wet: { value: 0 }, speed: { value: 0 }, aspect: { value: 1.6 }, tint: { value: new THREE.Color(0xc8d2dc) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float time, wet, speed, aspect; uniform vec3 tint; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.743); }
      vec4 layer(vec2 uv, float cells, float t){
        vec2 g = vec2(uv.x * aspect, uv.y) * cells;
        // airflow drags beads up the glass; a slow drip pulls them down when parked
        g.y -= t * (speed * 2.6 - 0.12);
        vec2 id = floor(g), f = fract(g) - 0.5;
        float r = h(id);
        if (r > wet) return vec4(0.0);
        vec2 off = (vec2(h(id + 3.7), h(id + 9.1)) - 0.5) * 0.55;
        vec2 q = f - off;
        q.y /= 1.0 + speed * 2.4;                               // streaks at speed
        float rad = 0.07 + 0.09 * h(id + 1.3);
        float d = length(q);
        float body = smoothstep(rad, rad * 0.7, d);
        float rim = body - smoothstep(rad * 0.85, rad * 0.45, d);
        float spec = smoothstep(rad * 0.4, 0.0, length(q - vec2(-rad * 0.3, rad * 0.35)));
        return vec4(tint * (0.25 + 0.75 * spec) - rim * 0.25, body * 0.32 + spec * 0.4);
      }
      void main(){
        vec4 a = layer(vUv, 9.0, time);
        vec4 b = layer(vUv + 0.37, 16.0, time * 1.3);
        vec4 c = a.a > b.a ? a : b;
        // keep the instrument panel area clear
        c.a *= smoothstep(0.34, 0.42, vUv.y);
        if (c.a < 0.01) discard;
        gl_FragColor = c;
      }`,
  }));
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.renderOrder = 999;
  m.frustumCulled = false;
  return m;
}

// ------------------------------------------------------------- lightning --
function buildBoltMesh() {
  const mat = new THREE.MeshBasicMaterial({ color: 0xe8eeff, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, fog: false });
  const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  m.frustumCulled = false;
  m.visible = false;
  return m;
}
// Jagged path from (x, top, z) down to the ground, with a few branches.
function boltPaths(x, z, top, groundY) {
  const strands = [];
  const strand = (x0, y0, z0, y1, jag, width) => {
    let px = x0, py = y0, pz = z0;
    const segs = Math.max(4, Math.round((y0 - y1) / 40));
    const pts = [[px, py, pz]];
    for (let i = 1; i <= segs; i++) {
      py = y0 + (y1 - y0) * i / segs;
      px += (Math.random() - 0.5) * jag; pz += (Math.random() - 0.5) * jag;
      pts.push([px, py, pz]);
    }
    strands.push({ pts, width });
    return pts;
  };
  const main = strand(x, top, z, groundY, 70, 7);
  for (let k = 0; k < 3; k++) {
    const s = main[1 + Math.floor(Math.random() * Math.max(1, main.length / 2))];
    strand(s[0], s[1], s[2], s[1] - 120 - Math.random() * 200, 60, 3);
  }
  return strands;
}
// Camera-facing ribbon through the paths; `scale` widens it (the halo).
function boltGeometry(strands, cam, scale) {
  const pos = [];
  for (const { pts, width } of strands) {
    const toCam = new THREE.Vector3(cam.x - pts[0][0], 0, cam.z - pts[0][2]).normalize();
    const side = new THREE.Vector3(-toCam.z, 0, toCam.x);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], w = width * scale * (1 - 0.5 * i / pts.length);
      const ax = side.x * w, az = side.z * w;
      pos.push(a[0] - ax, a[1], a[2] - az, a[0] + ax, a[1], a[2] + az, b[0] + ax, b[1], b[2] + az,
        a[0] - ax, a[1], a[2] - az, b[0] + ax, b[1], b[2] + az, b[0] - ax, b[1], b[2] - az);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/**
 * @param {THREE.Scene} scene
 * @param {object} env     environment.js API (setSky, sunDirection)
 * @param {object} audio   audio.js API (setRain, thunder) — optional
 * @param {(p: THREE.Vector3) => {x,y,z}} [windAt] world wind (m/s) at a point
 */
export function createWeatherFX(scene, env, audio, windAt) {
  const deckBottom = new THREE.Mesh(new THREE.PlaneGeometry(18000, 18000, 64, 64), deckMaterial(false));
  const deckTop = new THREE.Mesh(new THREE.PlaneGeometry(18000, 18000, 48, 48), deckMaterial(true));
  for (const d of [deckBottom, deckTop]) {
    d.geometry.rotateX(-Math.PI / 2);
    d.frustumCulled = false;
    d.visible = false;
    scene.add(d);
  }
  // full-detail volume (built on first use; the surfaces above stay the lite path)
  let deckVol = null, volOn = false;
  function ensureVol() {
    if (deckVol) return deckVol;
    deckVol = new THREE.Mesh(new THREE.BoxGeometry(40000, 1, 40000), deckVolumeMaterial(cloudNoiseTexture()));   // wide: grazing rays enter the layer far out
    deckVol.frustumCulled = false;
    deckVol.renderOrder = 1;
    deckVol.visible = false;
    scene.add(deckVol);
    return deckVol;
  }
  const rain = buildRain();
  rain.visible = false;
  scene.add(rain);
  const screen = buildScreenRain();
  screen.visible = false;
  const bolt = buildBoltMesh();
  const halo = buildBoltMesh();
  halo.material.color.set(0x8fa6ff);
  scene.add(bolt, halo);

  let preset = SKY_PRESETS.clear, presetId = 'clear';
  let deckY = 0, groundRef = 0, map = null;
  let nextStrike = 8, boltT = -1, flashT = -1, strikes = 0, boltHold = false, lastBolt = null;
  const camVel = new THREE.Vector3(), lastCam = new THREE.Vector3(), haveCam = { v: false };
  const fallW = new THREE.Vector3();
  const deckCol = new THREE.Color(), topCol = new THREE.Color(), cloudIn = new THREE.Color();
  let screenParent = null;
  const fwdV = new THREE.Vector3();

  function set(id, m) {
    presetId = SKY_PRESETS[id] ? id : 'clear';
    preset = SKY_PRESETS[presetId];
    map = m || map;
    groundRef = map ? map.runway.y : 0;
    deckY = groundRef + preset.deck;
    const on = preset.overcast > 0;
    deckBottom.visible = deckTop.visible = on && !volOn;
    if (deckVol) deckVol.visible = on && volOn;
    deckBottom.material.uniforms.base.value = deckTop.material.uniforms.base.value = deckY;
    rain.visible = preset.rain > 0;
    rain.material.uniforms.amount.value = preset.rain;
    RUNWAY_WX.wet.value = preset.rain > 0 ? 0.55 + 0.45 * preset.rain : 0;
    nextStrike = 6 + Math.random() * 8;
    if (!on) env.setSky({ overcast: 0, vis: 1, inCloud: 0, flash: 0 });
    audio?.setRain?.(0, false);
  }

  return {
    set,
    /** Full detail: volumetric deck shading from the shared 3D cloud noise. */
    setDetail(k) {
      const on = k > 0.5;
      for (const d of [deckBottom, deckTop]) {
        if (on && !d.material.uniforms.noise3.value) d.material.uniforms.noise3.value = cloudNoiseTexture();
        d.material.uniforms.vol.value = on ? 1 : 0;
      }
      // full detail: the raymarched volume replaces the two surfaces
      volOn = on;
      if (on) ensureVol();
      const deckShown = preset.overcast > 0;
      deckBottom.visible = deckTop.visible = deckShown && !volOn;
      if (deckVol) deckVol.visible = deckShown && volOn;
    },
    get volumetricDeck() { return deckTop.material.uniforms.vol.value > 0.5; },
    /** True when the overcast is drawn as the raymarched volume (full detail). */
    get deckVolume() { return !!(deckVol && deckVol.visible); },
    get preset() { return presetId; },
    get deckBase() { return preset.overcast > 0 ? deckY : null; },
    get strikes() { return strikes; },
    /** Force a strike now; hold keeps the bolt lit (art review / tests). */
    strike(hold = false) { nextStrike = 0; boltHold = !!hold; },
    get lastBolt() { return lastBolt; },
    // camera: THREE camera; camMode: CAM mode name; ac: live aircraft
    update(dt, elapsed, ac, camera, camMode) {
      const cam = camera.position;
      if (haveCam.v && dt > 0) camVel.subVectors(cam, lastCam).divideScalar(dt);
      if (camVel.lengthSq() > 250 * 250) camVel.set(0, 0, 0);       // teleport, not motion
      lastCam.copy(cam); haveCam.v = true;
      if (preset.overcast <= 0) {
        if (screen.visible) screen.visible = false;
        return;
      }
      // ---- where is the camera relative to the deck?
      const below = 1 - smoothstep(deckY - 60, deckY + 40, cam.y);
      const above = smoothstep(deckY + DECK_THICK - 40, deckY + DECK_THICK + 80, cam.y);
      const inCloud = Math.max(0, 1 - below - above);
      const overcast = preset.overcast * (1 - above);
      // ---- deck colours from the current (un-greyed) day palette
      const st = env.state();
      const night = st.night ? 1 : 0;
      deckCol.setRGB(0.42, 0.45, 0.5).multiplyScalar(night ? 0.18 : (st.timeOfDay === 'day' ? 1 : 0.62) * (1.08 - 0.3 * preset.overcast));
      topCol.setRGB(0.95, 0.95, 0.97).multiplyScalar(night ? 0.22 : st.timeOfDay === 'day' ? 1 : 0.8);
      cloudIn.copy(deckCol).lerp(topCol, 0.45);
      // ---- lightning
      let flash = 0;
      if (preset.lightning > 0) {
        nextStrike -= dt;
        if (nextStrike <= 0) {
          strikes++;
          nextStrike = 7 + Math.random() * 14;
          // mostly ahead of the camera, where the pilot can see it
          camera.getWorldDirection(fwdV);
          const a = Math.atan2(fwdV.z, fwdV.x) + (Math.random() - 0.5) * 2.0, d = 900 + Math.random() * 2600;
          const x = cam.x + Math.cos(a) * d, z = cam.z + Math.sin(a) * d;
          const gy = map ? Math.max(0, map.height(x, z)) : 0;
          const paths = boltPaths(x, z, deckY + 20, gy);
          bolt.geometry.dispose(); halo.geometry.dispose();
          bolt.geometry = boltGeometry(paths, cam, 1);
          halo.geometry = boltGeometry(paths, cam, 5);
          boltT = 0; flashT = 0;
          const dist = Math.hypot(x - cam.x, deckY * 0.5 - cam.y, z - cam.z);
          lastBolt = { x, z, dist: Math.round(dist) };
          audio?.thunder?.(dist / 343, Math.max(0.25, 1 - dist / 7000));
        }
        if (flashT >= 0) {
          flashT += dt;
          // two quick pulses, the classic flicker
          flash = flashT < 0.08 ? 1 : flashT < 0.14 ? 0.15 : flashT < 0.22 ? 0.75 : Math.max(0, 0.75 - (flashT - 0.22) * 4);
          if (flashT > 0.45) { flashT = -1; flash = 0; }
          flash *= 0.55 * (1 - above * 0.6);
        }
        if (boltT >= 0) {
          boltT += dt;
          bolt.visible = boltHold || (boltT < 0.32 && (boltT < 0.07 || boltT > 0.13));
          bolt.material.opacity = boltHold ? 1 : 1 - boltT / 0.32;
          halo.visible = bolt.visible;
          halo.material.opacity = 0.22 * bolt.material.opacity;
          if (boltT > 0.32 && !boltHold) { boltT = -1; bolt.visible = halo.visible = false; }
        }
      }
      env.setSky({ overcast, vis: 1 - (1 - preset.vis) * (1 - above), inCloud, flash, cloudCol: cloudIn });

      // ---- deck: snap to a grid so the world-space lumps never swim
      const sx = Math.round(cam.x / 300) * 300, sz = Math.round(cam.z / 300) * 300;
      for (const d of [deckBottom, deckTop]) {
        d.position.set(sx, 0, sz);
        const u = d.material.uniforms;
        u.time.value = elapsed; u.flash.value = flash;
        u.fogColor.value.copy(env.screenFog);
        u.fogNear.value = scene.fog.near;
        u.fogFar.value = inCloud > 0.3 ? scene.fog.far : Math.max(scene.fog.far, 600) * (d === deckTop ? 2.5 : 1.6);
      }
      deckBottom.material.uniforms.col.value.copy(deckCol);
      deckTop.material.uniforms.col.value.copy(topCol);
      deckTop.material.uniforms.sunDir.value.copy(env.sunDirection());
      if (deckVol && deckVol.visible) {
        const y0 = deckY - SLAB_LO, y1 = deckY + DECK_THICK + SLAB_HI;
        deckVol.position.set(sx, (y0 + y1) / 2, sz);
        deckVol.scale.set(1, y1 - y0, 1);
        // inside the layer the box's front faces are behind us: draw the back ones
        const inside = cam.y > y0 && cam.y < y1;
        deckVol.material.side = inside ? THREE.BackSide : THREE.FrontSide;
        const u = deckVol.material.uniforms;
        u.base.value = deckY; u.cover.value = preset.overcast; u.time.value = elapsed; u.flash.value = flash;
        u.lo.value.copy(deckCol); u.hi.value.copy(topCol); u.sunDir.value.copy(env.sunDirection());
        u.sun.value = night ? 0.15 : 1;
        u.fogColor.value.copy(env.screenFog);
        u.fogNear.value = scene.fog.near;
        u.fogFar.value = inCloud > 0.3 ? scene.fog.far : Math.max(scene.fog.far, 600) * 2;
      }

      // ---- rain (below and inside the deck only)
      const rainK = preset.rain * (1 - above);
      rain.visible = rainK > 0.02;
      if (rain.visible) {
        const w = windAt ? windAt(cam) : null;
        fallW.set(w ? w.x : 0, -9.5, w ? w.z : 0);
        const u = rain.material.uniforms;
        u.camPos.value.copy(cam);
        u.time.value = elapsed;
        u.fall.value.copy(fallW);
        u.rel.value.copy(fallW).sub(camVel);
        u.amount.value = rainK;
        u.flash.value = flash;
        u.col.value.setRGB(0.66, 0.7, 0.75).multiplyScalar(night ? 0.35 : 1);
      }

      // ---- windscreen beads in the cockpit
      const wantScreen = camMode === 'COCKPIT' && rainK > 0.02;
      if (wantScreen && screenParent !== camera) { camera.add(screen); screenParent = camera; }
      screen.visible = wantScreen;
      if (wantScreen) {
        const dist = camera.near * 1.5;                 // just beyond the near plane
        const hgt = 2 * Math.tan(camera.fov * Math.PI / 360) * dist;
        screen.scale.set(hgt * camera.aspect, hgt, 1);
        screen.position.set(0, 0, -dist);
        const u = screen.material.uniforms;
        u.time.value = elapsed; u.wet.value = 0.25 + 0.4 * rainK;
        u.speed.value = Math.min(1, (ac.airspeed || 0) / 45);
        u.aspect.value = camera.aspect;
        u.tint.value.setRGB(0.8, 0.84, 0.88).multiplyScalar(night ? 0.3 : 1);
      }
      audio?.setRain?.(rainK * (inCloud > 0.5 ? 0.6 : 1), camMode === 'COCKPIT');
    },
  };
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
