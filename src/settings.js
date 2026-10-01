// Settings: a small persisted model + the SETTINGS screen renderer.
// The model (loadSettings/saveSettings) is pure localStorage JSON under
// archipelago.settings; applying a setting is the caller's job (modes.js wires
// volume -> audio, invert/mouse/gamepad -> controls, pixel-ratio -> renderer),
// so this module stays free of engine imports.

const KEY = 'archipelago.settings';
const STYLE_ID = 'settings-style';

export const DEFAULTS = {
  volume: 0.5,         // 0..1 MASTER gain (sfx + music ride inside it)
  sfxVolume: 1,        // engine, wind, stall horn, touchdown, UI
  musicVolume: 0.6,    // wired to the music bus; no track ships yet
  muted: false,        // one switch that silences everything
  invertPitch: false,  // applies to mouse-fly + gamepad pitch only (arrows stay semantic)
  pixelRatioCap: 2,    // renderer.setPixelRatio(min(devicePixelRatio, cap))
  mouseFly: true,      // hold right mouse button = stick
  gamepad: true,       // first connected gamepad drives the primary axes
  coldDark: false,     // v5-R3: C172 spawns shut down; run the start checklist
  atc: true,           // v5-R5: spoken tower calls + transcript (off during lessons)
  quality: 'high',     // v6: 'low' = near terrain only, no shadows | 'high' = both
  autoRes: true,       // dynamic resolution: drop render scale when fps sags
};

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

// Each row cycles through its values on click (same feel as the menu selectors).
const ROWS = [
  { id: 'muted', label: 'MUTE', hint: 'silence everything — your levels are kept',
    values: [false, true], fmt: v => v ? 'ON' : 'OFF' },
  { id: 'volume', label: 'MASTER', hint: 'overall level; SFX and music sit inside it',
    values: [0, 0.15, 0.3, 0.5, 0.75, 1], fmt: v => v === 0 ? 'SILENT' : `${Math.round(v * 100)}%` },
  { id: 'sfxVolume', label: 'SFX', hint: 'engine, wind, stall horn, touchdown, chimes',
    values: [0, 0.25, 0.5, 0.75, 1], fmt: v => v === 0 ? 'OFF' : `${Math.round(v * 100)}%` },
  { id: 'musicVolume', label: 'MUSIC', hint: 'reserved for a soundtrack — no track ships yet',
    values: [0, 0.25, 0.5, 0.6, 0.8, 1], fmt: v => v === 0 ? 'OFF' : `${Math.round(v * 100)}%` },
  { id: 'invertPitch', label: 'INVERT PITCH', hint: 'mouse-fly & gamepad only — push forward = nose down',
    values: [false, true], fmt: v => v ? 'ON' : 'OFF' },
  { id: 'pixelRatioCap', label: 'PIXEL RATIO', hint: 'lower = faster on high-DPI screens',
    values: [1, 1.5, 2], fmt: v => `${v}×` },
  { id: 'mouseFly', label: 'MOUSE-FLY', hint: 'hold the right mouse button to fly with the mouse',
    values: [true, false], fmt: v => v ? 'ON' : 'OFF' },
  { id: 'gamepad', label: 'GAMEPAD', hint: 'left stick pitch/roll, right stick rudder/throttle',
    values: [true, false], fmt: v => v ? 'ON' : 'OFF' },
  { id: 'coldDark', label: 'COLD & DARK', hint: 'Skyhawk spawns shut down — run the real start checklist (I opens the panel)',
    values: [false, true], fmt: v => v ? 'ON' : 'OFF' },
  { id: 'atc', label: 'ATC', hint: 'tower talks you round the circuit — stays quiet during lessons',
    values: [true, false], fmt: v => v ? 'ON' : 'OFF' },
  { id: 'autoRes', label: 'DYNAMIC RES', hint: 'renders at a lower resolution when the frame rate sags, back up when it recovers',
    values: [true, false], fmt: v => v ? 'ON' : 'OFF' },
  { id: 'quality', label: 'QUALITY', hint: 'HIGH draws terrain to 9 km and casts real shadows; LOW is the lighter old view',
    values: ['high', 'low'], fmt: v => v.toUpperCase() },
];

// Populate the #settings screen. onChange(next) fires with the full settings
// object after every edit (caller persists + applies).
export function renderSettings(mountEl, { settings, onChange }) {
  injectStyles();
  mountEl.innerHTML = `
    <div class="kicker">CONFIGURATION</div>
    <h1>SETTINGS</h1>
    <div class="sub">Changes apply immediately and persist between flights.</div>
    <div class="set-rows"></div>
    <div style="margin-top:1.6rem">
      <button class="btn" data-act="menu"><span class="no">&larr;</span> BACK</button>
    </div>`;
  const rowsEl = mountEl.querySelector('.set-rows');
  for (const row of ROWS) {
    const el = document.createElement('button');
    el.className = 'btn set-row';
    el.dataset.setting = row.id;
    el.innerHTML =
      `<span class="set-label">${row.label}</span>` +
      `<span class="set-value"></span>` +
      `<span class="set-hint">${row.hint}</span>`;
    el.addEventListener('click', () => {
      const i = row.values.findIndex(v => v === settings[row.id]);
      settings[row.id] = row.values[(i + 1) % row.values.length];
      paint();
      onChange(settings);
    });
    rowsEl.appendChild(el);
  }
  const paint = () => {
    for (const row of ROWS) {
      const el = rowsEl.querySelector(`[data-setting="${row.id}"] .set-value`);
      const v = settings[row.id];
      el.textContent = row.fmt(row.values.includes(v) ? v : row.values[0]);
    }
  };
  paint();
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .set-rows { display: grid; grid-template-columns: 1fr; gap: .55rem; margin-top: 1.4rem;
      max-width: 34rem; }
    .set-row { display: grid !important; grid-template-columns: 11rem 6rem 1fr; gap: 1rem;
      align-items: baseline; text-align: left; background: rgba(16,21,26,.72);
      border: 1px solid rgba(232,237,242,.28); border-left: 3px solid #ffb300;
      padding: .6rem .85rem; pointer-events: auto; }
    .set-row:hover { border-color: #ffb300; }
    .set-label { font-family: "B612 Mono", ui-monospace, monospace; font-size: .62rem;
      letter-spacing: .22em; color: #9aa7b2; }
    .set-value { font-family: "B612 Mono", ui-monospace, monospace; font-size: .85rem;
      font-weight: 700; color: #ffb300; }
    .set-hint { font-size: .6rem; color: #9aa7b2; letter-spacing: .04em; }
    @media (max-width: 40rem) { .set-row { grid-template-columns: 1fr; gap: .15rem; } }
  `;
  document.head.appendChild(style);
}
