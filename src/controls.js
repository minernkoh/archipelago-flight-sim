// Keyboard input with analog-feel smoothing on the flight controls.

const FLAP_DETENTS = [0, 0.33, 0.66, 1];

export function createControls() {
  const keys = new Set();
  const handlers = {};
  const state = {
    elevator: 0, aileron: 0, rudder: 0,
    throttle: 0, flaps: 0, brakes: false, trim: 0,
  };
  let flapIdx = 0;
  // Keyboard-smoothing rates, swapped per aircraft. Rudder stays at the 4.5/5.5
  // ratio of the primary (pitch/roll) rate. Defaults match the original C172.
  let pitchRollRate = 5.5;
  let rudderRate = 4.5;
  // Settings-driven input options (see settings.js). Invert applies to
  // mouse-fly and gamepad pitch only — the arrow keys stay semantic.
  let invertPitch = false, mouseFlyOn = true, gamepadOn = true;

  // Mouse-fly: hold RMB = stick. Offset from the press point maps to a target
  // deflection written DIRECTLY into state each poll — the mouse position IS
  // the deflection, so the axis() keyboard ramp is bypassed (ramping a
  // position input just adds lag). The autopilot yields via axisActive below.
  let mouseHeld = false, mouseAnchor = null, mousePitch = 0, mouseRoll = 0;
  const MOUSE_FULL_PX = 220; // px of travel for full deflection
  const clamp1 = (v) => Math.max(-1, Math.min(1, v));
  window.addEventListener('mousedown', (e) => {
    if (e.button === 2 && mouseFlyOn) { mouseHeld = true; mouseAnchor = { x: e.clientX, y: e.clientY }; }
  });
  window.addEventListener('mousemove', (e) => {
    if (!mouseHeld) return;
    mouseRoll = clamp1((e.clientX - mouseAnchor.x) / MOUSE_FULL_PX);
    mousePitch = clamp1((mouseAnchor.y - e.clientY) / MOUSE_FULL_PX); // mouse up = nose up (invert flips)
  });
  const mouseRelease = () => { mouseHeld = false; mousePitch = 0; mouseRoll = 0; };
  window.addEventListener('mouseup', (e) => { if (e.button === 2) mouseRelease(); });
  window.addEventListener('blur', mouseRelease);
  window.addEventListener('contextmenu', (e) => { if (mouseFlyOn) e.preventDefault(); });

  // Gamepad: first connected pad, standard mapping — left stick pitch/roll,
  // right stick X rudder, right stick Y throttle rate. Deadzoned; an
  // out-of-zone stick writes directly (it's already analog — no ramp needed).
  const DEADZONE = 0.18;
  const dz = (v) => Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);
  function padAxes() {
    if (!gamepadOn || !navigator.getGamepads) return null;
    let gp = null;
    try { gp = [...navigator.getGamepads()].find(p => p && p.connected); } catch { return null; }
    if (!gp) return null;
    const a = gp.axes;
    return { roll: dz(a[0] ?? 0), pitch: dz(a[1] ?? 0), yaw: dz(a[2] ?? 0), thr: dz(a[3] ?? 0) };
  }

  const emit = (ev) => handlers[ev] && handlers[ev]();

  window.addEventListener('keydown', (e) => {
    // trim repeats while held (like winding a trim wheel)
    if (e.key === '[') { state.trim = Math.max(-0.3, state.trim - 0.012); return; }
    if (e.key === ']') { state.trim = Math.min(0.3, state.trim + 0.012); return; }
    if (e.repeat) { if (e.key.startsWith('Arrow')) e.preventDefault(); return; }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    keys.add(k);
    if (k.startsWith('Arrow') || k === ' ') e.preventDefault();
    if (k === 'f') {
      flapIdx = e.shiftKey ? Math.max(0, flapIdx - 1) : Math.min(FLAP_DETENTS.length - 1, flapIdx + 1);
    }
    if (k === 'c') emit('camera');
    if (k === 'v') emit('flyby');      // cinematic fly-past camera
    if (k === 'k') emit('smoke');      // airshow smoke trail
    if (k === 'm') emit('minimap');
    if (k === 'i') emit('panel');
    if (k === 'r') emit('reset');
    if (k === 'Escape') emit('pause');
    if (k === '?' || k === '/') emit('help');
    // Autopilot toggles (see autopilot.js). Free keys — none clash with the
    // flight/camera/panel bindings above.
    if (k === 'p') emit('ap');          // master on/off (HDG+ALT)
    if (k === 'h') emit('ap-hdg');      // heading hold
    if (k === 'g') emit('ap-alt');      // altitude hold
    if (k === 'j') emit('ap-ias');      // airspeed hold (throttle)
    if (k === 'n') emit('ap-nav');      // NAV / waypoint steering
    if (k === 'l') emit('ap-wing');     // wing leveler
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  });
  window.addEventListener('blur', () => keys.clear());

  function axis(cur, target, dt, rate = 5.5) {
    return cur + (target - cur) * Math.min(1, dt * rate);
  }

  return {
    state,
    on(ev, cb) { handlers[ev] = cb; },
    // Swap keyboard-smoothing rates when the aircraft changes. p.inputRate is the
    // primary (pitch/roll) rate; rudder keeps the original 4.5/5.5 ratio.
    setRates(p) {
      pitchRollRate = p?.inputRate ?? 5.5;
      rudderRate = pitchRollRate * (4.5 / 5.5);
    },
    resetFlaps() { flapIdx = 0; state.flaps = 0; state.throttle = 0; state.trim = 0; },
    // Apply the persisted settings (settings.js). Called at boot + on change.
    applySettings(s) {
      invertPitch = !!s.invertPitch;
      mouseFlyOn = s.mouseFly !== false;
      gamepadOn = s.gamepad !== false;
      if (!mouseFlyOn) mouseRelease();
    },
    // True when the human is actively driving this axis (key held, RMB
    // mouse-fly, or a gamepad stick out of its deadzone) — the autopilot
    // reads this to yield that axis to live input.
    axisActive(name) {
      const pad = padAxes();
      if (name === 'elevator') return keys.has('ArrowUp') || keys.has('ArrowDown') || mouseHeld || !!(pad && pad.pitch);
      if (name === 'aileron') return keys.has('ArrowLeft') || keys.has('ArrowRight') || mouseHeld || !!(pad && pad.roll);
      if (name === 'rudder') return keys.has('a') || keys.has('d') || !!(pad && pad.yaw);
      if (name === 'throttle') return keys.has('w') || keys.has('s') || !!(pad && pad.thr);
      return false;
    },
    poll(dt) {
      const s = state;
      s.elevator = axis(s.elevator, (keys.has('ArrowUp') ? 1 : 0) + (keys.has('ArrowDown') ? -1 : 0), dt, pitchRollRate);
      s.aileron  = axis(s.aileron, (keys.has('ArrowRight') ? 1 : 0) + (keys.has('ArrowLeft') ? -1 : 0), dt, pitchRollRate);
      s.rudder   = axis(s.rudder, (keys.has('d') ? 1 : 0) + (keys.has('a') ? -1 : 0), dt, rudderRate);
      if (keys.has('w')) s.throttle = Math.min(1, s.throttle + dt * 0.55);
      if (keys.has('s')) s.throttle = Math.max(0, s.throttle - dt * 0.7);
      // Mouse-fly and gamepad write their axes directly (position inputs —
      // see the notes above). Keyboard keeps the ramped path untouched.
      const inv = invertPitch ? -1 : 1;
      if (mouseHeld) {
        s.elevator = mousePitch * inv;
        s.aileron = mouseRoll;
      }
      const pad = padAxes();
      if (pad) {
        if (pad.pitch) s.elevator = -pad.pitch * inv; // stick fwd (+) = nose down
        if (pad.roll) s.aileron = pad.roll;
        if (pad.yaw) s.rudder = pad.yaw;
        if (pad.thr) s.throttle = Math.max(0, Math.min(1, s.throttle - pad.thr * dt * 0.8)); // stick up (-) increases
      }
      s.flaps = axis(s.flaps, FLAP_DETENTS[flapIdx], dt, 1.6); // flaps travel slowly
      s.brakes = keys.has('b');
      return s;
    },
  };
}
