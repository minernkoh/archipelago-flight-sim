// Landing gear + airframe ground interaction.
// Gear points act as spring-dampers with tire friction; airframe probe points
// turn contact into a crash. Geometry lives on the aircraft params (ac.p.gear /
// ac.p.probes) so tricycles, taildraggers and heavies all use the same code.

import { v3, vAdd, vScale, vCross, qRot, qRotInv, clamp } from './vecmath.js';

const MU_ROLL = 0.02, MU_BRAKE = 0.5, MU_SIDE = 0.75;
const HARD_LANDING = 2.0;           // m/s — survivable but rated "hard"

export function gearForces(ac, controls, env, dt) {
  let force = v3(), momentBody = v3(), contacts = 0, crash = '';
  const p = ac.p;

  const gs = Math.hypot(ac.vel.x, ac.vel.z);
  const steerFade = clamp(1 - gs / 28, 0.12, 1);
  const maxSteer = p.maxSteer ?? 0.38;
  const crashSink = p.crashSink ?? 3.6;
  const massScale = p.mass / 1100;         // friction slopes tuned on the C172
  const maxN = 8 * p.mass * 9.81;

  ac._airTime = ac._airTime ?? 10;

  for (const g of p.gear) {
    const rW = qRot(ac.q, g.r);
    const pW = vAdd(ac.pos, rW);
    const groundY = env.groundHeight(pW.x, pW.z);
    const pen = groundY - pW.y;
    if (pen <= 0) continue;
    contacts++;

    // Point velocity = v_cg + omega_world x r
    const omegaW = qRot(ac.q, ac.omega);
    const vP = vAdd(ac.vel, vCross(omegaW, rW));

    // Normal (vertical spring-damper; terrain is locally flat enough)
    let N = g.k * pen + g.c * -vP.y;
    N = clamp(N, 0, maxN);

    // Touchdown event: first gear contact after real airtime
    if (ac._airTime > 0.5 && !ac.touchdown) {
      const sink = -vP.y;
      ac.touchdown = {
        fpm: Math.round(sink * 196.85),
        speedKt: Math.round(gs * 1.94384),
        onRunway: env.isRunway(pW.x, pW.z),
        hard: sink > HARD_LANDING,
      };
      if (sink > crashSink) crash = 'hard impact';
    }

    // Tire frame on the ground plane. Steered wheels yaw their roll direction;
    // g.steer is a SIGNED gain (+1 nosewheel, -1 tailwheel: an aft wheel must
    // deflect the other way to yaw the nose the same way).
    const steerAngle = controls.rudder * maxSteer * steerFade * (g.steer || 0);
    let fwd = qRot(ac.q, g.steer
      ? v3(Math.cos(steerAngle), 0, Math.sin(steerAngle))
      : v3(1, 0, 0));
    fwd.y = 0;
    const fl = Math.hypot(fwd.x, fwd.z) || 1;
    fwd = vScale(fwd, 1 / fl);
    const side = v3(-fwd.z, 0, fwd.x);

    const vLong = vP.x * fwd.x + vP.z * fwd.z;
    const vLat = vP.x * side.x + vP.z * side.z;

    // Viscous below saturation (kills jitter at rest), Coulomb-capped above.
    const braking = g.brake && controls.brakes;
    const muLong = braking ? MU_BRAKE : MU_ROLL;
    const slopeLong = (braking ? 900 : 30) * massScale;
    const fLong = -clamp(slopeLong * vLong, -muLong * N, muLong * N);
    const fLat = -clamp(4000 * massScale * vLat, -MU_SIDE * N, MU_SIDE * N);

    const F = v3(
      fwd.x * fLong + side.x * fLat,
      N,
      fwd.z * fLong + side.z * fLat,
    );
    force = vAdd(force, F);
    momentBody = vAdd(momentBody, qRotInv(ac.q, vCross(rW, F)));
  }

  // Airframe probes — touching ground with anything but the wheels
  for (const pr of p.probes) {
    const pW = vAdd(ac.pos, qRot(ac.q, pr.r));
    if (env.groundHeight(pW.x, pW.z) - pW.y > 0.05) { crash = crash || pr.name; break; }
  }

  if (contacts > 0) {
    ac._airTime = 0;
  } else {
    ac._airTime += dt;
    if (ac._airTime > 0.6) ac.touchdown = null; // airborne again — arm for next landing
  }

  return { force, momentBody, contacts, crash };
}
