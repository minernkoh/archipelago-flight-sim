// src/tour.js — ARCHIPELAGO HUD guided tour engine.
//
// Self-contained ES module: DOM + localStorage only, no Three.js, no other
// project imports. Drives a "spotlight" tour that dims the screen and
// highlights one HUD element at a time with a plain-language explanation.
//
// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------
//   import { createTour, DEFAULT_CARDS, DEFAULT_KEYLIST_HTML } from './tour.js';
//
//   const tour = createTour({
//     cards,            // optional: array of spotlight cards, replaces DEFAULT_CARDS
//     finalCardHTML,     // optional: HTML string for the closing "key list" card
//     finalCardTitle,     // optional: title for the closing card (default 'KEYBOARD CONTROLS')
//     storageKey,         // optional: localStorage key for the "seen it" flag
//   });
//
//   tour.open()          -> opens the tour immediately at card 1, regardless of history.
//   tour.close()          -> closes the tour and tears down its listeners.
//   tour.isOpen()          -> boolean, current open/closed state.
//   tour.offerOnce()        -> opens the tour ONLY the first time ever called for this
//                             browser (keyed on localStorage[storageKey]); returns true
//                             if it opened, false if it had already been offered before.
//                             Call this whenever the integrator decides "first flight"
//                             has begun; safe to call every flight, it's a no-op after
//                             the first time.
//   tour.hasBeenOffered()    -> boolean, whether offerOnce() has ever fired before.
//   tour.reset()            -> clears the storage flag (handy for QA / a "replay tour"
//                             menu item that should ignore the once-only gate).
//
// Card shape: { title: string, body?: string, html?: string, targetId?: string }
//   - targetId: id of a HUD element to spotlight (e.g. 'tape-spd'). Omit for a
//     plain centered card with no spotlight (used by the final key-list card).
//   - body: plain text, escaped and shown as-is (use for spotlight cards).
//   - html: raw HTML, used verbatim (use for the final key-list card so the
//     integrator can inject markup like "<b>W</b> throttle").
//
// Space or click anywhere in the tour advances to the next card (closing the
// tour from the last card). Esc closes the tour at any point. Backdrop rects
// are computed against document.body in viewport coordinates at card-show
// time (and recomputed on window resize) because HUD elements are absolutely
// positioned inside #hud with vw/vh units.

const STYLE_ID = 'archipelago-tour-style';

export const DEFAULT_KEYLIST_HTML = `
  <div class="tour-keys">
    <div><b>&uarr;&darr;</b> pitch&nbsp; <b>&larr;&rarr;</b> roll&nbsp; <b>A</b>/<b>D</b> rudder</div>
    <div><b>W</b>/<b>S</b> throttle&nbsp; <b>F</b> flaps, <b>shift+F</b> retract&nbsp; <b>B</b> brakes</div>
    <div><b>[</b>/<b>]</b> trim&nbsp; <b>C</b> camera&nbsp; <b>R</b> reset</div>
    <div><b>ESC</b> pause&nbsp; <b>?</b> hide this HUD help</div>
  </div>`;

export const DEFAULT_CARDS = [
  {
    title: 'AIRSPEED',
    targetId: 'tape-spd',
    body: "This tape shows your airspeed — how fast you're moving through the air, in knots. Too slow near the ground and the wings can stop flying; too fast and you strain the airframe.",
  },
  {
    title: 'ALTITUDE',
    targetId: 'tape-alt',
    body: "This tape shows your altitude — your height above sea level, in feet. It's the number pilots use to stay clear of each other and of terrain far away.",
  },
  {
    title: 'HEADING',
    targetId: 'heading',
    body: 'This is your heading — the compass direction your nose points, from 0 to 360 degrees. North is 360 (or 0), east is 90, south is 180, and so on around the dial.',
  },
  {
    title: 'VERTICAL SPEED',
    targetId: 'vsi',
    body: "This is your vertical speed — how fast you're climbing or descending, in feet per minute. Positive means climbing, negative means descending, zero means flying level.",
  },
  {
    title: 'RADAR ALTITUDE (AGL)',
    targetId: 'radalt',
    body: "This is your height above the actual ground right beneath you — not sea level. It's the number that matters most when a hill or ridge is closer than the altitude tape makes it look.",
  },
  {
    title: 'STATUS BAR',
    targetId: 'status',
    body: 'This bar shows your throttle, flaps, brakes, trim, and camera at a glance. Flaps are wing panels that drop down to help you fly slower for landing; trim is a setting that holds your pitch steady so you can let go of the stick.',
  },
  {
    title: 'WARNING LIGHTS',
    targetId: 'annunciator',
    body: "These flash when something needs attention right now: STALL means the wings have stopped producing lift and the nose will drop, OVERSPEED means you're flying too fast for the airframe. Ease off immediately when you see either one.",
  },
];

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .tour-root { position: fixed; inset: 0; z-index: 500; cursor: pointer;
      font-family: "B612", system-ui, sans-serif; color: #e8edf2; }
    .tour-root.hidden { display: none; }
    .tour-dim { position: fixed; background: rgba(9, 13, 17, 0.82);
      transition: all .18s ease; pointer-events: none; }
    .tour-outline { position: fixed; border: 2px solid #ffb300; border-radius: 4px;
      box-shadow: 0 0 0 2px rgba(255,179,0,.25), 0 0 22px rgba(255,179,0,.55);
      transition: all .18s ease; pointer-events: none; display: none; }
    .tour-outline.show { display: block; }
    .tour-card { position: fixed; left: 50%; bottom: max(9vh, 4.5rem); transform: translateX(-50%);
      width: min(30rem, 86vw); background: rgba(16, 21, 26, 0.92); border: 1px solid rgba(232,237,242,.28);
      border-left: 3px solid #ffb300; padding: .9rem 1.15rem 1rem; pointer-events: auto; cursor: default; }
    .tour-card.tour-card--center { bottom: auto; top: 50%; transform: translate(-50%, -50%); }
    .tour-kicker { font-family: "B612 Mono", ui-monospace, monospace; font-size: .62rem;
      letter-spacing: .3em; color: #ffb300; margin-bottom: .4rem; }
    .tour-title { font-size: 1.05rem; font-weight: 700; letter-spacing: .02em; margin-bottom: .4rem; }
    .tour-body { font-size: .92rem; line-height: 1.5; color: #e8edf2; }
    .tour-keys { font-family: "B612 Mono", ui-monospace, monospace; font-size: .8rem;
      line-height: 2; color: #e8edf2; }
    .tour-keys b { font-family: "B612 Mono", ui-monospace, monospace; font-weight: 400;
      background: rgba(232,237,242,.12); padding: 0 .35em; border-radius: 2px; }
    .tour-foot { margin-top: .65rem; display: flex; align-items: center; justify-content: space-between; }
    .tour-dots { display: flex; gap: .3rem; }
    .tour-dots i { width: 1.1rem; height: .22rem; background: rgba(232,237,242,.18); display: block; }
    .tour-dots i.done { background: #63d97c; }
    .tour-dots i.cur { background: #ffb300; }
    .tour-hint { font-family: "B612 Mono", ui-monospace, monospace; font-size: .65rem;
      letter-spacing: .08em; color: #9aa7b2; white-space: nowrap; }
  `;
  document.head.appendChild(style);
}

/**
 * @param {object} [opts]
 * @param {Array}  [opts.cards] full replacement list of spotlight cards (defaults to DEFAULT_CARDS)
 * @param {string} [opts.finalCardHTML] raw HTML for the closing key-list card
 * @param {string} [opts.finalCardTitle] title for the closing key-list card
 * @param {string} [opts.storageKey] localStorage key used by offerOnce()/hasBeenOffered()
 */
export function createTour(opts = {}) {
  const spotlightCards = opts.cards || DEFAULT_CARDS;
  const finalCard = {
    title: opts.finalCardTitle || 'KEYBOARD CONTROLS',
    html: opts.finalCardHTML || DEFAULT_KEYLIST_HTML,
  };
  const cards = [...spotlightCards, finalCard];
  const storageKey = opts.storageKey || 'archipelago.toured';

  let idx = 0;
  let openFlag = false;
  let dom = null;

  function buildDOM() {
    const root = document.createElement('div');
    root.className = 'tour-root hidden';

    const dimTop = document.createElement('div');
    dimTop.className = 'tour-dim';
    const dimBottom = document.createElement('div');
    dimBottom.className = 'tour-dim';
    const dimLeft = document.createElement('div');
    dimLeft.className = 'tour-dim';
    const dimRight = document.createElement('div');
    dimRight.className = 'tour-dim';
    const outline = document.createElement('div');
    outline.className = 'tour-outline';

    const card = document.createElement('div');
    card.className = 'tour-card';
    card.innerHTML = `
      <div class="tour-kicker">GUIDED TOUR</div>
      <div class="tour-title"></div>
      <div class="tour-body"></div>
      <div class="tour-foot">
        <div class="tour-dots"></div>
        <div class="tour-hint">SPACE / CLICK next &nbsp;&middot;&nbsp; ESC skip</div>
      </div>`;

    root.append(dimTop, dimBottom, dimLeft, dimRight, outline, card);
    document.body.appendChild(root);

    return {
      root, dimTop, dimBottom, dimLeft, dimRight, outline, card,
      title: card.querySelector('.tour-title'),
      body: card.querySelector('.tour-body'),
      dots: card.querySelector('.tour-dots'),
    };
  }

  function ensureDOM() {
    if (!dom) dom = buildDOM();
    return dom;
  }

  function layout() {
    if (!openFlag || !dom) return;
    const cardData = cards[idx];
    const target = cardData.targetId ? document.getElementById(cardData.targetId) : null;
    const rect = target ? target.getBoundingClientRect() : null;
    const PAD = 8;

    if (rect && rect.width > 0 && rect.height > 0) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const top = Math.max(0, rect.top - PAD);
      const bottom = Math.min(vh, rect.bottom + PAD);
      const left = Math.max(0, rect.left - PAD);
      const right = Math.min(vw, rect.right + PAD);

      Object.assign(dom.dimTop.style, { top: '0px', left: '0px', width: '100%', height: `${top}px` });
      Object.assign(dom.dimBottom.style, { top: `${bottom}px`, left: '0px', width: '100%', height: `${Math.max(0, vh - bottom)}px` });
      Object.assign(dom.dimLeft.style, { top: `${top}px`, left: '0px', width: `${left}px`, height: `${Math.max(0, bottom - top)}px` });
      Object.assign(dom.dimRight.style, { top: `${top}px`, left: `${right}px`, width: `${Math.max(0, vw - right)}px`, height: `${Math.max(0, bottom - top)}px` });

      Object.assign(dom.outline.style, { top: `${top}px`, left: `${left}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      dom.outline.classList.add('show');
      dom.card.classList.remove('tour-card--center');
    } else {
      // No target (or target missing) — full-screen dim, centered card.
      Object.assign(dom.dimTop.style, { top: '0px', left: '0px', width: '100%', height: '100%' });
      Object.assign(dom.dimBottom.style, { width: '0px', height: '0px' });
      Object.assign(dom.dimLeft.style, { width: '0px', height: '0px' });
      Object.assign(dom.dimRight.style, { width: '0px', height: '0px' });
      dom.outline.classList.remove('show');
      dom.card.classList.add('tour-card--center');
    }

    dom.title.textContent = cardData.title;
    if (cardData.html != null) dom.body.innerHTML = cardData.html;
    else dom.body.textContent = cardData.body || '';

    dom.dots.innerHTML = '';
    cards.forEach((_, i) => {
      const dot = document.createElement('i');
      if (i < idx) dot.className = 'done';
      else if (i === idx) dot.className = 'cur';
      dom.dots.appendChild(dot);
    });
  }

  function next() {
    if (idx >= cards.length - 1) { close(); return; }
    idx += 1;
    layout();
  }

  function onKeydown(e) {
    if (!openFlag) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); next(); }
  }
  function onClick() { next(); }
  function onResize() { layout(); }

  function open() {
    ensureDOM();
    idx = 0;
    openFlag = true;
    dom.root.classList.remove('hidden');
    layout();
    window.addEventListener('keydown', onKeydown);
    dom.root.addEventListener('click', onClick);
    window.addEventListener('resize', onResize);
  }

  function close() {
    openFlag = false;
    if (dom) dom.root.classList.add('hidden');
    window.removeEventListener('keydown', onKeydown);
    if (dom) dom.root.removeEventListener('click', onClick);
    window.removeEventListener('resize', onResize);
  }

  function isOpen() { return openFlag; }

  function hasBeenOffered() {
    try { return window.localStorage.getItem(storageKey) === '1'; }
    catch { return false; }
  }

  function markOffered() {
    try { window.localStorage.setItem(storageKey, '1'); } catch { /* storage unavailable, ignore */ }
  }

  function offerOnce() {
    if (hasBeenOffered()) return false;
    markOffered();
    open();
    return true;
  }

  function reset() {
    try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
  }

  injectStyles();

  return { open, close, isOpen, offerOnce, hasBeenOffered, reset };
}
