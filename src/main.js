// ARCHIPELAGO — boot, world/aircraft swap lifecycle, fixed-timestep loop.

import * as THREE from 'three';
import { createAircraft, step, resetOnRunway } from './physics/flightModel.js';
import { createFailures, annunciators } from './physics/failures.js';
import { createTerrain, COARSE_TILE_RADIUS, GROUND_DETAIL } from './terrain.js';
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
import { NAV } from './instruments.js';
import { createRadios, ilsFrequency, fmtFreq } from './radios.js';
const radios = createRadios();
import { createGameFlow } from './modes.js';
import { createTrainingSystem } from './training.js';
import { createEffects } from './effects.js';
import { createTrails } from './trails.js';
import { createTraffic } from './traffic.js';
import { createWind, WEATHER, WET_WEATHER } from './physics/wind.js';
import { createWeatherFX } from './weather.js';
import { createReplay } from './replay.js';
import { createCockpit } from './cockpit.js';
import { fetchLiveWeather } from './liveweather.js';
import { loadPlan } from './planner.js';
import { createPost } from './post.js';
import { createMinimap } from './minimap.js';
import { createPanel } from './panel.js';
import { createAutopilot } from './autopilot.js';
import { createTcas, tcasCallout } from './tcas.js';
import { createVoice } from './atc.js';
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

// v12 clickable cockpit: a SHORT click on a cockpit button operates it (a drag
// is still free-look, camera.js); the starter is held while the button is.
const cockpitRay = new THREE.Raycaster();
const cockpitNdc = new THREE.Vector2();
function cockpitPick(e) {
  if (!cockpit || !cockpit.group.visible || game.state !== 'flying') return null;
  const r = renderer.domElement.getBoundingClientRect();
  cockpitNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  cockpitRay.setFromCamera(cockpitNdc, camera);
  return cockpit.pick(cockpitRay);
}
function cockpitAction(id) {
  const s = ac.sys;
  switch (id) {
    case 'bat': if (s) s.battery = !s.battery; break;
    case 'mix': if (s) s.mixture = s.mixture > 0.3 ? 0 : 1; break;
    // leaning: 3% of travel a click; RICH stops at full rich, LEAN can starve it
    case 'mix-ln': if (s && s.mixture > 0.3) s.mixture = Math.max(0.31, +(s.mixture - 0.03).toFixed(2)); break;
    case 'mix-rc': if (s && s.mixture > 0.3) s.mixture = Math.min(1, +(s.mixture + 0.03).toFixed(2)); break;
    case 'mags': if (s && s.mags !== 'START') { const C = ['OFF', 'R', 'L', 'BOTH']; s.mags = C[(C.indexOf(s.mags) + 1) % C.length]; } break;
    case 'flap-up': controls.flapStep(-1); break;
    case 'flap-dn': controls.flapStep(1); break;
    case 'com-dn': radios.step('com', -1); break;
    case 'com-up': radios.step('com', 1); break;
    case 'com-swap': radios.swap('com'); break;
    case 'nav-dn': radios.step('nav', -1); break;
    case 'nav-up': radios.step('nav', 1); break;
    case 'nav-swap': radios.swap('nav'); break;
    case 'lt-land': case 'lt-nav': case 'lt-strb': case 'lt-bcn': {
      const k = { 'lt-land': 'land', 'lt-nav': 'nav', 'lt-strb': 'strobe', 'lt-bcn': 'beacon' }[id];
      if (s && s.lights) s.lights[k] = !s.lights[k];
      break;
    }
    case 'page': cockpit?.togglePage?.(); break;
    case 'cabin': if (s) s.cabinHeat = !s.cabinHeat; break;
    case 'vent': if (s) s.vent = !s.vent; break;
    case 'pitot': if (s) s.pitotHeat = !s.pitotHeat; break;
    case 'altstat': if (s) s.altStatic = !s.altStatic; break;
    case 'carb': if (s) s.carbHeat = !s.carbHeat; break;
    case 'prime': if (s && !ac.engineRunning) s.primes = Math.min(9, (s.primes || 0) + 1); break;
    case 'xpdr': if (s) { const X = [1200, 7000, 7600, 7700]; s.xpdr = X[(X.indexOf(s.xpdr ?? 1200) + 1) % X.length]; } break;
    case 'fuel': if (s) { const F = ['BOTH', 'L', 'R', 'OFF']; s.fuel = F[(F.indexOf(s.fuel || 'BOTH') + 1) % F.length]; } break;
    case 'trim-dn': case 'trim-up': controls.state.trim = Math.max(-0.3, Math.min(0.3, (controls.state.trim || 0) + (id === 'trim-up' ? 0.03 : -0.03))); break;
    case 'alt': if (s) s.alt = !s.alt; break;
    case 'avm': if (s) s.avMaster = s.avMaster === false; break;
    case 'cb-alt': if (ac.breakers) ac.breakers.altFld = ac.breakers.altFld === false; break;
    case 'cb-avn': case 'cb-ap': case 'cb-flap': case 'cb-lts': case 'cb-com': case 'cb-xpdr': case 'cb-tc': case 'cb-pitot': { const k = id.slice(3); if (ac.breakers) ac.breakers[k] = !ac.breakers[k]; break; }
    // transponder code knobs: each digit steps 0-7 (squawk codes are octal)
    case 'xp-1': case 'xp-2': case 'xp-3': case 'xp-4': if (s) {
      const d = String(s.xpdr ?? 1200).padStart(4, '0').split(''), i = +id.slice(3) - 1;
      d[i] = String((+d[i] + 1) % 8); s.xpdr = +d.join('');
    } break;
    case 'hdg-dn': case 'hdg-up': autopilot.sel.hdg = (Math.round(autopilot.sel.hdg / 5) * 5 + (id === 'hdg-up' ? 5 : -5) + 360) % 360; break;
    case 'alt-dn': case 'alt-up': autopilot.sel.alt = Math.max(0, (Math.round(autopilot.sel.alt * 3.28084 / 100) * 100 + (id === 'alt-up' ? 100 : -100)) / 3.28084); break;
    default: if (id.startsWith('ap')) controls.fire(id === 'ap' ? 'ap' : id);
  }
  audio.click?.();
}
let cockpitDown = null;
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const hit = cockpitPick(e);
  cockpitDown = hit ? { id: hit.id, x: e.clientX, y: e.clientY } : null;
  if (hit?.id === 'start' && ac.sys) { ac.sys.mags = 'START'; audio.click?.(); }
});
window.addEventListener('mouseup', (e) => {
  const d = cockpitDown; cockpitDown = null;
  if (!d) return;
  if (d.id === 'start') { if (ac.sys?.mags === 'START') ac.sys.mags = 'BOTH'; return; }
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) cockpitAction(d.id);
});
let hoverT = 0;
renderer.domElement.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - hoverT < 90) return;
  hoverT = now;
  renderer.domElement.style.cursor = cockpitPick(e) ? 'pointer' : '';
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 20000);
scene.add(camera);   // hosts the cockpit frame (camera.js)

// Dynamic resolution. The scene is fill-rate bound (sky, ocean, clouds and
// terrain all cover the screen), so render scale is the one knob that moves
// frame rate on a weak GPU. Every ~1.5 s: below ~40 fps step the scale down,
// above ~56 fps creep it back up. Asymmetric steps + the dead band between
// them keep it from hunting.
let pixelRatioCap = 2, autoRes = true, resScale = 1;
// Post-processing (post.js): built lazily the first time it is wanted, so LOW
// quality and headless fallbacks never allocate the HDR target.
let post = null, postWanted = true, postSunDir = null, postSunK = 1;
let resAccT = 0, resFrames = 0;
const applyPixelRatio = () => {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap) * resScale);
  post?.setSize();
};
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
  post?.observeFps(fps, resScale);
  // Same idea one step further: still slow at the resolution floor, drop the
  // per-pixel ground/water detail for the rest of the session (the "lite"
  // shading path; LOW quality uses it from the start).
  if (detailAuto && resScale <= 0.6001 && fps < 24) { if (++slowDetail >= 2) { detailAuto = false; setDetail(0); } }
  else slowDetail = 0;
}
let detailAuto = true, slowDetail = 0;
const detailHooks = { weather: null };   // filled once weatherFx exists (it is created later)
function setDetail(k) {
  GROUND_DETAIL.value = k;
  env.setDetail(k);
  terrain.setDetail(k);
  detailHooks.weather?.setDetail(k);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post?.setSize();
});

// --- world state (swappable) ---
const env = createEnvironment(scene, renderer);
function setTimeOfDay(name) {
  env.setTimeOfDay(name);
  postSunDir = env.sunDirection();            // cached: post reads it every frame
  postSunK = name === 'night' ? 0.25 : 1;     // the "sun" is the moon at night
  post?.setSun(postSunDir, postSunK);
  cockpit?.setNight(name === 'night');        // instrument backlighting
}
env.setHeightFn(archipelagoMap.height);
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
env.applyEnv(traffic.group, 'traffic');
env.applyEnv(scenery, 'scenery');

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
  env.setHeightFn(map.height);
  autopilot.setRunway(map.runway);       // APR flies to this map's runway
  radios.setIls(ilsFrequency(map.id + ':' + map.runway.name));   // and NAV 1 comes pre-tuned to its ILS
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
  // OpenStreetMap scenery (real-world maps): wait up to 15 s so land cover,
  // forests and flat aprons are in the terrain from the first chunk. Slower
  // than that, the terrain is built without it and only the buildings and
  // roads appear when the data lands (osm.js explains why).
  if (map.loadScenery) {
    const inner = loading.querySelector('.inner'), was = inner?.textContent;
    if (inner) inner.textContent = 'LOADING OPENSTREETMAP SCENERY …';
    const ok = await Promise.race([map.loadScenery(), new Promise(r => setTimeout(() => r(false), 15000))]);
    if (ok) map.commitScenery();
    if (inner) inner.textContent = was;
  }
  const credit = document.querySelector('#map-credit');
  const showCredit = () => { if (!credit) return; credit.textContent = map.attribution || ''; credit.classList.toggle('on', !!map.attribution && currentMap === map); };
  showCredit();
  map.loadScenery?.().then(showCredit);
  terrain = createTerrain(scene, map);   // picks up GROUND_DETAIL (lite or full) at creation
  terrain.setFarTier(qualityHigh);   // a fresh streamer defaults to on — re-apply the setting
  terrain.setTrees(qualityHigh);
  scenery = map.createScenery(scene);
  rings = createRings(scene, { course: map.raceCourse, heightFn: map.height, finalDir: map.finalGateDir });
  rings.show(false);
  traffic = createTraffic(scene, map, { enabled: qualityHigh });
  env.applyEnv(traffic.group, 'traffic');
  env.applyEnv(scenery, 'scenery');
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
let cockpit = null, hull = [], cockpitDirty = true;   // 3D interior + the exterior meshes it replaces

function setAircraft(craft) {
  if (craft === currentCraft) return;
  currentCraft = craft;
  if (plane) { scene.remove(plane.group); disposeGroup(plane.group); }
  plane = craft.buildMesh();
  plane.group.traverse(o => { if (o.isMesh) o.castShadow = true; });   // v6 shadows
  scene.add(plane.group);
  env.applyEnv(plane.group, 'aircraft');   // PBR paint + glass reflect the sky
  hull = [];
  plane.group.traverse(o => { if (o.userData.hull) hull.push(o); });
  if (cockpit) { scene.remove(cockpit.group); cockpit.dispose(); }
  cockpit = createCockpit(craft.camera, craft.hud, craft.params);
  cockpit.setNight(env.state().night);
  scene.add(cockpit.group);
  env.applyEnv(cockpit.group, 'cockpit');
  cockpitDirty = true;
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
// Precipitation sky: overcast deck, rain, lightning (weather.js). The wind
// half of a preset goes to windField; the wet runway to physEnv.wet.
const weatherFx = createWeatherFX(scene, env, audio, (p) => windField.at(p.x, p.y, p.z));
detailHooks.weather = weatherFx;
weatherFx.setDetail(GROUND_DETAIL.value);
const skyId = (w) => (w === 'rain' || w === 'storm') ? w : 'clear';
function setSkyWeather(id) {
  weatherFx.set(skyId(id), currentMap);
  physEnv.wet = WET_WEATHER.has(id);
  physEnv.carbIceRisk = WET_WEATHER.has(id) ? 1 : 0;   // rain and storms: moist air ices carburettors
}
const audioView = { x: 0, y: 0, z: 0, mode: 'CHASE' }; // reused each frame for Doppler/distance
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
    setSkyWeather(w.sky || 'clear');
    hud.message(`Live weather · ${w.wind.kts} kt from ${String(w.wind.dirDeg).padStart(3, '0')}°${w.clamped ? ' (capped for flyability)' : ''}.`, 5200);
  } catch {
    windField.set({ ...WEATHER.calm, dirDeg: Math.round(Math.random() * 360) });
    env.resetWeather();
    setSkyWeather('clear');
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
  get detail() { return GROUND_DETAIL.value; },
  /** The AI circuit aircraft (aitraffic.js) as the tower sees it, or null. */
  /** The tower's instructions to the AI traffic since the last call (modes.js passes them to atc.js). */
  aiEvents() { return traffic?.drainEvents?.() ?? []; },
  aiTraffic(pos = ac.pos) {
    // the aircraft that matters to the tower: one on the runway or short final
    // first, otherwise the nearest
    const list = traffic?.aiStates?.() ?? [];
    if (!list.length) return null;
    // (an airliner on a parallel runway is traffic to watch, never one to wait for)
    const busy = list.find(a => a.onRunway && !a.otherRunway) || list.find(a => a.phase === 'final' && a.toAim < 2500 && !a.otherRunway);
    if (busy) return busy;
    // aircraft parked, taxiing or holding off the runway are not traffic
    let best = null, bd = Infinity;
    for (const a of list) {
      if (AI_GROUND_PHASES.has(a.phase) || (a.otherRunway && a.onRunway)) continue;
      const d = Math.hypot(a.x - pos.x, a.y - pos.y, a.z - pos.z); if (d < bd) { bd = d; best = a; }
    }
    return best;
  },
  // Tests/tools: force the full or lite shading path (overrides the auto drop).
  forceDetail(k) { detailAuto = false; setDetail(k); },
  // v6 quality knob: HIGH = coarse terrain tier out to 9 km + real shadows.
  // LOW is the pre-v6 view for weaker GPUs.
  setQuality(q) {
    qualityHigh = q !== 'low';
    terrain.setFarTier(qualityHigh);
    terrain.setTrees(qualityHigh);
    traffic.setEnabled(qualityHigh);
    env.setShadows(qualityHigh);
    renderer.shadowMap.enabled = qualityHigh;
    setDetail(qualityHigh && detailAuto ? 1 : 0);
    env.setReflections(qualityHigh);
    env.setVolumetricClouds(qualityHigh);
  },
  // POST FX setting: bloom + grade + sun flare. Still gated on HIGH quality and
  // on the session auto-disable in post.js.
  setPost(on) { postWanted = on !== false; post?.setWanted(postWanted); },
  async apply(sel) {
    await loadMap(MAPS.find(m => m.id === sel.map) || MAPS[0]);
    setTimeOfDay(sel.time || 'day');
    setAircraft(byId(sel.aircraft));
    if (sel.weather === 'live') {
      // Neutral until the async fetch resolves — never block flight start on it.
      windField.set({ kts: 0, gustKts: 0, turb: 0, dirDeg: Math.round(Math.random() * 360) });
      env.resetWeather();
      setSkyWeather('clear');
      applyLiveWeather(currentMap);
    } else {
      // fresh preset wind each flight: preset strength, semi-random direction
      windField.set({ ...(WEATHER[sel.weather] || WEATHER.calm), dirDeg: Math.round(Math.random() * 360) });
      env.resetWeather();
      setSkyWeather(sel.weather);
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
    setTimeOfDay(sel.time || 'day');
    if (weatherFx.preset !== skyId(sel.weather)) setSkyWeather(sel.weather);   // the backdrop shows rain/storm too
    const r = currentMap.runway;
    resetOnRunway(ac, { x: r.spawn.x, z: r.spawn.z, y: r.y, headingRad: r.headingRad });
  },
  // Fresh trainer per lesson start so it binds the active map's runway.
  createTrainer(ui) {
    return createTrainingSystem({ ac, controls, map: currentMap, gates: gatesAdapter, ui, wind: windField });
  },
};

const fx = createEffects(scene);
// Instant replay (X): records the flight, plays it back as a ghost with
// cinematic cameras. Touchdowns and the crash replay as one-shot effects.
const replay = createReplay({
  camera, ground: (x, z) => collisionHeight(x, z),
  events: {
    touchdown: (g) => { fx.touchdown(g.pos, g.groundSpeed, Math.max(0, -g.vel.y * 196.85)); audio.chirp(); },
    crash: (g) => { fx.crash(g.pos, g.vel); audio.thud(); },
  },
});
const trails = createTrails(scene);
controls.on('smoke', () => {
  if (game.state !== 'flying') return;
  hud.message(trails.toggleSmoke() ? 'Smoke on.' : 'Smoke off.', 1200);
});
const failures = createFailures();
const game = createGameFlow({ ac, hud, audio, controls, camRig, world, fx, autopilot, panel, replay, failures });
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
controls.on('ap-alt', () => { if (flying()) autopilot.toggleAlt(ac, controls); });
controls.on('ap-ias', () => { if (flying()) autopilot.toggleIas(ac, controls); });
controls.on('ap-nav', () => { if (flying()) autopilot.toggleNav(ac); });
controls.on('ap-wing', () => { if (flying()) autopilot.toggleWing(ac); });
controls.on('ap-apr', () => {
  if (!flying()) return;
  // APR flies the ILS, so NAV 1 has to be on it (it comes pre-tuned)
  if ((!radios.ilsTuned || ac.breakers?.com === false) && !autopilot.modes.apr) { hud.message(`APR needs the ILS: tune NAV 1 to ${fmtFreq(radios.ils)}`, 3500); return; }
  autopilot.toggleApr(ac, controls);
});

// ---- TCAS (tcas.js) against the airborne AI traffic: HUD box, ND symbols, aural.
// Transport jets get resolution advisories (above 1000 ft AGL, as the real
// system inhibits them low down); everything else carries a TAS: TA only.
// Standby on the ground, so taxiing past the circuit traffic stays quiet.
const AI_GROUND_PHASES = new Set(['parked', 'pushback', 'taxi', 'holding', 'lineup', 'gone']);
const tcas = createTcas();
const tcasVoice = createVoice();
const tcasEl = document.getElementById('tcas');
let tcasState = null, tcasInject = null, tcasShown = '', tcasForceRa = null;
function updateTcas(active) {
  // TCAS / TAS interrogate through the transponder: dead with its breaker out
  if (!active || ac.onGround || ac.crashed || ac.breakers?.xpdr === false) {
    if (tcasState) { tcas.reset(); tcasState = null; }
  } else {
    const agl = ac.pos.y - currentMap.height(ac.pos.x, ac.pos.z);
    tcas.setRa(tcasForceRa ?? (ac.p.engine?.type === 'jet' && !ac.p.engine?.afterburner && agl > 305));
    const q = ac.q;
    const own = { pos: ac.pos, vel: ac.vel, headingRad: Math.atan2(-2 * (q.x * q.z - q.w * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) };
    const list = tcasInject ?? traffic.aiStates().filter(a => !AI_GROUND_PHASES.has(a.phase) && a.visible !== false);
    tcasState = tcas.update(own, list, elapsed);
    const say = tcasCallout(tcasState);
    if (say) {
      tcasVoice.speak(say);
      if (tcasState.event !== 'CLEAR') audio.caution?.(tcasState.event === 'RA');
    }
  }
  const lv = tcasState?.level || '';
  const key = lv + (tcasState?.sense || '');
  if (tcasEl && key !== tcasShown) {
    tcasShown = key;
    tcasEl.className = lv ? 'show ' + lv.toLowerCase() : '';
    tcasEl.textContent = lv === 'RA' ? (tcasState.sense === 'CLIMB' ? '\u25b2 CLIMB' : '\u25bc DESCEND') : lv === 'TA' ? 'TRAFFIC' : '';
  }
}

window.__sim = { get tcas() { return tcasState; }, tcasInject: (list) => { tcasInject = list; }, tcasForceRa: (on) => { tcasForceRa = on; }, ac, controls, game, world, autopilot, audio, failures, radios, env, windField, minimap, camRig, camera, weatherFx, physEnv, replay, get simTime() { return elapsed; }, get cockpit() { return cockpit; }, cockpitAction: (id) => cockpitAction(id), annunciators: () => annunciators(ac), get plane() { return plane; },
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
let lastCamMode = null;   // last cockpit-view state (true/false)
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
    // v11: the autopilot runs INSIDE the fixed 120 Hz loop. Once per rendered
    // frame it was a ~3 Hz sampled controller on a slow machine, and its
    // rate-damping terms went unstable (full-deflection elevator bang-bang,
    // +/-10 deg bank wander). Per physics step it behaves the same at any fps.
    acc += dt;
    while (acc >= PHYS_DT) {
      autopilot.update(ac, controls, PHYS_DT);
      step(ac, c, physEnv, PHYS_DT);
      const failed = failures.update(ac, PHYS_DT);
      if (failed && failed.kind !== 'silent') {
        hud.message(`<b class="${failed.kind}">${failed.kind === 'warning' ? 'WARNING' : 'CAUTION'}</b> ${failed.label}`, 6000);
        audio.caution?.(failed.kind === 'warning');
      }
      acc -= PHYS_DT;
    }
    replay.record(dt, ac, c);
  }
  // Instant replay renders a recorded ghost instead of the physics state.
  const replaying = replay.active;
  if (replaying) replay.update(dt);
  const view = replaying ? replay.ghost : ac;
  const vc = replaying ? replay.controls : c;

  plane.group.position.set(view.pos.x, view.pos.y, view.pos.z);
  plane.group.quaternion.set(view.q.x, view.q.y, view.q.z, view.q.w);
  plane.animate(vc, view.rpmNorm, dt, view);
  // Cockpit view: the 3D interior replaces the exterior hull; wings, struts,
  // props and engines stay visible through the glass.
  const inCockpit = !replaying && camRig.modeName === 'COCKPIT';
  if (inCockpit !== lastCamMode || cockpitDirty) {
    lastCamMode = inCockpit; cockpitDirty = false;
    for (const h of hull) h.visible = !inCockpit;
    cockpit.group.visible = inCockpit;
    if (inCockpit) cockpit.setNight(env.state().night);
  }
  if (inCockpit) {
    const apS = autopilot.status(ac);
    const flapNames = currentCraft?.hud?.flapNames;
    cockpit.setUi({
      ap: apS.on, 'ap-hdg': apS.hdg, 'ap-alt': apS.alt, 'ap-ias': apS.ias, 'ap-nav': apS.nav,
      'ap-apr': apS.apr ? (apS.apr.loc && apS.apr.gs ? true : 'APR·') : false,
      // the + knobs show the selected value, so the setting is readable in the cockpit
      'hdg-up': '+' + String(Math.round(apS.selHdg) % 360).padStart(3, '0'), 'alt-up': '+' + (Math.round(apS.selAlt * 3.28084 / 100) * 100),
      bat: !!ac.sys?.battery, start: ac.sys?.mags === 'START',
      mix: (ac.sys?.mixture ?? 1) <= 0.3 ? false : (ac.sys?.mixture ?? 1) >= 0.995 ? true : 'MIX ' + Math.round(ac.sys.mixture * 100),
      mags: ac.sys ? (ac.sys.mags === 'OFF' ? false : 'M ' + (ac.sys.mags === 'START' ? 'ST' : ac.sys.mags)) : false,
      'lt-land': ac.sys?.lights?.land !== false, 'lt-nav': ac.sys?.lights?.nav !== false,
      'lt-strb': ac.sys?.lights?.strobe !== false, 'lt-bcn': ac.sys?.lights?.beacon !== false,
      fuel: ac.sys?.fuel === 'OFF' ? false : 'F ' + (ac.sys?.fuel || 'BOTH'),
      carb: !!ac.sys?.carbHeat, prime: ac.sys?.primes ? 'PR ' + ac.sys.primes : false,
      xpdr: String(ac.sys?.xpdr ?? 1200),
      altstat: !!ac.sys?.altStatic, cabin: !!ac.sys?.cabinHeat, vent: !!ac.sys?.vent, pitot: !!ac.sys?.pitotHeat,
      'cb-pitot': ac.breakers?.pitot !== false, 'cb-alt': ac.breakers?.altFld !== false,
      alt: ac.sys?.alt !== false && !!ac.sys?.battery, avm: ac.sys?.avMaster !== false,
      'trim-up': (controls.state.trim || 0) > 0.005 ? 'T ' + Math.round(controls.state.trim * 100) : false,
      'trim-dn': (controls.state.trim || 0) < -0.005 ? 'T ' + Math.round(controls.state.trim * 100) : false,
      'cb-avn': ac.breakers?.avn !== false, 'cb-ap': ac.breakers?.ap !== false, 'cb-flap': ac.breakers?.flap !== false,
      'cb-lts': ac.breakers?.lts !== false, 'cb-com': ac.breakers?.com !== false, 'cb-xpdr': ac.breakers?.xpdr !== false, 'cb-tc': ac.breakers?.tc !== false,
      ...Object.fromEntries([0, 1, 2, 3].map(i => ['xp-' + (i + 1), String(ac.sys?.xpdr ?? 1200).padStart(4, '0')[i]])),
      'flap-up': controls.flapDetent === 0, 'flap-dn': controls.flapDetent > 0 ? (flapNames?.[controls.flapDetent] ?? true) : false,
    }, ac.avionics === false || ac.breakers?.com === false ? null : {
      com: { act: fmtFreq(radios.com.act), sby: fmtFreq(radios.com.sby) },
      nav: { act: fmtFreq(radios.nav.act), sby: fmtFreq(radios.nav.sby), ils: radios.ilsTuned },
      tcas: tcasState?.targets ?? null,
    });
    cockpit.update(ac, c, dt);
  }

  const ringBearing = game.tick(dt);
  if (trainGates) trainGates.update(dt);
  minimap.frame({
    flying: isFlying, map: currentMap, ac, rings,
    trainGates, raceMode: isFlying && game.mode === 'race',
    plan: autopilot.getPlan(), // v5-R4 moving-map route overlay
  });
  panel.update(ac);
  if (isFlying) fx.wake(ac, dt);
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

  if (!mapLoading) terrain.update(view.pos.x, view.pos.z);
  // v6: the coarse terrain tier samples out to COARSE_TILE_RADIUS (~9.9 km,
  // see terrain.js), so tiles must be fetched that far ahead or distant real
  // terrain bakes as flat sea. Cheap: at z12 a tile spans ~7-10 km, so this is
  // single digits of tiles (TILE_CAP is 220).
  if (!mapLoading && currentMap.prefetch) currentMap.prefetch(view.pos.x, view.pos.z, COARSE_TILE_RADIUS);
  env.update(view, dt, elapsed, camera.position, camera);
  // the circuit traffic steps away from you; the intruder of a TCAS RA flies the complementary sense
  traffic.update(dt, camera.position, elapsed, isFlying ? ac.pos : null,
    tcasState?.level === 'RA' ? { id: tcasState.targets.find(x => x.level === 'RA')?.id, sense: tcasState.sense } : null,
    isFlying ? { vel: ac.vel, onGround: ac.onGround } : null);
  updateTcas(isFlying && !replaying);
  camRig.setInput(isFlying);
  if (game.state === 'menu') camRig.updateMenu(ac, dt);
  else if (!replaying) camRig.update(ac, dt);
  weatherFx.update(dt, elapsed, view, camera, replaying ? 'REPLAY' : camRig.modeName);
  physEnv.inCloud = env.skyState?.inCloud || 0;          // visible moisture for pitot icing
  if (isFlying) {
    hud.update(ac, c, dt, ringBearing ?? null);
    const apS = autopilot.status(ac);
    hud.setAP(apS);
    hud.setAnnunciators?.(annunciators(ac));
    // ILS receiver: needles live inside the localizer beam out to 18 km (or whenever APR is armed)
    const appr = apS.ils;
    NAV.ils = radios.ilsTuned && ac.breakers?.com !== false && appr && appr.dist > -300 && appr.dist < 18000 && (apS.apr || Math.abs(appr.locDots) < 5) ? appr : null;
    audioView.x = camera.position.x; audioView.y = camera.position.y; audioView.z = camera.position.z;
    audioView.mode = camRig.modeName;
    audio.update(ac, c, audioView);
  } else if (replaying) {
    // engine + Doppler from the ghost: flybys and tower shots sound right
    audioView.x = camera.position.x; audioView.y = camera.position.y; audioView.z = camera.position.z;
    audioView.mode = 'REPLAY';
    audio.update(view, vc, audioView);
  }

  camera.updateMatrixWorld();
  env.renderReflection(camera);          // planar water reflection (full detail only)
  if (postWanted && qualityHigh && !(post && post.disabled)) {
    if (!post) { post = createPost(renderer, scene, camera); if (postSunDir) post.setSun(postSunDir, postSunK); }
    post.render();
  } else renderer.render(scene, camera);
  window.__sim.frames = (window.__sim.frames || 0) + 1;
}
