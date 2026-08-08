// ARCHIPELAGO — classic steam six-pack instrument panel.
// Self-contained inline-SVG cockpit panel (ASI / Attitude / Altimeter / Turn
// Coordinator / Heading / VSI), styled to match the PFD/B612 HUD aesthetic.
// THREE-free: only pulls pure-JS helpers from physics/flightModel.js.
//
// Usage (by the integrator):
//   import { createPanel } from './panel.js';
//   const panel = createPanel();
//   panel.mount(document.body);      // once, builds hidden DOM
//   panel.toggle();                  // e.g. on a keybind, to show/hide
//   // in the frame loop:
//   panel.update(ac);                // every frame, cheap (needle transforms only)
//
// See createPanel() below for the full API.

import { KT, FT, attitude } from './physics/flightModel.js';
import { vSpeeds } from './physics/envelope.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const RAD2DEG = 180 / Math.PI;

// ---------- small numeric/DOM helpers ----------

function safeNum(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function svgEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v !== undefined && v !== null) e.setAttribute(k, v);
    }
  }
  return e;
}

function append(parent, ...children) {
  for (const c of children) parent.appendChild(c);
  return parent;
}

// point at radius r, angle deg measured clockwise from straight-up (12 o'clock)
function polar(cx, cy, r, deg) {
  const rad = deg * Math.PI / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function tickLine(cx, cy, deg, rOuter, rInner, cls) {
  const a = polar(cx, cy, rOuter, deg);
  const b = polar(cx, cy, rInner, deg);
  return svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: cls });
}

function label(cx, cy, deg, r, text, cls) {
  const p = polar(cx, cy, r, deg);
  const t = svgEl('text', { x: p.x, y: p.y, class: cls, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
  t.textContent = text;
  return t;
}

// a needle drawn pointing straight up from the hub; rotate() at update time
// gives the cheap per-frame transform (face geometry never touches the DOM again).
function needleShape(cx, cy, len, tailLen, halfWidth, cls) {
  const tip = polar(cx, cy, len, 0);
  const tail = polar(cx, cy, tailLen, 180);
  const baseL = { x: cx - halfWidth, y: cy };
  const baseR = { x: cx + halfWidth, y: cy };
  const pts = `${tip.x},${tip.y} ${baseR.x},${baseR.y} ${tail.x},${tail.y} ${baseL.x},${baseL.y}`;
  return svgEl('polygon', { points: pts, class: cls });
}

// ---------- layout ----------

const R = 68;               // gauge radius
const COLS = [86, 244, 402];
const ROWS = [86, 240];
const VB_W = 488, VB_H = 330;

// ---------- gauge builders (each returns an update(value...) closure) ----------

function buildBezel(g, cx, cy, caption) {
  append(g,
    svgEl('circle', { cx, cy, r: R + 7, class: 'ap-bezel' }),
    svgEl('circle', { cx, cy, r: R, class: 'ap-face' }));
  append(g, label(cx, cy, 0, R + 20, caption, 'ap-caption'));
}

// Point on the dial at `deg` from vertical (the same convention the needle's
// rotate() uses), radius r.
function dialXY(cx, cy, r, deg) {
  const a = deg * Math.PI / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}
// Arc as a stroked path. Deliberately NOT a clipped group: test/e2e.mjs finds
// the attitude indicator with `#ap-sixpack g[clip-path]` and takes the FIRST
// match, and the ASI is built before the AI — a clipped group here would
// silently steal that check.
function arcPath(cx, cy, r, deg0, deg1, cls) {
  const [x0, y0] = dialXY(cx, cy, r, deg0);
  const [x1, y1] = dialXY(cx, cy, r, deg1);
  return svgEl('path', {
    d: `M ${x0} ${y0} A ${r} ${r} 0 ${Math.abs(deg1 - deg0) > 180 ? 1 : 0} 1 ${x1} ${y1}`,
    class: cls, fill: 'none',
  });
}

// The ASI was a fixed 0-200 kt dial shared by all five aircraft — the Hornet
// (600+ kt) and the Heavy both pegged it permanently — and it carried no
// airspeed arcs at all, so nothing on the panel told you where the limits
// were. Both are now driven per-aircraft from physics/envelope.js, the same
// source the airframe limits themselves use.
function buildASI(g, cx, cy) {
  buildBezel(g, cx, cy, 'ASI · KT');
  const startDeg = -130, endDeg = 130, span = endDeg - startDeg;
  const marks = svgEl('g');            // ticks + labels, rebuilt on scale change
  const arcs = svgEl('g');             // white/green/yellow arcs + Vne radial
  append(g, arcs, marks);
  const needle = needleShape(cx, cy, R - 10, R * 0.22, 3.4, 'ap-needle');
  append(g, needle, svgEl('circle', { cx, cy, r: 6.5, class: 'ap-hub' }));

  let max = 200, step = 10, curId = null;
  const v2d = (v) => startDeg + clamp(v, 0, max) / max * span;

  function rescale(p) {
    max = p?.hud?.asiMaxKt ?? 200;
    step = max <= 250 ? 10 : max <= 500 ? 25 : 50;
    marks.textContent = ''; arcs.textContent = '';
    for (let v = 0; v <= max; v += step) {
      const deg = v2d(v), major = (v / step) % 2 === 0;
      append(marks, tickLine(cx, cy, deg, R - 4, R - (major ? 14 : 8),
        major ? 'ap-tick ap-tick-major' : 'ap-tick'));
      if (major) append(marks, label(cx, cy, deg, R - 24, String(v), 'ap-label'));
    }
    if (!p) return;
    const s = vSpeeds(p);
    const ar = R - 7;
    // White: full-flap stall to Vfe — the speeds at which flaps may be out.
    if (s.vfeKt) append(arcs, arcPath(cx, cy, ar - 7, v2d(s.vs0Kt), v2d(s.vfeKt), 'ap-arc-white'));
    // Green: normal operating range, clean stall to Vno (or Vne without a Vno).
    append(arcs, arcPath(cx, cy, ar, v2d(s.vs1Kt), v2d(s.vnoKt ?? s.vneKt), 'ap-arc-green'));
    // Yellow: caution range, smooth air only.
    if (s.vnoKt) append(arcs, arcPath(cx, cy, ar, v2d(s.vnoKt), v2d(s.vneKt), 'ap-arc-yellow'));
    // Red radial at Vne.
    append(arcs, tickLine(cx, cy, v2d(s.vneKt), R - 3, R - 17, 'ap-vne'));
  }
  rescale(null);

  return (kt, p) => {
    if (p && p.id !== curId) { curId = p.id; rescale(p); }
    needle.setAttribute('transform', `rotate(${v2d(safeNum(kt, 0))} ${cx} ${cy})`);
  };
}

function buildAttitude(g, cx, cy) {
  const clipId = `ap-ai-clip-${cx}-${cy}`;
  const clip = svgEl('clipPath', { id: clipId });
  append(clip, svgEl('circle', { cx, cy, r: R - 2 }));
  g.appendChild(clip);

  append(g, svgEl('circle', { cx, cy, r: R + 7, class: 'ap-bezel' }));
  append(g, label(cx, cy, 0, R + 20, 'ATT', 'ap-caption'));

  const rollGroup = svgEl('g', { 'clip-path': `url(#${clipId})` });
  const pitchGroup = svgEl('g'); // translated for pitch, lives inside rollGroup
  const big = R * 6; // oversized sky/ground so pitch+roll never reveal an edge
  const sky = svgEl('rect', { x: cx - big, y: cy - big, width: big * 2, height: big, class: 'ap-sky' });
  const ground = svgEl('rect', { x: cx - big, y: cy, width: big * 2, height: big, class: 'ap-ground' });
  const horizonLine = svgEl('line', { x1: cx - big, y1: cy, x2: cx + big, y2: cy, class: 'ap-horizon-line' });
  append(pitchGroup, sky, ground);
  // pitch reference ticks (+-10, +-20, +-30 deg), painted on top of sky/ground
  for (const p of [-30, -20, -10, 10, 20, 30]) {
    const y = cy - p * 2.0;
    const w = (p % 20 === 0) ? 22 : 12;
    append(pitchGroup, svgEl('line', { x1: cx - w, y1: y, x2: cx + w, y2: y, class: 'ap-pitch-tick' }));
  }
  append(pitchGroup, horizonLine);
  append(rollGroup, pitchGroup);

  // bank pointer, attached to the gyro (rotates with rollGroup, fixed radius)
  const bankPointer = svgEl('polygon', {
    points: `${cx},${cy - R + 6} ${cx - 5},${cy - R + 16} ${cx + 5},${cy - R + 16}`,
    class: 'ap-bank-pointer',
  });
  append(rollGroup, bankPointer);
  g.appendChild(rollGroup);

  // fixed bank-angle rim scale (case-mounted, never moves)
  for (const d of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const major = d === 0 || Math.abs(d) === 30 || Math.abs(d) === 60;
    append(g, tickLine(cx, cy, d, R + 6, R + (major ? -2 : 1), 'ap-tick ap-tick-major'));
  }
  // fixed miniature aircraft symbol (case reference)
  append(g,
    svgEl('line', { x1: cx - 24, y1: cy, x2: cx - 7, y2: cy, class: 'ap-ai-wing' }),
    svgEl('line', { x1: cx + 7, y1: cy, x2: cx + 24, y2: cy, class: 'ap-ai-wing' }),
    svgEl('polygon', { points: `${cx},${cy - 6} ${cx - 5},${cy + 3} ${cx + 5},${cy + 3}`, class: 'ap-ai-wing' }));

  const pxPerDeg = 2.0;
  return (pitchDeg, rollDeg) => {
    const p = clamp(safeNum(pitchDeg, 0), -90, 90);
    const r = clamp(safeNum(rollDeg, 0), -180, 180);
    pitchGroup.setAttribute('transform', `translate(0 ${clamp(p * pxPerDeg, -big + R, big - R)})`);
    rollGroup.setAttribute('transform', `rotate(${-r} ${cx} ${cy})`);
  };
}

function buildAltimeter(g, cx, cy) {
  buildBezel(g, cx, cy, 'ALT · FT');
  // classic two-needle Kollsman-style face: numbers 0-9 every 36 deg (hundreds),
  // minor ticks every 20 ft (7.2 deg).
  for (let v = 0; v < 1000; v += 20) {
    const deg = v / 1000 * 360;
    const major = v % 100 === 0;
    append(g, tickLine(cx, cy, deg, R - 4, R - (major ? 14 : 7), major ? 'ap-tick ap-tick-major' : 'ap-tick'));
    if (major) append(g, label(cx, cy, deg, R - 24, String(v / 100), 'ap-label'));
  }
  const hundreds = needleShape(cx, cy, R - 10, R * 0.2, 3.4, 'ap-needle');
  const thousands = needleShape(cx, cy, R - 26, R * 0.15, 4.2, 'ap-needle ap-needle-short');
  append(g, thousands, hundreds, svgEl('circle', { cx, cy, r: 6.5, class: 'ap-hub' }));
  return (ft) => {
    const alt = clamp(safeNum(ft, 0), -2000, 60000);
    const wrapped = ((alt % 1000) + 1000) % 1000;
    const wrapped10k = ((alt % 10000) + 10000) % 10000;
    hundreds.setAttribute('transform', `rotate(${wrapped / 1000 * 360} ${cx} ${cy})`);
    thousands.setAttribute('transform', `rotate(${wrapped10k / 10000 * 360} ${cx} ${cy})`);
  };
}

function buildTurnCoordinator(g, cx, cy) {
  buildBezel(g, cx, cy, 'TURN COORD');
  // standard-rate (3 deg/s) doghouse index marks
  for (const d of [-20, 20]) {
    append(g, tickLine(cx, cy, d, R - 2, R - 16, 'ap-tick ap-tick-major'));
  }
  append(g, label(cx, cy, 0, R - 32, '2 MIN', 'ap-caption-small'));

  // miniature airplane symbol (rear view), rotates to show bank direction
  const plane = svgEl('g');
  append(plane,
    svgEl('rect', { x: cx - 26, y: cy - 2, width: 52, height: 4, class: 'ap-tc-wing' }),
    svgEl('rect', { x: cx - 3, y: cy - 12, width: 6, height: 10, class: 'ap-tc-fin' }),
    svgEl('circle', { cx: cx - 24, cy, r: 3, class: 'ap-tc-dot' }),
    svgEl('circle', { cx: cx + 24, cy, r: 3, class: 'ap-tc-dot' }));
  g.appendChild(plane);

  // slip/skid ball in a curved tube below center
  const tubeY = cy + R - 20;
  append(g, svgEl('rect', {
    x: cx - 26, y: tubeY - 8, width: 52, height: 16, rx: 8, class: 'ap-tube',
  }));
  append(g,
    svgEl('line', { x1: cx - 9, y1: tubeY - 8, x2: cx - 9, y2: tubeY + 8, class: 'ap-tube-ref' }),
    svgEl('line', { x1: cx + 9, y1: tubeY - 8, x2: cx + 9, y2: tubeY + 8, class: 'ap-tube-ref' }));
  const ball = svgEl('circle', { cx, cy: tubeY, r: 6, class: 'ap-ball' });
  g.appendChild(ball);

  const MAX_BANK_DEG = 35;      // visual clamp for the little plane
  const MAX_BALL_PX = 16;
  return (turnRateDegPerSec, betaRad) => {
    const rate = clamp(safeNum(turnRateDegPerSec, 0), -12, 12);
    // 3 deg/s (standard rate) maps to the +-20 deg doghouse marks
    const visualDeg = clamp(rate / 3 * 20, -MAX_BANK_DEG, MAX_BANK_DEG);
    plane.setAttribute('transform', `rotate(${visualDeg} ${cx} ${cy})`);
    const betaDeg = safeNum(betaRad, 0) * RAD2DEG;
    const ballX = cx + clamp(-betaDeg / 15 * MAX_BALL_PX, -MAX_BALL_PX, MAX_BALL_PX);
    ball.setAttribute('cx', ballX);
  };
}

function buildHeading(g, cx, cy) {
  buildBezel(g, cx, cy, 'HDG');
  const card = svgEl('g');
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = 0; d < 360; d += 10) {
    const major = d % 30 === 0;
    append(card, tickLine(cx, cy, d, R - 4, R - (major ? 14 : 8), major ? 'ap-tick ap-tick-major' : 'ap-tick'));
    if (major) {
      const txt = names[d] || String(d / 10).padStart(2, '0');
      append(card, label(cx, cy, d, R - 24, txt, names[d] ? 'ap-label ap-cardinal' : 'ap-label'));
    }
  }
  g.appendChild(card);
  // fixed lubber line (case reference) at top
  append(g, svgEl('polygon', {
    points: `${cx},${cy - R + 2} ${cx - 5},${cy - R + 14} ${cx + 5},${cy - R + 14}`,
    class: 'ap-lubber',
  }));
  return (headingDeg) => {
    const h = ((safeNum(headingDeg, 0) % 360) + 360) % 360;
    card.setAttribute('transform', `rotate(${-h} ${cx} ${cy})`);
  };
}

function buildVSI(g, cx, cy) {
  buildBezel(g, cx, cy, 'VSI · FPM×100');
  // 0 fpm at 9-o'clock (270deg), climb sweeps clockwise up through 12 to ~360/0,
  // descent sweeps counter-clockwise down through 6.
  const v2d = (fpm) => 270 + clamp(fpm, -2000, 2000) / 2000 * 90;
  for (const v of [-2000, -1500, -1000, -500, 0, 500, 1000, 1500, 2000]) {
    const deg = v2d(v);
    append(g, tickLine(cx, cy, deg, R - 4, R - 14, 'ap-tick ap-tick-major'));
    append(g, label(cx, cy, deg, R - 26, String(Math.abs(v) / 100), 'ap-label'));
  }
  append(g, label(cx, cy, 315, R - 42, 'UP', 'ap-caption-small'));
  append(g, label(cx, cy, 225, R - 42, 'DOWN', 'ap-caption-small'));
  const needle = needleShape(cx, cy, R - 10, R * 0.1, 3.4, 'ap-needle');
  // needle is drawn pointing up (0deg=up); rotate by (v2d(value) - 270) extra
  // offset isn't needed since our tick angles already use the same convention
  // as needleShape's 0deg=up reference via rotate(), so rotate by v2d(value).
  append(g, needle, svgEl('circle', { cx, cy, r: 6.5, class: 'ap-hub' }));
  return (fpm) => {
    needle.setAttribute('transform', `rotate(${v2d(safeNum(fpm, 0))} ${cx} ${cy})`);
  };
}

// ---------- style ----------

const STYLE = `
.ap-panel {
  position: fixed; left: 50%; bottom: 0.9rem; transform: translateX(-50%);
  width: min(94vw, 620px); z-index: 45; pointer-events: none; user-select: none;
  display: none; filter: drop-shadow(0 6px 18px rgba(0,0,0,.45));
}
.ap-panel.ap-visible { display: block; }
.ap-svg { width: 100%; height: auto; display: block; }
.ap-bezel { fill: #10151a; stroke: var(--ink-dim, #9aa7b2); stroke-width: 2; }
.ap-face { fill: #0c1116; stroke: var(--panel-line, rgba(232,237,242,.28)); stroke-width: 1; }
.ap-caption {
  font-family: "B612 Mono", ui-monospace, monospace; font-size: 9px;
  letter-spacing: .08em; fill: var(--ink-dim, #9aa7b2);
}
.ap-caption-small {
  font-family: "B612 Mono", ui-monospace, monospace; font-size: 7px;
  letter-spacing: .06em; fill: var(--ink-dim, #9aa7b2);
}
.ap-tick { stroke: var(--ink-dim, #9aa7b2); stroke-width: 1; }
.ap-tick-major { stroke: var(--ink, #e8edf2); stroke-width: 1.6; }
/* ASI airspeed arcs — the panel had none, so nothing showed you the limits. */
.ap-arc-white { stroke: #e8edf2; stroke-width: 3.2; opacity: .85; }
.ap-arc-green { stroke: #35c46a; stroke-width: 3.6; }
.ap-arc-yellow { stroke: var(--amber, #ffb300); stroke-width: 3.6; }
.ap-vne { stroke: var(--warn, #ff3b30); stroke-width: 3.4; }
.ap-label {
  font-family: "B612 Mono", ui-monospace, monospace; font-size: 10px;
  fill: var(--ink, #e8edf2);
}
.ap-cardinal { font-size: 12px; font-weight: 700; fill: var(--amber, #ffb300); }
.ap-needle { fill: var(--amber, #ffb300); }
.ap-needle-short { fill: var(--ink, #e8edf2); }
.ap-hub { fill: #1a2129; stroke: var(--ink-dim, #9aa7b2); stroke-width: 1; }
.ap-sky { fill: #2a5c8a; }
.ap-ground { fill: #6b4a2a; }
.ap-horizon-line { stroke: var(--ink, #e8edf2); stroke-width: 2; }
.ap-pitch-tick { stroke: var(--ink, #e8edf2); stroke-width: 1.3; }
.ap-bank-pointer { fill: var(--ink, #e8edf2); }
.ap-ai-wing { stroke: var(--amber, #ffb300); stroke-width: 3; stroke-linecap: round; }
.ap-lubber { fill: var(--amber, #ffb300); }
.ap-tc-wing { fill: var(--ink, #e8edf2); }
.ap-tc-fin { fill: var(--ink, #e8edf2); }
.ap-tc-dot { fill: var(--amber, #ffb300); }
.ap-tube { fill: #0c1116; stroke: var(--ink-dim, #9aa7b2); stroke-width: 1; }
.ap-tube-ref { stroke: var(--ink-dim, #9aa7b2); stroke-width: 1.4; }
.ap-ball { fill: var(--ink, #e8edf2); stroke: var(--ink-dim, #9aa7b2); stroke-width: 1; }
/* v5-R3: unpowered avionics dim the gauge faces */
.ap-panel.ap-unpowered .ap-svg { opacity: .26; }
/* engine-management switch strip (C172 study level) */
.ap-switches {
  display: none; pointer-events: auto; margin-top: .35rem;
  background: rgba(16,21,26,.85); border: 1px solid rgba(232,237,242,.25);
  border-left: 3px solid #ffb300; padding: .35rem .5rem;
  font-family: "B612 Mono", ui-monospace, monospace; font-size: .58rem;
  letter-spacing: .12em; color: #9aa7b2;
  gap: .5rem; align-items: center; justify-content: center; flex-wrap: wrap;
}
.ap-panel.ap-has-sys .ap-switches { display: flex; }
.ap-sw {
  background: #10151a; color: #9aa7b2; border: 1px solid rgba(232,237,242,.3);
  font: inherit; letter-spacing: .12em; padding: .3rem .55rem; cursor: pointer;
}
.ap-sw.on { color: #ffb300; border-color: #ffb300; }
.ap-sw:active { transform: translateY(1px); }
.ap-batt { display: inline-block; width: 3.2rem; height: .45rem;
  border: 1px solid rgba(232,237,242,.3); vertical-align: middle; }
.ap-batt i { display: block; height: 100%; background: #63d97c; }
.ap-batt.low i { background: #ff5b45; }
/* live checklist card (shown while cold & dark) */
.ap-chk {
  display: none; pointer-events: none; margin-bottom: .35rem;
  background: rgba(16,21,26,.85); border: 1px solid rgba(232,237,242,.25);
  border-left: 3px solid #ffb300; padding: .4rem .6rem;
  font-family: "B612 Mono", ui-monospace, monospace; font-size: .6rem;
  letter-spacing: .1em; color: #9aa7b2;
}
.ap-panel.ap-show-chk .ap-chk { display: block; }
.ap-chk .t { color: #e8edf2; letter-spacing: .2em; margin-bottom: .2rem; }
.ap-chk li { list-style: none; margin: .12rem 0; }
.ap-chk li.done { color: #63d97c; }
.ap-chk li.done::before { content: '\\2713  '; }
.ap-chk li::before { content: '\\25CB  '; }
`;

let styleInjected = false;
function ensureStyle() {
  if (styleInjected || document.getElementById('ap-panel-style')) { styleInjected = true; return; }
  const style = document.createElement('style');
  style.id = 'ap-panel-style';
  style.textContent = STYLE;
  document.head.appendChild(style);
  styleInjected = true;
}

/**
 * Build a steam six-pack instrument panel.
 *
 * @returns {{
 *   mount: (parentEl?: Element) => HTMLElement,  // build DOM once; parentEl defaults to document.body
 *   update: (ac: object) => void,                // call every frame, no-op if not mounted
 *   setVisible: (on: boolean) => void,
 *   toggle: () => boolean,                        // returns new visibility
 *   isVisible: () => boolean,
 *   destroy: () => void,                          // remove DOM (rarely needed)
 * }}
 *
 * Container: <div id="ap-sixpack" class="ap-panel">, fixed, bottom-center,
 * pointer-events:none, hidden by default (no "ap-visible" class until shown).
 */
export function createPanel() {
  let root = null;       // container div
  let visible = false;
  const updaters = {};   // gauge-name -> update closure
  // v5-R3 engine-management UI state
  let chkEl = null, swEl = null, curAc = null, runSince = null;

  function mount(parentEl) {
    if (root) return root; // idempotent
    ensureStyle();
    const parent = parentEl || document.body;

    root = document.createElement('div');
    root.id = 'ap-sixpack';
    root.className = 'ap-panel';

    const svg = svgEl('svg', { class: 'ap-svg', viewBox: `0 0 ${VB_W} ${VB_H}`, xmlns: SVGNS });

    const gAsi = svgEl('g'); svg.appendChild(gAsi);
    updaters.asi = buildASI(gAsi, COLS[0], ROWS[0]);

    const gAtt = svgEl('g'); svg.appendChild(gAtt);
    updaters.attitude = buildAttitude(gAtt, COLS[1], ROWS[0]);

    const gAlt = svgEl('g'); svg.appendChild(gAlt);
    updaters.altimeter = buildAltimeter(gAlt, COLS[2], ROWS[0]);

    const gTc = svgEl('g'); svg.appendChild(gTc);
    updaters.turnCoord = buildTurnCoordinator(gTc, COLS[0], ROWS[1]);

    const gHdg = svgEl('g'); svg.appendChild(gHdg);
    updaters.heading = buildHeading(gHdg, COLS[1], ROWS[1]);

    const gVsi = svgEl('g'); svg.appendChild(gVsi);
    updaters.vsi = buildVSI(gVsi, COLS[2], ROWS[1]);

    root.appendChild(svg);

    // v5-R3: live start checklist (above the gauges) + engine-management
    // switches (below). Only shown for aircraft with p.startup (the C172).
    chkEl = document.createElement('div');
    chkEl.className = 'ap-chk';
    chkEl.innerHTML = `<div class="t">START CHECKLIST</div><ul>
      <li data-chk="bat">Battery master — ON</li>
      <li data-chk="mix">Mixture — RICH</li>
      <li data-chk="start">Hold START until the engine catches</li>
      <li data-chk="run">Engine running — throttle when ready</li></ul>`;
    root.insertBefore(chkEl, svg);

    swEl = document.createElement('div');
    swEl.className = 'ap-switches';
    swEl.innerHTML =
      `<button class="ap-sw" data-sw="bat">BAT</button>` +
      `<span class="ap-batt"><i style="width:100%"></i></span>` +
      `<button class="ap-sw" data-sw="mags">MAGS BOTH</button>` +
      `<button class="ap-sw" data-sw="start">START</button>` +
      `<button class="ap-sw" data-sw="mix">MIX RICH</button>`;
    root.appendChild(swEl);
    const sw = (n) => swEl.querySelector(`[data-sw="${n}"]`);
    sw('bat').addEventListener('click', () => { if (curAc) curAc.sys.battery = !curAc.sys.battery; });
    sw('mix').addEventListener('click', () => { if (curAc) curAc.sys.mixture = curAc.sys.mixture > 0.3 ? 0 : 1; });
    const MAG_CYCLE = ['OFF', 'R', 'L', 'BOTH'];
    sw('mags').addEventListener('click', () => {
      if (!curAc || curAc.sys.mags === 'START') return;
      curAc.sys.mags = MAG_CYCLE[(MAG_CYCLE.indexOf(curAc.sys.mags) + 1) % MAG_CYCLE.length];
    });
    // START is a spring-loaded key: held = cranking, released = BOTH.
    const startDown = () => { if (curAc) curAc.sys.mags = 'START'; };
    const startUp = () => { if (curAc && curAc.sys.mags === 'START') curAc.sys.mags = 'BOTH'; };
    sw('start').addEventListener('pointerdown', startDown);
    sw('start').addEventListener('pointerup', startUp);
    sw('start').addEventListener('pointerleave', startUp);

    parent.appendChild(root);
    return root;
  }

  function update(ac) {
    if (!root || !ac) return;
    curAc = ac;

    // v5-R3: engine-management strip + checklist + unpowered dimming.
    const hasSys = !!ac.p?.startup;
    root.classList.toggle('ap-has-sys', hasSys);
    root.classList.toggle('ap-unpowered', hasSys && ac.avionics === false);
    if (hasSys && swEl) {
      const s = ac.sys || {};
      const q = (n) => swEl.querySelector(`[data-sw="${n}"]`);
      q('bat').classList.toggle('on', !!s.battery);
      q('mix').classList.toggle('on', s.mixture > 0.3);
      q('mix').textContent = s.mixture > 0.3 ? 'MIX RICH' : 'MIX CUT';
      q('mags').classList.toggle('on', s.mags !== 'OFF');
      q('mags').textContent = 'MAGS ' + (s.mags === 'START' ? 'START' : s.mags);
      q('start').classList.toggle('on', s.mags === 'START');
      const bar = swEl.querySelector('.ap-batt');
      bar.classList.toggle('low', ac.batteryCharge < 0.25);
      bar.firstElementChild.style.width = `${Math.round(safeNum(ac.batteryCharge, 0) * 100)}%`;
      // checklist: visible while cold; ticks live; hides a few s after start
      if (ac.engineRunning) { if (runSince == null) runSince = Date.now(); }
      else runSince = null;
      root.classList.toggle('ap-show-chk', visible && (!ac.engineRunning || Date.now() - runSince < 5000));
      const tick = (n, done) => chkEl.querySelector(`[data-chk="${n}"]`).classList.toggle('done', !!done);
      tick('bat', s.battery);
      tick('mix', s.mixture > 0.3);
      tick('start', ac.engineRunning || ac.crankT > 0.2);
      tick('run', ac.engineRunning);
    } else {
      root.classList.remove('ap-show-chk');
    }

    const iasKt = safeNum(ac.iasIndicated, 0) * KT;
    const altFt = safeNum(ac?.pos?.y, 0) * FT;
    const vsiFpm = safeNum(ac?.vel?.y, 0) * FT * 60;
    const yawRate = safeNum(ac?.omega?.y, 0);          // +y = nose LEFT
    const turnRateDegPerSec = -yawRate * RAD2DEG;       // positive = turning RIGHT
    const betaRad = safeNum(ac.beta, 0);

    let pitch = 0, roll = 0, headingDeg = 0;
    try {
      const att = attitude(ac);
      pitch = safeNum(att.pitch, 0) * RAD2DEG;
      roll = safeNum(att.roll, 0) * RAD2DEG;
      // compass convention: attitude().heading is 0=east, +ccw-from-above;
      // convert to standard compass degrees (0=N, clockwise), matching hud.js.
      headingDeg = (90 - safeNum(att.heading, 0) * RAD2DEG + 360) % 360;
    } catch {
      // ac.q missing/malformed on this call — hold last-known display attitude at level/0.
    }

    updaters.asi(iasKt, ac.p);
    updaters.attitude(pitch, roll);
    updaters.altimeter(altFt);
    updaters.turnCoord(turnRateDegPerSec, betaRad);
    updaters.heading(headingDeg);
    updaters.vsi(vsiFpm);
  }

  function setVisible(on) {
    visible = !!on;
    if (root) root.classList.toggle('ap-visible', visible);
  }

  function toggle() {
    setVisible(!visible);
    return visible;
  }

  function isVisible() {
    return visible;
  }

  function destroy() {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    visible = false;
  }

  return { mount, update, setVisible, toggle, isVisible, destroy };
}
