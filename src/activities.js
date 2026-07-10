// src/activities.js — Phase C activity logic (THREE-free, node-testable).
//
// Three self-contained pieces, all pure logic / plain numbers so the physics
// node suite can exercise them without a browser:
//   * createComfortMeter / comfortFromRates — airline-leg ride-comfort score
//   * buildGauntletCourse + GAUNTLET         — low-level gauntlet gate layout
//   * createManeuverDetector                 — aerobatics loop/roll detector
// No THREE, no DOM imports. modes.js wires these into the flight loop.

// ---------------------------------------------------------------------------
// Airline leg — passenger comfort score
// ---------------------------------------------------------------------------
// Passengers feel two things: load factor held away from 1 g (pushed into or
// out of the seat), and jerk — sharp changes in vertical speed. The meter is
// fed load factor (ac.gLoad) and vertical speed (ac.vel.y) each frame and
// returns a 0..100 score. Gentle jet cruising scores high; yanking scores low.

export function createComfortMeter() {
  let gAcc = 0, jerkAcc = 0, time = 0, lastVs = null;
  return {
    // gLoad ~1 level, vs = vertical speed m/s, dt seconds.
    sample(gLoad, vs, dt) {
      if (!(dt > 0)) return;
      gAcc += Math.abs(gLoad - 1) * dt;
      if (lastVs !== null) jerkAcc += Math.abs(vs - lastVs); // |ΔVS| between frames
      lastVs = vs;
      time += dt;
    },
    get seconds() { return time; },
    score() {
      if (time <= 0) return 100;
      return comfortFromRates(gAcc / time, jerkAcc / time);
    },
    reset() { gAcc = jerkAcc = time = 0; lastVs = null; },
  };
}

// Pure map from time-averaged discomfort rates to a 0..100 score (tested).
// gRate = mean |g-1|; jerkRate = mean |ΔVS| per second (≈ vertical jerk).
export function comfortFromRates(gRate, jerkRate) {
  const penalty = gRate * 120 + jerkRate * 22;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

// ---------------------------------------------------------------------------
// Low-level gauntlet — gate layout + ceiling
// ---------------------------------------------------------------------------
// A string of low gates marching away down the runway heading. createRings
// floors each gate above terrain (see rings.js `clearance`), so gates hug the
// ground across any map. The player flies UNDER a hard altitude ceiling
// (AGL); climbing above GAUNTLET.ceilingAgl busts the run.

export const GAUNTLET = {
  ceilingAgl: 140,   // metres AGL — climb above this and the run is busted
  clearance: 28,     // gate centre height above terrain (low)
  radius: 46,        // gate radius
  gates: 8,
  spacing: 750,      // metres between gates
  start: 900,        // metres from spawn to the first gate
};

// runway: { spawn:{x,z}, headingRad, y }. Returns a [x, z, desiredY] course.
export function buildGauntletCourse(runway, opts = {}) {
  const n = opts.gates ?? GAUNTLET.gates;
  const spacing = opts.spacing ?? GAUNTLET.spacing;
  const start = opts.start ?? GAUNTLET.start;
  const alt = opts.alt ?? GAUNTLET.clearance;
  const h = runway.headingRad || 0;
  const fx = Math.cos(h), fz = -Math.sin(h); // forward vector down the runway
  const sx = runway.spawn?.x ?? 0, sz = runway.spawn?.z ?? 0, base = runway.y || 0;
  const course = [];
  for (let i = 0; i < n; i++) {
    const d = start + i * spacing;
    course.push([sx + fx * d, sz + fz * d, base + alt]);
  }
  return course;
}

// ---------------------------------------------------------------------------
// Aerobatics freestyle — maneuver detector
// ---------------------------------------------------------------------------
// Integrates BODY rates while the aircraft is actively rotating. A pure loop
// spins about the body pitch axis (omega.z) → its integral reaches 2π with the
// roll integral near zero. A pure roll spins about the body roll axis
// (omega.x). Rotating about both at once → barrel roll. Integrals reset after
// a short lull, so straight-and-level flight (rates ≈ 0) never accumulates a
// false maneuver, and each completed maneuver starts the next from zero.

export function createManeuverDetector(opts = {}) {
  const TAU = Math.PI * 2;
  const full = opts.full ?? TAU * 0.85;    // ~306° counts as a full rotation
  const rateGate = opts.rateGate ?? 0.15;  // rad/s below which an axis is "idle"
  const gapReset = opts.gapReset ?? 1.2;   // s of lull that ends a maneuver
  let pitchInt = 0, rollInt = 0, idle = 0;
  const events = [];
  function reset() { pitchInt = 0; rollInt = 0; idle = 0; }
  return {
    // omega: body rates { x: roll, y: yaw, z: pitch } rad/s; dt seconds.
    sample(omega, dt) {
      if (!(dt > 0) || !omega) return null;
      const active = Math.abs(omega.z) > rateGate || Math.abs(omega.x) > rateGate;
      if (active) {
        idle = 0;
        pitchInt += omega.z * dt;
        rollInt += omega.x * dt;
      } else {
        idle += dt;
        if (idle > gapReset) reset();
      }
      const ap = Math.abs(pitchInt), ar = Math.abs(rollInt);
      let hit = null;
      if (ap >= full && ar >= full * 0.6) hit = 'BARREL ROLL';
      else if (ap >= full && ar < full * 0.6) hit = 'LOOP';
      else if (ar >= full && ap < full * 0.6) hit = 'AILERON ROLL';
      if (hit) { events.push(hit); reset(); return hit; }
      return null;
    },
    get count() { return events.length; },
    get last() { return events[events.length - 1] || null; },
    get events() { return events.slice(); },
    reset() { reset(); },
    clear() { events.length = 0; reset(); },
  };
}
