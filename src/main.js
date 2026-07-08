// ARCHIPELAGO — boot, world/aircraft swap lifecycle, fixed-timestep loop.

import * as THREE from 'three';
import { createAircraft, step } from './physics/flightModel.js';
import { createTerrain } from './terrain.js';
import { archipelagoMap } from './maps/archipelago.js';
import { singaporeMap } from './maps/singapore.js';
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
import { createWind, WEATHER } from './physics/wind.js';
import { createMinimap } from './minimap.js';
import { createPanel } from './panel.js';

const PHYS_DT = 1 / 120;
const MAPS = [archipelagoMap, singaporeMap];

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 20000);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- world state (swappable) ---
const env = createEnvironment(scene);
let currentMap = archipelagoMap;
let terrain = createTerrain(scene, currentMap);
let scenery = currentMap.createScenery(scene);
let rings = createRings(scene, { course: currentMap.raceCourse, heightFn: currentMap.height });
rings.show(false);

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
  gatesAdapter.clear();
  currentMap = map;
  terrain = createTerrain(scene, map);
  scenery = map.createScenery(scene);
  rings = createRings(scene, { course: map.raceCourse, heightFn: map.height, finalDir: map.finalGateDir });
  rings.show(false);
  env.setGround(collisionHeight);
  terrain.prime(map.runway.spawn.x, map.runway.spawn.z);
  while (terrain.pendingCount() > 0) {
    terrain.update(map.runway.spawn.x, map.runway.spawn.z, 8);
    await new Promise(r => setTimeout(r));
  }
  minimap.bake(map); // coarse height sampling — stays in this pre-gen path, never rAF
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
  scene.add(plane.group);
  ac.p = { ...craft.params };
  controls.setRates(craft.params);
  hud.configure(craft.hud);
  camRig.configure(craft.camera);
}

const controls = createControls();
const hud = createHUD();
const camRig = createCameraRig(camera);
const audio = createAudio();
const minimap = createMinimap();
const panel = createPanel();
panel.mount(document.body);
controls.on('minimap', () => minimap.toggle());
controls.on('panel', () => panel.toggle());

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

const world = {
  maps: MAPS,
  aircraft: CATALOG,
  async apply(sel) {
    await loadMap(MAPS.find(m => m.id === sel.map) || MAPS[0]);
    setAircraft(byId(sel.aircraft));
    // fresh wind each flight: preset strength, semi-random direction
    windField.set({ ...(WEATHER[sel.weather] || WEATHER.calm), dirDeg: Math.round(Math.random() * 360) });
    return { map: currentMap, rings };
  },
  // Fresh trainer per lesson start so it binds the active map's runway.
  createTrainer(ui) {
    return createTrainingSystem({ ac, controls, map: currentMap, gates: gatesAdapter, ui, wind: windField });
  },
};

const fx = createEffects(scene);
const game = createGameFlow({ ac, hud, audio, controls, camRig, world, fx });
setAircraft(byId('c172'));
hud.setCamera(camRig.modeName);

window.__sim = { ac, controls, game, world, get rings() { return rings; }, get map() { return currentMap; } };

// --- boot: pre-build terrain around the spawn, then reveal the menu ---
// (setTimeout, not rAF: headless/hidden pages stop delivering animation frames
// when nothing renders, and we want boot to run at full speed anyway)
async function boot() {
  terrain.prime(currentMap.runway.spawn.x, currentMap.runway.spawn.z);
  while (terrain.pendingCount() > 0) {
    terrain.update(currentMap.runway.spawn.x, currentMap.runway.spawn.z, 8);
    await new Promise(r => setTimeout(r));
  }
  minimap.bake(currentMap); // initial-map bake, still in the setTimeout pre-gen path
  document.querySelector('#loading').classList.remove('show');
  game.toMenu();
  schedule();
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

function frame(now) {
  schedule(); // bumps gen: invalidates this generation's sibling callback
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  elapsed += dt;

  const flying = game.state === 'flying';
  const c = controls.poll(flying ? dt : 0);

  if (flying) {
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
    flying, map: currentMap, ac, rings,
    trainGates, raceMode: flying && game.mode === 'race',
  });
  panel.update(ac);
  fx.update(dt);
  windField.setTime(elapsed);
  const sock = scenery.userData?.windsock;
  if (sock) {
    const w = windField.get();
    const c = w.dirDeg * Math.PI / 180;
    sock.rotation.y = Math.atan2(Math.cos(c), Math.sin(c)); // tail points downwind
    sock.visible = true;
    sock.scale.setScalar(0.6 + 0.4 * Math.min(1, w.kts / 15));
  }

  if (!mapLoading) terrain.update(ac.pos.x, ac.pos.z);
  env.update(ac, dt, elapsed);
  camRig.update(ac, dt);
  if (flying) {
    hud.update(ac, c, dt, ringBearing ?? null);
    audio.update(ac, c);
  }

  renderer.render(scene, camera);
  window.__sim.frames = (window.__sim.frames || 0) + 1;
}
