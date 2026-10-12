// Instant replay: a flight recorder plus a cinematic camera director.
//
// Recording: while flying, main.js hands every frame to record(); the state is
// sampled at 30 Hz of SIM time into one preallocated Float32Array ring (the
// last 150 s), so recording never allocates and costs a few dozen float writes.
//
// Playback fills a "ghost" — an object shaped like the live aircraft (pos, q,
// vel, airspeed, onGround, rpmNorm, ...) — by interpolating between samples.
// main.js renders the mesh, terrain, shadows, weather and engine audio from the
// ghost instead of the physics state, which is never touched, so closing the
// replay drops you back exactly where you paused.
//
// Cameras: CHASE, TOWER (a telephoto observer on the ground ahead of the
// flight path), FLYBY (a spot the aircraft passes close to), ONBOARD (over
// the tail or on the wing, banking with the airframe), ORBIT, and AUTO, a
// director that cuts between them every few seconds.
//
// Touchdowns and the crash are replayed as events (dust, tyre chirp, debris)
// when the playhead crosses them.

import * as THREE from 'three';

// ------------------------------------------------------- recorder (pure) --
const HZ = 30;
const SECONDS = 150;
const N = HZ * SECONDS;
// t, pos3, q4, vel3, elev, ail, rud, thr, flaps, rpm, spool, onGround, gs,
// airspeed, flapsEff, agl, gLoad, abOn, crashed
const S = 26;

export function createRecorder() {
  const buf = new Float32Array(N * S);
  let head = 0, count = 0, simT = 0, nextT = 0;
  const idx = (i) => ((head - count + i) % N + N) % N;   // logical i -> ring slot
  function write(ac, c) {
    const o = head * S;
    buf[o] = simT;
    buf[o + 1] = ac.pos.x; buf[o + 2] = ac.pos.y; buf[o + 3] = ac.pos.z;
    buf[o + 4] = ac.q.x; buf[o + 5] = ac.q.y; buf[o + 6] = ac.q.z; buf[o + 7] = ac.q.w;
    buf[o + 8] = ac.vel.x; buf[o + 9] = ac.vel.y; buf[o + 10] = ac.vel.z;
    buf[o + 11] = c.elevator || 0; buf[o + 12] = c.aileron || 0; buf[o + 13] = c.rudder || 0;
    buf[o + 14] = c.throttle || 0; buf[o + 15] = c.flaps || 0;
    buf[o + 16] = ac.rpmNorm || 0; buf[o + 17] = ac.spool ?? ac.rpmNorm ?? 0;
    buf[o + 18] = ac.onGround ? 1 : 0; buf[o + 19] = ac.groundSpeed || 0;
    buf[o + 20] = ac.airspeed || 0; buf[o + 21] = ac.flapsEff ?? c.flaps ?? 0;
    buf[o + 22] = ac.agl ?? 100; buf[o + 23] = ac.gLoad ?? 1;
    buf[o + 24] = ac.abOn ? 1 : 0; buf[o + 25] = ac.crashed ? 1 : 0;
    head = (head + 1) % N;
    count = Math.min(N, count + 1);
  }
  return {
    /** Advance sim time by dt and sample at 30 Hz. */
    record(dt, ac, c) {
      simT += dt;
      if (count === 0 || simT >= nextT) {
        write(ac, c);
        nextT = simT + 1 / HZ;
      }
    },
    clear() { head = 0; count = 0; simT = 0; nextT = 0; },
    get count() { return count; },
    get start() { return count ? buf[idx(0) * S] : 0; },
    get end() { return count ? buf[idx(count - 1) * S] : 0; },
    get duration() { return count > 1 ? buf[idx(count - 1) * S] - buf[idx(0) * S] : 0; },
    /** Raw field f of logical sample i. */
    field(i, f) { return buf[idx(i) * S + f]; },
    /** Logical index of the last sample at or before time t (binary search). */
    find(t) {
      let lo = 0, hi = count - 1;
      if (count === 0 || t <= buf[idx(0) * S]) return 0;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (buf[idx(mid) * S] <= t) lo = mid; else hi = mid - 1;
      }
      return lo;
    },
    /**
     * Interpolated state at time t into `g` (ghost) and `gc` (controls).
     * Quaternions are nlerped along the shorter arc.
     */
    sample(t, g, gc) {
      if (!count) return;
      const i = this.find(t), j = Math.min(count - 1, i + 1);
      const a = idx(i) * S, b = idx(j) * S;
      const ta = buf[a], tb = buf[b];
      const k = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 0;
      const L = (f) => buf[a + f] + (buf[b + f] - buf[a + f]) * k;
      g.pos.x = L(1); g.pos.y = L(2); g.pos.z = L(3);
      let s = 1;
      if (buf[a + 4] * buf[b + 4] + buf[a + 5] * buf[b + 5] + buf[a + 6] * buf[b + 6] + buf[a + 7] * buf[b + 7] < 0) s = -1;
      let qx = buf[a + 4] + (s * buf[b + 4] - buf[a + 4]) * k, qy = buf[a + 5] + (s * buf[b + 5] - buf[a + 5]) * k;
      let qz = buf[a + 6] + (s * buf[b + 6] - buf[a + 6]) * k, qw = buf[a + 7] + (s * buf[b + 7] - buf[a + 7]) * k;
      const n = Math.hypot(qx, qy, qz, qw) || 1;
      g.q.x = qx / n; g.q.y = qy / n; g.q.z = qz / n; g.q.w = qw / n;
      g.vel.x = L(8); g.vel.y = L(9); g.vel.z = L(10);
      gc.elevator = L(11); gc.aileron = L(12); gc.rudder = L(13); gc.throttle = L(14); gc.flaps = L(15);
      g.rpmNorm = L(16); g.spool = L(17);
      g.onGround = buf[(k < 0.5 ? a : b) + 18] > 0.5;
      g.groundSpeed = L(19); g.airspeed = L(20); g.flapsEff = L(21); g.agl = L(22); g.gLoad = L(23);
      g.abOn = buf[a + 24] > 0.5; g.crashed = false;
    },
  };
}

// ------------------------------------------------------------- director --
export const REPLAY_CAMS = ['AUTO', 'CHASE', 'TOWER', 'FLYBY', 'ONBOARD', 'ORBIT'];

const STYLE_ID = 'replay-style';
const CSS = `
  #replay-bars { position: fixed; inset: 0; pointer-events: none; z-index: 30; display: none; }
  #replay-bars::before, #replay-bars::after { content: ''; position: absolute; left: 0; right: 0; height: 8vh;
    background: #000; }
  #replay-bars::before { top: 0; } #replay-bars::after { bottom: 0; }
  #replay-ui { position: fixed; left: 50%; bottom: 1.2vh; transform: translateX(-50%); z-index: 31; display: none;
    width: min(46rem, calc(100vw - 32px)); font-family: "B612 Mono", ui-monospace, monospace; color: var(--ink, #e8edf2);
    background: rgba(16,21,26,0.72); border: 1px solid rgba(232,237,242,0.28); padding: .55rem .9rem .6rem; }
  #replay-ui .row { display: flex; align-items: center; gap: .9rem; font-size: .8rem; }
  #replay-ui .rec { color: #ff453a; font-weight: 700; letter-spacing: .18em; }
  #replay-ui .rec i { display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; background: #ff453a;
    margin-right: .45rem; animation: rp-blink 1s steps(1) infinite; vertical-align: baseline; }
  #replay-ui .rec.paused i { animation: none; opacity: .4; }
  @keyframes rp-blink { 50% { opacity: .2; } }
  #replay-ui .grow { flex: 1; }
  #replay-ui .lbl { color: var(--ink-dim, #9aa7b2); font-size: .62rem; letter-spacing: .16em; }
  #replay-ui .val { font-weight: 700; }
  #replay-ui .amber { color: var(--amber, #ffb300); }
  #replay-ui .track { position: relative; height: .5rem; margin: .5rem 0 .4rem; background: rgba(232,237,242,.12);
    cursor: pointer; pointer-events: auto; }
  #replay-ui .track b { position: absolute; left: 0; top: 0; bottom: 0; background: var(--amber, #ffb300); }
  #replay-ui .track .ev { position: absolute; top: -.2rem; width: 2px; height: .9rem; background: #e8edf2; opacity: .7; }
  #replay-ui .track .ev.crash { background: #ff453a; opacity: 1; }
  #replay-ui .keys { font-size: .62rem; color: var(--ink-dim, #9aa7b2); letter-spacing: .06em; }
  #replay-ui .keys b { color: var(--ink, #e8edf2); font-weight: 400; }
  @media (max-width: 600px) { #replay-ui .keys { display: none; } }
  body.replaying #minimap, body.replaying #ap-sixpack, body.replaying #hud, body.replaying #instructor { visibility: hidden; }
`;

const SPEEDS = [0.25, 0.5, 1, 2];
const fmt = (s) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};

/**
 * @param {object} o
 * @param {THREE.PerspectiveCamera} o.camera
 * @param {(x:number, z:number) => number} o.ground  collision height
 * @param {object} [o.events] { touchdown(ghost), crash(ghost) } replayed one-shots
 */
export function createReplay({ camera, ground, events = {} }) {
  const rec = createRecorder();
  const ghost = {
    pos: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 }, airspeed: 0, groundSpeed: 0, onGround: true, rpmNorm: 0, spool: 0,
    flapsEff: 0, agl: 0, gLoad: 1, alpha: 0, alphaMargin: 1, beta: 0, stalled: false, touchdown: null,
    abOn: false, crashed: false, p: null, eas: 0, gearPos: 0,
  };
  const gc = { elevator: 0, aileron: 0, rudder: 0, throttle: 0, flaps: 0, brakes: false, trim: 0 };
  let active = false, t = 0, speed = 1, playing = true, camIdx = 0, clean = false;
  let shot = 'CHASE', shotT = 0, shotLen = 5, lastShot = '';
  let groundFn = ground;
  let wasGround = true, wasCrashT = -1, crashAt = -1;
  const spot = new THREE.Vector3(), camPos = new THREE.Vector3(), look = new THREE.Vector3();
  const qv = new THREE.Quaternion(), fwd = new THREE.Vector3(), up = new THREE.Vector3(), lat = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let orbitA = 0, onboardSide = 0, fovNow = 55;

  // ---- DOM
  let ui = null, bars = null, els = {};
  function mountUI() {
    if (ui || typeof document === 'undefined') return;
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style'); st.id = STYLE_ID; st.textContent = CSS; document.head.appendChild(st);
    }
    bars = document.createElement('div'); bars.id = 'replay-bars';
    ui = document.createElement('div'); ui.id = 'replay-ui';
    ui.innerHTML = `
      <div class="row">
        <span class="rec" id="rp-rec"><i></i>REPLAY</span>
        <span class="grow"></span>
        <span><span class="lbl">TIME </span><span class="val" id="rp-time">0:00.0</span><span class="lbl"> / </span><span id="rp-dur">0:00.0</span></span>
        <span><span class="lbl">SPEED </span><span class="val amber" id="rp-speed">1×</span></span>
        <span><span class="lbl">CAM </span><span class="val amber" id="rp-cam">AUTO</span></span>
      </div>
      <div class="track" id="rp-track"><b id="rp-prog"></b></div>
      <div class="keys"><b>SPACE</b> play/pause · <b>← →</b> ±5 s · <b>↑ ↓</b> speed · <b>C</b>/<b>1-6</b> camera · <b>H</b> hide · <b>X</b>/<b>ESC</b> exit</div>`;
    document.body.append(bars, ui);
    for (const id of ['rec', 'time', 'dur', 'speed', 'cam', 'track', 'prog']) els[id] = ui.querySelector('#rp-' + id);
    els.track.addEventListener('click', (e) => {
      const r = els.track.getBoundingClientRect();
      seek(rec.start + (e.clientX - r.left) / r.width * rec.duration);
    });
  }
  function paintEvents() {
    els.track.querySelectorAll('.ev').forEach(e => e.remove());
    const d = rec.duration || 1;
    let prevG = rec.field(0, 18) > 0.5;
    for (let i = 1; i < rec.count; i++) {
      const g = rec.field(i, 18) > 0.5, cr = rec.field(i, 25) > 0.5;
      const at = (rec.field(i, 0) - rec.start) / d * 100;
      if (cr && rec.field(i - 1, 25) < 0.5) { const m = document.createElement('span'); m.className = 'ev crash'; m.style.left = at + '%'; els.track.appendChild(m); }
      else if (g && !prevG) { const m = document.createElement('span'); m.className = 'ev'; m.style.left = at + '%'; els.track.appendChild(m); }
      prevG = g;
    }
  }
  function paintUI() {
    if (!ui) return;
    els.time.textContent = fmt(t - rec.start);
    els.dur.textContent = fmt(rec.duration);
    els.speed.textContent = `${speed}×`;
    els.cam.textContent = REPLAY_CAMS[camIdx] === 'AUTO' ? `AUTO · ${shot}` : shot;
    els.prog.style.width = `${rec.duration ? (t - rec.start) / rec.duration * 100 : 0}%`;
    els.rec.classList.toggle('paused', !playing);
  }

  function seek(nt) {
    t = Math.max(rec.start, Math.min(rec.end, nt));
    rec.sample(t, ghost, gc);
    wasGround = ghost.onGround;
    cut(shot);    // re-frame after a jump
  }

  // ---- keys (capture phase, so flight controls never see them)
  function onKey(e) {
    if (!active) return;
    const k = e.key;
    let used = true;
    if (k === ' ') playing = !playing;
    else if (k === 'ArrowLeft') seek(t - 5);
    else if (k === 'ArrowRight') seek(t + 5);
    else if (k === 'ArrowUp') speed = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)];
    else if (k === 'ArrowDown') speed = SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)];
    else if (k >= '1' && k <= '6') setCam(+k - 1);
    else if (k === 'h' || k === 'H') {                 // photo mode: clean frame
      clean = !clean;
      ui.style.display = clean ? 'none' : 'block';
      bars.style.display = clean ? 'none' : 'block';
    }
    else used = false;
    if (used) { e.preventDefault(); e.stopImmediatePropagation(); paintUI(); }
  }
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);

  // ---- camera director
  const span = () => Math.max(8, ghost.p?.span || 11);
  function basis() {
    qv.set(ghost.q.x, ghost.q.y, ghost.q.z, ghost.q.w);
    fwd.set(ghost.vel.x, ghost.vel.y * 0.3, ghost.vel.z);
    if (fwd.lengthSq() < 4) fwd.set(1, 0, 0).applyQuaternion(qv);
    fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
    fwd.normalize();
    lat.set(-fwd.z, 0, fwd.x);
  }
  function groundAt(x, z) { return groundFn ? groundFn(x, z) : 0; }
  function cut(name) {
    shot = name; shotT = 0;
    const s = span(), spd = Math.hypot(ghost.vel.x, ghost.vel.y, ghost.vel.z);
    basis();
    const P = ghost.pos;
    const side = Math.random() < 0.5 ? -1 : 1;
    if (name === 'TOWER') {
      const ahead = spd * (3 + Math.random() * 3) + s * 6;
      spot.set(P.x + fwd.x * ahead + lat.x * side * (s * 10 + 60), 0, P.z + fwd.z * ahead + lat.z * side * (s * 10 + 60));
      spot.y = Math.max(groundAt(spot.x, spot.z), 0) + 2 + Math.random() * 14;
      if (P.y - spot.y > 600) spot.y = P.y - 400;         // no observer on the deck under a cruise
      shotLen = 5 + Math.random() * 2;
    } else if (name === 'FLYBY') {
      const ahead = spd * 2.6 + s * 3;
      spot.set(P.x + fwd.x * ahead + lat.x * side * s * 1.4, P.y + s * (0.25 + Math.random() * 0.4), P.z + fwd.z * ahead + lat.z * side * s * 1.4);
      spot.y = Math.max(spot.y, groundAt(spot.x, spot.z) + 1.5);
      shotLen = 4.5;
    } else if (name === 'ONBOARD') {
      onboardSide = Math.random() < 0.55 ? 0 : side;
      shotLen = 5 + Math.random() * 2;
    } else if (name === 'ORBIT') {
      orbitA = Math.atan2(-fwd.z, -fwd.x) + (Math.random() - 0.5);
      shotLen = 6;
    } else {
      camPos.set(P.x - fwd.x * s * 1.4, P.y + s * 0.4, P.z - fwd.z * s * 1.4);
      shotLen = 5;
    }
    lastShot = name;
  }
  function pickShot() {
    const pool = ['CHASE', 'TOWER', 'FLYBY', 'ONBOARD', 'ORBIT'].filter(n => n !== lastShot);
    // a parked/taxiing aircraft is dull from a tower 500 m away
    const slow = ghost.groundSpeed < 8 && ghost.onGround;
    const p = slow ? pool.filter(n => n !== 'TOWER' && n !== 'FLYBY') : pool;
    cut(p[Math.floor(Math.random() * p.length)] || 'CHASE');
  }
  function setCam(i) {
    camIdx = ((i % REPLAY_CAMS.length) + REPLAY_CAMS.length) % REPLAY_CAMS.length;
    const name = REPLAY_CAMS[camIdx];
    if (name === 'AUTO') pickShot(); else cut(name);
    paintUI();
  }
  function updateCamera(dt) {
    const s = span(), P = ghost.pos;
    shotT += dt;
    basis();
    let fov = 55;
    camera.up.set(0, 1, 0);
    if (shot === 'CHASE') {
      tmp.set(P.x - fwd.x * s * 1.35, P.y + s * 0.33, P.z - fwd.z * s * 1.35);
      camPos.lerp(tmp, 1 - Math.exp(-dt * 3.5));
      camera.position.copy(camPos);
      look.set(P.x + fwd.x * s * 0.6, P.y, P.z + fwd.z * s * 0.6);
    } else if (shot === 'TOWER') {
      camera.position.copy(spot);
      look.set(P.x, P.y, P.z);
      const d = camera.position.distanceTo(look);
      fov = THREE.MathUtils.clamp(2 * Math.atan(s * 1.5 / d) * 180 / Math.PI, 3, 50);
      if (REPLAY_CAMS[camIdx] !== 'AUTO' && d > 2600) cut('TOWER');
    } else if (shot === 'FLYBY') {
      camera.position.copy(spot);
      look.set(P.x, P.y, P.z);
      const d = camera.position.distanceTo(look);
      fov = THREE.MathUtils.clamp(2 * Math.atan(s * 2.2 / d) * 180 / Math.PI, 18, 60);
      if (REPLAY_CAMS[camIdx] !== 'AUTO' && d > s * 40 && shotT > 3) cut('FLYBY');
    } else if (shot === 'ONBOARD') {
      qv.set(ghost.q.x, ghost.q.y, ghost.q.z, ghost.q.w);
      if (onboardSide === 0) tmp.set(-s * 0.62, s * 0.2, 0);                // over the tail
      else tmp.set(-s * 0.1, s * 0.22, onboardSide * s * 0.45);            // above the wingtip, looking at the nose
      camera.position.copy(tmp.applyQuaternion(qv)).add(P);
      if (onboardSide === 0) look.set(s * 2.5, -s * 0.05, 0);
      else look.set(s * 0.45, -s * 0.02, 0);
      look.applyQuaternion(qv).add(P);
      up.set(0, 1, 0).applyQuaternion(qv);
      camera.up.copy(up);
      fov = onboardSide === 0 ? 62 : 58;
    } else if (shot === 'ORBIT') {
      orbitA += dt * 0.22;
      const r = s * 2.1;
      camera.position.set(P.x + Math.cos(orbitA) * r, P.y + s * 0.35, P.z + Math.sin(orbitA) * r);
      look.set(P.x, P.y, P.z);
      fov = 50;
    }
    // never underground
    const gy = groundAt(camera.position.x, camera.position.z);
    if (camera.position.y < gy + 1.2) camera.position.y = gy + 1.2;
    camera.lookAt(look);
    fovNow += (fov - fovNow) * (shot === 'TOWER' || shot === 'FLYBY' ? 1 : 1 - Math.exp(-dt * 4));
    camera.fov = fovNow;
    camera.updateProjectionMatrix();
    if (REPLAY_CAMS[camIdx] === 'AUTO' && shotT > shotLen) pickShot();
  }

  return {
    get active() { return active; },
    get ghost() { return ghost; },
    get controls() { return gc; },
    get time() { return t - rec.start; },
    get duration() { return rec.duration; },
    get shot() { return shot; },
    get camName() { return REPLAY_CAMS[camIdx]; },
    get speed() { return speed; },
    get playing() { return playing; },
    recorder: rec,
    setGround(fn) { groundFn = fn; },
    /** Record the live aircraft (call every frame while flying). */
    record(dt, ac, c) { rec.record(dt, ac, c); },
    clear() { rec.clear(); },
    available() { return rec.count > 3 && rec.duration >= 1; },
    /** Start playback: from `back` seconds before the end (default 30). */
    open(ac, back = 30) {
      if (!this.available()) return false;
      mountUI();
      ghost.p = ac.p;
      active = true; playing = true; speed = 1;
      crashAt = -1;
      for (let i = 0; i < rec.count; i++) if (rec.field(i, 25) > 0.5) { crashAt = rec.field(i, 0); break; }
      // a crash replay starts a little before the impact and ends on it
      const endT = crashAt > 0 ? crashAt + 1.5 : rec.end;
      seek(Math.max(rec.start, endT - back));
      wasCrashT = -1;
      fovNow = camera.fov;
      setCam(camIdx);
      paintEvents();
      clean = false;
      bars.style.display = ui.style.display = 'block';
      document.body.classList.add('replaying');
      paintUI();
      return true;
    },
    close() {
      if (!active) return;
      active = false;
      if (ui) bars.style.display = ui.style.display = 'none';
      document.body.classList.remove('replaying');
      camera.up.set(0, 1, 0);
    },
    nextCam() { setCam(camIdx + 1); },
    setCam,
    seek(sec) { seek(rec.start + sec); paintUI(); },
    setSpeed(v) { if (SPEEDS.includes(v)) speed = v; paintUI(); },
    togglePlay() { playing = !playing; paintUI(); },
    /** Advance playback + camera; fires replayed touchdown/crash events. */
    update(dt) {
      if (!active) return;
      if (playing) {
        const endT = crashAt > 0 ? Math.min(rec.end, crashAt + 1.5) : rec.end;
        t += dt * speed;
        if (t >= endT) { t = Math.max(rec.start, endT - Math.min(30, rec.duration)); wasGround = true; wasCrashT = -1; }
      }
      rec.sample(t, ghost, gc);
      if (playing) {
        if (ghost.onGround && !wasGround) events.touchdown?.(ghost);
        if (crashAt > 0 && t >= crashAt && wasCrashT < 0) { wasCrashT = t; events.crash?.(ghost); }
      }
      wasGround = ghost.onGround;
      updateCamera(dt);
      paintUI();
    },
  };
}
