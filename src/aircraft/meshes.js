// Low-poly flat-shaded aircraft meshes for ARCHIPELAGO v2.
// Model frame: +x forward, +y up, +z right (matches the physics body frame).
// Every builder returns { group: THREE.Group, animate(controls, rpmNorm, dt) }
// with exactly the shape of createAircraftMesh() in ../aircraft.js.
//
// controls: { elevator, aileron, rudder, throttle, flaps, brakes }
//   elevator/aileron/rudder in -1..1, throttle/flaps in 0..1, brakes boolean.
// rpmNorm: 0..1 normalized engine speed.
// Optional 4th arg `st` (the live ac: onGround, agl, vel.y) drives the retractable gear on
// the jets/airliner/flying wing; without it the gear stays down (menu preview).

import * as THREE from 'three';

// ---------------------------------------------------------------- helpers --

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// Cylinder with its axis aligned to model +x (default THREE cylinder axis is
// Y; rotation.z = -90deg maps local +Y to world +X).
function cyl(rTop, rBot, h, seg, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
  m.rotation.z = -Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

// Cone with its tip pointing +x (nose cones, spinners, engine nozzles).
function coneX(r, h, seg, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat);
  m.rotation.z = -Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

// Simple aircraft tire: a short, wide cylinder with its axis along z so it
// rolls forward about +x.
function wheel(r, w, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 10), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

// Tapered + swept lifting-surface panel (wings, horizontal stabs), built by
// shearing a BoxGeometry -- same trick as the fuselage taper below, applied
// spanwise. Local z spans [-span/2, +span/2]; `side` (+1/-1) selects which
// end is the untapered root. The returned geometry should be positioned with
// z = side * (rootZOffset + span / 2) so the root sits at rootZOffset.
function sweptPanelGeo(rootChord, tipChord, span, sweep, thickness, side) {
  const geo = new THREE.BoxGeometry(rootChord, thickness, span);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const zl = p.getZ(i);
    const t = side > 0 ? (zl + span / 2) / span : (span / 2 - zl) / span; // 0 root .. 1 tip
    const chordScale = 1 - (1 - tipChord / rootChord) * t;
    p.setX(i, p.getX(i) * chordScale - sweep * t);
  }
  geo.computeVertexNormals();
  return geo;
}

// Tapered + swept vertical surface (fins). Local y spans [-height/2,
// +height/2] with the root at the bottom (y = -height/2).
function verticalPanelGeo(rootChord, tipChord, height, sweep, thickness) {
  const geo = new THREE.BoxGeometry(rootChord, height, thickness);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const yl = p.getY(i);
    const t = (yl + height / 2) / height; // 0 root(bottom) .. 1 tip(top)
    const chordScale = 1 - (1 - tipChord / rootChord) * t;
    p.setX(i, p.getX(i) * chordScale - sweep * t);
  }
  geo.computeVertexNormals();
  return geo;
}

// A hinged flap/control-surface box: local x=0 is the hinge (leading) edge,
// the panel trails off toward -x. Mirrors the elevator/aileron/rudder
// pattern used throughout src/aircraft.js.
function flapGeo(chord, thickness, span) {
  const geo = new THREE.BoxGeometry(chord, thickness, span);
  geo.translate(-chord / 2, 0, 0);
  return geo;
}


// ------------------------------------------------- shared visual helpers --

// Canopy / windscreen glass: flat-shaded but with a specular sheen so the sun
// glints across the facets.
function glassMat(color, opts = {}) {
  return new THREE.MeshPhongMaterial({
    color, flatShading: true, specular: 0x9fb8cc, shininess: 90,
    emissive: 0x050a10, ...opts,
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
// Prop blur: translucent hub, denser band toward the tips, feathered edge.
function propTex() {
  return _propTex || (_propTex = radialTex([
    [0, 'rgba(70,70,74,0.25)'], [0.3, 'rgba(60,60,64,0.45)'],
    [0.75, 'rgba(50,50,54,0.8)'], [0.92, 'rgba(50,50,54,0.55)'],
    [1, 'rgba(50,50,54,0)'],
  ], 128));
}

// Prop blur disc whose opacity follows rpm (see propBlur()).
function propDisc(radius) {
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 24),
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
  const o = Math.min(1, Math.max(0, (rpmNorm - 0.12) / 0.6)) * 0.55;
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
    _navCoreMat[col] = new THREE.MeshBasicMaterial({ color: _navCol[col], toneMapped: false });
    _navGlowMat[col] = new THREE.SpriteMaterial({
      map: glowTex(), color: _navCol[col], blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, toneMapped: false, opacity: 0.55,
    });
  }
  return [_navCoreMat[col], _navGlowMat[col]];
}
function navLights(parent, s, specs) {
  const blinkers = [];
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
  }
  let t = 0;
  // Called once per frame; allocation free.
  return function tick(dt) {
    t += dt;
    const sp = t % 1.2;
    const strobeOn = sp < 0.07 || (sp > 0.18 && sp < 0.25);
    const beaconOn = (t % 0.95) < 0.22;
    for (let i = 0; i < blinkers.length; i++) {
      blinkers[i].grp.visible = blinkers[i].kind === 'strobe' ? strobeOn : beaconOn;
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

// ------------------------------------------------------------------ c172 --
// Verbatim port of createAircraftMesh() from src/aircraft.js.

function c172() {
  const M = {
    body:   new THREE.MeshLambertMaterial({ color: 0xece7d8, flatShading: true }),
    accent: new THREE.MeshLambertMaterial({ color: 0xb8372e, flatShading: true }),
    navy:   new THREE.MeshLambertMaterial({ color: 0x1f3454, flatShading: true }),
    belly:  new THREE.MeshLambertMaterial({ color: 0xcdc6b2, flatShading: true }),
    glass:  glassMat(0x1d2a36),
    dark:   new THREE.MeshLambertMaterial({ color: 0x2a2d31, flatShading: true }),
    tire:   new THREE.MeshLambertMaterial({ color: 0x17181a, flatShading: true }),
  };

  const g = new THREE.Group();

  // Cabin + nose
  g.add(box(2.6, 1.25, 1.15, M.body, 0.45, 0, 0));
  g.add(box(1.15, 0.95, 1.0, M.body, 2.15, -0.12, 0));
  g.add(box(0.1, 0.5, 1.02, M.dark, 2.74, -0.15, 0)); // cowl face

  // Tapered tail cone
  const tailGeo = new THREE.BoxGeometry(3.1, 1.0, 0.9);
  {
    const p = tailGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = 1 - 0.68 * ((1.55 - p.getX(i)) / 3.1); // full at front, slim at rear
      p.setY(i, p.getY(i) * k + 0.12 * (1 - k));
      p.setZ(i, p.getZ(i) * k);
    }
    tailGeo.computeVertexNormals();
  }
  const tail = new THREE.Mesh(tailGeo, M.body);
  tail.position.set(-2.4, 0.05, 0);
  g.add(tail);

  // Windshield + side glass
  const ws = box(0.7, 0.55, 1.0, M.glass, 1.35, 0.55, 0);
  ws.rotation.z = -0.5;
  g.add(ws);
  g.add(box(1.5, 0.42, 1.18, M.glass, 0.35, 0.5, 0));

  // Red cheat line + tail stripe
  g.add(box(2.62, 0.16, 1.17, M.accent, 0.45, -0.28, 0));
  g.add(box(2.64, 0.05, 1.18, M.navy, 0.45, -0.4, 0)); // navy pinstripe under it
  g.add(box(2.6, 0.12, 1.12, M.belly, 0.45, -0.66, 0)); // shaded belly
  g.add(box(1.1, 0.14, 0.92, M.belly, 2.15, -0.64, 0));
  g.add(box(2.9, 0.12, 0.7, M.accent, -2.45, 0.2, 0.0)); // tail-cone dorsal stripe

  // High wing, two halves with slight dihedral; ailerons hinged at trailing edge
  const wingHalf = (side) => {
    const grp = new THREE.Group();
    const w = box(1.5, 0.13, 5.3, M.body, 0, 0, side * 2.65);
    grp.add(w);
    grp.add(box(1.52, 0.14, 0.5, M.accent, 0, 0, side * 5.15)); // tip
    grp.add(box(1.4, 0.03, 0.12, M.navy, 0, 0.08, side * 4.88)); // tip pinstripe
    const ailGeo = new THREE.BoxGeometry(0.42, 0.09, 1.7);
    ailGeo.translate(-0.21, 0, 0);
    const ail = new THREE.Mesh(ailGeo, M.body);
    ail.position.set(-0.75, 0, side * 4.2);
    grp.add(ail);
    grp.rotation.x = -side * 0.035; // dihedral
    return { grp, ail };
  };
  const L = wingHalf(-1), R = wingHalf(1);
  const wing = new THREE.Group();
  wing.add(L.grp, R.grp);
  wing.position.set(0.35, 0.72, 0);
  g.add(wing);

  // Wing struts
  for (const s of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.6), M.body);
    strut.position.set(0.45, 0.05, s * 1.5);
    strut.rotation.x = s * 0.9;
    g.add(strut);
  }

  // Horizontal stab + elevator
  g.add(box(0.85, 0.09, 3.3, M.body, -3.75, 0.18, 0));
  const elevGeo = new THREE.BoxGeometry(0.5, 0.07, 3.3);
  elevGeo.translate(-0.25, 0, 0);
  const elevator = new THREE.Mesh(elevGeo, M.body);
  elevator.position.set(-4.17, 0.18, 0);
  g.add(elevator);

  // Fin + rudder
  const fin = box(0.95, 1.55, 0.11, M.accent, -3.7, 0.95, 0);
  fin.rotation.z = 0.35;
  g.add(fin);
  const finBand = box(0.9, 0.2, 0.13, M.navy, -3.9, 1.0, 0);
  finBand.rotation.z = 0.35;
  g.add(finBand);
  const rudGeo = new THREE.BoxGeometry(0.5, 1.35, 0.09);
  rudGeo.translate(-0.25, 0, 0);
  const rudder = new THREE.Mesh(rudGeo, M.accent);
  rudder.position.set(-4.25, 0.9, 0);
  g.add(rudder);

  // Landing gear
  const wh = (x, z, r = 0.27) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.17, 10), M.tire);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, -1.02, z);
    return m;
  };
  const noseWheel = wh(1.7, 0, 0.22);
  g.add(noseWheel);
  g.add(wh(-0.35, -1.15), wh(-0.35, 1.15));
  const leg = (x, z, tilt) => {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.7, 0.08), M.dark);
    l.position.set(x, -0.65, z); l.rotation.x = tilt;
    return l;
  };
  g.add(leg(1.7, 0, 0), leg(-0.35, -0.9, 0.55), leg(-0.35, 0.9, -0.55));

  // Prop: spinner + blades + blur disc
  const propGroup = new THREE.Group();
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.45, 8), M.dark);
  spinner.rotation.z = -Math.PI / 2;
  propGroup.add(spinner);
  const blades = new THREE.Group();
  blades.add(box(0.05, 1.85, 0.2, M.dark));
  propGroup.add(blades);
  const disc = propDisc(0.95);
  propGroup.add(disc);
  propGroup.position.set(2.78, -0.12, 0);
  g.add(propGroup);

  const lights = navLights(g, 0.9, [
    ['red', 0.35, 0.9, -5.4], ['green', 0.35, 0.9, 5.4], ['white', -4.35, 1.15, 0],
    ['strobe', 0.35, 0.9, -5.4], ['strobe', 0.35, 0.9, 5.4], ['beacon', -3.95, 1.75, 0],
  ]);

  let propAngle = 0;
  return {
    group: g,
    animate(controls, rpmNorm, dt) {
      const ael = 0.35 * controls.aileron;
      L.ail.rotation.z = -ael;
      R.ail.rotation.z = ael;
      elevator.rotation.z = 0.32 * controls.elevator;
      rudder.rotation.y = 0.35 * controls.rudder;
      noseWheel.rotation.y = -0.3 * controls.rudder;
      propAngle += (4 + 105 * rpmNorm) * dt;
      blades.rotation.x = propAngle;
      propBlur(disc, blades, rpmNorm);
      lights(dt);
    },
  };
}

// --------------------------------------------------------------- extra300 --
// Low-wing aerobatic single-seater, ~7m long / 8m span, taildragger gear.

function extra300() {
  const M = {
    body:   new THREE.MeshLambertMaterial({ color: 0xf4f2ea, flatShading: true }),
    accent: new THREE.MeshLambertMaterial({ color: 0xc81e1e, flatShading: true }),
    black:  new THREE.MeshLambertMaterial({ color: 0x1c1d21, flatShading: true }),
    belly:  new THREE.MeshLambertMaterial({ color: 0xd8d5c8, flatShading: true }),
    glass:  glassMat(0x1b252e),
    dark:   new THREE.MeshLambertMaterial({ color: 0x24262a, flatShading: true }),
    tire:   new THREE.MeshLambertMaterial({ color: 0x141416, flatShading: true }),
  };

  const g = new THREE.Group();

  // Boxy, slab-sided aerobatic fuselage + cowl
  g.add(box(2.3, 1.05, 1.0, M.body, 0.2, 0, 0));
  g.add(box(1.35, 0.85, 0.88, M.body, 1.75, -0.08, 0));
  g.add(box(0.1, 0.5, 0.9, M.dark, 2.45, -0.1, 0)); // cowl face

  // Tapered tail cone (slimmer/longer than the C172's)
  const tailGeo = new THREE.BoxGeometry(3.3, 0.85, 0.78);
  {
    const p = tailGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = 1 - 0.78 * ((1.65 - p.getX(i)) / 3.3);
      p.setY(i, p.getY(i) * k + 0.08 * (1 - k));
      p.setZ(i, p.getZ(i) * k);
    }
    tailGeo.computeVertexNormals();
  }
  const tail = new THREE.Mesh(tailGeo, M.body);
  tail.position.set(-1.75, 0.05, 0);
  g.add(tail);

  // Single-seat bubble canopy: small dark rounded box
  g.add(box(1.1, 0.4, 0.72, M.glass, 1.05, 0.55, 0));
  g.add(box(0.5, 0.28, 0.7, M.glass, 1.75, 0.42, 0)); // windshield step

  // Sunburst-ish red accents: spine stripe + radiating stripes near the wing root
  g.add(box(2.0, 0.1, 0.2, M.accent, 0.4, 0.62, 0));
  g.add(box(2.3, 0.05, 1.02, M.black, 0.2, -0.3, 0)); // black belt line
  g.add(box(2.2, 0.1, 0.9, M.belly, 0.2, -0.5, 0));  // shaded belly
  for (let i = 0; i < 5; i++) {
    const ray = box(1.1, 0.05, 0.16, M.accent, 0.35, 0.05, 0);
    ray.rotation.y = (i - 2) * 0.34;
    g.add(ray);
  }

  // LOW wing, mounted at belly; large ailerons (~half span)
  const halfSpan = 3.75;
  const wingHalf = (side) => {
    const grp = new THREE.Group();
    grp.add(box(1.35, 0.14, halfSpan, M.body, 0, 0, side * halfSpan / 2));
    grp.add(box(1.3, 0.15, 0.4, M.accent, 0, 0, side * (halfSpan + 0.2))); // tip
    grp.add(box(1.36, 0.145, 0.3, M.black, 0, 0, side * (halfSpan - 0.35))); // black band
    const ailGeo = new THREE.BoxGeometry(0.4, 0.1, halfSpan * 0.55);
    ailGeo.translate(-0.2, 0, 0);
    const ail = new THREE.Mesh(ailGeo, M.body);
    ail.position.set(-0.68, 0, side * (halfSpan - (halfSpan * 0.55) / 2));
    grp.add(ail);
    return { grp, ail };
  };
  const L = wingHalf(-1), R = wingHalf(1);
  const wing = new THREE.Group();
  wing.add(L.grp, R.grp);
  wing.position.set(0.3, -0.35, 0);
  g.add(wing);

  // Horizontal stab + elevator
  g.add(box(0.75, 0.08, 2.3, M.body, -3.15, 0.15, 0));
  const elevGeo = new THREE.BoxGeometry(0.42, 0.07, 2.3);
  elevGeo.translate(-0.21, 0, 0);
  const elevator = new THREE.Mesh(elevGeo, M.body);
  elevator.position.set(-3.53, 0.15, 0);
  g.add(elevator);

  // Fin + rudder
  const fin = box(0.8, 1.25, 0.1, M.accent, -3.05, 0.75, 0);
  fin.rotation.z = 0.32;
  g.add(fin);
  const rudGeo = new THREE.BoxGeometry(0.42, 1.1, 0.08);
  rudGeo.translate(-0.21, 0, 0);
  const rudder = new THREE.Mesh(rudGeo, M.accent);
  rudder.position.set(-3.6, 0.72, 0);
  g.add(rudder);

  // Taildragger gear: spatted mains forward under the wing + small tailwheel
  const mainPant = (side) => {
    const grp = new THREE.Group();
    grp.add(box(0.24, 0.55, 0.3, M.dark, 0, 0, 0)); // wheel pant
    grp.add(wheel(0.28, 0.13, M.tire, 0, -0.28, 0));
    grp.position.set(0.55, -0.78, side * 0.95);
    return grp;
  };
  g.add(mainPant(-1), mainPant(1));
  const leg = (x, z) => box(0.09, 0.55, 0.07, M.dark, x, -0.55, z);
  g.add(leg(0.55, -0.95), leg(0.55, 0.95));
  const tailWheel = wheel(0.12, 0.08, M.tire, -3.55, -0.5, 0);
  g.add(tailWheel);
  g.add(box(0.07, 0.35, 0.06, M.dark, -3.55, -0.35, 0));

  // Big spinner + 2-blade prop with blur disc
  const propGroup = new THREE.Group();
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 8), M.dark);
  spinner.rotation.z = -Math.PI / 2;
  propGroup.add(spinner);
  const blades = new THREE.Group();
  blades.add(box(0.06, 2.1, 0.24, M.dark));
  propGroup.add(blades);
  const disc = propDisc(1.05);
  propGroup.add(disc);
  propGroup.position.set(2.5, -0.1, 0);
  g.add(propGroup);

  const lights = navLights(g, 0.85, [
    ['red', 0.3, -0.35, -4.2], ['green', 0.3, -0.35, 4.2], ['white', -4.1, 0.95, 0],
    ['strobe', 0.3, -0.35, -4.2], ['strobe', 0.3, -0.35, 4.2], ['beacon', -3.3, 1.4, 0],
  ]);

  let propAngle = 0;
  return {
    group: g,
    animate(controls, rpmNorm, dt) {
      const ael = 0.45 * controls.aileron; // large ailerons
      L.ail.rotation.z = -ael;
      R.ail.rotation.z = ael;
      elevator.rotation.z = 0.36 * controls.elevator;
      rudder.rotation.y = 0.4 * controls.rudder;
      tailWheel.rotation.y = -0.35 * controls.rudder;
      propAngle += (4 + 130 * rpmNorm) * dt;
      blades.rotation.x = propAngle;
      propBlur(disc, blades, rpmNorm);
      lights(dt);
    },
  };
}

// ------------------------------------------------------------------ hornet --
// Twin-engine, twin-tail fighter, ~17.6m long / ~12.4m span.

function hornet() {
  const M = {
    body:  new THREE.MeshLambertMaterial({ color: 0x8b939c, flatShading: true }),
    panel: new THREE.MeshLambertMaterial({ color: 0x767e87, flatShading: true }),
    top:   new THREE.MeshLambertMaterial({ color: 0x6f7881, flatShading: true }),
    band:  new THREE.MeshLambertMaterial({ color: 0xd9a21b, flatShading: true }),
    red:   new THREE.MeshLambertMaterial({ color: 0xb02424, flatShading: true }),
    glass: glassMat(0x2a3640, { specular: 0xc8dcf0 }),
    dark:  new THREE.MeshLambertMaterial({ color: 0x2b2e32, flatShading: true }),
    tire:  new THREE.MeshLambertMaterial({ color: 0x141416, flatShading: true }),
    flame: new THREE.MeshBasicMaterial({ color: 0xffa53d, transparent: true, opacity: 0.75, depthWrite: false }),
  };

  const g = new THREE.Group();

  // Main fuselage (0.0 -> 9.0)
  g.add(box(9.0, 1.3, 1.6, M.body, 4.5, 0, 0));
  // Nose cone / radome (base 9.0, tip 11.4)
  g.add(coneX(0.35, 2.4, 10, M.body, 10.2, 0, 0));
  g.add(coneX(0.16, 0.9, 10, M.dark, 11.6, 0, 0)); // dark radome tip
  // Two-tone: darker dorsal skin, light underside panel, intake-side shadow
  g.add(box(6.2, 0.06, 1.2, M.top, 3.2, 0.67, 0));
  g.add(box(8.0, 0.08, 1.3, M.panel, 4.2, -0.66, 0));

  // LEX strakes blending the wing root into the nose, tapered to a point forward
  const lex = (side) => {
    const geo = new THREE.BoxGeometry(4.5, 0.1, 1.0);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const t = (x + 2.25) / 4.5; // 0 at rear (root) .. 1 at forward tip
      p.setZ(i, p.getZ(i) * (1 - 0.92 * t));
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, M.panel);
    m.position.set(4.5, 0.4, side * 0.95);
    return m;
  };
  g.add(lex(-1), lex(1));

  // Cockpit canopy bulge
  g.add(box(2.3, 0.55, 0.9, M.glass, 7.0, 0.85, 0));
  g.add(box(1.0, 0.3, 0.85, M.glass, 8.2, 0.65, 0));

  // Tail cone / boat-tail housing the nozzles (0.0 -> -5.2)
  const tailGeo = new THREE.BoxGeometry(5.2, 1.1, 1.4);
  {
    const p = tailGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = (2.6 - p.getX(i)) / 5.2; // 0 at front, 1 at rear
      const k = 1 - 0.55 * t;
      p.setY(i, p.getY(i) * k);
      p.setZ(i, p.getZ(i) * k);
    }
    tailGeo.computeVertexNormals();
  }
  const tailCone = new THREE.Mesh(tailGeo, M.body);
  tailCone.position.set(-2.6, 0, 0);
  g.add(tailCone);

  // Twin engine nozzles
  g.add(cyl(0.42, 0.34, 1.2, 10, M.dark, -5.6, 0, -0.6));
  g.add(cyl(0.42, 0.34, 1.2, 10, M.dark, -5.6, 0, 0.6));

  // Afterburner flames -- hidden unless throttle > 0.95
  const flameGeo = new THREE.ConeGeometry(0.34, 1.6, 8);
  const flameL = new THREE.Mesh(flameGeo, M.flame);
  flameL.rotation.z = Math.PI / 2; // tip points -x (aft)
  flameL.position.set(-7.0, 0, -0.6);
  flameL.visible = false;
  const flameR = new THREE.Mesh(flameGeo, M.flame);
  flameR.rotation.z = Math.PI / 2;
  flameR.position.set(-7.0, 0, 0.6);
  flameR.visible = false;
  g.add(flameL, flameR);

  // Wings: swept trapezoid via a sheared box (total span ~12.4m)
  const wingSpan = 5.4, wingRootZ = 0.8;
  const wingHalf = (side) => {
    const geo = sweptPanelGeo(3.2, 1.0, wingSpan, 2.1, 0.16, side);
    const m = new THREE.Mesh(geo, M.body);
    m.position.set(2.0, -0.05, side * (wingRootZ + wingSpan / 2));
    g.add(m);
    // Outer flaperon/aileron
    const ail = new THREE.Mesh(flapGeo(0.5, 0.1, wingSpan * 0.4), M.panel);
    ail.position.set(1.0, -0.05, side * (wingRootZ + wingSpan - (wingSpan * 0.4) / 2));
    g.add(ail);
    return ail;
  };
  const ailL = wingHalf(-1), ailR = wingHalf(1);

  // Twin canted vertical fins with rudders
  const finHeight = 2.3, finRootZ = 1.15;
  const finGroup = (side) => {
    const grp = new THREE.Group();
    const fin = new THREE.Mesh(verticalPanelGeo(1.7, 0.7, finHeight, 0.95, 0.12), M.panel);
    fin.position.set(0, finHeight / 2, 0);
    grp.add(fin);
    const tipBand = new THREE.Mesh(verticalPanelGeo(0.78, 0.7, 0.35, 0.05, 0.14), M.band);
    tipBand.position.set(-0.85, finHeight - 0.22, 0); // squadron tail band
    grp.add(tipBand);
    const rudder = new THREE.Mesh(flapGeo(0.42, 0.1, finHeight * 0.5), M.dark);
    rudder.rotation.z = -Math.PI / 2; // hinge about vertical (y) axis instead of z
    rudder.position.set(0, finHeight * 0.72, 0.21);
    grp.add(rudder);
    grp.position.set(-1.6, 0.7, side * finRootZ);
    grp.rotation.x = side * 0.35; // canted outward ~20deg
    grp.rotation.z = 0.1;
    return { grp, rudder };
  };
  const finL = finGroup(-1), finR = finGroup(1);
  g.add(finL.grp, finR.grp);

  // Full-moving horizontal stabs
  const stabSpan = 1.9, stabRootZ = 0.75;
  const stabHalf = (side) => {
    const geo = sweptPanelGeo(1.4, 0.6, stabSpan, 0.7, 0.12, side);
    const m = new THREE.Mesh(geo, M.body);
    m.position.set(-2.2, 0.2, side * (stabRootZ + stabSpan / 2));
    g.add(m);
    return m;
  };
  const stabL = stabHalf(-1), stabR = stabHalf(1);

  // Tricycle gear (retractable): pivots at the leg tops, nose folds aft,
  // mains fold inboard into the belly.
  const noseLeg = legGroup(6.0, -0.3, 0);
  const noseWheelM = wheel(0.26, 0.16, M.tire, 0, -0.65, 0);
  noseLeg.add(noseWheelM, box(0.09, 0.7, 0.08, M.dark, 0, -0.3, 0));
  const mainLegH = (side) => {
    const l = legGroup(2.0, -0.3, side * 0.9);
    l.add(wheel(0.32, 0.2, M.tire, 0, -0.75, 0), box(0.1, 0.75, 0.09, M.dark, 0, -0.35, 0));
    return l;
  };
  const mainLH = mainLegH(-1), mainRH = mainLegH(1);
  g.add(noseLeg, mainLH, mainRH);
  const gear = gearRig([
    { grp: noseLeg, axis: 'z', ang: -1.5 },
    { grp: mainLH, axis: 'x', ang: -1.5 },
    { grp: mainRH, axis: 'x', ang: 1.5 },
  ]);

  const lights = navLights(g, 1.2, [
    ['red', 1.4, -0.05, -6.3], ['green', 1.4, -0.05, 6.3], ['white', -5.4, 0.45, 0],
    ['strobe', 1.4, -0.05, -6.3], ['strobe', 1.4, -0.05, 6.3], ['beacon', 4.0, 0.74, 0],
  ]);

  let abPhase = 0;
  return {
    group: g,
    animate(controls, rpmNorm, dt, st) {
      gear(dt, st);
      lights(dt);
      const elevDeflect = 0.28 * controls.elevator; // full-moving stabs
      stabL.rotation.z = elevDeflect;
      stabR.rotation.z = elevDeflect;

      const ael = 0.4 * controls.aileron; // outer flaperons
      ailL.rotation.z = -ael;
      ailR.rotation.z = ael;

      const rud = 0.35 * controls.rudder;
      finL.rudder.rotation.y = rud;
      finR.rudder.rotation.y = rud;

      noseWheelM.rotation.y = -0.3 * controls.rudder;

      const abOn = controls.throttle > 0.95;
      flameL.visible = flameR.visible = abOn;
      if (abOn) {
        abPhase += dt;
        const flick = 1 + 0.15 * Math.sin(abPhase * 46) + 0.08 * Math.sin(abPhase * 113 + 1.7);
        flameL.scale.setScalar(flick);
        flameR.scale.setScalar(flick * (1 + 0.05 * Math.sin(abPhase * 71 + 0.6)));
      }
    },
  };
}

// ------------------------------------------------------------------- heavy --
// Twin-engine widebody airliner, ~59m long / 64m span.

function heavy() {
  const M = {
    body:   new THREE.MeshLambertMaterial({ color: 0xf2f1ec, flatShading: true }),
    accent: new THREE.MeshLambertMaterial({ color: 0xc21f1f, flatShading: true }),
    navy:   new THREE.MeshLambertMaterial({ color: 0x20345a, flatShading: true }),
    belly:  new THREE.MeshLambertMaterial({ color: 0xc9c8c2, flatShading: true }),
    glass:  glassMat(0x1c2630),
    dark:   new THREE.MeshLambertMaterial({ color: 0x2a2c30, flatShading: true }),
    tire:   new THREE.MeshLambertMaterial({ color: 0x141416, flatShading: true }),
  };

  const CY = 3.0; // fuselage centerline height (gear reaches ~5.5m below this)
  const g = new THREE.Group();

  // Long tube fuselage + nose/tail cones
  g.add(cyl(2.2, 2.2, 46, 12, M.body, 2.0, CY, 0));           // tube: -21 .. 25
  g.add(coneX(2.2, 4, 12, M.body, 27.0, CY, 0));               // nose: 25 .. 29
  g.add(cyl(2.2, 0.3, 9, 12, M.body, -25.5, CY, 0));           // tail cone: -21 .. -30

  // Black cockpit window band + red belly stripe
  g.add(box(2.2, 0.5, 1.8, M.dark, 25.5, CY + 1.5, 0));
  g.add(box(38, 0.35, 2.2, M.accent, 2.0, CY - 2.25, 0));
  // Window rows + navy cheatline down both sides, grey belly
  for (const sd of [-1, 1]) {
    g.add(box(34, 0.32, 0.12, M.glass, 2.0, CY + 0.95, sd * 2.04));
    g.add(box(40, 0.22, 0.1, M.navy, 1.0, CY + 0.35, sd * 2.1));
  }
  g.add(box(42, 0.5, 2.9, M.belly, 1.0, CY - 1.95, 0));

  // Swept wings, slight dihedral, low-mid mounted (total span 64m)
  const wingSpan = 30, wingRootZ = 2.0;
  const wingHalf = (side) => {
    const m = new THREE.Mesh(sweptPanelGeo(8.5, 2.2, wingSpan, 13, 0.55, side), M.body);
    m.position.set(3.0, CY - 1.3, side * (wingRootZ + wingSpan / 2));
    m.rotation.x = -side * 0.045; // dihedral
    g.add(m);
    // Small subtle aileron near the tip
    const ail = new THREE.Mesh(flapGeo(1.0, 0.14, 4.0), M.body);
    ail.position.set(0.5, CY - 1.35, side * (wingRootZ + wingSpan - 2));
    g.add(ail);
    // Visible flap board, inboard trailing edge -- the "airliner tell"
    const flap = new THREE.Mesh(flapGeo(1.6, 0.16, 7.6), M.body);
    flap.position.set(-1.2, CY - 1.65, side * 6.3);
    g.add(flap);
    return { ail, flap };
  };
  const wL = wingHalf(-1), wR = wingHalf(1);

  // Two large engine nacelles on pylons under the wings
  const nacelle = (side) => {
    g.add(cyl(1.4, 1.4, 5.5, 12, M.dark, 1.0, CY - 3.0, side * 11));
    g.add(cyl(1.43, 1.43, 0.7, 12, M.navy, 3.3, CY - 3.0, side * 11)); // intake lip band
    g.add(box(1.0, 0.6, 0.5, M.body, 2.3, CY - 2.1, side * 11));
  };
  nacelle(-1); nacelle(1);

  // Swept tailplane + tall fin with red accent
  const stabSpan = 8.5, stabRootZ = 1.1;
  const stabHalf = (side) => {
    const m = new THREE.Mesh(sweptPanelGeo(3.8, 1.3, stabSpan, 3.2, 0.28, side), M.body);
    m.position.set(-27.5, CY + 0.6, side * (stabRootZ + stabSpan / 2));
    g.add(m);
    const elev = new THREE.Mesh(flapGeo(1.0, 0.12, 3.5), M.body);
    elev.position.set(-29.3, CY + 0.6, side * 3.0);
    g.add(elev);
    return elev;
  };
  const elevL = stabHalf(-1), elevR = stabHalf(1);

  const finHeight = 9.0;
  const fin = new THREE.Mesh(verticalPanelGeo(6.5, 2.0, finHeight, 4.0, 0.3), M.body);
  fin.position.set(-24.5, CY + 2.2 + finHeight / 2, 0);
  g.add(fin);
  g.add(box(1.1, 1.8, 0.34, M.accent, -27.0, CY + 9.5, 0)); // red fin accent
  const rudder = new THREE.Mesh(flapGeo(0.9, 4.0, 0.16), M.body);
  rudder.rotation.z = -Math.PI / 2;
  rudder.position.set(-27.5, CY + 6.0, 0.2);
  g.add(rudder);

  // Tricycle gear (retractable): nose leg folds forward, mains swing inboard.
  // Pivots sit at the leg tops; parts hang below.
  const noseLeg = legGroup(20.0, CY - 0.4, 0);
  noseLeg.add(box(0.4, 3.0, 0.4, M.dark, 0, -1.1, 0));
  noseLeg.add(wheel(0.55, 0.35, M.tire, 0, -4.8, -0.45));
  noseLeg.add(wheel(0.55, 0.35, M.tire, 0, -4.8, 0.45));
  g.add(noseLeg);

  const mainGear = (side) => {
    const l = legGroup(1.0, CY - 0.5, side * 3.3);
    l.add(box(0.4, 3.6, 0.4, M.dark, 0, -1.4, 0));
    l.add(box(2.0, 0.4, 0.7, M.dark, 0, -4.9, 0));
    l.add(wheel(0.6, 0.4, M.tire, -0.9, -5.0, 0));
    l.add(wheel(0.6, 0.4, M.tire, 0.9, -5.0, 0));
    g.add(l);
    return l;
  };
  const mainLH = mainGear(-1), mainRH = mainGear(1);
  const gear = gearRig([
    { grp: noseLeg, axis: 'z', ang: 1.55 },
    { grp: mainLH, axis: 'x', ang: -1.5 },
    { grp: mainRH, axis: 'x', ang: 1.5 },
  ]);

  const lights = navLights(g, 4.5, [
    ['red', -7.0, CY - 2.0, -31.8], ['green', -7.0, CY - 2.0, 31.8], ['white', -30.4, CY, 0],
    ['white', -28.5, CY + 11.4, 0],
    ['strobe', -7.0, CY - 2.0, -31.8], ['strobe', -7.0, CY - 2.0, 31.8], ['strobe', -30.4, CY, 0],
    ['beacon', 10.0, CY + 2.25, 0], ['beacon', 10.0, CY - 2.25, 0],
  ]);

  return {
    group: g,
    animate(controls, rpmNorm, dt, st) {
      gear(dt, st);
      lights(dt);
      // Subtle primary control deflections -- an airliner barely twitches.
      const elevDeflect = 0.12 * controls.elevator;
      elevL.rotation.z = elevDeflect;
      elevR.rotation.z = elevDeflect;
      const ael = 0.15 * controls.aileron;
      wL.ail.rotation.z = -ael;
      wR.ail.rotation.z = ael;
      rudder.rotation.y = 0.12 * controls.rudder;

      // Flap boards: the visible, airliner-selling control surface.
      const flapDeflect = 0.5 * controls.flaps;
      wL.flap.rotation.z = flapDeflect;
      wR.flap.rotation.z = flapDeflect;
    },
  };
}

// ------------------------------------------------------------------ spirit --
// B-2-silhouette flying wing, 52.4m span, built from a THREE.Shape planform.

function spirit() {
  const M = {
    body:   new THREE.MeshLambertMaterial({ color: 0x2e3136, flatShading: true }),
    dark:   new THREE.MeshLambertMaterial({ color: 0x212327, flatShading: true }),
    edge:   new THREE.MeshLambertMaterial({ color: 0x3b3f46, flatShading: true }),
    glass:  glassMat(0x181d24, { specular: 0x7f93a8, shininess: 120 }),
    tire:   new THREE.MeshLambertMaterial({ color: 0x141416, flatShading: true }),
  };

  const g = new THREE.Group();
  const halfSpan = 26.2; // 52.4m total span

  // Planform outline in (x, z): nose apex -> right leading edge -> right
  // wingtip -> inboard "W" sawtooth trailing edge -> center notch, then the
  // mirrored path back out to the left wingtip and up the left leading edge.
  const rightHalf = [
    [11, 0],
    [-1, halfSpan],
    [-3.5, halfSpan],
    [-7.5, 19],
    [-4.5, 14.5],
    [-9, 8.5],
    [-6, 4],
    [-10.5, 0],
  ];
  const mirrored = rightHalf.slice(1, 7).reverse().map(([x, z]) => [x, -z]);
  const outline = rightHalf.concat(mirrored);

  const shape = new THREE.Shape();
  shape.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], outline[i][1]);
  shape.closePath();

  // Thin main wing skin (full planform, constant thickness -- this is the
  // "tip" thickness).
  const skinThickness = 0.7;
  const skinGeo = new THREE.ExtrudeGeometry(shape, { depth: skinThickness, bevelEnabled: false });
  skinGeo.rotateX(-Math.PI / 2);
  skinGeo.translate(0, -skinThickness / 2, 0);
  g.add(new THREE.Mesh(skinGeo, M.body));

  // Thicker center-body bulge stacked on top, standing in for the weapons
  // bay / engine deck (root thickness ~3.2m vs the 0.7m tip skin).
  const bulgeShape = new THREE.Shape();
  const bulgeOutline = [[9, 0], [5, 5], [-3, 5.5], [-6, 0], [-3, -5.5], [5, -5]];
  bulgeShape.moveTo(bulgeOutline[0][0], bulgeOutline[0][1]);
  for (let i = 1; i < bulgeOutline.length; i++) bulgeShape.lineTo(bulgeOutline[i][0], bulgeOutline[i][1]);
  bulgeShape.closePath();
  const bulgeThickness = 3.2;
  const bulgeGeo = new THREE.ExtrudeGeometry(bulgeShape, { depth: bulgeThickness, bevelEnabled: false });
  bulgeGeo.rotateX(-Math.PI / 2);
  bulgeGeo.translate(0, -bulgeThickness / 2, 0);
  g.add(new THREE.Mesh(bulgeGeo, M.body));

  // Slightly lighter centre-body panels so the dark skin reads in flat light
  g.add(box(5.0, 0.06, 3.4, M.edge, 1.0, 1.62, 0));
  for (const sd of [-1, 1]) g.add(box(6.0, 0.05, 0.5, M.edge, -1.0, 0.38, sd * 10));

  // Cockpit hump on top of the bulge, forward of center
  g.add(box(2.5, 0.4, 2.0, M.body, 8.0, 1.9, 0));
  g.add(box(0.8, 0.14, 1.2, M.glass, 9.4, 1.95, 0)); // tiny windscreen strip

  // Darker engine intake humps on top, symmetric either side of center
  g.add(box(1.8, 0.28, 1.6, M.dark, 5.0, 0.5, -4));
  g.add(box(1.8, 0.28, 1.6, M.dark, 5.0, 0.5, 4));

  // Two slit exhausts near the trailing edge, top surface
  g.add(box(0.9, 0.08, 0.4, M.dark, -2.5, 0.42, -2.4));
  g.add(box(0.9, 0.08, 0.4, M.dark, -2.5, 0.42, 2.4));

  // Elevons: small trailing-edge surfaces near mid-span, mixed for pitch+roll
  const elevon = (side) => {
    const m = new THREE.Mesh(flapGeo(0.9, 0.14, 3.0), M.body);
    m.position.set(-5.6, 0, side * 13);
    g.add(m);
    return m;
  };
  const elevL = elevon(-1), elevR = elevon(1);

  // Tricycle gear (retractable); nose folds aft, mains inboard. Wheel centres
  // sit ~0.5 m above the contact points in params (y = -3.0).
  const noseLeg = legGroup(6.5, -1.4, 0);
  noseLeg.add(box(0.3, 1.7, 0.3, M.dark, 0, -0.85, 0), wheel(0.45, 0.3, M.tire, 0, -2.0, 0));
  const mainLegS = (side) => {
    const l = legGroup(-1.5, -1.4, side * 3.5);
    l.add(box(0.35, 1.7, 0.35, M.dark, 0, -0.85, 0), wheel(0.55, 0.4, M.tire, 0, -2.0, 0));
    return l;
  };
  const mainLS = mainLegS(-1), mainRS = mainLegS(1);
  g.add(noseLeg, mainLS, mainRS);
  const gear = gearRig([
    { grp: noseLeg, axis: 'z', ang: -1.55 },
    { grp: mainLS, axis: 'x', ang: -1.5 },
    { grp: mainRS, axis: 'x', ang: 1.5 },
  ]);

  const lights = navLights(g, 3.5, [
    ['red', -2.0, 0.2, -26.1], ['green', -2.0, 0.2, 26.1], ['white', -10.7, 0.1, 0],
    ['strobe', -2.0, 0.2, -26.1], ['strobe', -2.0, 0.2, 26.1],
    ['beacon', 2.0, 1.75, 0], ['beacon', 2.0, -1.75, 0],
  ]);

  return {
    group: g,
    // No rudder surface at this fidelity (drag rudders would be invisible).
    animate(controls, rpmNorm, dt, st) {
      gear(dt, st);
      lights(dt);
      elevL.rotation.z = 0.3 * controls.elevator - 0.35 * controls.aileron;
      elevR.rotation.z = 0.3 * controls.elevator + 0.35 * controls.aileron;
    },
  };
}

export const MESH_BUILDERS = { c172, extra300, hornet, heavy, spirit };
