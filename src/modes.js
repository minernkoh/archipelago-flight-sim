// Game flow: menu (mode/map/aircraft selection) / free flight / ring race /
// pause / crash / results. World swapping is delegated to main.js via `world`.

import { resetOnRunway, setColdStart, KT, FT } from './physics/flightModel.js';
import { createTour } from './tour.js';
import { renderGlossary } from './groundschool.js';
import { vSpeeds, landingBands } from './physics/envelope.js';
import { runwayFrame } from './runwayUtil.js';
import { createComfortMeter, createManeuverDetector, GAUNTLET } from './activities.js';
import { loadLogbook, saveLogbook, accumulate, renderLogbook } from './logbook.js';
import { loadSettings, saveSettings, renderSettings } from './settings.js';
import { createPlanner } from './planner.js';
import { createAtc, createVoice, callsignFor } from './atc.js';
import { createMenuPreview } from './menupreview.js';
import { AIRPORTS } from './maps/airports.js';

const $ = (s) => document.querySelector(s);
const SEL_KEY = 'archipelago.sel';
const bestKey = (map, aircraft) => `archipelago.best.${map}.${aircraft}`;
const splitsKey = (map, aircraft) => `${bestKey(map, aircraft)}.splits`; // sibling of the float best

// One-line map descriptions for the menu map row.
const MAP_DESC = {
  archipelago: 'procedural islands, one strip of asphalt',
  singapore: 'stylised city-state — Changi to Marina Bay',
  alpine: 'high valley airstrip ringed by jagged peaks',
  // Real-world airfields (streamed elevation) — descriptions from airports.js.
  ...Object.fromEntries(AIRPORTS.map(a => [a.id, a.desc])),
};

// Human-terms numbers derived from the physics params (never hand-maintained):
// clean 1g stall speed and the structural redline (Vne), both in knots.
function derivedNumbers(p) {
  // Both numbers come from physics/envelope.js so the card, the ASI arcs and
  // the airframe limits can never disagree.
  const v = vSpeeds(p);
  return { stallKt: Math.round(v.vs1Kt), vneKt: Math.round(v.vneKt) };
}

const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

const MODES = [
  { id: 'free', label: 'FREE FLIGHT', hint: 'explore, land anywhere' },
  { id: 'race', label: 'RING RACE', hint: '12 gates against the clock' },
  { id: 'training', label: 'FLIGHT SCHOOL', hint: 'learn to fly' },
  { id: 'gauntlet', label: 'LOW GAUNTLET', hint: 'hornet — thread low gates, stay under the ceiling' },
  { id: 'airline', label: 'AIRLINE LEG', hint: 'heavy — a smooth cruise, scored on comfort' },
  { id: 'freestyle', label: 'AEROBATICS', hint: 'extra 300 — 90 s freestyle, we name your moves' },
];

// Activities that fly a fixed aircraft (like the school always flies the c172).
const FORCED_AIRCRAFT = { gauntlet: 'hornet', airline: 'heavy', freestyle: 'extra300' };
const AIRLINE_SECONDS = 75;
const FREESTYLE_SECONDS = 90;
const gauntletBestKey = (map) => `archipelago.gauntlet.${map}`;

const WEATHERS = [
  { id: 'calm', label: 'CALM', hint: 'still air' },
  { id: 'breezy', label: 'BREEZY', hint: '8 kt, light gusts' },
  { id: 'gusty', label: 'GUSTY', hint: '16 kt gusting 28 — hold on' },
  { id: 'live', label: 'LIVE', hint: 'real current weather at this field' },
];

// Time-of-day drives environment.js lighting (fog, sun, exposure) + night content.
const TIMES = [
  { id: 'dawn', label: 'DAWN', hint: 'low warm sun, soft haze' },
  { id: 'day', label: 'DAY', hint: 'bright, high sun' },
  { id: 'dusk', label: 'DUSK', hint: 'orange light, long shadows' },
  { id: 'night', label: 'NIGHT', hint: 'runway lights, PAPI, landing light' },
];

const CRASH_TEXT = {
  'hard impact': ['HARD IMPACT.', 'That arrival exceeded the landing gear’s enthusiasm.'],
  'prop strike': ['PROP STRIKE.', 'The propeller met the ground. The ground won.'],
  'wing strike': ['WING STRIKE.', 'A wingtip caught the ground mid-manoeuvre.'],
  'tail strike': ['TAIL STRIKE.', 'Rotated a little too eagerly.'],
  'terrain impact': ['TERRAIN.', 'Controlled flight into terrain — the classic.'],
  'numerical': ['DEPARTED FLIGHT.', 'The airflow gave up entirely.'],
  // v6: the airframe now actually has structural limits (see physics/envelope.js).
  'overspeed': ['AIRFRAME FAILURE.', 'Past Vne, and it let go.'],
  'overstress': ['AIRFRAME FAILURE.', 'Pulled harder than the wings could carry.'],
};

// U5: turn the crash telemetry snapshot into one coaching line. Stall and
// overspeed override the reason; otherwise the reason distinguishes a gear-
// overload arrival ('hard impact') from a building/terrain strike, etc.
function crashWhy(snap, reason) {
  if (!snap) return '';
  if (snap.stalled && snap.aglFt < 500)
    return 'The wing stalled with no height to recover — down low, lower the nose the instant the STALL light fires.';
  if (reason === 'overstress')
    return `Over-g — you asked the wings for more than their ${snap.gLimit}g limit. Ease the pull; at speed the elevator can break the aircraft long before it stalls.`;
  if (snap.overspeed || reason === 'overspeed')
    return `Structural failure at ${snap.speedKt} kt — past Vne the airframe can't carry the aerodynamic loads.`;
  switch (reason) {
    case 'hard impact':
      return `Came down at ${snap.fpm} fpm — this gear gives out near ${snap.gearLimitFpm} fpm, so flare to bleed the sink before touchdown.`;
    case 'terrain impact':
      return 'Flew into solid ground or a building — watch AGL, not just the altitude tape, near high terrain and the city.';
    case 'prop strike':
      return 'Nose-low contact drove the prop in — raise the nose and touch on the mains first.';
    case 'wing strike':
      return 'A wing dropped into the surface — keep the wings level through the flare and touchdown.';
    case 'tail strike':
      return 'Over-rotated — ease the back-pressure so the tail clears.';
    default:
      return 'The airflow departed the airframe entirely — keep it inside the envelope.';
  }
}

export function createGameFlow({ ac, hud, audio, controls, camRig, world, fx, autopilot, panel }) {
  let crashT = null; // delay before the crash screen so the debris burst reads
  let state = 'menu';           // menu | flying | paused | crash | results
  let sel = { mode: 'free', map: 'archipelago', aircraft: 'c172', weather: 'calm', time: 'day' };
  try { sel = { ...sel, ...JSON.parse(localStorage.getItem(SEL_KEY) || '{}') }; } catch { /* fresh defaults */ }
  let map = null, rings = null;  // live handles, set by begin()
  let raceT = 0, raceStarted = false, raceDone = false;
  let runSplits = [];   // this run's per-gate split times (vs getBestSplits())
  let crashSnap = null; // ac telemetry captured at the first crashed frame (U5)
  let trainer = null, lessonId = null;
  const instrEl = $('#instructor');

  // Phase C activity state.
  const comfort = createComfortMeter();   // airline-leg ride score
  let maneuver = null;                     // freestyle detector (per flight)
  let activityT = 0;                       // airline/freestyle timer (s)
  let flightAircraft = sel.aircraft;       // effective aircraft this flight
  let flightAcc = null;                    // this flight's logbook accumulator

  const screens = { menu: $('#menu'), pause: $('#pause'), crash: $('#crash'), results: $('#results'), lessons: $('#lessons'), groundschool: $('#groundschool'), logbook: $('#logbook'), settings: $('#settings'), plan: $('#plan') };
  const showScreen = (name) => {
    for (const [k, el] of Object.entries(screens)) el.classList.toggle('show', k === name);
    hud.show(name === null);
  };

  // Guided HUD tour: reuses the #help key list as its final card, so the key
  // list survives and #help no longer pops up on its own.
  const tour = createTour({
    finalCardHTML: $('#help').innerHTML,
    finalCardTitle: 'KEYBOARD CONTROLS',
  });
  // Populate the ground-school glossary screen once at boot (BACK -> menu via
  // the global [data-act] wiring below).
  renderGlossary($('#groundschool'), { backAct: 'menu' });

  // Settings: load once, apply everywhere, re-apply + persist on every edit.
  const settings = loadSettings();
  // v5-R5: ATC-lite. The tower is rebuilt per flight (field/runway/callsign all
  // change with the selection); the voice is a single long-lived synth handle.
  const atcVoice = createVoice();
  let atc = null;
  const sayAtc = (text) => { hud.atc(text); atcVoice.speak(text); };
  const silenceAtc = () => { atcVoice.cancel(); hud.clearAtc?.(); };

  const applySettingsEverywhere = () => {
    audio.setVolume(settings.volume);
    audio.setSfxVolume?.(settings.sfxVolume);
    audio.setMusicVolume?.(settings.musicVolume);
    audio.setMuted?.(settings.muted);
    controls.applySettings(settings);
    world.setPixelRatioCap?.(settings.pixelRatioCap);
    world.setAutoRes?.(settings.autoRes);
    world.setQuality?.(settings.quality);   // v6: draw distance + shadows
    atcVoice.setEnabled(settings.atc);
    atc?.setArmed(settings.atc);
    if (!settings.atc) silenceAtc();
  };
  applySettingsEverywhere();
  renderSettings($('#settings'), {
    settings,
    onChange: (s) => { saveSettings(s); applySettingsEverywhere(); },
  });

  // Flight planner (v5-R4): plans on the PLAN screen; DIRECT-TO/FLY PLAN feed
  // the autopilot; NAV engages automatically if already airborne.
  const planner = createPlanner({
    getMap: () => map || world.maps.find(m => m.id === sel.map) || world.maps[0],
    getAc: () => ac,
    autopilot,
    onFlyPlan: (kind) => {
      if (state === 'flying') {
        autopilot.engageNav();
        showScreen(null);
        hud.message(kind === 'direct' ? 'Direct-to engaged — NAV is steering.' : 'Plan loaded — NAV is steering.', 4200);
      } else {
        hud.message('Plan loaded — engage NAV (<b>N</b>) once airborne.', 4200);
      }
    },
  });
  planner.mount($('#plan'));

  // Menu map preview (chart of the selected world). Baking samples map.height
  // on a grid, so it runs only on selection change and is cached by map id —
  // the first bake rides main.js's boot() -> toMenu() setTimeout pre-gen path,
  // never rAF. Real-world maps stream elevation, so poll on a slow timer to
  // upgrade the placeholder once tiles land.
  const menuPreview = createMenuPreview($('#mp-canvas'), $('#mp-caption'));
  setInterval(() => {
    if (state !== 'menu' || !menuPreview.awaiting) return;
    menuPreview.retryIfPending(world.maps.find(m => m.id === sel.map));
  }, 900);

  // Logbook screen is re-rendered each time it opens so stats/badges are fresh.
  function refreshLogbook() {
    renderLogbook($('#logbook'), {
      backAct: 'menu',
      craftName: (id) => (world.aircraft.find(a => a.id === id)?.params.name || id),
    });
  }

  const getGauntletBest = () => {
    const v = parseFloat(localStorage.getItem(gauntletBestKey(sel.map)));
    return Number.isFinite(v) ? v : null;
  };
  const setGauntletBest = (t) => { try { localStorage.setItem(gauntletBestKey(sel.map), String(t)); } catch { /* off */ } };

  // Fold the just-finished flight into the persistent logbook (once).
  function commitFlight() {
    const f = flightAcc;
    flightAcc = null;
    if (!f) return;
    if (!f.seconds && !f.landing && !f.gauntletDone && f.comfort == null) return;
    const lb = loadLogbook();
    accumulate(lb, {
      aircraft: f.aircraft, seconds: f.seconds, landing: f.landing,
      apUsed: f.apUsed, gauntletDone: f.gauntletDone, comfort: f.comfort,
    });
    saveLogbook(lb);
  }

  // Fire a warm one-line instructor hint at most once EVER per key.
  function hint(key, html) {
    const sk = 'archipelago.hint.' + key;
    try {
      if (localStorage.getItem(sk)) return;
      localStorage.setItem(sk, '1');
    } catch { /* storage unavailable — just show it */ }
    hud.message(html);
  }

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
  // Sibling key holds the best run's per-gate split times (JSON array). Kept
  // separate from the bare-float best so the legacy best key is never touched.
  const getBestSplits = () => {
    try {
      const v = JSON.parse(localStorage.getItem(splitsKey(sel.map, sel.aircraft)) || 'null');
      return Array.isArray(v) ? v : null;
    } catch { return null; }
  };
  const setBestSplits = (arr) => {
    try { localStorage.setItem(splitsKey(sel.map, sel.aircraft), JSON.stringify(arr)); } catch { /* storage unavailable */ }
  };

  // U4: aircraft preview panel — name, tagline, 3 editorial stat bars, and two
  // derived human-terms numbers (stall / Vne).
  function renderCraftPanel(craft) {
    // Name + tagline deliberately absent: row 03 and the description line
    // already say them, and repeating them cost the panel its vertical room.
    const stats = craft.stats || { speed: 0, handling: 0, difficulty: 0 };
    const bar = (label, n) =>
      `<div class="cp-bar"><span class="bl">${label}</span><span class="cp-seg">` +
      Array.from({ length: 5 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('') +
      `</span></div>`;
    $('#cp-bars').innerHTML =
      bar('SPEED', stats.speed) + bar('HANDLING', stats.handling) + bar('DIFF', stats.difficulty);
    const d = derivedNumbers(craft.params);
    $('#cp-nums').innerHTML =
      `<span>STALL</span> ${d.stallKt} KT &nbsp;&middot;&nbsp; <span>VNE</span> ${d.vneKt} KT`;
  }

  function updateMenuLabels() {
    const mode = MODES.find(m => m.id === sel.mode) || MODES[0];
    $('#sel-mode').textContent = mode.label;
    const best = getBest();
    $('#sel-mode-hint').textContent = sel.mode === 'race' && best ? `${mode.hint} · best ${fmtTime(best)}` : mode.hint;
    const mapObj = world.maps.find(m => m.id === sel.map) || world.maps[0];
    $('#sel-map').textContent = mapObj.name;
    $('#sel-map-hint').textContent = MAP_DESC[mapObj.id] || '';
    menuPreview.show(mapObj);   // cached per map id; one bake on a miss
    const craft = world.aircraft.find(a => a.id === sel.aircraft) || world.aircraft[0];
    $('#sel-aircraft').textContent = craft.params.name.toUpperCase();
    $('#sel-aircraft-hint').textContent = craft.tagline;
    renderCraftPanel(craft);
    const wx = WEATHERS.find(w => w.id === sel.weather) || WEATHERS[0];
    $('#sel-weather').textContent = wx.label;
    $('#sel-weather-hint').textContent = wx.hint;
    const tm = TIMES.find(t => t.id === sel.time) || TIMES[1];
    $('#sel-time').textContent = tm.label;
    $('#sel-time-hint').textContent = tm.hint;
    // Must run AFTER every hint is written — it copies the focused row's hint
    // into the description line, so an earlier call would show a stale one.
    paintMenuCursor();
    localStorage.setItem(SEL_KEY, JSON.stringify(sel));
    if (state === 'menu') world.preview?.(sel);
  }

  // dir +1 / -1 so the keyboard can step backwards; clicking still means "next".
  function cycle(kind, dir = 1) {
    const lists = { mode: MODES.map(m => m.id), map: world.maps.map(m => m.id), aircraft: world.aircraft.map(a => a.id), weather: WEATHERS.map(w => w.id), time: TIMES.map(t => t.id) };
    const list = lists[kind];
    const cur = list.indexOf(sel[kind]);
    sel[kind] = list[(cur + dir + list.length) % list.length];
    updateMenuLabels();
  }

  // --- Menu keyboard navigation -------------------------------------------
  // The whole sim is flown from the keyboard, but the menu used to be
  // mouse-only. Up/Down move a cursor, Left/Right cycle the focused row, Enter
  // launches. Mouse hover moves the same cursor so the two inputs never
  // disagree about which row is live.
  const menuRows = () => Array.from(document.querySelectorAll('#sel-rows .btn'));
  let menuIndex = 0;

  // One description line for the focused row, instead of a hint per row: the
  // per-row hints had to be ellipsed to fit ("explore, land …") and the ones
  // that did fit wrapped, which broke the row rhythm.
  function paintMenuCursor() {
    const rows = menuRows();
    rows.forEach((el, i) => el.classList.toggle('cur', i === menuIndex));
    const desc = $('#sel-desc');
    if (desc) desc.textContent = rows[menuIndex]?.querySelector('.hint')?.textContent || '';
  }

  function moveMenuCursor(delta) {
    const rows = menuRows();
    if (!rows.length) return;
    menuIndex = (menuIndex + delta + rows.length) % rows.length;
    paintMenuCursor();
  }

  function menuKey(e) {
    if (state !== 'menu') return;
    // Only drive the menu while the menu itself is the visible screen —
    // lessons/settings/logbook/plan are all screens with their own controls.
    if (!screens.menu.classList.contains('show')) return;
    const rows = menuRows();
    const row = rows[menuIndex];
    const kind = row?.dataset.sel;
    switch (e.key) {
      case 'ArrowUp': moveMenuCursor(-1); break;
      case 'ArrowDown': moveMenuCursor(1); break;
      case 'ArrowLeft': if (kind) cycle(kind, -1); else return; break;
      case 'ArrowRight': if (kind) cycle(kind, 1); else return; break;
      case 'Enter': audio.resume(); begin(); break;
      default: return;
    }
    e.preventDefault();   // arrows must not scroll the menu behind the cursor
  }
  window.addEventListener('keydown', menuKey);

  function resetFlight() {
    const r = map.runway;
    resetOnRunway(ac, { x: r.spawn.x, z: r.spawn.z, y: r.y, headingRad: r.headingRad });
    controls.resetFlaps();
    camRig.reset();
    rings.reset();
    raceT = 0; raceStarted = false; raceDone = false;
    runSplits = [];
    crashSnap = null;
    crashT = null;
    activityT = 0;
    comfort.reset();
    flightAcc = { aircraft: flightAircraft, seconds: 0, landing: null,
      apUsed: false, gauntletDone: false, comfort: null, night: sel.time === 'night' };
    hud.clearMessage();
    hud.clearDebrief?.();
    silenceAtc();
  }

  async function begin() {
    if (sel.mode === 'training') { openLessons(); return; }
    commitFlight(); // log any prior flight before starting a new one
    lessonId = null;
    // Activities fly a fixed aircraft; free/race honour the menu selection.
    flightAircraft = FORCED_AIRCRAFT[sel.mode] || sel.aircraft;
    ({ map, rings } = await world.apply({ ...sel, aircraft: flightAircraft }));
    resetFlight();
    const gated = sel.mode === 'race' || sel.mode === 'gauntlet';
    const scored = sel.mode === 'airline' || sel.mode === 'freestyle';
    rings.show(gated);
    hud.race(gated || scored);
    maneuver = sel.mode === 'freestyle' ? createManeuverDetector() : null;
    // Fresh tower for this field/runway/aircraft; holds short until we roll.
    atc = createAtc({
      field: map.name, rwyName: map.runway.name,
      callsign: callsignFor(flightAircraft), say: sayAtc,
    });
    atc.setArmed(settings.atc);
    state = 'flying';
    showScreen(null);
    audio.resume();
    const rwy = map.runway.name;
    const msg = {
      race: `Clock starts when you roll. ${rings.total} gates, then land back on runway ${rwy}.`,
      gauntlet: `Thread the low gates and stay UNDER ${GAUNTLET.ceilingAgl} m above ground — climb through it and you bust.`,
      airline: `Ease it into a smooth cruise. You have ${AIRLINE_SECONDS}s aloft and you're scored on the ride.`,
      freestyle: `${FREESTYLE_SECONDS}s of open sky — loops, rolls, barrel rolls. We'll name what we see.`,
    }[sel.mode] || `Runway ${rwy} — full throttle <b>W</b>, rotate with <b>&uarr;</b>.`;
    hud.message(msg, 5200);
    // v5-R3: cold & dark spawn (free flight, startup-capable aircraft only — the
    // clock-driven modes and lessons keep the engine hot). Auto-opens the panel
    // so the switches + live checklist sit in front of the player.
    if (settings.coldDark && ac.p.startup && sel.mode === 'free') {
      setColdStart(ac);
      panel?.setVisible(true);
      hud.message('Cold &amp; dark — run the START CHECKLIST on the panel below.', 6800);
    }
    if (sel.mode === 'race') hud.countdown(); // visual 3-2-1-GO; clock still arms on roll
    tour.offerOnce(); // first flight ever: auto-open the guided HUD tour
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
    // The night circuit is flown after dark regardless of the menu time setting.
    const time = id === 'night-circuit' ? 'night' : sel.time;
    commitFlight();
    flightAircraft = 'c172';
    ({ map, rings } = await world.apply({ ...sel, aircraft: 'c172', time })); // school flies the trainer
    trainer = world.createTrainer(ui); // rebind to the active map's runway
    resetFlight();
    atc = null;   // the instructor has the frequency — no tower during lessons
    if (flightAcc) flightAcc.night = time === 'night';
    rings.show(false);
    hud.race(false);
    state = 'flying';
    showScreen(null);
    audio.resume();
    trainer.start(id);
  }

  function toMenu() {
    commitFlight();
    trainer?.stop();
    lessonId = null;
    atc = null;
    silenceAtc();
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
    if (isBest) { setBest(raceT); setBestSplits(runSplits); }
    $('#res-time').textContent = fmtTime(raceT);
    $('#res-time').classList.toggle('newbest', isBest);
    $('#res-verdict').textContent = isBest ? 'NEW BEST TIME' : `FINAL TIME · BEST ${fmtTime(best)}`;
    commitFlight();
    showScreen('results');
  }

  // Gauntlet ends either by clearing every gate (bust=false) or by busting the
  // altitude ceiling (bust=true). Reuses the results screen.
  function finishGauntlet(bust) {
    raceDone = true;
    state = 'results';
    if (!bust && flightAcc) flightAcc.gauntletDone = true;
    commitFlight();
    $('#res-time').textContent = fmtTime(raceT);
    if (bust) {
      $('#res-time').classList.remove('newbest');
      $('#res-verdict').textContent = `CEILING BUST · you climbed through ${GAUNTLET.ceilingAgl} m`;
    } else {
      const best = getGauntletBest();
      const isBest = !best || raceT < best;
      if (isBest) setGauntletBest(raceT);
      $('#res-time').classList.toggle('newbest', isBest);
      $('#res-verdict').textContent = isBest ? 'GAUNTLET CLEAR · NEW BEST' : `GAUNTLET CLEAR · BEST ${fmtTime(best)}`;
    }
    showScreen('results');
  }

  // Airline leg ends after AIRLINE_SECONDS aloft; the comfort score is the stat.
  function finishAirline() {
    raceDone = true;
    state = 'results';
    const s = comfort.score();
    if (flightAcc) flightAcc.comfort = s;
    commitFlight();
    $('#res-time').textContent = String(s);
    $('#res-time').classList.toggle('newbest', s >= 90);
    $('#res-verdict').textContent = s >= 90 ? 'COMFORT SCORE · buttery smooth'
      : s >= 70 ? 'COMFORT SCORE · acceptable ride' : 'COMFORT SCORE · hold the coffee';
    showScreen('results');
  }

  // Freestyle ends after FREESTYLE_SECONDS; the count of named maneuvers is the stat.
  function finishFreestyle() {
    raceDone = true;
    state = 'results';
    commitFlight();
    const n = maneuver?.count || 0;
    $('#res-time').textContent = String(n);
    $('#res-time').classList.toggle('newbest', n > 0);
    $('#res-verdict').textContent = n > 0 ? `MANEUVERS FLOWN · last: ${maneuver.last}` : 'MANEUVERS FLOWN · none named';
    showScreen('results');
  }

  function crash() {
    state = 'crash'; // thud already played at the moment of impact
    commitFlight(); // log hours flown up to the crash (+ any landing before it)
    let title, sub;
    const lessonFail = lessonId ? trainer?.onCrash() : null;
    if (lessonFail) ({ title, sub } = { title: lessonFail.title + '.', sub: lessonFail.sub });
    else [title, sub] = CRASH_TEXT[ac.crashReason] || CRASH_TEXT['terrain impact'];
    instrEl.classList.remove('show');
    hud.setPapi(null); hud.setSlip(null);
    $('#crash-title').innerHTML = title.replace('.', '<em>.</em>');
    $('#crash-sub').textContent = sub;
    if (!lessonFail) { // real crash: append the "why" coaching line
      const why = crashWhy(crashSnap, ac.crashReason);
      if (why) $('#crash-sub').innerHTML = sub + `<span class="crash-why">${why}</span>`;
    }
    showScreen('crash');
  }

  // --- wire screens ---
  document.querySelectorAll('#menu .btn.sel').forEach(b =>
    b.addEventListener('click', () => { audio.resume(); cycle(b.dataset.sel); }));
  // Hover adopts the keyboard cursor, so mouse and keys always agree on the
  // live row (and clicking then arrowing continues from where you clicked).
  menuRows().forEach((el, i) => el.addEventListener('mouseenter', () => {
    if (state !== 'menu') return;
    menuIndex = i; paintMenuCursor();
  }));
  paintMenuCursor();
  $('#btn-start').addEventListener('click', () => { audio.resume(); begin(); });

  const actions = {
    resume: () => { state = 'flying'; showScreen(null); audio.resume(); },
    restart: () => (lessonId ? beginLesson(lessonId) : begin()),
    menu: toMenu,
    groundschool: () => showScreen('groundschool'),
    logbook: () => { refreshLogbook(); showScreen('logbook'); },
    settings: () => showScreen('settings'),
    plan: () => { planner.refresh(); showScreen('plan'); },
    // Race retry-from-gate: respawn on the approach to the last passed gate
    // rather than the runway, rewinding the clock to that gate's split.
    regate: () => {
      if (sel.mode !== 'race' || !rings || rings.active <= 0) { actions.restart(); return; }
      const ap = rings.approach(); // last passed gate, 140 m out on its centreline
      if (!ap) { actions.restart(); return; }
      const yaw = Math.atan2(-ap.dir.z, ap.dir.x);
      const spd = 55;
      ac.pos = { x: ap.pos.x, y: ap.pos.y, z: ap.pos.z };
      ac.vel = { x: ap.dir.x * spd, y: 0, z: ap.dir.z * spd };
      ac.q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
      ac.omega = { x: 0, y: 0, z: 0 };
      ac.crashed = false; ac.crashReason = ''; ac.touchdown = null; ac.stalled = false;
      crashT = null; crashSnap = null;
      raceT = runSplits.length ? runSplits[runSplits.length - 1] : 0;
      raceStarted = true; raceDone = false;
      state = 'flying';
      showScreen(null);
      audio.resume();
      hud.message(`Restarted from gate ${rings.active}.`, 2500);
    },
  };
  document.querySelectorAll('[data-act]').forEach(b =>
    b.addEventListener('click', () => actions[b.dataset.act]()));

  controls.on('pause', () => {
    if (state === 'flying') {
      state = 'paused'; showScreen('pause'); audio.suspend();
      // "restart from last gate" only makes sense mid-race past gate 1
      const rg = $('#btn-regate');
      if (rg) rg.style.display = (sel.mode === 'race' && rings && rings.active > 0) ? '' : 'none';
    } else if (state === 'paused') actions.resume();
  });
  controls.on('reset', () => { if (state === 'flying' || state === 'crash') actions.restart(); });
  controls.on('camera', () => { camRig.cycle(); hud.setCamera(camRig.modeName); });
  controls.on('flyby', () => {
    if (state !== 'flying') return;
    camRig.toggleFlyby(); hud.setCamera(camRig.modeName);
  });
  controls.on('help', () => { if (tour.isOpen()) tour.close(); else tour.open(); });

  let lastTouchdown = null;

  return {
    get state() { return state; },
    get mode() { return sel.mode; },
    get maneuver() { return maneuver; }, // freestyle detector (null otherwise)
    get selection() { return { ...sel }; },
    select(partial) { sel = { ...sel, ...partial }; updateMenuLabels(); }, // used by tests/menu
    start: begin,
    beginLesson, // exposed for tests
    toMenu,
    // called every render frame while flying
    tick(dt) {
      if (state !== 'flying') return;

      if (ac.crashed) {
        if (crashT === null) {
          crashT = 0;
          // snapshot telemetry the instant the loop first sees the crash — by the
          // time the crash screen shows, the aircraft has stopped tumbling.
          crashSnap = {
            stalled: ac.stalled,
            overspeed: ac.eas > (ac.p.limits?.vne ?? ac.p.maxSpeed),
            speedKt: Math.round(ac.eas * KT),
            aglFt: ac.agl * FT,
            fpm: Math.round(-ac.vel.y * FT * 60),
            gLimit: ac.p.limits?.gPos ?? 3.8,
            gearLimitFpm: landingBands(ac.p).limitFpm,
          };
          fx?.crash(ac.pos, ac.vel); audio.thud();
        }
        crashT += dt;
        if (crashT > 1.3) { crashT = null; crash(); }
        return;
      }

      if (lessonId) { trainer?.tick(dt); return null; }

      // v5-R5: tower calls. Sits below the lesson early-return above, so the
      // instructor never has to talk over ATC. `touchdown` is passed only on
      // the tick it is new — lastTouchdown is still the previous value here
      // (the debrief block updates it further down), and a stale one would
      // re-trigger the landing call after every touch-and-go.
      if (atc) {
        atc.update({
          onGround: ac.onGround,
          agl: ac.agl,
          vsFpm: ac.vel.y * FT * 60,          // positive up
          cross: runwayFrame(map.runway).cross(ac.pos),
          groundSpeedKt: ac.groundSpeed * KT,
          touchdown: ac.touchdown && ac.touchdown !== lastTouchdown ? ac.touchdown : null,
        }, dt);
      }

      // flight-time + autopilot-usage accounting for the logbook.
      if (flightAcc) {
        flightAcc.seconds += dt;
        if (autopilot?.on) flightAcc.apUsed = true;
      }

      // first-use micro-hints (free flight & race; lessons are suppressed by the
      // early return above, since the #instructor is already talking).
      const cs = controls.state;
      if (cs.flaps > 0.05) hint('flaps', 'Flaps are coming down — they add lift and drag so you can fly slower and settle into a steeper, gentler approach.');
      if (Math.abs(cs.trim) > 0.001) hint('trim', 'You just trimmed — that holds the nose where you set it so you can ease off the stick. Re-trim whenever your speed settles.');
      if (cs.brakes && ac.groundSpeed * KT > 40) hint('brakes', 'Wheel brakes bite on the ground — squeeze them to slow your rollout after touchdown, and go easy at speed so the nose stays up.');
      if (ac.stalled) hint('stall', 'The wing quit flying — push the nose DOWN and add power to get airflow back over it.');
      if (ac.eas > (ac.p.limits?.vne ?? ac.p.maxSpeed)) hint('overspeed', "You're past the airframe's limit — ease the throttle back and raise the nose gently before something bends.");

      // gated activities (race + gauntlet): shared clock/gate-pass machinery.
      let bearing = null;
      if (sel.mode === 'race' || sel.mode === 'gauntlet') {
        const isRace = sel.mode === 'race';
        if (!raceStarted && ac.groundSpeed > 3) { raceStarted = true; }
        if (raceStarted && !raceDone) raceT += dt;
        const res = rings.check(ac);
        if (res === 'pass') {
          audio.chime();
          const gateIdx = runSplits.length;
          runSplits.push(raceT);
          if (isRace) { // split delta vs the best run (race only)
            const bestSplits = getBestSplits();
            const ref = bestSplits && bestSplits[gateIdx];
            hud.split?.(ref != null ? raceT - ref : null);
          }
          hud.message(rings.done
            ? (isRace ? `All gates! Land on runway ${map.runway.name} and stop.` : 'Last gate — gauntlet clear!')
            : `Gate ${rings.active} / ${rings.total}`, 1800);
        }
        const gd = rings.guidance(ac);
        if (gd) bearing = gd.bearing;
        else if (isRace) {
          const dx = map.runway.spawn.x - ac.pos.x, dz = map.runway.spawn.z - ac.pos.z;
          bearing = (90 - Math.atan2(-dz, dx) * 180 / Math.PI + 360) % 360;
        }
        rings.update(dt);
        if (isRace) {
          hud.race(true, {
            time: fmtTime(raceT),
            rings: rings.done ? `LAND RWY ${map.runway.name}` : `GATE ${rings.active + 1} / ${rings.total}`,
            best: getBest() ? `BEST ${fmtTime(getBest())}` : 'BEST —',
          });
          if (rings.done && ac.onGround && ac.groundSpeed < 3 && ac.touchdown?.onRunway) {
            finishRace(); return;
          }
        } else { // gauntlet: ceiling floor readout + bust/clear checks
          const aglM = Math.round(ac.agl);
          hud.race(true, {
            time: fmtTime(raceT),
            rings: `GATE ${Math.min(rings.active + 1, rings.total)} / ${rings.total}`,
            best: `CEIL ${aglM} / ${GAUNTLET.ceilingAgl} m`,
          });
          if (raceStarted && !raceDone && ac.agl > GAUNTLET.ceilingAgl) { finishGauntlet(true); return; }
          if (rings.done) { finishGauntlet(false); return; }
        }
      }

      // airline leg: sample ride comfort while aloft; end after the leg's time.
      if (sel.mode === 'airline') {
        const aloft = !ac.onGround;
        if (aloft) { activityT += dt; comfort.sample(ac.gLoad, ac.vel.y, dt); }
        hud.race(true, {
          time: `${Math.floor(activityT)} / ${AIRLINE_SECONDS}s`,
          rings: `COMFORT ${comfort.score()}`,
          best: aloft ? 'CRUISE' : 'CLIMB OUT',
        });
        if (activityT >= AIRLINE_SECONDS) { finishAirline(); return; }
      }

      // aerobatics freestyle: detect maneuvers from body-rate history; time-boxed.
      if (sel.mode === 'freestyle') {
        activityT += dt;
        const hit = maneuver?.sample(ac.omega, dt);
        if (hit) { audio.chime(); hud.message(`${hit}!`, 1400); }
        hud.race(true, {
          time: fmtTime(Math.max(0, FREESTYLE_SECONDS - activityT)),
          rings: `MOVES ${maneuver?.count || 0}`,
          best: maneuver?.last ? `LAST ${maneuver.last}` : 'FREESTYLE',
        });
        if (activityT >= FREESTYLE_SECONDS) { finishFreestyle(); return; }
      }

      // landing debrief (free flight)
      if (ac.touchdown && ac.touchdown !== lastTouchdown) {
        lastTouchdown = ac.touchdown;
        // log a safe (on-runway) landing for the logbook, in any mode
        if (flightAcc && ac.touchdown.onRunway && ac.touchdown.fpm != null) {
          flightAcc.landing = { fpm: ac.touchdown.fpm, night: flightAcc.night };
        }
        if (sel.mode === 'free') {
          const { fpm, speedKt, onRunway } = ac.touchdown;
          const b = landingBands(ac.p);
          const grade = fpm <= b.greased ? 'GREASED IT' : fpm <= b.smooth ? 'SMOOTH'
            : fpm <= b.firm ? 'FIRM' : 'HARD ARRIVAL';
          const coach = !onRunway
            ? 'Off-field — down safe, but aim for the pavement next time.'
            : fpm <= b.greased ? 'Textbook — the mains barely chirped.'
            : fpm <= b.smooth ? 'Nicely flared. Keep bleeding speed before you touch.'
            : fpm <= b.firm ? 'A touch firm — start the flare a beat earlier.'
            : 'Heavy — carry a little power into the flare to ease the sink.';
          // centerline offset only makes sense on the runway (computed via the
          // shared runwayFrame — valid on both maps' runway definitions).
          const offset = onRunway ? runwayFrame(map.runway).cross(ac.pos) : null;
          hud.debrief({ grade, fpm, speedKt, offset, coach });
        }
        fx?.touchdown(ac.pos, ac.groundSpeed, ac.touchdown.fpm);
        audio.chirp();
        audio.thud();
      }
      return bearing;
    },
  };
}
