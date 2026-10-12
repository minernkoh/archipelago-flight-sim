// TCAS (v12): traffic and resolution advisories against the AI traffic.
// THREE-free and DOM-free; main.js feeds it the airborne AI aircraft and turns
// its transitions into the HUD annunciation, the ND symbols and the aural
// ("Traffic, traffic", "Climb, climb", "Clear of conflict").
//
// A simplified DO-185 logic. Intruder velocity comes from its position history
// (the AI traffic is a pure function of time and has no velocity of its own).
// Horizontal threat: modified range tau, tau = -(r^2 - DMOD^2) / (r * rdot)
// while closing, or simply inside DMOD. Vertical threat: inside the altitude
// threshold now, or closing to it within the same time. Levels per target:
//   OT  other traffic        (shown, no alert)
//   PT  proximate traffic    within 6 nm and +-1200 ft
//   TA  traffic advisory     ~40 s to the closest point of approach
//   RA  resolution advisory  ~25 s, and only when `ra` is on (transport
//                            aircraft; light aircraft carry a TAS: TA only)
// The RA sense is the one that keeps the aircraft on its side of the intruder
// at the closest point of approach: above it -> CLIMB, below -> DESCEND.

const NM = 1852, FT = 0.3048;
const TA = { tau: 40, dmod: 0.55 * NM, alt: 850 * FT };
const RA = { tau: 25, dmod: 0.35 * NM, alt: 600 * FT };
const PT = { range: 6 * NM, alt: 1200 * FT };
const SHOW = { range: 12 * NM, alt: 2700 * FT };

function horizontalThreat(r, rdot, p) {
  if (r < p.dmod) return true;
  if (rdot >= -0.5) return false;                         // not closing
  const tau = -(r * r - p.dmod * p.dmod) / (r * rdot);
  return tau >= 0 && tau < p.tau;
}
function verticalThreat(dy, dvy, p) {
  if (Math.abs(dy) < p.alt) return true;
  if (dy * dvy >= 0) return false;                        // vertical gap opening
  return (Math.abs(dy) - p.alt) / Math.abs(dvy) < p.tau;
}

export function createTcas({ ra = false } = {}) {
  const track = new Map();                                // id -> { x, y, z, vx, vy, vz, t }
  let level = null, sense = null, lastT = null;
  const out = { level: null, sense: null, targets: [], event: null };
  return {
    get ra() { return ra; },
    setRa(on) { ra = !!on; },
    reset() { track.clear(); level = null; sense = null; lastT = null; },
    /**
     * own: { pos, vel, headingRad } (sim units); intruders: [{ id, x, y, z }];
     * t: sim time (s). Returns { level, sense, targets, event } where event is
     * 'TA' | 'RA' | 'CLEAR' on the frame the advisory changes, else null.
     */
    update(own, intruders, t) {
      const dt = lastT == null ? 0 : t - lastT;
      lastT = t;
      out.targets.length = 0;
      let worst = null, worstSense = null, worstScore = 0;
      const seen = new Set();
      for (const a of intruders) {
        seen.add(a.id);
        let k = track.get(a.id);
        if (!k) { k = { x: a.x, y: a.y, z: a.z, vx: 0, vy: 0, vz: 0, ok: false }; track.set(a.id, k); }
        else if (dt > 1e-3 && dt < 2) {
          // smoothed finite-difference velocity
          const f = Math.min(1, dt / 0.6);
          k.vx += ((a.x - k.x) / dt - k.vx) * f; k.vy += ((a.y - k.y) / dt - k.vy) * f; k.vz += ((a.z - k.z) / dt - k.vz) * f;
          k.x = a.x; k.y = a.y; k.z = a.z; k.ok = true;
        } else { k.x = a.x; k.y = a.y; k.z = a.z; }
        const dx = a.x - own.pos.x, dz = a.z - own.pos.z, dy = a.y - own.pos.y;     // intruder relative to us
        const r = Math.hypot(dx, dz);
        if (r > SHOW.range || Math.abs(dy) > SHOW.alt) continue;
        const rvx = k.vx - own.vel.x, rvz = k.vz - own.vel.z, dvy = k.vy - own.vel.y;
        const rdot = r > 1 ? (dx * rvx + dz * rvz) / r : 0;
        let lv = 'OT';
        if (r < PT.range && Math.abs(dy) < PT.alt) lv = 'PT';
        if (k.ok && horizontalThreat(r, rdot, TA) && verticalThreat(dy, dvy, TA)) lv = 'TA';
        let s = null;
        if (k.ok && ra && horizontalThreat(r, rdot, RA) && verticalThreat(dy, dvy, RA)) {
          lv = 'RA';
          // vertical miss at the closest point of approach decides the sense
          const tc = rdot < 0 ? Math.min(60, -r / rdot) : 0;
          const missY = dy + dvy * tc;                      // intruder above us at CPA if > 0
          s = missY > 0 ? 'DESCEND' : 'CLIMB';
        }
        const score = { OT: 0, PT: 1, TA: 2, RA: 3 }[lv];
        if (score > worstScore) { worstScore = score; worst = lv; worstSense = s; }
        // bearing relative to our heading (+ = right), sim heading convention
        const brg = Math.atan2(-dz, dx);
        let rel = (own.headingRad ?? 0) - brg;
        while (rel > Math.PI) rel -= 2 * Math.PI; while (rel < -Math.PI) rel += 2 * Math.PI;
        out.targets.push({ id: a.id, rel, range: r, relAltFt: Math.round(dy / FT / 100) * 100,
          trend: Math.abs(k.vy) > 2.5 ? Math.sign(k.vy) : 0, level: lv });
      }
      for (const id of track.keys()) if (!seen.has(id)) track.delete(id);
      const now = worst === 'TA' || worst === 'RA' ? worst : null;
      out.event = null;
      if (now === 'RA' && (level !== 'RA' || worstSense !== sense)) out.event = 'RA';
      else if (now === 'TA' && level == null) out.event = 'TA';
      // "Clear of conflict" ends an RA (even if a TA remains); a TA just times out
      else if (now !== 'RA' && level === 'RA') out.event = 'CLEAR';
      level = now; sense = now === 'RA' ? worstSense : null;
      out.level = level; out.sense = sense;
      return out;
    },
  };
}

/** The aural for an event: what a real TCAS says. */
export function tcasCallout(st) {
  if (st.event === 'TA') return 'Traffic, traffic';
  if (st.event === 'RA') return st.sense === 'CLIMB' ? 'Climb, climb' : 'Descend, descend';
  if (st.event === 'CLEAR') return 'Clear of conflict';
  return null;
}
