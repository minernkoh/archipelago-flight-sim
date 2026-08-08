// Autopilot: HDG-hold, ALT-hold, IAS-hold (throttle), wing-leveler, and
// NAV-hold (waypoint steering). Each mode is a simple proportional law with
// rate damping, writing CONTROL INPUTS (not forces) into controls.state.
//
// Integration contract (see main.js): the AP runs AFTER controls.poll() every
// frame and only writes an axis when the human is NOT holding a key for it
// (controls.axisActive(axis) === false). So poll's keyboard path is untouched
// when the AP is off, and live keyboard input always overrides the AP for that
// axis. Writes blend toward the commanded value to avoid an engage-time jump.
//
// Envelope guard: ALT-hold never commands pitch that would hold the aircraft
// past its stall AoA. As alpha approaches (alphaStall - margin) nose-up
// authority tapers to zero; if alpha crosses the limit while ALT-hold is
// pushing to hold altitude, ALT-hold DISCONNECTs (annunciated) rather than
// stalling.

import { attitude } from './physics/flightModel.js';

const RAD2DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap180 = (d) => { while (d > 180) d -= 360; while (d < -180) d += 360; return d; };
const compassHdg = (headingRad) => (90 - headingRad * RAD2DEG + 360) % 360;

// Conservative gains: tuned to damp rather than PIO. Aileron/elevator are
// normalized -1..1; Cmde gives plenty of pitch authority so those gains stay small.
//
// The roll gains are NOT fixed: aileron authority varies ~9x across the fleet
// (pb/2V 0.067 on the heavy to 0.38 on the Extra), so a single gain either
// PIOs the aerobat or leaves the widebody unable to hold a bank. rollPRef /
// rollDRef are divided by the airframe's own pb/2V at the use site, which
// reproduces the loop gain these numbers were originally tuned at and adapts
// automatically if the aerodynamic coefficients are ever retuned again.
const G = {
  hdgToBank: 1.1, maxBank: 25,   // deg commanded bank per deg heading error
  rollPRef: 0.00672,             // = 0.028 x 0.240, the gain tuned against the old c172
  rollDRef: 0.0048,              // = 0.020 x 0.240
  altToVs: 0.06, maxVs: 6,       // m/s commanded climb per m altitude error
  vsToPitch: 1.2, maxPitch: 12,  // deg commanded pitch per (m/s) VS error
  pitchP: 0.035, pitchD: 0.02,   // elevator per deg pitch error / per (deg/s) pitch rate
  iasGain: 0.22,                 // throttle/s per (m/s) IAS error (integrator)
  stallMargin: 0.035,            // rad below alphaStall where nose-up authority hits zero
  taperBand: 0.05,               // rad band over which nose-up authority tapers
  overspeedFrac: 0.98,           // back throttle off above this fraction of maxSpeed
};

const CAPTURE = 300;             // m — sequence to the next fix inside this radius

export function createAutopilot() {
  // Active modes and the selected reference values.
  const m = { hdg: false, alt: false, ias: false, wing: false, nav: false };
  const sel = { hdg: 0, alt: 0, ias: 0 }; // hdg deg, alt metres MSL, ias m/s (TAS-ish)
  let thrInt = 0;                          // throttle integrator (IAS hold)
  let disconnectT = 0;                     // seconds left on the AP DISCONNECT annunciation

  // Flight plan: ordered world-space fixes [x, z, y?]; origin anchors the first leg.
  let plan = null; // { points: [[x,z,y?]...], origin: [x,z] | null }
  let navIdx = 0;

  const anyOn = () => m.hdg || m.alt || m.ias || m.wing || m.nav;

  function disconnectAll(annunciate) {
    m.hdg = m.alt = m.ias = m.wing = m.nav = false;
    if (annunciate) disconnectT = 4;
  }

  // Blend an axis toward a commanded value, honouring human override.
  function drive(controls, axis, val, dt) {
    if (controls.axisActive(axis)) return; // human is flying this axis
    const cur = controls.state[axis];
    controls.state[axis] = cur + (val - cur) * Math.min(1, dt * 6);
  }

  function navGuidance(ac) {
    if (!plan || !plan.points.length) return null;
    const i = Math.min(navIdx, plan.points.length - 1);
    const wp = plan.points[i];
    const dx = wp[0] - ac.pos.x, dz = wp[1] - ac.pos.z;
    const dist = Math.hypot(dx, dz);
    const bearing = (90 - Math.atan2(-dz, dx) * RAD2DEG + 360) % 360;
    // cross-track vs the active leg (origin -> wp); +ve = right of course
    const origin = i > 0 ? plan.points[i - 1] : plan.origin;
    let xtk = 0;
    if (origin) {
      const lx = wp[0] - origin[0], lz = wp[1] - origin[1];
      const L = Math.hypot(lx, lz) || 1;
      xtk = ((ac.pos.x - origin[0]) * lz - (ac.pos.z - origin[1]) * lx) / L;
    }
    return { bearing, dist, xtk, index: i, total: plan.points.length };
  }

  function trySequence(ac, g) {
    if (!plan || navIdx >= plan.points.length - 1) return; // hold at the last fix
    if (g.dist < CAPTURE) { navIdx++; return; }
    // crossed abeam: past the fix along the leg
    const wp = plan.points[navIdx];
    const origin = navIdx > 0 ? plan.points[navIdx - 1] : plan.origin;
    if (origin) {
      const lx = wp[0] - origin[0], lz = wp[1] - origin[1];
      const L2 = lx * lx + lz * lz;
      const proj = ((ac.pos.x - origin[0]) * lx + (ac.pos.z - origin[1]) * lz) / (L2 || 1);
      if (proj > 1.0) navIdx++;
    }
  }

  return {
    modes: m,
    sel,
    get on() { return anyOn(); },

    // --- engage/disengage (snap selected refs to the current state) ---
    toggleHdg(ac) { m.hdg = !m.hdg; if (m.hdg) { m.wing = false; sel.hdg = compassHdg(attitude(ac).heading); } },
    toggleAlt(ac) { m.alt = !m.alt; if (m.alt) sel.alt = ac.pos.y; },
    toggleIas(ac, controls) { m.ias = !m.ias; if (m.ias) { sel.ias = ac.iasIndicated || ac.airspeed; thrInt = controls.state.throttle; } },
    toggleWing(ac) { m.wing = !m.wing; if (m.wing) m.hdg = m.nav = false; },
    toggleNav(ac) { m.nav = !m.nav; if (m.nav) { m.wing = false; navIdx = 0; } },
    // Master: engage HDG+ALT at current state, or disengage everything.
    toggleMaster(ac, controls) {
      if (anyOn()) { disconnectAll(false); }
      else { m.hdg = true; m.alt = true; sel.hdg = compassHdg(attitude(ac).heading); sel.alt = ac.pos.y; }
    },

    setPlan(points, origin) { plan = { points: (points || []).map(p => [p[0], p[1], p[2]]), origin: origin || null }; navIdx = 0; },
    get planLength() { return plan ? plan.points.length : 0; },
    get activeFix() { return navIdx; },
    // Route snapshot for the minimap's moving-map overlay (v5-R4).
    getPlan() { return plan ? { points: plan.points, idx: navIdx, navOn: m.nav } : null; },
    get navOn() { return m.nav; },
    engageNav() { if (!m.nav) { m.nav = true; m.wing = false; } navIdx = 0; },

    // Runs after controls.poll() each frame. Writes only idle axes.
    update(ac, controls, dt) {
      if (disconnectT > 0) disconnectT = Math.max(0, disconnectT - dt);
      if (!anyOn()) return;

      const att = attitude(ac);
      const curHdg = compassHdg(att.heading);
      const rollDeg = att.roll * RAD2DEG;        // + = right bank
      const pitchDeg = att.pitch * RAD2DEG;      // + = nose up
      const rollRate = ac.omega.x * RAD2DEG;     // + = rolling right
      const pitchRate = ac.omega.z * RAD2DEG;    // + = pitching up
      const p = ac.p;

      // NAV drives the lateral target and sequences fixes.
      if (m.nav && plan && plan.points.length) {
        const g = navGuidance(ac);
        if (g) { sel.hdg = g.bearing; trySequence(ac, g); }
      }

      // --- lateral: aileron (HDG / NAV / wing-leveler) ---
      if (m.hdg || m.nav || m.wing) {
        const lateralNav = m.hdg || m.nav;
        const desiredBank = lateralNav
          ? clamp(wrap180(sel.hdg - curHdg) * G.hdgToBank, -G.maxBank, G.maxBank)
          : 0; // pure wing-leveler
        // Normalize the roll loop by this airframe's aileron authority (pb/2V).
        const rollAuth = Math.max(0.02, p.Clda / -p.Clp);
        const rollP = G.rollPRef / rollAuth, rollD = G.rollDRef / rollAuth;
        const ail = clamp(rollP * (desiredBank - rollDeg) - rollD * rollRate, -1, 1);
        drive(controls, 'aileron', ail, dt);
      }

      // --- vertical: elevator (ALT-hold) with stall-envelope guard ---
      if (m.alt) {
        const flaps = controls.state.flaps || 0;
        const alphaStall = p.alphaStall + (p.flapStallShift || 0) * flaps;
        const alphaMax = alphaStall - G.stallMargin;

        if (ac.alpha > alphaMax) {
          // Holding altitude would require flying past the stall AoA — bail out.
          m.alt = false;
          disconnectT = 4;
          drive(controls, 'elevator', clamp(G.pitchP * (-3 - pitchDeg), -0.6, 0), dt);
        } else {
          const altErr = sel.alt - ac.pos.y;
          const desiredVs = clamp(altErr * G.altToVs, -G.maxVs, G.maxVs);
          const vsErr = desiredVs - ac.vel.y;
          const desiredPitch = clamp(vsErr * G.vsToPitch, -G.maxPitch, G.maxPitch);
          let elev = clamp(G.pitchP * (desiredPitch - pitchDeg) - G.pitchD * pitchRate, -1, 1);
          // Taper nose-up authority as alpha approaches the limit.
          if (elev > 0 && ac.alpha > alphaMax - G.taperBand) {
            elev *= clamp((alphaMax - ac.alpha) / G.taperBand, 0, 1);
          }
          drive(controls, 'elevator', elev, dt);
        }
      }

      // --- speed: throttle (IAS-hold) with overspeed protection ---
      if (m.ias) {
        const iasErr = sel.ias - (ac.iasIndicated || ac.airspeed);
        thrInt = clamp(thrInt + iasErr * G.iasGain * dt, 0, 1);
        let thr = thrInt;
        if (ac.eas > (p.limits?.vne ?? p.maxSpeed) * G.overspeedFrac) thr = Math.min(thr, 0.15);
        drive(controls, 'throttle', thr, dt);
      }
    },

    // HUD annunciation payload.
    status(ac) {
      const nd = (m.nav && plan && plan.points.length) ? navGuidance(ac) : null;
      return {
        on: anyOn(),
        hdg: m.hdg || m.nav, alt: m.alt, ias: m.ias, wing: m.wing, nav: m.nav,
        selHdg: sel.hdg, selAlt: sel.alt, selIas: sel.ias,
        navData: nd ? { idx: nd.index + 1, total: nd.total, dme: nd.dist, xtk: nd.xtk } : null,
        warn: disconnectT > 0 ? 'AP DISCONNECT' : null,
      };
    },
  };
}
