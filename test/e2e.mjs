// Headless E2E: boot, aircraft selection, take off, cameras, pause, full ring
// race, landing, results, landing-rating toast. Run: node test/e2e.mjs
// (static server must be on :8123)
//
// All input goes through evaluate-dispatched DOM events, NOT page.click /
// page.keyboard: headless input dispatch waits on compositor frames, and the
// SwiftShader compositor stalls unpredictably. DOM events always deliver.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

const SHOTS = process.env.SHOTS_DIR || 'test/shots';
mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 300000,
  args: ['--window-size=1440,900', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const sim = (expr) => page.evaluate(new Function(`return (${expr});`));
const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const keyEv = (type, key) => page.evaluate(([t, k]) => window.dispatchEvent(new KeyboardEvent(t, { key: k })), [type, key]);
const hold = (k) => keyEv('keydown', k);
const release = (k) => keyEv('keyup', k);
const press = async (k) => { await hold(k); await release(k); };
const shot = async (name) => {
  try { await page.screenshot({ path: `${SHOTS}/${name}.png` }); }
  catch { console.log(`  (screenshot ${name} skipped — compositor stalled)`); }
};
const settle = (ms) => new Promise(r => setTimeout(r, ms));

console.log('loading page…');
await page.goto('http://localhost:8123/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu.show', { timeout: 60000 });
check('boots to menu (terrain generated)', true);
await page.waitForFunction('(window.__sim.frames || 0) > 3', { timeout: 120000, polling: 1000 });
await shot('1-menu');

// --- U1: pressing ? opens the guided tour, and it pages through the cards ---
const tourVisible = () => sim('!!document.querySelector(".tour-root") && !document.querySelector(".tour-root").classList.contains("hidden")');
await keyEv('keydown', '?');
await settle(250);
const tourOpened = await tourVisible();
check('? opens the guided tour', tourOpened);
let tourCards = 0;
for (let i = 0; i < 14; i++) {
  if (!(await tourVisible())) break;
  tourCards++;
  await keyEv('keydown', ' '); // SPACE advances one card
  await settle(140);
}
check('tour pages through >= 6 cards', tourCards >= 6, `${tourCards} cards`);
await keyEv('keydown', 'Escape'); // ensure closed before continuing
await settle(150);

// --- menu: aircraft row cycles through the fleet ---
const first = await page.evaluate(() => document.querySelector('#sel-aircraft').textContent);
await click('[data-sel="aircraft"]');
const second = await page.evaluate(() => document.querySelector('#sel-aircraft').textContent);
check('aircraft selector cycles', first !== second, `${first} -> ${second}`);
await click('[data-sel="weather"]');
const wx = await page.evaluate(() => document.querySelector('#sel-weather').textContent);
check('weather selector cycles', wx === 'BREEZY', wx);
// return to CALM for the flight tests (robust to the weather-list length)
for (let i = 0; i < 6 && (await page.evaluate(() => document.querySelector('#sel-weather').textContent)) !== 'CALM'; i++) {
  await click('[data-sel="weather"]');
}

// --- every aircraft spawns and sits on its gear ---
for (const id of ['extra300', 'hornet', 'heavy', 'spirit']) {
  await page.evaluate((i) => window.__sim.game.select({ aircraft: i, mode: 'free' }), id);
  await click('#btn-start');
  await settle(2000);
  const st = await sim('({state: __sim.game.state, id: __sim.ac.p.id, ground: __sim.ac.onGround, crashed: __sim.ac.crashed})');
  check(`${id} spawns on its gear`, st.state === 'flying' && st.id === id && st.ground && !st.crashed, JSON.stringify(st));
  await press('Escape');
  await settle(200);
  await click('#pause [data-act="menu"]');
  await settle(200);
}

// --- free flight in the c172: take off and climb ---
await page.evaluate(() => window.__sim.game.select({ aircraft: 'c172', mode: 'free', map: 'archipelago' }));
await click('#btn-start');
await settle(1500);
const spawn = await sim('({onGround: __sim.ac.onGround, state: __sim.game.state})');
check('free flight starts on the ground', spawn.state === 'flying' && spawn.onGround, JSON.stringify(spawn));
await shot('2-runway');

console.log('full throttle…');
await hold('w');
const t0 = Date.now();
let v = 0;
while (v < 33 && Date.now() - t0 < 60000) {
  await settle(500);
  v = await sim('__sim.ac.airspeed');
}
check('accelerates to rotate speed (64 kt)', v >= 33, `${(v * 1.94).toFixed(0)} kt in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

console.log('rotating…');
let air = null;
const t1 = Date.now();
while (Date.now() - t1 < 45000) {
  await hold('ArrowUp');
  await settle(260);
  await release('ArrowUp');
  await settle(340);
  air = await sim('({agl: __sim.ac.agl, v: __sim.ac.airspeed, crashed: __sim.ac.crashed, vs: __sim.ac.vel.y})');
  if (air.crashed || air.agl > 60) break;
}
await release('w');
check('airborne and climbing', !air.crashed && air.agl > 60 && air.vs > 0,
  `AGL ${air.agl.toFixed(0)} m, VS ${air.vs.toFixed(1)} m/s, ${(air.v * 1.94).toFixed(0)} kt`);
// stabilize to safe cruise — the scripted zoom climb is near stall
await page.evaluate(() => {
  const ac = window.__sim.ac;
  ac.pos.y = Math.max(ac.pos.y, 300);
  ac.vel = { x: 50, y: 0, z: 0 };
  ac.q = { x: 0, y: 0, z: 0, w: 1 };
  ac.omega = { x: 0, y: 0, z: 0 };
  window.__sim.controls.state.throttle = 0.7;
});
await shot('3-climbout');

const hudState = await page.evaluate(() => ({
  spd: document.querySelector('#tape-spd .cursor').textContent,
  hudOn: document.querySelector('#hud').classList.contains('on'),
}));
check('HUD live', hudState.hudOn && Number(hudState.spd) > 30, `IAS ${hudState.spd} kt`);

// --- U7: minimap toggles with M (assert via DOM/state, not pixels) ---
const mmExists = await sim('!!document.querySelector("#minimap")');
const mmBefore = await sim('document.querySelector("#minimap").classList.contains("on")');
await press('m');
await settle(500);
const mmOn = await sim('document.querySelector("#minimap").classList.contains("on")');
await press('m');
await settle(500);
const mmOff = await sim('document.querySelector("#minimap").classList.contains("on")');
check('minimap toggles with M', mmExists && !mmBefore && mmOn && !mmOff,
  `exists=${mmExists} before=${mmBefore} on=${mmOn} off=${mmOff}`);

// --- G1: instrument six-pack toggles with I (assert via DOM class, not pixels) ---
const panelExists = await sim('!!document.querySelector("#ap-sixpack")');
const panelBefore = await sim('document.querySelector("#ap-sixpack").classList.contains("ap-visible")');
await press('i');
await settle(400);
const panelOn = await sim('document.querySelector("#ap-sixpack").classList.contains("ap-visible")');
await press('i');
await settle(400);
const panelOff = await sim('document.querySelector("#ap-sixpack").classList.contains("ap-visible")');
check('instruments toggle with I', panelExists && !panelBefore && panelOn && !panelOff,
  `exists=${panelExists} before=${panelBefore} on=${panelOn} off=${panelOff}`);

// --- G2: attitude-indicator gyro transform CHANGES between two flight states ---
const attSel = '#ap-sixpack g[clip-path]'; // the attitude roll-gyro group (rotate = bank)
await page.evaluate(() => { const ac = window.__sim.ac; ac.q = { x: 0, y: 0, z: 0, w: 1 }; ac.omega = { x: 0, y: 0, z: 0 }; });
await settle(300);
const att1 = await sim(`document.querySelector(${JSON.stringify(attSel)}).getAttribute("transform")`);
await page.evaluate(() => { const s = Math.sin(0.25), c = Math.cos(0.25); const ac = window.__sim.ac; ac.q = { x: s, y: 0, z: 0, w: c }; ac.omega = { x: 0, y: 0, z: 0 }; });
await settle(300);
const att2 = await sim(`document.querySelector(${JSON.stringify(attSel)}).getAttribute("transform")`);
check('attitude indicator transform changes with attitude', !!att1 && !!att2 && att1 !== att2, `${att1} -> ${att2}`);

await press('c');
await settle(400);
await shot('4-cockpit');
await press('c');
await settle(400);
await press('c');

// --- pause & race mode ---
await press('Escape');
await settle(300);
check('escape pauses', (await sim('__sim.game.state')) === 'paused');
await click('#pause [data-act="menu"]');
await page.evaluate(() => window.__sim.game.select({ mode: 'race' }));
await click('#btn-start');
await settle(1200);
const race = await sim('({state: __sim.game.state, mode: __sim.game.mode, ringsVisible: __sim.rings.group.visible, total: __sim.rings.total})');
check('race mode starts with rings', race.state === 'flying' && race.mode === 'race' && race.ringsVisible && race.total === 12, JSON.stringify(race));

// --- U6: 3-2-1-GO countdown appears BEFORE the aircraft rolls ---
const cd = await page.evaluate(() => ({
  shown: document.querySelector('#countdown').classList.contains('show'),
  text: document.querySelector('#countdown').textContent.trim(),
  gs: window.__sim.ac.groundSpeed,
}));
check('race countdown appears before roll', cd.shown && /^(3|2|1|GO)$/.test(cd.text) && cd.gs < 3,
  `text=${cd.text} groundSpeed=${cd.gs.toFixed(2)}`);
await shot('6-race-start');

// --- fly the whole course by teleporting short of each gate ---
console.log('flying the course…');
const gates = await page.evaluate(() => window.__sim.rings.group.children.map(m => ({ x: m.position.x, y: m.position.y, z: m.position.z })));
for (let i = 0; i < gates.length; i++) {
  await page.evaluate((g, i) => {
    const { rings, ac } = window.__sim;
    const D = 150;
    const p = i === 0
      ? { x: g.x - D, y: g.y, z: g.z }
      : (() => {
          const before = rings.group.children[i - 1].position;
          const dx = g.x - before.x, dz = g.z - before.z;
          const L = Math.hypot(dx, dz);
          return { x: g.x - dx / L * D, y: g.y, z: g.z - dz / L * D };
        })();
    const dx = g.x - p.x, dz = g.z - p.z, L = Math.hypot(dx, dz);
    ac.pos = { x: p.x, y: g.y, z: p.z };
    ac.vel = { x: dx / L * 48, y: 0, z: dz / L * 48 };
    const yaw = Math.atan2(-dz, dx);
    ac.q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    ac.omega = { x: 0, y: 0, z: 0 };
    window.__sim.controls.state.throttle = 0.5;
  }, gates[i], i);
  await settle(5000);
  const st = await sim('({active: __sim.rings.active, crashed: __sim.ac.crashed})');
  if (st.crashed) { console.log(`  crashed during leg ${i + 1}`); break; }
  if (st.active !== i + 1) console.log(`  gate ${i + 1} not yet registered (active=${st.active})`);
}
const coursed = await sim('({active: __sim.rings.active, done: __sim.rings.done})');
check('all 12 gates registered', coursed.done, JSON.stringify(coursed));

// --- land back on the runway and stop -> results ---
console.log('landing…');
await page.evaluate(() => {
  const ac = window.__sim.ac;
  ac.pos = { x: 250, y: 7.6, z: 0 };
  ac.vel = { x: 22, y: -0.5, z: 0 };
  ac.q = { x: 0, y: 0, z: 0, w: 1 };
  ac.omega = { x: 0, y: 0, z: 0 };
  window.__sim.controls.state.throttle = 0;
});
await hold('b');
await settle(12000);
await release('b');
const resState = await sim('__sim.game.state');
check('race finishes on landed full stop', resState === 'results', `state=${resState}`);
const best = await page.evaluate(() => localStorage.getItem('archipelago.best.archipelago.c172'));
check('best time saved (per map+aircraft key)', best !== null, best ? `${Number(best).toFixed(1)} s` : 'missing');
await shot('8-results');

// --- U5: free-flight landing debrief card shows a centerline number ---
await click('#results [data-act="menu"]');
await page.evaluate(() => window.__sim.game.select({ mode: 'free' }));
await click('#btn-start');
await settle(600);
await page.evaluate(() => {
  const ac = window.__sim.ac;
  ac._airTime = 5;
  ac.pos = { x: 300, y: 8.2, z: 0 };
  ac.vel = { x: 24, y: -0.8, z: 0 };
  ac.q = { x: 0, y: 0, z: 0, w: 1 };
  ac.omega = { x: 0, y: 0, z: 0 };
});
await settle(6000);
const db = await page.evaluate(() => ({
  shown: document.querySelector('#debrief').classList.contains('show'),
  text: document.querySelector('#debrief').textContent,
}));
check('debrief card shows a centerline number after a runway landing',
  db.shown && /CTR/.test(db.text) && /\d+\s*m/.test(db.text), db.text.replace(/\s+/g, ' ').trim());

// --- flight school: lesson 1 (controls & taxi) start to finish ---
console.log('flight school…');
await press('Escape');
await settle(200);
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ mode: 'training' }));
await click('#btn-start');
await settle(400);
const nLessons = await page.evaluate(() => document.querySelectorAll('#lesson-list [data-lesson]').length);
check('lesson picker lists the full syllabus', nLessons >= 9, `${nLessons} lessons`);
await page.evaluate(() => window.__sim.game.beginLesson('controls-taxi'));
await settle(1500);
const instrOn = await page.evaluate(() => document.querySelector('#instructor').classList.contains('show'));
check('instructor panel appears', instrOn);
// taxi like a student, not a maniac: ~35% throttle, gentle rudder at taxi speed
await hold('w'); await settle(700); await release('w');   // step 1: roll
await settle(4000);
for (let i = 0; i < 3; i++) {                              // step 2: rudder wander
  await hold('a'); await settle(900); await release('a');
  await hold('d'); await settle(900); await release('d');
}
await page.evaluate(() => { window.__sim.controls.state.throttle = 0; });
await hold('b');                                            // step 3: brake to a stop
await settle(10000);
await release('b');
const trainProg = await page.evaluate(() => localStorage.getItem('archipelago.training'));
check('lesson 1 completes and persists', !!trainProg && /controls-taxi/.test(trainProg), trainProg || 'no progress saved');

// --- Singapore: loads, spawns at Changi, MBS tower is solid ---
console.log('singapore…');
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ mode: 'free', map: 'singapore', aircraft: 'c172' }));
await click('#btn-start');
await page.waitForFunction('!document.querySelector("#loading").classList.contains("show") && window.__sim.game.state === "flying"', { timeout: 120000, polling: 1000 });
await settle(1500);
const sg = await sim('({map: __sim.map.id, ground: __sim.ac.onGround, crashed: __sim.ac.crashed, rwy: __sim.map.runway.name})');
check('singapore loads and spawns at Changi', sg.map === 'singapore' && sg.ground && !sg.crashed && sg.rwy === '02L', JSON.stringify(sg));
await shot('9-singapore-changi');
await page.evaluate(() => { // cruise toward Marina Bay from the east for the skyline shot
  const ac = window.__sim.ac;
  ac.pos = { x: -3600, y: 260, z: 4100 };
  ac.vel = { x: -50, y: 0, z: 5 };
  ac.q = { x: 0, y: Math.sin(Math.PI / 2), z: 0, w: Math.cos(Math.PI / 2) };
  ac.omega = { x: 0, y: 0, z: 0 };
  window.__sim.controls.state.throttle = 0.7;
});
await settle(4000);
await shot('9b-marina-bay');
await page.evaluate(() => { // fly into an MBS tower
  const ac = window.__sim.ac;
  ac.pos = { x: -5600 - 400, y: 100, z: 4350 };
  ac.vel = { x: 60, y: 0, z: 0 };
  ac.q = { x: 0, y: 0, z: 0, w: 1 };
  ac.omega = { x: 0, y: 0, z: 0 };
});
await settle(8000);
const hit = await sim('({crashed: __sim.ac.crashed, reason: __sim.ac.crashReason})');
check('MBS tower is solid (collision = crash)', hit.crashed, JSON.stringify(hit));
await shot('10-singapore-crash');

// --- map swap back: no leaks/errors ---
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ map: 'archipelago' }));
await click('#btn-start');
await page.waitForFunction('!document.querySelector("#loading").classList.contains("show") && window.__sim.game.state === "flying"', { timeout: 120000, polling: 1000 });
await settle(600); // let a physics tick settle the gear so onGround registers
const back = await sim('({map: __sim.map.id, ground: __sim.ac.onGround})');
check('map swaps back cleanly', back.map === 'archipelago' && back.ground, JSON.stringify(back));

// --- U2: first-flaps hint fires exactly once across two separate flights ---
await page.evaluate(() => { window.__sim.game.toMenu?.(); localStorage.removeItem('archipelago.hint.flaps'); });
await page.evaluate(() => window.__sim.game.select({ mode: 'free', aircraft: 'c172', map: 'archipelago' }));
await click('#btn-start');
await settle(1500);
await press('f');            // flight 1: extend flaps
await settle(1800);
const flapMsg1 = await page.evaluate(() => document.querySelector('#msg').textContent);
check('first flaps extension shows a hint', /flap/i.test(flapMsg1), flapMsg1 || '(empty)');
// refly (begin() again) and clear the toast, then extend flaps once more
await press('Escape'); await settle(250);
await click('#pause [data-act="restart"]');
await settle(1600);
await page.evaluate(() => { document.querySelector('#msg').textContent = ''; });
await press('f'); await settle(300); await press('f');   // flight 2: extend flaps again
await settle(1800);
const flapMsg2 = await page.evaluate(() => document.querySelector('#msg').textContent);
check('flaps hint does NOT fire a second time', !/flap/i.test(flapMsg2), flapMsg2 || '(empty)');

// --- U3: ground-school glossary lists >= 10 flip cards ---
await press('Escape'); await settle(200);
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => document.querySelector('#menu-foot [data-act="groundschool"]').click());
await settle(300);
const gsShown = await sim('document.querySelector("#groundschool").classList.contains("show")');
const gsCards = await page.evaluate(() => document.querySelectorAll('#groundschool .gs-card').length);
check('ground school screen opens from the menu', gsShown);
check('glossary lists >= 10 cards', gsCards >= 10, `${gsCards} cards`);

// --- Phase H: autopilot ALT/IAS-hold band + NAV waypoint sequencing ---
console.log('autopilot…');
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ mode: 'free', aircraft: 'c172', map: 'archipelago' }));
await click('#btn-start');
await settle(1000);
// establish stable, level cruise then engage ALT-hold (g) + IAS-hold (j)
await page.evaluate(() => {
  const ac = window.__sim.ac;
  ac.pos = { x: 0, y: 500, z: 0 };
  ac.vel = { x: 55, y: 0, z: 0 };
  ac.q = { x: 0, y: 0, z: 0, w: 1 };
  ac.omega = { x: 0, y: 0, z: 0 };
  window.__sim.controls.state.throttle = 0.6;
});
await settle(400);
const apY0 = await sim('__sim.ac.pos.y');
await press('g'); await settle(120); await press('j');
await settle(200);
const apEng = await sim('({alt: __sim.autopilot.modes.alt, ias: __sim.autopilot.modes.ias})');
check('AP ALT+IAS engage via keys (g/j)', apEng.alt && apEng.ias, JSON.stringify(apEng));
let apMin = 1e9, apMax = -1e9;
for (let i = 0; i < 14; i++) {
  await settle(1000);
  const y = await sim('__sim.ac.pos.y');
  apMin = Math.min(apMin, y); apMax = Math.max(apMax, y);
}
check('AP ALT-hold keeps altitude within ±75 m over ~14 s',
  (apMax - apY0) < 75 && (apY0 - apMin) < 75,
  `set=${apY0.toFixed(0)} min=${apMin.toFixed(0)} max=${apMax.toFixed(0)}`);

// NAV: 2-waypoint plan, engage, heading target turns toward wp1, sequences to wp2
await page.evaluate(() => {
  const ac = window.__sim.ac;
  ac.pos = { x: 0, y: 500, z: 0 };
  ac.vel = { x: 55, y: 0, z: 0 };            // tracking 090
  ac.q = { x: 0, y: 0, z: 0, w: 1 };
  ac.omega = { x: 0, y: 0, z: 0 };
  window.__sim.autopilot.setPlan([[1500, -1500, 500], [3000, -3000, 500]], [0, 0]);
});
await press('h'); await press('g'); await press('n'); // HDG+ALT for stability, then NAV
await settle(400);
const nav0 = await sim('({idx: __sim.autopilot.status(__sim.ac).navData.idx, sel: __sim.autopilot.sel.hdg})');
check('NAV engages, targets wp1 (bearing ~045)', nav0.idx === 1 && nav0.sel > 25 && nav0.sel < 65, JSON.stringify(nav0));
// fly to within the 300 m capture radius of wp1 → should sequence to wp2
await page.evaluate(() => {
  const ac = window.__sim.ac;
  ac.pos = { x: 1400, y: 500, z: -1450 };    // ~112 m from wp1
  ac.vel = { x: 40, y: 0, z: -40 };
  ac.omega = { x: 0, y: 0, z: 0 };
});
await settle(600);
const navSeq = await sim('__sim.autopilot.status(__sim.ac).navData.idx');
check('NAV sequences to wp2 on capture radius', navSeq === 2, `idx=${navSeq}`);
await press('p'); // master off — leave AP disengaged
await settle(150);

// --- Phase I: alpine map loads + time-of-day NIGHT darkens the scene ---
// (assert env state / scalars via page.evaluate, never pixels).
console.log('time-of-day / alpine…');
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ mode: 'free', map: 'archipelago', aircraft: 'c172', time: 'day' }));
await click('#btn-start');
await settle(900);
const dayEnv = await sim('__sim.env.state()');
check('DAY env reports daytime', dayEnv.timeOfDay === 'day' && dayEnv.night === false, JSON.stringify(dayEnv));

await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ mode: 'free', map: 'alpine', aircraft: 'c172', time: 'night' }));
await click('#btn-start');
await page.waitForFunction('!document.querySelector("#loading").classList.contains("show") && window.__sim.game.state === "flying"', { timeout: 120000, polling: 1000 });
await settle(1200);
const alp = await sim('({ map: __sim.map.id, ground: __sim.ac.onGround, crashed: __sim.ac.crashed, rwy: __sim.map.runway.name })');
check('alpine map loads and spawns on the strip', alp.map === 'alpine' && alp.ground && !alp.crashed, JSON.stringify(alp));
const nightEnv = await sim('__sim.env.state()');
check('NIGHT sets a night flag and darkens the scene',
  nightEnv.night === true && nightEnv.timeOfDay === 'night'
  && nightEnv.sunIntensity < dayEnv.sunIntensity && nightEnv.fogLum < dayEnv.fogLum,
  `night sun=${nightEnv.sunIntensity} fogLum=${nightEnv.fogLum.toFixed(3)} vs day fogLum=${dayEnv.fogLum.toFixed(3)}`);
await shot('11-alpine-night');

// --- Phase C: low-level gauntlet starts with low gates in the Hornet ---
console.log('phase C — gauntlet / freestyle / logbook…');
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ mode: 'gauntlet', map: 'archipelago', time: 'day' }));
await click('#btn-start');
await page.waitForFunction('!document.querySelector("#loading").classList.contains("show") && window.__sim.game.state === "flying"', { timeout: 120000, polling: 1000 });
await settle(800);
const gaunt = await sim(`(() => {
  const s = window.__sim;
  const g0 = s.rings.group.children[0];
  return { mode: s.game.mode, ac: s.ac.p.id, visible: s.rings.group.visible,
           total: s.rings.total, gateY: g0 ? g0.position.y : null };
})()`);
check('gauntlet starts in the Hornet with low gates visible',
  gaunt.mode === 'gauntlet' && gaunt.ac === 'hornet' && gaunt.visible && gaunt.total > 0 && gaunt.gateY < 120,
  JSON.stringify(gaunt));

// --- Phase C: aerobatics freestyle scores a maneuver (detector wired live) ---
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ mode: 'freestyle', map: 'archipelago' }));
await click('#btn-start');
await settle(800);
const free0 = await sim('({ mode: __sim.game.mode, ac: __sim.ac.p.id, hasDetector: !!__sim.game.maneuver })');
check('freestyle starts in the Extra with a live maneuver detector',
  free0.mode === 'freestyle' && free0.ac === 'extra300' && free0.hasDetector, JSON.stringify(free0));
const man = await page.evaluate(() => {
  const d = window.__sim.game.maneuver;
  if (!d) return { ok: false };
  for (let i = 0; i < 80; i++) d.sample({ x: 0, y: 0, z: 1.05 }, 0.1); // a full pitch loop
  return { ok: true, count: d.count, last: d.last };
});
check('freestyle detector names a LOOP from a full pitch rotation', man.ok && man.last === 'LOOP', JSON.stringify(man));

// --- Phase C: logbook screen opens from the menu and shows stats + badges ---
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => document.querySelector('#menu-foot [data-act="logbook"]').click());
await settle(300);
const logb = await page.evaluate(() => ({
  shown: document.querySelector('#logbook').classList.contains('show'),
  badges: document.querySelectorAll('#logbook .lb-badge').length,
  stats: document.querySelectorAll('#logbook .lb-stat').length,
  hasLandings: /LANDINGS/.test(document.querySelector('#logbook')?.textContent || ''),
}));
check('logbook screen opens from the menu', logb.shown);
check('logbook shows badges + stat tiles', logb.badges === 6 && logb.stats >= 4 && logb.hasLandings, JSON.stringify(logb));
await shot('12-logbook');
await page.evaluate(() => document.querySelector('#logbook [data-act="menu"]').click());

// --- Phase E: settings screen, persistence, and mouse-fly ---
console.log('phase E — settings / mouse-fly…');
await page.evaluate(() => document.querySelector('#menu-foot [data-act="settings"]').click());
await settle(300);
const setShown = await page.evaluate(() => ({
  shown: document.querySelector('#settings').classList.contains('show'),
  rows: document.querySelectorAll('#settings .set-row').length,
}));
check('settings screen opens from the menu', setShown.shown && setShown.rows >= 5, JSON.stringify(setShown));
// Toggling INVERT PITCH persists to localStorage
await page.evaluate(() => document.querySelector('#settings [data-setting="invertPitch"]').click());
const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('archipelago.settings') || '{}'));
check('settings edit persists to archipelago.settings', persisted.invertPitch === true, JSON.stringify(persisted));
await page.evaluate(() => document.querySelector('#settings [data-setting="invertPitch"]').click()); // restore
await page.evaluate(() => document.querySelector('#settings [data-act="menu"]').click());
// Mouse-fly: hold RMB and drag up -> elevator goes positive (nose up). This is
// pure controls-layer behaviour (poll writes state regardless of game mode),
// so no flight/map reload is needed — keeps this immune to load stalls.
const mfElev = await page.evaluate(() => {
  const ev = (type, x, y, button = 2) => window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button }));
  ev('mousedown', 400, 400);
  ev('mousemove', 400, 250); // drag up 150 px = nose up
  window.__sim.controls.poll(1 / 60);
  const held = window.__sim.controls.state.elevator;
  ev('mouseup', 400, 250);
  window.__sim.controls.poll(1 / 60);
  return { held, released: window.__sim.controls.state.elevator };
});
check('mouse-fly RMB drag drives the elevator directly', mfElev.held > 0.5, JSON.stringify(mfElev));

// --- v5 R1: real-world airfields registered + one loads and spawns on runway ---
// Deterministic without network: the runway flatten makes height(spawn)==elev
// with zero tiles, and loadMap's ready() resolves whether tiles load or fail —
// so "spawns on the runway" holds online or offline.
console.log('real-world terrain…');
const rwMaps = await sim('window.__sim.world.maps.map(m => m.id)');
check('real-world airfields registered in the map list',
  ['changi', 'courchevel', 'innsbruck', 'queenstown', 'sanfrancisco'].every(id => rwMaps.includes(id)),
  JSON.stringify(rwMaps));
const flat = await sim(`(() => { const m = window.__sim.world.maps.find(m => m.id === 'changi');
  return { h: Math.round(m.height(m.runway.spawn.x, m.runway.spawn.z)), elev: m.runway.y }; })()`);
check('real-world runway flattens to field elevation (no tiles needed)', flat.h === flat.elev, JSON.stringify(flat));
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ mode: 'free', map: 'changi', aircraft: 'c172', time: 'day' }));
await click('#btn-start');
await page.waitForFunction('!document.querySelector("#loading").classList.contains("show") && window.__sim.game.state === "flying"', { timeout: 120000, polling: 1000 });
await settle(800);
const rw = await sim('({ map: window.__sim.map.id, ground: window.__sim.ac.onGround, crashed: window.__sim.ac.crashed, rwy: window.__sim.map.runway.name })');
check('real-world Changi loads and spawns on the runway', rw.map === 'changi' && rw.ground && !rw.crashed, JSON.stringify(rw));

// --- v5 R2: LIVE weather fetches Open-Meteo and applies real wind ---
console.log('live weather…');
await page.evaluate(() => {
  window.__origFetch = window.fetch;
  window.fetch = (u, o) => String(u).includes('open-meteo')
    ? Promise.resolve(new Response(
        JSON.stringify({ current: { wind_speed_10m: 6, wind_direction_10m: 210, wind_gusts_10m: 9, visibility: 6000, cloud_cover: 80 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }))
    : window.__origFetch(u, o);
});
await page.evaluate(() => { window.__sim.game.toMenu?.(); });
await page.evaluate(() => window.__sim.game.select({ mode: 'free', map: 'archipelago', aircraft: 'c172', time: 'day', weather: 'live' }));
await click('#btn-start');
await page.waitForFunction('!document.querySelector("#loading").classList.contains("show") && window.__sim.game.state === "flying"', { timeout: 120000, polling: 1000 });
await settle(1600); // let the (stubbed) fetch resolve and apply
const liveWx = await sim('window.__sim.windField.get()');
check('LIVE weather applies real wind (12 kt from 210)', liveWx.kts === 12 && liveWx.dirDeg === 210, JSON.stringify(liveWx));
await page.evaluate(() => { if (window.__origFetch) window.fetch = window.__origFetch; });

check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nAll E2E checks passed.' : `\n${failures} E2E check(s) FAILED.`);
process.exit(failures ? 1 : 0);
