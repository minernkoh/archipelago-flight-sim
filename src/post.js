// Post-processing: RenderPass -> half-res UnrealBloom -> grade/vignette/sun-flare -> OutputPass.
// The scene renders linear HDR into the composer target; OutputPass applies the
// renderer's ACES tone mapping + sRGB exactly once, so the final image matches the
// direct path. Fill-rate is the budget here, so post only runs on HIGH quality with
// the setting on, and it drops itself for the session when dynamic res is pinned
// at its floor and fps is still poor (see observeFps).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const GradeShader = {
  name: 'GradeFlareShader',
  uniforms: {
    tDiffuse: { value: null },
    sun: { value: new THREE.Vector2(0.5, 0.5) },   // sun position in UV
    flare: { value: 0 },                           // 0..1 strength (0 = off-screen / behind)
    aspect: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 sun; uniform float flare, aspect; varying vec2 vUv;
    float disc(vec2 p, vec2 c, float r, float soft){
      vec2 d=(p-c)*vec2(aspect,1.0); return 1.0-smoothstep(r*(1.0-soft), r, length(d));
    }
    void main(){
      vec3 c=texture2D(tDiffuse,vUv).rgb;
      // gentle grade (linear, pre tone map): tiny shadow lift, warm highlights
      c+=0.004*(1.0-clamp(c,0.0,1.0));
      float l=dot(c,vec3(0.2126,0.7152,0.0722));
      c*=mix(vec3(1.0),vec3(1.035,1.0,0.94),smoothstep(0.4,1.6,l));
      // ghost discs along the sun -> centre axis
      if(flare>0.001){
        vec2 ax=vec2(0.5)-sun; vec3 g=vec3(0.0);
        g+=vec3(1.0,0.8,0.55)*disc(vUv,sun+ax*0.55,0.045,0.9)*0.55;
        g+=vec3(0.6,0.85,1.0)*disc(vUv,sun+ax*0.95,0.07,0.95)*0.35;
        g+=vec3(1.0,0.7,0.5)*disc(vUv,sun+ax*1.45,0.035,0.8)*0.5;
        g+=vec3(0.7,1.0,0.8)*disc(vUv,sun+ax*1.9,0.1,0.97)*0.22;
        float ring=disc(vUv,sun+ax*1.15,0.16,0.04)-disc(vUv,sun+ax*1.15,0.145,0.04);
        g+=vec3(0.9,0.9,1.0)*max(ring,0.0)*0.18;
        c+=g*flare*0.14;
      }
      // vignette
      vec2 q=(vUv-0.5)*vec2(aspect*0.7,1.0);
      c*=1.0-0.22*smoothstep(0.25,0.85,length(q)*1.35);
      gl_FragColor=vec4(c,1.0);
    }`,
};

export function createPost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  // MSAA only where the canvas has it: main.js turns it off on software GL.
  const samples = renderer.getContext().getContextAttributes()?.antialias ? 4 : 0;
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  // Threshold is above anything diffuse: only the sun/moon disc, ocean glints and
  // emissive lights reach it. Strength stays low on purpose.
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.35, 0.55, 1.15);
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSetSize(Math.max(2, w >> 1), Math.max(2, h >> 1));   // half resolution
  composer.addPass(bloom);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());

  const sunDir = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3();
  let sunStrength = 1;
  let wanted = true, dead = false, slow = 0;

  let dirty = false;
  function applySize() {
    dirty = false;
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);
    grade.uniforms.aspect.value = window.innerWidth / window.innerHeight;
  }
  applySize();

  return {
    get active() { return wanted && !dead; },
    get disabled() { return dead; },
    setWanted(on) { wanted = !!on; },
    setSize() { dirty = true; },   // applied lazily on the next rendered frame
    // dir: unit vector toward the sun (or moon); strength scales the flare.
    setSun(dir, strength = 1) { sunDir.copy(dir); sunStrength = strength; },
    // Called once per dynamic-res window. Several consecutive slow windows at the
    // resolution floor retire post for the rest of the session.
    observeFps(fps, resScale) {
      if (dead || !wanted) return;
      slow = (resScale <= 0.6001 && fps < 30) ? slow + 1 : 0;
      if (slow >= 3) {
        dead = true;
        console.info('[post] disabled for this session: fps stayed below 30 at minimum render scale');
      }
    },
    render() {
      if (dirty) applySize();
      v.copy(sunDir).transformDirection(camera.matrixWorldInverse);
      const p = camera.projectionMatrix.elements;
      let f = 0;
      if (v.z < -0.05) {
        const nx = v.x * p[0] / -v.z, ny = v.y * p[5] / -v.z;
        grade.uniforms.sun.value.set(nx * 0.5 + 0.5, ny * 0.5 + 0.5);
        const edge = Math.max(Math.abs(nx), Math.abs(ny));
        f = Math.min(1, Math.max(0, (1.5 - edge) * 2)) * sunStrength;   // fade out past the screen edge
      }
      grade.uniforms.flare.value = f;
      composer.render();
    },
  };
}
