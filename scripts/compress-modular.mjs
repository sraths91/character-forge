/**
 * Compress the CC0 Quaternius modular parts for the per-item 3D composer.
 *
 * Sibling to compress-3d.mjs (which handles the KayKit archetypes) — do NOT
 * fold these together; the source layout, clip set, and multi-mesh rig differ.
 *
 * Every Quaternius "body" is FOUR or FIVE separate SkinnedMeshes
 * (<Name>_{Body,Head,Legs/Pants,Feet}[+Backpack / bundled Sword]) bound to ONE
 * shared 62-joint `CharacterArmature` skeleton, carrying 24 identical animation
 * clips prefixed `CharacterArmature|`. The composer plays only Idle, Sword_Slash,
 * HitRecieve and Death, so we dispose the other ~20 clips, then Draco-compress
 * geometry. Weapons are single static meshes (0 clips) — dedup + Draco only.
 *
 * CRITICAL guards:
 *   - prune() must never drop a slot mesh. We assert listMeshes().length is
 *     identical before and after the transform, and fail loudly otherwise.
 *   - Draco keeps JOINTS_0 / WEIGHTS_0 (lossless by default) so the shared-
 *     skeleton rebind still works. Verify with `gltf-transform inspect` / the
 *     project's verify probe after running.
 *
 * Reads the raw parts from the acquisition scratchpad (SRC); writes the
 * renamed, compressed GLBs into public/assets/3d/modular/ (OUT). Idempotent:
 * a re-run skips any OUT file already Draco-compressed.
 *
 *   node scripts/compress-modular.mjs   (or: npm run compress:modular)
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Raw parts live in the acquisition scratchpad (verified on disk); the
// compressed, human-named outputs are hosted under public/.
const SRC = '/private/tmp/claude-501/-Users-sraths-Desktop-windsurf-Projects-character-forge/d93f6eb6-0363-4f93-a747-241ae7cd42ad/scratchpad/modular-team/parts';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', '3d', 'modular');

// 8-body MVP set: raw poly_<id> / q_ source → human name. Excludes q_Soldier1
// (CC-BY 3.0) and Quaternius_Adventurer (byte-dup of Adventurer).
const BODIES = {
  'poly_5EGWBMpuXq.glb': 'Adventurer.glb',
  'q_Adventurer2.glb':   'Adventurer2.glb',
  'poly_y9KWOVG21R.glb': 'Medieval.glb',
  'poly_I1gTjmuK2m.glb': 'King.glb',
  'poly_7pn3R6hPvE.glb': 'Farmer.glb',
  'poly_Yg2bQZO6Hj.glb': 'Worker.glb',
  'poly_Btfn3G5Xv4.glb': 'SWAT.glb',
  'poly_3hC2i0CTuO.glb': 'SpaceSuit.glb',
};

// Weapons the composer's loadout table references (exact output names matter).
const WEAPONS = {
  'w_Sword.glb':             'sword.glb',
  'w_DoublesidedHammer.glb': 'hammer_q.glb',
  'w_Axe.glb':               'axe.glb',
  'w_Dagger.glb':            'dagger.glb',
  'w_Staff.glb':             'staff.glb',
  'w_Spear.glb':             'spear.glb',
  'w_WoodenBow.glb':         'bow_q.glb',
  'w_ShieldRound.glb':       'shield.glb',
};

// Clip suffixes kept, matched AFTER the `CharacterArmature|` prefix. Exact
// match on the suffix — a prefix test would wrongly keep Idle_Sword /
// Idle_Neutral / HitRecieve_2 alongside Idle / HitRecieve.
const KEEP_CLIPS = new Set(['Idle', 'Sword_Slash', 'Punch_Right', 'HitRecieve', 'Death']);
const clipSuffix = (name) => {
  const bar = name.lastIndexOf('|');
  return bar >= 0 ? name.slice(bar + 1) : name;
};

const DRACO_EXT = 'KHR_draco_mesh_compression';

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const mb = (n) => (n / 1e6).toFixed(2) + ' MB';

/** True if the already-hosted OUT file has been Draco-compressed by a prior run. */
async function alreadyCompressed(outPath) {
  if (!existsSync(outPath)) return false;
  const doc = await io.readBinary(readFileSync(outPath));
  return doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === DRACO_EXT);
}

/**
 * Prune (bodies only), dedup and Draco a single part.
 * @param {string} srcFile  raw filename in SRC
 * @param {string} outName  human filename in OUT
 * @param {boolean} isBody  whether to prune animation clips to KEEP_CLIPS
 */
async function process(srcFile, outName, isBody) {
  const srcPath = join(SRC, srcFile);
  const outPath = join(OUT, outName);

  if (await alreadyCompressed(outPath)) {
    console.log(`${outName}: already compressed (${mb(statSync(outPath).size)}) — skipped`);
    totalOut += statSync(outPath).size;
    return;
  }

  const before = statSync(srcPath).size;
  const doc = await io.readBinary(readFileSync(srcPath));
  const root = doc.getRoot();

  let dropped = 0;
  let kept = [];
  if (isBody) {
    for (const anim of root.listAnimations()) {
      if (KEEP_CLIPS.has(clipSuffix(anim.getName()))) kept.push(clipSuffix(anim.getName()));
      else { anim.dispose(); dropped++; }
    }
  }

  // Multi-mesh guard: capture slot-mesh count BEFORE the transform.
  const meshesBefore = root.listMeshes().length;

  await doc.transform(
    prune(),   // drop now-orphaned accessors/samplers from disposed clips
    dedup(),
    draco({ quantizePosition: 14, quantizeNormal: 10 }), // no lower — seams
  );

  // ASSERT prune() did not swallow any of the 4-5 slot SkinnedMeshes.
  const meshesAfter = root.listMeshes().length;
  if (meshesAfter !== meshesBefore) {
    throw new Error(
      `${outName}: mesh count changed ${meshesBefore} → ${meshesAfter} — prune dropped a slot mesh, aborting.`,
    );
  }

  const bin = await io.writeBinary(doc);
  writeFileSync(outPath, bin);
  totalOut += bin.byteLength;

  const clipNote = isBody
    ? `dropped ${dropped} clips, kept ${kept.join(', ')}`
    : 'no clips (weapon)';
  console.log(
    `${outName}: ${mb(before)} → ${mb(bin.byteLength)}  [${meshesAfter} mesh(es), ${clipNote}]`,
  );
}

let totalOut = 0;

console.log('— bodies —');
for (const [srcFile, outName] of Object.entries(BODIES)) {
  await process(srcFile, outName, true);
}
console.log('— weapons —');
for (const [srcFile, outName] of Object.entries(WEAPONS)) {
  await process(srcFile, outName, false);
}
console.log(`\nTOTAL public/assets/3d/modular/: ${mb(totalOut)}`);
