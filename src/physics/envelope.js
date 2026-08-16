// Flight-envelope limits: Vne, Vfe, Mach and structural g.
//
// THREE-free, like the rest of src/physics — the headless suite drives it.
//
// Before this module the sim had NO outer boundary at all: the Hornet would
// accelerate to Mach 1.54 in level flight at 500 m with no transonic drag and
// nothing breaking, then pull 15.9 g with the airframe intact, and the C172
// took full flaps at 150 kt (Vfe 85) with no consequence. `p.maxSpeed` existed
// but nothing in the flight model read it — it only lit an annunciator, and it
// compared TRUE airspeed against a limit that is by definition indicated.
//
// Everything here is expressed in EAS (equivalent airspeed) because that is
// what airframe limits actually are. `ac.eas` is computed unconditionally in
// step(), unlike `ac.iasIndicated` which freezes on a pitot failure — so a
// broken pitot now genuinely hides an overspeed from the pilot while the
// airframe still feels it.

const KT = 1.94384;

// Speed of sound for the standard atmosphere (troposphere, then isothermal).
export function speedOfSound(alt) {
  const T = alt < 11000 ? 288.15 - 0.0065 * alt : 216.65;
  return Math.sqrt(1.4 * 287.05 * T);
}

// Transonic wave drag. Zero below Mcrit by construction, so subsonic aircraft
// (and the C172 cruise state hash, at M 0.14) never see it.
export function machDragRise(mach, p) {
  const m = p.mach;
  if (!m || mach <= m.crit) return 0;
  const d = mach - m.crit;
  return m.cdWave * d * d / (0.1 * 0.1);   // ~cdWave at Mcrit + 0.1
}

// Flaps trail back under air load above Vfe instead of failing outright —
// realistic, non-punitive, and it gives the player a visible consequence.
// Exactly identity at or below Vfe.
//
// The floor matters: an early version drove deflection to zero, which set up a
// divergent loop — losing flap lift made the aircraft descend and accelerate,
// which blew the flaps back further. Real blow-back trails the surface toward
// a partial setting under load, it does not retract it, so half deflection is
// the floor and the actual penalty for an overspeed is structural (see
// updateDamage) rather than an aerodynamic cliff.
export const FLAP_BLOWBACK_FLOOR = 0.5;
export function flapBlowback(eas, flaps, p) {
  const vfe = p.limits?.vfe;
  if (!vfe || flaps <= 0 || eas <= vfe) return flaps;
  const over = eas / vfe - 1;
  const frac = Math.max(FLAP_BLOWBACK_FLOOR, Math.min(1, 1 - over / 0.25));
  return flaps * frac;
}

// Human-readable V-speeds for the menu card, the ASI arcs and the HUD.
export function vSpeeds(p) {
  const rho = 1.225, g = 9.81;
  const clMax = p.CL0 + p.CLalpha * p.alphaStall;
  const clMaxF = p.CL0 + p.flapCL + p.CLalpha * (p.alphaStall + p.flapStallShift);
  const vs = (cl) => Math.sqrt((2 * p.mass * g) / (rho * p.wingArea * cl));
  const L = p.limits || {};
  return {
    vs1Kt: vs(clMax) * KT,                        // clean 1g stall
    vs0Kt: vs(clMaxF) * KT,                       // full-flap 1g stall
    vfeKt: L.vfe ? L.vfe * KT : null,
    vnoKt: L.vno ? L.vno * KT : null,
    vneKt: (L.vne ?? p.maxSpeed) * KT,
    gPos: L.gPos ?? 3.8,
    gNeg: L.gNeg ?? -1.5,
  };
}

// Structural damage accumulator. A momentary excursion is survivable and
// sustained abuse is not — an instant trip would fire spuriously on a single
// gust-loaded frame. 1.5x limit load is the certification ultimate factor, so
// "instant above 1.5x" is the real rule rather than an invention.
export function updateDamage(ac, dt) {
  const p = ac.p;
  const L = p.limits;
  if (!L) return;
  const vne = L.vne ?? p.maxSpeed;
  const gPos = L.gPos ?? 3.8, gNeg = L.gNeg ?? -1.5;
  let rate = -0.5;                                 // heals when inside the envelope
  let cause = '';

  const overV = ac.eas / vne;
  if (overV > 1.15) { rate = Infinity; cause = 'overspeed'; }
  else if (overV > 1) { rate = Math.max(rate, (overV - 1) / 0.15); cause = 'overspeed'; }

  const gl = ac.gLoad;
  const overG = gl >= 0 ? gl / gPos : gl / gNeg;
  if (overG > 1.5) { rate = Infinity; cause = 'overstress'; }
  else if (overG > 1) {
    const r = (overG - 1) / 0.5;
    if (r > rate) { rate = r; cause = 'overstress'; }
  }

  ac.damage = Math.max(0, Math.min(1, ac.damage + (rate === Infinity ? 1 : rate * dt)));
  if (cause) ac.damageCause = cause;
  if (ac.damage >= 1 && !ac.crashed) {
    ac.crashed = true;
    ac.crashReason = ac.damageCause || 'overstress';
  }
}
