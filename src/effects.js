// One-shot particle effects: touchdown dust and crash burst. Pooled meshes only —
// update(dt) runs every frame (incl. under SwiftShader in tests), so no per-frame
// geometry/material allocation is allowed here.

import * as THREE from 'three';

const PUFF_COUNT = 40;   // smoke/dust/fireball — icosahedron blobs, shared geometry
const DEBRIS_COUNT = 20; // crash chunks — box geometry
const GRAVITY = 9.81;    // local copy; this file can't import physics/

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createEffects(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const puffGeo = new THREE.IcosahedronGeometry(1, 0);
  const debrisGeo = new THREE.BoxGeometry(1, 1, 1);

  const puffs = [];
  for (let i = 0; i < PUFF_COUNT; i++) {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, transparent: true, opacity: 0 });
    const mesh = new THREE.Mesh(puffGeo, mat);
    mesh.visible = false;
    group.add(mesh);
    puffs.push({
      mesh, mat, active: false, age: 0, life: 1,
      vx: 0, vy: 0, vz: 0, riseAccel: 0,
      scaleFrom: 1, scaleTo: 1, easePow: 2, opacityMax: 1,
    });
  }

  const debris = [];
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    const mat = new THREE.MeshLambertMaterial({ color: 0x2b2723, flatShading: true, transparent: true, opacity: 0 });
    const mesh = new THREE.Mesh(debrisGeo, mat);
    mesh.visible = false;
    group.add(mesh);
    debris.push({
      mesh, mat, active: false, age: 0, life: 1,
      vx: 0, vy: 0, vz: 0, spinX: 0, spinY: 0, spinZ: 0,
    });
  }

  function findFree(list) {
    for (const p of list) if (!p.active) return p;
    return null; // pool exhausted — drop the extra particle rather than steal a live one
  }

  function spawnPuff(pos, o) {
    const p = findFree(puffs);
    if (!p) return;
    p.active = true; p.age = 0; p.life = o.life;
    p.vx = o.vx; p.vy = o.vy; p.vz = o.vz; p.riseAccel = o.riseAccel;
    p.scaleFrom = o.scaleFrom; p.scaleTo = o.scaleTo;
    p.easePow = o.easePow; p.opacityMax = o.opacityMax;
    p.mesh.position.set(pos.x, pos.y, pos.z);
    p.mesh.scale.setScalar(o.scaleFrom);
    p.mesh.visible = true;
    p.mat.color.setHex(o.color);
    p.mat.opacity = o.opacityMax;
  }

  function spawnDebris(pos, o) {
    const d = findFree(debris);
    if (!d) return;
    d.active = true; d.age = 0; d.life = o.life;
    d.vx = o.vx; d.vy = o.vy; d.vz = o.vz;
    d.spinX = o.spinX; d.spinY = o.spinY; d.spinZ = o.spinZ;
    d.mesh.position.set(pos.x, pos.y, pos.z);
    d.mesh.scale.set(o.sx, o.sy, o.sz);
    d.mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    d.mesh.visible = true;
    d.mat.opacity = 1;
  }

  // 2-5 dust puffs at gear contact; size/opacity/count scale with sink rate.
  function touchdown(pos, groundSpeed = 0, sinkFpm = 0) {
    const k = clamp(sinkFpm / 600, 0.12, 1.4); // 100 fpm ~0.17, 600 fpm ~1.0 (firm arrival)
    const n = Math.round(clamp(2 + k * 2.5, 2, 5));
    const spreadV = 0.8 + k * 1.4 + groundSpeed * 0.015; // faster rollout -> wider scatter
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      spawnPuff(
        { x: pos.x + Math.cos(ang) * 0.6, y: pos.y + 0.25, z: pos.z + Math.sin(ang) * 0.6 },
        {
          color: 0xd9d6ce,
          life: 0.55 + Math.random() * 0.35, // ~0.8s avg
          scaleFrom: 0.5 + k * 0.5, scaleTo: (0.5 + k * 0.5) * 2.2,
          vx: Math.cos(ang) * spreadV, vz: Math.sin(ang) * spreadV,
          vy: 0.4 + Math.random() * 0.3, riseAccel: 0.1,
          easePow: 2, opacityMax: 0.3 + k * 0.45,
        },
      );
    }
  }

  // One-shot: debris burst + fireball flash + lingering smoke column.
  function crash(pos, vel = { x: 0, y: 0, z: 0 }) {
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    const spread = 2 + speed * 0.15;
    for (let i = 0; i < 14; i++) {
      const sz = 0.35 + Math.random() * 0.7;
      spawnDebris(
        { x: pos.x + (Math.random() - 0.5) * 1.5, y: pos.y + (Math.random() - 0.5), z: pos.z + (Math.random() - 0.5) * 1.5 },
        {
          life: 2.0 + Math.random() * 0.6,
          vx: vel.x * 0.5 + (Math.random() - 0.5) * spread,
          vy: Math.max(vel.y, 0) * 0.4 + 1 + Math.random() * 4,
          vz: vel.z * 0.5 + (Math.random() - 0.5) * spread,
          spinX: (Math.random() - 0.5) * 10, spinY: (Math.random() - 0.5) * 10, spinZ: (Math.random() - 0.5) * 10,
          sx: sz, sy: sz * (0.5 + Math.random() * 0.6), sz,
        },
      );
    }
    for (let i = 0; i < 3; i++) {
      spawnPuff(
        { x: pos.x + (Math.random() - 0.5) * 3, y: pos.y + 1 + Math.random() * 1.5, z: pos.z + (Math.random() - 0.5) * 3 },
        {
          color: i === 0 ? 0xffcf5e : 0xff6a1f,
          life: 0.45 + Math.random() * 0.2, // ~0.6s
          scaleFrom: 1.2, scaleTo: 4.5 + Math.random() * 1.5,
          vx: (Math.random() - 0.5) * 2, vy: 0.5 + Math.random(), vz: (Math.random() - 0.5) * 2,
          riseAccel: 0, easePow: 4, opacityMax: 0.95,
        },
      );
    }
    for (let i = 0; i < 4; i++) {
      const base = 1.5 + i * 0.3;
      spawnPuff(
        { x: pos.x + (Math.random() - 0.5) * 4, y: pos.y + 1 + i * 1.5, z: pos.z + (Math.random() - 0.5) * 4 },
        {
          color: 0x2a2a28,
          life: 2.4 + Math.random() * 0.8, // ~3s
          scaleFrom: base, scaleTo: base * 2.1,
          vx: (Math.random() - 0.5) * 0.6, vy: 1.2 + i * 0.3, vz: (Math.random() - 0.5) * 0.6,
          riseAccel: 0.05, easePow: 1.4, opacityMax: 0.55,
        },
      );
    }
  }

  function stepPuff(p, dt) {
    p.age += dt;
    if (p.age >= p.life) { p.active = false; p.mesh.visible = false; return; }
    const t = p.age / p.life;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += (p.vy + p.riseAccel * p.age) * dt;
    p.mesh.position.z += p.vz * dt;
    const et = 1 - Math.pow(1 - t, p.easePow); // ease-out expansion
    p.mesh.scale.setScalar(p.scaleFrom + (p.scaleTo - p.scaleFrom) * et);
    p.mat.opacity = Math.max(0, p.opacityMax * (1 - t));
  }

  function stepDebris(d, dt) {
    d.age += dt;
    if (d.age >= d.life) { d.active = false; d.mesh.visible = false; return; }
    d.vy -= GRAVITY * dt;
    d.mesh.position.x += d.vx * dt;
    d.mesh.position.y += d.vy * dt;
    d.mesh.position.z += d.vz * dt;
    d.mesh.rotation.x += d.spinX * dt;
    d.mesh.rotation.y += d.spinY * dt;
    d.mesh.rotation.z += d.spinZ * dt;
    d.mat.opacity = Math.max(0, 1 - d.age / d.life);
  }

  function update(dt) {
    for (const p of puffs) if (p.active) stepPuff(p, dt);
    for (const d of debris) if (d.active) stepDebris(d, dt);
  }

  function dispose() {
    scene.remove(group);
    puffGeo.dispose();
    debrisGeo.dispose();
    for (const p of puffs) p.mat.dispose();
    for (const d of debris) d.mat.dispose();
  }

  return { touchdown, crash, update, dispose };
}
