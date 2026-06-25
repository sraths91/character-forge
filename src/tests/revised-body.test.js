import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  bodyAnimSheet, bodyAnimFrames, ASSET_MAP,
  revisedWeaponAttackSrc, revisedWeaponBehindSrc
} from '../js/sprite/lpc-config.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- bodyAnimSheet — revised routing ----------

test('M62: bodyAnimSheet routes revised bases to body-revised/ for the anims they have', () => {
  assert.strictEqual(bodyAnimSheet('revised', 'slash'),     '/assets/lpc/body-revised/revised_slash.png');
  assert.strictEqual(bodyAnimSheet('revised', 'backslash'), '/assets/lpc/body-revised/revised_backslash.png');
  assert.strictEqual(bodyAnimSheet('revised', 'halfslash'), '/assets/lpc/body-revised/revised_halfslash.png');
  assert.strictEqual(bodyAnimSheet('revised_female', 'slash'), '/assets/lpc/body-revised/revised_female_slash.png');
});

test('M62: bodyAnimSheet returns null for anims revised lacks (thrust/cast/hurt) → idle fallback', () => {
  assert.strictEqual(bodyAnimSheet('revised', 'thrust'), null);
  assert.strictEqual(bodyAnimSheet('revised', 'cast'), null);
  assert.strictEqual(bodyAnimSheet('revised', 'hurt'), null);
});

test('M62: classic bodyAnimSheet is unchanged', () => {
  assert.strictEqual(bodyAnimSheet('male', 'slash'),   '/assets/lpc/body/male_slash.png');
  assert.strictEqual(bodyAnimSheet('female', 'thrust'), '/assets/lpc/body/female_thrust.png');
  assert.strictEqual(bodyAnimSheet('muscular', 'backslash'), null); // muscular has no backslash
  assert.strictEqual(bodyAnimSheet('skeleton', 'slash'), null);     // not a human attack base
});

// ---------- bodyAnimFrames — per-body counts ----------

test('M62: bodyAnimFrames gives revised its own counts (slash 7 vs classic 6)', () => {
  assert.strictEqual(bodyAnimFrames('revised', 'slash'),     7);
  assert.strictEqual(bodyAnimFrames('revised', 'backslash'), 12);
  assert.strictEqual(bodyAnimFrames('revised', 'halfslash'), 6);
  assert.strictEqual(bodyAnimFrames('revised_female', 'slash'), 7);
  assert.strictEqual(bodyAnimFrames('revised', 'thrust'),    0);   // not present
  assert.strictEqual(bodyAnimFrames('male', 'slash'),        6);   // classic unchanged
  assert.strictEqual(bodyAnimFrames('male', 'thrust'),       8);
});

// ---------- Phase 2: revised weapon (arming sword) ----------

test('M62 Phase 2: swords resolve the revised arming sword per cut; non-swords/non-cuts → null', () => {
  assert.strictEqual(revisedWeaponAttackSrc({ name: 'Longsword' }, 'slash'),
    '/assets/lpc/weapon-revised/arming_slash.png');
  assert.strictEqual(revisedWeaponAttackSrc({ name: 'Longsword' }, 'backslash'),
    '/assets/lpc/weapon-revised/arming_backslash.png');
  assert.strictEqual(revisedWeaponAttackSrc({ name: 'Rapier' }, 'halfslash'),
    '/assets/lpc/weapon-revised/arming_halfslash.png');
  assert.strictEqual(revisedWeaponAttackSrc({ name: 'Greatsword' }, 'slash'),
    '/assets/lpc/weapon-revised/arming_slash.png');   // longsword_alt is a sword
  // non-swords have no revised art → bare-handed on revised
  assert.strictEqual(revisedWeaponAttackSrc({ name: 'Greataxe' }, 'slash'), null);
  assert.strictEqual(revisedWeaponAttackSrc({ name: 'Mace' }, 'slash'), null);
  assert.strictEqual(revisedWeaponAttackSrc({ name: 'Spear' }, 'slash'), null);
  // cuts revised weapons don't have → null
  assert.strictEqual(revisedWeaponAttackSrc({ name: 'Longsword' }, 'thrust'), null);
  assert.strictEqual(revisedWeaponAttackSrc({ name: 'Longsword' }, null), null);
});

test('M62 Phase 2: revised behind sheet mirrors the front (swords only)', () => {
  assert.strictEqual(revisedWeaponBehindSrc({ name: 'Longsword' }, 'slash'),
    '/assets/lpc/weapon-revised/arming_slash_behind.png');
  assert.strictEqual(revisedWeaponBehindSrc({ name: 'Greataxe' }, 'slash'), null);
});

// ---------- assets on disk ----------

test('M62: revised bases are registered and present on disk, decoding to the right frame counts', () => {
  for (const key of ['revised', 'revised_female']) {
    assert.ok(ASSET_MAP.body[key], `ASSET_MAP.body.${key} missing`);
    const base = ASSET_MAP.body[key].replace('/assets/lpc/', '');
    assert.ok(existsSync(join(REPO, 'public', 'assets', 'lpc', base)), `missing ${base}`);
  }
  // every revised attack sheet decodes (cellW=height/4) to its declared count
  const want = { slash: 7, backslash: 12, halfslash: 6 };
  for (const key of ['revised', 'revised_female']) {
    for (const [anim, frames] of Object.entries(want)) {
      const p = join(REPO, 'public', 'assets', 'lpc', 'body-revised', `${key}_${anim}.png`);
      assert.ok(existsSync(p), `missing ${key}_${anim}.png`);
      const b = readFileSync(p);
      const w = b.readUInt32BE(16), h = b.readUInt32BE(20), cellW = Math.round(h / 4);
      assert.strictEqual(h % 4, 0, `${key}_${anim}: height ${h} not /4`);
      assert.strictEqual(cellW, 64, `${key}_${anim}: cellW ${cellW} ≠ 64`);
      assert.strictEqual(Math.round(w / cellW), frames, `${key}_${anim}: ${w}px ≠ ${frames} frames`);
      assert.strictEqual(bodyAnimFrames(key, anim), frames, `${key}_${anim}: registry count mismatch`);
    }
  }
});

test('M62 Phase 2: revised arming sword sheets exist and frame-match the revised body cuts', () => {
  // weapon frames MUST equal the body cut's frames or the overlay desyncs.
  const want = { slash: 7, backslash: 12, halfslash: 6 };
  for (const [anim, frames] of Object.entries(want)) {
    for (const suffix of ['', '_behind']) {
      const p = join(REPO, 'public', 'assets', 'lpc', 'weapon-revised', `arming_${anim}${suffix}.png`);
      assert.ok(existsSync(p), `missing arming_${anim}${suffix}.png`);
      const b = readFileSync(p);
      const w = b.readUInt32BE(16), h = b.readUInt32BE(20), cellW = Math.round(h / 4);
      assert.strictEqual(h % 4, 0, `arming_${anim}${suffix}: height ${h} not /4`);
      assert.strictEqual(Math.round(w / cellW), frames, `arming_${anim}${suffix}: ${w}px ≠ ${frames} frames`);
      assert.strictEqual(frames, bodyAnimFrames('revised', anim), `arming_${anim}: must match body cut frames`);
    }
  }
});
