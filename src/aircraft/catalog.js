// Aircraft catalog: physics params + mesh builder + HUD/camera metadata.
// Physics-only presets live in params.js (THREE-free for headless tests);
// this file is the browser-side assembly point.

import { AIRCRAFT } from './params.js';
import { MESH_BUILDERS } from './meshes.js';

export const CATALOG = [
  {
    id: 'c172',
    params: AIRCRAFT.c172,
    buildMesh: MESH_BUILDERS.c172,
    tagline: 'the trainer — honest and forgiving',
    hud: { tapeMaxKt: 220, altMaxFt: 15000, flapNames: ['UP', '10°', '25°', 'FULL'] },
    camera: { chaseDist: 14, chaseHeight: 4.2, orbitR: 26, cockpit: { fwd: 0.55, up: 0.42 } },
  },
  {
    id: 'extra300',
    params: AIRCRAFT.extra300,
    buildMesh: MESH_BUILDERS.extra300,
    tagline: 'aerobat — rolls on a thought, lands like a knife fight',
    hud: { tapeMaxKt: 260, altMaxFt: 15000, flapNames: null },
    camera: { chaseDist: 12, chaseHeight: 3.6, orbitR: 22, cockpit: { fwd: 0.3, up: 0.5 } },
  },
  {
    id: 'hornet',
    params: AIRCRAFT.hornet,
    buildMesh: MESH_BUILDERS.hornet,
    tagline: 'jet — afterburner past 600 kt',
    hud: { tapeMaxKt: 800, altMaxFt: 45000, flapNames: ['UP', '1', '2', 'FULL'] },
    camera: { chaseDist: 26, chaseHeight: 7, orbitR: 40, cockpit: { fwd: 6.2, up: 0.9 } },
  },
  {
    id: 'heavy',
    params: AIRCRAFT.heavy,
    buildMesh: MESH_BUILDERS.heavy,
    tagline: 'airliner — 200 tonnes of patience',
    hud: { tapeMaxKt: 420, altMaxFt: 45000, flapNames: ['UP', '1', '2', 'FULL'] },
    camera: { chaseDist: 110, chaseHeight: 28, orbitR: 160, cockpit: { fwd: 26, up: 2.5 } },
  },
  {
    id: 'spirit',
    params: AIRCRAFT.spirit,
    buildMesh: MESH_BUILDERS.spirit,
    tagline: 'flying wing — the computers keep it pointed',
    hud: { tapeMaxKt: 480, altMaxFt: 45000, flapNames: null },
    camera: { chaseDist: 70, chaseHeight: 18, orbitR: 110, cockpit: { fwd: 8, up: 1.2 } },
  },
];

export const byId = (id) => CATALOG.find(a => a.id === id) || CATALOG[0];
