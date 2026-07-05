// Low-poly flat-shaded aircraft meshes for ARCHIPELAGO v2.
// Model frame: +x forward, +y up, +z right (matches the physics body frame).
// Every builder returns { group: THREE.Group, animate(controls, rpmNorm, dt) }
// with exactly the shape of createAircraftMesh() in ../aircraft.js.
//
// controls: { elevator, aileron, rudder, throttle, flaps, brakes }
//   elevator/aileron/rudder in -1..1, throttle/flaps in 0..1, brakes boolean.
// rpmNorm: 0..1 normalized engine speed.

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

// ------------------------------------------------------------------ c172 --
// Verbatim port of createAircraftMesh() from src/aircraft.js.

function c172() {
  const M = {
    body:   new THREE.MeshLambertMaterial({ color: 0xece7d8, flatShading: true }),
    accent: new THREE.MeshLambertMaterial({ color: 0xb8372e, flatShading: true }),
    glass:  new THREE.MeshLambertMaterial({ color: 0x1d242c, flatShading: true }),
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

  // High wing, two halves with slight dihedral; ailerons hinged at trailing edge
  const wingHalf = (side) => {
    const grp = new THREE.Group();
    const w = box(1.5, 0.13, 5.3, M.body, 0, 0, side * 2.65);
    grp.add(w);
    grp.add(box(1.52, 0.14, 0.5, M.accent, 0, 0, side * 5.15)); // tip
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
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 24),
    new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
  );
  disc.rotation.y = Math.PI / 2;
  propGroup.add(disc);
  propGroup.position.set(2.78, -0.12, 0);
  g.add(propGroup);

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
      disc.visible = rpmNorm > 0.45;
      disc.material.opacity = 0.1 + 0.1 * rpmNorm;
    },
  };
}

// --------------------------------------------------------------- extra300 --
// Low-wing aerobatic single-seater, ~7m long / 8m span, taildragger gear.

function extra300() {
  const M = {
    body:   new THREE.MeshLambertMaterial({ color: 0xf4f2ea, flatShading: true }),
    accent: new THREE.MeshLambertMaterial({ color: 0xc81e1e, flatShading: true }),
    glass:  new THREE.MeshLambertMaterial({ color: 0x171b1f, flatShading: true }),
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
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.05, 24),
    new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
  );
  disc.rotation.y = Math.PI / 2;
  propGroup.add(disc);
  propGroup.position.set(2.5, -0.1, 0);
  g.add(propGroup);

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
      disc.visible = rpmNorm > 0.4;
      disc.material.opacity = 0.1 + 0.12 * rpmNorm;
    },
  };
}

// ------------------------------------------------------------------ hornet --
// Twin-engine, twin-tail fighter, ~17.6m long / ~12.4m span.

function hornet() {
  const M = {
    body:  new THREE.MeshLambertMaterial({ color: 0x8b939c, flatShading: true }),
    panel: new THREE.MeshLambertMaterial({ color: 0x767e87, flatShading: true }),
    glass: new THREE.MeshLambertMaterial({ color: 0x161a1e, flatShading: true }),
    dark:  new THREE.MeshLambertMaterial({ color: 0x2b2e32, flatShading: true }),
    tire:  new THREE.MeshLambertMaterial({ color: 0x141416, flatShading: true }),
    flame: new THREE.MeshBasicMaterial({ color: 0xffa53d, transparent: true, opacity: 0.75, depthWrite: false }),
  };

  const g = new THREE.Group();

  // Main fuselage (0.0 -> 9.0)
  g.add(box(9.0, 1.3, 1.6, M.body, 4.5, 0, 0));
  // Nose cone / radome (base 9.0, tip 11.4)
  g.add(coneX(0.35, 2.4, 10, M.body, 10.2, 0, 0));

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

  // Tricycle gear
  const noseWheelM = wheel(0.26, 0.16, M.tire, 6.0, -0.95, 0);
  g.add(noseWheelM);
  g.add(box(0.09, 0.7, 0.08, M.dark, 6.0, -0.6, 0));
  g.add(wheel(0.32, 0.2, M.tire, 2.0, -1.05, -0.9));
  g.add(wheel(0.32, 0.2, M.tire, 2.0, -1.05, 0.9));
  g.add(box(0.1, 0.75, 0.09, M.dark, 2.0, -0.65, -0.9));
  g.add(box(0.1, 0.75, 0.09, M.dark, 2.0, -0.65, 0.9));

  let abPhase = 0;
  return {
    group: g,
    animate(controls, rpmNorm, dt) {
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
    glass:  new THREE.MeshLambertMaterial({ color: 0x1b1e22, flatShading: true }),
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

  // Tricycle gear: nose leg + two main bogies (2 wheels each), ~5.5m drop
  g.add(box(0.4, 3.0, 0.4, M.dark, 20.0, CY - 1.5, 0));
  g.add(wheel(0.55, 0.35, M.tire, 20.0, CY - 5.2, -0.45));
  g.add(wheel(0.55, 0.35, M.tire, 20.0, CY - 5.2, 0.45));

  const mainGear = (side) => {
    g.add(box(0.4, 3.6, 0.4, M.dark, 1.0, CY - 1.9, side * 3.3));
    g.add(box(2.0, 0.4, 0.7, M.dark, 1.0, CY - 5.4, side * 3.3));
    g.add(wheel(0.6, 0.4, M.tire, 0.1, CY - 5.5, side * 3.3));
    g.add(wheel(0.6, 0.4, M.tire, 1.9, CY - 5.5, side * 3.3));
  };
  mainGear(-1); mainGear(1);

  return {
    group: g,
    animate(controls, rpmNorm, dt) {
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
    glass:  new THREE.MeshLambertMaterial({ color: 0x14161a, flatShading: true }),
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

  return {
    group: g,
    // No rudder surface at this fidelity (drag rudders would be invisible).
    animate(controls, rpmNorm, dt) {
      elevL.rotation.z = 0.3 * controls.elevator - 0.35 * controls.aileron;
      elevR.rotation.z = 0.3 * controls.elevator + 0.35 * controls.aileron;
    },
  };
}

export const MESH_BUILDERS = { c172, extra300, hornet, heavy, spirit };
