// Aircraft meshes for ARCHIPELAGO: smooth lofted PBR airframes (modelkit.js).
// Model frame: +x forward, +y up, +z right (matches the physics body frame).
// Every builder returns { group: THREE.Group, animate(controls, rpmNorm, dt, st) }.
//
// controls: { elevator, aileron, rudder, throttle, flaps, brakes }
//   elevator/aileron/rudder in -1..1, throttle/flaps in 0..1, brakes boolean.
// rpmNorm: 0..1 normalized engine speed.
// Optional 4th arg `st` (the live ac: onGround, agl, vel, groundSpeed,
// flapsEff) drives retractable gear, wheel spin, flap travel and ground
// spoilers; without it (menu preview) the gear stays down and wheels idle.
//
// v9: lofted fuselages and real airfoil-section wings/tails from modelkit.js
// (one colour per facet, the livery painted at face centroids) replace the
// old box stacks. Gear is placed from the physics contact points in params.js,
// so every airframe sits on its tyres instead of floating or sinking.

import * as THREE from 'three';
import { AIRCRAFT } from './params.js';
import {
  loft, surface, wingHalf, hinged, mirrorZ, rod, wheel, wheelY, bladeGeo,
  surfacePoint, stationAt, PROFILE, roundProfile,
} from './modelkit.js';

// ------------------------------------------------- shared visual helpers --

// Canopy / windscreen glass: flat-shaded but with a specular sheen so the sun
// glints across the facets.
// Canopy / windscreen glass: dark, glossy, reflecting the sky environment.
function glassMat(color, opts = {}) {
  const { specular, shininess, ...rest } = opts;   // legacy Phong knobs ignored
  return new THREE.MeshPhysicalMaterial({
    color, metalness: 0.0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02,
    envMapIntensity: 1.6, side: THREE.DoubleSide, ...rest,
  });
}

// Radial-gradient textures made once on a canvas and shared by every aircraft.
// Both degrade to null (plain colour) if there is no DOM.
let _glowTex = null, _propTex = null;
function radialTex(stops, size = 64) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [t, col] of stops) gr.addColorStop(t, col);
  x.fillStyle = gr;
  x.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function glowTex() {
  return _glowTex || (_glowTex = radialTex([
    [0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,0.7)'],
    [0.5, 'rgba(255,255,255,0.16)'], [1, 'rgba(255,255,255,0)'],
  ]));
}
// Prop blur: a faint veil, a little denser toward the tips, feathered edge
// (a real disc barely reads, and a hard band makes it look like a grey plate).
function propTex() {
  return _propTex || (_propTex = radialTex([
    [0, 'rgba(70,70,74,0.3)'], [0.4, 'rgba(62,62,66,0.38)'],
    [0.82, 'rgba(56,56,60,0.55)'], [0.93, 'rgba(56,56,60,0.3)'],
    [1, 'rgba(56,56,60,0)'],
  ], 256));
}

// Prop blur disc whose opacity follows rpm (see propBlur()).
function propDisc(radius) {
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48),
    new THREE.MeshBasicMaterial({
      map: propTex(), color: 0xffffff, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  disc.rotation.y = Math.PI / 2;
  disc.visible = false;
  return disc;
}
function propBlur(disc, blades, rpmNorm) {
  const o = Math.min(1, Math.max(0, (rpmNorm - 0.12) / 0.6)) * 0.42;
  disc.visible = o > 0.01;
  disc.material.opacity = o;
  blades.visible = rpmNorm < 0.85; // past that the blades are just the disc
}

// Position lights: red left tip, green right tip, white tail, white double-flash
// strobes at the tips, red beacon. Tiny emissive cores (unlit, not tone mapped
// so a bloom pass can pick them up) plus additive glow sprites. No PointLights.
// `s` scales the whole rig to the airframe. specs: [kind, x, y, z] where kind
// is 'red' | 'green' | 'white' (steady) | 'strobe' | 'beacon'.
const _navCoreGeo = new THREE.SphereGeometry(1, 6, 4);
const _navCol = { red: 0xff2a1a, green: 0x1aff5a, white: 0xfff4e0 };
const _navCoreMat = {}, _navGlowMat = {};
function navMats(col) {
  if (!_navCoreMat[col]) {
    // HDR core (x12) so the bloom pass (threshold 6, scene-linear) picks it up
    _navCoreMat[col] = new THREE.MeshBasicMaterial({ color: new THREE.Color(_navCol[col]).multiplyScalar(12), toneMapped: false });
    _navGlowMat[col] = new THREE.SpriteMaterial({
      map: glowTex(), color: _navCol[col], blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, toneMapped: false, opacity: 0.55,
    });
  }
  return [_navCoreMat[col], _navGlowMat[col]];
}
// the cockpit light switches, all off when the LTS breaker is pulled (AI
// traffic passes no state: all on)
const LIGHTS_OFF = { land: false, nav: false, strobe: false, beacon: false };
function litSwitches(st) {
  if (!st || !st.sys) return null;
  return st.breakers && st.breakers.lts === false ? LIGHTS_OFF : st.sys.lights;
}
function navLights(parent, s, specs) {
  const blinkers = [], steady = [];
  for (const [kind, x, y, z] of specs) {
    const col = kind === 'strobe' ? 'white' : kind === 'beacon' ? 'red' : kind;
    const [cm, gm] = navMats(col);
    const grp = new THREE.Group();
    grp.position.set(x, y, z);
    const core = new THREE.Mesh(_navCoreGeo, cm);
    const glow = new THREE.Sprite(gm);
    const strong = kind === 'strobe' || kind === 'beacon';
    core.scale.setScalar(s * (strong ? 0.07 : 0.055));
    glow.scale.setScalar(s * (strong ? 1.1 : 0.55));
    grp.add(core, glow);
    parent.add(grp);
    if (strong) blinkers.push({ grp, kind });
    else steady.push(grp);
  }
  let t = 0;
  // Called once per frame; allocation free. sw = the cockpit light switches
  // ({ nav, strobe, beacon }, ac.sys.lights); absent (AI traffic) = all on.
  return function tick(dt, sw) {
    t += dt;
    const sp = t % 1.2;
    const strobeOn = sp < 0.07 || (sp > 0.18 && sp < 0.25);
    const beaconOn = (t % 0.95) < 0.22;
    const navSw = !sw || sw.nav !== false, strobeSw = !sw || sw.strobe !== false, beaconSw = !sw || sw.beacon !== false;
    for (let i = 0; i < steady.length; i++) steady[i].visible = navSw;
    for (let i = 0; i < blinkers.length; i++) {
      blinkers[i].grp.visible = blinkers[i].kind === 'strobe' ? strobeOn && strobeSw : beaconOn && beaconSw;
    }
  };
}

// Visual-only gear retraction. `legs` are pivot groups; each folds about its
// own axis ('x' or 'z') by `ang` radians. Retracts once clearly airborne and
// climbing, extends on the ground, low, or on descent; ~4 s travel.
function gearRig(legs) {
  let pos = 0; // 0 down .. 1 up
  return function update(dt, st) {
    let up = pos > 0.5;
    if (st) {
      const vy = st.vel ? st.vel.y : 0;
      if (st.onGround || st.agl < 12) up = false;
      else if (st.agl > 30 && vy > -1) up = true;
      else if (st.agl < 200 && vy < -2) up = false;
    } else up = false;
    const target = up ? 1 : 0;
    if (st) st.gearPos = pos; // read by audio.js for the gear motor (visual state only)
    if (pos === target) return;
    const step = dt * 0.25;
    pos = pos < target ? Math.min(target, pos + step) : Math.max(target, pos - step);
    const e = pos * pos * (3 - 2 * pos);
    for (let i = 0; i < legs.length; i++) {
      const L = legs[i];
      L.grp.rotation[L.axis] = L.ang * e;
      L.grp.visible = pos < 0.97;
    }
  };
}
// Pivot group helper: a gear leg whose parts hang below (x,y,z).
function legGroup(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  return g;
}

// --------------------------------------------------------- shared kit --

// Painted airframe skin: PBR paint with a clear coat that picks up the sky
// (scene.environment, see environment.js). Per-face vertex colours carry the
// livery. Double-sided so loft winding never matters (three flips the normal
// for back faces).
function paintMat({ roughness = 0.5, metalness = 0.05, clearcoat = 0.45 } = {}) {
  return new THREE.MeshPhysicalMaterial({
    vertexColors: true, side: THREE.DoubleSide,
    roughness, metalness, clearcoat, clearcoatRoughness: 0.22,
    // the hemisphere light already supplies sky fill: the env map is here for
    // reflections, so keep its diffuse share down or white paint over-exposes
    envMapIntensity: 0.4,
  });
}
// Unpainted parts: tyres, struts, hubs, gear legs.
const lam = (color, roughness = 0.7, metalness = 0.1) => new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: 0.4 });
const neg = (surfs) => surfs.map(s => ({ ...s, from: -s.from, to: -s.to }));
// Exterior hull: hidden in the cockpit view (cockpit.js draws the interior),
// so the wings, struts, props and engines stay visible through the glass.
const H = (o) => { o.userData.hull = true; return o; };

// Spinning wheel set: a tyre/hub pair with a couple of hub spokes so the
// rotation reads. Returns the wheel group (rotate about z).
function spokedWheel(R, W, tireMat, hubMat, x, y, z) {
  const w = wheel(R, W, tireMat, hubMat, x, y, z);
  const sp = new THREE.Mesh(new THREE.BoxGeometry(R * 1.3, R * 0.16, W * 1.12), hubMat);
  const sp2 = sp.clone(); sp2.rotation.z = Math.PI / 2;
  w.add(sp, sp2);
  return w;
}

// Teardrop wheel fairing around a wheel centre.
function wheelPant(x, y, z, R, paint, mat) {
  return new THREE.Mesh(loft([
    { x: x + R * 2.0, y: y + R * 0.05, z, w: 0.01, t: 0.01, b: 0.01 },
    { x: x + R * 1.1, y, z, w: R * 0.5, t: R * 0.9, b: R * 0.72 },
    { x, y: y + R * 0.05, z, w: R * 0.56, t: R * 1.14, b: R * 0.74 },
    { x: x - R * 1.4, y: y + R * 0.2, z, w: R * 0.32, t: R * 0.66, b: R * 0.36 },
    { x: x - R * 2.3, y: y + R * 0.35, z, w: 0.01, t: 0.02, b: 0.01 },
  ], { profile: roundProfile(6), paint }), mat);
}

// Shared animation bits.
function spinner(rpmNorm) { return (4 + 120 * rpmNorm); }
function wheelSpin(wheels, R, st, dt) {
  if (!st || !st.onGround) return;
  const a = (st.groundSpeed || 0) / R * dt;
  for (const w of wheels) w.rotation.z -= a;
}
function flapLag() {
  let f = 0;
  return (controls, st, dt) => {
    const target = st && st.flapsEff != null ? st.flapsEff : controls.flaps;
    f += (target - f) * Math.min(1, dt * 1.6);
    return f;
  };
}
// Static tyre squash so the airframe sits ON the contact points.
function squash(p) {
  const k = p.gear.reduce((a, g) => a + g.k, 0);
  return Math.min(0.2, p.mass * 9.81 / k);
}

// ------------------------------------------------------------------ c172 --
// High-wing trainer, 8.3 m long / 11 m span. Red/navy on cream.

function c172() {
  const P = AIRCRAFT.c172;
  const C = { white: 0xf2efe6, red: 0xb8372e, navy: 0x1f3454, belly: 0xd3cdbd, glass: 0x1f2d3a, dark: 0x2a2d31 };
  const mat = paintMat();
  const glass = glassMat(0x1d2a36);
  const dark = lam(0x2a2d31), tire = lam(0x17181a), hub = lam(0xb7bac0);
  const g = new THREE.Group();

  // Fuselage. Rows (cabin profile): 0-1 roof, 2-3 window band, 4 shoulder,
  // 5 cheatline, 6 lower side, 7-9 belly.
  const fus = [
    { x: 2.80, y: -0.10, w: 0.20, t: 0.19, b: 0.21 },
    { x: 2.62, y: -0.08, w: 0.42, t: 0.36, b: 0.42 },
    { x: 2.20, y: -0.05, w: 0.52, t: 0.47, b: 0.56 },
    { x: 1.72, y: -0.02, w: 0.57, t: 0.56, b: 0.62 },
    { x: 1.35, y: 0.02, w: 0.59, t: 0.70, b: 0.64 },
    { x: 1.00, y: 0.05, w: 0.60, t: 0.82, b: 0.65 },
    { x: 0.45, y: 0.05, w: 0.61, t: 0.84, b: 0.64 },
    { x: 0.30, y: 0.05, w: 0.61, t: 0.84, b: 0.64 },
    { x: -0.20, y: 0.06, w: 0.60, t: 0.84, b: 0.61 },
    { x: -0.75, y: 0.10, w: 0.56, t: 0.78, b: 0.53 },
    { x: -1.40, y: 0.16, w: 0.46, t: 0.62, b: 0.42 },
    { x: -2.20, y: 0.22, w: 0.34, t: 0.45, b: 0.32 },
    { x: -3.10, y: 0.27, w: 0.22, t: 0.30, b: 0.22 },
    { x: -3.90, y: 0.31, w: 0.12, t: 0.20, b: 0.13 },
    { x: -4.40, y: 0.34, w: 0.03, t: 0.09, b: 0.05 },
  ];
  g.add(H(new THREE.Mesh(loft(fus, {
    profile: PROFILE.cabin,
    paint({ x, row, cap }) {
      if (cap) return C.dark;
      if (x > 2.62) return C.red;                                    // nose ring
      if (x > 1.0 && x < 1.72 && row <= 3) return C.glass;           // windshield
      if (row >= 2 && row <= 3 && ((x > 0.45 && x < 1.0) || (x > -0.75 && x < 0.30))) return C.glass;
      if (row >= 2 && row <= 3 && x > -1.40 && x < -0.75) return C.glass; // rear quarter window
      if (row === 5) return C.red;
      if (row >= 7) return C.belly;
      return C.white;
    },
  }), mat)));

  // Wing: rectangular inboard, tapered outboard, 1.7 deg dihedral.
  const wst = [
    { x: 0.98, y: 0.93, z: 0.55, chord: 1.62, t: 0.12 },
    { x: 0.98, y: 0.99, z: 2.55, chord: 1.62, t: 0.12 },
    { x: 0.80, y: 1.07, z: 5.05, chord: 1.26, t: 0.11 },
    { x: 0.72, y: 1.09, z: 5.45, chord: 1.06, t: 0.07 },
  ];
  const wingPaint = ({ z, up }) => Math.abs(z) > 5.05 ? C.red : (up ? C.white : C.belly);
  const surfs = [{ from: 0.62, to: 2.5, key: 'flap' }, { from: 2.62, to: 5.0, key: 'ail' }];
  const WR = wingHalf(wst, { hingeC: 0.74, camber: 0.02, surfaces: surfs, paint: wingPaint, mat });
  const WL = wingHalf(mirrorZ(wst), { hingeC: 0.74, camber: 0.02, surfaces: neg(surfs), paint: wingPaint, mat });
  g.add(WR.group, WL.group);

  // Lift struts
  for (const s of [-1, 1]) g.add(rod([0.25, -0.42, s * 0.56], [0.40, 0.95, s * 3.0], 0.04, lam(C.white)));

  // Tail: swept fin with dorsal fillet, rectangular stabiliser.
  const finPaint = ({ y }) => y > 1.52 ? C.red : y > 1.3 ? C.navy : C.white;
  const fin = [
    { x: -2.95, y: 0.48, z: 0, chord: 1.45, t: 0.10 },
    { x: -3.40, y: 1.30, z: 0, chord: 1.08, t: 0.095 },
    { x: -3.51, y: 1.52, z: 0, chord: 0.98, t: 0.094 },
    { x: -3.72, y: 1.88, z: 0, chord: 0.78, t: 0.09 },
  ];
  const F = wingHalf(fin, { axis: 'y', tdir: [0, 0, 1], hingeC: 0.62, surfaces: [{ from: 0.56, to: 1.86, key: 'rud' }], paint: finPaint, mat });
  g.add(F.group);
  g.add(new THREE.Mesh(surface([
    { x: -1.70, y: 0.56, z: 0, chord: 1.35, t: 0.07 },
    { x: -2.85, y: 0.80, z: 0, chord: 0.45, t: 0.07 },
  ], { tdir: [0, 0, 1], paint: () => C.white }), mat));
  const hst = [
    { x: -3.30, y: 0.38, z: 0.08, chord: 1.18, t: 0.09 },
    { x: -3.50, y: 0.38, z: 1.72, chord: 0.86, t: 0.08 },
  ];
  const tailPaint = ({ z }) => Math.abs(z) > 1.5 ? C.red : C.white;
  const HR = wingHalf(hst, { hingeC: 0.58, surfaces: [{ from: 0.15, to: 1.66, key: 'elev' }], paint: tailPaint, mat });
  const HL = wingHalf(mirrorZ(hst), { hingeC: 0.58, surfaces: neg([{ from: 0.15, to: 1.66, key: 'elev' }]), paint: tailPaint, mat });
  g.add(HR.group, HL.group);

  // Fixed tricycle gear with speed fairings, on the physics contact points.
  const sq = squash(P);
  const [gN, gL] = P.gear;
  const whiteM = lam(C.white);
  const wheels = [];
  const mainR = 0.27, noseR = 0.22;
  for (const s of [-1, 1]) {
    const y = wheelY(gL, mainR, sq), x = gL.r.x, z = s * Math.abs(gL.r.z);
    g.add(rod([x + 0.1, -0.55, s * 0.48], [x, y + 0.12, z - s * 0.12], 0.045, whiteM));
    const w = spokedWheel(mainR, 0.17, tire, hub, x, y, z);
    wheels.push(w); g.add(w);
    g.add(wheelPant(x, y, z, mainR, () => C.white, mat));
  }
  const steer = new THREE.Group();
  steer.position.set(gN.r.x, 0, 0);
  const ny = wheelY(gN, noseR, sq);
  steer.add(rod([0.05, -0.55, 0], [0, ny + 0.1, 0], 0.05, dark));
  const nw = spokedWheel(noseR, 0.14, tire, hub, 0, ny, 0);
  wheels.push(nw);
  steer.add(nw, wheelPant(0, ny, 0, noseR, () => C.white, mat));
  g.add(steer);

  // Prop: red spinner, two twisted blades with painted tips, blur disc.
  const propGroup = new THREE.Group();
  propGroup.position.set(2.80, -0.10, 0);
  propGroup.add(new THREE.Mesh(loft([
    { x: 0, y: 0, w: 0.19, t: 0.19, b: 0.19 }, { x: 0.18, y: 0, w: 0.16, t: 0.16, b: 0.16 },
    { x: 0.32, y: 0, w: 0.08, t: 0.08, b: 0.08 }, { x: 0.40, y: 0, w: 0.0, t: 0.0, b: 0.0 },
  ], { profile: roundProfile(5), paint: () => C.red }), mat));
  const blades = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(bladeGeo(0.95, 0.17, 0.09, 0x26282c, 0xd9b326), mat);
    b.rotation.x = i * Math.PI;
    b.position.x = 0.08;
    blades.add(b);
  }
  propGroup.add(blades);
  const disc = propDisc(0.95);
  disc.position.x = 0.08;
  propGroup.add(disc);
  g.add(propGroup);

  const lights = navLights(g, 0.9, [
    ['red', 0.35, 1.09, -5.5], ['green', 0.35, 1.09, 5.5], ['white', -4.42, 0.36, 0],
    ['strobe', 0.35, 1.09, -5.5], ['strobe', 0.35, 1.09, 5.5], ['beacon', -3.95, 1.93, 0],
  ]);

  let propAngle = 0;
  const flaps = flapLag();
  return {
    group: g,
    animate(controls, rpmNorm, dt, st) {
      const ael = 0.35 * controls.aileron;
      WR.ail.set(ael); WL.ail.set(ael);
      const f = flaps(controls, st, dt);
      WR.flap.set(0.55 * f); WL.flap.set(-0.55 * f);
      WR.flap.slide(0.14 * f); WL.flap.slide(0.14 * f);
      HR.elev.set(0.32 * controls.elevator); HL.elev.set(-0.32 * controls.elevator);
      F.rud.set(0.35 * controls.rudder);
      steer.rotation.y = -0.3 * controls.rudder;
      wheelSpin(wheels, mainR, st, dt);
      propAngle += spinner(rpmNorm) * dt;
      blades.rotation.x = propAngle;
      propBlur(disc, blades, rpmNorm);
      lights(dt, litSwitches(st));
    },
  };
}

// --------------------------------------------------------------- extra300 --
// Low-wing aerobatic single-seater, ~7 m long / 8 m span, taildragger.

function extra300() {
  const P = AIRCRAFT.extra300;
  const C = { white: 0xf5f3ec, red: 0xc81e1e, black: 0x1c1d21, belly: 0xdcd8cb, dark: 0x24262a };
  const mat = paintMat();
  const glass = glassMat(0x1b252e);
  const dark = lam(C.dark), tire = lam(0x141416), hub = lam(0xb7bac0);
  const g = new THREE.Group();

  const fus = [
    { x: 2.45, y: -0.10, w: 0.17, t: 0.17, b: 0.17 },
    { x: 2.30, y: -0.08, w: 0.38, t: 0.34, b: 0.37 },
    { x: 1.85, y: -0.04, w: 0.47, t: 0.45, b: 0.47 },
    { x: 1.25, y: 0.00, w: 0.50, t: 0.50, b: 0.50 },
    { x: 0.45, y: 0.02, w: 0.50, t: 0.52, b: 0.50 },
    { x: -0.40, y: 0.04, w: 0.44, t: 0.48, b: 0.44 },
    { x: -1.30, y: 0.08, w: 0.33, t: 0.38, b: 0.34 },
    { x: -2.30, y: 0.12, w: 0.22, t: 0.27, b: 0.24 },
    { x: -3.20, y: 0.16, w: 0.12, t: 0.18, b: 0.14 },
    { x: -3.75, y: 0.18, w: 0.03, t: 0.08, b: 0.05 },
  ];
  g.add(H(new THREE.Mesh(loft(fus, {
    profile: PROFILE.cabin,
    paint({ x, row, k, cap }) {
      if (cap) return C.dark;
      if (x > 2.3) return C.red;
      if (row <= 1 && x < 0.5) return C.red;                 // spine stripe behind the canopy
      if (row === 5) return C.black;                          // belt line
      if (row >= 3 && row <= 4 && k >= 2 && k <= 4 && (k % 2 === 0)) return C.red; // forward flash
      if (row >= 7) return C.belly;
      return C.white;
    },
  }), mat)));
  // Bubble canopy
  g.add(H(new THREE.Mesh(loft([
    { x: 1.72, y: 0.46, w: 0.04, t: 0.03, b: 0.02 },
    { x: 1.35, y: 0.46, w: 0.33, t: 0.24, b: 0.02 },
    { x: 0.70, y: 0.46, w: 0.37, t: 0.36, b: 0.02 },
    { x: 0.00, y: 0.48, w: 0.31, t: 0.27, b: 0.02 },
    { x: -0.45, y: 0.50, w: 0.06, t: 0.05, b: 0.02 },
  ], { profile: roundProfile(6) }), glass)));

  // Symmetric low wing, red tips and a red chevron band on top.
  const wst = [
    { x: 0.98, y: -0.36, z: 0.35, chord: 1.68, t: 0.15 },
    { x: 0.86, y: -0.355, z: 1.55, chord: 1.46, t: 0.145 },
    { x: 0.80, y: -0.352, z: 2.15, chord: 1.35, t: 0.14 },
    { x: 0.66, y: -0.345, z: 3.05, chord: 1.18, t: 0.135 },
    { x: 0.62, y: -0.34, z: 3.6, chord: 1.08, t: 0.13 },
    { x: 0.55, y: -0.34, z: 4.02, chord: 0.95, t: 0.10 },
  ];
  const wingPaint = ({ z, up }) => {
    const a = Math.abs(z);
    if (a > 3.05) return C.red;
    if (up && a > 1.55 && a < 2.15) return C.red;
    return up ? C.white : C.belly;
  };
  const surfs = [{ from: 0.9, to: 3.62, key: 'ail' }];
  const WR = wingHalf(wst, { hingeC: 0.72, surfaces: surfs, paint: wingPaint, mat });
  const WL = wingHalf(mirrorZ(wst), { hingeC: 0.72, surfaces: neg(surfs), paint: wingPaint, mat });
  g.add(WR.group, WL.group);

  const finPaint = ({ y }) => y > 1.0 ? C.red : C.white;
  const fin = [
    { x: -2.55, y: 0.24, z: 0, chord: 1.15, t: 0.10 },
    { x: -2.92, y: 1.00, z: 0, chord: 0.85, t: 0.095 },
    { x: -3.25, y: 1.38, z: 0, chord: 0.58, t: 0.09 },
  ];
  const F = wingHalf(fin, { axis: 'y', tdir: [0, 0, 1], hingeC: 0.55, surfaces: [{ from: 0.3, to: 1.36, key: 'rud' }], paint: finPaint, mat });
  g.add(F.group);
  const hst = [
    { x: -2.85, y: 0.17, z: 0.06, chord: 0.98, t: 0.09 },
    { x: -3.08, y: 0.17, z: 1.28, chord: 0.66, t: 0.08 },
  ];
  const tailPaint = ({ z, up }) => Math.abs(z) > 1.0 ? C.red : (up ? C.white : C.belly);
  const HR = wingHalf(hst, { hingeC: 0.55, surfaces: [{ from: 0.12, to: 1.22, key: 'elev' }], paint: tailPaint, mat });
  const HL = wingHalf(mirrorZ(hst), { hingeC: 0.55, surfaces: neg([{ from: 0.12, to: 1.22, key: 'elev' }]), paint: tailPaint, mat });
  g.add(HR.group, HL.group);

  // Spring-leg mains with spats + steerable tailwheel.
  const sq = squash(P);
  const gM = P.gear[0], gT = P.gear[2];
  const wheels = [];
  const mainR = 0.28;
  for (const s of [-1, 1]) {
    const y = wheelY(gM, mainR, sq), x = gM.r.x, z = s * Math.abs(gM.r.z);
    g.add(rod([x + 0.08, -0.42, s * 0.3], [x, y + 0.14, z - s * 0.1], 0.045, lam(C.white)));
    const w = spokedWheel(mainR, 0.13, tire, hub, x, y, z);
    wheels.push(w); g.add(w);
    g.add(wheelPant(x, y, z, mainR, ({ y: py }) => py > y + 0.12 ? C.red : C.white, mat));
  }
  const steer = new THREE.Group();
  steer.position.set(gT.r.x, 0, 0);
  const ty = wheelY(gT, 0.12, sq * 0.5);
  steer.add(rod([0.25, 0.04, 0], [0, ty, 0], 0.035, dark));
  const tw = spokedWheel(0.12, 0.07, tire, hub, 0, ty, 0);
  wheels.push(tw); steer.add(tw);
  g.add(steer);

  // Three-blade prop
  const propGroup = new THREE.Group();
  propGroup.position.set(2.47, -0.10, 0);
  propGroup.add(new THREE.Mesh(loft([
    { x: 0, y: 0, w: 0.17, t: 0.17, b: 0.17 }, { x: 0.22, y: 0, w: 0.14, t: 0.14, b: 0.14 },
    { x: 0.42, y: 0, w: 0.06, t: 0.06, b: 0.06 }, { x: 0.52, y: 0, w: 0, t: 0, b: 0 },
  ], { profile: roundProfile(5), paint: () => C.red }), mat));
  const blades = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(bladeGeo(1.02, 0.2, 0.12, 0x1e2024, 0xe8e2d0), mat);
    b.rotation.x = i * Math.PI * 2 / 3;
    b.position.x = 0.1;
    blades.add(b);
  }
  propGroup.add(blades);
  const disc = propDisc(1.05);
  disc.position.x = 0.1;
  propGroup.add(disc);
  g.add(propGroup);

  const lights = navLights(g, 0.85, [
    ['red', 0.3, -0.33, -4.1], ['green', 0.3, -0.33, 4.1], ['white', -3.78, 0.2, 0],
    ['strobe', 0.3, -0.33, -4.1], ['strobe', 0.3, -0.33, 4.1], ['beacon', -3.3, 1.42, 0],
  ]);

  let propAngle = 0;
  return {
    group: g,
    animate(controls, rpmNorm, dt, st) {
      const ael = 0.45 * controls.aileron;   // big aerobatic ailerons
      WR.ail.set(ael); WL.ail.set(ael);
      HR.elev.set(0.36 * controls.elevator); HL.elev.set(-0.36 * controls.elevator);
      F.rud.set(0.4 * controls.rudder);
      steer.rotation.y = -0.35 * controls.rudder;
      wheelSpin(wheels, mainR, st, dt);
      propAngle += (4 + 130 * rpmNorm) * dt;
      blades.rotation.x = propAngle;
      propBlur(disc, blades, rpmNorm);
      lights(dt, litSwitches(st));
    },
  };
}

// ------------------------------------------------------------------ hornet --
// Twin-engine, twin-tail fighter, ~17.6 m long / ~12.4 m span.

function hornet() {
  const P = AIRCRAFT.hornet;
  const C = { top: 0x7f8992, side: 0x98a1aa, belly: 0xa9b1b9, radome: 0x6a7179, dark: 0x2b2e32,
    band: 0xd9a21b, metal: 0x50545a, white: 0xe6e6df };
  const mat = paintMat({ roughness: 0.55, clearcoat: 0.15, metalness: 0.2 });   // matte naval grey
  const glass = glassMat(0x2a3640, { specular: 0xc8dcf0 });
  const dark = lam(C.dark), tire = lam(0x141416), hub = lam(0x9da2a8);
  const g = new THREE.Group();

  const skin = ({ row, up }) => (row != null ? row <= 3 : up) ? C.top : (row != null && row >= 7 ? C.belly : C.side);
  g.add(H(new THREE.Mesh(loft([
    { x: 9.30, y: -0.05, w: 0.03, t: 0.03, b: 0.03 },
    { x: 8.70, y: -0.02, w: 0.26, t: 0.26, b: 0.27 },
    { x: 7.70, y: 0.04, w: 0.44, t: 0.44, b: 0.46 },
    { x: 6.50, y: 0.10, w: 0.56, t: 0.58, b: 0.58 },
    { x: 5.20, y: 0.12, w: 0.64, t: 0.64, b: 0.62 },
    { x: 3.90, y: 0.10, w: 0.74, t: 0.62, b: 0.70 },
    { x: 2.40, y: 0.05, w: 0.86, t: 0.58, b: 0.76 },
    { x: 0.40, y: 0.00, w: 0.94, t: 0.55, b: 0.74 },
    { x: -1.60, y: 0.00, w: 0.98, t: 0.52, b: 0.64 },
    { x: -4.20, y: 0.02, w: 0.98, t: 0.46, b: 0.56 },
    { x: -6.40, y: 0.02, w: 0.94, t: 0.40, b: 0.46 },
    { x: -7.50, y: 0.02, w: 0.90, t: 0.36, b: 0.40 },
  ], {
    profile: PROFILE.jet,
    paint({ x, row, cap }) {
      if (cap) return C.dark;
      if (x > 7.7) return C.radome;
      return skin({ row });
    },
  }), mat)));
  // Canopy
  g.add(H(new THREE.Mesh(loft([
    { x: 7.30, y: 0.55, w: 0.05, t: 0.03, b: 0.02 },
    { x: 6.60, y: 0.58, w: 0.42, t: 0.30, b: 0.02 },
    { x: 5.50, y: 0.66, w: 0.47, t: 0.44, b: 0.02 },
    { x: 4.30, y: 0.68, w: 0.40, t: 0.32, b: 0.02 },
    { x: 3.50, y: 0.66, w: 0.10, t: 0.05, b: 0.02 },
  ], { profile: roundProfile(6) }), glass)));
  // Intakes under the LEX
  for (const s of [-1, 1]) {
    g.add(H(new THREE.Mesh(loft([
      { x: 3.40, y: -0.32, z: s * 0.98, w: 0.30, t: 0.27, b: 0.27 },
      { x: 2.20, y: -0.30, z: s * 0.92, w: 0.30, t: 0.28, b: 0.28 },
      { x: 0.20, y: -0.25, z: s * 0.80, w: 0.18, t: 0.18, b: 0.18 },
    ], { profile: PROFILE.cabin, paint: ({ cap, x }) => cap && x > 3 ? 0x101114 : C.belly }), mat)));
  }
  // LEX strakes
  const lex = [{ x: 6.6, y: 0.12, z: 0.5, chord: 6.2, t: 0.03 }, { x: 2.0, y: 0.10, z: 1.38, chord: 1.8, t: 0.03 }];
  g.add(new THREE.Mesh(surface(lex, { paint: skin }), mat), new THREE.Mesh(surface(mirrorZ(lex), { paint: skin }), mat));

  // Wings + wingtip missiles
  const wst = [
    { x: 1.90, y: -0.05, z: 0.85, chord: 4.40, t: 0.055 },
    { x: -0.95, y: -0.12, z: 6.05, chord: 1.45, t: 0.045 },
  ];
  const surfs = [{ from: 1.0, to: 3.4, key: 'flap' }, { from: 3.5, to: 5.9, key: 'ail' }];
  const WR = wingHalf(wst, { hingeC: 0.74, surfaces: surfs, paint: skin, mat });
  const WL = wingHalf(mirrorZ(wst), { hingeC: 0.74, surfaces: neg(surfs), paint: skin, mat });
  g.add(WR.group, WL.group);
  for (const s of [-1, 1]) {
    g.add(new THREE.Mesh(loft([
      { x: 0.9, y: -0.12, z: s * 6.17, w: 0.0, t: 0.0, b: 0.0 },
      { x: 0.65, y: -0.12, z: s * 6.17, w: 0.065, t: 0.065, b: 0.065 },
      { x: -2.0, y: -0.12, z: s * 6.17, w: 0.065, t: 0.065, b: 0.065 },
      { x: -2.1, y: -0.12, z: s * 6.17, w: 0.05, t: 0.05, b: 0.05 },
    ], { profile: roundProfile(4), paint: ({ x }) => x > 0.6 ? C.dark : C.white }), mat));
    const fins = [{ x: -1.55, y: -0.12, z: s * 6.17, chord: 0.45, t: 0.04 }, { x: -1.85, y: -0.12, z: s * 6.42, chord: 0.2, t: 0.04 }];
    g.add(new THREE.Mesh(surface(fins, { paint: () => C.white }), mat));
  }

  // Twin canted fins
  const finSt = [
    { x: 1.60, y: 0, z: 0, chord: 3.4, t: 0.06 },
    { x: 0.11, y: 2.05, z: 0, chord: 2.1, t: 0.055 },
    { x: -0.45, y: 2.78, z: 0, chord: 1.55, t: 0.052 },
    { x: -0.60, y: 3.0, z: 0, chord: 1.3, t: 0.05 },
  ];
  const finPaint = ({ y }) => y > 2.78 ? C.dark : y > 2.05 ? C.band : C.top;
  const fins = [-1, 1].map(s => {
    const grp = new THREE.Group();
    const F = wingHalf(finSt, { axis: 'y', tdir: [0, 0, 1], hingeC: 0.68, surfaces: [{ from: 0.15, to: 1.7, key: 'rud' }], paint: finPaint, mat });
    grp.add(F.group);
    grp.position.set(-4.6, 0.35, s * 1.05);
    grp.rotation.x = s * 0.36;
    g.add(grp);
    return F;
  });

  // All-moving stabilators
  const stab = [{ x: -5.6, y: 0.05, z: 0.85, chord: 2.9, t: 0.045 }, { x: -7.5, y: -0.08, z: 3.45, chord: 1.05, t: 0.04 }];
  const stabs = [1, -1].map(s => {
    const sts = s > 0 ? stab : mirrorZ(stab);
    const h = hinged(surface(sts, { paint: skin }), mat, [-6.7, 0.03, s * 0.85], [-6.7, -0.03, s * 3.45]);
    g.add(h.obj);
    return h;
  });

  // Nozzles with a heat glow that follows the throttle, plus afterburner plumes.
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, toneMapped: false });
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xff9a3d, transparent: true, opacity: 0.7,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0.8,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const flames = [];
  for (const s of [-1, 1]) {
    g.add(new THREE.Mesh(loft([
      { x: -7.3, y: 0.0, z: s * 0.46, w: 0.44, t: 0.44, b: 0.44 },
      { x: -7.9, y: 0.0, z: s * 0.46, w: 0.42, t: 0.42, b: 0.42 },
      { x: -8.45, y: 0.0, z: s * 0.46, w: 0.37, t: 0.37, b: 0.37 },
    ], { profile: roundProfile(8), paint: ({ row }) => row % 2 ? C.metal : 0x45494f }), mat));
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.34, 12), glowMat);
    core.rotation.y = -Math.PI / 2;
    core.position.set(-8.3, 0, s * 0.46);
    g.add(core);
    const fl = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.36, 3.2, 10, 1, true), flameMat);
    outer.rotation.z = Math.PI / 2; outer.position.x = -1.6;
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.6, 8, 1, true), coreMat);
    inner.rotation.z = Math.PI / 2; inner.position.x = -0.8;
    fl.add(outer, inner);
    fl.position.set(-8.4, 0, s * 0.46);
    fl.visible = false;
    g.add(fl);
    flames.push(fl);
  }

  // Retractable tricycle gear on the physics contact points.
  const sq = squash(P);
  const [gN, gL] = P.gear;
  const wheels = [];
  const noseLeg = legGroup(gN.r.x, -0.45, 0);
  const noseSteer = new THREE.Group();
  const ny = wheelY(gN, 0.3, sq) + 0.45;
  noseSteer.add(rod([0, 0, 0], [0, ny + 0.05, 0], 0.08, dark));
  for (const z of [-0.18, 0.18]) { const w = spokedWheel(0.3, 0.16, tire, hub, 0, ny, z); wheels.push(w); noseSteer.add(w); }
  noseLeg.add(noseSteer);
  const mainLegs = [-1, 1].map(s => {
    const l = legGroup(-1.0, -0.5, s * 0.85);
    const wy = wheelY(gL, 0.4, sq) + 0.5, wx = gL.r.x + 1.0, wz = s * (Math.abs(gL.r.z) - 0.85);
    l.add(rod([0, 0, 0], [wx, wy + 0.2, wz - s * 0.12], 0.09, dark));
    const w = spokedWheel(0.4, 0.22, tire, hub, wx, wy, wz);
    wheels.push(w); l.add(w);
    return l;
  });
  g.add(noseLeg, ...mainLegs);
  const gear = gearRig([
    { grp: noseLeg, axis: 'z', ang: -1.5 },
    { grp: mainLegs[0], axis: 'x', ang: 1.5 },
    { grp: mainLegs[1], axis: 'x', ang: -1.5 },
  ]);

  const lights = navLights(g, 1.2, [
    ['red', 0.4, -0.05, -6.1], ['green', 0.4, -0.05, 6.1], ['white', -7.6, 0.4, 0],
    ['strobe', 0.4, -0.05, -6.1], ['strobe', 0.4, -0.05, 6.1], ['beacon', 4.0, 0.74, 0],
  ]);

  const flaps = flapLag();
  const heat = new THREE.Color(), cold = new THREE.Color(0x1a1a1a), hot = new THREE.Color(0xff7a2a);
  let abPhase = 0;
  return {
    group: g,
    animate(controls, rpmNorm, dt, st) {
      gear(dt, st);
      lights(dt, litSwitches(st));
      const e = 0.28 * controls.elevator;
      stabs[0].set(e); stabs[1].set(-e);
      const ael = 0.4 * controls.aileron;
      WR.ail.set(ael); WL.ail.set(ael);
      const f = flaps(controls, st, dt);
      WR.flap.set(0.6 * f); WL.flap.set(-0.6 * f);
      for (const F of fins) F.rud.set(0.35 * controls.rudder);
      noseSteer.rotation.y = -0.3 * controls.rudder;
      wheelSpin(wheels, 0.4, st, dt);
      heat.copy(cold).lerp(hot, Math.max(0, rpmNorm - 0.55) * 1.6);
      glowMat.color.copy(heat);
      const abOn = controls.throttle > 0.95;
      abPhase += dt;
      for (let i = 0; i < 2; i++) {
        flames[i].visible = abOn;
        if (abOn) {
          const flick = 1 + 0.12 * Math.sin(abPhase * 46 + i) + 0.07 * Math.sin(abPhase * 113 + 1.7 * i);
          flames[i].scale.set(flick, 1 + 0.05 * Math.sin(abPhase * 71 + i), 1 + 0.05 * Math.sin(abPhase * 71 + i));
        }
      }
    },
  };
}

// ------------------------------------------------------------------- heavy --
// Twin-engine widebody, ~61 m long / 64 m span, in Archipelago Air colours.

function heavy() {
  const P = AIRCRAFT.heavy;
  const C = { white: 0xf2f2ee, grey: 0xc6cad1, navy: 0x1f3358, red: 0xc21f1f, glass: 0x1c2630,
    lip: 0xc9ccd2, dark: 0x24262a, wing: 0xe2e4e8, wingLo: 0xbfc4cc };
  const mat = paintMat({ roughness: 0.35, clearcoat: 0.9 });
  const dark = lam(C.dark), tire = lam(0x141416), hub = lam(0x9da2a8);
  const g = new THREE.Group();

  // Fuselage (round profile, 15 degree facets). Rows: 0-3 crown, 4 windows,
  // 5 white, 6 cheatline, 7 white, 8-11 belly.
  const doors = [21.0, 9.5, -6.0, -15.5];
  g.add(H(new THREE.Mesh(loft([
    { x: 29.7, y: -0.70, w: 0.05, t: 0.05, b: 0.05 },
    { x: 29.2, y: -0.50, w: 1.00, t: 0.95, b: 0.90 },
    { x: 28.0, y: -0.25, w: 1.95, t: 1.90, b: 1.95 },
    { x: 26.2, y: -0.08, w: 2.60, t: 2.55, b: 2.65 },
    { x: 23.8, y: 0, w: 2.88, t: 2.88, b: 2.90 },
    { x: -14.0, y: 0, w: 2.90, t: 2.90, b: 2.90 },
    { x: -19.0, y: 0.35, w: 2.62, t: 2.56, b: 2.40 },
    { x: -24.0, y: 0.95, w: 1.85, t: 1.80, b: 1.35 },
    { x: -28.0, y: 1.45, w: 0.98, t: 0.96, b: 0.62 },
    { x: -30.6, y: 1.75, w: 0.36, t: 0.36, b: 0.26 },
    { x: -31.2, y: 1.85, w: 0.08, t: 0.08, b: 0.08 },
  ], {
    profile: roundProfile(12), maxDx: 0.6,
    paint({ x, row, cap }) {
      if (cap) return C.grey;
      if (x > 26.0 && x < 28.1 && row >= 2 && row <= 3) return C.glass;   // flight deck
      if (row === 4 && x > -18 && x < 23) {
        if (doors.some(d => Math.abs(x - d) < 0.7)) return C.grey;
        return Math.floor((x + 100) / 0.6) % 2 ? C.glass : C.white;
      }
      if (row === 6 && x > -22) return C.red;
      if (row >= 8) return C.grey;
      if (x < -22 && row <= 5) return C.navy;                           // tail cone wrap
      return C.white;
    },
  }), mat)));
  // Wing-root belly fairing
  g.add(H(new THREE.Mesh(loft([
    { x: 12.0, y: -2.2, w: 0.5, t: 0.6, b: 0.4 },
    { x: 8.0, y: -2.3, w: 2.9, t: 0.9, b: 0.75 },
    { x: -4.0, y: -2.3, w: 3.0, t: 0.9, b: 0.8 },
    { x: -8.0, y: -2.1, w: 1.0, t: 0.6, b: 0.4 },
  ], { profile: roundProfile(6), paint: () => C.grey }), mat)));

  // Wings: kinked trailing edge, 6 deg dihedral, winglets.
  const wst = [
    { x: 9.5, y: -1.85, z: 2.4, chord: 12.5, t: 0.14 },
    { x: 3.5, y: -1.25, z: 10.0, chord: 6.6, t: 0.12 },
    { x: -11.0, y: 0.95, z: 30.0, chord: 2.3, t: 0.10 },
    { x: -12.0, y: 1.20, z: 31.5, chord: 1.7, t: 0.09 },
  ];
  const wingPaint = ({ up }) => up ? C.wing : C.wingLo;
  const surfs = [
    { from: 3.0, to: 9.8, key: 'flapIn' }, { from: 10.3, to: 20.0, key: 'flapOut' },
    { from: 20.5, to: 28.0, key: 'ail' },
  ];
  const WR = wingHalf(wst, { hingeC: 0.76, camber: 0.02, surfaces: surfs, paint: wingPaint, mat });
  const WL = wingHalf(mirrorZ(wst), { hingeC: 0.76, camber: 0.02, surfaces: neg(surfs), paint: wingPaint, mat });
  g.add(WR.group, WL.group);
  for (const s of [-1, 1]) {
    g.add(new THREE.Mesh(surface([
      { x: -11.85, y: 1.15, z: s * 31.4, chord: 1.8, t: 0.08 },
      { x: -13.6, y: 3.6, z: s * 32.0, chord: 0.8, t: 0.07 },
    ], { tdir: [0, 0, 1], paint: () => C.navy }), mat));
  }
  // Ground spoilers: plates on the upper skin ahead of the flaps.
  const spoilers = [];
  for (const s of [1, -1]) {
    for (const [z0, z1] of [[4.0, 9.4], [11.0, 19.0]]) {
      const a = stationAt(wst, z0), b = stationAt(wst, z1);
      const pts = [];
      for (const st of [a, b]) for (const c of [0.6, 0.745]) {
        const p = surfacePoint(st, c, 1, 0.02);
        pts.push([p[0], p[1] + 0.03, s * p[2]]);
      }
      const geo = new THREE.BufferGeometry();
      const v = [...pts[0], ...pts[1], ...pts[3], ...pts[0], ...pts[3], ...pts[2]];
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      const pm = new THREE.MeshStandardMaterial({ color: C.wing, roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide });
      const h = hinged(geo, pm, pts[0], pts[2]);
      g.add(h.obj);
      spoilers.push({ h, s });
    }
  }

  // Engines: nacelle, pylon, spinning fan face.
  const fans = [];
  for (const s of [-1, 1]) {
    const z = s * 10.5;
    g.add(new THREE.Mesh(loft([
      { x: 10.2, y: -3.3, z, w: 1.42, t: 1.42, b: 1.42 },
      { x: 9.7, y: -3.3, z, w: 1.6, t: 1.6, b: 1.6 },
      { x: 7.5, y: -3.3, z, w: 1.62, t: 1.62, b: 1.62 },
      { x: 4.6, y: -3.3, z, w: 1.42, t: 1.42, b: 1.42 },
      { x: 3.1, y: -3.3, z, w: 1.05, t: 1.05, b: 1.05 },
      { x: 2.2, y: -3.3, z, w: 0.55, t: 0.55, b: 0.55 },
    ], {
      profile: roundProfile(10),
      paint: ({ x, cap }) => cap ? (x > 9 ? 0x15171a : 0x3a3d42) : x > 9.7 ? C.lip : x < 3.1 ? 0x8d929a : C.navy,
    }), mat));
    g.add(new THREE.Mesh(surface([
      { x: 8.6, y: -2.0, z, chord: 7.0, t: 0.12 },
      { x: 7.0, y: -0.95, z, chord: 6.0, t: 0.12 },
    ], { tdir: [0, 0, 1], paint: () => C.grey }), mat));
    const fan = new THREE.Group();
    fan.position.set(9.95, -3.3, z);
    const spin = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.9, 10), lam(0xe8e8e8));
    spin.rotation.z = -Math.PI / 2; spin.position.x = 0.25;
    fan.add(spin);
    const bladeMat = lam(0x55595f);
    for (let i = 0; i < 16; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 0.24), bladeMat);
      b.position.y = 0.85;
      const arm = new THREE.Group();
      arm.rotation.x = i / 16 * Math.PI * 2;
      b.rotation.y = 0.5;
      arm.add(b);
      fan.add(arm);
    }
    g.add(fan);
    fans.push(fan);
  }

  // Tail
  const hst = [{ x: -23.5, y: 1.3, z: 1.2, chord: 6.5, t: 0.1 }, { x: -29.0, y: 2.4, z: 10.2, chord: 2.0, t: 0.09 }];
  const HR = wingHalf(hst, { hingeC: 0.7, surfaces: [{ from: 1.6, to: 9.8, key: 'elev' }], paint: wingPaint, mat });
  const HL = wingHalf(mirrorZ(hst), { hingeC: 0.7, surfaces: neg([{ from: 1.6, to: 9.8, key: 'elev' }]), paint: wingPaint, mat });
  g.add(HR.group, HL.group);
  const fin = [
    { x: -19.5, y: 2.4, z: 0, chord: 9.5, t: 0.11 },
    { x: -22.7, y: 6.3, z: 0, chord: 7.25, t: 0.106 },
    { x: -24.2, y: 8.1, z: 0, chord: 6.18, t: 0.104 },
    { x: -27.6, y: 12.2, z: 0, chord: 3.4, t: 0.10 },
  ];
  const finPaint = ({ y }) => y > 6.3 && y < 8.1 ? C.red : C.navy;
  const F = wingHalf(fin, { axis: 'y', tdir: [0, 0, 1], hingeC: 0.68, surfaces: [{ from: 3.0, to: 11.6, key: 'rud' }], paint: finPaint, mat });
  g.add(F.group);

  // Gear: twin nose wheels, four-wheel main bogies on the physics points.
  const sq = squash(P);
  const [gN, gL] = P.gear;
  const wheels = [];
  const noseLeg = legGroup(gN.r.x, -2.5, 0);
  const noseSteer = new THREE.Group();
  const ny = wheelY(gN, 0.55, sq) + 2.5;
  noseSteer.add(rod([0, 0, 0], [0, ny + 0.2, 0], 0.18, dark));
  for (const z of [-0.42, 0.42]) { const w = spokedWheel(0.55, 0.38, tire, hub, 0, ny, z); wheels.push(w); noseSteer.add(w); }
  noseLeg.add(noseSteer);
  const mainLegs = [-1, 1].map(s => {
    const l = legGroup(gL.r.x, -2.1, s * 5.0);
    const wy = wheelY(gL, 0.62, sq) + 2.1, zc = s * (Math.abs(gL.r.z) - 5.0);
    l.add(rod([0, 0, 0], [0, wy + 0.1, zc], 0.22, dark));
    l.add(rod([-1.05, wy, zc], [1.05, wy, zc], 0.14, dark));
    for (const dx of [-0.95, 0.95]) for (const dz of [-0.48, 0.48]) {
      const w = spokedWheel(0.62, 0.4, tire, hub, dx, wy, zc + dz);
      wheels.push(w); l.add(w);
    }
    return l;
  });
  g.add(noseLeg, ...mainLegs);
  const gear = gearRig([
    { grp: noseLeg, axis: 'z', ang: 1.55 },
    { grp: mainLegs[0], axis: 'x', ang: -1.5 },
    { grp: mainLegs[1], axis: 'x', ang: 1.5 },
  ]);

  const lights = navLights(g, 4.5, [
    ['red', -12.3, 1.25, -31.6], ['green', -12.3, 1.25, 31.6], ['white', -31.25, 1.85, 0],
    ['strobe', -12.3, 1.25, -31.6], ['strobe', -12.3, 1.25, 31.6], ['strobe', -31.25, 1.85, 0],
    ['beacon', 10.0, 2.95, 0], ['beacon', 10.0, -2.95, 0],
  ]);

  const flaps = flapLag();
  let spoil = 0, fanAngle = 0;
  return {
    group: g,
    animate(controls, rpmNorm, dt, st) {
      gear(dt, st);
      lights(dt, litSwitches(st));
      const e = 0.12 * controls.elevator;
      HR.elev.set(e); HL.elev.set(-e);
      const ael = 0.15 * controls.aileron;
      WR.ail.set(ael); WL.ail.set(ael);
      F.rud.set(0.12 * controls.rudder);
      const f = flaps(controls, st, dt);
      for (const k of ['flapIn', 'flapOut']) {
        WR[k].set(0.5 * f); WL[k].set(-0.5 * f);
        WR[k].slide(1.1 * f); WL[k].slide(1.1 * f);
      }
      // Auto ground spoilers: deploy on the ground at idle while still rolling.
      const want = st && st.onGround && controls.throttle < 0.08 && (st.groundSpeed || 0) > 12 ? 1 : 0;
      spoil += (want - spoil) * Math.min(1, dt * 3);
      for (const sp of spoilers) sp.h.set(-sp.s * 0.9 * spoil);
      noseSteer.rotation.y = -0.3 * controls.rudder;
      wheelSpin(wheels, 0.6, st, dt);
      fanAngle += (2 + 40 * rpmNorm) * dt;
      for (const fan of fans) fan.rotation.x = fanAngle;
    },
  };
}

// ------------------------------------------------------------------ spirit --
// B-2-silhouette flying wing, 52.4 m span: a real airfoil loft through the
// sawtooth planform, a thick centre body, elevons and split drag rudders.

function spirit() {
  const P = AIRCRAFT.spirit;
  const C = { top: 0x3c4048, low: 0x31343a, glass: 0x10161d, intake: 0x202227, exhaust: 0x4f4b46, edge: 0x464a52 };
  const mat = paintMat({ roughness: 0.7, clearcoat: 0.0, metalness: 0.1 });   // radar-absorbent matte
  const dark = lam(0x212327), tire = lam(0x141416), hub = lam(0x8a8f96);
  const g = new THREE.Group();
  const half = 26.2;
  const leX = (z) => 11 - 12 * (z / half);
  const TE = [[0, -10.5], [4, -6], [8.5, -9], [14.5, -4.5], [19, -7.5], [26.2, -3.5]];
  const teX = (z) => {
    for (let i = 1; i < TE.length; i++) {
      if (z <= TE[i][0] + 1e-6) {
        const [z0, x0] = TE[i - 1], [z1, x1] = TE[i];
        return x0 + (x1 - x0) * (z - z0) / (z1 - z0);
      }
    }
    return TE[TE.length - 1][1];
  };
  const thk = (z) => 0.055 + 0.11 * Math.pow(Math.max(0, 1 - z / 11), 1.5);
  const zs = [0, 1.6, 4, 6, 8.5, 9.2, 13.8, 14.5, 17, 19, 20, 25.2, 26.2];
  const sts = zs.map(z => ({ x: leX(z), y: 0, z, chord: leX(z) - teX(z), t: thk(z) }));
  const paint = ({ x, z, up }) => {
    const a = Math.abs(z);
    if (!up) return C.low;
    if (x > 7.6 && x < 10.4 && a < 1.7) return C.glass;
    if (x > 1.5 && x < 5.5 && a > 2.2 && a < 6.2) return C.intake;
    if (x < -3.5 && x > -8.5 && a > 1.4 && a < 6.5) return C.exhaust;
    return C.top;
  };
  // The drag-rudder span is a `skip` surface: kept out of the fixed trailing
  // fill, then filled by the split upper/lower pair built here.
  const surfs = [{ from: 9.2, to: 13.8, key: 'elev' }, { from: 20, to: 25.2, key: 'drag', skip: true }];
  const build = (stations, sgn) => {
    const W = wingHalf(stations, { hingeC: 0.86, camber: 0.012,
      surfaces: surfs.map(s => ({ ...s, from: sgn * s.from, to: sgn * s.to })), paint, mat });
    const ds = [20, 25.2].map(z => stationAt(stations, sgn * z));
    const A = surfacePoint(ds[0], 0.86, 0, 0.012), B = surfacePoint(ds[1], 0.86, 0, 0.012);
    const up = hinged(surface(ds, { c0: 0.872, half: 'upper', camber: 0.012, paint }), mat, A, B);
    const lo = hinged(surface(ds, { c0: 0.872, half: 'lower', camber: 0.012, paint }), mat, A, B);
    W.group.add(up.obj, lo.obj);
    return { ...W, dUp: up, dLo: lo };
  };
  const RW = build(sts, 1), LW = build(mirrorZ(sts), -1);
  g.add(RW.group, LW.group);
  H(RW.group); H(LW.group);

  // Engine intake humps and the cockpit hump
  for (const s of [-1, 1]) {
    g.add(H(new THREE.Mesh(loft([
      { x: 5.6, y: 1.35, z: s * 4.2, w: 0.05, t: 0.02, b: 0.02 },
      { x: 4.6, y: 1.3, z: s * 4.2, w: 1.5, t: 0.35, b: 0.1 },
      { x: 1.5, y: 1.15, z: s * 4.2, w: 1.4, t: 0.3, b: 0.1 },
      { x: -1.5, y: 0.95, z: s * 4.2, w: 0.2, t: 0.05, b: 0.05 },
    ], { profile: PROFILE.cabin, paint: ({ x }) => x > 4.6 ? 0x0c0d0f : C.top }), mat)));
  }

  // Retractable gear on the physics contact points.
  const sq = squash(P);
  const [gN, gL] = P.gear;
  const wheels = [];
  const noseLeg = legGroup(gN.r.x, -1.3, 0);
  const noseSteer = new THREE.Group();
  const ny = wheelY(gN, 0.45, sq) + 1.3;
  noseSteer.add(rod([0, 0, 0], [0, ny + 0.1, 0], 0.14, dark));
  for (const z of [-0.3, 0.3]) { const w = spokedWheel(0.45, 0.3, tire, hub, 0, ny, z); wheels.push(w); noseSteer.add(w); }
  noseLeg.add(noseSteer);
  const mainLegs = [-1, 1].map(s => {
    const l = legGroup(gL.r.x, -1.25, s * Math.abs(gL.r.z));
    const wy = wheelY(gL, 0.55, sq) + 1.25;
    l.add(rod([0, 0, 0], [0, wy + 0.1, 0], 0.18, dark));
    for (const dx of [-0.65, 0.65]) { const w = spokedWheel(0.55, 0.4, tire, hub, dx, wy, 0); wheels.push(w); l.add(w); }
    return l;
  });
  g.add(noseLeg, ...mainLegs);
  const gear = gearRig([
    { grp: noseLeg, axis: 'z', ang: -1.55 },
    { grp: mainLegs[0], axis: 'x', ang: 1.5 },
    { grp: mainLegs[1], axis: 'x', ang: -1.5 },
  ]);

  const lights = navLights(g, 3.5, [
    ['red', -2.2, 0.15, -26.1], ['green', -2.2, 0.15, 26.1], ['white', -10.6, 0.1, 0],
    ['strobe', -2.2, 0.15, -26.1], ['strobe', -2.2, 0.15, 26.1],
    ['beacon', 2.0, 1.9, 0], ['beacon', 2.0, -1.9, 0],
  ]);

  return {
    group: g,
    animate(controls, rpmNorm, dt, st) {
      gear(dt, st);
      lights(dt, litSwitches(st));
      const eR = 0.3 * controls.elevator + 0.35 * controls.aileron;
      const eL = 0.3 * controls.elevator - 0.35 * controls.aileron;
      RW.elev.set(eR); LW.elev.set(-eL);
      // split drag rudders open on the side the pilot wants the nose to go
      const r = controls.rudder;
      const oR = 0.7 * Math.max(0, r), oL = 0.7 * Math.max(0, -r);
      RW.dUp.set(-oR); RW.dLo.set(oR);
      LW.dUp.set(oL); LW.dLo.set(-oL);
      noseSteer.rotation.y = -0.3 * controls.rudder;
      wheelSpin(wheels, 0.55, st, dt);
    },
  };
}

export const MESH_BUILDERS = { c172, extra300, hornet, heavy, spirit };
