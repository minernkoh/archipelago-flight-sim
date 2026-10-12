// Airfield lighting, built generically from map.runway: edge, centreline,
// threshold/end lights, an approach lighting system with sequenced flashers
// ("the rabbit") running to the threshold, and a PAPI whose four units really
// switch red/white with the viewer's angle above the glidepath.
//
// Every light is a point sprite in ONE draw call per kind: a custom shader
// keeps a minimum pixel size, so a runway reads as strings of lights from
// 10 km out the way it does from a real cockpit, and the cores are
// toneMapped:false so the bloom pass (post.js) can halo them.

import * as THREE from 'three';
import { displayMatch } from './display.js';

const VERT = `
  attribute vec3 lcolor; attribute float phase;
  uniform float time, scale, size, minPx, fogFar, dayK;
  varying vec3 vC; varying float vA;
  void main(){
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float px = size * scale / max(-mv.z, 1.0);
    gl_PointSize = max(px, minPx);
    vC = lcolor;
    vA = 1.0 - smoothstep(fogFar * 0.9, fogFar * 2.2, -mv.z);   // lights punch through haze
    if (phase >= 0.0) {                                           // sequenced flasher
      float t = fract(time * 2.0);
      vA *= 1.0 - smoothstep(0.0, 0.035, abs(t - phase));
    }
    vA *= dayK;
  }`;
const FRAG = `
  varying vec3 vC; varying float vA;
  void main(){
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d) * 4.0;
    float a = exp(-r2 * 6.0) + 0.35 * exp(-r2 * 1.5);
    if (a * vA < 0.01) discard;
    gl_FragColor = vec4(vC * a * vA * 2.6, 1.0);   // > bloom threshold (post.js)
  }`;

function lightMaterial(size, minPx) {
  return displayMatch(new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      time: { value: 0 }, scale: { value: 400 }, size: { value: size }, minPx: { value: minPx },
      fogFar: { value: 5000 }, dayK: { value: 1 },
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  }));
}

const COL = {
  white: new THREE.Color(1.0, 0.93, 0.78), green: new THREE.Color(0.25, 1.0, 0.45),
  red: new THREE.Color(1.0, 0.16, 0.1), blue: new THREE.Color(0.3, 0.45, 1.0),
  flash: new THREE.Color(1.0, 1.0, 1.0), amber: new THREE.Color(1.0, 0.7, 0.25),
};

class PointSet {
  constructor() { this.p = []; this.c = []; this.ph = []; }
  add(x, y, z, col, phase = -1) { this.p.push(x, y, z); this.c.push(col.r, col.g, col.b); this.ph.push(phase); }
  build(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('lcolor', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('phase', new THREE.Float32BufferAttribute(this.ph, 1));
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    return pts;
  }
}

/**
 * @param {object} map   FlightMap (runway, height)
 * @returns {{ group, update(camera, elapsed, renderer), setMode(k), papi() }}
 */
export function createRunwayLights(map) {
  const r = map.runway;
  const h = r.headingRad;
  const fwd = { x: Math.cos(h), z: -Math.sin(h) };
  const right = { x: Math.sin(h), z: Math.cos(h) };
  const ground = (x, z) => Math.max(map.height(x, z), r.y - 2, 0.5);
  const W = (u, v, dy = 0.6) => {
    const x = fwd.x * u + right.x * v, z = fwd.z * u + right.z * v;
    return [x, (Math.abs(v) <= r.halfWidth + 1 && u >= r.x0 && u <= r.x1 ? r.y : ground(x, z)) + dy, z];
  };
  const group = new THREE.Group();
  const L = r.x1 - r.x0, hw = r.halfWidth;

  // Runway: edge (white, amber in the last 600 m), centreline (white -> red/white -> red),
  // thresholds (green) and ends (red).
  const rw = new PointSet();
  const nEdge = Math.max(8, Math.round(L / 60));
  for (let i = 0; i <= nEdge; i++) {
    const u = r.x0 + L * i / nEdge;
    const col = (r.x1 - u) < 600 ? COL.amber : COL.white;
    rw.add(...W(u, hw + 0.5), col); rw.add(...W(u, -hw - 0.5), col);
  }
  for (let u = r.x0 + 30; u < r.x1 - 15; u += 30) {
    const left = r.x1 - u;
    const col = left < 300 ? COL.red : left < 900 ? ((Math.round(u / 30) % 2) ? COL.red : COL.white) : COL.white;
    rw.add(...W(u, 0, 0.12), col);
  }
  for (let v = -hw; v <= hw + 0.01; v += hw / 6) {
    rw.add(...W(r.x0 - 1, v, 0.3), COL.green);
    rw.add(...W(r.x1 + 1, v, 0.3), COL.red);
  }
  const rwMat = lightMaterial(1.6, 2.2);
  const rwPts = rw.build(rwMat);
  group.add(rwPts);

  // Approach lights (x0 end): centre bars every 30 m, a crossbar at 300 m,
  // and a flasher on each bar sequencing toward the threshold twice a second.
  const als = new PointSet();
  const alsLen = L >= 1500 ? 720 : 420;
  const nBars = Math.round(alsLen / 30);
  for (let i = 1; i <= nBars; i++) {
    const u = r.x0 - i * 30;
    for (let k = -2; k <= 2; k++) als.add(...W(u, k * 1.1, 1.2), COL.white);
    if (i === 10) for (let k = 3; k <= 12; k++) { als.add(...W(u, k * 1.5, 1.2), COL.white); als.add(...W(u, -k * 1.5, 1.2), COL.white); }
  }
  const flashMat = lightMaterial(3.2, 3.5);
  const fl = new PointSet();
  for (let i = nBars; i >= 1; i--) fl.add(...W(r.x0 - i * 30, 0, 2.2), COL.flash, (nBars - i) / nBars * 0.5);
  const alsPts = als.build(rwMat), flPts = fl.build(flashMat);
  group.add(alsPts, flPts);

  // PAPI: four units left of the runway abeam the aim point used by the
  // flight school (spawn + 300 m). Transition angles 3.5 / 3.17 / 2.83 / 2.5 deg
  // from the runway edge outward: on a 3 deg slope you see two red, two white.
  const spawnU = r.spawn.x * fwd.x + r.spawn.z * fwd.z;
  const papiU = spawnU + 300;
  const papiPos = [0, 1, 2, 3].map(k => W(papiU, -(hw + 15 + k * 9), 1.0));
  const papiAng = [3.5, 3.17, 2.83, 2.5].map(d => d * Math.PI / 180);
  const pp = new PointSet();
  for (const p of papiPos) pp.add(p[0], p[1], p[2], COL.white);
  const papiMat = lightMaterial(2.6, 3.2);
  const papiPts = pp.build(papiMat);
  group.add(papiPts);
  const papiCol = papiPts.geometry.attributes.lcolor;
  let papiWhites = 2;

  const mats = [rwMat, flashMat, papiMat];
  const tmp = new THREE.Vector2();
  return {
    group,
    // k: 0 off, 0..1 day/dusk/night brightness
    setMode(k) {
      rwPts.visible = alsPts.visible = flPts.visible = k > 0.01;
      rwMat.uniforms.dayK.value = flashMat.uniforms.dayK.value = k;
      papiMat.uniforms.dayK.value = Math.max(k, 0.9);    // PAPI is daylight-visible
    },
    setFog(far) { for (const m of mats) m.uniforms.fogFar.value = far; },
    update(camera, elapsed, renderer) {
      renderer.getDrawingBufferSize(tmp);
      const scale = tmp.y / (2 * Math.tan(camera.fov * Math.PI / 360));
      for (const m of mats) { m.uniforms.time.value = elapsed; m.uniforms.scale.value = scale; }
      // PAPI: each unit white above its transition angle, red below.
      const c = camera.position;
      let whites = 0;
      for (let i = 0; i < 4; i++) {
        const p = papiPos[i];
        const d = Math.hypot(c.x - p[0], c.z - p[2]);
        const white = Math.atan2(c.y - p[1], d) > papiAng[i];
        const col = white ? COL.white : COL.red;
        papiCol.setXYZ(i, col.r, col.g, col.b);
        whites += white ? 1 : 0;
      }
      papiCol.needsUpdate = true;
      papiWhites = whites;
    },
    /** Number of white PAPI units seen from the camera (0 = well low, 4 = well high). */
    papiWhites() { return papiWhites; },
    dispose() {
      group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      for (const m of mats) m.dispose();
    },
  };
}
