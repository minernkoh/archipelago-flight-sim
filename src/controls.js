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
    if (k === 'r') emit('reset');
    if (k === 'Escape') emit('pause');
    if (k === '?' || k === '/') emit('help');
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
    poll(dt) {
      const s = state;
      s.elevator = axis(s.elevator, (keys.has('ArrowUp') ? 1 : 0) + (keys.has('ArrowDown') ? -1 : 0), dt, pitchRollRate);
      s.aileron  = axis(s.aileron, (keys.has('ArrowRight') ? 1 : 0) + (keys.has('ArrowLeft') ? -1 : 0), dt, pitchRollRate);
      s.rudder   = axis(s.rudder, (keys.has('d') ? 1 : 0) + (keys.has('a') ? -1 : 0), dt, rudderRate);
      if (keys.has('w')) s.throttle = Math.min(1, s.throttle + dt * 0.55);
      if (keys.has('s')) s.throttle = Math.max(0, s.throttle - dt * 0.7);
      s.flaps = axis(s.flaps, FLAP_DETENTS[flapIdx], dt, 1.6); // flaps travel slowly
      s.brakes = keys.has('b');
      return s;
    },
  };
}
