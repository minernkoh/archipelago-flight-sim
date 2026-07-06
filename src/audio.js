// WebAudio: engine hum keyed to RPM, wind rush keyed to airspeed,
// stall horn, ring chime. Created lazily on first user gesture.

export function createAudio() {
  let ctx = null;
  let engineOsc, engineOsc2, engineGain, engineFilter;
  let windSrc, windGain, windFilter;
  let hornOsc, hornGain;
  let master;
  // jet path: bandpass roar + turbine whine + afterburner rumble (silent unless ac.p.engine.type === 'jet')
  let jetRoarSrc, jetRoarFilter, jetRoarGain;
  let whineOsc, whineGain;
  let abSrc, abFilter, abGain, abLfo, abLfoGain;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);

    engineOsc = ctx.createOscillator(); engineOsc.type = 'sawtooth';
    engineOsc2 = ctx.createOscillator(); engineOsc2.type = 'square';
    engineFilter = ctx.createBiquadFilter(); engineFilter.type = 'lowpass';
    engineGain = ctx.createGain(); engineGain.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.4;
    engineOsc.connect(engineFilter);
    engineOsc2.connect(g2).connect(engineFilter);
    engineFilter.connect(engineGain).connect(master);
    engineOsc.start(); engineOsc2.start();

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { // brown-ish noise
      last = (last + (Math.random() * 2 - 1) * 0.04) * 0.985;
      d[i] = last * 6;
    }
    windSrc = ctx.createBufferSource(); windSrc.buffer = noiseBuf; windSrc.loop = true;
    windFilter = ctx.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 600;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(windGain).connect(master);
    windSrc.start();

    // jet roar: same noise buffer through a bandpass, centered/gained by spool
    jetRoarSrc = ctx.createBufferSource(); jetRoarSrc.buffer = noiseBuf; jetRoarSrc.loop = true;
    jetRoarFilter = ctx.createBiquadFilter(); jetRoarFilter.type = 'bandpass';
    jetRoarFilter.frequency.value = 180; jetRoarFilter.Q.value = 0.7;
    jetRoarGain = ctx.createGain(); jetRoarGain.gain.value = 0;
    jetRoarSrc.connect(jetRoarFilter).connect(jetRoarGain).connect(master);
    jetRoarSrc.start();

    // turbine whine: pitch tracks spool
    whineOsc = ctx.createOscillator(); whineOsc.type = 'triangle'; whineOsc.frequency.value = 900;
    whineGain = ctx.createGain(); whineGain.gain.value = 0;
    whineOsc.connect(whineGain).connect(master);
    whineOsc.start();

    // afterburner: lowpass rumble with a slow flicker LFO riding on its gain
    abSrc = ctx.createBufferSource(); abSrc.buffer = noiseBuf; abSrc.loop = true;
    abFilter = ctx.createBiquadFilter(); abFilter.type = 'lowpass'; abFilter.frequency.value = 120;
    abGain = ctx.createGain(); abGain.gain.value = 0;
    abLfo = ctx.createOscillator(); abLfo.type = 'sine'; abLfo.frequency.value = 8;
    abLfoGain = ctx.createGain(); abLfoGain.gain.value = 0;
    abSrc.connect(abFilter).connect(abGain).connect(master);
    abLfo.connect(abLfoGain).connect(abGain.gain);
    abSrc.start(); abLfo.start();

    hornOsc = ctx.createOscillator(); hornOsc.type = 'square'; hornOsc.frequency.value = 640;
    hornGain = ctx.createGain(); hornGain.gain.value = 0;
    hornOsc.connect(hornGain).connect(master);
    hornOsc.start();
  }

  return {
    resume() { init(); if (ctx.state === 'suspended') ctx.resume(); },
    suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    chime() {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 1180;
      g.gain.setValueAtTime(0.35, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      o.connect(g).connect(master);
      o.start(); o.stop(ctx.currentTime + 0.55);
      o.frequency.exponentialRampToValueAtTime(1560, ctx.currentTime + 0.1);
    },
    chirp() { // tire squeal on touchdown
      if (!ctx) return;
      const src = ctx.createBufferSource();
      src.buffer = windSrc.buffer;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 950; f.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      src.connect(f).connect(g).connect(master);
      src.start(0, Math.random() * 1.5); src.stop(ctx.currentTime + 0.25);
    },
    thud() {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = 70;
      g.gain.setValueAtTime(0.6, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      o.connect(g).connect(master);
      o.start(); o.stop(ctx.currentTime + 0.4);
    },
    update(ac, controls) {
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime;
      const engineType = ac.p?.engine?.type ?? 'prop';
      const isJet = engineType === 'jet';
      const spool = ac.spool ?? ac.rpmNorm ?? (0.25 + 0.75 * controls.throttle);
      const alive = !ac.crashed;

      // prop path: unchanged; oscillators keep running, gain drops to 0 when jet
      const f = 42 + 88 * ac.rpmNorm;
      engineOsc.frequency.setTargetAtTime(f, t, 0.08);
      engineOsc2.frequency.setTargetAtTime(f * 0.5 + 1.5, t, 0.08);
      engineFilter.frequency.setTargetAtTime(320 + 900 * controls.throttle, t, 0.1);
      engineGain.gain.setTargetAtTime(alive && !isJet ? 0.05 + 0.16 * controls.throttle : 0, t, 0.1);

      // jet path: bandpass roar + turbine whine + afterburner; silent unless jet
      const jetOn = alive && isJet;
      jetRoarFilter.frequency.setTargetAtTime(180 + 720 * spool, t, 0.1);
      jetRoarGain.gain.setTargetAtTime(jetOn ? 0.05 + 0.30 * spool : 0, t, 0.12);
      whineOsc.frequency.setTargetAtTime(900 + 1700 * spool, t, 0.08);
      whineGain.gain.setTargetAtTime(jetOn ? 0.04 : 0, t, 0.1);
      const abOn = jetOn && !!ac.abOn;
      abGain.gain.setTargetAtTime(abOn ? 0.25 : 0, t, 0.15);
      abLfoGain.gain.setTargetAtTime(abOn ? 0.05 : 0, t, 0.15);

      const wind = Math.min(1, (ac.airspeed / 75) ** 2);
      windGain.gain.setTargetAtTime(wind * 0.5, t, 0.15);
      windFilter.frequency.setTargetAtTime(400 + 1400 * wind, t, 0.15);
      hornGain.gain.setTargetAtTime(ac.stalled ? 0.12 : 0, t, 0.05);
    },
  };
}
