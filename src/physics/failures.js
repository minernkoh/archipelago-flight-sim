// Failure scheduler (v12). The consequences live in flightModel.js
// (failSystem + step); this decides WHAT fails and WHEN. THREE-free and
// deterministic for a given seed, so the tests can drive it.
//
// Modes: 'off', or 'random': one failure at a random moment 2-12 minutes into
// the flight, picked from the systems this airframe actually has. Nothing
// fails on the ground, and the clock only runs while airborne, so a failure
// never hits on the takeoff roll.

import { failSystem } from './flightModel.js';

/**
 * kind: 'warning' (red, annunciated), 'caution' (amber, annunciated) or
 * 'silent' (no light: the pilot has to catch it on the instruments, as in
 * real life: a blocked pitot or static port gives no warning).
 */
export const FAILURES = {
  engine:     { label: 'ENGINE FAILURE', ann: 'ENG',   kind: 'warning' },
  power:      { label: 'ENGINE RUNNING ROUGH', ann: 'ENG', kind: 'caution' },
  electrical: { label: 'ALTERNATOR FAILURE', ann: 'VOLTS', kind: 'caution' },
  vacuum:     { label: 'VACUUM PUMP FAILURE', ann: 'VAC', kind: 'caution', steamOnly: true },
  hydraulics: { label: 'HYDRAULIC FAILURE', ann: 'HYD', kind: 'caution', jetOnly: true },
  flaps:      { label: 'FLAP DRIVE FAILURE', ann: null, kind: 'silent' },
  pitot:      { label: 'PITOT BLOCKED', ann: null, kind: 'silent' },
  static:     { label: 'STATIC PORT BLOCKED', ann: null, kind: 'silent' },
};

/** Failures that make sense for this aircraft. */
export function failurePool(p) {
  const jet = p.engine?.type === 'jet';
  return Object.keys(FAILURES).filter(id => {
    const f = FAILURES[id];
    if (f.steamOnly && jet) return false;
    if (f.jetOnly && !jet) return false;
    if (id === 'flaps' && !(p.flapCL > 0)) return false;
    return true;
  });
}

function rng(seed) {
  // hash the seed first: raw xorshift on a small seed starts with tiny outputs
  let s = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b); s ^= s >>> 13; s = Math.imul(s, 0xc2b2ae35); s ^= s >>> 16;
  s = (s >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

export function createFailures({ seed = Date.now() } = {}) {
  let mode = 'off';
  let r = rng(seed);
  let armedAt = Infinity, airborne = 0, fired = [];

  function arm() {
    airborne = 0;
    fired = [];
    armedAt = mode === 'random' ? 120 + r() * 600 : Infinity;
  }

  return {
    get mode() { return mode; },
    setMode(m) { mode = m === 'random' ? 'random' : 'off'; arm(); },
    reseed(s) { r = rng(s); arm(); },
    /** Call on every (re)spawn: clears the schedule and the history. */
    reset() { arm(); },
    /** Fail one system now. Returns its FAILURES entry. */
    trigger(ac, id) {
      if (!FAILURES[id] || ac.systems[id] === false) return null;
      failSystem(ac, id);
      fired.push(id);
      return { id, ...FAILURES[id] };
    },
    get fired() { return fired.slice(); },
    get dueIn() { return armedAt - airborne; },
    /** Advance the clock (sim seconds). Returns a fired failure or null. */
    update(ac, dt) {
      if (mode === 'off' || ac.crashed) return null;
      if (!ac.onGround) airborne += dt;
      if (airborne < armedAt) return null;
      armedAt = Infinity;                                 // one per flight
      const pool = failurePool(ac.p).filter(id => ac.systems[id] !== false);
      if (!pool.length) return null;
      return this.trigger(ac, pool[Math.floor(r() * pool.length)]);
    },
  };
}

/** Annunciator lights currently lit, e.g. ['VOLTS', 'VAC']. */
export function annunciators(ac) {
  const out = [];
  for (const id of Object.keys(FAILURES)) {
    const f = FAILURES[id];
    if (f.ann && ac.systems?.[id] === false && !out.includes(f.ann)) out.push(f.ann);
  }
  if (ac.systems?.electrical === false && ac.avionics === false && !out.includes('VOLTS')) out.push('VOLTS');
  return out;
}
