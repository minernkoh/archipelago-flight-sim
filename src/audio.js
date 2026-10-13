// WebAudio: engine, synthesised from the engine's physical state in an
// AudioWorklet (engineSynth.js: cylinder firing pulses through an exhaust
// waveguide + propeller blade-pass, or turbofan fan/buzzsaw/core/jet roar),
// with cockpit vs exterior voicing and fore/aft directivity. Browsers without
// AudioWorklet keep the older oscillator/noise engine below. Wind rush keyed to airspeed, stall
// horn + buffet rumble, flap/gear motors, tyre screech, ring chime. Created
// lazily on first user gesture. Aircraft sounds pass through one "view" stage:
// Doppler + distance gain + lowpass when the camera is outside the aircraft,
// a muffled lowpass inside the cockpit.
//
// Bus layout (everything routes through master, so MUTE is one gain):
//   engine / jet / horn / buffet / motors -> view -> sfx
//   wind / chime / chirp / thud -> sfx -> master -> out
//                                              (music) -> music -> master -> out
// The music bus exists and is mixed, but nothing feeds it yet, the sim has no
// music track. Its slider is therefore live but silent until one is added;
// connectMusic() is the hook for that.

import { engineSound } from './engineSynth.js';

export function createAudio() {
  let ctx = null;
  let masterVol = 0.5;  // settings-driven; applied at init and via setVolume
  let sfxVol = 1;
  let musicVol = 0.6;
  let muted = false;
  let sfx = null, music = null;
  const applyMaster = () => { if (master) master.gain.value = muted ? 0 : masterVol; };
  let engineOsc, engineOsc2, engineGain, engineFilter;
  let windSrc, windGain, windFilter;
  let hornOsc, hornGain;
  let master;
  // jet path: bandpass roar + turbine whine + afterburner rumble (silent unless ac.p.engine.type === 'jet')
  let jetRoarSrc, jetRoarFilter, jetRoarGain;
  let whineOsc, whineGain;
  let abSrc, abFilter, abGain, abLfo, abLfoGain;
  // organic prop: noise -> bandpass -> blade-pass chop, plus firing thump
  let propSrc, propFilter, propChop, propGain, bladeLfo, bladeLfoGain, thumpOsc, thumpGain;
  // view stage (aircraft sounds only), buffet, motors
  let viewFilter, viewGain;
  let buffetSrc, buffetFilter, buffetGain;
  let flapOsc, flapGain, gearOsc, gearGain;
  // weather: rain hiss (outside) / drumming (on the canopy), thunder one-shots
  let rainSrc, rainFilter, rainGain, drumFilter, drumGain, brownBuf = null;
  let rainLevel = 0, rainCockpit = false;
  // per-frame scratch (plain numbers, no allocation)
  let camPX = 0, camPY = 0, camPZ = 0, camT = -1, camVX = 0, camVY = 0, camVZ = 0;
  let dop = 1, lastFlaps = null, lastGear = null, flapUntil = 0, gearUntil = 0;
  let lastSink = 0, lastSide = 0;
  const SOUND_C = 340;
  // physically modelled engine (AudioWorklet); null until the module loads
  let synth = null, synthP = null, synthId = null;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : masterVol;
    master.connect(ctx.destination);
    // Sub-buses so SFX and music trim independently of the master fader.
    sfx = ctx.createGain(); sfx.gain.value = sfxVol; sfx.connect(master);
    music = ctx.createGain(); music.gain.value = musicVol; music.connect(master);

    // view stage: every aircraft-borne sound goes through here
    viewFilter = ctx.createBiquadFilter(); viewFilter.type = 'lowpass'; viewFilter.frequency.value = 2200;
    viewGain = ctx.createGain(); viewGain.gain.value = 1;
    viewFilter.connect(viewGain).connect(sfx);
    const view = viewFilter;

    engineOsc = ctx.createOscillator(); engineOsc.type = 'sawtooth';
    engineOsc2 = ctx.createOscillator(); engineOsc2.type = 'square';
    engineFilter = ctx.createBiquadFilter(); engineFilter.type = 'lowpass';
    engineGain = ctx.createGain(); engineGain.gain.value = 0;
    const g2 = ctx.createGain(); g2.gain.value = 0.4;
    engineOsc.connect(engineFilter);
    engineOsc2.connect(g2).connect(engineFilter);
    engineFilter.connect(engineGain).connect(view);
    engineOsc.start(); engineOsc2.start();

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { // brown-ish noise
      last = (last + (Math.random() * 2 - 1) * 0.04) * 0.985;
      d[i] = last * 6;
    }
    // pink-ish white noise for the prop (brighter than the brown wind buffer)
    const pinkBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const pd = pinkBuf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < pd.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
      pd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
    propSrc = ctx.createBufferSource(); propSrc.buffer = pinkBuf; propSrc.loop = true;
    propFilter = ctx.createBiquadFilter(); propFilter.type = 'bandpass';
    propFilter.frequency.value = 300; propFilter.Q.value = 0.9;
    propChop = ctx.createGain(); propChop.gain.value = 0.55;
    propGain = ctx.createGain(); propGain.gain.value = 0;
    bladeLfo = ctx.createOscillator(); bladeLfo.type = 'sine'; bladeLfo.frequency.value = 40;
    bladeLfoGain = ctx.createGain(); bladeLfoGain.gain.value = 0.45;
    propSrc.connect(propFilter).connect(propChop).connect(propGain).connect(view);
    bladeLfo.connect(bladeLfoGain).connect(propChop.gain);
    thumpOsc = ctx.createOscillator(); thumpOsc.type = 'triangle'; thumpOsc.frequency.value = 40;
    const thumpLp = ctx.createBiquadFilter(); thumpLp.type = 'lowpass'; thumpLp.frequency.value = 160;
    thumpGain = ctx.createGain(); thumpGain.gain.value = 0;
    thumpOsc.connect(thumpLp).connect(thumpGain).connect(view);
    propSrc.start(); bladeLfo.start(); thumpOsc.start();

    windSrc = ctx.createBufferSource(); windSrc.buffer = noiseBuf; windSrc.loop = true;
    windFilter = ctx.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 600;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(windGain).connect(sfx);
    windSrc.start();

    // jet roar: same noise buffer through a bandpass, centered/gained by spool
    jetRoarSrc = ctx.createBufferSource(); jetRoarSrc.buffer = noiseBuf; jetRoarSrc.loop = true;
    jetRoarFilter = ctx.createBiquadFilter(); jetRoarFilter.type = 'bandpass';
    jetRoarFilter.frequency.value = 180; jetRoarFilter.Q.value = 0.7;
    jetRoarGain = ctx.createGain(); jetRoarGain.gain.value = 0;
    jetRoarSrc.connect(jetRoarFilter).connect(jetRoarGain).connect(view);
    jetRoarSrc.start();

    // turbine whine: pitch tracks spool
    whineOsc = ctx.createOscillator(); whineOsc.type = 'triangle'; whineOsc.frequency.value = 900;
    whineGain = ctx.createGain(); whineGain.gain.value = 0;
    whineOsc.connect(whineGain).connect(view);
    whineOsc.start();

    // afterburner: lowpass rumble with a slow flicker LFO riding on its gain
    abSrc = ctx.createBufferSource(); abSrc.buffer = noiseBuf; abSrc.loop = true;
    abFilter = ctx.createBiquadFilter(); abFilter.type = 'lowpass'; abFilter.frequency.value = 120;
    abGain = ctx.createGain(); abGain.gain.value = 0;
    abLfo = ctx.createOscillator(); abLfo.type = 'sine'; abLfo.frequency.value = 8;
    abLfoGain = ctx.createGain(); abLfoGain.gain.value = 0;
    abSrc.connect(abFilter).connect(abGain).connect(view);
    abLfo.connect(abLfoGain).connect(abGain.gain);
    abSrc.start(); abLfo.start();

    hornOsc = ctx.createOscillator(); hornOsc.type = 'square'; hornOsc.frequency.value = 640;
    hornGain = ctx.createGain(); hornGain.gain.value = 0;
    hornOsc.connect(hornGain).connect(view);
    hornOsc.start();

    // stall buffet: low rumble from the same brown noise
    buffetSrc = ctx.createBufferSource(); buffetSrc.buffer = noiseBuf; buffetSrc.loop = true;
    buffetFilter = ctx.createBiquadFilter(); buffetFilter.type = 'lowpass'; buffetFilter.frequency.value = 110;
    buffetGain = ctx.createGain(); buffetGain.gain.value = 0;
    buffetSrc.connect(buffetFilter).connect(buffetGain).connect(view);
    buffetSrc.start();

    // flap / gear actuator motors: quiet buzzing tones, gated while moving
    flapOsc = ctx.createOscillator(); flapOsc.type = 'sawtooth'; flapOsc.frequency.value = 420;
    const flapBp = ctx.createBiquadFilter(); flapBp.type = 'bandpass'; flapBp.frequency.value = 600; flapBp.Q.value = 2;
    flapGain = ctx.createGain(); flapGain.gain.value = 0;
    flapOsc.connect(flapBp).connect(flapGain).connect(view);
    flapOsc.start();
    gearOsc = ctx.createOscillator(); gearOsc.type = 'sawtooth'; gearOsc.frequency.value = 160;
    const gearBp = ctx.createBiquadFilter(); gearBp.type = 'bandpass'; gearBp.frequency.value = 320; gearBp.Q.value = 1.5;
    gearGain = ctx.createGain(); gearGain.gain.value = 0;
    gearOsc.connect(gearBp).connect(gearGain).connect(view);
    gearOsc.start();

    // rain: the pink buffer through a bright bandpass (hiss) plus a low,
    // lumpy band for drops drumming on the airframe when heard from inside
    brownBuf = noiseBuf;
    rainSrc = ctx.createBufferSource(); rainSrc.buffer = pinkBuf; rainSrc.loop = true;
    rainFilter = ctx.createBiquadFilter(); rainFilter.type = 'bandpass'; rainFilter.frequency.value = 3200; rainFilter.Q.value = 0.4;
    rainGain = ctx.createGain(); rainGain.gain.value = 0;
    drumFilter = ctx.createBiquadFilter(); drumFilter.type = 'bandpass'; drumFilter.frequency.value = 900; drumFilter.Q.value = 0.8;
    drumGain = ctx.createGain(); drumGain.gain.value = 0;
    rainSrc.connect(rainFilter).connect(rainGain).connect(sfx);
    rainSrc.connect(drumFilter).connect(drumGain).connect(sfx);
    rainSrc.start();
    applyRain();

    if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
      ctx.audioWorklet.addModule(new URL('./engineWorklet.js', import.meta.url)).then(() => {
        synth = new AudioWorkletNode(ctx, 'engine-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        synthP = synth.parameters;
        synth.connect(viewFilter);
      }).catch((e) => { console.warn('engine synth unavailable, using the basic engine sound', e); });
    }
  }
  const setP = (name, v, t, tc) => { const a = synthP.get(name); if (tc) a.setTargetAtTime(v, t, tc); else a.setValueAtTime(v, t); };
  function applyRain() {
    if (!ctx) return;
    const t = ctx.currentTime;
    rainGain.gain.setTargetAtTime(rainLevel * (rainCockpit ? 0.09 : 0.22), t, 0.4);
    drumGain.gain.setTargetAtTime(rainLevel * (rainCockpit ? 0.26 : 0.04), t, 0.4);
  }

  return {
    resume() { init(); if (ctx.state === 'suspended') ctx.resume(); },
    // All 0..1 and all safe before init, values are applied when ctx exists.
    // Master is the overall fader; SFX and music trim within it.
    setVolume(v) {
      masterVol = Math.max(0, Math.min(1, v));
      applyMaster();
    },
    setSfxVolume(v) {
      sfxVol = Math.max(0, Math.min(1, v));
      if (sfx) sfx.gain.value = sfxVol;
    },
    setMusicVolume(v) {
      musicVol = Math.max(0, Math.min(1, v));
      if (music) music.gain.value = musicVol;
    },
    // Mute rides on the master gain, so it silences everything at once and
    // restores the previous levels exactly when switched back off.
    setMuted(on) { muted = !!on; applyMaster(); },
    get muted() { return muted; },
    get levels() { return { master: masterVol, sfx: sfxVol, music: musicVol, muted }; },
    /** 'worklet' once the modelled engine runs, 'basic' on the fallback, 'off' before init. */
    get engineVoice() { return !ctx ? 'off' : synth ? 'worklet' : 'basic'; },
    /**
     * Hook for a future music track: connect a source node to the music bus.
     * NOTE nothing calls this yet, the sim ships no music, so the MUSIC
     * slider is wired end-to-end but has no audio to move until one exists.
     */
    connectMusic(node) { if (music && node) node.connect(music); return music; },
    suspend() { if (ctx && ctx.state === 'running') ctx.suspend(); },
    chime() {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 1180;
      g.gain.setValueAtTime(0.35, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      o.connect(g).connect(sfx);
      o.start(); o.stop(ctx.currentTime + 0.55);
      o.frequency.exponentialRampToValueAtTime(1560, ctx.currentTime + 0.1);
    },
    chirp() { // tire squeal on touchdown, scaled by sink rate and sideways slip
      if (!ctx) return;
      const sink = Math.max(0.3, Math.min(1.5, lastSink / 400));
      const side = Math.min(1, lastSide / 8);
      const dur = 0.22 + 0.35 * side;
      const src = ctx.createBufferSource();
      src.buffer = windSrc.buffer;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 950 + 500 * side; f.Q.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.min(0.9, 0.35 * sink * (1 + side)), ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      src.connect(f).connect(g).connect(viewFilter);
      src.start(0, Math.random() * 1.5); src.stop(ctx.currentTime + dur + 0.03);
    },
    /** Rain bed: k 0..1, cockpit = heard through the canopy (drumming). */
    setRain(k, cockpit) {
      const nk = Math.max(0, Math.min(1, k || 0));
      if (Math.abs(nk - rainLevel) < 0.02 && !!cockpit === rainCockpit) return;
      rainLevel = nk; rainCockpit = !!cockpit;
      applyRain();
    },
    /** Thunder after `delay` s (distance / speed of sound); k 0..1 = closeness. */
    thunder(delay, k = 0.6) {
      if (!ctx || !brownBuf) return;
      const t0 = ctx.currentTime + Math.max(0, delay);
      const src = ctx.createBufferSource(); src.buffer = brownBuf; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(260 + 900 * k, t0);
      lp.frequency.exponentialRampToValueAtTime(90, t0 + 4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.setValueAtTime(0.0001, t0);
      // a crack when close, then a long rolling rumble with a few swells
      g.gain.exponentialRampToValueAtTime(0.25 + 0.6 * k * k, t0 + 0.03 + 0.25 * (1 - k));
      let tt = t0 + 0.4;
      for (let i = 0; i < 4; i++) {
        tt += 0.4 + Math.random() * 0.7;
        g.gain.exponentialRampToValueAtTime((0.12 + 0.3 * Math.random()) * (0.4 + 0.6 * k), tt);
      }
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 2.2);
      src.connect(lp).connect(g).connect(sfx);
      src.start(t0, Math.random()); src.stop(tt + 2.4);
    },
    /** A switch / button click in the cockpit. */
    click() {
      if (!ctx || !brownBuf) return;
      const src = ctx.createBufferSource(); src.buffer = brownBuf;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.035);
      src.connect(f).connect(g).connect(sfx);
      src.start(0, Math.random()); src.stop(ctx.currentTime + 0.05);
    },
    /** Master caution (two soft dings) or warning (three sharper ones). */
    caution(warning = false) {
      if (!ctx) return;
      const n = warning ? 3 : 2, f = warning ? 1320 : 880;
      for (let i = 0; i < n; i++) {
        const t0 = ctx.currentTime + i * 0.28;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.24);
        o.connect(g).connect(sfx);
        o.start(t0); o.stop(t0 + 0.26);
      }
    },
    thud() {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = 70;
      g.gain.setValueAtTime(0.6, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      o.connect(g).connect(sfx);
      o.start(); o.stop(ctx.currentTime + 0.4);
    },
    // view = optional { x, y, z, mode }: camera position + CAM mode name. Omitted = cockpit-like.
    update(ac, controls, view) {
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime;
      const engineType = ac.p?.engine?.type ?? 'prop';
      const isJet = engineType === 'jet';
      const spool = ac.spool ?? ac.rpmNorm ?? (0.25 + 0.75 * controls.throttle);
      const alive = !ac.crashed;

      // view stage: Doppler + distance + cockpit muffling
      let external = false, dist = 0;
      if (view && view.mode !== 'COCKPIT') {
        const dx = ac.pos.x - view.x, dy = ac.pos.y - view.y, dz = ac.pos.z - view.z;
        dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        external = true;
        const dt = t - camT;
        if (camT >= 0 && dt > 0.001) { // camera velocity from frame deltas (scalars, no allocation)
          const k = Math.min(1, dt * 12);
          camVX += ((view.x - camPX) / dt - camVX) * k;
          camVY += ((view.y - camPY) / dt - camVY) * k;
          camVZ += ((view.z - camPZ) / dt - camVZ) * k;
        }
        camPX = view.x; camPY = view.y; camPZ = view.z; camT = t;
        if (dist > 1) {
          const inv = 1 / dist; // unit vector camera -> aircraft
          const vs = (ac.vel.x * dx + ac.vel.y * dy + ac.vel.z * dz) * inv;  // + = receding
          const vl = (camVX * dx + camVY * dy + camVZ * dz) * inv;           // + = camera closing
          const target = Math.max(0.7, Math.min(1.4, (SOUND_C + vl) / (SOUND_C + vs)));
          dop += (target - dop) * 0.25;
        }
      } else {
        camT = -1; camVX = camVY = camVZ = 0;
        dop += (1 - dop) * 0.25;
      }
      const vGain = external ? Math.max(0.05, 1 / (1 + Math.max(0, dist - 40) / 150)) : 1;
      const vCut = external ? Math.max(1500, 14000 / (1 + dist / 400)) : 2200;
      viewGain.gain.setTargetAtTime(vGain, t, 0.08);
      viewFilter.frequency.setTargetAtTime(vCut, t, 0.1);

      // prop path: oscillators keep running, gain drops to 0 when jet. The saw/square
      // pair is turned down; the organic layer (blade-pass chop + firing thump) carries it.
      const f = (42 + 88 * ac.rpmNorm) * dop;
      engineOsc.frequency.setTargetAtTime(f, t, 0.08);
      engineOsc2.frequency.setTargetAtTime(f * 0.5 + 1.5, t, 0.08);
      engineFilter.frequency.setTargetAtTime(320 + 900 * controls.throttle, t, 0.1);
      // physically modelled engine: once it is running the basic layers mute
      if (synth) {
        const cfg = engineSound(ac.p?.id, engineType);
        if (synthId !== cfg) { synthId = cfg; synth.port.postMessage({ cfg }); }
        const running = alive && ac.engineRunning !== false && !ac.engineFailed;
        // fore/aft directivity: body +x in world dotted with aircraft -> camera
        let front = 0;
        if (external && dist > 1 && ac.q) {
          const q = ac.q;
          const fx = 1 - 2 * (q.y * q.y + q.z * q.z), fy = 2 * (q.x * q.y + q.w * q.z), fz = 2 * (q.x * q.z - q.w * q.y);
          front = -(fx * (ac.pos.x - view.x) + fy * (ac.pos.y - view.y) + fz * (ac.pos.z - view.z)) / dist;
        }
        setP('alive', running ? 1 : 0, t);
        setP('crank', !ac.crashed && (ac.crankT || 0) > 0 ? 1 : 0, t);
        setP('dop', dop, t);
        setP('cockpit', external ? 0 : 1, t);
        setP('front', front, t);
        if (isJet) {
          const n1 = running ? 0.22 + 0.78 * spool : (alive ? Math.min(0.12, (ac.airspeed || 0) / 600) : 0);
          setP('n1', n1, t);
          setP('ab', running && ac.abOn ? 1 : 0, t);
        } else {
          setP('rpm', (ac.rpmNorm || 0) * cfg.rpmMax, t);
          setP('load', running ? Math.max(0, Math.min(1, ac.spool ?? controls.throttle)) : 0, t);
          setP('ab', 0, t);
        }
        setP('gain', alive ? 1 : 0, t, 0.05);
        setP('misfire', ac.systems?.power === false || (ac.carbIce || 0) > 0.35 || ac.mixRough || ac.plugRough || ac.cylRough ? 1 : 0, t);   // rough: failure, carb ice, too lean, fouled plugs on one mag or a worn cylinder
      }
      const legacy = !synth;
      const propOn = legacy && alive && !isJet;
      engineGain.gain.setTargetAtTime(propOn ? 0.02 + 0.07 * controls.throttle : 0, t, 0.1);
      const rpm = 700 + 2000 * ac.rpmNorm;
      const blades = ac.p?.engine?.blades ?? 2;
      const cyl = ac.p?.engine?.cylinders ?? 4;
      bladeLfo.frequency.setTargetAtTime(rpm * blades / 60 * dop, t, 0.06);
      thumpOsc.frequency.setTargetAtTime(Math.max(18, rpm * cyl / 120 * dop), t, 0.06);
      propFilter.frequency.setTargetAtTime((220 + 650 * ac.rpmNorm + 300 * controls.throttle) * dop, t, 0.1);
      propGain.gain.setTargetAtTime(propOn ? 0.10 + 0.34 * controls.throttle : 0, t, 0.1);
      thumpGain.gain.setTargetAtTime(propOn ? 0.05 + 0.10 * controls.throttle : 0, t, 0.1);

      // jet path: bandpass roar + turbine whine + afterburner; silent unless jet
      const jetOn = legacy && alive && isJet;
      jetRoarFilter.frequency.setTargetAtTime((180 + 720 * spool) * dop, t, 0.1);
      jetRoarGain.gain.setTargetAtTime(jetOn ? 0.05 + 0.30 * spool : 0, t, 0.12);
      whineOsc.frequency.setTargetAtTime((900 + 1700 * spool) * dop, t, 0.08);
      whineGain.gain.setTargetAtTime(jetOn ? 0.04 : 0, t, 0.1);
      const abOn = jetOn && !!ac.abOn;
      abGain.gain.setTargetAtTime(abOn ? 0.25 : 0, t, 0.15);
      abLfoGain.gain.setTargetAtTime(abOn ? 0.05 : 0, t, 0.15);

      // stall buffet: ramps in as the alpha margin closes, full when stalled
      let buf = 0;
      if (alive && !ac.onGround && ac.airspeed > 15) {
        buf = ac.stalled ? 1 : (ac.alphaMargin != null ? Math.max(0, Math.min(1, 1 - ac.alphaMargin / 0.07)) * 0.7 : 0);
      }
      buffetGain.gain.setTargetAtTime(buf * 0.45, t, 0.08);
      buffetFilter.frequency.setTargetAtTime(70 + 90 * buf, t, 0.1);

      // actuator motors: run while the setting is changing (plus a short tail)
      const fl = controls.flaps ?? 0;
      if (lastFlaps !== null && Math.abs(fl - lastFlaps) > 1e-4) {
        flapUntil = t + 0.3;
        flapOsc.frequency.setTargetAtTime((fl > lastFlaps ? 440 : 380) * dop, t, 0.03);
      }
      lastFlaps = fl;
      flapGain.gain.setTargetAtTime(alive && t < flapUntil ? 0.035 : 0, t, 0.04);
      const gp = typeof ac.gearPos === 'number' ? ac.gearPos : null; // only if a retract state exists
      if (gp !== null) {
        if (lastGear !== null && Math.abs(gp - lastGear) > 1e-4) gearUntil = t + 0.3;
        lastGear = gp;
      }
      gearGain.gain.setTargetAtTime(alive && t < gearUntil ? 0.05 : 0, t, 0.05);

      // remember touchdown severity for chirp() (modes.js calls it on contact)
      if (ac.touchdown) {
        lastSink = ac.touchdown.fpm ?? 0;
        lastSide = Math.abs(ac.beta ?? 0) * ac.airspeed;
      }

      const wind = Math.min(1, (ac.airspeed / 75) ** 2);
      windGain.gain.setTargetAtTime(wind * (external ? 0.25 : 0.5), t, 0.15);
      windFilter.frequency.setTargetAtTime(400 + 1400 * wind, t, 0.15);
      hornGain.gain.setTargetAtTime(ac.stalled ? 0.12 : 0, t, 0.05);
    },
  };
}
