import { clockOf } from './aitraffic.js';

// v5-R5: ATC-lite — a scripted tower that talks you round the circuit.
//
// Deliberately NOT an AI: the calls are a small state machine over the same
// geometry the landing debrief uses (runwayFrame cross/along + sink rate), so
// the tower says the right thing at the right time and nothing else.
//
// This module is PURE — no DOM, no Three, no speechSynthesis. The caller
// injects `say` (voice + transcript), which keeps phrase generation testable
// in the headless node suite. See modes.js for the wiring and hud.atc() for
// the transcript line.

const DIGITS = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four',
  5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'niner' };
const SIDES = { L: 'left', R: 'right', C: 'center' };

// '02L' -> 'zero two left'. Radio reads runways digit by digit.
export function sayRunway(name) {
  return String(name || '').toUpperCase().split('').map(
    (c) => DIGITS[c] ?? SIDES[c] ?? c).join(' ').trim();
}

// Per-aircraft radio callsigns. Spoken form only — the HUD shows the same text.
const CALLSIGNS = {
  c172: 'Skyhawk five delta alpha',
  extra300: 'Extra three hundred, five delta alpha',
  hornet: 'Viper one one',
  heavy: 'Heavy four seven',
  spirit: 'Spirit zero one',
};
export const callsignFor = (id) => CALLSIGNS[id] || 'five delta alpha';

// Field name as the tower says it: 'SINGAPORE CHANGI' -> 'Singapore Changi'.
const titleCase = (s) => String(s || 'Field').toLowerCase()
  .replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Every phrase the tower can say, as a pure function of context.
// ctx: { field, rwy (spoken), callsign, grade }
export const PHRASES = {
  clearance: (c) => `${c.callsign}, ${c.field} tower, wind calm, runway ${c.rwy}, cleared for takeoff.`,
  departure: (c) => `${c.callsign}, airborne. Climb runway heading, report pattern.`,
  pattern:   (c) => `${c.callsign}, radar contact. Resume own navigation, report inbound.`,
  inbound:   (c) => `${c.callsign}, ${c.field} tower, report midfield downwind runway ${c.rwy}.`,
  clearLand: (c) => `${c.callsign}, wind calm, runway ${c.rwy}, cleared to land.`,
  goAround:  (c) => `${c.callsign}, go around! Unstable — climb runway heading and rejoin downwind.`,
  landed:    (c) => `${c.callsign}, nice work. Exit when able, contact ground point seven.`,
  offField:  (c) => `${c.callsign}, we show you down off the field. Say your intentions.`,
  // v12: traffic (aitraffic.js). c.traffic = aircraft type, c.clock, c.miles, c.rel.
  holdShort: (c) => `${c.callsign}, hold position, traffic on short final.`,
  sequence:  (c) => `${c.callsign}, number two, follow the ${c.traffic} on final.`,
  trafficInfo: (c) => `${c.callsign}, traffic, ${c.clock} o'clock, ${c.miles} ${c.miles === 'one' ? 'mile' : 'miles'}, ${c.rel}, ${c.traffic} in the pattern.`,
  goAroundTraffic: (c) => `${c.callsign}, go around, traffic on the runway. Climb runway heading.`,
};
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// Is this descent steeper than twice a normal glideslope? Falls back to the
// flat sink-rate floor when groundspeed is unknown or implausibly low.
export function tooSteep(vsFpm, groundSpeedKt) {
  if (!(groundSpeedKt > 20)) return vsFpm < LIMITS.unstableFpm;
  // 1 kt = 101.27 ft/min, so a slope of D degrees at G knots descends
  // G * 101.27 * tan(D) feet per minute.
  const slopeFpm = groundSpeedKt * 101.27 * Math.tan(LIMITS.unstableSlopeDeg * Math.PI / 180);
  // The floor keeps a very slow aircraft from being sent around for a gentle
  // sink rate that happens to be a steep angle at 30 kt.
  return vsFpm < Math.min(LIMITS.minGoAroundFpm, -slopeFpm);
}

export function buildPhrase(id, ctx) {
  const fn = PHRASES[id];
  return fn ? fn(ctx) : '';
}

// --- geometry thresholds -----------------------------------------------
// Sink and centerline limits mirror the landing debrief's own inputs so the
// tower's "unstable" and the debrief's "HARD ARRIVAL" never disagree.
export const LIMITS = {
  airborneAgl: 30,      // m — wheels genuinely off
  patternAgl: 150,      // m — high enough to be flying, not bouncing
  inboundAgl: 400,      // m — below this and descending = coming home
  inboundCross: 700,    // m — roughly lined up with the extended centerline
  finalAgl: 200,        // m — short final band where "cleared to land" lands
  // Descent ANGLE, not a fixed sink rate. A flat -1000 fpm is a 6.6 deg dive
  // for a 70 kt trainer but a normal 3 deg approach for a 200 kt widebody —
  // the Heavy averaged -1120 fpm on a correctly flown approach and would have
  // been sent around every single time. Twice a 3 deg glideslope, scaled by
  // the aircraft's own groundspeed, is the criterion that works for both.
  unstableSlopeDeg: 6,
  unstableFpm: -1000,   // fallback when groundspeed is unknown
  minGoAroundFpm: -600, // never call a go-around for a gentler sink than this
  unstableCross: 150,   // m off centerline that earns a go-around
  minGapSec: 3.5,       // radio discipline — never step on the last call
  // traffic (v12)
  shortFinal: 2500,     // m before the aim point: traffic this close holds you short
  trafficRange: 3700,   // m (~2 NM): close enough for a traffic call
  trafficDy: 300,       // m above/below: further apart vertically is not a factor
  trafficEvery: 60,     // s between repeat traffic calls
  goAroundBelow: 60,    // m AGL: runway still occupied this low = go around
};

/**
 * Scripted tower. Feed it a snapshot each tick; it returns the id of the call
 * it just made (or null). Pure aside from its own internal phase.
 *
 * snap: { onGround, agl, vsFpm, cross, touchdown } — cross comes from
 * runwayFrame; vsFpm is positive UP (note the debrief's touchdown.fpm is
 * sink-positive, so the call site negates it there, not here).
 */
export function createAtc({ field, rwyName, callsign, say } = {}) {
  const ctx = {
    field: titleCase(field),
    rwy: sayRunway(rwyName),
    callsign: callsign || 'five delta alpha',
  };
  let phase = 'hold';
  let sinceCall = LIMITS.minGapSec;   // allow the very first call immediately
  let armed = true;
  let sinceTraffic = 1e9, sequenced = false;

  function emit(id, extra) {
    const text = buildPhrase(id, extra ? { ...ctx, ...extra } : ctx);
    sinceCall = 0;
    say?.(text, id);
    return id;
  }

  return {
    get phase() { return phase; },
    get context() { return { ...ctx }; },
    // Called on a fresh flight: back to holding short.
    reset() { phase = 'hold'; sinceCall = LIMITS.minGapSec; armed = true; sinceTraffic = 1e9; sequenced = false; },
    // ATC off (settings) or a lesson in progress: go quiet without losing phase.
    setArmed(on) { armed = !!on; },

    update(snap, dt = 0) {
      sinceCall += dt;
      sinceTraffic += dt;
      if (!armed || !snap) return null;
      if (sinceCall < LIMITS.minGapSec) return null;

      const { onGround, agl = 0, vsFpm = 0, cross = 0, touchdown = null, groundSpeedKt = 0 } = snap;
      const lined = Math.abs(cross) < LIMITS.inboundCross;
      // v12 traffic: ai = aitraffic state (or null), toAim = our distance before the aim point
      const ai = snap.ai || null;
      const aiShort = !!ai && (ai.onRunway || (ai.phase === 'final' && ai.toAim < LIMITS.shortFinal));
      const tx = ai ? { traffic: ai.type || 'Cessna' } : null;

      switch (phase) {
        case 'hold':
          if (onGround && aiShort) { phase = 'holding'; return emit('holdShort'); }
          if (onGround) { phase = 'roll'; return emit('clearance'); }
          // Careful: on the first tick after a respawn the physics step has not
          // computed gear contact yet, so onGround is still false while the
          // aircraft sits on the runway. Only treat it as a genuine airborne
          // start once there is real height under it — otherwise keep holding.
          if (agl > LIMITS.airborneAgl) { phase = 'cruise'; return null; }
          return null;

        case 'holding':
          // cleared once the traffic has landed and lifted off again
          if (!aiShort) { phase = 'roll'; return emit('clearance'); }
          if (!onGround && agl > LIMITS.airborneAgl) phase = 'climb';    // went anyway
          return null;

        case 'roll':
          if (!onGround && agl > LIMITS.airborneAgl) { phase = 'climb'; return emit('departure'); }
          return null;

        case 'climb':
          if (agl > LIMITS.patternAgl) { phase = 'cruise'; return emit('pattern'); }
          return null;

        case 'cruise':
          if (touchdown) { phase = 'down'; return emit(touchdown.onRunway ? 'landed' : 'offField'); }
          if (ai && !ai.onRunway && snap.pos && sinceTraffic > LIMITS.trafficEvery) {
            const dx = ai.x - snap.pos.x, dz = ai.z - snap.pos.z, d = Math.hypot(dx, dz), dy = ai.y - snap.pos.y;
            if (d < LIMITS.trafficRange && Math.abs(dy) < LIMITS.trafficDy) {
              sinceTraffic = 0;
              return emit('trafficInfo', { ...tx, clock: NUM[clockOf(snap.headingRad || 0, dx, dz)],
                miles: NUM[Math.max(1, Math.round(d / 1852))], rel: Math.abs(dy) < 90 ? 'same altitude' : dy > 0 ? 'above you' : 'below you' });
            }
          }
          if (!onGround && agl < LIMITS.inboundAgl && vsFpm < -100 && lined) {
            phase = 'inbound';
            return emit('inbound');
          }
          return null;

        case 'inbound': {
          if (touchdown) { phase = 'down'; return emit(touchdown.onRunway ? 'landed' : 'offField'); }
          const unstable = tooSteep(vsFpm, groundSpeedKt) || Math.abs(cross) > LIMITS.unstableCross;
          if (agl < LIMITS.finalAgl && unstable) { phase = 'cruise'; return emit('goAround'); }
          // traffic ahead of us on final, or on the runway: sequence, and
          // only clear us to land once the runway is ours
          const ahead = !!ai && (ai.onRunway || (ai.phase === 'final' && snap.toAim != null && ai.toAim < snap.toAim));
          if (ahead && !sequenced) { sequenced = true; return emit('sequence', tx); }
          if (ai && ai.onRunway && agl < LIMITS.goAroundBelow) { phase = 'cruise'; sequenced = false; return emit('goAroundTraffic'); }
          if (agl < LIMITS.finalAgl && !unstable && !(ai && ai.onRunway)) { phase = 'final'; sequenced = false; return emit('clearLand'); }
          if (agl < LIMITS.finalAgl) return null;                         // waiting on the runway
          // Climbed away or wandered off the centerline — stop expecting them.
          if (agl > LIMITS.inboundAgl || !lined) phase = 'cruise';
          return null;
        }

        case 'final':
          if (touchdown) { phase = 'down'; return emit(touchdown.onRunway ? 'landed' : 'offField'); }
          if (tooSteep(vsFpm, groundSpeedKt) || Math.abs(cross) > LIMITS.unstableCross) {
            phase = 'cruise';
            return emit('goAround');
          }
          return null;

        case 'down':
          // Touch-and-go: back in the air and climbing away, so pick the
          // circuit up again rather than going silent for the rest of the day.
          if (!onGround && agl > LIMITS.patternAgl) { phase = 'cruise'; return emit('pattern'); }
          return null;

        default:
          return null;
      }
    },
  };
}

// Speech is best-effort: some headless/OS combos expose no voices at all, in
// which case the transcript line still carries every call (plan fork R5).
export function createVoice() {
  const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  // Voice list populates asynchronously, and headless Chrome reports the API as
  // present with ZERO voices — where speak() leaves `speaking` true forever and
  // nothing is ever heard. Verified by probe. So gate on an actual voice being
  // available and fall back to the transcript line alone.
  let voices = 0;
  const refresh = () => { try { voices = synth?.getVoices?.().length || 0; } catch { voices = 0; } };
  refresh();
  try { synth?.addEventListener?.('voiceschanged', refresh); } catch { /* not supported */ }

  let enabled = true;
  return {
    get available() { return !!synth && voices > 0; },
    setEnabled(on) { enabled = !!on; if (!enabled) synth?.cancel(); },
    speak(text) {
      if (!enabled || !synth || typeof SpeechSynthesisUtterance === 'undefined') return false;
      refresh();
      if (!voices) return false;   // plan fork: transcript-only, never a failure
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.12; u.pitch = 0.9; u.volume = 0.9;   // clipped, businesslike
        synth.cancel();                                  // never queue stale calls
        synth.speak(u);
        return true;
      } catch { return false; }
    },
    cancel() { try { synth?.cancel(); } catch { /* nothing to cancel */ } },
  };
}
