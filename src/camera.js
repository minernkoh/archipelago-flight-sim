// Chase / cockpit / orbit cameras, plus a cinematic FLYBY and the menu's slow
// showcase orbit. Physics body frame (+x fwd) matches world handedness, so mesh
// quaternions come straight from the flight model; the camera aligns its -z
// view axis to body +x in cockpit mode.
//
// `C` cycles CHASE -> COCKPIT -> ORBIT (unchanged, tests rely on it); `V`
// toggles FLYBY. Mouse wheel zooms the external views; left-drag looks around
// (chase and cockpit) and springs back on release.

import * as THREE from 'three';

export const CAM_MODES = ['CHASE', 'COCKPIT', 'ORBIT', 'FLYBY'];
const CYCLE = 3;   // C cycles the first three; FLYBY is its own toggle

const ALIGN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);   // frame-rate independent lerp factor

// Cockpit frame, in camera space (-z forward, ~1 m out). Just enough structure
// (glareshield, pillars, canopy bow) to put you IN the aircraft rather than
// floating over the scenery; the HTML six-pack sits on the glareshield.
function buildFrame(style) {
  const g = new THREE.Group();
  if (!style || style === 'none') return g;
  const mat = new THREE.MeshLambertMaterial({ color: 0x1a1f24, flatShading: true });
  const lip = new THREE.MeshLambertMaterial({ color: 0x2a3138, flatShading: true });
  const box = (w, h, d, x, y, z, rz = 0, m = mat) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z); b.rotation.z = rz; g.add(b); return b;
  };
  const top = style === 'canopy' ? -0.3 : -0.22;          // glareshield top edge (y at z = -1)
  box(3.4, 0.9, 0.5, 0, top - 0.45, -1.05);              // dash
  const curve = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.4, 8), lip);
  curve.rotation.z = Math.PI / 2; curve.position.set(0, top, -0.85); g.add(curve);  // padded lip
  if (style === 'cabin' || style === 'airliner') {
    const inset = style === 'airliner' ? 0.92 : 1.06;
    box(0.06, 1.25, 0.06, -inset, top + 0.55, -0.98, -0.32);   // A-pillars, raked
    box(0.06, 1.25, 0.06, inset, top + 0.55, -0.98, 0.32);
    box(3.2, 0.2, 0.08, 0, 0.8, -0.98);                       // header
    if (style === 'airliner') box(0.06, 1.1, 0.06, 0, top + 0.5, -1.0);   // centre post
  } else {
    const bow = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.025, 4, 24, Math.PI), mat);
    bow.position.set(0, top + 0.05, -1.05); g.add(bow);       // canopy bow
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.renderOrder = 10; } });
  return g;
}

export function createCameraRig(camera) {
  let mode = 0;
  const look = new THREE.Vector3();
  const lookS = new THREE.Vector3();      // smoothed look point (chase)
  const tmpQ = new THREE.Quaternion();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const target = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const flybyPos = new THREE.Vector3();
  let orbitT = 0, menuT = 0, shakeT = 0;
  let initialized = false, flybyArmed = false;
  let groundFn = null;
  let zoom = 1, zoomS = 1;
  let gBob = 0;                           // smoothed head drop under G (cockpit)
  // Free-look (left drag): offsets in radians, spring back when released.
  let lookYaw = 0, lookPitch = 0, dragging = false, dragX = 0, dragY = 0;
  // Per-aircraft offsets (a 200 t airliner needs a much longer leash)
  let cfg = { chaseDist: 14, chaseHeight: 4.2, orbitR: 26, cockpit: { fwd: 0.55, up: 0.42 } };
  let inputOn = false;                    // only while flying: menus own the mouse otherwise
  let frame = buildFrame('cabin');
  frame.visible = false;
  camera.add(frame);                      // main.js adds the camera to the scene

  if (typeof window !== 'undefined') {
    window.addEventListener('wheel', (e) => {
      if (!inputOn) return;
      zoom = Math.max(0.55, Math.min(2.8, zoom * Math.exp(e.deltaY * 0.0012)));
    }, { passive: true });
    window.addEventListener('mousedown', (e) => {
      if (!inputOn || e.button !== 0 || e.target?.closest?.('button, a, input, .screen, #panel')) return;
      dragging = true; dragX = e.clientX; dragY = e.clientY;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      lookYaw = Math.max(-2.6, Math.min(2.6, lookYaw - (e.clientX - dragX) * 0.006));
      lookPitch = Math.max(-0.9, Math.min(0.9, lookPitch + (e.clientY - dragY) * 0.004));
      dragX = e.clientX; dragY = e.clientY;
    });
    const stop = () => { dragging = false; };
    window.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
  }

  function clampAboveGround(pos, clearance) {
    if (!groundFn) return;
    const g = Math.max(groundFn(pos.x, pos.z), 0);
    if (pos.y < g + clearance) pos.y = g + clearance;
  }

  // Smooth pseudo-random shake (sum of incommensurate sines), not per-frame
  // white noise — that read as jitter rather than buffet.
  function shake(mag, dt) {
    shakeT += dt;
    const t = shakeT * 23;
    camera.position.x += (Math.sin(t * 1.13) + Math.sin(t * 2.71 + 1.3)) * 0.5 * mag;
    camera.position.y += (Math.sin(t * 1.57 + 0.4) + Math.sin(t * 3.11 + 2.1)) * 0.5 * mag;
    camera.position.z += (Math.sin(t * 1.91 + 2.2) + Math.sin(t * 2.33 + 0.7)) * 0.5 * mag;
  }

  // FLYBY: park the camera ahead of the aircraft, a little off its track, and
  // let it fly past; re-park once it is well behind.
  function placeFlyby(ac) {
    const sp = Math.hypot(ac.vel.x, ac.vel.y, ac.vel.z);
    const dir = sp > 3 ? v3.set(ac.vel.x / sp, ac.vel.y / sp * 0.5, ac.vel.z / sp) : v3.copy(fwd);
    const lead = Math.max(90, Math.min(420, sp * 4.5)) * (cfg.chaseDist / 14);
    const side = (Math.random() < 0.5 ? -1 : 1) * (14 + Math.random() * 18) * (cfg.chaseDist / 14);
    flybyPos.set(
      ac.pos.x + dir.x * lead - dir.z * side,
      ac.pos.y + dir.y * lead + (Math.random() * 10 - 3),
      ac.pos.z + dir.z * lead + dir.x * side);
    clampAboveGround(flybyPos, 2.5);
    flybyArmed = true;
  }

  return {
    get modeName() { return CAM_MODES[mode]; },
    cycle() { mode = mode >= CYCLE ? 0 : (mode + 1) % CYCLE; initialized = false; },
    toggleFlyby() { mode = mode === 3 ? 0 : 3; flybyArmed = false; initialized = false; },
    reset() { initialized = false; flybyArmed = false; lookYaw = lookPitch = 0; },
    configure(c) {
      cfg = { ...cfg, ...c };
      initialized = false;
      camera.remove(frame);
      frame.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
      frame = buildFrame(cfg.cockpit?.frame);
      frame.visible = false;
      camera.add(frame);
    },
    setGround(fn) { groundFn = fn; },
    setInput(on) { inputOn = !!on; if (!on) dragging = false; },
    get zoom() { return zoom; },

    // Menu showcase: a slow, low orbit around the parked aircraft with a gentle
    // height swell, so the selection screen sits over a living scene.
    updateMenu(ac, dt) {
      menuT += dt;
      frame.visible = false;
      const r = cfg.orbitR * 1.55;
      const a = menuT * 0.07 + 2.2;
      target.set(
        ac.pos.x + Math.cos(a) * r,
        ac.pos.y + r * (0.12 + 0.08 * Math.sin(menuT * 0.11)),
        ac.pos.z + Math.sin(a) * r);
      clampAboveGround(target, 1.2);
      camera.position.lerp(target, initialized ? damp(2, dt) : 1);
      // Offset the look point so the aircraft sits a touch right of centre
      // and low in frame: the gap between the menu column and the brief cards.
      tmpQ.setFromUnitVectors(v3.set(0, 0, -1), v3.set(ac.pos.x - camera.position.x, 0, ac.pos.z - camera.position.z).normalize());
      right.set(1, 0, 0).applyQuaternion(tmpQ);
      look.set(ac.pos.x, ac.pos.y + r * 0.13, ac.pos.z).addScaledVector(right, -r * 0.07);
      camera.up.set(0, 1, 0);
      camera.lookAt(look);
      camera.fov = 50;
      camera.updateProjectionMatrix();
      initialized = true;
    },

    update(ac, dt) {
      const p = ac.pos;
      tmpQ.set(ac.q.x, ac.q.y, ac.q.z, ac.q.w);
      fwd.set(1, 0, 0).applyQuaternion(tmpQ);
      up.set(0, 1, 0).applyQuaternion(tmpQ);
      zoomS += (zoom - zoomS) * damp(8, dt);
      if (!dragging) {                               // free-look springs home
        const k = damp(3.5, dt);
        lookYaw -= lookYaw * k; lookPitch -= lookPitch * k;
      }

      // Speed sensation: FOV stretches toward Vne; shake from buffet/AB/ground roll
      const speedFrac = Math.min(1, ac.airspeed / (ac.p.maxSpeed || 88));
      const fovBoost = 12 * speedFrac * speedFrac;
      const nearStall = ac.airspeed > 15 && !ac.onGround && ac.alpha > 0.8 * ac.p.alphaStall;
      const shakeMag =
        (ac.stalled ? 0.30 : nearStall ? 0.12 : 0) +
        (ac.abOn ? 0.10 : 0) +
        (ac.onGround && ac.groundSpeed > 8 ? 0.06 * Math.min(1, ac.groundSpeed / 50) : 0);
      const name = CAM_MODES[mode];
      frame.visible = name === 'COCKPIT';

      if (name === 'COCKPIT') {
        // Head sinks under positive G and floats under negative — a few cm,
        // just enough to feel a pull-up.
        gBob += (Math.max(-1.5, Math.min(4, (ac.gLoad ?? 1) - 1)) - gBob) * damp(6, dt);
        camera.position.set(p.x, p.y, p.z)
          .addScaledVector(fwd, cfg.cockpit.fwd)
          .addScaledVector(up, cfg.cockpit.up - gBob * 0.035);
        camera.quaternion.copy(tmpQ).multiply(ALIGN);
        if (lookYaw || lookPitch) {
          camera.rotateY(lookYaw);
          camera.rotateX(-lookPitch);
        }
        camera.fov = 72 + fovBoost * 0.7;
      } else if (name === 'ORBIT') {
        orbitT += dt * 0.12;
        const r = cfg.orbitR * zoomS;
        target.set(p.x + Math.cos(orbitT) * r, p.y + r * 0.27, p.z + Math.sin(orbitT) * r);
        clampAboveGround(target, 1.5);
        camera.position.lerp(target, initialized ? damp(3, dt) : 1);
        camera.up.set(0, 1, 0);
        camera.lookAt(p.x, p.y, p.z);
        camera.fov = 55;
      } else if (name === 'FLYBY') {
        if (!flybyArmed || !initialized) placeFlyby(ac);
        const dx = p.x - flybyPos.x, dy = p.y - flybyPos.y, dz = p.z - flybyPos.z;
        const dist = Math.hypot(dx, dy, dz);
        const sp = Math.hypot(ac.vel.x, ac.vel.z) || 1;
        const along = (dx * ac.vel.x + dz * ac.vel.z) / sp;  // > 0: the aircraft has passed
        if (along > 0 && dist > Math.max(120, sp * 3.2) * (cfg.chaseDist / 14)) placeFlyby(ac);
        camera.position.copy(flybyPos);
        camera.up.set(0, 1, 0);
        camera.lookAt(p.x, p.y, p.z);
        // Zoom to keep the airframe a steady size on screen, like a long lens.
        const span = 14 * (cfg.chaseDist / 14);
        camera.fov = THREE.MathUtils.clamp(2 * Math.atan2(span, Math.max(1, dist)) * 180 / Math.PI, 8, 60);
      } else { // CHASE — follow behind the yaw direction, spring-damped
        const yaw = Math.atan2(-fwd.z, fwd.x) + lookYaw;
        const dist = cfg.chaseDist * zoomS;
        const pitchOff = lookPitch * 0.9;
        const horiz = Math.cos(pitchOff);
        target.set(
          p.x - Math.cos(yaw) * dist * horiz,
          p.y + cfg.chaseHeight * zoomS - fwd.y * dist * 0.36 + Math.sin(pitchOff) * dist,
          p.z + Math.sin(yaw) * dist * horiz);
        clampAboveGround(target, 1.2);
        if (!initialized) { camera.position.copy(target); }
        else camera.position.lerp(target, damp(5.2, dt));
        // Look a little ahead along the flight path (velocity), not just the
        // nose, so turns and climbs open up the view where you are going.
        const sp = Math.hypot(ac.vel.x, ac.vel.y, ac.vel.z);
        look.set(p.x, p.y, p.z).addScaledVector(fwd, 8 * zoomS);
        if (sp > 5 && !lookYaw) look.addScaledVector(v3.set(ac.vel.x, ac.vel.y, ac.vel.z), 6 / sp);
        if (!initialized) lookS.copy(look); else lookS.lerp(look, damp(9, dt));
        camera.up.set(0, 1, 0).lerp(up, 0.18).normalize(); // lean into the bank a touch
        camera.lookAt(lookS);
        camera.fov = 62 + fovBoost;
      }
      if (shakeMag > 0) shake(shakeMag, dt);
      camera.updateProjectionMatrix();
      initialized = true;
    },
  };
}
