// Render the engine synthesiser to WAV files for listening (test/shots/*.wav).
// Same code the AudioWorklet runs, driven by scripted scenarios: a cold start
// and run-up, a throttle chop (afterfire), a spool-up, and a fly-by with
// Doppler and fore/aft directivity. Usage: node test/enginewav.mjs [id ...]
import { writeFileSync, mkdirSync } from 'node:fs';
import { EngineSynth, ENGINE_SOUNDS } from '../src/engineSynth.js';

const SR = 44100, BLOCK = 128;
const lerp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));

function render(id, secs, state) {
  const synth = new EngineSynth(SR, ENGINE_SOUNDS[id]);
  const out = new Float32Array(Math.ceil(secs * SR / BLOCK) * BLOCK);
  for (let i = 0; i < out.length; i += BLOCK) { Object.assign(synth.p, state(i / SR)); synth.render(out, BLOCK, i); }
  return out;
}

function wav(path, data) {
  let peak = 1e-6; for (const v of data) peak = Math.max(peak, Math.abs(v));
  const norm = Math.min(1, 0.89 / peak);           // normalise, never boost past the synth's own headroom by >1x
  const buf = Buffer.alloc(44 + data.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, data[i] * norm)) * 32767), 44 + i * 2);
  writeFileSync(path, buf);
  console.log(path, (data.length / SR).toFixed(1) + ' s');
}

// fly-by: straight line past the listener at `v` m/s, closest approach `d` m at t0
function flyby(t, t0, v, d) {
  const x = (t - t0) * v, r = Math.hypot(x, d);
  const vr = v * x / r;                              // + = receding
  return { dop: 340 / (340 + vr), front: -x / r, dist: r };
}

const SCENES = {
  c172: [
    ['startup-runup', 22, t => t < 2.2 ? { alive: 0, crank: 1, rpm: 180, dop: 1, gain: 1 }
      : { alive: 1, crank: 0, rpm: t < 9 ? lerp(1100, 700, (t - 2.2) / 1.5) : lerp(700, 2400, (t - 9) / 3), load: t < 9 ? 0 : t < 17 ? lerp(0, 1, (t - 9) / 2) : 0, dop: 1, gain: 1 }],
    ['cockpit-cruise', 8, t => ({ alive: 1, rpm: 2400, load: 0.75, cockpit: 1, dop: 1, gain: 1 })],
    ['flyby', 10, t => { const f = flyby(t, 5, 55, 40); return { alive: 1, rpm: 2500, load: 1, dop: f.dop, front: f.front, gain: 40 / Math.max(40, f.dist) }; }],
  ],
  extra300: [
    ['runup-chop', 12, t => ({ alive: 1, rpm: t < 2 ? 800 : t < 7 ? lerp(800, 2700, (t - 2) / 1.2) : lerp(2700, 1300, (t - 7) / 3), load: t > 2 && t < 7 ? 1 : 0, dop: 1, gain: 1 })],
    ['flyby', 9, t => { const f = flyby(t, 4.5, 90, 30); return { alive: 1, rpm: 2700, load: 1, dop: f.dop, front: f.front, gain: 30 / Math.max(30, f.dist) }; }],
  ],
  heavy: [
    ['spool-takeoff', 22, t => ({ alive: 1, n1: t < 4 ? 0.22 : lerp(0.22, 1.0, (t - 4) / 10), front: 0.3, dop: 1, gain: 1 })],
    ['flyby', 14, t => { const f = flyby(t, 7, 80, 120); return { alive: 1, n1: 0.92, dop: f.dop, front: f.front, gain: 120 / Math.max(120, f.dist) }; }],
    ['cabin', 8, () => ({ alive: 1, n1: 0.85, cockpit: 1, dop: 1, gain: 1 })],
  ],
  hornet: [
    ['afterburner-takeoff', 14, t => ({ alive: 1, n1: t < 3 ? 0.22 : lerp(0.22, 1, (t - 3) / 2.5), ab: t > 6 ? 1 : 0, front: -0.6, dop: 1, gain: 1 })],
    ['flyby', 8, t => { const f = flyby(t, 4, 200, 60); return { alive: 1, n1: 1, ab: 0, dop: f.dop, front: f.front, gain: 60 / Math.max(60, f.dist) }; }],
  ],
  spirit: [
    ['flyby', 12, t => { const f = flyby(t, 6, 150, 100); return { alive: 1, n1: 0.9, dop: f.dop, front: f.front, gain: 100 / Math.max(100, f.dist) }; }],
  ],
};

mkdirSync(new URL('./shots/', import.meta.url), { recursive: true });
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);
for (const id of ids) {
  for (const [name, secs, state] of SCENES[id] || []) {
    wav(new URL(`./shots/engine-${id}-${name}.wav`, import.meta.url).pathname, render(id, secs, state));
  }
}
