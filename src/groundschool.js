// src/groundschool.js — ARCHIPELAGO glossary content + renderer.
//
// Self-contained ES module: DOM only, no Three.js, no other project imports.
// Exports the flip-card glossary data and a render helper that builds the
// glossary screen's DOM into a mount element the integrator provides (an
// empty `<div class="screen">` added to index.html, matching the existing
// menu / lessons / pause / crash / results screens).
//
// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------
//   import { GLOSSARY, renderGlossary } from './groundschool.js';
//
//   renderGlossary(mountEl, opts?)
//     - mountEl: the empty `.screen` div (e.g. document.getElementById('groundschool')).
//       Its innerHTML is fully replaced with the glossary layout (kicker, title,
//       intro, flip-card grid, back button).
//     - opts.backAct: value for the back button's data-act attribute
//       (default 'menu' — matches modes.js's existing global
//       `[data-act]` click wiring, so no extra JS is needed to make BACK work).
//     - Cards flip (front = term, back = plain-language explanation) on click
//       or Enter/Space when focused; each card is a real <button> for
//       keyboard and screen-reader access.
//     - Injects its own <style> block (once) so the integrator needs no CSS edits.
//     - Returns nothing; call again to re-render if needed.
//
//   GLOSSARY: array of { term: string, back: string }, >=10 entries, in the
//   fixed order below (flaps, trim, stall & AoA, IAS vs ground speed, VS/AGL,
//   pattern legs, PAPI, slip ball, flare, go-around).

const STYLE_ID = 'archipelago-groundschool-style';

export const GLOSSARY = [
  {
    term: 'FLAPS',
    back: "Panels that drop down from the back of the wing to add lift and drag, so you can fly slower and steeper without stalling. Handy for a gentler, shorter landing.",
  },
  {
    term: 'TRIM',
    back: "A small adjustment that holds your nose at a chosen pitch without you holding the stick. Set it once for level cruise and your arm gets a break.",
  },
  {
    term: 'STALL & AoA',
    back: "A stall happens when the wing tilts too steeply into the oncoming air — the angle of attack, or AoA — and stops making lift, so the nose drops. Push the nose down and add power to recover.",
  },
  {
    term: 'IAS vs GROUND SPEED',
    back: "IAS (indicated airspeed) is how fast you move through the air; ground speed is how fast you move over the ground. Wind makes these different — a headwind slows your ground speed, a tailwind speeds it up.",
  },
  {
    term: 'VS / AGL',
    back: "VS (vertical speed) is how fast you're climbing or descending; AGL (above ground level) is your height over the actual terrain below, not sea level. Use VS to plan a smooth descent and AGL to know how close the ground really is.",
  },
  {
    term: 'PATTERN LEGS',
    back: "The traffic pattern is a rectangular path around the runway with named legs — upwind, crosswind, downwind, base, and final. Flying it keeps every plane predictable near a busy airport.",
  },
  {
    term: 'PAPI',
    back: "Precision Approach Path Indicator — a row of lights beside the runway showing whether you're above, on, or below the ideal glide path. Two white and two red means you're right on target; all red means too low.",
  },
  {
    term: 'SLIP BALL',
    back: "A small ball in a curved tube that shows whether you're flying straight through the air or skidding sideways. Center it with rudder to keep the flight coordinated and comfortable.",
  },
  {
    term: 'FLARE',
    back: "The gentle nose-up pull just before touchdown that slows your descent so the wheels meet the runway smoothly. Too early and you balloon back up; too late and you land hard.",
  },
  {
    term: 'GO-AROUND',
    back: "Abandoning a landing attempt — full throttle, nose up, climb away — when the approach isn't safe to continue. Always the right call the moment anything looks or feels wrong.",
  },
];

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .gs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
      gap: 1rem; margin-top: 1.6rem; max-width: 52rem; }
    .gs-card { perspective: 60rem; height: 8rem; background: none; border: none; padding: 0;
      cursor: pointer; font: inherit; color: inherit; text-align: left; }
    .gs-card-inner { position: relative; width: 100%; height: 100%; transition: transform .5s;
      transform-style: preserve-3d; }
    .gs-card.flipped .gs-card-inner { transform: rotateY(180deg); }
    .gs-face { position: absolute; inset: 0; backface-visibility: hidden;
      background: rgba(16, 21, 26, 0.72); border: 1px solid rgba(232,237,242,.28);
      border-left: 3px solid #ffb300; padding: .8rem .9rem; display: flex;
      align-items: center; font-family: "B612", system-ui, sans-serif; }
    .gs-face.gs-front { font-family: "B612 Mono", ui-monospace, monospace;
      font-size: 1.02rem; font-weight: 700; letter-spacing: .04em; color: #e8edf2; }
    .gs-face.gs-back { transform: rotateY(180deg); font-size: .8rem; line-height: 1.45;
      color: #e8edf2; align-items: flex-start; overflow-y: auto; }
    .gs-card:hover .gs-face, .gs-card:focus-visible .gs-face { border-color: rgba(255,179,0,.6); }
    .gs-card:focus-visible { outline: none; }
    .gs-hint { font-family: "B612 Mono", ui-monospace, monospace; font-size: .6rem;
      letter-spacing: .18em; color: #9aa7b2; margin-top: 1.2rem; }
  `;
  document.head.appendChild(style);
}

/**
 * @param {HTMLElement} mountEl empty `.screen` div to populate
 * @param {object} [opts]
 * @param {string} [opts.backAct] data-act value for the back button (default 'menu')
 */
export function renderGlossary(mountEl, opts = {}) {
  if (!mountEl) return;
  injectStyles();

  const backAct = opts.backAct || 'menu';

  mountEl.innerHTML = `
    <div class="inner">
      <div class="kicker">GROUND SCHOOL</div>
      <h1>GLOSSARY<em>.</em></h1>
      <p class="sub">Every term the HUD and instructor use, in plain words. Click a card
        to flip it over.</p>
      <div class="gs-grid"></div>
      <div class="gs-hint">CLICK OR ENTER TO FLIP</div>
      <div class="btnrow" style="margin-top:1.4rem">
        <button class="btn" data-act="${backAct}"><span class="no">&larr;</span> BACK</button>
      </div>
    </div>`;

  const grid = mountEl.querySelector('.gs-grid');
  GLOSSARY.forEach(({ term, back }) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'gs-card';
    card.setAttribute('aria-label', `${term} — tap to flip`);
    card.innerHTML = `
      <div class="gs-card-inner">
        <div class="gs-face gs-front">${term}</div>
        <div class="gs-face gs-back">${back}</div>
      </div>`;
    card.addEventListener('click', () => card.classList.toggle('flipped'));
    grid.appendChild(card);
  });
}
