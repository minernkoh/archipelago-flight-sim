// Airfield buildings and pavement shared by the fictional maps: concrete apron
// with a taxiway and yellow taxi markings, an arched hangar with its doors
// rolled half open, a control tower with a glazed cab, and parked aircraft.
// Visual only: nothing here touches map.height or obstacleTop.
//
// Every builder works in a local frame and returns a THREE.Group: +x along the
// runway, +z away from it (toward the apron side), y = 0 on the runway surface.

import * as THREE from 'three';

const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
const decal = (color, units = -8) => new THREE.MeshLambertMaterial({
  color, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: units,
});

function flatRect(x0, x1, z0, z1, mat, y = 0) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
  m.receiveShadow = true;
  return m;
}

/**
 * Apron + taxiway from the runway edge. Taxi line runs from the runway
 * centreline (z = 0) to the apron centre, with a hold-short marking.
 */
export function apron({ x0, x1, z0, z1, runwayHalfWidth: hw, taxiX }) {
  const g = new THREE.Group();
  const concrete = decal(0x8d8f8c, -6);
  g.add(flatRect(x0, x1, z0, z1, concrete, 0.04));
  // taxiway: 15 m wide link from the runway edge to the apron
  const tw = 7.5;
  g.add(flatRect(taxiX - tw, taxiX + tw, hw - 0.5, z0 + 1, decal(0x55585b, -6), 0.035));
  // expansion joints on the apron (thin darker lines)
  const joint = decal(0x6f716f, -10);
  for (let x = x0 + 10; x < x1; x += 10) g.add(flatRect(x - 0.08, x + 0.08, z0, z1, joint, 0.045));
  for (let z = z0 + 10; z < z1; z += 10) g.add(flatRect(x0, x1, z - 0.08, z + 0.08, joint, 0.045));
  // yellow taxi line: runway centreline curve -> taxiway -> apron lead-in
  const yellow = decal(0xe0b021, -14);
  const pts = [];
  const R = Math.max(12, hw);
  for (let i = 0; i <= 10; i++) {                     // lead-off arc from the runway centreline
    const a = (i / 10) * Math.PI / 2;
    pts.push([taxiX - R + Math.sin(a) * R, R - Math.cos(a) * R]);
  }
  pts.push([taxiX, z0 + 2], [taxiX, (z0 + z1) / 2]);
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.3), yellow);
    seg.rotation.x = -Math.PI / 2;
    seg.rotation.z = -Math.atan2(bz - az, bx - ax);
    seg.position.set((ax + bx) / 2, 0.06, (az + bz) / 2);
    g.add(seg);
  }
  // hold-short: two solid + two dashed lines across the taxiway
  const hz = hw + 12;
  for (let k = 0; k < 2; k++) g.add(flatRect(taxiX - tw, taxiX + tw, hz + k * 0.6, hz + k * 0.6 + 0.3, yellow, 0.06));
  for (let k = 0; k < 2; k++) {
    for (let x = taxiX - tw; x < taxiX + tw - 0.5; x += 1.8) {
      g.add(flatRect(x, x + 1.0, hz + 1.6 + k * 0.6, hz + 1.9 + k * 0.6, yellow, 0.06));
    }
  }
  return g;
}

/** Arched hangar, doors facing -z (toward the runway), half open. */
export function hangar({ w = 30, d = 22, h = 7, wall = 0xa3abb3, roof = 0x6e7780, trim = 0xc8372d } = {}) {
  const g = new THREE.Group();
  const wallM = lam(wall), roofM = lam(roof), dark = lam(0x1d2126), trimM = lam(trim);
  // side walls + back
  const back = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.4), wallM);
  back.position.set(0, h / 2, d / 2);
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.4, h, d), wallM);
  left.position.set(-w / 2, h / 2, 0);
  const right = left.clone(); right.position.x = w / 2;
  g.add(back, left, right);
  // arched roof: a half cylinder along z, flattened a little
  const arch = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, d + 0.6, 12, 1, true, Math.PI / 2, Math.PI), roofM);
  arch.rotation.x = Math.PI / 2;
  arch.scale.set(1, 1, 0.42);
  arch.position.set(0, h, 0);
  arch.material.side = THREE.DoubleSide;
  g.add(arch);
  // ribs over the arch
  for (let k = -2; k <= 2; k++) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(w / 2 + 0.05, 0.12, 4, 12, Math.PI), roofM);
    rib.scale.set(1, 0.42, 1);
    rib.position.set(0, h, k * d / 5);
    g.add(rib);
  }
  // gable front: arch infill above the door, door panels (two open, dark interior)
  const gable = new THREE.Mesh(new THREE.CircleGeometry(w / 2, 12, 0, Math.PI), wallM);
  gable.scale.set(1, 0.42, 1);
  gable.position.set(0, h, -d / 2);
  gable.rotation.y = Math.PI;
  g.add(gable);
  const interior = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.5, h * 0.92), dark);
  interior.position.set(0, h * 0.46, -d / 2 + 0.3);
  interior.rotation.y = Math.PI;
  g.add(interior);
  const panelW = w / 4;
  for (const sx of [-1, 1]) {
    for (const k of [0, 1]) {               // doors stacked beside the opening
      const p = new THREE.Mesh(new THREE.BoxGeometry(panelW, h * 0.94, 0.25), wallM);
      p.position.set(sx * (w / 2 - panelW / 2 - k * 0.3), h * 0.47, -d / 2 - 0.2 - k * 0.3);
      g.add(p);
    }
  }
  const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.6, 0.3), trimM);
  band.position.set(0, h + 0.1, -d / 2 - 0.35);
  g.add(band);
  // side windows
  for (const sx of [-1, 1]) {
    for (let k = -2; k <= 2; k++) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 2.2), dark);
      win.position.set(sx * (w / 2 + 0.2), h * 0.72, k * d / 5);
      g.add(win);
    }
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/** Control tower: tapered shaft, glazed and slanted cab, roof, antenna, beacon. */
export function tower({ h = 16 } = {}) {
  const g = new THREE.Group();
  const shaftM = lam(0xc4c8cd), glassM = new THREE.MeshPhongMaterial({ color: 0x24394a, specular: 0x9fb8cc, shininess: 80 });
  const dark = lam(0x2a3038);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.0, h, 8), shaftM);
  shaft.position.y = h / 2;
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 3.2, 1.0, 8), shaftM);
  deck.position.y = h + 0.5;
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 4.0, 3.2, 8, 1, true), glassM);
  cab.position.y = h + 2.6;
  cab.material.side = THREE.DoubleSide;
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 3.0, 8), dark);
  inner.position.y = h + 2.6;
  const mull = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2 + Math.PI / 8;
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.3, 0.18), dark);
    m.position.set(Math.cos(a) * 4.45, h + 2.6, Math.sin(a) * 4.45);
    m.rotation.z = Math.cos(a) * 0.12; m.rotation.x = -Math.sin(a) * 0.12;
    mull.add(m);
  }
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 5.2, 0.7, 8), shaftM);
  roof.position.y = h + 4.55;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 4), dark);
  mast.position.set(1.5, h + 6.8, 0);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff3a2a, toneMapped: false }));
  beacon.position.set(1.5, h + 8.9, 0);
  g.add(shaft, deck, inner, cab, mull, roof, mast, beacon);
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.beacon = beacon;
  return g;
}

/** Fuel truck, for a little apron life. */
export function fuelTruck() {
  const g = new THREE.Group();
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 2.1, 2.3), lam(0xd9d9d4));
  cab.position.set(3.0, 1.45, 0);
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 4.6, 8), lam(0xd4a62a));
  tank.rotation.z = Math.PI / 2; tank.position.set(-0.6, 1.55, 0);
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.4, 2.2), lam(0x2a2d31));
  chassis.position.y = 0.6;
  g.add(cab, tank, chassis);
  for (const x of [2.8, -1.0, -2.4]) for (const z of [-1.05, 1.05]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.3, 8), lam(0x141416));
    w.rotation.x = Math.PI / 2; w.position.set(x, 0.45, z);
    g.add(w);
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}
