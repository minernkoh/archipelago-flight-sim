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
    // Clean polar gives L/Dmax 10.8; the windmilling-prop term below adds
    // 0.0153 power-off, landing the glide on the POH's 9.0 at 68 kt. The old
    // 0.030/0.054 gave 12.4 at 74 kt — engine-out glides went 35% too far.
    CD0: 0.034, kInduced: 0.0626, CYbeta: -0.35,
    flapCL: 0.55, flapCD: 0.065, flapStallShift: -0.035,
    Cm0: 0.045, Cmalpha: -1.15, Cmq: -14.0, Cmde: 0.5, CmFlap: -0.10,
    // Clda sized for pb/2V = 0.10, which FLIES at ~45 deg/s full deflection at
    // 100 kt (adverse yaw plus dihedral effect cost ~15% off the analytic
    // figure). The old 0.115 gave ~128 deg/s — fighter numbers on a trainer.
    Clp: -0.48, Clda: 0.048, Clbeta: -0.09, Clr: 0.10,
    stallAsym: -0.003,   // drops the left wing at the break (slipstream + torque)
    Cnbeta: 0.11, Cnr: -0.14, Cndr: 0.075, CnAdverse: 0.012,
    engine: { type: 'prop', tau: 0.15, powerW: 134000, propEff: 0.75, staticThrust: 2250,
      windmillCD: 0.0153, discArea: 4.6 },   // stopped/windmilling prop drag; 76in disc
    // Thrust line above the CG, and the tail sits in the slipstream: power
    // changes pitch the nose and elevator authority rises with power. The
    // model previously added thrust to the FORCE vector only, so neither
    // existed and the pitch/power/trim coordination of primary training was
    // simply absent.
    thrustArmY: 0.05, washFrac: 0.15, CmThrust: 0.12,
    // Left-turning tendency. The old single propYaw term produced 6.6 N.m
    // against 7,400 N.m of full rudder — 0.09% — so the takeoff roll needed
    // no rudder at all. swirl is sized so full power at low speed needs
    // roughly a third of full right rudder to hold the centreline.
    propfx: { swirl: 0.95, pFactor: 0.55, gyroH: 376 },
    fuel: { capacityKg: 180, tsfc: 1.0e-5 },   // ~56 US gal usable; piston, low burn
    startup: true,   // v5-R3: study-level cold-start (battery/mags/mixture/starter)
    sas: null,
    maxSpeed: 88, gearHeight: 1.25,
    // Envelope limits (EAS m/s). Vne 163 KIAS, Vno 129, Vfe 85, +3.8/-1.52 g.
    limits: { vne: 84, vno: 66.4, vfe: 43.7, gPos: 3.8, gNeg: -1.52 },
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
    Clp: -0.45, Clda: 0.171, Clbeta: -0.04, Clr: 0.08,   // pb/2V 0.38 -> ~420 deg/s at 150 kt
    stallAsym: -0.0025,   // symmetric wing, but same prop-side bias
    Cnbeta: 0.10, Cnr: -0.13, Cndr: 0.10, CnAdverse: 0.015,
    engine: { type: 'prop', tau: 0.12, powerW: 164000, propEff: 0.85, staticThrust: 4200,
      windmillCD: 0.016, discArea: 4.2 },
    thrustArmY: 0.04, washFrac: 0.15, CmThrust: 0.10,
    propfx: { swirl: 1.0, pFactor: 0.6, gyroH: 430 },
    fuel: { capacityKg: 120, tsfc: 1.1e-5 },   // aerobatic piston; small tank, thirsty
    sas: null,
    maxSpeed: 113, gearHeight: 1.05,
    // Aerobatic category: Vne 220 KIAS, +/-10 g.
    limits: { vne: 113, vno: 81, vfe: null, gPos: 10, gNeg: -10 },
    crashSink: 3.2, maxSteer: 0.45,
    // Taildragger: rests tail-low; mains ahead of the CG, steerable tailwheel
    // aft. Rest pitch = atan2 of the wheel-contact height difference.
    spawn: { pitch: 0.186 },
    gear: [
      { name: 'mainL', r: { x: 0.55, y: -1.05, z: -0.95 }, k: 40000, c: 2400, steer: 0,  brake: true },
      { name: 'mainR', r: { x: 0.55, y: -1.05, z: 0.95 },  k: 40000, c: 2400, steer: 0,  brake: true },
      // Tailwheel raised: at the old 7.1 deg ground angle a symmetric wing
      // (CL0 = 0) made only CL 0.73 on the roll and could not unstick below
      // 86 kt, though the aircraft stalls at 57. Real Extras sit ~11 deg tail-low.
      { name: 'tail',  r: { x: -3.45, y: -0.30, z: 0 },    k: 15000, c: 800,  steer: -1, brake: false },
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
    Clp: -0.40, Clda: 0.052, Clbeta: -0.05, Clr: 0.05,   // pb/2V 0.13 -> ~218 deg/s at 350 kt
    stallAsym: -0.0015,  // no prop; rigging tolerance only
    Cnbeta: 0.15, Cnr: -0.20, Cndr: 0.12, CnAdverse: 0.005,
    engine: { type: 'jet', tau: 0.8, maxThrust: 128000, afterburner: { mult: 1.5 } },
    thrustArmY: -0.35,
    fuel: { capacityKg: 5000, tsfc: 2.5e-5 },  // ~internal fuel; military low-bypass, high TSFC
    sas: null,
    // Fly-by-wire q-scheduling: full deflection at 250 kt (qbar ~10,100 Pa) and
    // it softens further with speed, so 500-kt full aft stick stays sub-9 g.
    controlSoften: { qRef: 10100, ailExp: 0.45 }, inputRate: 6.5,
    maxSpeed: 360, gearHeight: 2.2,
    // 700 KIAS / Mach 1.8 / +7.5 g. mach.crit drives the wave-drag rise that
    // stops it walking to Mach 1.54 in level flight at 500 m.
    limits: { vne: 360, vfe: 128.6, gPos: 7.5, gNeg: -3.0, mMax: 1.8 },
    mach: { crit: 0.85, cdWave: 0.045 },
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
    Clp: -0.45, Clda: 0.030, Clbeta: -0.10, Clr: 0.10,   // pb/2V 0.067 -> ~15 deg/s at 250 kt
    stallAsym: -0.002,
    Cnbeta: 0.12, Cnr: -0.25, Cndr: 0.06, CnAdverse: 0.008,
    engine: { type: 'jet', tau: 4.0, maxThrust: 748000, afterburner: null },
    // Underslung engines: adding power pitches the nose UP. Kept conservative
    // so the couple never overpowers the elevator on approach.
    thrustArmY: -0.8,
    fuel: { capacityKg: 80000, tsfc: 1.7e-5 },  // widebody; efficient high-bypass turbofan
    sas: null,
    // Lower qRef (~180 kt) so the heavy keeps flare/approach authority at its
    // low approach speeds while still softening at cruise.
    controlSoften: { qRef: 5250 }, inputRate: 4.5,
    maxSpeed: 175, gearHeight: 5.5,
    // Vmo 340 KIAS / Mmo 0.89 / +2.5 g. Both bind: Vmo low down, Mmo high up.
    limits: { vne: 175, vfe: 92.6, gPos: 2.5, gNeg: -1.0, mMax: 0.89 },
    mach: { crit: 0.86, cdWave: 0.060 },
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
    Clp: -0.50, Clda: 0.045, Clbeta: -0.05, Clr: 0.05,   // pb/2V 0.09 -> ~25 deg/s at 250 kt
    stallAsym: -0.002,
    // Flying wing: mildly directionally UNSTABLE (negative Cnbeta) with almost
    // no damping — this is why it cannot fly without the SAS below.
    Cnbeta: -0.03, Cnr: -0.02, Cndr: 0.04, CnAdverse: 0.02,
    engine: { type: 'jet', tau: 1.5, maxThrust: 308000, afterburner: null },
    fuel: { capacityKg: 60000, tsfc: 1.9e-5 },  // flying-wing bomber; long-range turbofans
    // Fly-by-wire keeps it pointed; without this it departs (see physics test).
    // Softening composes with the SAS; qRef ~250 kt keeps low-speed authority.
    controlSoften: { qRef: 10100 }, inputRate: 5.5,
    sas: { yawDamper: 0.6, betaGain: 0.3, pitchDamper: 8 },
    maxSpeed: 230, gearHeight: 3.0,
    limits: { vne: 230, vfe: null, gPos: 3.0, gNeg: -1.0, mMax: 0.85 },
    mach: { crit: 0.80, cdWave: 0.055 },
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
