// Runway dressing shared by every map: a procedural asphalt slab plus
// geometry markings laid out to the ICAO pattern (edge stripes, threshold
// piano keys, designators, centreline, touchdown-zone bars, aiming points).
//
// Markings are real quads, not a stretched canvas, so they stay razor sharp
// at any distance and on any runway length; only the designator digits use a
// small text texture each. The asphalt is shaded in the fragment shader
// (paving lanes, patch repairs, grain, rubber deposits in the touchdown
// zones), so it costs no texture memory either.
//
// Frame: the returned group is in RUNWAY-LOCAL metres: x = 0 at the first
// threshold running to x = length, z across (+z = right of the centreline
// looking down +x), y = 0 on the slab. Callers position/rotate it.

import * as THREE from 'three';

const PAINT = 0xe9ebee;

// Shared by every runway slab: weather.js sets how wet the surface is and the
// sky colour the standing water reflects.
export const RUNWAY_WX = { wet: { value: 0 }, sky: { value: new THREE.Color(0x9aa3ab) } };
let _paintMat = null;
function paintMat() {
  // Stacked above the slab, which is itself polygon-offset above the ground.
  return _paintMat || (_paintMat = new THREE.MeshLambertMaterial({
    color: PAINT, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16,
  }));
}

function asphaltMaterial(length, width, tone) {
  const mat = new THREE.MeshLambertMaterial({
    color: tone, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.rwySize = { value: new THREE.Vector2(length, width) };
    sh.uniforms.rwyWet = RUNWAY_WX.wet;
    sh.uniforms.rwySky = RUNWAY_WX.sky;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRwyUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRwyUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vRwyUv; uniform vec2 rwySize; uniform float rwyWet; uniform vec3 rwySky;
        float rh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float rn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(rh(i), rh(i + vec2(1, 0)), f.x), mix(rh(i + vec2(0, 1)), rh(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec2 m = vRwyUv * rwySize;                 // metres: x along, y across
          float across = abs(m.y - rwySize.y * 0.5);
          vec2 fw = fwidth(m);
          float near = 1.0 - smoothstep(0.15, 0.6, max(fw.x, fw.y));
          // paving lanes 7.5 m wide, each laid a touch differently
          float lane = rh(vec2(floor(m.y / 7.5), 3.0));
          float k = (lane - 0.5) * 0.07;
          // patch repairs and long-wave tone drift
          k += (rn(m * vec2(0.035, 0.12)) - 0.5) * 0.18;
          float patchN = rn(m * vec2(0.05, 0.09) + 17.0);
          k += smoothstep(0.78, 0.8, patchN) * 0.09;
          // aggregate grain, faded out before it can alias
          k += (rn(m * 2.6) * 0.55 + rn(m * 8.3) * 0.45 - 0.5) * 0.16 * near;
          // joint lines between lanes
          float jd = abs(fract(m.y / 7.5 + 0.5) - 0.5) * 7.5;
          k -= (1.0 - smoothstep(0.0, 0.08 + fw.y, jd)) * 0.12 * near;
          // rubber deposits: wheel tracks either side of the centreline in
          // both touchdown zones, streaky along the runway
          float end = min(m.x, rwySize.x - m.x);
          float tz = smoothstep(60.0, 220.0, end) * (1.0 - smoothstep(420.0, 950.0, end));
          float track = exp(-pow((across - 3.2) / 2.4, 2.0)) + 0.6 * exp(-pow(across / 1.4, 2.0));
          float streak = rn(vec2(m.x * 0.08, m.y * 2.2));
          float rubber = tz * track * (0.35 + 0.65 * streak);
          diffuseColor.rgb *= (1.0 + k) * (1.0 - 0.6 * clamp(rubber, 0.0, 1.0));
          diffuseColor.rgb *= 1.0 - 0.38 * rwyWet;                  // wet asphalt goes dark
          // shoulders a little lighter and dustier
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + vec3(0.02),
            smoothstep(rwySize.y * 0.5 - 2.6, rwySize.y * 0.5 - 2.4, across));
        }`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        if (rwyWet > 0.0) {
          // standing water: a fresnel sheet of sky, strongest in the puddles
          vec2 m = vRwyUv * rwySize;
          float puddle = smoothstep(0.45, 0.7, rn(m * vec2(0.06, 0.16) + 41.0));
          float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 5.0);
          gl_FragColor.rgb += rwySky * rwyWet * (0.06 + fres * (0.35 + 0.65 * puddle));
        }`);
  };
  mat.customProgramCacheKey = () => 'rwy-asphalt';
  return mat;
}

// Collects axis-aligned rectangles (in runway-local x/z) into one geometry.
class Quads {
  constructor() { this.p = []; }
  rect(x0, x1, z0, z1) {
    const p = this.p;
    p.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    const n = new Float32Array(this.p.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    return g;
  }
}

// Runway designator ("09", "27L"...) as a transparent text plane, 9 m tall
// along the runway, read from the approach.
function designator(label) {
  const W = 256, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const digits = label.replace(/[LRC]$/, ''), side = label.slice(digits.length);
  // tall condensed digits like the real stencil
  ctx.save();
  ctx.scale(0.5, 1);
  ctx.font = `bold ${side ? 250 : 330}px "B612", "DejaVu Sans", Arial, sans-serif`;
  ctx.fillText(digits, W, side ? 250 : 400);
  if (side) { ctx.font = 'bold 230px "B612", Arial, sans-serif'; ctx.fillText(side, W, 495); }
  ctx.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 8;
  const mat = new THREE.MeshLambertMaterial({
    color: PAINT, map: tex, transparent: true, alphaTest: 0.35, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16,
  });
  return mat;
}

/**
 * @param {object} o
 * @param {number} o.length   runway length (m)
 * @param {number} o.halfWidth
 * @param {string[]} o.labels [label at x=0 end, label at x=length end]
 * @param {number} [o.tone]   asphalt base colour
 */
export function runwayDressing({ length: L, halfWidth: hw, labels = ['', ''], tone = 0x4b4b4a }) {
  const g = new THREE.Group();
  const W = hw * 2;

  const slabGeo = new THREE.PlaneGeometry(L, W);
  slabGeo.rotateX(-Math.PI / 2);
  slabGeo.translate(L / 2, 0, 0);
  const slab = new THREE.Mesh(slabGeo, asphaltMaterial(L, W, tone));
  slab.receiveShadow = true;
  g.add(slab);

  const q = new Quads();
  const edgeIn = hw - 2.6;        // paint edge stripe inside the shoulder
  // Edge stripes
  q.rect(0, L, edgeIn - 0.9, edgeIn);
  q.rect(0, L, -edgeIn, -edgeIn + 0.9);

  // Per-end markings, built for the x=0 end and mirrored to the far end.
  const aimAt = L < 800 ? 150 : L < 1200 ? 250 : L < 2400 ? 300 : 400;
  const tdzPairs = L < 900 ? 1 : L < 1200 ? 2 : L < 1500 ? 3 : L < 2400 ? 4 : 6;
  const keys = Math.max(2, Math.floor((edgeIn - 1.0) / 3.6));     // stripes each side, inside the edge paint
  const end = (mirror) => {
    const X = (a, b) => mirror ? [L - b, L - a] : [a, b];
    // threshold piano keys: 30 m long, 1.8 m wide, 1.8 m gaps, centre gap
    for (let i = 0; i < keys; i++) {
      const z0 = 1.8 + i * 3.6;
      for (const s of [1, -1]) {
        const [a, b] = X(6, 36);
        q.rect(a, b, s > 0 ? z0 : -z0 - 1.8, s > 0 ? z0 + 1.8 : -z0);
      }
    }
    // threshold bar
    { const [a, b] = X(2, 3.8); q.rect(a, b, -edgeIn, edgeIn); }
    // aiming point: two 45 m blocks
    const aw = W >= 43 ? 9 : 6, ai = W >= 43 ? 9 : 4.5;
    { const [a, b] = X(aimAt, aimAt + 45); q.rect(a, b, ai, ai + aw * 0.6); q.rect(a, b, -ai - aw * 0.6, -ai); }
    // touchdown zone bars every 150 m (3, 3, 2, 2, 1, 1), skipping the aim point
    const pattern = [3, 3, 2, 2, 1, 1];
    let placed = 0;
    for (let i = 1; placed < tdzPairs && i < 12; i++) {
      const x = i * 150;
      if (x > L / 2 - 60) break;
      if (Math.abs(x - aimAt) < 60) continue;
      const n = pattern[placed++];
      for (let k = 0; k < n; k++) {
        const z0 = ai + k * 2.6;
        const [a, b] = X(x, x + 22.5);
        q.rect(a, b, z0, z0 + 1.8);
        q.rect(a, b, -z0 - 1.8, -z0);
      }
    }
  };
  end(false);
  end(true);

  // Centreline: 30 m dashes, 20 m gaps, between the designators
  for (let x = 70; x + 30 < L - 70; x += 50) q.rect(x, x + 30, -0.45, 0.45);

  const marks = new THREE.Mesh(q.geometry(), paintMat());
  marks.position.y = 0.01;
  marks.receiveShadow = true;
  g.add(marks);

  // Designators, read from each approach
  if (typeof document !== 'undefined') {
    labels.forEach((label, i) => {
      if (!label) return;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(6, 12), designator(label));
      m.rotation.x = -Math.PI / 2;                 // lie flat, text up = -z
      m.rotation.z = i === 0 ? -Math.PI / 2 : Math.PI / 2;
      m.position.set(i === 0 ? 48 : L - 48, 0.02, 0);
      m.receiveShadow = true;
      g.add(m);
    });
  }
  return g;
}

// Reciprocal designator for a runway number ("09" -> "27", "02L" -> "20R").
export function reciprocal(label) {
  const m = /^(\d{1,2})([LRC]?)$/.exec(label || '');
  if (!m) return '';
  const n = ((+m[1] + 18 - 1) % 36) + 1;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  return String(n).padStart(2, '0') + side;
}
