// Autogen city fill (v12): the stylized Singapore map placed a handful of
// estates by hand, which left the land between Changi and Marina Bay as open
// grass. This fills a map's urban land with procedurally placed buildings, the
// way the big simulators' autogen does: dense housing-board slabs and condo
// towers in the districts, low-rise blocks in the suburbs, nothing on water,
// in forest, on the airfield, under the approaches or across the race course.
//
// Every building is a box written straight into one merged, non-indexed
// geometry per material (no per-building meshes or draw calls), so a few
// thousand buildings cost a handful of draws. The materials carry the shared
// facade shader (sgLandmarks.js), so windows and their night lights come for
// free. Each building registers an obstacle box, so it is solid.

import * as THREE from 'three';

/**
 * @param {object} o
 * @param {number[]} o.bounds  [x0, x1, z0, z1] world metres to fill
 * @param {number} o.cell      grid cell (m)
 * @param {(x:number,z:number)=>number} o.ground   ground height
 * @param {(x:number,z:number)=>number} o.density  0..1 how built-up a spot is (0 = never)
 * @param {(x:number,z:number,r:number)=>boolean} o.excluded  keep-clear test (r = footprint radius)
 * @param {(x0,x1,z0,z1,top)=>void} o.reg   obstacle registry
 * @param {()=>number} o.rng
 * @param {{slab:THREE.Material[], tower:THREE.Material[], low:THREE.Material[]}} o.mats
 */
export function buildAutogen(o) {
  const buckets = new Map();                       // material -> { pos: [], nor: [] }
  const bucket = (m) => { let b = buckets.get(m); if (!b) buckets.set(m, b = { pos: [], nor: [] }); return b; };
  const pick = (arr) => arr[(o.rng() * arr.length) | 0];
  let count = 0;

  // one triangle, its normal from the (counter-clockwise from outside) winding
  function tri(m, p0, p1, p2) {
    const b = bucket(m);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const p of [p0, p1, p2]) { b.pos.push(p[0], p[1], p[2]); b.nor.push(nx, ny, nz); }
  }
  // one box: centre (x, z), base y, size w x d x h, heading a; walls + roof
  // (flat, or with `roof` a gabled one: ridge along the long axis, eaves overhanging)
  function box(m, x, y, z, w, d, h, a, roof = null) {
    const b = bucket(m), c = Math.cos(a), s = Math.sin(a);
    const P = (lx, ly, lz) => [x + lx * c - lz * s, y + ly, z + lx * s + lz * c];
    const hw = w / 2, hd = d / 2;
    const quad = (p0, p1, p2, p3, n) => {
      // counter-clockwise seen from outside (the side n points to)
      for (const p of [p0, p2, p1, p0, p3, p2]) { b.pos.push(p[0], p[1], p[2]); b.nor.push(n[0], n[1], n[2]); }
    };
    const N = (nx, nz) => [nx * c - nz * s, 0, nx * s + nz * c];
    const a0 = P(-hw, 0, -hd), a1 = P(hw, 0, -hd), a2 = P(hw, 0, hd), a3 = P(-hw, 0, hd);
    const b0 = P(-hw, h, -hd), b1 = P(hw, h, -hd), b2 = P(hw, h, hd), b3 = P(-hw, h, hd);
    quad(a0, a1, b1, b0, N(0, -1)); quad(a1, a2, b2, b1, N(1, 0));
    quad(a2, a3, b3, b2, N(0, 1)); quad(a3, a0, b0, b3, N(-1, 0));
    let top = h;
    if (!roof) quad(b0, b1, b2, b3, [0, 1, 0]);
    else {
      const rh = d * 0.42, ov = 0.7;                           // pitch ~40 deg, 0.7 m overhang
      const eL = P(-hw - ov, h - 0.3, -hd - ov), eR = P(hw + ov, h - 0.3, -hd - ov);
      const fL = P(-hw - ov, h - 0.3, hd + ov), fR = P(hw + ov, h - 0.3, hd + ov);
      const rL = P(-hw - ov, h + rh, 0), rR = P(hw + ov, h + rh, 0);
      tri(roof, eL, rL, rR); tri(roof, eL, rR, eR);            // -z slope
      tri(roof, fR, rR, rL); tri(roof, fR, rL, fL);            // +z slope
      // gable ends (the walls carried up to the ridge)
      tri(m, P(hw, h, -hd), P(hw, h + rh, 0), P(hw, h, hd));
      tri(m, P(-hw, h, hd), P(-hw, h + rh, 0), P(-hw, h, -hd));
      top = h + rh;
    }
    // obstacle: the box's axis-aligned bounds
    const ex = Math.abs(hw * c) + Math.abs(hd * s), ez = Math.abs(hw * s) + Math.abs(hd * c);
    o.reg(x - ex, x + ex, z - ez, z + ez, y + top);
    count++;
  }

  const [X0, X1, Z0, Z1] = o.bounds, C = o.cell;
  for (let gx = X0; gx < X1; gx += C) {
    for (let gz = Z0; gz < Z1; gz += C) {
      const cx = gx + C / 2, cz = gz + C / 2;
      const dens = o.density(cx, cz);
      if (dens < 0.2 || o.rng() > dens * 1.1) continue;
      // blocks in a neighbourhood share a street grid: heading from a coarse cell
      const a = Math.floor((Math.sin(Math.floor(gx / 900) * 12.9898 + Math.floor(gz / 900) * 78.233) * 43758.5453 % 1 + 1) % 1 * 4) * (Math.PI / 8)
        + (o.rng() - 0.5) * 0.06;
      if (o.mats.chalet) {
        // alpine: a few gabled chalets / farmhouses per cell
        const n = 1 + (o.rng() * (1 + dens * 3) | 0);
        for (let k = 0; k < n; k++) {
          const x = cx + (o.rng() - 0.5) * C * 0.8, z = cz + (o.rng() - 0.5) * C * 0.8;
          if (o.excluded(x, z, 14)) continue;
          const big = o.rng() < 0.25;                           // a barn or a guesthouse now and then
          box(pick(o.mats.chalet.walls), x, o.ground(x, z) - 0.6, z, (big ? 20 : 11) + o.rng() * 5, (big ? 13 : 8) + o.rng() * 3,
            (big ? 8 : 5.5) + o.rng() * 2.5, a + (o.rng() - 0.5) * 0.3, pick(o.mats.chalet.roofs));
        }
        continue;
      }
      if (dens > 0.6) {
        // dense: one or two housing-board slabs, sometimes a condo tower
        if (o.rng() < 0.22) {
          const x = cx + (o.rng() - 0.5) * C * 0.3, z = cz + (o.rng() - 0.5) * C * 0.3;
          if (o.excluded(x, z, 30)) continue;
          const w = 22 + o.rng() * 12, h = 60 + o.rng() * 70;
          box(pick(o.mats.tower), x, o.ground(x, z) - 1, z, w, w * (0.8 + o.rng() * 0.3), h, a);
        } else {
          // an estate row: two or three slabs side by side, ~46 m apart
          const n = 2 + (o.rng() < 0.45 ? 1 : 0);
          for (let k = 0; k < n; k++) {
            const off = (k - (n - 1) / 2) * 46;
            const x = cx + -Math.sin(a) * off + (o.rng() - 0.5) * 10, z = cz + Math.cos(a) * off + (o.rng() - 0.5) * 10;
            if (o.excluded(x, z, 40)) continue;
            box(pick(o.mats.slab), x, o.ground(x, z) - 1, z, 58 + o.rng() * 18, 14, 32 + o.rng() * 22, a);
          }
        }
      } else {
        // suburbs: a few low-rise blocks
        const n = 2 + (o.rng() * 3 | 0);
        for (let k = 0; k < n; k++) {
          const x = cx + (o.rng() - 0.5) * C * 0.75, z = cz + (o.rng() - 0.5) * C * 0.75;
          if (o.excluded(x, z, 16)) continue;
          box(pick(o.mats.low), x, o.ground(x, z) - 0.5, z, 14 + o.rng() * 14, 12 + o.rng() * 10, 7 + o.rng() * 12, a);
        }
      }
    }
  }

  const g = new THREE.Group();
  for (const [m, b] of buckets) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, m);
    mesh.matrixAutoUpdate = false;              // world-space vertices: the facade shader reads modelMatrix
    g.add(mesh);
  }
  g.userData.autogen = count;
  return g;
}
