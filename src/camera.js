// Chase / cockpit / orbit cameras. Physics body frame (+x fwd) matches world
// handedness, so mesh quaternions come straight from the flight model; the
// camera aligns its -z view axis to body +x in cockpit mode.

import * as THREE from 'three';

export const CAM_MODES = ['CHASE', 'COCKPIT', 'ORBIT'];

const ALIGN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);

export function createCameraRig(camera) {
  let mode = 0;
  const look = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  let orbitT = 0;
  let initialized = false;
  // Per-aircraft offsets (a 200 t airliner needs a much longer leash)
  let cfg = { chaseDist: 14, chaseHeight: 4.2, orbitR: 26, cockpit: { fwd: 0.55, up: 0.42 } };

  return {
    get modeName() { return CAM_MODES[mode]; },
    cycle() { mode = (mode + 1) % CAM_MODES.length; initialized = false; },
    reset() { initialized = false; },
    configure(c) { cfg = { ...cfg, ...c }; initialized = false; },
    update(ac, dt) {
      const p = ac.pos;
      tmpQ.set(ac.q.x, ac.q.y, ac.q.z, ac.q.w);
      fwd.set(1, 0, 0).applyQuaternion(tmpQ);
      up.set(0, 1, 0).applyQuaternion(tmpQ);

      if (CAM_MODES[mode] === 'COCKPIT') {
        camera.position.set(p.x, p.y, p.z)
          .add(fwd.clone().multiplyScalar(cfg.cockpit.fwd))
          .add(up.clone().multiplyScalar(cfg.cockpit.up));
        camera.quaternion.copy(tmpQ).multiply(ALIGN);
        camera.fov = 72;
      } else if (CAM_MODES[mode] === 'ORBIT') {
        orbitT += dt * 0.12;
        const r = cfg.orbitR;
        const target = new THREE.Vector3(
          p.x + Math.cos(orbitT) * r,
          p.y + r * 0.27,
          p.z + Math.sin(orbitT) * r,
        );
        camera.position.lerp(target, initialized ? Math.min(1, dt * 3) : 1);
        camera.lookAt(p.x, p.y, p.z);
        camera.fov = 55;
      } else { // CHASE — follow behind the yaw direction, damped
        const yaw = Math.atan2(-fwd.z, fwd.x);
        const back = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(cfg.chaseDist);
        const target = new THREE.Vector3(p.x, p.y, p.z).add(back);
        target.y = p.y + cfg.chaseHeight - fwd.y * cfg.chaseDist * 0.36;
        if (!initialized) { camera.position.copy(target); }
        else {
          const k = Math.min(1, dt * 4.5);
          camera.position.lerp(target, k);
        }
        look.set(p.x, p.y, p.z).add(fwd.clone().multiplyScalar(8));
        camera.up.set(0, 1, 0).lerp(up, 0.18).normalize(); // lean into the bank a touch
        camera.lookAt(look);
        camera.fov = 62;
      }
      camera.updateProjectionMatrix();
      initialized = true;
    },
  };
}
