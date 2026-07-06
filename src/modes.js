// Game flow: menu (mode/map/aircraft selection) / free flight / ring race /
// pause / crash / results. World swapping is delegated to main.js via `world`.

import { resetOnRunway } from './physics/flightModel.js';

const $ = (s) => document.querySelector(s);
const SEL_KEY = 'archipelago.sel';
const bestKey = (map, aircraft) => `archipelago.best.${map}.${aircraft}`;

const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

const MODES = [
  { id: 'free', label: 'FREE FLIGHT', hint: 'explore, land anywhere' },
  { id: 'race', label: 'RING RACE', hint: '12 gates against the clock' },
  { id: 'training', label: 'FLIGHT SCHOOL', hint: 'learn to fly — 7 lessons' },
];

const CRASH_TEXT = {
  'hard impact': ['HARD IMPACT.', 'That arrival exceeded the landing gear’s enthusiasm.'],
  'prop strike': ['PROP STRIKE.', 'The propeller met the ground. The ground won.'],
  'wing strike': ['WING STRIKE.', 'A wingtip caught the ground mid-manoeuvre.'],
  'tail strike': ['TAIL STRIKE.', 'Rotated a little too eagerly.'],
  'terrain impact': ['TERRAIN.', 'Controlled flight into terrain — the classic.'],
  'numerical': ['DEPARTED FLIGHT.', 'The airflow gave up entirely.'],
};

export function createGameFlow({ ac, hud, audio, controls, camRig, world, fx }) {
  let crashT = null; // delay before the crash screen so the debris burst reads
  let state = 'menu';           // menu | flying | paused | crash | results
  let sel = { mode: 'free', map: 'archipelago', aircraft: 'c172' };
  try { sel = { ...sel, ...JSON.parse(localStorage.getItem(SEL_KEY) || '{}') }; } catch { /* fresh defaults */ }
  let map = null, rings = null;  // live handles, set by begin()
  let raceT = 0, raceStarted = false, raceDone = false;
  let trainer = null, lessonId = null;
  const instrEl = $('#instructor');

  const screens = { menu: $('#menu'), pause: $('#pause'), crash: $('#crash'), results: $('#results'), lessons: $('#lessons') };
  const showScreen = (name) => {
    for (const [k, el] of Object.entries(screens)) el.classList.toggle('show', k === name);
    hud.show(name === null);
  };

  const getBest = () => {
    const v = parseFloat(localStorage.getItem(bestKey(sel.map, sel.aircraft)));
    if (Number.isFinite(v)) return v;
    if (sel.map === 'archipelago' && sel.aircraft === 'c172') {
      const legacy = parseFloat(localStorage.getItem('archipelago.best'));
      if (Number.isFinite(legacy)) return legacy;
    }
    return null;
  };
  const setBest = (t) => localStorage.setItem(bestKey(sel.map, sel.aircraft), String(t));

  function updateMenuLabels() {
    const mode = MODES.find(m => m.id === sel.mode) || MODES[0];
    $('#sel-mode').textContent = mode.label;
    const best = getBest();
    $('#sel-mode-hint').textContent = sel.mode === 'race' && best ? `${mode.hint} · best ${fmtTime(best)}` : mode.hint;
    $('#sel-map').textContent = (world.maps.find(m => m.id === sel.map) || world.maps[0]).name;
    const craft = world.aircraft.find(a => a.id === sel.aircraft) || world.aircraft[0];
    $('#sel-aircraft').textContent = craft.params.name.toUpperCase();
    $('#sel-aircraft-hint').textContent = craft.tagline;
    localStorage.setItem(SEL_KEY, JSON.stringify(sel));
  }

  function cycle(kind) {
    const lists = { mode: MODES.map(m => m.id), map: world.maps.map(m => m.id), aircraft: world.aircraft.map(a => a.id) };
    const list = lists[kind];
    const cur = list.indexOf(sel[kind]);
    sel[kind] = list[(cur + 1) % list.length];
    updateMenuLabels();
  }

  function resetFlight() {
    const r = map.runway;
    resetOnRunway(ac, { x: r.spawn.x, z: r.spawn.z, y: r.y, headingRad: r.headingRad });
    controls.resetFlaps();
    camRig.reset();
    rings.reset();
    raceT = 0; raceStarted = false; raceDone = false;
    crashT = null;
    hud.clearMessage();
  }

  async function begin() {
    if (sel.mode === 'training') { openLessons(); return; }
    lessonId = null;
    ({ map, rings } = await world.apply(sel));
    resetFlight();
    rings.show(sel.mode === 'race');
    hud.race(sel.mode === 'race');
    state = 'flying';
    showScreen(null);
    audio.resume();
    const rwy = map.runway.name;
    hud.message(sel.mode === 'race'
      ? `Clock starts when you roll. ${rings.total} gates, then land back on runway ${rwy}.`
      : `Runway ${rwy} — full throttle <b>W</b>, rotate with <b>&uarr;</b>.`, 5200);
  }

  // ---- flight school ----
  const ui = {
    instruct(html) { instrEl.querySelector('.text').innerHTML = html; instrEl.classList.add('show'); },
    progress(i, n) {
      instrEl.querySelector('.steps').innerHTML =
        Array.from({ length: n }, (_, k) =>
          `<i class="${k < i ? 'done' : k === i ? 'cur' : ''}"></i>`).join('');
    },
    setPapi(d) { hud.setPapi(d); },
    setSlip(b) { hud.setSlip(b); },
    lessonComplete(passed, summaryHtml) {
      instrEl.querySelector('.text').innerHTML = summaryHtml;
      instrEl.querySelector('.steps').innerHTML = '';
      hud.setPapi(null); hud.setSlip(null);
      hud.message(passed ? 'Lesson passed &#10003; &nbsp;<b>ESC</b> for menu, <b>R</b> to refly' : 'Not this time — <b>R</b> to retry', 6000);
      if (passed) audio.chime();
    },
  };

  function openLessons() {
    trainer = world.createTrainer(ui);
    const progress = trainer.loadProgress();
    $('#lesson-list').innerHTML = trainer.lessons.map((l, i) =>
      `<button class="btn" data-lesson="${l.id}"><span class="no">${String(i + 1).padStart(2, '0')}</span>
       ${l.title.toUpperCase()} ${progress[l.id] ? '<span style="color:var(--good)">&#10003;</span>' : ''}
       <span class="hint">${l.blurb}</span></button>`).join('');
    $('#lesson-list').querySelectorAll('[data-lesson]').forEach(b =>
      b.addEventListener('click', () => beginLesson(b.dataset.lesson)));
    state = 'menu';
    showScreen('lessons');
  }

  async function beginLesson(id) {
    lessonId = id;
    ({ map, rings } = await world.apply({ ...sel, aircraft: 'c172' })); // school flies the trainer
    trainer = world.createTrainer(ui); // rebind to the active map's runway
    resetFlight();
    rings.show(false);
    hud.race(false);
    state = 'flying';
    showScreen(null);
    audio.resume();
    trainer.start(id);
  }

  function toMenu() {
    trainer?.stop();
    lessonId = null;
    instrEl.classList.remove('show');
    hud.setPapi(null); hud.setSlip(null);
    state = 'menu';
    showScreen('menu');
    audio.suspend();
    updateMenuLabels();
  }

  function finishRace() {
    raceDone = true;
    state = 'results';
    const best = getBest();
    const isBest = !best || raceT < best;
    if (isBest) setBest(raceT);
    $('#res-time').textContent = fmtTime(raceT);
    $('#res-time').classList.toggle('newbest', isBest);
    $('#res-verdict').textContent = isBest ? 'NEW BEST TIME' : `FINAL TIME · BEST ${fmtTime(best)}`;
    showScreen('results');
  }

  function crash() {
    state = 'crash'; // thud already played at the moment of impact
    let title, sub;
    const lessonFail = lessonId ? trainer?.onCrash() : null;
    if (lessonFail) ({ title, sub } = { title: lessonFail.title + '.', sub: lessonFail.sub });
    else [title, sub] = CRASH_TEXT[ac.crashReason] || CRASH_TEXT['terrain impact'];
    instrEl.classList.remove('show');
    hud.setPapi(null); hud.setSlip(null);
    $('#crash-title').innerHTML = title.replace('.', '<em>.</em>');
    $('#crash-sub').textContent = sub;
    showScreen('crash');
  }

  // --- wire screens ---
  document.querySelectorAll('#menu .btn.sel').forEach(b =>
    b.addEventListener('click', () => { audio.resume(); cycle(b.dataset.sel); }));
  $('#btn-start').addEventListener('click', () => { audio.resume(); begin(); });

  const actions = {
    resume: () => { state = 'flying'; showScreen(null); audio.resume(); },
    restart: () => (lessonId ? beginLesson(lessonId) : begin()),
    menu: toMenu,
  };
  document.querySelectorAll('[data-act]').forEach(b =>
    b.addEventListener('click', () => actions[b.dataset.act]()));

  controls.on('pause', () => {
    if (state === 'flying') { state = 'paused'; showScreen('pause'); audio.suspend(); }
    else if (state === 'paused') actions.resume();
  });
  controls.on('reset', () => { if (state === 'flying' || state === 'crash') actions.restart(); });
  controls.on('camera', () => { camRig.cycle(); hud.setCamera(camRig.modeName); });
  controls.on('help', () => $('#help').classList.toggle('show'));

  let lastTouchdown = null;

  return {
    get state() { return state; },
    get mode() { return sel.mode; },
    get selection() { return { ...sel }; },
    select(partial) { sel = { ...sel, ...partial }; updateMenuLabels(); }, // used by tests/menu
    start: begin,
    beginLesson, // exposed for tests
    toMenu,
    // called every render frame while flying
    tick(dt) {
      if (state !== 'flying') return;

      if (ac.crashed) {
        if (crashT === null) { crashT = 0; fx?.crash(ac.pos, ac.vel); audio.thud(); }
        crashT += dt;
        if (crashT > 1.3) { crashT = null; crash(); }
        return;
      }

      if (lessonId) { trainer?.tick(dt); return null; }

      // race clock + gates
      let bearing = null;
      if (sel.mode === 'race') {
        if (!raceStarted && ac.groundSpeed > 3) { raceStarted = true; }
        if (raceStarted && !raceDone) raceT += dt;
        const res = rings.check(ac);
        if (res === 'pass') {
          audio.chime();
          hud.message(rings.done ? `All gates! Land on runway ${map.runway.name} and stop.` : `Gate ${rings.active} / ${rings.total}`, 1800);
        }
        const gd = rings.guidance(ac);
        if (gd) bearing = gd.bearing;
        else {
          const dx = map.runway.spawn.x - ac.pos.x, dz = map.runway.spawn.z - ac.pos.z;
          bearing = (90 - Math.atan2(-dz, dx) * 180 / Math.PI + 360) % 360;
        }
        rings.update(dt);
        hud.race(true, {
          time: fmtTime(raceT),
          rings: rings.done ? `LAND RWY ${map.runway.name}` : `GATE ${rings.active + 1} / ${rings.total}`,
          best: getBest() ? `BEST ${fmtTime(getBest())}` : 'BEST —',
        });
        if (rings.done && ac.onGround && ac.groundSpeed < 3 && ac.touchdown?.onRunway) {
          finishRace(); return;
        }
      }

      // landing callouts (free flight)
      if (ac.touchdown && ac.touchdown !== lastTouchdown) {
        lastTouchdown = ac.touchdown;
        if (sel.mode === 'free') {
          const { fpm, speedKt, onRunway } = ac.touchdown;
          const rating = fpm <= 130 ? 'Greased it.' : fpm <= 300 ? 'Smooth.' : fpm <= 500 ? 'Firm.' : 'Hard arrival — gear survived, barely.';
          hud.message(`${rating} &nbsp;${fpm} fpm &middot; ${speedKt} kt${onRunway ? '' : ' &middot; off-field'}`, 4200);
        }
        fx?.touchdown(ac.pos, ac.groundSpeed, ac.touchdown.fpm);
        audio.chirp();
        audio.thud();
      }
      return bearing;
    },
  };
}
