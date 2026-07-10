// Ring gates. A course is a list of [x, z, desiredY] centres; each gate is a
// hoop floored above terrain. Pass detection = plane-crossing + radius test.
//
// createRings(scene, opts) is world-agnostic. Default opts reproduce the
// archipelago race exactly. A second instance can be spawned with a different
// course/radius/theme (e.g. amber training gates: { theme: 'training',
// radius: 35, course: [...] }).

import * as THREE from 'three';
import { archipelagoMap } from './maps/archipelago.js';

// Colour themes. Each entry gives base + emissive for the three ring states.
const THEMES = {
  race: {
    active: 0xff5fd2, activeEmissive: 0x8f2a78,
    passed: 0x3f7a4f, passedEmissive: 0x1c3a24,
    dim:    0x5a6470, dimEmissive:    0x222831,
  },
  training: {
    active: 0xffb43a, activeEmissive: 0x7a4d0a,
    passed: 0x3f7a4f, passedEmissive: 0x1c3a24,
    dim:    0x5a6470, dimEmissive:    0x222831,
  },
  // Low-level gauntlet: cyan gates, reads as "hug the deck".
  gauntlet: {
    active: 0x35e0d8, activeEmissive: 0x0d5a55,
    passed: 0x3f7a4f, passedEmissive: 0x1c3a24,
    dim:    0x4a5a60, dimEmissive:    0x1c2428,
  },
};

export function createRings(scene, opts = {}) {
  const course = opts.course || archipelagoMap.raceCourse;
  const RING_R = opts.radius ?? 50;
  const heightFn = opts.heightFn || archipelagoMap.height;
  const pulseAmp = opts.pulseAmp ?? 0.03;
  const clearance = opts.clearance ?? 55; // min gate-centre height above terrain

  const theme = THEMES[opts.theme] || THEMES.race;
  // Per-colour overrides win over the theme; emissives follow the theme.
  const activeColor = opts.activeColor ?? theme.active;
  const passedColor = opts.passedColor ?? theme.passed;
  const dimColor = opts.dimColor ?? theme.dim;
  const activeEmissive = opts.activeEmissive ?? theme.activeEmissive;
  const passedEmissive = opts.passedEmissive ?? theme.passedEmissive;
  const dimEmissive = opts.dimEmissive ?? theme.dimEmissive;

  const group = new THREE.Group();
  scene.add(group);

  const rings = course.map(([x, z, y], i) => {
    const gy = heightFn(x, z);
    const cy = Math.max(y, gy + clearance);
    const next = course[i + 1];
    const fd = opts.finalDir || { x: 1, z: 0 };
    const dir = next
      ? new THREE.Vector3(next[0] - x, 0, next[1] - z).normalize()
      : new THREE.Vector3(fd.x, 0, fd.z).normalize(); // last gate faces down the runway
    const mesh = new THREE.Mesh(
      new THREE.TorusGeometry(RING_R, 2.4, 8, 36),
      new THREE.MeshLambertMaterial({ color: dimColor, emissive: dimEmissive }),
    );
    mesh.position.set(x, cy, z);
    mesh.lookAt(x + dir.x, cy, z + dir.z);
    group.add(mesh);
    return { center: new THREE.Vector3(x, cy, z), normal: dir, mesh, passed: false };
  });

  let active = 0, prevSide = null, pulse = 0;
  const rel = new THREE.Vector3();

  function styleRings() {
    rings.forEach((r, i) => {
      const m = r.mesh.material;
      if (r.passed) { m.color.set(passedColor); m.emissive.set(passedEmissive); }
      else if (i === active) { m.color.set(activeColor); m.emissive.set(activeEmissive); }
      else { m.color.set(dimColor); m.emissive.set(dimEmissive); }
      r.mesh.scale.setScalar(1);
    });
  }

  return {
    group,
    total: rings.length,
    get active() { return active; },
    get done() { return active >= rings.length; },
    reset() {
      active = 0; prevSide = null;
      rings.forEach(r => { r.passed = false; });
      styleRings();
    },
    show(on) { group.visible = on; },
    // Returns 'pass' | 'miss' | null for this frame.
    check(ac) {
      if (this.done) return null;
      const r = rings[active];
      rel.set(ac.pos.x - r.center.x, ac.pos.y - r.center.y, ac.pos.z - r.center.z);
      const side = rel.dot(r.normal);
      let result = null;
      if (prevSide !== null && prevSide < 0 && side >= 0 && Math.abs(side) < 80) {
        // crossed the gate plane going forward — inside the hoop?
        const radial = rel.clone().addScaledVector(r.normal, -side).length();
        if (radial < RING_R) {
          r.passed = true;
          active++;
          prevSide = null;
          styleRings();
          return 'pass';
        }
        result = 'miss';
      }
      prevSide = side;
      return result;
    },
    // A spawn point `dist` metres short of gate `i` (default: the last gate
    // already passed), on its approach centreline, plus the gate normal — for
    // restarting a race from the last passed gate rather than the runway.
    approach(i = active - 1, dist = 140) {
      if (i < 0 || i >= rings.length) return null;
      const r = rings[i];
      return {
        pos: { x: r.center.x - r.normal.x * dist, y: r.center.y, z: r.center.z - r.normal.z * dist },
        dir: { x: r.normal.x, y: 0, z: r.normal.z },
      };
    },
    // bearing (compass deg) and distance from aircraft to the active ring, for HUD
    guidance(ac) {
      if (this.done) return null;
      const r = rings[active];
      const dx = r.center.x - ac.pos.x, dz = r.center.z - ac.pos.z;
      const bearing = (90 - Math.atan2(-dz, dx) * 180 / Math.PI + 360) % 360;
      return { bearing, dist: Math.hypot(dx, dz), index: active };
    },
    update(dt) {
      pulse += dt * 3.2;
      if (!this.done) {
        const s = 1 + Math.sin(pulse) * pulseAmp;
        rings[active].mesh.scale.setScalar(s);
      }
    },
    styleRings,
    // Remove from scene and release GPU resources (used when swapping maps).
    dispose() {
      scene.remove(group);
      rings.forEach(r => { r.mesh.geometry.dispose(); r.mesh.material.dispose(); });
    },
  };
}
