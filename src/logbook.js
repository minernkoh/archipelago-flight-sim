// src/logbook.js — pilot logbook: data model + screen renderer.
//
// The data model (emptyLogbook / accumulate / computeBadges) is pure and
// THREE-free so the node suite can test accumulation and badge logic. The
// renderer (renderLogbook) is DOM-only and mirrors the ground-school glossary
// screen: it populates an empty `<div class="screen">`, injects its own style
// once, and wires BACK through the existing global [data-act] handler.
//
// Persisted under localStorage `archipelago.logbook` (JSON).

export const LOGBOOK_KEY = 'archipelago.logbook';
const STYLE_ID = 'archipelago-logbook-style';
const TRAINING_KEY = 'archipelago.training';
const LESSON_TOTAL = 10; // full syllabus incl. night circuit (training.js)

export function emptyLogbook() {
  return {
    hours: {},            // seconds flown per aircraft id
    landings: 0,          // total safe landings
    landingsByType: {},   // landings per aircraft id
    bestFpm: null,        // softest landing (lowest sink rate, fpm)
    flags: { nightLanding: false, apLeg: false, gauntletDone: false, smoothLeg: false },
  };
}

export function loadLogbook() {
  try {
    const v = JSON.parse(localStorage.getItem(LOGBOOK_KEY) || 'null');
    if (!v || typeof v !== 'object') return emptyLogbook();
    const base = emptyLogbook();
    return { ...base, ...v, flags: { ...base.flags, ...(v.flags || {}) },
      hours: { ...(v.hours || {}) }, landingsByType: { ...(v.landingsByType || {}) } };
  } catch { return emptyLogbook(); }
}

export function saveLogbook(lb) {
  try { localStorage.setItem(LOGBOOK_KEY, JSON.stringify(lb)); } catch { /* storage off */ }
}

// Fold one flight's summary into the logbook (pure; mutates + returns lb).
// ev: { aircraft, seconds, landing:{fpm,night}|null, apUsed, gauntletDone, comfort }
export function accumulate(lb, ev = {}) {
  const { aircraft, seconds = 0, landing = null, apUsed = false,
          gauntletDone = false, comfort = null } = ev;
  if (aircraft && seconds > 0) lb.hours[aircraft] = (lb.hours[aircraft] || 0) + seconds;
  if (landing) {
    lb.landings += 1;
    if (aircraft) lb.landingsByType[aircraft] = (lb.landingsByType[aircraft] || 0) + 1;
    if (landing.fpm != null && (lb.bestFpm == null || landing.fpm < lb.bestFpm)) lb.bestFpm = landing.fpm;
    if (landing.night) lb.flags.nightLanding = true;
  }
  if (apUsed && seconds >= 60) lb.flags.apLeg = true;
  if (gauntletDone) lb.flags.gauntletDone = true;
  if (comfort != null && comfort >= 90) lb.flags.smoothLeg = true;
  return lb;
}

// Badge unlock logic (pure). opts.lessonsDone / opts.lessonsTotal describe
// flight-school progress (PPL depends on it, not on the logbook object).
export function computeBadges(lb, opts = {}) {
  const lessonsDone = opts.lessonsDone ?? 0;
  const lessonsTotal = opts.lessonsTotal ?? LESSON_TOTAL;
  return [
    { id: 'ppl', label: 'PPL', desc: 'Pass every flight-school lesson',
      earned: lessonsTotal > 0 && lessonsDone >= lessonsTotal },
    { id: 'tailwheel', label: 'TAILWHEEL', desc: 'Land the Extra 300 taildragger',
      earned: (lb.landingsByType.extra300 || 0) >= 1 },
    { id: 'jet', label: 'JET', desc: 'Finish the low-level gauntlet in the Hornet',
      earned: !!lb.flags.gauntletDone },
    { id: 'night', label: 'NIGHT', desc: 'Complete a landing after dark',
      earned: !!lb.flags.nightLanding },
    { id: 'autopilot', label: 'AUTOPILOT', desc: 'Fly a full leg (≥60 s) on the autopilot',
      earned: !!lb.flags.apLeg },
    { id: 'smooth', label: 'SMOOTH OPERATOR', desc: 'Fly an airline leg at comfort ≥ 90',
      earned: !!lb.flags.smoothLeg },
  ];
}

// Count completed lessons from the training progress key (browser side).
function lessonsDoneFromStorage() {
  try {
    const p = JSON.parse(localStorage.getItem(TRAINING_KEY) || '{}');
    return Object.values(p).filter(Boolean).length;
  } catch { return 0; }
}

const fmtHours = (s) => {
  if (!s || s < 60) return `${Math.round(s || 0)}s`;
  const h = s / 3600;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(s / 60)} min`;
};

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .lb-wrap { display: grid; grid-template-columns: 1fr; gap: 1.4rem; margin-top: 1.4rem;
      max-width: 52rem; }
    .lb-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
      gap: .8rem; }
    .lb-stat { background: rgba(16,21,26,.72); border: 1px solid rgba(232,237,242,.28);
      border-left: 3px solid #ffb300; padding: .7rem .85rem; }
    .lb-stat .k { font-family: "B612 Mono", ui-monospace, monospace; font-size: .55rem;
      letter-spacing: .22em; color: #9aa7b2; }
    .lb-stat .v { font-family: "B612 Mono", ui-monospace, monospace; font-size: 1.5rem;
      font-weight: 700; color: #e8edf2; margin-top: .15rem; }
    .lb-stat .v small { font-size: .8rem; color: #9aa7b2; font-weight: 400; }
    .lb-sub { font-family: "B612 Mono", ui-monospace, monospace; font-size: .58rem;
      letter-spacing: .22em; color: #9aa7b2; margin: .4rem 0 .1rem; }
    .lb-hours { display: flex; flex-wrap: wrap; gap: .5rem; }
    .lb-chip { font-family: "B612 Mono", ui-monospace, monospace; font-size: .72rem;
      background: rgba(16,21,26,.72); border: 1px solid rgba(232,237,242,.22);
      padding: .3rem .6rem; color: #e8edf2; }
    .lb-chip b { color: #ffb300; font-weight: 700; }
    .lb-badges { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
      gap: .7rem; }
    .lb-badge { background: rgba(16,21,26,.72); border: 1px solid rgba(232,237,242,.18);
      padding: .6rem .75rem; opacity: .5; }
    .lb-badge.earned { opacity: 1; border-color: rgba(99,217,124,.65); border-left: 3px solid #63d97c; }
    .lb-badge .bl { font-family: "B612 Mono", ui-monospace, monospace; font-size: .9rem;
      font-weight: 700; letter-spacing: .06em; color: #e8edf2; display: flex; justify-content: space-between; }
    .lb-badge .bl .tick { color: #63d97c; }
    .lb-badge .bl .tick.no { color: #5a6470; }
    .lb-badge .bd { font-family: "B612", system-ui, sans-serif; font-size: .72rem; line-height: 1.35;
      color: #9aa7b2; margin-top: .25rem; }
    .lb-empty { font-family: "B612", system-ui, sans-serif; font-size: .82rem; color: #9aa7b2; }
  `;
  document.head.appendChild(style);
}

/**
 * Render the logbook screen.
 * @param {HTMLElement} mountEl empty `.screen` div (e.g. #logbook)
 * @param {object} [opts]
 * @param {string} [opts.backAct] data-act for BACK (default 'menu')
 * @param {(id:string)=>string} [opts.craftName] id -> display name
 * @param {number} [opts.lessonsTotal] full syllabus size (default 10)
 */
export function renderLogbook(mountEl, opts = {}) {
  if (!mountEl) return;
  injectStyles();
  const backAct = opts.backAct || 'menu';
  const name = opts.craftName || ((id) => id.toUpperCase());
  const lb = loadLogbook();
  const badges = computeBadges(lb, {
    lessonsDone: lessonsDoneFromStorage(),
    lessonsTotal: opts.lessonsTotal ?? LESSON_TOTAL,
  });

  const totalSec = Object.values(lb.hours).reduce((s, v) => s + v, 0);
  const earned = badges.filter(b => b.earned).length;
  const hoursChips = Object.entries(lb.hours).sort((a, b) => b[1] - a[1])
    .map(([id, s]) => `<span class="lb-chip">${name(id)} <b>${fmtHours(s)}</b></span>`).join('');

  mountEl.innerHTML = `
    <div class="inner">
      <div class="kicker">PILOT RECORD</div>
      <h1>LOGBOOK<em>.</em></h1>
      <p class="sub">Every hour flown, every landing, and the badges you've earned along
        the way — kept between visits.</p>
      <div class="lb-wrap">
        <div class="lb-stats">
          <div class="lb-stat"><div class="k">TOTAL TIME</div><div class="v">${fmtHours(totalSec)}</div></div>
          <div class="lb-stat"><div class="k">LANDINGS</div><div class="v">${lb.landings}</div></div>
          <div class="lb-stat"><div class="k">SOFTEST LANDING</div><div class="v">${
            lb.bestFpm != null ? `${Math.round(lb.bestFpm)}<small> fpm</small>` : '—'}</div></div>
          <div class="lb-stat"><div class="k">BADGES</div><div class="v">${earned}<small> / ${badges.length}</small></div></div>
        </div>
        <div>
          <div class="lb-sub">HOURS BY AIRCRAFT</div>
          <div class="lb-hours">${hoursChips || '<span class="lb-empty">No flights logged yet — go fly.</span>'}</div>
        </div>
        <div>
          <div class="lb-sub">BADGES</div>
          <div class="lb-badges">${badges.map(b => `
            <div class="lb-badge ${b.earned ? 'earned' : ''}">
              <div class="bl">${b.label}<span class="tick ${b.earned ? '' : 'no'}">${b.earned ? '&#10003;' : '&#9679;'}</span></div>
              <div class="bd">${b.desc}</div>
            </div>`).join('')}</div>
        </div>
      </div>
      <div class="btnrow" style="margin-top:1.5rem">
        <button class="btn" data-act="${backAct}"><span class="no">&larr;</span> BACK</button>
      </div>
    </div>`;
}
