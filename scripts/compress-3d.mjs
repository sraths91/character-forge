/**
 * Compress the KayKit archetype GLBs for the optional 3D preview (Path B).
 *
 * The raw KayKit Adventurers GLBs are ~3.6 MB each — dominated by 76 baked
 * animation clips, of which the preview uses only two (Idle + one attack).
 * This prunes each model to the clips the viewer actually plays, then
 * Draco-compresses geometry, dropping each file ~10× so the feature ships
 * self-contained and offline-capable.
 *
 * Reproducible: point SRC at the raw GLBs and run `node scripts/compress-3d.mjs`.
 * Raw originals live in the spike scratchpad (and upstream KayKit, CC0).
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', '3d');

// Per archetype: the exact clips the viewer plays (must match three-viewer.js).
// The full per-weapon attack set shared by every KayKit Adventurers body, so
// weapon-map.js MOTION_TO_CLIP resolves a DISTINCT animation per weapon (a
// warhammer chops, a rapier stabs, a bow shoots, a staff casts) instead of
// every weapon falling back to the body's one kept clip. Every name verified
// present in all four Adventurer GLBs (76 clips upstream).
const ADVENTURER_CLIPS = [
  'Idle',
  '1H_Melee_Attack_Slice_Diagonal',   // sword-slash
  '1H_Melee_Attack_Stab',             // sword-thrust / dagger-stab
  '2H_Melee_Attack_Chop',             // axe-cleave (+ warhammer/mace via the hammer bucket)
  '2H_Melee_Attack_Stab',             // lance-thrust (spear/polearm)
  'Spellcasting',                     // staff-cast
  '1H_Ranged_Shoot',                  // bow-draw
  'Unarmed_Melee_Attack_Punch_A'      // fist-jab
];

const KEEP = {
  'Knight.glb':        ADVENTURER_CLIPS,
  'Barbarian.glb':     ADVENTURER_CLIPS,
  'Mage.glb':          ADVENTURER_CLIPS,
  'Rogue.glb':         ADVENTURER_CLIPS,
  'Rogue_Hooded.glb':  ADVENTURER_CLIPS,   // ranger — bow + melee both available now
  // Warlock (Skeletons pack, different clip set) + monk (unarmed) stay minimal.
  'Skeleton_Mage.glb': ['Idle', 'Spellcast_Shoot'],                          // warlock
  'Monk.glb':          ['Unarmed_Idle', 'Unarmed_Melee_Attack_Punch_A'],     // monk (unarmed)
};

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const mb = (n) => (n / 1e6).toFixed(2) + ' MB';

for (const [file, keep] of Object.entries(KEEP)) {
  const path = join(DIR, file);
  const before = statSync(path).size;
  const doc = await io.readBinary(readFileSync(path));

  // Idempotent: skip a file that's already been pruned to its KEEP set (so
  // re-running to add new models doesn't re-encode the committed ones).
  if (doc.getRoot().listAnimations().length <= keep.length) {
    console.log(`${file}: already lean (${mb(before)}) — skipped`);
    continue;
  }

  const keepSet = new Set(keep);
  let dropped = 0;
  for (const anim of doc.getRoot().listAnimations()) {
    if (!keepSet.has(anim.getName())) { anim.dispose(); dropped++; }
  }

  await doc.transform(
    prune(),                       // drop now-orphaned accessors/samplers
    dedup(),
    draco({ quantizePosition: 14, quantizeNormal: 10 }),
  );

  const bin = await io.writeBinary(doc);
  writeFileSync(path, bin);
  console.log(`${file}: ${mb(before)} → ${mb(bin.byteLength)}  (dropped ${dropped} clips, kept ${keep.join(', ')})`);
}
