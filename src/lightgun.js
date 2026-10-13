// Tower light gun (v12). With your COM radio dead the tower cannot be heard,
// so it signals the clearances that matter with a light from the cab
// (atc.js LIGHT_SIGNAL): steady green = cleared for takeoff / to land, steady
// red = hold / give way and keep circling, flashing green = cleared to taxi.
// One additive sprite at the tower cab, a constant few pixels at any range
// (it has to read from a few kilometres out on final), toneMapped:false and
// driven above the bloom threshold like the other light sources.

import * as THREE from 'three';

const COLORS = { green: [0.25, 1, 0.4], red: [1, 0.15, 0.1], white: [1, 1, 1] };
const KINDS = {
  green: { col: 'green', flash: false }, flashGreen: { col: 'green', flash: true },
  red: { col: 'red', flash: false }, flashRed: { col: 'red', flash: true },
};

let _tex = null;
function glow() {
  if (_tex) return _tex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.8)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return (_tex = new THREE.CanvasTexture(c));
}

/**
 * @param {THREE.Scene} scene
 * @returns {{ setPos(x,y,z), signal(kind, t, dur?), update(t), state, dispose() }}
 */
export function createLightGun(scene) {
  const mat = new THREE.SpriteMaterial({
    map: typeof document !== 'undefined' ? glow() : null, color: 0xffffff, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, toneMapped: false, sizeAttenuation: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.018, 0.018, 1);          // screen fraction: a bright point at any range
  sprite.visible = false;
  sprite.renderOrder = 10;
  scene.add(sprite);
  let cur = null, until = 0;
  const state = { kind: null, lit: false };
  return {
    sprite,
    setPos(x, y, z) { sprite.position.set(x, y, z); },
    /** Show a signal (atc.js LIGHT_SIGNAL kind) from time t for `dur` s. */
    signal(kind, t, dur = 30) { cur = KINDS[kind] ? kind : null; until = t + dur; },
    clear() { cur = null; },
    update(t) {
      const on = !!cur && t < until;
      if (!on) cur = null;
      const k = cur ? KINDS[cur] : null;
      const lit = !!k && (!k.flash || (t * 1.5) % 1 < 0.5);   // flashing ~1.5 Hz
      if (k) { const c = COLORS[k.col]; mat.color.setRGB(c[0] * 10, c[1] * 10, c[2] * 10); }
      sprite.visible = lit;
      state.kind = cur; state.lit = lit;
    },
    get state() { return state; },
    dispose() { scene.remove(sprite); mat.dispose(); },
  };
}
