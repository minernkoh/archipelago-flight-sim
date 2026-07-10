// Stylized Singapore landmarks — low-poly primitive groups in the game's
// flat-shaded style. Each builder adds meshes to a group and registers solid
// obstacle boxes via reg(x0, x1, z0, z1, topY) so towers are crash-able.
// This is a 1:2-scale tribute, not survey data.

import * as THREE from 'three';

const lam = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });

const M = {
  concrete: lam(0xb9bdc1), glassDark: lam(0x3a4a58), glassBlue: lam(0x5b7d94),
  glassTeal: lam(0x4d7a72), white: lam(0xe8e6df), sand: lam(0xcfc5a8),
  redRoof: lam(0x8a4a3a), dark: lam(0x2c2f33), crane: lam(0xc2483a),
  hull: lam(0x54382e), hull2: lam(0x3a4a63), deck: lam(0x8b93a0),
};

// Night window glow: baked as material emissive on the shared building
// materials (one glow per building type), NEVER per-window point lights. The
// glass towers glow warm; concrete/decks get a fainter cool wash.
const WARM = new THREE.Color(0xffcf87), COOL = new THREE.Color(0x8fb4d6), BLACK = new THREE.Color(0x000000);
const WARM_MATS = [M.glassDark, M.glassBlue, M.glassTeal];
const COOL_MATS = [M.concrete, M.white, M.deck];
export function setNightGlow(on) {
  for (const m of WARM_MATS) { m.emissive.copy(on ? WARM : BLACK); m.emissiveIntensity = on ? 0.42 : 0; }
  for (const m of COOL_MATS) { m.emissive.copy(on ? COOL : BLACK); m.emissiveIntensity = on ? 0.16 : 0; }
}

// A red obstruction beacon (aviation warning light) atop a tall tower. Hidden
// by default; the environment shows + blinks it at night. Returns the mesh so
// createScenery can collect it into scenery.userData.beacons.
export function addBeacon(g, x, y, z) {
  const b = new THREE.Mesh(
    new THREE.SphereGeometry(2.2, 6, 5),
    new THREE.MeshLambertMaterial({ color: 0x300806, emissive: 0xff3020, emissiveIntensity: 1 }),
  );
  b.position.set(x, y, z);
  b.visible = false;
  g.add(b);
  return b;
}

function box(g, mat, w, h, d, x, y, z, ry = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  if (ry) m.rotation.y = ry;
  g.add(m);
  return m;
}

// --- Marina Bay Sands: three 200 m towers + skypark slab ---
export function addMBS(g, reg, cx, cz, groundY) {
  const H = 200, spacing = 90;
  for (let i = -1; i <= 1; i++) {
    const x = cx + i * spacing;
    // each tower: two leaning slabs meeting at the top
    const t = box(g, M.glassTeal, 42, H, 24, x, groundY + H / 2, cz);
    t.geometry = new THREE.BoxGeometry(42, H, 24);
    const lean = new THREE.Mesh(new THREE.BoxGeometry(30, H * 0.62, 22), M.glassDark);
    lean.position.set(x, groundY + H * 0.31, cz + 26);
    lean.rotation.x = -0.18;
    g.add(lean);
    reg(x - 26, x + 26, cz - 30, cz + 30, groundY + H);
  }
  // skypark: 340 m slab across all three, prow overhanging north
  const park = box(g, M.white, spacing * 2 + 150, 12, 44, cx - 20, groundY + H + 8, cz);
  park.geometry.translate(0, 0, 0);
  reg(cx - spacing - 95, cx + spacing + 55, cz - 22, cz + 22, groundY + H + 16);
  box(g, lam(0x6f9e5a), spacing * 2 + 120, 3, 30, cx - 20, groundY + H + 15, cz); // gardens on top
}

// --- Singapore Flyer: observation wheel ---
export function addFlyer(g, reg, cx, cz, groundY) {
  const R = 68, hub = groundY + R + 12;
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(R, 3.2, 8, 40), M.concrete);
  wheel.position.set(cx, hub, cz);
  wheel.rotation.y = Math.PI / 2 - 0.4;
  g.add(wheel);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, R * 2 - 4), M.concrete);
    spoke.position.set(cx, hub, cz);
    spoke.rotation.set(a, -0.4, 0, 'YXZ');
    spoke.rotation.z = 0; spoke.rotation.x = a;
    spoke.rotation.y = Math.PI / 2 - 0.4;
    // simpler: orient spokes in the wheel plane
    spoke.rotation.set(0, Math.PI / 2 - 0.4, a);
    g.add(spoke);
  }
  box(g, M.dark, 10, hub - groundY, 10, cx + 18, groundY + (hub - groundY) / 2, cz + 6, 0.4);
  box(g, M.dark, 10, hub - groundY, 10, cx - 18, groundY + (hub - groundY) / 2, cz - 6, 0.4);
  reg(cx - R, cx + R, cz - 24, cz + 24, hub + R + 6);
}

// --- Esplanade: the two spiky domes (durians), simplified to faceted half-spheres ---
export function addEsplanade(g, reg, cx, cz, groundY) {
  for (const dx of [-30, 30]) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(26, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.glassDark);
    dome.position.set(cx + dx, groundY + 6, cz);
    g.add(dome);
  }
  box(g, M.concrete, 130, 8, 60, cx, groundY + 4, cz);
  reg(cx - 65, cx + 65, cz - 32, cz + 32, groundY + 34);
}

// --- CBD tower cluster ---
export function addCBD(g, reg, cx, cz, groundY, rng) {
  const mats = [M.glassDark, M.glassBlue, M.glassTeal, M.concrete, M.white];
  for (let i = 0; i < 19; i++) {
    const a = rng() * Math.PI * 2, r = 90 + rng() * 460;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r * 0.7;
    const h = 110 + rng() * 170;
    const w = 26 + rng() * 26, d = 26 + rng() * 26;
    box(g, mats[(rng() * mats.length) | 0], w, h, d, x, groundY + h / 2, z, rng() * 0.8);
    if (rng() > 0.6) box(g, M.concrete, w * 0.55, 14, d * 0.55, x, groundY + h + 7, z); // crown
    reg(x - w * 0.75, x + w * 0.75, z - d * 0.75, z + d * 0.75, groundY + h + 14);
  }
}

// --- HDB estate: rows of pastel slab blocks (one coarse obstacle per estate) ---
const HDB_COLORS = [0xd8cfc4, 0xcfd8cf, 0xd7ccd8, 0xd8d5c4, 0xc4ccd8];
export function addHDBEstate(g, reg, cx, cz, groundY, rng) {
  const rows = 3 + (rng() * 3 | 0), cols = 4 + (rng() * 4 | 0);
  const mat = lam(HDB_COLORS[(rng() * HDB_COLORS.length) | 0]);
  const ry = rng() * Math.PI;
  const est = new THREE.Group();
  let maxH = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = 34 + rng() * 14;
      maxH = Math.max(maxH, h);
      const b = new THREE.Mesh(new THREE.BoxGeometry(64, h, 14), mat);
      b.position.set((c - cols / 2) * 90, h / 2, (r - rows / 2) * 60);
      est.add(b);
    }
  }
  est.position.set(cx, groundY, cz);
  est.rotation.y = ry;
  g.add(est);
  const span = Math.max(cols * 90, rows * 60) * 0.72;
  reg(cx - span, cx + span, cz - span, cz + span, groundY + maxH);
}

// --- Port: gantry cranes + container stacks ---
export function addPort(g, reg, cx, cz, groundY, rng) {
  for (let i = 0; i < 6; i++) {
    const x = cx + i * 110;
    box(g, M.crane, 8, 70, 8, x - 25, groundY + 35, cz);
    box(g, M.crane, 8, 70, 8, x + 25, groundY + 35, cz);
    box(g, M.crane, 96, 7, 9, x, groundY + 72, cz - 18); // boom over the water
    reg(x - 50, x + 50, cz - 60, cz + 12, groundY + 76);
  }
  const cMats = [M.crane, M.glassBlue, M.glassTeal, M.white];
  for (let i = 0; i < 40; i++) {
    const x = cx + rng() * 640, z = cz + 40 + rng() * 120;
    box(g, cMats[(rng() * 4) | 0], 24, 8 + rng() * 14, 10, x, groundY + 6, z, (rng() > 0.5 ? 0 : Math.PI / 2));
  }
}

// --- Anchored ships in the strait (the classic Singapore horizon) ---
export function addShips(g, reg, rng, seaLaneY, lanes) {
  for (const [cx, cz, n] of lanes) {
    for (let i = 0; i < n; i++) {
      const x = cx + (rng() - 0.5) * 1600, z = cz + (rng() - 0.5) * 700;
      const L = 90 + rng() * 130, hullMat = rng() > 0.5 ? M.hull : M.hull2;
      const ry = rng() * 0.6 - 0.3;
      box(g, hullMat, L, 14, 22, x, seaLaneY + 5, z, ry);
      box(g, M.white, 16, 18, 18, x - L * 0.36 * Math.cos(ry), seaLaneY + 21, z + L * 0.36 * Math.sin(ry), ry);
      if (rng() > 0.4) for (let s = 0; s < 4; s++)
        box(g, [M.crane, M.glassBlue, M.glassTeal, M.deck][(rng() * 4) | 0], 18, 6, 16,
          x + (s - 1.5) * L * 0.18 * Math.cos(ry), seaLaneY + 17, z - (s - 1.5) * L * 0.18 * Math.sin(ry), ry);
      // ships are low over water — no obstacle registration needed except hulls near the low gate
      reg(x - L / 2, x + L / 2, z - 14, z + 14, seaLaneY + 28);
    }
  }
}

// --- Changi: terminals + tower next to the runways ---
export function addChangi(g, reg, groundY, runwayDir) {
  // terminals west of 02L, aligned with the runway heading
  const ry = Math.atan2(-runwayDir.z, runwayDir.x) + Math.PI / 2;
  box(g, M.white, 420, 22, 90, -520, groundY + 11, 640, ry);
  box(g, M.glassDark, 420, 10, 60, -520, groundY + 27, 640, ry);
  box(g, M.white, 300, 20, 70, -760, groundY + 10, 190, ry);
  reg(-740, -300, 480, 800, groundY + 37);
  reg(-920, -600, 60, 330, groundY + 30);
  // control tower (Changi's is iconic and 80 m)
  box(g, M.concrete, 9, 78, 9, -260, groundY + 39, 330);
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(14, 10, 16, 10), M.glassDark);
  cab.position.set(-260, groundY + 86, 330);
  g.add(cab);
  reg(-280, -240, 310, 350, groundY + 96);
}
