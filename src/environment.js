// Sky dome, sun light, procedural ocean, drifting low-poly clouds, blob shadow.

import * as THREE from 'three';
import { getTerrainHeight as archipelagoHeight } from './maps/archipelago.js';

export const SUN_DIR = new THREE.Vector3(-0.45, 0.52, 0.62).normalize();
const SKY_HORIZON = new THREE.Color(0xd7e3ea);
const SKY_ZENITH = new THREE.Color(0x5e8fc4);
export const FOG_COLOR = new THREE.Color(0xcfdde6);

export function createEnvironment(scene) {
  // Ground elevation source for the blob shadow. Defaults to the archipelago
  // heightfield; swap via setGround(fn) when another map is active.
  let groundFn = archipelagoHeight;

  scene.fog = new THREE.Fog(FOG_COLOR, 1400, 5200);
  scene.background = FOG_COLOR.clone();

  const hemi = new THREE.HemisphereLight(0xbcd3e8, 0x6b7a5c, 0.85);
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.9);
  sun.position.copy(SUN_DIR).multiplyScalar(1000);
  scene.add(hemi, sun, new THREE.AmbientLight(0xffffff, 0.12));

  // --- Sky dome ---
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      horizon: { value: SKY_HORIZON }, zenith: { value: SKY_ZENITH },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir=normalize(position);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vDir; uniform vec3 horizon,zenith,sunDir;
      void main(){
        float t=pow(max(vDir.y,0.0),0.55);
        vec3 c=mix(horizon,zenith,t);
        float s=max(dot(vDir,sunDir),0.0);
        c+=vec3(1.0,0.86,0.62)*pow(s,350.0)*1.4;   // disc
        c+=vec3(1.0,0.9,0.7)*pow(s,8.0)*0.12;      // glow
        gl_FragColor=vec4(c,1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 24, 12), skyMat);
  scene.add(sky);

  // --- Ocean ---
  const oceanMat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      time: { value: 0 }, sunDir: { value: SUN_DIR },
      deep: { value: new THREE.Color(0x1a4a5e) }, shallow: { value: new THREE.Color(0x2e7a80) },
      fogColor: { value: FOG_COLOR }, fogNear: { value: 1400 }, fogFar: { value: 5200 },
    },
    vertexShader: `varying vec3 vWorld;
      void main(){ vec4 w=modelMatrix*vec4(position,1.0); vWorld=w.xyz;
        gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `varying vec3 vWorld;
      uniform float time; uniform vec3 sunDir,deep,shallow,fogColor;
      uniform float fogNear,fogFar;
      void main(){
        vec2 p=vWorld.xz;
        vec3 n=normalize(vec3(
          sin(p.x*0.11+time*1.1)*0.05+sin(p.x*0.021-time*0.4)*0.09+sin((p.x+p.y)*0.05+time*0.7)*0.04,
          1.0,
          sin(p.y*0.13+time*0.9)*0.05+sin(p.y*0.017+time*0.5)*0.09));
        vec3 view=normalize(cameraPosition-vWorld);
        float fres=pow(1.0-max(dot(view,n),0.0),2.2);
        vec3 c=mix(deep,shallow,fres*0.9+0.1);
        vec3 r=reflect(-sunDir,n);
        c+=vec3(1.0,0.93,0.75)*pow(max(dot(r,view),0.0),120.0)*1.1; // glint
        c=mix(c,fogColor*0.98,fres*0.35);
        float d=distance(cameraPosition,vWorld);
        c=mix(c,fogColor,smoothstep(fogNear,fogFar,d));
        gl_FragColor=vec4(c,1.0);
      }`,
  });
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(24000, 24000, 1, 1), oceanMat);
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = 0;
  scene.add(ocean);

  // --- Clouds: clustered low-poly blobs drifting slowly ---
  const cloudMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, flatShading: true, transparent: true, opacity: 0.92,
  });
  const clouds = new THREE.Group();
  const rng = (() => { let s = 99; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  for (let i = 0; i < 42; i++) {
    const cluster = new THREE.Group();
    const nBlob = 3 + Math.floor(rng() * 4);
    for (let b = 0; b < nBlob; b++) {
      const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(30 + rng() * 45, 0), cloudMat);
      blob.position.set((rng() - 0.5) * 160, (rng() - 0.5) * 22, (rng() - 0.5) * 90);
      blob.scale.y = 0.45;
      cluster.add(blob);
    }
    cluster.position.set((rng() - 0.5) * 9000, 380 + rng() * 550, (rng() - 0.5) * 9000);
    clouds.add(cluster);
  }
  scene.add(clouds);

  // --- Blob shadow under the aircraft (no shadow maps needed) ---
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(3.1, 20),
    new THREE.MeshBasicMaterial({ color: 0x10180f, transparent: true, opacity: 0.24, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1.35, 1, 1); // wingspan-ish ellipse
  scene.add(shadow);

  return {
    // Swap the heightfield used for the blob shadow (called on map change).
    setGround(fn) { groundFn = fn; },
    update(ac, dt, elapsed) {
      oceanMat.uniforms.time.value = elapsed;
      ocean.position.x = ac.pos.x;
      ocean.position.z = ac.pos.z;
      sky.position.set(ac.pos.x, 0, ac.pos.z);

      // wrap clouds around the player
      for (const c of clouds.children) {
        c.position.x += dt * 2.2;
        if (c.position.x - ac.pos.x > 5000) c.position.x -= 10000;
        if (ac.pos.x - c.position.x > 5000) c.position.x += 10000;
        if (c.position.z - ac.pos.z > 5000) c.position.z -= 10000;
        if (ac.pos.z - c.position.z > 5000) c.position.z += 10000;
      }

      const gy = groundFn(ac.pos.x, ac.pos.z);
      shadow.position.set(ac.pos.x, Math.max(gy, 0) + 0.15, ac.pos.z);
      const agl = Math.max(ac.pos.y - gy, 0);
      const k = Math.max(0, 1 - agl / 120);
      shadow.material.opacity = 0.32 * k;
      const s = 1 + agl * 0.02;
      shadow.scale.set(s * 1.35, s, s);
      shadow.visible = k > 0.01;
    },
  };
}
