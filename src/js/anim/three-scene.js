/**
 * Shared three.js scaffolding for the 3D character viewers.
 *
 * The archetype viewer (three-viewer.js) and the per-item modular composer
 * (modular-viewer.js) are two different build strategies over the SAME scene:
 * one lazy three import, one Draco decoder, one lighting rig, one framing
 * helper. Keeping them here means the modular backend adds a compose engine,
 * not a second renderer (CLAUDE.md: don't duplicate an engine that exists).
 *
 * three + addons load on first use, so the 2D-only path pays zero bytes.
 */

let _THREE, _GLTFLoader, _DRACOLoader, _OrbitControls, _skeletonClone;

/** Lazy-load three + addons once. Returns the module handles. */
export async function ensureThree() {
  if (!_THREE) {
    _THREE = await import('three');
    ({ GLTFLoader: _GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js'));
    ({ DRACOLoader: _DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js'));
    ({ OrbitControls: _OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js'));
    ({ clone: _skeletonClone } = await import('three/examples/jsm/utils/SkeletonUtils.js'));
  }
  return { THREE: _THREE, GLTFLoader: _GLTFLoader, DRACOLoader: _DRACOLoader, OrbitControls: _OrbitControls, skeletonClone: _skeletonClone };
}

/** A GLTFLoader wired with the hosted Draco decoder (all models are Draco). */
export function makeLoader() {
  const draco = new _DRACOLoader();
  draco.setDecoderPath('/assets/draco/');
  const loader = new _GLTFLoader();
  loader.setDRACOLoader(draco);
  return loader;
}

/** getObjectByName, tolerant of the dot/underscore sanitising three applies. */
export function findBone(root, name) {
  let hit = root.getObjectByName(name);
  if (hit) return hit;
  const want = name.toLowerCase().replace(/[._]/g, '');
  root.traverse(o => { if (!hit && o.name && o.name.toLowerCase().replace(/[._]/g, '') === want) hit = o; });
  return hit;
}

/** Shadow/culling/colour-space fixups for every mesh under a root. */
export function fixMaterials(root) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) { if (m?.map) m.map.colorSpace = _THREE.SRGBColorSpace; if (m) m.side = _THREE.FrontSide; }
  });
}

/**
 * Build a transparent-background stage sized `size`px: renderer + scene +
 * perspective camera + damped OrbitControls + a 3-point-ish light rig + a
 * contact-shadow ground. Returns the pieces; the caller owns the render loop.
 */
export function makeStage(container, size) {
  const THREE = _THREE;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;touch-action:none;';
  container.textContent = '';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 500);
  const controls = new _OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x30281f, 0.95));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.3);
  key.position.set(4, 8, 6); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 50;
  key.shadow.bias = -0.0006;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.6); fill.position.set(-5, 3, 4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xaad0ff, 1.1); rim.position.set(-3, 5, -6); scene.add(rim);

  const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.ShadowMaterial({ opacity: 0.32 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground);

  return { renderer, scene, camera, controls, ground };
}
