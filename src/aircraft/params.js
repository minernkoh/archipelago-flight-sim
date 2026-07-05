// Per-aircraft physics presets. THREE-free on purpose: the headless physics
// tests import this file under Node. Mesh builders and HUD metadata live in
// catalog.js — keep anything renderer-related out of here.
//
// Body frame: +x forward, +y up, +z right.
// gear[].steer is a signed gain: +1 nosewheel, -1 tailwheel (an aft steering
// wheel must deflect opposite to yaw the nose the same way), 0 unsteered.

export const AIRCRAFT = {
  c172: {
    id: 'c172', name: 'Skyhawk',
    mass: 1100, wingArea: 16.2, span: 11.0, chord: 1.5,
    Ix: 1300, Iy: 2650, Iz: 1850,
    CL0: 0.30, CLalpha: 5.5, alphaStall: 0.26,
    CD0: 0.030, kInduced: 0.054, CYbeta: -0.35,
    flapCL: 0.55, flapCD: 0.065, flapStallShift: -0.035,
    Cm0: 0.045, Cmalpha: -1.15, Cmq: -14.0, Cmde: 0.5, CmFlap: -0.10,
    Clp: -0.48, Clda: 0.115, Clbeta: -0.09, Clr: 0.10,
    Cnbeta: 0.11, Cnr: -0.14, Cndr: 0.075, CnAdverse: 0.012,
    engine: { type: 'prop', tau: 0.15, powerW: 134000, propEff: 0.75, staticThrust: 2250 },
    sas: null,
    maxSpeed: 88, gearHeight: 1.25,
    crashSink: 3.6, maxSteer: 0.38,
    spawn: { pitch: 0 },
    gear: [
      { name: 'nose',  r: { x: 1.70, y: -1.25, z: 0 },     k: 30000, c: 1600, steer: 1,  brake: false },
      { name: 'mainL', r: { x: -0.35, y: -1.25, z: -1.15 }, k: 42000, c: 2600, steer: 0, brake: true },
      { name: 'mainR', r: { x: -0.35, y: -1.25, z: 1.15 },  k: 42000, c: 2600, steer: 0, brake: true },
    ],
    probes: [
      { name: 'prop strike',    r: { x: 2.55, y: -0.55, z: 0 } },
      { name: 'wing strike',    r: { x: 0.30, y: 0.45, z: -5.4 } },
      { name: 'wing strike',    r: { x: 0.30, y: 0.45, z: 5.4 } },
      { name: 'tail strike',    r: { x: -3.90, y: -0.40, z: 0 } },
      { name: 'terrain impact', r: { x: 0.00, y: 0.30, z: 0 } },
    ],
  },

  extra300: {
    id: 'extra300', name: 'Extra 300',
    mass: 950, wingArea: 10.7, span: 8.0, chord: 1.35,
    Ix: 700, Iy: 1400, Iz: 950,
    // Symmetric aerobatic wing: no camber, flies inverted as happily as upright.
    CL0: 0.0, CLalpha: 5.9, alphaStall: 0.28,
    CD0: 0.032, kInduced: 0.063, CYbeta: -0.30,
    flapCL: 0, flapCD: 0, flapStallShift: 0,
    Cm0: 0.02, Cmalpha: -0.9, Cmq: -11.0, Cmde: 0.55, CmFlap: 0,
    Clp: -0.45, Clda: 0.35, Clbeta: -0.04, Clr: 0.08,
    Cnbeta: 0.10, Cnr: -0.13, Cndr: 0.10, CnAdverse: 0.015,
    engine: { type: 'prop', tau: 0.12, powerW: 164000, propEff: 0.8, staticThrust: 3400 },
    sas: null,
    maxSpeed: 113, gearHeight: 1.05,
    crashSink: 3.2, maxSteer: 0.45,
    // Taildragger: rests tail-low; mains ahead of the CG, steerable tailwheel
    // aft. Rest pitch = atan2 of the wheel-contact height difference.
    spawn: { pitch: 0.124 },
    gear: [
      { name: 'mainL', r: { x: 0.55, y: -1.05, z: -0.95 }, k: 40000, c: 2400, steer: 0,  brake: true },
      { name: 'mainR', r: { x: 0.55, y: -1.05, z: 0.95 },  k: 40000, c: 2400, steer: 0,  brake: true },
      { name: 'tail',  r: { x: -3.45, y: -0.55, z: 0 },    k: 15000, c: 800,  steer: -1, brake: false },
    ],
    probes: [
      { name: 'prop strike',    r: { x: 2.9, y: -0.75, z: 0 } },
      { name: 'wing strike',    r: { x: 0.3, y: -0.35, z: -4.1 } },
      { name: 'wing strike',    r: { x: 0.3, y: -0.35, z: 4.1 } },
      { name: 'terrain impact', r: { x: 0.0, y: 0.30, z: 0 } },
    ],
  },

  hornet: {
    id: 'hornet', name: 'Hornet',
    mass: 16000, wingArea: 38, span: 12.3, chord: 3.5,
    Ix: 23000, Iy: 180000, Iz: 160000,
    CL0: 0.05, CLalpha: 4.2, alphaStall: 0.32,
    CD0: 0.028, kInduced: 0.107, CYbeta: -0.80,
    flapCL: 0.5, flapCD: 0.05, flapStallShift: -0.02,
    Cm0: 0.0, Cmalpha: -0.8, Cmq: -6.0, Cmde: 0.35, CmFlap: -0.05,
    Clp: -0.40, Clda: 0.28, Clbeta: -0.05, Clr: 0.05,
    Cnbeta: 0.15, Cnr: -0.20, Cndr: 0.12, CnAdverse: 0.005,
    engine: { type: 'jet', tau: 0.8, maxThrust: 128000, afterburner: { mult: 1.5 } },
    sas: null,
    maxSpeed: 360, gearHeight: 2.2,
    crashSink: 4.5, maxSteer: 0.30,
    spawn: { pitch: 0 },
    gear: [
      { name: 'nose',  r: { x: 5.5, y: -2.2, z: 0 },    k: 500000, c: 30000, steer: 1, brake: false },
      { name: 'mainL', r: { x: -1.2, y: -2.2, z: -2.0 }, k: 700000, c: 45000, steer: 0, brake: true },
      { name: 'mainR', r: { x: -1.2, y: -2.2, z: 2.0 },  k: 700000, c: 45000, steer: 0, brake: true },
    ],
    probes: [
      { name: 'terrain impact', r: { x: 8.8, y: -0.8, z: 0 } },
      { name: 'wing strike',    r: { x: -1.0, y: 0.0, z: -6.1 } },
      { name: 'wing strike',    r: { x: -1.0, y: 0.0, z: 6.1 } },
      { name: 'tail strike',    r: { x: -8.4, y: -0.9, z: 0 } },
      { name: 'terrain impact', r: { x: 0.0, y: 0.5, z: 0 } },
    ],
  },

  heavy: {
    id: 'heavy', name: 'Heavy 350',
    mass: 200000, wingArea: 442, span: 64.8, chord: 7,
    Ix: 1.2e7, Iy: 4.5e7, Iz: 3.3e7,
    CL0: 0.25, CLalpha: 5.7, alphaStall: 0.24,
    CD0: 0.023, kInduced: 0.0394, CYbeta: -0.50,
    flapCL: 0.85, flapCD: 0.09, flapStallShift: -0.04,
    Cm0: 0.03, Cmalpha: -1.3, Cmq: -20.0, Cmde: 0.35, CmFlap: -0.12,
    Clp: -0.45, Clda: 0.05, Clbeta: -0.10, Clr: 0.10,
    Cnbeta: 0.12, Cnr: -0.25, Cndr: 0.06, CnAdverse: 0.008,
    engine: { type: 'jet', tau: 4.0, maxThrust: 748000, afterburner: null },
    sas: null,
    maxSpeed: 175, gearHeight: 5.5,
    crashSink: 4.5, maxSteer: 0.30,
    spawn: { pitch: 0 },
    gear: [
      { name: 'nose',  r: { x: 25.0, y: -5.5, z: 0 },    k: 3e6, c: 200000, steer: 1, brake: false },
      { name: 'mainL', r: { x: -2.0, y: -5.5, z: -5.2 }, k: 5e6, c: 350000, steer: 0, brake: true },
      { name: 'mainR', r: { x: -2.0, y: -5.5, z: 5.2 },  k: 5e6, c: 350000, steer: 0, brake: true },
    ],
    probes: [
      { name: 'terrain impact', r: { x: 30.0, y: -1.5, z: 0 } },
      { name: 'wing strike',    r: { x: -3.0, y: 2.0, z: -32 } },
      { name: 'wing strike',    r: { x: -3.0, y: 2.0, z: 32 } },
      { name: 'tail strike',    r: { x: -29.0, y: -1.5, z: 0 } },
      { name: 'terrain impact', r: { x: 0.0, y: 0.0, z: 0 } },
    ],
  },

  spirit: {
    id: 'spirit', name: 'Spirit',
    mass: 100000, wingArea: 478, span: 52.4, chord: 9,
    Ix: 6e6, Iy: 1.4e7, Iz: 8e6,
    CL0: 0.15, CLalpha: 4.5, alphaStall: 0.22,
    CD0: 0.008, kInduced: 0.0616, CYbeta: -0.10,
    flapCL: 0, flapCD: 0, flapStallShift: 0,
    Cm0: 0.02, Cmalpha: -0.35, Cmq: -4.0, Cmde: 0.5, CmFlap: 0,
    Clp: -0.50, Clda: 0.15, Clbeta: -0.05, Clr: 0.05,
    // Flying wing: mildly directionally UNSTABLE (negative Cnbeta) with almost
    // no damping — this is why it cannot fly without the SAS below.
    Cnbeta: -0.03, Cnr: -0.02, Cndr: 0.04, CnAdverse: 0.02,
    engine: { type: 'jet', tau: 1.5, maxThrust: 308000, afterburner: null },
    // Fly-by-wire keeps it pointed; without this it departs (see physics test).
    sas: { yawDamper: 0.6, betaGain: 0.3, pitchDamper: 8 },
    maxSpeed: 230, gearHeight: 3.0,
    crashSink: 4.0, maxSteer: 0.25,
    spawn: { pitch: 0 },
    gear: [
      { name: 'nose',  r: { x: 6.5, y: -3.0, z: 0 },    k: 1.5e6, c: 100000, steer: 1, brake: false },
      { name: 'mainL', r: { x: -1.5, y: -3.0, z: -3.5 }, k: 2.5e6, c: 170000, steer: 0, brake: true },
      { name: 'mainR', r: { x: -1.5, y: -3.0, z: 3.5 },  k: 2.5e6, c: 170000, steer: 0, brake: true },
    ],
    probes: [
      { name: 'terrain impact', r: { x: 10.5, y: -1.0, z: 0 } },
      { name: 'wing strike',    r: { x: -6.0, y: 0.3, z: -26 } },
      { name: 'wing strike',    r: { x: -6.0, y: 0.3, z: 26 } },
      { name: 'tail strike',    r: { x: -8.0, y: -1.0, z: 0 } },
      { name: 'terrain impact', r: { x: 0.0, y: 1.2, z: 0 } },
    ],
  },
};
