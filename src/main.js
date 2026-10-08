// ARCHIPELAGO — boot, world/aircraft swap lifecycle, fixed-timestep loop.

import * as THREE from 'three';
import { createAircraft, step, resetOnRunway } from './physics/flightModel.js';
import { createTerrain, COARSE_TILE_RADIUS } from './terrain.js';
import { archipelagoMap } from './maps/archipelago.js';
import { singaporeMap } from './maps/singapore.js';
import { alpineMap } from './maps/alpine.js';
import { createRealWorldMap } from './maps/realworld.js';
import { AIRPORTS } from './maps/airports.js';
import { CATALOG, byId } from './aircraft/catalog.js';
import { createControls } from './controls.js';
import { createCameraRig } from './camera.js';
import { createEnvironment } from './environment.js';
import { createHUD } from './hud.js';
import { createRings } from './rings.js';
import { createAudio } from './audio.js';
import { createGameFlow } from './modes.js';
import { createTrainingSystem } from './training.js';
import { createEffects } from './effects.js';
import { createTrails } from './trails.js';
import { createTraffic } from './traffic.js';
import { createWind, WEATHER } from './physics/wind.js';
import { fetchLiveWeather } from './liveweather.js';
import { loadPlan } from './planner.js';
import { createMinimap } from './minimap.js';
import { createPanel } from './panel.js';
import { createAutopilot } from './autopilot.js';
import { buildGauntletCourse, GAUNTLET } from './activities.js';

const PHYS_DT = 1 / 120;
// Fictional maps first, then real-world airfields (streamed elevation).
const MAPS = [archipelagoMap, singaporeMap, alpineMap, ...AIRPORTS.map(createRealWorldMap)];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// v6: real shadows near the aircraft. The shadow camera is a small box that
// follows the plane (see environment.js) — a map-wide one would spend all its
// resolution on terrain nobody is looking at.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 20000);
scene.add(camera);   // hosts the cockpit frame (camera.js)

// Dynamic resolution. The scene is fill-rate bound (sky, ocean, clouds and
// terrain all cover the screen), so render scale is the one knob that moves
// frame rate on a weak GPU. Every ~1.5 s: below ~40 fps step the scale down,
// above ~56 fps creep it back up. Asymmetric steps + the dead band between
// them keep it from hunting.
let pixelRatioCap = 2, autoRes = true, resScale = 1;
let resAccT = 0, resFrames = 0;
const applyPixelRatio = () => renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap) * resScale);
function adaptResolution(rawDt) {
  if (!autoRes) return;
  resAccT += rawDt; resFrames++;
  if (resAccT < 1.5) return;
  const fps = resFrames / resAccT;
  resAccT = 0; resFrames = 0;
  const prev = resScale;
  if (fps < 40) resScale = Math.max(0.6, resScale - 0.1);
  else if (fps > 56) resScale = Math.min(1, resScale + 0.05);
  if (resScale !== prev) applyPixelRatio();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- world state (swappable) ---
const env = createEnvironment(scene, renderer);
let currentMap = archipelagoMap;
let terrain = createTerrain(scene, currentMap);
// Survives map swaps: loadMap builds a fresh streamer, which would otherwise
// come back with the coarse tier on regardless of the user's quality setting.
let qualityHigh = true;
let scenery = currentMap.createScenery(scene);
let rings = createRings(scene, { course: currentMap.raceCourse, heightFn: currentMap.height });
rings.show(false);
// Ambient boats / pattern traffic / birds (visual only; off on LOW quality).
let traffic = createTraffic(scene, currentMap, { enabled: qualityHigh });

// Collision height folds solid obstacles in; aero ground effect and AGL use
// bare terrain so overflying a rooftop doesn't fake ground effect.
const windField = createWind();
const collisionHeight = (x, z) => Math.max(currentMap.height(x, z), currentMap.obstacleTop(x, z));
const physEnv = {
  groundHeight: collisionHeight,
  terrainHeight: (x, z) => currentMap.height(x, z),
  isRunway: (x, z) => currentMap.isRunway(x, z),
  wind: (x, y, z) => windField.at(x, y, z),
};
env.setGround(collisionHeight);
env.onMapLoaded(currentMap, scenery);

function disposeGroup(g) {
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
      if (m.map) m.map.dispose();
      m.dispose();
    });
  });
}

let mapLoading = false; // frame loop must not stream chunks while loadMap pre-gens
async function loadMap(map) {
  if (map === currentMap) return;
  mapLoading = true;
  const loading = document.querySelector('#loading');
  loading.classList.add('show');
  terrain.disposeAll();
  scene.remove(scenery); disposeGroup(scenery);
  rings.dispose();
  traffic.dispose();
  gauntletRings?.dispose(); gauntletRings = null;
  gatesAdapter.clear();
  currentMap = map;
  // Real-world maps stream elevation tiles; wait for the ones around the spawn
  // before building terrain so chunks/minimap sample real ground, not sea. Caps
  // at 12 s so a slow network degrades to a flat world rather than hanging;
  // ready() also returns once fetches have failed, so offline resolves fast.
  // Tracker blockers that leave fetches pending (never fail) are forced settled
  // via abandonPending so the coarse-tier builder cannot spin forever.
  // Radius matches COARSE_TILE_RADIUS (terrain.js) — the true worst-case reach
  // of the coarse tier's own per-chunk readiness gate — so this pre-wait and
  // the frame-loop prefetch below can't drift apart again.
  if (map.prefetch) {
    map.prefetch(map.runway.spawn.x, map.runway.spawn.z, COARSE_TILE_RADIUS);
    const t0 = Date.now();
    while (!map.ready(map.runway.spawn.x, map.runway.spawn.z, COARSE_TILE_RADIUS) && Date.now() - t0 < 12000) {
      await new Promise(r => setTimeout(r, 60));
    }
    if (!map.ready(map.runway.spawn.x, map.runway.spawn.z, COARSE_TILE_RADIUS)) map.abandonPending?.();
    if (map.elevationOffline) hud.message('Elevation tiles offline — flying a flat world.', 5000);
  }
  terrain = createTerrain(scene, map);
  terrain.setFarTier(qualityHigh);   // a fresh streamer defaults to on — re-apply the setting
  terrain.setTrees(qualityHigh);
  scenery = map.createScenery(scene);
  rings = createRings(scene, { course: map.raceCourse, heightFn: map.height, finalDir: map.finalGateDir });
  rings.show(false);
  traffic = createTraffic(scene, map, { enabled: qualityHigh });
  env.setGround(collisionHeight);
  env.onMapLoaded(currentMap, scenery);
  terrain.prime(map.runway.spawn.x, map.runway.spawn.z);
  {
    const tBuild = Date.now();
    while (terrain.pendingCount() > 0 && Date.now() - tBuild < 8000) {
      terrain.update(map.runway.spawn.x, map.runway.spawn.z, 8);
      await new Promise(r => setTimeout(r));
    }
    // Force-flush anything still deferred (stalled elevation tiles).
    if (terrain.pendingCount() > 0) terrain.update(map.runway.spawn.x, map.runway.spawn.z, 999, true);
  }
  minimap.bake(map); // coarse height sampling — stays in this pre-gen path, never rAF
  refreshPlan();     // rebuild the demo flight plan for the new map's fixes/course
  loading.classList.remove('show');
  mapLoading = false;
}

// --- player (swappable aircraft) ---
const ac = createAircraft({ pos: { x: archipelagoMap.runway.spawn.x, y: archipelagoMap.runway.y + 1.3, z: 0 } });
let currentCraft = null;
let plane = null;

function setAircraft(craft) {
  if (craft === currentCraft) return;
  currentCraft = craft;
  if (plane) { scene.remove(plane.group); disposeGroup(plane.group); }
  plane = craft.buildMesh();
  plane.group.traverse(o => { if (o.isMesh) o.castShadow = true; });   // v6 shadows
  scene.add(plane.group);
  ac.p = { ...craft.params };
  controls.setRates(craft.params);
  hud.configure(craft.hud);
  camRig.configure(craft.camera);
}

const controls = createControls();
const hud = createHUD();
const camRig = createCameraRig(camera);
camRig.setGround((x, z) => collisionHeight(x, z));
const audio = createAudio();
const minimap = createMinimap();
const panel = createPanel();
panel.mount(document.body);
const autopilot = createAutopilot();
controls.on('minimap', () => {
  // v5-R4: M cycles off -> north-up chart -> aircraft-centered GPS.
  const m = minimap.toggle();
  if (m) hud.message(m === 1 ? 'Chart — north up.' : 'GPS — moving map, plan overlaid.', 1600);
});
controls.on('panel', () => panel.toggle());

// Low-level gauntlet gates — a low course built on demand for the gauntlet
// activity (returned by world.apply so modes.js drives it like the race rings).
let gauntletRings = null;
// Amber training gates — a second rings instance the trainer drives.
let trainGates = null;
const gatesAdapter = {
  set(course) {
    trainGates?.dispose();
    trainGates = createRings(scene, { course, radius: 45, theme: 'training', heightFn: currentMap.height });
    trainGates.show(true);
  },
  clear() { trainGates?.dispose(); trainGates = null; },
  check(a) { return trainGates ? trainGates.check(a) : null; },
  active() { return trainGates ? trainGates.active : 0; },
};

// Nominal coordinates so LIVE weather works on the fictional maps too; the
// real-world maps carry their own map.latLon.
const NOMINAL_LL = {
  archipelago: { lat: 10.5, lon: -60.0 },
  singapore: { lat: 1.36, lon: 103.99 },
  alpine: { lat: 46.0, lon: 7.0 },
};
const mapLatLon = (map) => map.latLon || NOMINAL_LL[map.id] || { lat: 1.36, lon: 103.99 };

// Fire-and-forget: fetch real conditions and apply them; fall back to calm on
// any failure. Not awaited by world.apply, so a slow/offline API never delays
// the flight — the wind just updates a moment later.
async function applyLiveWeather(map) {
  const ll = mapLatLon(map);
  try {
    const w = await fetchLiveWeather(ll.lat, ll.lon);
    windField.set(w.wind);
    env.setWeather(w.vis);
    hud.message(`Live weather · ${w.wind.kts} kt from ${String(w.wind.dirDeg).padStart(3, '0')}°${w.clamped ? ' (capped for flyability)' : ''}.`, 5200);
  } catch {
    windField.set({ ...WEATHER.calm, dirDeg: Math.round(Math.random() * 360) });
    env.resetWeather();
    hud.message('Live weather unavailable — calm winds.', 4500);
  }
}

const world = {
  maps: MAPS,
  aircraft: CATALOG,
  // Settings hook: cap the render pixel ratio (high-DPI perf knob).
  setPixelRatioCap(cap) { pixelRatioCap = cap; applyPixelRatio(); },
  setAutoRes(on) { autoRes = on !== false; if (!autoRes) { resScale = 1; applyPixelRatio(); } },
  get resScale() { return resScale; },
  // v6 quality knob: HIGH = coarse terrain tier out to 9 km + real shadows.
  // LOW is the pre-v6 view for weaker GPUs.
  setQuality(q) {
    qualityHigh = q !== 'low';
    terrain.setFarTier(qualityHigh);
    terrain.setTrees(qualityHigh);
    traffic.setEnabled(qualityHigh);
    env.setShadows(qualityHigh);
    renderer.shadowMap.enabled = qualityHigh;
  },
  async apply(sel) {
    await loadMap(MAPS.find(m => m.id === sel.map) || MAPS[0]);
    env.setTimeOfDay(sel.time || 'day');
    setAircraft(byId(sel.aircraft));
    if (sel.weather === 'live') {
      // Neutral until the async fetch resolves — never block flight start on it.
      windField.set({ kts: 0, gustKts: 0, turb: 0, dirDeg: Math.round(Math.random() * 360) });
      env.resetWeather();
      applyLiveWeather(currentMap);
    } else {
      // fresh preset wind each flight: preset strength, semi-random direction
      windField.set({ ...(WEATHER[sel.weather] || WEATHER.calm), dirDeg: Math.round(Math.random() * 360) });
      env.resetWeather();
    }
    if (sel.mode === 'gauntlet') {
      gauntletRings?.dispose();
      gauntletRings = createRings(scene, {
        course: buildGauntletCourse(currentMap.runway),
        radius: GAUNTLET.radius, clearance: GAUNTLET.clearance,
        theme: 'gauntlet', heightFn: currentMap.height,
      });
      gauntletRings.show(true);
      return { map: currentMap, rings: gauntletRings };
    }
    gauntletRings?.dispose(); gauntletRings = null;
    return { map: currentMap, rings };
  },
  // Menu showcase: the live scene behind the menu reflects the cheap parts of
  // the selection (aircraft + time of day) immediately. The map itself still
  // loads on START — a multi-second terrain rebuild per click would make the
  // map row unbrowsable.
  preview(sel) {
    setAircraft(byId(sel.aircraft));
    env.setTimeOfDay(sel.time || 'day');
    const r = currentMap.runway;
    resetOnRunway(ac, { x: r.spawn.x, z: r.spawn.z, y: r.y, headingRad: r.headingRad });
  },
  // Fresh trainer per lesson start so it binds the active map's runway.
  createTrainer(ui) {
    return createTrainingSystem({ ac, controls, map: currentMap, gates: gatesAdapter, ui, wind: windField });
  },
};

const fx = createEffects(scene);
const trails = createTrails(scene);
controls.on('smoke', () => {
  if (game.state !== 'flying') return;
  hud.message(trails.toggleSmoke() ? 'Smoke on.' : 'Smoke off.', 1200);
});
const game = createGameFlow({ ac, hud, audio, controls, camRig, world, fx, autopilot, panel });
setAircraft(byId('c172'));
hud.setCamera(camRig.modeName);

// Fixed per-map demo flight plan (runway → race gates → runway). An interactive
// waypoint planner is a follow-up; this ships NAV-hold now with a usable plan.
function buildDemoPlan(map) {
  if (map.fixes && map.fixes.length) return map.fixes.map(f => [f.x, f.z, f.y]);
  const rc = map.raceCourse || [];
  const pts = [];
  for (const i of [0, 3, 7]) if (rc[i]) pts.push([rc[i][0], rc[i][1], rc[i][2]]);
  pts.push([map.runway.x1 - 200, 0, map.runway.y + 120]); // return toward the runway
  return pts;
}
function refreshPlan() {
  // v5-R4: a plan the player saved on the PLAN screen beats the demo plan.
  const saved = loadPlan(currentMap.id);
  autopilot.setPlan(saved || buildDemoPlan(currentMap), [currentMap.runway.spawn.x, currentMap.runway.spawn.z]);
}
refreshPlan();

// Autopilot key toggles — only while flying, so menu/pause keystrokes are inert.
const flying = () => game.state === 'flying';
controls.on('ap', () => { if (flying()) autopilot.toggleMaster(ac, controls); });
controls.on('ap-hdg', () => { if (flying()) autopilot.toggleHdg(ac); });
controls.on('ap-alt', () => { if (flying()) autopilot.toggleAlt(ac); });
controls.on('ap-ias', () => { if (flying()) autopilot.toggleIas(ac, controls); });
controls.on('ap-nav', () => { if (flying()) autopilot.toggleNav(ac); });
controls.on('ap-wing', () => { if (flying()) autopilot.toggleWing(ac); });

window.__sim = { ac, controls, game, world, autopilot, env, windField, minimap,
  terrainCounts: () => terrain.counts(),
  get rings() { return gauntletRings || rings; }, get map() { return currentMap; },
  get camName() { return camRig.modeName; }, get trails() { return trails; }, get traffic() { return traffic; }, scene, renderer };

// --- boot: pre-build terrain around the spawn, then reveal the menu ---
// (setTimeout, not rAF: headless/hidden pages stop delivering animation frames
// when nothing renders, and we want boot to run at full speed anyway)
async function boot() {
  try {
    terrain.prime(currentMap.runway.spawn.x, currentMap.runway.spawn.z);
    const tBuild = Date.now();
    while (terrain.pendingCount() > 0 && Date.now() - tBuild < 8000) {
      terrain.update(currentMap.runway.spawn.x, currentMap.runway.spawn.z, 8);
      await new Promise(r => setTimeout(r));
    }
    if (terrain.pendingCount() > 0) {
      terrain.update(currentMap.runway.spawn.x, currentMap.runway.spawn.z, 999, true);
    }
    minimap.bake(currentMap); // initial-map bake, still in the setTimeout pre-gen path
  } catch (err) {
    console.error('boot failed', err);
  } finally {
    document.querySelector('#loading').classList.remove('show');
    game.toMenu();
    schedule();
  }
}
boot();

// rAF when the compositor is producing frames; setTimeout fallback when it
// stalls (headless browsers and some occluded windows starve rAF entirely).
// Generation ticket: rAF and the watchdog race for the same slot — whichever
// fires first wins, the stale sibling no-ops (else slow frames double-schedule
// and queued frames multiply until the main thread saturates).
let gen = 0;
function schedule() {
  const my = ++gen;
  // 250 ms fallback keeps sim time real-time even at 4 fps (physics dt clamp
  // is 0.25 s); rAF wins the race whenever the compositor is alive.
  requestAnimationFrame((t) => { if (my === gen) frame(t); });
  setTimeout(() => { if (my === gen) frame(performance.now()); }, 250);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'flying') {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  }
});

// --- main loop ---
let last = performance.now();
let acc = 0, elapsed = 0;
let lastCamMode = camRig.modeName;
const lastPos = { x: ac.pos.x, y: ac.pos.y, z: ac.pos.z };

function frame(now) {
  schedule(); // bumps gen: invalidates this generation's sibling callback
  const rawDt = (now - last) / 1000;
  const dt = Math.min(rawDt, 0.25);
  last = now;
  adaptResolution(rawDt);
  elapsed += dt;

  const isFlying = game.state === 'flying';
  const c = controls.poll(isFlying ? dt : 0);

  if (isFlying) {
    // Autopilot runs AFTER poll() and only writes axes the human isn't holding,
    // so keyboard input always wins and poll's keyboard path is untouched when
    // the AP is off. Once per frame (like the keyboard), before the phys steps.
    autopilot.update(ac, controls, dt);
    acc += dt;
    while (acc >= PHYS_DT) {
      step(ac, c, physEnv, PHYS_DT);
      acc -= PHYS_DT;
    }
  }

  plane.group.position.set(ac.pos.x, ac.pos.y, ac.pos.z);
  plane.group.quaternion.set(ac.q.x, ac.q.y, ac.q.z, ac.q.w);
  plane.animate(c, ac.rpmNorm, dt);
  plane.group.visible = camRig.modeName !== 'COCKPIT';
  // Six-pack auto-shows in the cockpit, auto-hides otherwise — but only on a
  // camera-mode transition, so it never flickers per frame and the manual `i`
  // toggle stays honoured within the current view until the next mode change.
  if (camRig.modeName !== lastCamMode) {
    lastCamMode = camRig.modeName;
    panel.setVisible(camRig.modeName === 'COCKPIT');
  }

  const ringBearing = game.tick(dt);
  if (trainGates) trainGates.update(dt);
  minimap.frame({
    flying: isFlying, map: currentMap, ac, rings,
    trainGates, raceMode: isFlying && game.mode === 'race',
    plan: autopilot.getPlan(), // v5-R4 moving-map route overlay
  });
  panel.update(ac);
  fx.update(dt);
  // A jump of hundreds of metres in one frame is a restart/teleport: drop the
  // trails, or they would draw a streak across the sky to the new position.
  if (Math.hypot(ac.pos.x - lastPos.x, ac.pos.y - lastPos.y, ac.pos.z - lastPos.z) > 150) trails.clear();
  lastPos.x = ac.pos.x; lastPos.y = ac.pos.y; lastPos.z = ac.pos.z;
  if (game.state === 'menu' && trails.smokeOn) trails.reset();
  trails.update(ac, isFlying ? dt : 0, camera.position, isFlying);
  windField.setTime(elapsed);
  scenery.userData?.tick?.(elapsed);   // lighthouse beams etc.
  const sock = scenery.userData?.windsock;
  if (sock) {
    const w = windField.get();
    const c = w.dirDeg * Math.PI / 180;
    sock.rotation.y = Math.atan2(Math.cos(c), Math.sin(c)); // tail points downwind
    sock.visible = true;
    sock.scale.setScalar(0.6 + 0.4 * Math.min(1, w.kts / 15));
  }

  if (!mapLoading) terrain.update(ac.pos.x, ac.pos.z);
  // v6: the coarse terrain tier samples out to COARSE_TILE_RADIUS (~9.9 km,
  // see terrain.js), so tiles must be fetched that far ahead or distant real
  // terrain bakes as flat sea. Cheap: at z12 a tile spans ~7-10 km, so this is
  // single digits of tiles (TILE_CAP is 220).
  if (!mapLoading && currentMap.prefetch) currentMap.prefetch(ac.pos.x, ac.pos.z, COARSE_TILE_RADIUS);
  env.update(ac, dt, elapsed, camera.position);
  traffic.update(dt, camera.position, elapsed);
  camRig.setInput(isFlying);
  if (game.state === 'menu') camRig.updateMenu(ac, dt);
  else camRig.update(ac, dt);
  if (isFlying) {
    hud.update(ac, c, dt, ringBearing ?? null);
    hud.setAP(autopilot.status(ac));
    audio.update(ac, c);
  }

  renderer.render(scene, camera);
  window.__sim.frames = (window.__sim.frames || 0) + 1;
}
