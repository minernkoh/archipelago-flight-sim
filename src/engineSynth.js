// Engine sound synthesis, one sample at a time, from the engine's physical
// state rather than from loops: what you hear is the crank turning, each
// cylinder firing, the pulse ringing down the exhaust pipe and the propeller
// blades passing, or a turbofan's shaft, fan blades and jet.
//
// Pure JS with no WebAudio objects, so the AudioWorklet (engineWorklet.js)
// and the headless tests (test/physics.test.js) run exactly the same code.
//
// PISTON (four-stroke): every cylinder fires once per two crank revolutions,
// evenly spaced, so the firing frequency is rpm * cyl / 120. A firing is a
// blowdown pressure pulse (sharper and stronger with load) plus turbulent
// rasp, scaled per cylinder by a fixed imbalance and a cycle-to-cycle
// variation that is large at idle (the lumpy idle) and small at power. The
// pulse train drives a waveguide exhaust pipe (delay = round trip at the
// speed of sound in hot gas, inverting lossy open-end reflection), then a
// muffler lowpass. The propeller adds its blade-pass tone (rpm * blades / 60)
// with harmonics that brighten as the tip Mach number climbs, plus blade-
// modulated broadband noise. Throttle chops at high rpm can afterfire.
//
// TURBOFAN (per engine, each slightly detuned so twins beat): fan blade-pass
// tone (N1 * fan blades), shaft-order "buzzsaw" once the fan tips go
// supersonic (high-bypass fans, forward arc), core compressor whine (N2),
// jet mixing roar whose spectrum and level climb steeply with jet velocity
// (aft arc), shock crackle at high power, afterburner rumble and pops.
//
// Inputs per block (all plain numbers): rpm or n1, load, alive, crank, dop
// (Doppler pitch factor), cockpit 0..1, front -1 (behind) .. +1 (ahead), ab.

const TAU = Math.PI * 2;

/** Per-aircraft engine voices. Unknown ids fall back by engine type. */
export const ENGINE_SOUNDS = {
  c172:     { kind: 'piston', cylinders: 4, blades: 2, rpmMax: 2700, pipe: 1.1, muffler: 0.75, propD: 1.9, rough: 1, afterfire: 0.15, gain: 0.42 },
  extra300: { kind: 'piston', cylinders: 6, blades: 3, rpmMax: 2700, pipe: 0.55, muffler: 0.2, propD: 2.0, rough: 0.6, afterfire: 1, gain: 0.3 },
  hornet:   { kind: 'fan', engines: 2, fanBlades: 18, n1Rpm: 13300, bypass: 0.3, buzz: 0.15, roar: 1.25, whine: 1.6, gain: 0.85 },
  heavy:    { kind: 'fan', engines: 2, fanBlades: 22, n1Rpm: 2550, bypass: 1, buzz: 1, roar: 0.75, whine: 1, gain: 1.45 },
  spirit:   { kind: 'fan', engines: 4, fanBlades: 18, n1Rpm: 9800, bypass: 0.35, buzz: 0.1, roar: 0.6, whine: 0.9, gain: 1.6 },
};
export function engineSound(id, type) {
  return ENGINE_SOUNDS[id] || (type === 'jet' ? ENGINE_SOUNDS.heavy : ENGINE_SOUNDS.c172);
}

// small deterministic PRNG (worklet and tests must not depend on Math.random state)
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

// one-pole lowpass coefficient for a cutoff
const lpK = (fc, sr) => 1 - Math.exp(-TAU * Math.min(fc, sr * 0.45) / sr);

// state-variable filter (Chamberlin, stable to ~sr/6 with the clamp below)
function svf() { return { lp: 0, bp: 0 }; }
function svfStep(s, x, f, q) {           // f = 2 sin(pi fc / sr), q = 1/Q
  s.lp += f * s.bp;
  const hp = x - s.lp - q * s.bp;
  s.bp += f * hp;
  return s;
}
const svfF = (fc, sr) => 2 * Math.sin(Math.PI * Math.min(fc, sr / 7) / sr);

const TABLE = 2048;
function table(fill) { const t = new Float32Array(TABLE + 1); for (let i = 0; i <= TABLE; i++) t[i] = fill(i / TABLE); return t; }
function look(t, ph) { const x = (ph - Math.floor(ph)) * TABLE, i = x | 0, f = x - i; return t[i] + (t[i + 1] - t[i]) * f; }

const SINE = table(p => Math.sin(TAU * p));

export class EngineSynth {
  constructor(sampleRate, cfg = ENGINE_SOUNDS.c172, seed = 7) {
    this.sr = sampleRate;
    this.rand = rng(seed);
    // p = targets as last reported by the sim (~frame rate); s = the values
    // actually used, glided per block so 60 Hz updates never zipper
    this.p = { rpm: 0, n1: 0, load: 0, alive: 0, crank: 0, dop: 1, cockpit: 0, front: 0, ab: 0, gain: 1, misfire: 0 };
    this.s = { ...this.p };
    this.loadSlow = 0;
    this.configure(cfg);
  }

  configure(cfg) {
    this.cfg = cfg;
    const r = this.rand, sr = this.sr;
    this.out = 0;
    if (cfg.kind === 'piston') {
      // fixed per-cylinder imbalance (no real engine fires all cylinders alike)
      this.cylGain = Array.from({ length: cfg.cylinders }, () => 0.86 + 0.28 * r());
      this.cyc = 0; this.nextFire = 0; this.cyl = 0;
      this.pulse = 0; this.rasp = 0; this.thump = 0;
      // exhaust waveguide: round trip of the pipe at ~520 m/s (hot gas)
      this.pipeLen = Math.max(8, Math.round(sr * 2 * cfg.pipe / 520));
      this.pipe = new Float32Array(this.pipeLen); this.pipeI = 0; this.pipeLp = 0;
      this.muff = 0; this.muff2 = 0; this.body = svf(); this.cabin = svf();
      this.propPh = 0; this.propNz = 0; this.propLp = 0;
      // blade-pass waveforms: dull (low tip Mach) and bright (near-sonic tips)
      this.propDull = table(p => Math.sin(TAU * p) + 0.32 * Math.sin(2 * TAU * p) + 0.1 * Math.sin(3 * TAU * p));
      this.propBright = table(p => { let s = 0; for (let k = 1; k <= 14; k++) s += Math.sin(k * TAU * p) / Math.pow(k, 0.85); return s * 0.55; });
      this.pop = 0; this.popLp = 0; this.cabLp = 0; this.starterPh = 0;
    } else {
      this.eng = Array.from({ length: cfg.engines }, (_, i) => ({
        detune: 1 + (i - (cfg.engines - 1) / 2) * 0.0045 + (r() - 0.5) * 0.002,
        ph: r(), fanPh: r(), corePh: r(), corePh2: r(), flut: 0, roar: svf(), roarLo: 0, crack: 0, crackLp: 0,
      }));
      // buzzsaw: shaft-order harmonics with a fixed, uneven spectrum (blade
      // to blade differences decide which orders stick out; set at build)
      const amps = Array.from({ length: 40 }, (_, k) => (0.25 + r()) / Math.pow(k + 1, 0.6));
      const phs = amps.map(() => r() * TAU);
      this.buzzTab = table(p => { let s = 0; for (let k = 0; k < 40; k++) s += amps[k] * Math.sin((k + 1) * TAU * p + phs[k]); return s * 0.22; });
      this.ab = svf(); this.abPop = 0; this.abPopLp = 0; this.cabinLp = 0; this.lowLp = 0;
    }
  }

  /** Render n samples into out (Float32Array), adding nothing else. */
  render(out, n, offset = 0) {
    const P = this.p, S = this.s, dt = n / this.sr;
    const k = 1 - Math.exp(-dt / 0.05), kf = 1 - Math.exp(-dt / 0.02);
    S.rpm += (P.rpm - S.rpm) * k; S.n1 += (P.n1 - S.n1) * k; S.load += (P.load - S.load) * k;
    S.dop += (P.dop - S.dop) * kf; S.cockpit += (P.cockpit - S.cockpit) * kf; S.front += (P.front - S.front) * k;
    S.ab += (P.ab - S.ab) * (1 - Math.exp(-dt / 0.15)); S.gain += (P.gain - S.gain) * kf;
    S.alive = P.alive; S.crank = P.crank; S.misfire = P.misfire;
    this.loadSlow += (S.load - this.loadSlow) * (1 - Math.exp(-dt / 0.5));
    if (this.cfg.kind === 'piston') this.renderPiston(out, n, offset);
    else this.renderFan(out, n, offset);
  }

  renderPiston(out, n, o) {
    const sr = this.sr, c = this.cfg, P = this.s, r = this.rand;
    const dop = P.dop, alive = P.alive > 0.5;
    // crank speed: the engine's own rpm, or the starter's ~180 rpm with no combustion
    const cranking = !alive && P.crank > 0.5;
    const rpm = alive ? Math.max(P.rpm, 300) : (cranking ? 180 : P.rpm);
    const turning = rpm > 20;
    const load = alive ? P.load : 0;
    const revPerSample = rpm / 60 / sr * dop;
    const interval = 2 / c.cylinders;                 // revolutions between firings
    // pulse shape: blowdown is sharper and stronger with manifold pressure
    const pulseDecay = Math.exp(-1 / (sr * (0.0026 - 0.0014 * load)));
    const raspDecay = Math.exp(-1 / (sr * 0.004));
    const thumpDecay = Math.exp(-1 / (sr * 0.011));
    const roughK = c.rough * (0.08 + 0.32 * (1 - Math.min(1, (rpm - 600) / 900)) ** 2) * (alive ? 1 : 0.4);
    const fireAmp = alive ? 0.45 + 0.75 * load + 0.25 * Math.min(1, rpm / c.rpmMax) : 0.3;
    const fb = -0.55, pipeK = lpK(2600, sr);
    const muffK = lpK(900 + 3200 * (1 - c.muffler), sr), muffK2 = lpK(380 + 1600 * (1 - c.muffler), sr);
    // propeller: tip Mach decides how buzzy the blade-pass gets
    const tipMach = Math.PI * c.propD * (rpm / 60) / 340;
    const bright = Math.max(0, Math.min(1, (tipMach - 0.45) / 0.4));
    const propAmp = turning ? 0.12 * Math.min(1, (rpm / c.rpmMax) ** 2) * (0.5 + 0.9 * load) * (1 + 0.6 * bright) : 0;
    const propPerSample = revPerSample * c.blades;
    const propNzK = lpK(700 + 2400 * bright, sr);
    // cabin: lows boom, highs are lost through the firewall and windows
    const ck = P.cockpit, bodyF = svfF(130 * dop, sr), cabF = svfF(95, sr);
    const exhaustMix = (1 - 0.55 * ck) * (1 - 0.25 * P.front);   // pipes face down and aft
    const propMix = 1 + 0.6 * ck + 0.25 * P.front;
    // afterfire: rich mixture lighting in the pipe after a sharp throttle chop at high rpm
    const chop = Math.max(0, this.loadSlow - load);   // load just fell away
    const popRate = alive ? c.afterfire * Math.min(1, chop * 3) * Math.max(0, Math.min(1, (rpm - 1300) / 1000)) * 70 : 0;
    const g = P.gain * c.gain;

    for (let i = 0; i < n; i++) {
      let exc = 0;
      if (turning) {
        this.cyc += revPerSample;
        if (this.cyc >= this.nextFire) {
          const k = this.cylGain[this.cyl];
          // a rough-running engine (failures.js 'power') drops ~1 in 3 firings
          const a = (P.misfire > 0.5 && alive && r() < 0.32 ? 0.08 : 1) * fireAmp * k * (1 + roughK * (r() * 2 - 1));
          // compression-only "chuff" when cranking; a real firing otherwise
          this.pulse += a; this.rasp += a * (alive ? 0.5 + 0.6 * load : 0.2); this.thump += a * 0.6;
          this.cyl = (this.cyl + 1) % c.cylinders;
          this.nextFire += interval;
          if (this.cyc > 1e6) { this.cyc -= 1e6; this.nextFire -= 1e6; }
        }
        exc = this.pulse * 0.9 + this.rasp * (r() * 2 - 1) * 0.55;
        this.pulse *= pulseDecay; this.rasp *= raspDecay; this.thump *= thumpDecay;
      }
      // starter motor: gear whine that sags as each cylinder comes up on compression
      if (cranking) {
        this.starterPh += 640 * (1 - 0.22 * Math.min(1, this.thump * 4)) / sr;
        if (this.starterPh > 1) this.starterPh -= 1;
        exc += 0.1 * (look(SINE, this.starterPh) + 0.5 * look(SINE, this.starterPh * 3));
      }
      // waveguide exhaust: inverting, lossy reflection at the open end
      const back = this.pipe[this.pipeI];
      this.pipeLp += (back - this.pipeLp) * pipeK;
      const y = exc + fb * this.pipeLp;
      this.pipe[this.pipeI] = y;
      this.pipeI = (this.pipeI + 1) % this.pipeLen;
      // afterfire pops
      if (popRate > 0 && r() < popRate / sr) this.pop += 0.8 + 0.8 * r();
      this.popLp += ((r() * 2 - 1) * this.pop - this.popLp) * 0.35;
      this.pop *= 0.9965;
      // muffler + body resonance
      this.muff += (y + this.popLp * 0.8 - this.muff) * muffK;
      this.muff2 += (this.muff - this.muff2) * muffK2;
      svfStep(this.body, this.muff2, bodyF, 0.9);
      const exhaust = this.muff * (0.35 + 0.4 * (1 - c.muffler)) + this.muff2 * 0.7 + this.body.bp * 0.35 + this.thump * 0.25;
      // propeller blade-pass + chopped broadband
      this.propPh += propPerSample; if (this.propPh > 1) this.propPh -= 1;
      const bp = look(this.propDull, this.propPh) * (1 - bright) + look(this.propBright, this.propPh) * bright;
      const chopW = Math.max(0, look(SINE, this.propPh)) ** 4;
      this.propLp += ((r() * 2 - 1) - this.propLp) * propNzK;
      const prop = propAmp * (bp + this.propLp * (0.6 + 1.6 * chopW));
      let s = exhaust * exhaustMix * 0.55 + prop * propMix;
      // cockpit: firewall/cabin transmission
      if (ck > 0) {
        svfStep(this.cabin, s, cabF, 0.7);
        this.cabLp += (s - this.cabLp) * 0.08;
        s = s * (1 - ck) + ck * (this.cabLp * 1.1 + this.cabin.bp * 0.6);
      }
      out[o + i] = s * g;
    }
  }

  renderFan(out, n, o) {
    const sr = this.sr, c = this.cfg, P = this.s, r = this.rand;
    const n1 = Math.max(0, P.n1), dop = P.dop, ck = P.cockpit, front = P.front;
    const fwd = Math.max(0, front), aft = Math.max(0, -front);
    const shaftHz = n1 * c.n1Rpm / 60 * dop;
    const n2 = n1 > 0.01 ? 0.55 + 0.45 * n1 : 0;
    const coreHz = n2 * 3100 * dop;                      // dominant compressor stage tone
    // fan tone and buzzsaw: forward arc; buzzsaw only once the tips are supersonic
    const fanAmp = c.bypass * 0.05 * Math.min(1, n1 * 1.6) * (0.3 + 1.2 * fwd) * (1 - 0.6 * ck);
    const buzzAmp = c.buzz * 0.11 * Math.max(0, Math.min(1, (n1 - 0.78) / 0.14)) * (0.25 + 1.2 * fwd) * (1 - 0.8 * ck);
    const whineAmp = c.whine * 0.035 * Math.min(1, n2 * 1.4) * (1.1 - 0.5 * n1) * (0.6 + 0.6 * fwd) * (1 - 0.5 * ck);
    // jet roar: acoustic power ~ V^8, so level climbs steeply with N1; aft arc
    const v = Math.max(0, (n1 - 0.15) / 0.85);
    const roarAmp = c.roar * (0.32 * v ** 2.4 + (n1 > 0.05 ? 0.012 : 0)) * (0.45 + 0.9 * aft + 0.2 * fwd) * (1 - 0.55 * ck);
    const roarF = svfF((90 + 1500 * v * v) * dop, sr);
    const roarLoK = lpK(70 + 160 * v, sr);
    const crackRate = c.roar * Math.max(0, (n1 - 0.86) / 0.14) * 140 * (0.2 + aft);
    const ab = P.ab;
    const abF = svfF(150 * dop, sr);
    const abPopRate = ab * 45;
    const cabK = lpK(ck > 0 ? 500 : 20000, sr);
    const g = P.gain * c.gain / Math.sqrt(c.engines);

    for (let i = 0; i < n; i++) {
      let s = 0;
      const nz0 = r() * 2 - 1;
      for (let e = 0; e < this.eng.length; e++) {
        const E = this.eng[e];
        const sh = shaftHz * E.detune / sr;
        E.ph += sh; if (E.ph > 1) E.ph -= 1;
        E.fanPh += sh * c.fanBlades; if (E.fanPh > 1) E.fanPh -= Math.floor(E.fanPh);
        E.corePh += coreHz * E.detune / sr; if (E.corePh > 1) E.corePh -= 1;
        E.corePh2 += coreHz * 1.37 * E.detune / sr; if (E.corePh2 > 1) E.corePh2 -= 1;
        const fan = look(SINE, E.fanPh) + 0.35 * look(SINE, E.fanPh * 2);
        const buzz = look(this.buzzTab, E.ph);
        // two compressor stages, with the turbulent flutter that keeps a
        // real whine from sounding like a test tone
        E.flut += ((r() * 2 - 1) - E.flut) * 0.004;
        const core = (look(SINE, E.corePh) + 0.55 * look(SINE, E.corePh2)) * (1 + 2.5 * E.flut);
        // roar: per-engine noise (independent so twins decorrelate)
        const nz = e === 0 ? nz0 : r() * 2 - 1;
        svfStep(E.roar, nz, roarF, 1.2);
        E.roarLo += (nz - E.roarLo) * roarLoK;
        // crackle: sparse, skewed (positive) shock pulses
        if (crackRate > 0 && r() < crackRate / sr) E.crack += 0.6 + r();
        E.crackLp += (E.crack * (r() * 0.6 + 0.4) - E.crackLp) * 0.5;
        E.crack *= 0.93;
        s += fan * fanAmp + buzz * buzzAmp + core * whineAmp
          + (E.roar.lp * 0.8 + E.roarLo * 2.2) * roarAmp + E.crackLp * 0.12 * aft;
      }
      if (ab > 0) {
        svfStep(this.ab, r() * 2 - 1, abF, 1.4);
        if (r() < abPopRate / sr) this.abPop += 0.7 + r();
        this.abPopLp += (this.abPop * (r() * 2 - 1) - this.abPopLp) * 0.25;
        this.abPop *= 0.985;
        s += ab * (this.ab.lp * 2.8 * (0.5 + aft) + this.abPopLp * 0.5);
      }
      if (ck > 0) {                                     // fuselage/cabin transmission
        this.cabinLp += (s - this.cabinLp) * cabK;
        s = s * (1 - ck) + this.cabinLp * ck * 1.4;
      }
      out[o + i] = s * g;
    }
  }
}
