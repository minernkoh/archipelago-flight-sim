// Live cockpit instruments drawn on a 2D canvas, used as the texture on the
// 3D instrument panel (cockpit.js). Two families:
//  - steam gauges (light aircraft): the classic six-pack plus RPM, fuel/oil
//    and a radio stack,
//  - glass (jets/airliner): PFD, ND and engine displays.
// Everything reads the live aircraft state; nothing here owns any state.

import { KT, FT, attitude } from './physics/flightModel.js';
import { vSpeeds } from './physics/envelope.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

/**
 * Radio-nav state for the displays (v12): the ILS deviations of the active
 * runway, in dots (+-5 full scale, + = fly right / fly up), or null when the
 * receiver has no usable signal. main.js writes it once per frame.
 */
export const NAV = { ils: null };
const MAG = '#ff4fd8';

/**
 * Clickable panel buttons (v12). Panels draw them into the same canvas as the
 * gauges and return their rectangles (canvas px) so cockpit.js can hit-test a
 * click by the texture coordinate. states: { [id]: false | true | 'label' }.
 */
function drawButtons(x, list, states, rect, cols) {
  const rows = Math.ceil(list.length / cols), bw = rect.w / cols, bh = rect.h / rows, hits = [];
  list.forEach((b, i) => {
    const X = rect.x + (i % cols) * bw, Y = rect.y + Math.floor(i / cols) * bh;
    const st = states[b.id], lit = !!st, pad = Math.min(bw, bh) * 0.08;
    x.fillStyle = '#2b2f35'; x.fillRect(X + pad, Y + pad, bw - 2 * pad, bh - 2 * pad);
    x.fillStyle = '#3a3f46'; x.fillRect(X + pad, Y + pad, bw - 2 * pad, Math.max(2, bh * 0.06));
    x.fillStyle = lit ? '#38e070' : '#0d2a16'; x.fillRect(X + bw * 0.25, Y + bh * 0.2, bw * 0.5, Math.max(3, bh * 0.1));
    x.fillStyle = '#e8e8e2'; x.font = `bold ${Math.min(bh * 0.32, bw * 0.24)}px "B612", Arial, sans-serif`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(typeof st === 'string' ? st : b.label, X + bw / 2, Y + bh * 0.62);
    hits.push({ id: b.id, x: X, y: Y, w: bw, h: bh });
  });
  return hits;
}

/** Values every display needs, in pilot units. */
export function readout(ac) {
  let pitch = 0, roll = 0, hdg = 0;
  try {
    // a failed vacuum pump leaves the gyro instruments showing ac.gyro
    const a = ac.gyro && ac.p?.engine?.type !== 'jet' ? ac.gyro : attitude(ac);
    pitch = a.pitch; roll = a.roll; hdg = (90 - a.heading / D2R + 720) % 360;
  } catch { /* hold level */ }
  return {
    ias: num(ac.iasIndicated) * KT,
    alt: num(ac.altIndicated ?? ac.pos?.y) * FT,
    vsi: num(ac.vsIndicated ?? ac.vel?.y) * FT * 60,
    turn: -num(ac.omega?.y) / D2R,          // deg/s, + = right
    slip: num(ac.beta),
    pitch, roll, hdg,
    rpm: num(ac.rpmNorm), spool: num(ac.spool ?? ac.rpmNorm),
    g: num(ac.gLoad, 1), mach: num(ac.mach),
  };
}

// ------------------------------------------------------------- steam --
function bezel(x, cx, cy, r) {
  const g = x.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r * 1.12);
  g.addColorStop(0, '#3a3e44'); g.addColorStop(1, '#111316');
  x.fillStyle = g;
  x.beginPath(); x.arc(cx, cy, r * 1.12, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#0c0d0f';
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
}
function glassGlint(x, cx, cy, r) {
  const g = x.createLinearGradient(cx - r, cy - r, cx + r * 0.2, cy + r * 0.2);
  g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.5, 'rgba(255,255,255,0.02)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
}
function needle(x, cx, cy, ang, len, w, col = '#f2f2ee') {
  x.save(); x.translate(cx, cy); x.rotate(ang);
  x.fillStyle = col;
  x.beginPath(); x.moveTo(-w, 0); x.lineTo(0, -len); x.lineTo(w, 0); x.lineTo(0, len * 0.18); x.closePath(); x.fill();
  x.restore();
  x.fillStyle = '#2a2c30'; x.beginPath(); x.arc(cx, cy, w * 1.4, 0, Math.PI * 2); x.fill();
}
function ticks(x, cx, cy, r, a0, a1, n, major, labels, fs) {
  x.strokeStyle = '#e8e8e2'; x.fillStyle = '#e8e8e2';
  x.font = `bold ${fs}px "B612", Arial, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n - Math.PI / 2;
    const big = i % major === 0;
    x.lineWidth = big ? 3 : 1.5;
    x.beginPath();
    x.moveTo(cx + Math.cos(a) * r * (big ? 0.78 : 0.85), cy + Math.sin(a) * r * (big ? 0.78 : 0.85));
    x.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
    x.stroke();
    if (big && labels) {
      const t = labels(i / major);
      if (t !== null) x.fillText(t, cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
    }
  }
}
function arc(x, cx, cy, r, a0, a1, col, w) {
  x.strokeStyle = col; x.lineWidth = w;
  x.beginPath(); x.arc(cx, cy, r, a0 - Math.PI / 2, a1 - Math.PI / 2); x.stroke();
}
function label(x, cx, cy, t, fs) {
  x.fillStyle = '#9aa0a6'; x.font = `${fs}px "B612", Arial, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(t, cx, cy);
}

function asi(x, cx, cy, r, kt, p, maxKt) {
  bezel(x, cx, cy, r);
  const s = vSpeeds(p);
  const A = (v) => clamp(v / maxKt, 0, 1) * Math.PI * 1.7 + 0.15;
  if (s.vfeKt) arc(x, cx, cy, r * 0.93, A(s.vs0Kt), A(s.vfeKt), '#e8e8e2', r * 0.05);
  arc(x, cx, cy, r * 0.88, A(s.vs1Kt), A(s.vnoKt || s.vneKt * 0.8), '#3fbf4f', r * 0.06);
  if (s.vnoKt) arc(x, cx, cy, r * 0.88, A(s.vnoKt), A(s.vneKt), '#e5c22a', r * 0.06);
  arc(x, cx, cy, r * 0.9, A(s.vneKt) - 0.015, A(s.vneKt) + 0.015, '#e0302a', r * 0.1);
  const step = maxKt > 400 ? 100 : maxKt > 220 ? 50 : 20;
  const n = Math.round(maxKt / step);
  ticks(x, cx, cy, r, 0.15, 0.15 + Math.PI * 1.7, n * 2, 2, (k) => k === 0 ? null : String(k * step), r * 0.15);
  label(x, cx, cy + r * 0.35, 'KNOTS', r * 0.1);
  needle(x, cx, cy, A(kt), r * 0.85, r * 0.05);
  glassGlint(x, cx, cy, r);
}
function attitudeInd(x, cx, cy, r, pitch, roll) {
  bezel(x, cx, cy, r);
  x.save();
  x.beginPath(); x.arc(cx, cy, r * 0.96, 0, Math.PI * 2); x.clip();
  x.translate(cx, cy); x.rotate(-roll);
  const py = pitch / D2R * r * 0.028;
  x.fillStyle = '#2f73b8'; x.fillRect(-r * 2, -r * 2 + py, r * 4, r * 2);
  x.fillStyle = '#7a4f2a'; x.fillRect(-r * 2, py, r * 4, r * 2);
  x.strokeStyle = '#f2f2ee'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(-r * 2, py); x.lineTo(r * 2, py); x.stroke();
  for (const d of [-20, -10, 10, 20]) {
    const y = py - d * r * 0.028, w = Math.abs(d) === 10 ? r * 0.28 : r * 0.42;
    x.beginPath(); x.moveTo(-w / 2, y); x.lineTo(w / 2, y); x.stroke();
  }
  // bank scale rides with the sky
  for (const b of [-60, -30, -20, -10, 10, 20, 30, 60]) {
    const a = b * D2R - Math.PI / 2;
    x.beginPath(); x.moveTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8); x.lineTo(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92); x.stroke();
  }
  x.restore();
  // fixed aircraft symbol
  x.strokeStyle = '#ffb300'; x.lineWidth = r * 0.05;
  x.beginPath(); x.moveTo(cx - r * 0.5, cy); x.lineTo(cx - r * 0.15, cy); x.lineTo(cx - r * 0.08, cy + r * 0.08);
  x.moveTo(cx + r * 0.5, cy); x.lineTo(cx + r * 0.15, cy); x.lineTo(cx + r * 0.08, cy + r * 0.08); x.stroke();
  x.fillStyle = '#ffb300'; x.beginPath(); x.arc(cx, cy, r * 0.04, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.moveTo(cx, cy - r * 0.92); x.lineTo(cx - r * 0.06, cy - r * 0.8); x.lineTo(cx + r * 0.06, cy - r * 0.8); x.fill();
  glassGlint(x, cx, cy, r);
}
function altimeter(x, cx, cy, r, ft) {
  bezel(x, cx, cy, r);
  ticks(x, cx, cy, r, 0, Math.PI * 2, 50, 5, (k) => k < 10 ? String(k) : null, r * 0.17);
  label(x, cx, cy - r * 0.3, 'ALT', r * 0.1);
  x.fillStyle = '#e8e8e2'; x.font = `${r * 0.1}px "B612 Mono", monospace`; x.textAlign = 'center';
  x.fillText('29.92', cx + r * 0.42, cy + r * 0.05);
  const a = Math.max(0, ft);
  needle(x, cx, cy, (a / 10000) % 1 * Math.PI * 2, r * 0.45, r * 0.03, '#e8e8e2');
  needle(x, cx, cy, (a / 1000) % 1 * Math.PI * 2, r * 0.58, r * 0.06);
  needle(x, cx, cy, (a / 100) % 10 / 10 * Math.PI * 2, r * 0.85, r * 0.035);
  glassGlint(x, cx, cy, r);
}
function turnCoord(x, cx, cy, r, turn, slip) {
  bezel(x, cx, cy, r);
  label(x, cx, cy - r * 0.42, 'TURN COORDINATOR', r * 0.08);
  label(x, cx, cy + r * 0.5, '2 MIN', r * 0.09);
  for (const s of [-1, 1]) {
    const a = s * 15 * D2R;
    x.strokeStyle = '#e8e8e2'; x.lineWidth = 3;
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r * 0.62 * s, cy + Math.sin(a) * r * 0.62); x.lineTo(cx + Math.cos(a) * r * 0.85 * s, cy + Math.sin(a) * r * 0.85); x.stroke();
  }
  x.save(); x.translate(cx, cy); x.rotate(clamp(turn / 3, -2, 2) * 15 * D2R);
  x.strokeStyle = '#f2f2ee'; x.lineWidth = r * 0.06; x.lineCap = 'round';
  x.beginPath(); x.moveTo(-r * 0.6, 0); x.lineTo(r * 0.6, 0); x.moveTo(0, 0); x.lineTo(0, -r * 0.16); x.stroke();
  x.restore();
  // inclinometer ball
  x.fillStyle = '#1d2024'; x.fillRect(cx - r * 0.4, cy + r * 0.2, r * 0.8, r * 0.18);
  x.fillStyle = '#e8e8e2';
  x.beginPath(); x.arc(cx + clamp(-slip * 4, -1, 1) * r * 0.3, cy + r * 0.29, r * 0.075, 0, Math.PI * 2); x.fill();
  glassGlint(x, cx, cy, r);
}
function headingInd(x, cx, cy, r, hdg) {
  bezel(x, cx, cy, r);
  x.save(); x.translate(cx, cy); x.rotate(-hdg * D2R);
  x.strokeStyle = '#e8e8e2'; x.fillStyle = '#e8e8e2'; x.textAlign = 'center'; x.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 5) {
    const a = d * D2R - Math.PI / 2, big = d % 30 === 0;
    x.lineWidth = big ? 3 : 1.5;
    x.beginPath(); x.moveTo(Math.cos(a) * r * (big ? 0.76 : 0.84), Math.sin(a) * r * (big ? 0.76 : 0.84)); x.lineTo(Math.cos(a) * r * 0.93, Math.sin(a) * r * 0.93); x.stroke();
    if (big) {
      const t = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10);
      x.save(); x.rotate(d * D2R); x.font = `bold ${r * 0.15}px "B612", Arial, sans-serif`;
      x.fillStyle = d % 90 === 0 ? '#ffb300' : '#e8e8e2'; x.fillText(t, 0, -r * 0.6); x.restore();
    }
  }
  x.restore();
  x.fillStyle = '#ffb300';
  x.beginPath(); x.moveTo(cx, cy - r * 0.95); x.lineTo(cx - r * 0.07, cy - r * 0.8); x.lineTo(cx + r * 0.07, cy - r * 0.8); x.fill();
  x.strokeStyle = '#ffb300'; x.lineWidth = r * 0.04;
  x.beginPath(); x.moveTo(cx, cy - r * 0.35); x.lineTo(cx, cy + r * 0.35); x.moveTo(cx - r * 0.25, cy - r * 0.05); x.lineTo(cx + r * 0.25, cy - r * 0.05); x.stroke();
  // ILS: crossed needles, localizer vertical and glideslope horizontal
  if (NAV.ils) {
    const k = r * 0.5 / 5, lx = cx + clamp(NAV.ils.locDots, -5, 5) * k, gy = cy - clamp(NAV.ils.gsDots, -5, 5) * k;
    x.strokeStyle = '#f2f2ee'; x.lineWidth = r * 0.035;
    x.beginPath(); x.moveTo(lx, cy - r * 0.55); x.lineTo(lx, cy + r * 0.55); x.moveTo(cx - r * 0.55, gy); x.lineTo(cx + r * 0.55, gy); x.stroke();
    x.fillStyle = '#e8e8e2';
    for (let d = -4; d <= 4; d += 2) { x.beginPath(); x.arc(cx + d * k, cy + r * 0.62, r * 0.025, 0, Math.PI * 2); x.fill(); }
  }
  glassGlint(x, cx, cy, r);
}
function vsiInd(x, cx, cy, r, fpm) {
  bezel(x, cx, cy, r);
  const A = (v) => -Math.PI / 2 + clamp(v / 2000, -1, 1) * Math.PI * 0.85 + Math.PI / 2;
  x.strokeStyle = '#e8e8e2'; x.fillStyle = '#e8e8e2'; x.font = `bold ${r * 0.14}px "B612", Arial, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  for (let v = -2000; v <= 2000; v += 100) {
    const a = A(v) - Math.PI, big = v % 500 === 0;
    x.lineWidth = big ? 3 : 1.5;
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r * (big ? 0.76 : 0.85), cy + Math.sin(a) * r * (big ? 0.76 : 0.85));
    x.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95); x.stroke();
    if (big && Math.abs(v) <= 2000) x.fillText(String(Math.abs(v / 100)), cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
  }
  label(x, cx, cy - r * 0.3, 'UP', r * 0.09); label(x, cx, cy + r * 0.3, 'DOWN', r * 0.09);
  needle(x, cx, cy, A(fpm) - Math.PI / 2, r * 0.85, r * 0.04);
  glassGlint(x, cx, cy, r);
}
function smallGauge(x, cx, cy, r, frac, txt, red = 0.92, lowRed = false) {
  bezel(x, cx, cy, r);
  if (lowRed) {                                   // quantity gauges: red at empty, green above
    arc(x, cx, cy, r * 0.82, -2.2 + 4.4 * 0.03, -2.2 + 4.4 * 0.12, '#e0302a', r * 0.1);
    arc(x, cx, cy, r * 0.82, -2.2 + 4.4 * 0.12, -2.2 + 4.4 * 0.97, '#3fbf4f', r * 0.1);
  } else {
    arc(x, cx, cy, r * 0.82, -2.2 + 4.4 * 0.55, -2.2 + 4.4 * red, '#3fbf4f', r * 0.1);
    arc(x, cx, cy, r * 0.82, -2.2 + 4.4 * red, -2.2 + 4.4 * 0.97, '#e0302a', r * 0.1);
  }
  needle(x, cx, cy, -2.2 + 4.4 * clamp(frac, 0, 1), r * 0.8, r * 0.07);
  label(x, cx, cy + r * 0.55, txt, r * 0.22);
}

/**
 * Vacuum (inHg) and ammeter (A) for the steam panel (v12), derived from the
 * engine and electrical state: the engine-driven pump pulls 4.6-5.2 inHg and
 * nothing when it has failed or the engine is stopped; the ammeter shows the
 * starter draw, the recharge after a start (tapering as the battery fills),
 * and a steady discharge on a dead alternator or with the engine off.
 */
export function engineAux(ac) {
  const running = !!ac.engineRunning || (!ac.p?.startup && !ac.engineFailed);
  const vac = running && ac.systems?.vacuum !== false ? 4.0 + 1.2 * Math.min(1, num(ac.rpmNorm) * 1.3) : 0;
  let amps = 0;
  const batt = ac.sys ? !!ac.sys.battery : true;
  if (batt) {
    if (ac.sys?.mags === 'START' && !ac.engineRunning) amps = -60;
    else if (running && ac.systems?.electrical !== false) amps = Math.min(30, 2 + 28 * (1 - num(ac.batteryCharge, 1)));
    else amps = -(8 + (ac.avionics ? 6 : 0));
  }
  return { vac, amps };
}
function miniGauge(x, cx, cy, r, frac, txt, g0, g1) {
  bezel(x, cx, cy, r);
  arc(x, cx, cy, r * 0.8, -2.2 + 4.4 * g0, -2.2 + 4.4 * g1, '#3fbf4f', r * 0.12);
  needle(x, cx, cy, -2.2 + 4.4 * clamp(frac, 0, 1), r * 0.78, r * 0.09);
  label(x, cx, cy + r * 0.55, txt, r * 0.26);
}

/** Light-aircraft panel: six-pack, engine gauges, radio stack. */
export function drawSteamPanel(x, W, H, ac, hud, ui = null) {
  const v = readout(ac);
  x.fillStyle = '#26292d'; x.fillRect(0, 0, W, H);
  // panel texture: faint vertical brushing
  x.fillStyle = 'rgba(255,255,255,0.025)';
  for (let i = 0; i < W; i += 6) x.fillRect(i, 0, 2, H);
  const r = H * 0.2, gx = W * 0.2, gy = H * 0.28, dx = r * 2.4, dy = r * 2.35;
  asi(x, gx, gy, r, v.ias, ac.p, hud?.asiMaxKt || 200);
  attitudeInd(x, gx + dx, gy, r, v.pitch, v.roll);
  altimeter(x, gx + dx * 2, gy, r, v.alt);
  turnCoord(x, gx, gy + dy, r, v.turn, v.slip);
  headingInd(x, gx + dx, gy + dy, r, v.hdg);
  vsiInd(x, gx + dx * 2, gy + dy, r, v.vsi);
  // suction and ammeter between the six-pack and the engine cluster
  const aux = engineAux(ac), mx = gx + dx * 2 + r * 1.62;
  miniGauge(x, mx, gy, r * 0.34, aux.vac / 7, `VAC ${aux.vac.toFixed(1)}`, 4.5 / 7, 5.5 / 7);
  miniGauge(x, mx, gy + dy, r * 0.34, 0.5 + aux.amps / 120, `AMP ${aux.amps > 0 ? '+' : ''}${Math.round(aux.amps)}`, 0.5, 0.75);
  // engine cluster
  const ex = gx + dx * 3 + r * 0.4;
  smallGauge(x, ex, gy, r * 0.62, v.rpm, `${Math.round(700 + 2000 * v.rpm)}`, 0.95);
  // live engine gauges: oil pressure (psi, red line 100) with the temperature
  // under it, and fuel quantity
  const oilP = num(ac.oilP, 0), oilT = num(ac.oilT, 59);
  smallGauge(x, ex, gy + dy * 0.55, r * 0.5, oilP / 115, `OIL ${Math.round(oilP)}`, 100 / 115);
  label(x, ex, gy + dy * 0.55 - r * 0.2, `${Math.round(oilT)}\u00b0F`, r * 0.12);   // temperature above the hub
  const cap = num(ac.p?.fuel?.capacityKg, 1) || 1;
  smallGauge(x, ex, gy + dy, r * 0.5, num(ac.fuelKg, 0) / cap * 0.97, 'FUEL', 0.98, true);
  // EGT (lean by it: peak, then richen ~50 F) above the tachometer
  if (ac.p?.startup) label(x, ex, gy - r * 0.84, `EGT ${Math.round(num(ac.egt, 70))}\u00b0F`, r * 0.15);
  // radio stack: COM + NAV, then the autopilot (KAP 140 style) when clickable
  const rx = ex + r * 1.0, rw = W - rx - W * 0.03;
  const radios = ui ? 2 : 3;
  const hits = [];
  for (let i = 0; i < radios; i++) {
    const y = H * 0.1 + i * H * 0.27;
    x.fillStyle = '#121416'; x.fillRect(rx, y, rw, H * 0.2);
    x.fillStyle = '#3e4248'; x.fillRect(rx + 4, y + 4, rw - 8, 6);
    x.fillStyle = '#34ff6a'; x.textAlign = 'left'; x.textBaseline = 'middle';
    if (ui && ui.radio) {
      // active frequency big, standby small, then the tune / swap buttons
      const id = i === 0 ? 'com' : 'nav', rd = ui.radio[id];
      x.font = `bold ${Math.min(H * 0.055, rw * 0.095)}px "B612 Mono", monospace`;
      x.fillText(`${id.toUpperCase()} ${rd.act}`, rx + rw * 0.05, y + H * 0.08);
      x.fillStyle = '#c8a43a'; x.font = `${Math.min(H * 0.04, rw * 0.07)}px "B612 Mono", monospace`;
      x.fillText(`SBY ${rd.sby}${id === 'nav' && rd.ils ? '  ILS' : ''}`, rx + rw * 0.05, y + H * 0.155);
      hits.push(...drawButtons(x, [{ id: id + '-dn', label: '−' }, { id: id + '-up', label: '+' }, { id: id + '-swap', label: '⇄' }],
        ui.states, { x: rx + rw * 0.6, y: y + H * 0.015, w: rw * 0.38, h: H * 0.17 }, 3));
    } else if (!ui) {
      x.font = `bold ${Math.min(H * 0.06, rw * 0.11)}px "B612 Mono", monospace`;
      x.fillText(['COM 118.30', 'NAV 110.50', `XPDR ${ac.sys?.xpdr ?? 1200}`][i], rx + rw * 0.08, y + H * 0.11);
    }   // (ui without a radio view = avionics bus dead: the displays stay dark)
  }
  if (!ui) return [];
  const apY = H * 0.1 + 2 * H * 0.27 - H * 0.02;
  x.fillStyle = '#121416'; x.fillRect(rx, apY, rw, H * 0.34);
  hits.push(...drawButtons(x, ui.ap, ui.states, { x: rx, y: apY, w: rw, h: H * 0.34 }, Math.ceil(ui.ap.length / 2)));
  // master / mags / starter / mixture / flaps: a switch column at the left edge
  const sx = W * 0.012, sw = gx - r * 1.2 - sx;
  // two columns once it grows past six switches, so the lower ones stay above the HUD's status box
  const cols = ui.sys.length > 18 ? 4 : ui.sys.length > 12 ? 3 : ui.sys.length > 6 ? 2 : 1, rows = Math.ceil(ui.sys.length / cols);
  if (sw > 40 && ui.sys.length) hits.push(...drawButtons(x, ui.sys, ui.states, { x: sx, y: H * 0.05, w: sw, h: Math.min(H * 0.86, rows * H * 0.13) }, cols));
  return hits;
}

// ------------------------------------------------------------- glass --
function pfd(x, X, Y, S, v, ac) {
  x.save();
  x.beginPath(); x.rect(X, Y, S, S); x.clip();
  x.fillStyle = '#05070a'; x.fillRect(X, Y, S, S);
  const cx = X + S / 2, cy = Y + S * 0.45, R = S * 0.3;
  // attitude
  x.save();
  x.beginPath(); x.rect(cx - R, cy - R, R * 2, R * 2); x.clip();
  x.translate(cx, cy); x.rotate(-v.roll);
  const py = v.pitch / D2R * R * 0.04;
  x.fillStyle = '#2a6fb6'; x.fillRect(-R * 3, -R * 3 + py, R * 6, R * 3);
  x.fillStyle = '#6b4626'; x.fillRect(-R * 3, py, R * 6, R * 3);
  x.strokeStyle = '#fff'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(-R * 3, py); x.lineTo(R * 3, py); x.stroke();
  x.fillStyle = '#fff'; x.font = `${S * 0.03}px "B612 Mono", monospace`; x.textAlign = 'right'; x.textBaseline = 'middle';
  for (let d = -30; d <= 30; d += 5) {
    if (!d) continue;
    const y = py - d * R * 0.04, w = d % 10 ? R * 0.18 : R * 0.4;
    x.beginPath(); x.moveTo(-w / 2, y); x.lineTo(w / 2, y); x.stroke();
    if (!(d % 10)) x.fillText(String(Math.abs(d)), -w / 2 - 4, y);
  }
  x.restore();
  x.strokeStyle = '#ffd400'; x.lineWidth = S * 0.012;
  x.beginPath(); x.moveTo(cx - R * 0.7, cy); x.lineTo(cx - R * 0.25, cy); x.lineTo(cx - R * 0.25, cy + R * 0.1);
  x.moveTo(cx + R * 0.7, cy); x.lineTo(cx + R * 0.25, cy); x.lineTo(cx + R * 0.25, cy + R * 0.1); x.stroke();
  // ILS: localizer diamond under the attitude ball, glideslope beside it
  if (NAV.ils) {
    const dot = R * 0.17;
    x.strokeStyle = '#fff'; x.lineWidth = 2;
    for (let d = -4; d <= 4; d += 2) {
      if (!d) continue;
      x.beginPath(); x.arc(cx + d * dot / 2 * 1, cy + R * 1.08, S * 0.007, 0, Math.PI * 2); x.stroke();
      x.beginPath(); x.arc(cx + R * 1.08, cy + d * dot / 2, S * 0.007, 0, Math.PI * 2); x.stroke();
    }
    const diamond = (dx, dy) => {
      const w = S * 0.018;
      x.fillStyle = MAG;
      x.beginPath(); x.moveTo(dx, dy - w); x.lineTo(dx + w, dy); x.lineTo(dx, dy + w); x.lineTo(dx - w, dy); x.closePath(); x.fill();
    };
    diamond(cx + clamp(NAV.ils.locDots, -5, 5) * dot / 2, cy + R * 1.08);
    diamond(cx + R * 1.08, cy - clamp(NAV.ils.gsDots, -5, 5) * dot / 2);
    x.fillStyle = MAG; x.font = `bold ${S * 0.03}px "B612 Mono", monospace`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('ILS', cx - R * 0.85, Y + S * 0.06);
  }
  // speed + altitude tapes
  const tape = (tx, val, step, fmt, left) => {
    const th = R * 2, tw = S * 0.14;
    x.fillStyle = 'rgba(60,64,70,0.85)'; x.fillRect(tx, cy - th / 2, tw, th);
    x.save(); x.beginPath(); x.rect(tx, cy - th / 2, tw, th); x.clip();
    x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.font = `${S * 0.032}px "B612 Mono", monospace`;
    x.textAlign = left ? 'right' : 'left'; x.textBaseline = 'middle';
    const base = Math.floor(val / step) * step;
    for (let k = -6; k <= 6; k++) {
      const vv = base + k * step, y = cy - (vv - val) / step * th * 0.12;
      x.beginPath(); x.moveTo(left ? tx + tw : tx, y); x.lineTo(left ? tx + tw - 8 : tx + 8, y); x.stroke();
      if (vv >= 0) x.fillText(fmt(vv), left ? tx + tw - 12 : tx + 12, y);
    }
    x.restore();
    x.fillStyle = '#000'; x.strokeStyle = '#fff'; x.lineWidth = 2;
    x.fillRect(tx, cy - S * 0.03, tw, S * 0.06); x.strokeRect(tx, cy - S * 0.03, tw, S * 0.06);
    x.fillStyle = '#fff'; x.font = `bold ${S * 0.04}px "B612 Mono", monospace`; x.textAlign = 'center';
    x.fillText(fmt(Math.max(0, Math.round(val))), tx + tw / 2, cy);
  };
  tape(X + S * 0.02, v.ias, 10, (n) => String(n), true);
  tape(X + S * 0.84, v.alt, 100, (n) => String(n), false);
  // heading strip + numbers
  x.fillStyle = '#fff'; x.font = `bold ${S * 0.04}px "B612 Mono", monospace`; x.textAlign = 'center';
  x.fillText(String(Math.round(v.hdg)).padStart(3, '0'), cx, Y + S * 0.86);
  x.fillStyle = '#34ff6a'; x.font = `${S * 0.032}px "B612 Mono", monospace`;
  x.fillText(`VS ${Math.round(v.vsi / 10) * 10}`, X + S * 0.84 + S * 0.07, cy + R + S * 0.05);
  if (v.mach > 0.3) x.fillText(`M ${v.mach.toFixed(2)}`, X + S * 0.09, cy + R + S * 0.05);
  x.restore();
}
function nd(x, X, Y, S, v, radio = null) {
  x.save(); x.beginPath(); x.rect(X, Y, S, S); x.clip();
  x.fillStyle = '#05070a'; x.fillRect(X, Y, S, S);
  const cx = X + S / 2, cy = Y + S * 0.72, R = S * 0.6;
  x.translate(cx, cy); x.rotate(-v.hdg * D2R);
  x.strokeStyle = '#fff'; x.fillStyle = '#fff'; x.lineWidth = 2; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.beginPath(); x.arc(0, 0, R, 0, Math.PI * 2); x.stroke();
  x.font = `bold ${S * 0.04}px "B612 Mono", monospace`;
  for (let d = 0; d < 360; d += 10) {
    const a = d * D2R - Math.PI / 2;
    x.beginPath(); x.moveTo(Math.cos(a) * R, Math.sin(a) * R); x.lineTo(Math.cos(a) * R * (d % 30 ? 0.96 : 0.92), Math.sin(a) * R * (d % 30 ? 0.96 : 0.92)); x.stroke();
    if (!(d % 30)) { x.save(); x.rotate(d * D2R); x.fillText(String(d / 10), 0, -R * 0.84); x.restore(); }
  }
  x.restore();
  // TCAS targets (tcas.js), 10 nm to the compass ring: hollow diamond = other
  // traffic, filled = proximate, amber circle = TA, red square = RA, with the
  // relative altitude in hundreds of feet (above or below) and a trend arrow
  const tg = radio?.tcas;
  if (tg && tg.length) {
    x.save(); x.beginPath(); x.rect(X, Y, S, S); x.clip();
    x.font = `bold ${S * 0.032}px "B612 Mono", monospace`; x.textAlign = 'center';
    const z = S * 0.018;
    for (const t of tg) {
      const d = Math.min(1.15, t.range / 18520) * R;
      const px = cx + Math.sin(t.rel) * d, py = cy - Math.cos(t.rel) * d;
      const col = t.level === 'RA' ? '#ff3b30' : t.level === 'TA' ? '#ffb300' : '#e8edf2';
      x.fillStyle = col; x.strokeStyle = col; x.lineWidth = 2;
      x.beginPath();
      if (t.level === 'RA') x.rect(px - z, py - z, 2 * z, 2 * z);
      else if (t.level === 'TA') x.arc(px, py, z, 0, Math.PI * 2);
      else { x.moveTo(px, py - z * 1.2); x.lineTo(px + z, py); x.lineTo(px, py + z * 1.2); x.lineTo(px - z, py); x.closePath(); }
      if (t.level === 'OT') x.stroke(); else x.fill();
      const h = Math.round(t.relAltFt / 100), above = h >= 0;
      x.textBaseline = above ? 'bottom' : 'top';
      x.fillText(`${above ? '+' : '-'}${String(Math.abs(h)).padStart(2, '0')}`, px, above ? py - z * 1.4 : py + z * 1.4);
      if (t.trend) {
        const ax = px + z * 1.9;
        x.beginPath(); x.moveTo(ax, py - z); x.lineTo(ax, py + z); x.stroke();
        x.beginPath(); x.moveTo(ax - z * 0.5, py - t.trend * z * 0.4); x.lineTo(ax, py - t.trend * z); x.lineTo(ax + z * 0.5, py - t.trend * z * 0.4); x.stroke();
      }
    }
    x.restore();
  }
  x.fillStyle = '#ffd400';
  x.beginPath(); x.moveTo(cx, cy - S * 0.03); x.lineTo(cx - S * 0.025, cy + S * 0.04); x.lineTo(cx + S * 0.025, cy + S * 0.04); x.fill();
  x.fillStyle = '#ff5fd2'; x.font = `${S * 0.035}px "B612 Mono", monospace`; x.textAlign = 'left';
  x.fillText(`HDG ${String(Math.round(v.hdg)).padStart(3, '0')}`, X + S * 0.05, Y + S * 0.07);
  x.fillStyle = '#34ff6a'; x.textAlign = 'right';
  x.fillText(`GS ${Math.round(v.ias)}`, X + S * 0.95, Y + S * 0.07);
  x.restore();
  if (radio) {
    // NAV 1 active / standby in the top corners, magenta when it is the field's ILS
    x.save();
    x.font = `bold ${S * 0.045}px "B612 Mono", monospace`; x.textBaseline = 'top';
    x.textAlign = 'left'; x.fillStyle = radio.nav.ils ? MAG : '#34ff6a';
    x.fillText(`NAV1 ${radio.nav.act}`, X + S * 0.05, Y + S * 0.12);   // under HDG / GS, clear of the rose
    x.textAlign = 'right'; x.fillStyle = '#c8a43a';
    x.fillText(`SBY ${radio.nav.sby}`, X + S * 0.95, Y + S * 0.12);
    x.restore();
  }
}
function eicas(x, X, Y, S, v, ac) {
  x.save(); x.beginPath(); x.rect(X, Y, S, S); x.clip();
  x.fillStyle = '#05070a'; x.fillRect(X, Y, S, S);
  const n1 = 20 + 80 * v.spool;
  for (let e = 0; e < 2; e++) {
    const cx = X + S * (0.3 + e * 0.4), cy = Y + S * 0.3, r = S * 0.15;
    x.strokeStyle = '#fff'; x.lineWidth = 3;
    x.beginPath(); x.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25); x.stroke();
    x.strokeStyle = '#ff3b30'; x.beginPath(); x.arc(cx, cy, r, Math.PI * 2.15, Math.PI * 2.25); x.stroke();
    const a = Math.PI * 0.75 + Math.PI * 1.5 * clamp(n1 / 105, 0, 1);
    x.fillStyle = 'rgba(255,255,255,0.18)';
    x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, r, Math.PI * 0.75, a); x.closePath(); x.fill();
    x.strokeStyle = '#fff'; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); x.stroke();
    x.fillStyle = '#fff'; x.font = `bold ${S * 0.045}px "B612 Mono", monospace`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(n1.toFixed(1), cx, cy + r * 0.55);
    x.fillStyle = '#9aa7b2'; x.font = `${S * 0.03}px "B612 Mono", monospace`;
    x.fillText('N1', cx, cy - r * 1.25);
  }
  x.fillStyle = '#34ff6a'; x.font = `${S * 0.035}px "B612 Mono", monospace`; x.textAlign = 'left';
  [`FUEL  ${(num(ac.fuelKg, 0) * 2.2046 / 1000).toFixed(1)}`, `G  ${v.g.toFixed(1)}`, 'OIL  OK', `HYD  ${ac.systems?.hydraulics === false ? '0' : '3000'}`].forEach((t, i) => x.fillText(t, X + S * 0.12, Y + S * (0.62 + i * 0.08)));
  x.restore();
}

/** Glass panel: PFD | ND | engines | PFD (airliner) or PFD | ND | engines (fighter). */
export function drawGlassPanel(x, W, H, ac, layout = 'airliner', ui = null) {
  const v = readout(ac);
  x.fillStyle = '#1e2125'; x.fillRect(0, 0, W, H);
  // a fighter's clickable switch band sits under its displays
  const band = ui && layout !== 'airliner' ? H * 0.2 : 0;
  const S = (H - band) * 0.84, gap = (W - S * (layout === 'airliner' ? 4 : 3)) / (layout === 'airliner' ? 5 : 4);
  const Y = (H - band - S) / 2;
  const slots = layout === 'airliner' ? ['pfd', 'nd', 'eicas', 'pfd'] : ['nd', 'pfd', 'eicas'];
  slots.forEach((k, i) => {
    const X = gap + i * (S + gap);
    x.fillStyle = '#0e1013'; x.fillRect(X - 8, Y - 8, S + 16, S + 16);
    if (ac.avionics === false) { x.fillStyle = '#020304'; x.fillRect(X, Y, S, S); return; }   // dead bus: blank glass
    if (k === 'pfd') pfd(x, X, Y, S, v, ac);
    else if (k === 'nd') nd(x, X, Y, S, v, ui?.radio);
    else eicas(x, X, Y, S, v, ac);
  });
  if (!band) return [];
  const list = [...ui.sys, ...ui.ap];
  return drawButtons(x, list, ui.states, { x: W * 0.04, y: H - band, w: W * 0.92, h: band * 0.92 }, list.length);
}
