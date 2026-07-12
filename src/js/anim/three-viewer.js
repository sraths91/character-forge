/**
 * Optional 3D character preview (Path B, opt-in).
 *
 * Renders an animated 3D character next to the classic 2D LPC sprite so a
 * player can switch between a static pixel sprite and a moving 3D one. This
 * is PURELY ADDITIVE — the combat engine, the D&D Beyond parsing, and the
 * whole sprite path are untouched; nothing here runs unless the player picks
 * "3D". three.js and the model GLB are lazy-loaded on first use, so the 2D
 * path pays zero bytes for a feature it never touches.
 *
 * Fidelity model (honest, first-pass): a D&D character maps to the NEAREST
 * curated KayKit archetype by class — the same "nearest mesh" approach Hero
 * Forge uses. It is approximate, not the literal sheet gear. The per-item
 * faithful path (Quaternius modular parts on a universal rig) is the later
 * upgrade; the registry below is deliberately swappable.
 *
 * Assets: real CC0 art (KayKit Adventurers + weapons) under /assets/3d/.
 */

const BASE = '/assets/3d';

// KayKit archetype specs — clip names + weapon bone verified in the spike.
// Weapons attach to KayKit's sanitized 'handslot.r' → 'handslotr' hand bone.
const ARCHETYPE = {
  knight: {
    glb: 'Knight.glb', idle: 'Idle', attack: '1H_Melee_Attack_Slice_Diagonal',
    weapon: { url: 'sword_1handed.gltf', bone: 'handslotr' },
    offhand: { url: 'shield_round.gltf', bone: 'handslotl' },
    label: 'Knight'
  },
  barbarian: {
    glb: 'Barbarian.glb', idle: 'Idle', attack: '2H_Melee_Attack_Chop',
    weapon: { url: 'axe_2handed.gltf', bone: 'handslotr' },
    label: 'Barbarian'
  },
  mage: {
    glb: 'Mage.glb', idle: 'Idle', attack: 'Spellcasting',
    weapon: { url: 'staff.gltf', bone: 'handslotr' },
    label: 'Mage'
  },
  rogue: {
    glb: 'Rogue.glb', idle: 'Idle', attack: '1H_Melee_Attack_Stab',
    weapon: { url: 'dagger.gltf', bone: 'handslotr' },
    label: 'Rogue'
  }
};

// D&D class → nearest curated archetype. The honest approximate mapping.
const CLASS_TO_ARCHETYPE = {
  fighter: 'knight', paladin: 'knight', cleric: 'knight',
  barbarian: 'barbarian',
  wizard: 'mage', sorcerer: 'mage', warlock: 'mage', druid: 'mage', artificer: 'mage',
  rogue: 'rogue', ranger: 'rogue', bard: 'rogue', monk: 'rogue'
};

/** Pick the 3D archetype key for a character from its primary class. */
export function archetypeForCharacter(character) {
  const cls = (
    character?.classes?.[0]?.name ||
    character?.classes?.[0]?.definition?.name ||
    character?.class || ''
  ).toLowerCase();
  return CLASS_TO_ARCHETYPE[cls] || 'knight';
}

export function archetypeLabel(key) {
  return ARCHETYPE[key]?.label || key;
}

// Lazy module handles — three + addons load only when a viewer is created.
let THREE, GLTFLoader, DRACOLoader, OrbitControls, skeletonClone;
async function ensureThree() {
  if (THREE) return;
  THREE = await import('three');
  ({ GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js'));
  ({ DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js'));
  ({ OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js'));
  ({ clone: skeletonClone } = await import('three/examples/jsm/utils/SkeletonUtils.js'));
}

/** A GLTFLoader wired with the Draco decoder (models are Draco-compressed). */
function makeLoader() {
  const draco = new DRACOLoader();
  draco.setDecoderPath('/assets/draco/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return loader;
}

/** getObjectByName, tolerant of the dot-sanitising three does on import. */
function findBone(root, name) {
  let hit = root.getObjectByName(name);
  if (hit) return hit;
  const want = name.toLowerCase().replace(/[._]/g, '');
  root.traverse(o => { if (!hit && o.name && o.name.toLowerCase().replace(/[._]/g, '') === want) hit = o; });
  return hit;
}

function fixMaterials(root, THREE) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) { if (m?.map) m.map.colorSpace = THREE.SRGBColorSpace; if (m) m.side = THREE.FrontSide; }
  });
}

/**
 * Mount a 3D character viewer into `container`. Returns a handle with
 * `playSwing()`, `setArchetype(key)`, and `dispose()`. Async: resolves once
 * three, the model, and its weapons are loaded and the idle is playing.
 */
export async function createThreeViewer(container, { archetype = 'knight', size = 384 } = {}) {
  await ensureThree();

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;touch-action:none;';
  container.textContent = '';   // clear any "Loading…" placeholder text
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();   // transparent — sits on the app panel bg

  const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 1.4; controls.maxDistance = 8;
  controls.minPolarAngle = Math.PI * 0.15; controls.maxPolarAngle = Math.PI * 0.62;

  // Studio-ish lighting.
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x30281f, 0.9));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.3);
  key.position.set(4, 8, 6); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1; key.shadow.camera.far = 30;
  key.shadow.camera.left = -4; key.shadow.camera.right = 4;
  key.shadow.camera.top = 4; key.shadow.camera.bottom = -4;
  key.shadow.bias = -0.0005;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.6); fill.position.set(-5, 3, 4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xaad0ff, 1.1); rim.position.set(-3, 5, -6); scene.add(rim);

  // Contact shadow only (transparent ground) so the character sits on the panel.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6, 48),
    new THREE.ShadowMaterial({ opacity: 0.34 })
  );
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const gltfCache = {};
  const loader = makeLoader();
  const load = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));

  let current = null;   // { rig, mixer, idleAction, attackAction, spec }
  let raf = null, disposed = false;
  const clock = new THREE.Clock();

  function frameCharacter(rig) {
    const box = new THREE.Box3(), tmp = new THREE.Box3();
    rig.updateWorldMatrix(true, true);
    let any = false;
    rig.traverse(m => {
      if (m.isSkinnedMesh) { m.geometry.computeBoundingBox(); tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld); box.union(tmp); any = true; }
    });
    if (!any) box.expandByObject(rig);
    const s = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(s.x, s.y);
    const dist = (maxDim * 1.35) / (2 * Math.tan(camera.fov * Math.PI / 360)) * 1.12;
    camera.position.set(c.x + dist * 0.34, c.y + s.y * 0.12, c.z + dist * 0.94);
    camera.near = dist / 50; camera.far = dist * 8; camera.updateProjectionMatrix();
    controls.target.set(c.x, c.y - s.y * 0.03, c.z);
    controls.minDistance = dist * 0.55; controls.maxDistance = dist * 1.8;
    controls.update();
    // drop the contact shadow to the character's feet
    ground.position.y = box.min.y + 0.001;
  }

  async function buildArchetype(archKey) {
    const spec = ARCHETYPE[archKey] || ARCHETYPE.knight;
    const gltf = gltfCache[spec.glb] || (gltfCache[spec.glb] = await load(`${BASE}/${spec.glb}`));
    const rig = skeletonClone(gltf.scene);
    fixMaterials(rig, THREE);

    const attach = async (w) => {
      if (!w) return;
      const wg = gltfCache[w.url] || (gltfCache[w.url] = await load(`${BASE}/${w.url}`));
      const mesh = wg.scene.clone(true);
      fixMaterials(mesh, THREE);
      const bone = findBone(rig, w.bone);
      if (bone) bone.add(mesh); else rig.add(mesh);
    };
    await attach(spec.weapon);
    await attach(spec.offhand);

    const mixer = new THREE.AnimationMixer(rig);
    const clips = gltf.animations;
    const pick = (n) => clips.find(c => c.name === n) || clips.find(c => c.name.toLowerCase().includes((n || '').toLowerCase())) || clips[0];
    const idleAction = mixer.clipAction(pick(spec.idle));
    const attackAction = mixer.clipAction(pick(spec.attack));
    attackAction.loop = THREE.LoopOnce; attackAction.clampWhenFinished = true;
    idleAction.play();

    // When a swing finishes, ease back into idle.
    mixer.addEventListener('finished', (e) => {
      if (e.action === attackAction && !disposed) {
        idleAction.reset().play();
        attackAction.crossFadeTo(idleAction, 0.25, false);
      }
    });

    return { rig, mixer, idleAction, attackAction, spec };
  }

  function mount(built) {
    if (current) { scene.remove(current.rig); current.mixer.stopAllAction(); }
    current = built;
    built.rig.rotation.y = 0.32;   // slight 3/4 turn toward the viewer
    scene.add(built.rig);
    built.mixer.update(0.001);
    frameCharacter(built.rig);
  }

  function tick() {
    if (disposed) return;
    const dt = clock.getDelta();
    if (current) current.mixer.update(dt);
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }

  mount(await buildArchetype(archetype));
  raf = requestAnimationFrame(tick);

  return {
    /** Play the archetype's attack clip once, then ease back to idle. */
    playSwing() {
      if (!current || disposed) return;
      const { idleAction, attackAction } = current;
      attackAction.reset();
      attackAction.play();
      idleAction.crossFadeTo(attackAction, 0.12, false);
    },
    /** Swap to a different archetype (keeps the same scene/renderer). */
    async setArchetype(archKey) {
      if (disposed) return;
      mount(await buildArchetype(archKey));
    },
    /** Tear down: stop the loop, free GPU resources, remove the canvas. */
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    }
  };
}
