// Ribbon trails: wingtip vortices that condense under high G / high alpha, and
// an airshow smoke trail toggled with K. Each trail is a ring buffer of world
// points re-meshed every frame into a camera-facing strip; buffers are
// preallocated, so update() allocates nothing (same rule as effects.js).

import * as THREE from 'three';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function createRibbon(scene, { points, life, color, opacity, widthFrom, widthTo, nearFade = 6 }) {
  const N = points;
  const pos = new Float32Array(N * 2 * 3);
  const alpha = new Float32Array(N * 2);
  const across = new Float32Array(N * 2);           // -1 / +1 edge coordinate
  for (let i = 0; i < N; i++) { across[i * 2] = -1; across[i * 2 + 1] = 1; }
  const idx = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('across', new THREE.BufferAttribute(across, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { color: { value: new THREE.Color(color) } }]),
    vertexShader: `attribute float alpha; attribute float across; varying float vA; varying float vX;
      #include <fog_pars_vertex>
      void main(){ vA=alpha; vX=across; vec4 mvPosition=modelViewMatrix*vec4(position,1.0);
        gl_Position=projectionMatrix*mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform vec3 color; varying float vA; varying float vX;
      #include <fog_pars_fragment>
      void main(){
        float edge=1.0-vX*vX;                       // soft tube-like falloff across the width
        float a=vA*edge*edge;
        if(a<0.003) discard;
        gl_FragColor=vec4(color*(0.86+0.14*edge),a);
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  scene.add(mesh);

  // ring buffer of samples: x,y,z, age, strength
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const age = new Float32Array(N).fill(1e9), str = new Float32Array(N);
  let head = 0, count = 0, emitT = 0;
  const _side = new THREE.Vector3(), _tan = new THREE.Vector3(), _view = new THREE.Vector3();

  function push(x, y, z, s) {
    head = (head + 1) % N;
    px[head] = x; py[head] = y; pz[head] = z; age[head] = 0; str[head] = s;
    if (count < N) count++;
  }

  return {
    // Emit at most every `interval` s so the trail length is time-based.
    feed(x, y, z, s, dt, interval) {
      for (let i = 0; i < N; i++) age[i] += dt;
      emitT += dt;
      if (emitT >= interval) {
        emitT = 0;
        // Resuming after a gap: lay a zero-strength break sample here first,
        // or the strip would stretch back to the last (stale) point.
        if (s > 0.01 && str[head] <= 0.01) push(x, y, z, 0);
        if (s > 0.01 || str[head] > 0.01) push(x, y, z, s);
      } else if (count && s > 0.01) {    // keep the newest sample glued to the source
        px[head] = x; py[head] = y; pz[head] = z;
      }
    },
    mesh(cam) {
      for (let k = 0; k < N; k++) {
        const i = (head - k + N) % N;
        const o = k * 2;
        if (k >= count || age[i] > life) {
          alpha[o] = alpha[o + 1] = 0;
          pos[o * 3] = pos[o * 3 + 3] = px[head]; pos[o * 3 + 1] = pos[o * 3 + 4] = py[head]; pos[o * 3 + 2] = pos[o * 3 + 5] = pz[head];
          continue;
        }
        const j = (i - 1 + N) % N, jn = (i + 1) % N;
        const a = k < count - 1 ? j : i, b = k > 0 ? jn : i;
        _tan.set(px[b] - px[a], py[b] - py[a], pz[b] - pz[a]);
        _view.set(cam.x - px[i], cam.y - py[i], cam.z - pz[i]);
        _side.crossVectors(_tan, _view);
        const L = _side.length() || 1;
        const t = age[i] / life;
        const w = widthFrom + (widthTo - widthFrom) * Math.sqrt(t);
        _side.multiplyScalar(w / L);
        pos[o * 3] = px[i] + _side.x; pos[o * 3 + 1] = py[i] + _side.y; pos[o * 3 + 2] = pz[i] + _side.z;
        pos[o * 3 + 3] = px[i] - _side.x; pos[o * 3 + 4] = py[i] - _side.y; pos[o * 3 + 5] = pz[i] - _side.z;
        const fadeIn = smooth(0, 0.04, t);
        // Fade out what is right at the lens: from the chase seat the camera
        // sits inside the smoke, and a strip that close fills the screen.
        const near = smooth(nearFade * 0.25, nearFade, Math.sqrt(_view.lengthSq()));
        const aa = opacity * str[i] * (1 - t) * (1 - t) * near * (k === 0 ? 0 : fadeIn + (1 - fadeIn) * 0.6);
        alpha[o] = alpha[o + 1] = aa;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.alpha.needsUpdate = true;
    },
    clear() { count = 0; age.fill(1e9); str.fill(0); },
    debug() { let vis = 0, maxA = 0; for (let i = 0; i < alpha.length; i++) { if (alpha[i] > 0.003) vis++; maxA = Math.max(maxA, alpha[i]); } return { count, vis, maxA }; },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}

export function createTrails(scene) {
  const tipL = createRibbon(scene, { points: 70, life: 1.6, color: 0xf4f7fb, opacity: 0.7, widthFrom: 0.05, widthTo: 0.5 });
  const tipR = createRibbon(scene, { points: 70, life: 1.6, color: 0xf4f7fb, opacity: 0.7, widthFrom: 0.05, widthTo: 0.5 });
  const smoke = createRibbon(scene, { points: 160, life: 14, color: 0xf1f1ee, opacity: 1.0, widthFrom: 0.8, widthTo: 14, nearFade: 30 });
  let smokeOn = false;
  const q = new THREE.Quaternion(), v = new THREE.Vector3();

  const local = (ac, x, y, z) => {
    q.set(ac.q.x, ac.q.y, ac.q.z, ac.q.w);
    return v.set(x, y, z).applyQuaternion(q).add(ac.pos);
  };

  return {
    get smokeOn() { return smokeOn; },
    toggleSmoke() { smokeOn = !smokeOn; return smokeOn; },
    reset() { smokeOn = false; tipL.clear(); tipR.clear(); smoke.clear(); },
    clear() { tipL.clear(); tipR.clear(); smoke.clear(); },
    debug() { return { smokeOn, smoke: smoke.debug(), tip: tipL.debug() }; },
    update(ac, dt, camPos, active) {
      const p = ac.p;
      const half = (p.span || 10) / 2;
      // Condensation strength: pulling G or flying near the stall at speed.
      let s = 0;
      if (active && !ac.onGround && !ac.crashed && ac.airspeed > 35) {
        const g = smooth(2.0, 4.2, ac.gLoad ?? 1);
        const a = p.alphaStall ? smooth(0.62, 0.95, ac.alpha / p.alphaStall) * smooth(40, 70, ac.airspeed) : 0;
        s = Math.max(g, a * 0.8);
      }
      const yTip = 0.25, xTip = -(p.chord || 1.5) * 0.4;
      let w = local(ac, xTip, yTip, -half);
      tipL.feed(w.x, w.y, w.z, s, dt, 1 / 40);
      w = local(ac, xTip, yTip, half);
      tipR.feed(w.x, w.y, w.z, s, dt, 1 / 40);
      // Smoke from the tail, only while airborne.
      let tailX = -3;
      for (const g of p.gear || []) tailX = Math.min(tailX, g.r.x);
      for (const pr of p.probes || []) tailX = Math.min(tailX, pr.r.x);
      w = local(ac, tailX, 0, 0);
      smoke.feed(w.x, w.y, w.z, smokeOn && active && !ac.onGround && !ac.crashed ? 1 : 0, dt, 1 / 12);
      if (camPos) { tipL.mesh(camPos); tipR.mesh(camPos); smoke.mesh(camPos); }
    },
    dispose() { tipL.dispose(); tipR.dispose(); smoke.dispose(); },
  };
}
