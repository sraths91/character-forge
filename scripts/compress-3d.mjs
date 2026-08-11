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
const KEEP = {
  'Knight.glb':        ['Idle', '1H_Melee_Attack_Slice_Diagonal'],
  'Barbarian.glb':     ['Idle', '2H_Melee_Attack_Chop'],
  'Mage.glb':          ['Idle', 'Spellcasting'],
  'Rogue.glb':         ['Idle', '1H_Melee_Attack_Stab'],
  // Roster additions (ranger / warlock / monk). Monk.glb is the raw Rogue
  // body kept for its Unarmed_* clips.
  'Rogue_Hooded.glb':  ['Idle', '2H_Ranged_Shoot'],                          // ranger
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
