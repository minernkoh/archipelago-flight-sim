// 3D cockpit interiors. Built in the aircraft BODY frame around the pilot's
// eye (catalog camera.cockpit.fwd/up), so the whole interior banks, pitches
// and shakes with the airframe while the camera's head motion (camera.js)
// gives real parallax against it. main.js shows it in COCKPIT view and hides
// only the exterior HULL meshes, so wings, struts, props and engines stay in
// view through the glass.
//
// Styles (catalog camera.cockpit.frame):
//   cabin    — high-wing light aircraft: steam six-pack, twin yokes, headliner,
//              door frames, A-pillars, wet compass
//   canopy   — bubble canopy: compact panel, centre stick, canopy bow + rails
//              (steam gauges, or glass displays for jets via `glass: true`)
//   airliner — wide glass panel (PFD/ND/EICAS/PFD), glareshield with MCP,
//              window posts, overhead panel, pedestal with thrust levers
//
// Instruments are a CanvasTexture redrawn ~15 times a second (instruments.js)
// and also used as the emissive map, so they glow at night like backlighting.

import * as THREE from 'three';
import { drawSteamPanel, drawGlassPanel } from './instruments.js';

const std = (color, roughness = 0.75, metalness = 0.05) => new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: 0.35 });

function box(parent, mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}
function rodBetween(parent, mat, a, b, r) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, A.distanceTo(B), 8), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.sub(A).normalize());
  parent.add(m);
  return m;
}

// Instrument panel face: a plane facing the pilot (-x), tilted back, carrying
// the live canvas. Returns the mesh and the redraw hook.
function panelFace(parent, { w, h, x, y, tilt = 0.2, cw, ch, draw }) {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let tex = null;
  if (canvas) {
    canvas.width = cw; canvas.height = ch;
    tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
  }
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.12,
    roughness: 0.35, metalness: 0.0,
  });
  const geo = new THREE.PlaneGeometry(w, h);
  geo.rotateY(-Math.PI / 2);                 // face -x (toward the pilot)
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, 0);
  m.rotation.z = -tilt;                      // top leans away
  parent.add(m);
  const ctx = canvas ? canvas.getContext('2d') : null;
  const face = {
    mesh: m, mat, cw, ch, hits: [],
    redraw(ac) { if (!ctx) return; face.hits = draw(ctx, cw, ch, ac) || []; tex.needsUpdate = true; },
    /** Button under a texture coordinate (canvas y runs down, uv.y up). */
    pick(uv) {
      const px = uv.x * cw, py = (1 - uv.y) * ch;
      const h = face.hits.find(r => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
      return h ? h.id : null;
    },
  };
  return face;
}

// A row of labelled push-buttons / switches on one canvas-textured plane (one
// draw call). Clicks are hit-tested by the texture coordinate of the ray hit,
// so the buttons need no geometry of their own. orient 'front' faces the
// pilot (-x), 'up' lies on a console top with its labels reading forward.
function buttonStrip(parent, { buttons, w, h, x, y, z = 0, tilt = 0, orient = 'front' }) {
  const n = buttons.length, cw = 128 * n, ch = 96;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let tex = null, ctx = null;
  if (canvas) {
    canvas.width = cw; canvas.height = ch; ctx = canvas.getContext('2d');
    tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, emissive: 0xffffff, emissiveMap: tex,
    emissiveIntensity: 0.25, roughness: 0.5, metalness: 0 });
  const geo = new THREE.PlaneGeometry(w, h);
  if (orient === 'up') { geo.rotateX(-Math.PI / 2); geo.rotateY(-Math.PI / 2); } else geo.rotateY(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  if (orient === 'front') mesh.rotation.z = -tilt;
  parent.add(mesh);
  let key = '';
  return {
    mesh, mat, buttons,
    /** states: { [id]: false | true | 'text' } (true = lit, a string relabels it) */
    draw(states) {
      const k = buttons.map(b => String(states[b.id])).join('|');
      if (!ctx || k === key) return;
      key = k;
      ctx.fillStyle = '#17191c'; ctx.fillRect(0, 0, cw, ch);
      buttons.forEach((b, i) => {
        const st = states[b.id], lit = !!st, X = i * 128;
        ctx.fillStyle = '#2b2f35'; ctx.fillRect(X + 8, 10, 112, 76);
        ctx.fillStyle = '#3a3f46'; ctx.fillRect(X + 8, 10, 112, 6);
        // annunciator bar: green when engaged / on
        ctx.fillStyle = lit ? '#38e070' : '#0d2a16'; ctx.fillRect(X + 30, 20, 68, 9);
        ctx.fillStyle = '#e8e8e2'; ctx.font = 'bold 26px "B612", Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(typeof st === 'string' ? st : b.label, X + 64, 60);
      });
      tex.needsUpdate = true;
    },
    pick(uv) { const i = Math.floor(uv.x * n); return buttons[Math.max(0, Math.min(n - 1, i))].id; },
  };
}

const AP_BUTTONS = [
  { id: 'ap', label: 'AP' }, { id: 'ap-hdg', label: 'HDG' }, { id: 'ap-alt', label: 'ALT' },
  { id: 'ap-ias', label: 'IAS' }, { id: 'ap-nav', label: 'NAV' }, { id: 'ap-apr', label: 'APR' },
  // selector knobs: heading bug and selected altitude
  { id: 'hdg-dn', label: 'HDG−' }, { id: 'hdg-up', label: 'HDG+' }, { id: 'alt-dn', label: 'ALT−' }, { id: 'alt-up', label: 'ALT+' },
];

function yoke(parent, mat, grip, z, x, y) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.34, 8), std(0x8a8d92, 0.35, 0.8));
  shaft.rotation.z = Math.PI / 2; shaft.position.x = 0.17;
  g.add(shaft);
  const wheel = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.3), mat);
  wheel.add(bar);
  for (const s of [-1, 1]) {
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.13, 8), grip);
    h.position.set(-0.01, 0.05, s * 0.15);
    wheel.add(h);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), mat);
  hub.rotation.z = Math.PI / 2;
  wheel.add(hub);
  g.add(wheel);
  parent.add(g);
  return { g, wheel, x0: x };
}

/**
 * @param {object} cfg catalog camera config ({ cockpit: { fwd, up, frame, glass } })
 * @param {object} hud catalog hud config (asiMaxKt)
 */
export function createCockpit(cfg, hud, p = null) {
  const style = cfg?.cockpit?.frame || 'cabin';
  const glass = !!cfg?.cockpit?.glass || style === 'airliner';
  const group = new THREE.Group();          // follows the aircraft transform
  const eye = new THREE.Group();            // origin at the pilot's eye
  eye.position.set(cfg?.cockpit?.fwd ?? 0.5, cfg?.cockpit?.up ?? 0.4, 0);
  group.add(eye);

  const dark = std(0x24272b, 0.85), darker = std(0x16181b, 0.9), trim = std(0x3a3e44, 0.6, 0.2);
  const yokeM = std(0x1b1c1e, 0.5, 0.1), grip = std(0x101112, 0.7);
  let panel = null, yokes = [], stick = null, throttles = [], compass = null;
  // clickable switch rows (v12): systems on the left, autopilot on the right
  const sysButtons = [
    ...(p?.startup ? [{ id: 'bat', label: 'BAT' }, { id: 'mags', label: 'MAGS' }, { id: 'start', label: 'START' }, { id: 'mix', label: 'MIX' }] : []),
    { id: 'flap-up', label: 'FLAP ▲' }, { id: 'flap-dn', label: 'FLAP ▼' },
    // circuit breakers (lit = in): avionics bus, autopilot, flap motor
    ...(glass ? [] : [{ id: 'cb-avn', label: 'CB AVN' }, { id: 'cb-ap', label: 'CB AP' }, { id: 'cb-flap', label: 'CB FLP' }]),
  ];
  const strips = [];
  // switch rows drawn INTO the instrument panel canvas (instruments.js), so
  // they are always in view: cockpit free-look springs back on release
  const ui = { sys: sysButtons, ap: AP_BUTTONS, states: {}, radio: null };

  if (style === 'cabin') {
    const head = std(0xbdb6a8, 0.95), wall = std(0x6e6a62, 0.9);
    panel = panelFace(eye, {
      w: 1.1, h: 0.36, x: 0.74, y: -0.34, tilt: 0.15, cw: 1152, ch: 378,
      draw: (x, W, H, ac) => drawSteamPanel(x, W, H, ac, hud, ui),
    });
    box(eye, darker, 0.32, 0.42, 1.22, 0.93, -0.34, 0);                       // panel housing
    box(eye, dark, 0.26, 0.035, 1.24, 0.84, -0.125, 0, 0, 0, 0.06);          // glareshield
    rodBetween(eye, darker, [0.71, -0.142, -0.62], [0.71, -0.142, 0.62], 0.02); // padded lip
    box(eye, dark, 0.3, 0.2, 1.22, 0.72, -0.62, 0);                          // lower panel
    for (const s of [-1, 1]) {
      rodBetween(eye, trim, [0.9, -0.14, s * 0.6], [0.4, 0.36, s * 0.63], 0.025);   // A-pillars
      box(eye, wall, 1.8, 0.62, 0.04, 0.0, -0.5, s * 0.66);                   // door panel below the sill
      box(eye, trim, 1.8, 0.05, 0.08, 0.0, -0.18, s * 0.64);                  // sill / armrest
      rodBetween(eye, trim, [-0.32, -0.18, s * 0.64], [-0.36, 0.37, s * 0.62], 0.022); // door post
    }
    box(eye, head, 1.4, 0.03, 1.32, -0.28, 0.39, 0);                          // headliner
    box(eye, dark, 0.06, 0.05, 1.3, 0.42, 0.37, 0);                           // windshield header
    // wet compass on the glareshield centre
    compass = new THREE.Group();
    compass.position.set(0.82, -0.08, 0);
    compass.add(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.08), darker));
    const card = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.035, 12), std(0xe8e2cf, 0.6));
    card.rotation.z = Math.PI / 2; card.position.x = -0.03;
    compass.add(card);
    eye.add(compass);
    yokes = [yoke(eye, yokeM, grip, -0.32, 0.46, -0.5), yoke(eye, yokeM, grip, 0.32, 0.46, -0.5)];
    // throttle plunger, mixture next to it
    for (const [z, col] of [[0.0, 0x151515], [0.08, 0xb8372e]]) {
      const t = new THREE.Group();
      t.position.set(0.62, -0.56, z);
      const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.14, 6), std(0x9a9da2, 0.3, 0.8));
      sh.rotation.z = Math.PI / 2; sh.position.x = 0.07;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), std(col, 0.5));
      t.add(sh, knob);
      eye.add(t);
      throttles.push({ t, x0: 0.58, travel: z === 0 ? 0.08 : 0 });
    }
  } else if (style === 'canopy') {
    panel = panelFace(eye, glass
      ? { w: 0.72, h: 0.24, x: 0.56, y: -0.25, tilt: 0.25, cw: 1152, ch: 384, draw: (x, W, H, ac) => drawGlassPanel(x, W, H, ac, 'fighter', ui) }
      : { w: 0.66, h: 0.24, x: 0.54, y: -0.25, tilt: 0.25, cw: 1152, ch: 420, draw: (x, W, H, ac) => drawSteamPanel(x, W, H, ac, hud, ui) });
    box(eye, darker, 0.26, 0.3, 0.8, 0.7, -0.26, 0);                          // panel housing
    box(eye, dark, 0.18, 0.025, 0.8, 0.66, -0.115, 0, 0, 0, 0.1);           // glareshield
    rodBetween(eye, darker, [0.57, -0.127, -0.4], [0.57, -0.127, 0.4], 0.016);
    for (const s of [-1, 1]) {
      box(eye, trim, 1.6, 0.06, 0.1, -0.1, -0.24, s * 0.43);                  // canopy rail
      box(eye, dark, 1.6, 0.4, 0.04, -0.1, -0.46, s * 0.46);                  // side console wall
    }
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.022, 6, 24, Math.PI), trim);
    bow.rotation.y = Math.PI / 2; bow.position.set(0.32, -0.24, 0);
    eye.add(bow);
    // centre stick
    stick = new THREE.Group();
    stick.position.set(0.32, -0.78, 0);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.36, 8), std(0x2a2c30, 0.6));
    col.position.y = 0.18;
    const g2 = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.022, 0.1, 10), grip);
    g2.position.y = 0.4;
    stick.add(col, g2);
    eye.add(stick);
    const t = new THREE.Group();
    t.position.set(0.0, -0.3, -0.4);
    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.04), grip);
    lever.position.y = 0.05;
    t.add(lever);
    eye.add(t);
    throttles.push({ t, x0: -0.06, travel: 0.14 });
  } else {
    // airliner
    const over = std(0x3c4148, 0.85);
    panel = panelFace(eye, {
      w: 1.92, h: 0.48, x: 0.92, y: -0.4, tilt: 0.12, cw: 1536, ch: 384,
      draw: (x, W, H, ac) => drawGlassPanel(x, W, H, ac, 'airliner'),
    });
    box(eye, darker, 0.36, 0.56, 2.0, 1.12, -0.4, 0);
    box(eye, dark, 0.42, 0.05, 2.1, 0.92, -0.14, 0, 0, 0, 0.1);              // glareshield
    box(eye, std(0x1f2226, 0.6), 0.04, 0.06, 1.0, 0.72, -0.12, 0);          // MCP face
    // MCP: the autopilot buttons along the glareshield
    strips.push(buttonStrip(eye, { buttons: [...AP_BUTTONS, ...sysButtons], w: 0.112 * (AP_BUTTONS.length + sysButtons.length), h: 0.05, x: 0.697, y: -0.12, z: 0 }));
    box(eye, over, 1.4, 0.06, 1.9, 0.0, 0.5, 0);                              // overhead
    rodBetween(eye, trim, [1.08, -0.17, 0], [0.82, 0.47, 0], 0.022);         // centre post
    for (const s of [-1, 1]) {
      rodBetween(eye, trim, [0.98, -0.17, s * 0.82], [0.62, 0.47, s * 0.9], 0.03);   // side posts
      box(eye, dark, 2.0, 0.55, 0.05, -0.1, -0.45, s * 1.02);                 // side wall
      box(eye, trim, 2.0, 0.06, 0.12, -0.1, -0.16, s * 0.98);                 // sill
    }
    box(eye, dark, 0.6, 0.32, 0.36, 0.4, -0.74, 0);                           // pedestal
    for (const z of [-0.06, 0.06]) {
      const t = new THREE.Group();
      t.position.set(0.3, -0.55, z);
      const lever = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.025), std(0x2a2c30, 0.6));
      lever.position.y = 0.07;
      const knob = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.04), std(0x101112, 0.5));
      knob.position.y = 0.15;
      t.add(lever, knob);
      eye.add(t);
      throttles.push({ t, x0: 0.24, travel: 0.16 });
    }
    yokes = [yoke(eye, yokeM, grip, -0.5, 0.6, -0.45), yoke(eye, yokeM, grip, 0.5, 0.6, -0.45)];
  }

  group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  group.visible = false;

  let redrawT = 0, night = false;
  const pickables = [...strips.map(st => st.mesh), ...(panel && style !== 'airliner' ? [panel.mesh] : [])];
  return {
    group,
    style,
    strips,
    setNight(on) {
      night = !!on;
      if (panel) panel.mat.emissiveIntensity = night ? 0.85 : 0.12;
      for (const st of strips) st.mat.emissiveIntensity = night ? 0.7 : 0.25;
    },
    /** Lit/label state for the switch rows (main.js: AP status + switch positions). */
    setUi(states, radio = null) { ui.states = states; ui.radio = radio; for (const st of strips) st.draw(states); },
    /**
     * Which cockpit control a ray hits, or null. Only the button rows are
     * clickable; the ray is tested against the live (visible) cockpit.
     */
    pick(raycaster) {
      if (!group.visible || !pickables.length) return null;
      group.updateMatrixWorld(true);
      const hit = raycaster.intersectObjects(pickables, false)[0];
      if (!hit || !hit.uv) return null;
      if (panel && hit.object === panel.mesh) { const id = panel.pick(hit.uv); return id ? { id, point: hit.point } : null; }
      const st = strips.find(s2 => s2.mesh === hit.object);
      return st ? { id: st.pick(hit.uv), point: hit.point } : null;
    },
    /** World position of a button's centre (tests and tooltips). */
    buttonWorld(id, out = new THREE.Vector3()) {
      const ph = panel?.hits.find(r => r.id === id);
      if (ph) {
        panel.mesh.geometry.computeBoundingBox();
        const bb = panel.mesh.geometry.boundingBox;
        const u = (ph.x + ph.w / 2) / panel.cw, v = 1 - (ph.y + ph.h / 2) / panel.ch;
        // panel plane: uv.x along +z, uv.y along +y (before the mesh's tilt)
        out.set((bb.min.x + bb.max.x) / 2, bb.min.y + (bb.max.y - bb.min.y) * v, bb.min.z + (bb.max.z - bb.min.z) * u);
        group.updateMatrixWorld(true);
        return panel.mesh.localToWorld(out);
      }
      for (const st of strips) {
        const i = st.buttons.findIndex(b => b.id === id);
        if (i < 0) continue;
        st.mesh.geometry.computeBoundingBox();
        const bb = st.mesh.geometry.boundingBox, n = st.buttons.length, u = (i + 0.5) / n;
        // uv.x runs along +z in strip space for both orientations
        out.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.min.z + (bb.max.z - bb.min.z) * u);
        group.updateMatrixWorld(true);
        return st.mesh.localToWorld(out);
      }
      return null;
    },
    update(ac, controls, dt) {
      group.position.set(ac.pos.x, ac.pos.y, ac.pos.z);
      group.quaternion.set(ac.q.x, ac.q.y, ac.q.z, ac.q.w);
      redrawT -= dt;
      // 15 Hz on a healthy frame rate; on a slow one, every 4th frame at most
      // (a canvas redraw + texture upload is not free on a software GPU)
      if (panel && redrawT <= 0) { redrawT = Math.max(1 / 15, dt * 4); panel.redraw(ac); }
      const e = controls.elevator || 0, a = controls.aileron || 0;
      for (const y of yokes) { y.g.position.x = y.x0 + 0.07 * e; y.wheel.rotation.x = -0.6 * a; }
      if (stick) { stick.rotation.z = -0.25 * e; stick.rotation.x = -0.25 * a; }
      for (const th of throttles) th.t.position.x = th.x0 + th.travel * (controls.throttle || 0);
      if (compass) compass.children[1].rotation.x = Math.sin(performance.now() * 0.0013) * 0.05 + (controls.rudder || 0) * 0.05;
    },
    dispose() {
      group.traverse(o => {
        o.geometry?.dispose();
        if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
      });
    },
  };
}
