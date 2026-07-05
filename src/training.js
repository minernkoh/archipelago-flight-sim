// Flight-school syllabus: seven PPL-flavoured lessons checked live against the
// aircraft's own telemetry. Pure logic — no DOM, no THREE. The integrator owns
// the instructor panel, HUD indicators, and mode routing; this module just
// tells it what to say and when a lesson is won or lost.
//
// Internally a "lesson" is a list of steps: { text, done(dt), fail(dt)?,
// hint?, slip?, papi()? }. Steps advance in order; done() is checked every
// tick, fail() (if present) can end the lesson early. slip/papi are read each
// tick to drive the HUD ball/glideslope regardless of which step is current.

import { attitude as flAttitude, KT, FT } from './physics/flightModel.js';

const PROGRESS_KEY = 'archipelago.training';
const HINT_AFTER = 20; // seconds stuck on one step before we nudge

function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); }
  catch { return {}; }
}
function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}

const angDiffDeg = (a, b) => ((a - b + 540) % 360) - 180;
const compassDeg = (rad) => (90 - rad * 180 / Math.PI + 360) % 360;

export function createTrainingSystem(deps) {
  const { ac, map, controls, ui } = deps;
  const ctrl = controls.state;
  const attitude = deps.attitude || flAttitude;
  const gates = deps.gates || {};
  const gSet = (course) => { if (typeof gates.set === 'function') gates.set(course); };
  const gClear = () => { if (typeof gates.clear === 'function') gates.clear(); };
  const gCheck = () => (typeof gates.check === 'function' ? gates.check(ac) : null);

  // ---- generic per-step timing helpers -----------------------------------
  // Continuous hold: accumulator resets the instant pred() goes false.
  function holdFor(pred, secs) {
    let t = 0;
    return (dt) => { t = pred() ? t + dt : 0; return t >= secs; };
  }
  // Cumulative: total time pred() has been true, non-contiguous is fine.
  function cumulativeFor(pred, secs) {
    let t = 0;
    return (dt) => { if (pred()) t += dt; return t >= secs; };
  }

  // ---- runway geometry ----------------------------------------------------
  // Body/world convention (see flightModel.js header): heading 0 = +x, and
  // +z is "right". A yaw of `h` about +y sends local +x -> (cos h, -sin h)
  // and local +z -> (sin h, cos h) — that's `fwd`/`right` below.
  function runwayFrame() {
    const rwy = map.runway;
    const h = rwy.headingRad;
    const fwd = { x: Math.cos(h), z: -Math.sin(h) };
    const right = { x: Math.sin(h), z: Math.cos(h) };
    const ox = rwy.spawn.x, oz = rwy.spawn.z;
    return {
      fwd, right,
      cross(pos) { return (pos.x - ox) * right.x + (pos.z - oz) * right.z; },
    };
  }

  // Rectangular left-traffic circuit: crosswind, two downwind points, base.
  // All at ~1000 ft AGL — close enough to real pattern altitude for training.
  function patternCourse() {
    const rwy = map.runway;
    const { fwd, right } = runwayFrame();
    const O = rwy.spawn;
    const patY = rwy.y + 1000 / FT;
    const LEG = 1300, WIDE = 550;
    const at = (f, r) => [O.x + fwd.x * f + right.x * r, O.z + fwd.z * f + right.z * r, patY];
    return [
      at(LEG * 0.95, -WIDE * 0.45),  // crosswind turn
      at(LEG * 0.55, -WIDE),         // downwind, upwind end
      at(-LEG * 0.10, -WIDE),        // downwind, abeam the numbers
      at(-LEG * 0.55, -WIDE * 0.45), // base turn
    ];
  }

  // ============================ lesson builders ============================

  function buildTaxiSteps() {
    return [
      {
        text: 'Ease the throttle up with <b>W</b> and let her start rolling.',
        done: () => ctrl.throttle > 0.10 && ac.groundSpeed > 2,
        hint: 'Hold <b>W</b> down — throttle builds gradually, like the real engine spooling up.',
      },
      {
        text: "Steer with your feet, not the yoke: tap <b>A</b>/<b>D</b> rudder to wander off centerline and bring it back.",
        done: cumulativeFor(() => ac.groundSpeed > 2 && Math.abs(ctrl.rudder) > 0.3, 2),
        hint: "Ailerons do nothing at taxi speed — it's the rudder pedals that swing the nosewheel.",
      },
      {
        text: 'Bring the throttle to idle, then hold <b>B</b> for the brakes until you stop.',
        done: () => ctrl.brakes && ac.groundSpeed < 0.5,
        hint: 'Let off <b>W</b> first, then squeeze and hold <b>B</b>.',
      },
    ];
  }

  function buildTakeoffSteps({ terse = false } = {}) {
    const frame = runwayFrame();
    return [
      {
        text: terse ? 'Takeoff.'
          : 'Full throttle — hold <b>W</b> to 100%. Keep the nose on the centerline with rudder as she accelerates.',
        done: () => !ac.onGround,
        fail: () => (ac.onGround && Math.abs(frame.cross(ac.pos)) > 15)
          ? 'Drifted off the runway centerline.' : null,
        hint: terse ? undefined : 'Full throttle, and dance on the rudder pedals to hold the line.',
      },
      {
        text: terse ? 'Climb to 1,000 ft AGL.'
          : "Rotate around 60 kt, then hold 70–85 kt climbing to 1,000 ft AGL — that's Vy, best rate of climb. Pitch for airspeed; the throttle's already maxed.",
        done: () => ac.agl * FT >= 1000,
        fail: () => ac.stalled ? 'Stalled during the climb — pitched for altitude instead of airspeed.' : null,
        hint: terse ? undefined : 'If the STALL annunciator lights, lower the nose — angle of attack, not altitude, breaks a stall.',
      },
    ];
  }

  function buildLevelTurnSteps() {
    function levelStep() {
      let refAlt = null;
      return {
        text: 'Hold altitude within 100 ft and keep the wings level for 20 seconds — small pitch corrections, no bank.',
        done: holdFor(() => {
          if (refAlt === null) refAlt = ac.pos.y;
          return Math.abs(ac.pos.y - refAlt) * FT < 100 && Math.abs(attitude(ac).roll) < 0.09;
        }, 20),
        hint: 'Trim for level flight, then leave the ailerons alone — chase the altimeter with tiny pitch inputs.',
        slip: true,
      };
    }
    function turnStep(label, sign) {
      let refHeading = null, refAlt = null;
      return {
        text: `Roll into a ${label} turn — 25–35° of bank — and hold it through 90° of heading change. Back-pressure holds the altitude; rudder keeps it coordinated.`,
        done() {
          const att = attitude(ac);
          if (refHeading === null) { refHeading = att.heading; refAlt = ac.pos.y; }
          let dh = (att.heading - refHeading) * sign;
          while (dh > Math.PI) dh -= 2 * Math.PI;
          while (dh < -Math.PI) dh += 2 * Math.PI;
          return dh >= Math.PI / 2 - 0.03;
        },
        fail() {
          if (refAlt === null) return null;
          return Math.abs(ac.pos.y - refAlt) * FT > 150
            ? `Gained or lost too much altitude in the ${label} turn.` : null;
        },
        hint: () => (Math.abs(ac.beta) > 0.087
          ? "Step on the ball — you're slipping or skidding through the turn."
          : 'Bank 25–35° and hold gentle back-pressure so the nose stays put.'),
        slip: true,
      };
    }
    return [levelStep(), turnStep('left', 1), turnStep('right', -1)];
  }

  function buildSlowFlightStallSteps() {
    let stallRefAlt = null;
    return [
      {
        text: "Climb to at least 2,000 ft AGL — we want plenty of air beneath us before slowing down.",
        done: () => ac.agl * FT >= 2000,
      },
      {
        text: "Add some flaps and ease the throttle back until you're holding 55–62 kt, straight and level, for 15 seconds.",
        done: holdFor(() => {
          const kt = ac.airspeed * KT;
          return kt >= 55 && kt <= 62 && ctrl.flaps >= 0.15;
        }, 15),
        hint: 'Trade throttle for pitch: flaps out, nose up, and settle right on the edge of a stall.',
      },
      {
        text: 'Bring the power to idle and keep holding the nose up until the STALL annunciator fires.',
        done: () => { if (ac.stalled) stallRefAlt = ac.pos.y; return ac.stalled; },
        hint: 'Keep easing the stick back — you want to feel the wing let go, not just get slow.',
      },
      {
        text: 'Recover: nose down to break the stall, then full throttle, wings level. Angle of attack first, power second — a wing stalls at an angle, not a speed.',
        done: () => !ac.stalled && ctrl.throttle > 0.9 && Math.abs(attitude(ac).roll) < 0.17,
        fail: () => {
          if (stallRefAlt === null) return null;
          return (stallRefAlt - ac.pos.y) * FT > 300 ? 'Lost too much altitude recovering from the stall.' : null;
        },
        hint: "Push the nose down first — power alone won't fly you out of a stall.",
      },
    ];
  }

  function buildPatternSteps(course, { terse = false } = {}) {
    const teach = [
      'Turn <b>crosswind</b> — 90° off the runway heading, still climbing to pattern altitude.',
      'Turn <b>downwind</b> — parallel to the runway, opposite direction, level at pattern altitude.',
      "Still on <b>downwind</b>, abeam the numbers — this is where you'd run landing checks and plan the descent.",
      'Turn <b>base</b> — perpendicular to the runway, descending, judging the turn to final by eye.',
    ];
    const short = ['Crosswind.', 'Downwind.', 'Downwind, abeam.', 'Base.'];
    const texts = terse ? short : teach;
    return course.map((_, i) => ({
      text: texts[i],
      done: () => gCheck() === 'pass',
      hint: terse ? undefined : 'Fly toward the lit gate and pass through the ring.',
    }));
  }

  function buildLandingSteps({ terse = false, fpmLimit = 300, papiOn = true } = {}) {
    const { fwd } = runwayFrame();
    const rwy = map.runway;
    const tdX = rwy.spawn.x + fwd.x * 300, tdZ = rwy.spawn.z + fwd.z * 300;
    function established() {
      const bx = rwy.spawn.x - ac.pos.x, bz = rwy.spawn.z - ac.pos.z;
      const dist = Math.hypot(bx, bz);
      const headingOk = Math.abs(angDiffDeg(compassDeg(attitude(ac).heading), compassDeg(rwy.headingRad))) < 10;
      return !ac.onGround && ac.agl > 5 && headingOk && dist < 4000;
    }
    function papi() {
      if (!papiOn || !established()) return null;
      const dx = tdX - ac.pos.x, dz = tdZ - ac.pos.z;
      const horiz = Math.hypot(dx, dz);
      const glideDeg = Math.atan2(ac.pos.y - rwy.y, horiz) * 180 / Math.PI;
      return glideDeg - 3;
    }
    return [
      {
        text: terse ? 'Final approach.'
          : "Turn onto a long final, inside 4 km of the runway, lined up with the extended centerline. The glideslope indicator lights up once you're established.",
        done: holdFor(established, 2),
        hint: terse ? undefined : 'Turn toward the runway heading and close inside 4 km — that wakes up the PAPI.',
        papi,
      },
      {
        text: terse ? `Land, full stop — under ${fpmLimit} fpm, on the pavement.`
          : 'Aim for a point about 300 m past the threshold. Hold your airspeed and flare gently as the runway fills the windscreen.',
        done: () => ac.onGround && ac.groundSpeed < 3 && !!ac.touchdown
          && ac.touchdown.fpm < fpmLimit && ac.touchdown.onRunway,
        hint: terse ? undefined : 'Two red, two white is right on the money — all white is high, all red is low.',
        papi,
      },
    ];
  }

  // ============================== syllabus ==================================

  const LESSON_DEFS = [
    {
      id: 'controls-taxi', title: 'Controls & taxi',
      blurb: 'Throttle, steering, and stopping — the basics before you ever leave the ground.',
      build: () => ({ steps: buildTaxiSteps() }),
    },
    {
      id: 'takeoff', title: 'Takeoff & climb',
      blurb: 'Full power, hold the centerline, rotate at the right speed, climb at best rate.',
      build: () => ({ steps: buildTakeoffSteps() }),
    },
    {
      id: 'level-turns', title: 'Straight & level + turns',
      blurb: 'Hold altitude, then bank into coordinated turns without ballooning or diving.',
      build: () => ({ steps: buildLevelTurnSteps() }),
    },
    {
      id: 'slow-flight-stall', title: 'Slow flight & stalls',
      blurb: 'Feel the edge of the envelope and recover before altitude gets away from you.',
      build: () => ({ steps: buildSlowFlightStallSteps() }),
    },
    {
      id: 'pattern', title: 'Traffic pattern',
      blurb: 'Fly the rectangle — crosswind, downwind, base — the way every airport expects.',
      build: () => {
        const course = patternCourse();
        return { steps: buildPatternSteps(course), setup: () => gSet(course), teardown: gClear };
      },
    },
    {
      id: 'landing', title: 'Landing',
      blurb: 'Aim point, stable airspeed, and a flare timed off the runway filling your view.',
      build: () => ({ steps: buildLandingSteps() }),
    },
    {
      id: 'checkride', title: 'Checkride',
      blurb: 'Takeoff, a full pattern, and a landing — no hints, just leg calls. Earn your PPL.',
      extraProgress: { ppl: true },
      build: () => {
        const course = patternCourse();
        const steps = [
          ...buildTakeoffSteps({ terse: true }),
          ...buildPatternSteps(course, { terse: true }),
          ...buildLandingSteps({ terse: true, fpmLimit: 400, papiOn: false }),
        ];
        return { steps, setup: () => gSet(course), teardown: gClear };
      },
    },
  ];

  // ============================== engine =====================================

  let cur = null; // { def, steps, idx, stepT, hintShown, teardown }

  function showStep() {
    ui.progress(cur.idx + 1, cur.steps.length);
    ui.instruct(cur.steps[cur.idx].text);
    cur.stepT = 0;
    cur.hintShown = false;
  }

  function passCard(def) {
    if (def.id === 'checkride') {
      const td = ac.touchdown;
      return `<b>CHECKRIDE PASSED.</b><br>Takeoff — pass. Pattern — 4/4 gates. `
        + `Landing — ${td ? td.fpm + ' fpm · ' + td.speedKt + ' kt' : 'pass'}.<br><b>PPL awarded.</b>`;
    }
    if (def.id === 'landing') {
      const td = ac.touchdown;
      return `<b>${def.title.toUpperCase()} — COMPLETE.</b>`
        + (td ? `<br>Touchdown ${td.fpm} fpm &middot; ${td.speedKt} kt.` : '');
    }
    return `<b>${def.title.toUpperCase()} — COMPLETE.</b>`;
  }
  function failCard(def, reason) {
    return `<b>${def.title.toUpperCase()} — NOT YET.</b><br>${reason}<br>Reset and give it another go.`;
  }

  function teardownCurrent() {
    if (cur && typeof cur.teardown === 'function') cur.teardown();
    ui.setSlip(null);
    ui.setPapi(null);
  }

  function finish(passed, summaryHtml) {
    const def = cur.def;
    teardownCurrent();
    if (passed) {
      const p = loadProgress();
      p[def.id] = true;
      if (def.extraProgress) Object.assign(p, def.extraProgress);
      saveProgress(p);
    }
    ui.lessonComplete(passed, summaryHtml);
    cur = null;
  }

  return {
    lessons: LESSON_DEFS.map(({ id, title, blurb }) => ({ id, title, blurb })),

    start(lessonId) {
      const def = LESSON_DEFS.find(d => d.id === lessonId);
      if (!def) return;
      teardownCurrent();
      const built = def.build();
      if (typeof built.setup === 'function') built.setup();
      cur = { def, steps: built.steps, teardown: built.teardown, idx: 0, stepT: 0, hintShown: false };
      showStep();
    },

    stop() {
      teardownCurrent();
      cur = null;
    },

    tick(dt) {
      if (!cur) return;
      const step = cur.steps[cur.idx];
      cur.stepT += dt;

      ui.setSlip(step.slip ? ac.beta : null);
      ui.setPapi(typeof step.papi === 'function' ? step.papi() : null);

      if (typeof step.fail === 'function') {
        const reason = step.fail(dt);
        if (reason) { finish(false, failCard(cur.def, reason)); return; }
      }

      if (cur.stepT > HINT_AFTER && !cur.hintShown && step.hint) {
        const hintText = typeof step.hint === 'function' ? step.hint() : step.hint;
        if (hintText) {
          ui.instruct(`${step.text}<br><i>${hintText}</i>`);
          cur.hintShown = true;
        }
      }

      if (step.done(dt)) {
        cur.idx++;
        if (cur.idx >= cur.steps.length) finish(true, passCard(cur.def));
        else showStep();
      }
    },

    get activeLesson() { return cur ? cur.def.id : null; },

    onCrash() {
      if (!cur) return null;
      const def = cur.def;
      teardownCurrent();
      cur = null;
      return { title: 'LESSON FAILED', sub: `Crashed during ${def.title.toLowerCase()}. Reset and try again.` };
    },

    loadProgress,
  };
}
