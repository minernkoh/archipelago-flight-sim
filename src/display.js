// Colour pipeline glue for the hand-written ShaderMaterials (sky, ocean,
// clouds, weather, lights, trails).
//
// Those shaders compute the colour they want ON SCREEN. Built-in materials go
// through ACES tone mapping + sRGB encoding either in their own shader (plain
// renderer path) or in OutputPass (post FX path). A custom shader without the
// chunks skips that in the plain path but gets it in the post path — the same
// scene looked deep blue without POST FX and washed out with it.
//
// displayMatch() fixes both: it appends an exact inverse of three's ACES fit
// and the sRGB curve to the shader's result, then includes the standard
// tonemapping/colorspace chunks. Whichever path runs, the forward transform
// undoes the inverse and the pixel lands on the intended colour. Values above
// the displayable range (sun disc, lights) are carried as HDR multiples, so
// bloom still sees them.

/** Shared exposure, kept equal to renderer.toneMappingExposure (environment.js). */
export const DISPLAY = { exposure: { value: 1 } };

const GLSL = `
uniform float uDispExposure;
vec3 dmSRGBToLinear(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
// inverse of RRTAndODTFit: y = (v(v+a) - b) / (v(cv+d) + e), solved for v >= 0
vec3 dmInvFit(vec3 y){
  const float a = 0.0245786, b = 0.000090537, c = 0.983729, d = 0.4329510, e = 0.238081;
  vec3 A = 1.0 - y * c, B = a - y * d, C = -b - y * e;
  return (-B + sqrt(max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
}
// forward: scene-linear -> on-screen (three's ACESFilmic + sRGB), for
// sampling render targets (e.g. the water reflection) inside a custom shader
vec3 dmToScreen(vec3 x){
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = inM * (x * uDispExposure / 0.6);
  v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  vec3 l = clamp(outM * v, 0.0, 1.0);
  return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), l));
}
vec3 dmToScene(vec3 screen){
  // HDR headroom: anything brighter than white keeps its excess as a multiplier
  float peak = max(max(screen.r, screen.g), screen.b);
  float over = max(peak, 1.0);
  vec3 lin = clamp(dmSRGBToLinear(clamp(screen / over, 0.0, 1.0)), 0.0, 0.985);
  // inverse ACESOutputMat, inverse RRT/ODT fit, inverse ACESInputMat (three's ACESFilmic)
  const mat3 invOut = mat3(0.64303825, 0.05926869, 0.00596190, 0.31118675, 0.93143649, 0.06392902, 0.04577546, 0.00929492, 0.93011838);
  const mat3 invIn = mat3(1.76474097, -0.14702785, -0.03633683, -0.67577768, 1.16025151, -0.16243644, -0.08896329, -0.01322366, 1.19877327);
  vec3 v = dmInvFit(max(invOut * lin, 0.0));
  vec3 x = max(invIn * v, 0.0) * (0.6 / uDispExposure);
  return x * over;
}
`;

/**
 * Patch a ShaderMaterial in place so its gl_FragColor (an intended on-screen
 * colour) displays identically with and without the post-FX chain.
 */
export function displayMatch(mat) {
  mat.uniforms.uDispExposure = DISPLAY.exposure;
  let fs = mat.fragmentShader;
  const main = fs.lastIndexOf('void main');
  fs = fs.slice(0, main) + GLSL + fs.slice(main);
  const end = fs.lastIndexOf('}');
  fs = fs.slice(0, end) + `
  gl_FragColor.rgb = dmToScene(gl_FragColor.rgb);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}` + fs.slice(end + 1);
  mat.fragmentShader = fs;
  mat.toneMapped = true;
  return mat;
}

// CPU forward transform (three's ACESFilmic + sRGB encode): the on-screen
// colour a built-in material shows for a linear scene colour. Custom shaders
// fade toward displayOf(fog) so their haze meets fogged terrain seamlessly.
const IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
const enc = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
export function displayOf(color, out = color.clone()) {
  const e = DISPLAY.exposure.value / 0.6;
  const c = [color.r * e, color.g * e, color.b * e];
  const a = IN.map(r => fit(r[0] * c[0] + r[1] * c[1] + r[2] * c[2]));
  const o = OUT.map(r => Math.min(1, Math.max(0, r[0] * a[0] + r[1] * a[1] + r[2] * a[2])));
  return out.setRGB(enc(o[0]), enc(o[1]), enc(o[2]), 'srgb-linear');
}
