// AudioWorklet host for the engine synthesiser (engineSynth.js). The main
// thread drives it through k-rate AudioParams, so per-frame updates cost no
// messages or allocation; the voice (cylinders, blades, fan) is sent once per
// aircraft over the port.
import { EngineSynth, ENGINE_SOUNDS } from './engineSynth.js';

const PARAMS = ['rpm', 'n1', 'load', 'alive', 'crank', 'dop', 'cockpit', 'front', 'ab', 'gain', 'misfire'];

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS.map(name => ({ name, defaultValue: name === 'dop' || name === 'gain' ? 1 : 0, automationRate: 'k-rate' }));
  }
  constructor() {
    super();
    this.synth = new EngineSynth(sampleRate, ENGINE_SOUNDS.c172);
    this.port.onmessage = (e) => { if (e.data && e.data.cfg) this.synth.configure(e.data.cfg); };
  }
  process(_inputs, outputs, parameters) {
    const out = outputs[0];
    const ch = out && out[0];
    if (!ch) return true;
    const p = this.synth.p;
    for (let i = 0; i < PARAMS.length; i++) p[PARAMS[i]] = parameters[PARAMS[i]][0];
    this.synth.render(ch, ch.length, 0);
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}
registerProcessor('engine-synth', EngineProcessor);
