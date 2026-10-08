// WebAudio: engine (prop: noise through a bandpass chopped at blade-pass rate
// plus a firing thump; jet: roar + whine), wind rush keyed to airspeed, stall
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
  // per-frame scratch (plain numbers, no allocation)
  let camPX = 0, camPY = 0, camPZ = 0, camT = -1, camVX = 0, camVY = 0, camVZ = 0;
  let dop = 1, lastFlaps = null, lastGear = null, flapUntil = 0, gearUntil = 0;
  let lastSink = 0, lastSide = 0;
  const SOUND_C = 340;

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
      const propOn = alive && !isJet;
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
      const jetOn = alive && isJet;
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
