// COM / NAV radios (v12): active + standby frequencies, tuned on the standby
// and swapped in, as on a real radio. Frequencies are integers in kHz so
// stepping never drifts. Every field gets a deterministic ILS frequency; the
// NAV radio has to be on it for the ILS needles and the APR autopilot mode
// (main.js). Pure: no DOM, no Three.

const COM_STEP = 25, NAV_STEP = 50;                  // kHz
const COM_MIN = 118000, COM_MAX = 136975, NAV_MIN = 108000, NAV_MAX = 117950;

/** ILS frequencies sit on 108.10-111.95 MHz, odd tenths (108.10, 108.15, 108.30, ...). */
export function ilsFrequency(key) {
  let h = 2166136261;
  for (const c of String(key)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const tenths = [1, 3, 5, 7, 9][(h >>> 3) % 5], mhz = 108 + ((h >>> 7) % 4), half = ((h >>> 11) & 1) * 50;
  return mhz * 1000 + tenths * 100 + half;
}

export const fmtFreq = (khz) => (khz / 1000).toFixed(khz % 50 === 0 && khz % 100 !== 0 ? 2 : khz % 25 === 0 && khz % 50 !== 0 ? 3 : 2);

export function createRadios(ils = 109300) {
  const r = {
    com: { act: 118300, sby: 121500 },
    nav: { act: ils, sby: 110500 },
    ils,
    /** Tune the STANDBY frequency one step (dir +1 / -1). */
    step(which, dir) {
      const x = r[which], st = which === 'com' ? COM_STEP : NAV_STEP;
      const lo = which === 'com' ? COM_MIN : NAV_MIN, hi = which === 'com' ? COM_MAX : NAV_MAX;
      x.sby += dir * st;
      if (x.sby > hi) x.sby = lo; if (x.sby < lo) x.sby = hi;
    },
    swap(which) { const x = r[which]; const t = x.act; x.act = x.sby; x.sby = t; },
    /** Is the NAV radio on this field's ILS? */
    get ilsTuned() { return r.nav.act === r.ils; },
    /** New field: a fresh ILS, pre-tuned (active) so nothing changes unless you retune. */
    setIls(f) { r.ils = f; r.nav.act = f; },
  };
  return r;
}
