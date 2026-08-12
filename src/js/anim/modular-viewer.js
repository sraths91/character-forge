/**
 * Per-item modular 3D character viewer (Path B, Quaternius backend).
 *
 * Composes a character from the Quaternius modular set on the shared 62-joint
 * CharacterArmature rig: the sheet picks a body set (by armour/class), the
 * equipped weapon, a shield, and a class tint (see modular-loadout.js). Same
 * handle shape as the KayKit archetype viewer — { playSwing, setCharacter,
 * dispose } — so the 2D/3D toggle, ⚔ swing, and teardown are untouched.
 *
 * Proven gotchas baked in from the composition spike:
 *  - weapon scale is DERIVED from the hand-bone world scale (~100 on this
 *    ×100 armature → ~0.01), not the archetype viewer's fixed scalar;
 *  - the camera frames from SKELETON BONE positions (the ×100/bind trick makes
 *    skinned-mesh bounding boxes meaningless);
 *  - clip names carry the "CharacterArmature|" prefix (matched by substring).
 */

import { ensureThree, makeLoader, findBone, fixMaterials, makeStage } from './three-scene.js';
import { loadoutForCharacter, nodeFor } from './modular-loadout.js';

/** Normalise a node name for tolerant compare (three strips dots/underscores). */
export function sanitizeName(name) { return String(name || '').toLowerCase().replace(/[._]/g, ''); }

/** Does a mesh node belong to slot `node`? `===` or `startsWith` because a
 *  multi-primitive slot loads as a Group `Prefix_Body` over `Prefix_Body_1..N`. */
export function matchesNode(meshName, node) {
  const want = sanitizeName(node), got = sanitizeName(meshName);
  return got === want || got.startsWith(want);
}

export async function createModularViewer(container, { character = null, size = 384 } = {}) {
  const { THREE, skeletonClone } = await ensureThree();
  const { renderer, scene, camera, controls, ground } = makeStage(container, size);
  const loader = makeLoader();
  const gltfCache = {};
  const load = (url) => (gltfCache[url] ||= new Promise((res, rej) => loader.load(url, res, undefined, rej)));

  let current = null;
  let raf = null, disposed = false;
  const clock = new THREE.Clock();

  const firstSkinned = (root) => { let m = null; root.traverse(o => { if (!m && o.isSkinnedMesh) m = o; }); return m; };

  function frameFromBones(rig, skel) {
    const box = new THREE.Box3();
    rig.updateWorldMatrix(true, true);
    const p = new THREE.Vector3();
    if (skel) for (const b of skel.bones) { b.getWorldPosition(p); box.expandByPoint(p); }
    if (box.isEmpty()) box.setFromObject(rig);
    box.expandByScalar((box.getSize(new THREE.Vector3()).length() * 0.12) || 0.2);
    const s = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const dist = (Math.max(s.x, s.y) * 1.35) / (2 * Math.tan(camera.fov * Math.PI / 360)) * 1.12;
    camera.position.set(c.x + dist * 0.30, c.y + s.y * 0.10, c.z + dist * 0.95);
    camera.near = dist / 50; camera.far = dist * 8; camera.updateProjectionMatrix();
    controls.target.set(c.x, c.y - s.y * 0.02, c.z);
    controls.minDistance = dist * 0.5; controls.maxDistance = dist * 2;
    controls.update();
    ground.position.y = box.min.y;
  }

  async function build(char) {
    const lo = loadoutForCharacter(char);
    const gltf = await load(lo.base);
    const rig = skeletonClone(gltf.scene);
    fixMaterials(rig);

    const baseSkinned = firstSkinned(rig);
    const skel = baseSkinned?.skeleton;                    // the shared 62-joint skeleton
    const armatureParent = baseSkinned?.parent || rig;     // grafts sit in the ×100 armature frame
    const materials = [];
    const grafted = [];

    // Clone a donor slot mesh and REBIND it onto the shared skeleton (spike).
    const graftMesh = (src) => {
      const m = src.clone();                               // shares geometry, copies bindMatrix
      m.material = src.material.clone();                   // per-instance material (tint isolation)
      if (m.material.map) m.material.map.colorSpace = THREE.SRGBColorSpace;
      m.material.side = THREE.FrontSide;
      m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
      m.bind(skel, src.bindMatrix);                        // POSITIONAL rebind onto the base rig
      return m;
    };

    // Per-slot compose: only graft slots whose donor differs from the base
    // (a same-file slot is already in the base rig). In practice the loadout
    // only cross-donors the HEAD (helm/crown); body/legs/feet == base.
    const slots = Array.isArray(lo.slots) ? lo.slots : [];
    const overrides = slots.filter(s => s.file && s.file !== lo.base);
    const overridden = new Set(overrides.map(s => s.which));
    for (const s of overrides) {
      const donor = skeletonClone((await load(s.file)).scene);
      const t = s.tint != null ? new THREE.Color(s.tint) : null;
      let hit = false;
      donor.traverse(o => {
        if (!o.isSkinnedMesh || !matchesNode(o.name, s.node)) return;
        const m = graftMesh(o);
        if (t && s.which !== 'head') m.material.color.lerp(t, 0.5);
        armatureParent.add(m); materials.push(m.material); grafted.push(m);
        hit = true;
      });
      if (!hit) overridden.delete(s.which);                // MISS → keep the base mesh visible
    }

    // Base meshes: hide overridden slots + STRAY meshes (Adventurer Backpack,
    // Medieval Sword — not one of the 4 slots); tint the rest, skipping head.
    const prefix = lo.body?.prefix || '';
    const baseNodes = { body: nodeFor(prefix, 'body'), legs: nodeFor(prefix, 'legs'), feet: nodeFor(prefix, 'feet'), head: nodeFor(prefix, 'head') };
    const tint = new THREE.Color(lo.tint);
    rig.traverse(o => {
      if (!o.isSkinnedMesh || !o.material) return;
      let which = null;
      for (const w of ['body', 'legs', 'feet', 'head']) if (matchesNode(o.name, baseNodes[w])) { which = w; break; }
      if (which === null || overridden.has(which)) { o.visible = false; return; }   // stray or overridden → hide
      const mat = o.material.clone();
      if (which !== 'head') mat.color.lerp(tint, 0.5);
      o.material = mat;
      materials.push(mat);
    });
    rig.updateWorldMatrix(true, true);

    // Attach held items. Weapon scale is derived from the hand-bone world
    // scale so it's correct on the ×100 armature (fixed scalars blow up 100×).
    const attach = async (w) => {
      if (!w) return;
      const bone = findBone(rig, w.bone);
      if (!bone) return;
      const ws = new THREE.Vector3();
      bone.getWorldScale(ws);
      const baseScale = ws.x ? 1 / ws.x : 0.01;
      const wg = await load(w.url);
      const mesh = wg.scene.clone(true);
      fixMaterials(mesh);
      mesh.scale.setScalar(baseScale * (w.mult || 1));
      bone.add(mesh);
    };
    await attach(lo.weapon);
    await attach(lo.shield);

    const mixer = new THREE.AnimationMixer(rig);
    const clips = gltf.animations;
    const pick = (n) => clips.find(c => c.name === n)
      || clips.find(c => c.name.toLowerCase().includes((n || '').toLowerCase()))
      || clips[0];
    const idleAction = mixer.clipAction(pick(lo.clips.idle));
    const attackAction = mixer.clipAction(pick(lo.clips.attack));
    attackAction.loop = THREE.LoopOnce; attackAction.clampWhenFinished = true;
    idleAction.play();
    mixer.addEventListener('finished', (e) => {
      if (e.action === attackAction && !disposed) {
        idleAction.reset().play();
        attackAction.crossFadeTo(idleAction, 0.25, false);
      }
    });

    return { rig, mixer, idleAction, attackAction, materials, skel, grafted };
  }

  function disposeBuilt(b) {
    b.mixer.stopAllAction();
    for (const m of b.materials) m.dispose();
    b.rig.traverse(o => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
    for (const m of (b.grafted || [])) { m.geometry?.dispose?.(); m.material?.dispose?.(); }
  }

  function mount(built) {
    if (current) { scene.remove(current.rig); disposeBuilt(current); }
    current = built;
    built.rig.rotation.y = 0.3;   // slight 3/4 turn
    scene.add(built.rig);
    built.mixer.update(0.001);
    frameFromBones(built.rig, built.skel);
  }

  function tick() {
    if (disposed) return;
    if (current) current.mixer.update(clock.getDelta());
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }

  mount(await build(character));
  raf = requestAnimationFrame(tick);

  return {
    playSwing() {
      if (!current || disposed) return;
      const { idleAction, attackAction } = current;
      attackAction.reset(); attackAction.play();
      idleAction.crossFadeTo(attackAction, 0.12, false);
    },
    async setCharacter(char) {
      if (disposed) return;
      mount(await build(char));
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (current) disposeBuilt(current);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    }
  };
}
