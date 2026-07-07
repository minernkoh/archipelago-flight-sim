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
await click('[data-sel="weather"]'); await click('[data-sel="weather"]'); // back to CALM for the flight tests

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

// --- free-flight landing rating toast ---
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
const toast = await page.evaluate(() => document.querySelector('#msg').textContent);
check('landing rating toast appears', /fpm/.test(toast), toast);

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

check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nAll E2E checks passed.' : `\n${failures} E2E check(s) FAILED.`);
process.exit(failures ? 1 : 0);
