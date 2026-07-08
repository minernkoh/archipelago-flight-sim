// PFD-style DOM HUD: moving airspeed/altitude tapes, heading strip,
// annunciators, status readouts, race panel, message toast.

import { KT, FT, attitude } from './physics/flightModel.js';

const $ = (s) => document.querySelector(s);

function buildVerticalTape(el, { max, step, labelEvery, pxPer }) {
  const strip = el.querySelector('.strip');
  strip.innerHTML = ''; // rebuilt on aircraft change
  for (let v = 0; v <= max; v += step) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.top = `${-v * pxPer}px`;
    const line = document.createElement('i');
    tick.appendChild(line);
    if (v % labelEvery === 0) {
      const lab = document.createElement('span');
      lab.textContent = v;
      tick.appendChild(lab);
    }
    strip.appendChild(tick);
  }
  const center = el.clientHeight / 2;
  return (value) => {
    strip.style.transform = `translateY(${center + value * pxPer}px)`;
  };
}

function buildHeadingTape(el, pxPerDeg) {
  const strip = el.querySelector('.strip');
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = -360; d <= 720; d += 10) {
    const norm = ((d % 360) + 360) % 360;
    const tick = document.createElement('div');
    tick.className = 'htick';
    tick.style.left = `${d * pxPerDeg}px`;
    tick.appendChild(document.createElement('i'));
    if (norm % 30 === 0) {
      const lab = document.createElement('span');
      lab.textContent = names[norm] ?? String(norm / 10).padStart(2, '0');
      tick.appendChild(lab);
    }
    strip.appendChild(tick);
  }
  // magenta bearing bug for the next race ring
  const bug = document.createElement('div');
  bug.style.cssText = 'position:absolute;top:1.9rem;width:0;height:0;border-left:.32rem solid transparent;border-right:.32rem solid transparent;border-bottom:.5rem solid var(--mag);display:none;';
  strip.appendChild(bug);
  const center = el.clientWidth / 2;
  return (deg, bugDeg) => {
    strip.style.transform = `translateX(${center - deg * pxPerDeg}px)`;
    if (bugDeg == null) { bug.style.display = 'none'; }
    else {
      let d = bugDeg;
      while (d - deg > 180) d -= 360;
      while (d - deg < -180) d += 360;
      bug.style.display = 'block';
      bug.style.left = `${d * pxPerDeg}px`;
    }
  };
}

export function createHUD() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const spdEl = $('#tape-spd'), altEl = $('#tape-alt');
  let flapNames = ['UP', '10°', '25°', 'FULL'];
  let setSpd, setAlt;
  function buildTapes({ tapeMaxKt = 220, altMaxFt = 15000 } = {}) {
    // Fixed visible window (tape is 17rem tall): slow aircraft read a fine
    // scale, jets read a coarse one.
    const fast = tapeMaxKt > 300;
    const ktWindow = fast ? 190 : 57;
    setSpd = buildVerticalTape(spdEl, {
      max: tapeMaxKt,
      step: fast ? 10 : 5,
      labelEvery: fast ? 50 : 20,
      pxPer: rem * 17 / ktWindow,
    });
    const hi = altMaxFt > 20000;
    const ftWindow = hi ? 3400 : 950;
    setAlt = buildVerticalTape(altEl, {
      max: altMaxFt,
      step: hi ? 500 : 100,
      labelEvery: hi ? 1000 : 500,
      pxPer: rem * 17 / ftWindow,
    });
  }
  buildTapes();
  const setHdg = buildHeadingTape($('#heading'), rem * 0.55 / 10);
  const spdCur = spdEl.querySelector('.cursor'), altCur = altEl.querySelector('.cursor');

  const vsi = $('#vsi b'), radalt = $('#radalt b'), aoa = $('#aoa b'), g = $('#gmeter b');
  const hdgNum = $('#hdg-num');
  const stThr = $('#st-thr'), thrBar = $('#thr-bar i'), stFlaps = $('#st-flaps'),
        stBrk = $('#st-brk'), stCam = $('#st-cam'), stTrim = $('#st-trim');
  const annStall = $('#ann-stall'), annOver = $('#ann-over');
  const raceEl = $('#race'), raceT = raceEl.querySelector('.t'),
        raceRings = raceEl.querySelector('.rings'), raceBest = raceEl.querySelector('.best');
  const msgEl = $('#msg');
  let msgTimer = null;
  let slow = 0;

  // Autopilot annunciator + CDI (Phase H)
  const apEl = $('#ap-status');
  const apModes = {
    hdg: $('#apm-hdg'), alt: $('#apm-alt'), ias: $('#apm-ias'), nav: $('#apm-nav'), wing: $('#apm-wing'),
  };
  const apVals = $('#ap-vals'), apWarn = $('#ap-warn');
  const cdiEl = $('#ap-cdi'), cdiNeedle = $('#ap-cdi .needle'), cdiInfo = $('#ap-cdi .info');
  const pad3 = (n) => String(Math.round(n) % 360).padStart(3, '0');

  const papiEl = $('#papi'), papiLights = papiEl.querySelectorAll('i');
  const slipEl = $('#slip'), slipBall = slipEl.querySelector('.ball');
  const debriefEl = $('#debrief');
  const countEl = $('#countdown');
  const splitEl = $('#split');
  let debriefTimer = null, countTimer = null, splitTimer = null;

  return {
    // Rebuild tapes/labels for a different aircraft (hud meta from the catalog)
    configure(hudMeta) {
      buildTapes(hudMeta);
      flapNames = hudMeta.flapNames; // null = aircraft has no flaps
    },
    show(on) { $('#hud').classList.toggle('on', on); },
    // Training aids -------------------------------------------------------
    // PAPI: dev in degrees above (+) / below (-) the 3° glideslope.
    setPapi(dev) {
      papiEl.classList.toggle('show', dev != null);
      if (dev == null) return;
      const whites = dev >= 0.7 ? 4 : dev >= 0.2 ? 3 : dev > -0.2 ? 2 : dev > -0.7 ? 1 : 0;
      papiLights.forEach((l, i) => l.classList.toggle('red', i >= whites));
    },
    // Slip/skid ball: beta rad, ball deflects toward the rudder you need.
    setSlip(beta) {
      slipEl.classList.toggle('show', beta != null);
      if (beta == null) return;
      const px = Math.max(-46, Math.min(46, beta * 260));
      slipBall.style.transform = `translateX(${px}px)`;
    },
    setCamera(name) { stCam.textContent = name; },
    // Autopilot mode block + CDI needle. s = createAutopilot().status(ac).
    setAP(s) {
      apEl.classList.toggle('on', s.on);
      apModes.hdg.classList.toggle('active', s.hdg);
      apModes.alt.classList.toggle('active', s.alt);
      apModes.ias.classList.toggle('active', s.ias);
      apModes.nav.classList.toggle('active', s.nav);
      apModes.wing.classList.toggle('active', s.wing);
      apVals.textContent = s.on
        ? `HDG ${pad3(s.selHdg)}  ALT ${Math.round(s.selAlt * FT / 10) * 10}  IAS ${Math.round(s.selIas * KT)}`
        : '';
      apWarn.classList.toggle('show', !!s.warn);
      const cdi = s.navData;
      cdiEl.classList.toggle('show', !!cdi);
      if (cdi) {
        // Deflect the needle toward the course (fly-to): right of course → left needle.
        const px = Math.max(-46, Math.min(46, -cdi.xtk / 500 * 46));
        cdiNeedle.style.transform = `translateX(${px}px)`;
        cdiInfo.textContent = `WPT ${cdi.idx}/${cdi.total}  DME ${(cdi.dme / 1852).toFixed(1)} NM`;
      }
    },
    message(text, ms = 3200) {
      msgEl.innerHTML = text;
      msgEl.classList.add('show');
      clearTimeout(msgTimer);
      if (ms) msgTimer = setTimeout(() => msgEl.classList.remove('show'), ms);
    },
    clearMessage() { msgEl.classList.remove('show'); },
    // Landing debrief card (bottom-center, auto-dismiss). data: { grade, fpm,
    // speedKt, offset (metres, null when off-runway), coach }.
    debrief(data, ms = 6000) {
      const off = data.offset == null ? ''
        : `<span><i>CTR</i>${Math.abs(Math.round(data.offset))} m ${data.offset >= 0 ? 'R' : 'L'}</span>`;
      debriefEl.innerHTML =
        `<div class="db-kicker">TOUCHDOWN</div>` +
        `<div class="db-grade">${data.grade}</div>` +
        `<div class="db-row"><span><i>FPM</i>${data.fpm}</span>` +
        `<span><i>SPD</i>${data.speedKt} kt</span>${off}</div>` +
        `<div class="db-coach">${data.coach}</div>`;
      debriefEl.classList.add('show');
      clearTimeout(debriefTimer);
      if (ms) debriefTimer = setTimeout(() => debriefEl.classList.remove('show'), ms);
    },
    clearDebrief() { debriefEl.classList.remove('show'); clearTimeout(debriefTimer); },
    // 3-2-1-GO race countdown overlay (visual only; the clock still arms on roll).
    countdown() {
      const seq = ['3', '2', '1', 'GO'];
      let i = 0;
      clearTimeout(countTimer);
      const tick = () => {
        countEl.textContent = seq[i];
        countEl.classList.toggle('go', seq[i] === 'GO');
        countEl.classList.add('show');
        // restart the pop animation
        countEl.style.animation = 'none'; void countEl.offsetWidth; countEl.style.animation = '';
        i++;
        if (i < seq.length) countTimer = setTimeout(tick, 800);
        else countTimer = setTimeout(() => countEl.classList.remove('show'), 700);
      };
      tick();
    },
    // Per-gate split flash vs the best run. delta in seconds (null = no baseline).
    split(delta) {
      if (delta == null) { splitEl.classList.remove('show'); return; }
      const ahead = delta <= 0;
      splitEl.textContent = (ahead ? '−' : '+') + Math.abs(delta).toFixed(1);
      splitEl.classList.toggle('ahead', ahead);
      splitEl.classList.toggle('behind', !ahead);
      splitEl.classList.add('show');
      clearTimeout(splitTimer);
      splitTimer = setTimeout(() => splitEl.classList.remove('show'), 1600);
    },
    race(show, data) {
      raceEl.classList.toggle('show', show);
      if (data) {
        raceT.textContent = data.time;
        raceRings.textContent = data.rings;
        raceBest.textContent = data.best;
      }
    },
    update(ac, controls, dt, ringBearing) {
      const kt = ac.airspeed * KT;
      const altFt = ac.pos.y * FT;
      setSpd(kt); setAlt(altFt);
      spdCur.textContent = Math.round(kt);
      altCur.textContent = Math.round(altFt / 10) * 10;

      const att = attitude(ac);
      let hdg = (90 - att.heading * 180 / Math.PI + 360) % 360; // compass: runway +x = 090
      setHdg(hdg, ringBearing);

      slow += dt;
      if (slow > 0.12) { // cheap text updates at ~8 Hz
        slow = 0;
        const vs = Math.round(ac.vel.y * FT * 60 / 50) * 50;
        vsi.textContent = (vs >= 0 ? '+' : '−') + String(Math.abs(vs)).padStart(4, '0');
        radalt.textContent = Math.max(0, Math.round(ac.agl * FT));
        aoa.textContent = ac.airspeed > 9 ? (ac.alpha * 57.29).toFixed(1) + '°' : '—';
        g.textContent = ac.gLoad.toFixed(1);
        hdgNum.textContent = String(Math.round(hdg) % 360 || 360).padStart(3, '0');
        stThr.firstChild.textContent = ac.abOn ? 'AB' : Math.round(controls.throttle * 100) + '%';
        stThr.style.color = ac.abOn ? 'var(--amber)' : '';
        thrBar.style.width = controls.throttle * 100 + '%';
        if (flapNames) {
          const fi = controls.flaps < 0.15 ? 0 : controls.flaps < 0.5 ? 1 : controls.flaps < 0.85 ? 2 : 3;
          stFlaps.textContent = flapNames[fi];
          stFlaps.classList.toggle('set', fi > 0);
        } else {
          stFlaps.textContent = '—';
          stFlaps.classList.remove('set');
        }
        stBrk.textContent = controls.brakes ? 'ON' : '—';
        stBrk.style.color = controls.brakes ? 'var(--amber)' : '';
        const tr = Math.round((controls.trim || 0) * 100);
        stTrim.textContent = tr === 0 ? '0' : (tr > 0 ? `+${tr}` : `${tr}`);
        stTrim.classList.toggle('set', tr !== 0);
      }
      annStall.classList.toggle('show', ac.stalled);
      annOver.classList.toggle('show', ac.airspeed > ac.p.maxSpeed);
    },
  };
}
