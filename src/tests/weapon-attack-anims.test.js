import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  weaponAttackSrc, weaponAnimForBody, WEAPON_ATTACK_ANIMS
} from '../js/sprite/lpc-config.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- weaponAnimForBody ----------

test('M59: weaponAnimForBody — slash-family → slash, thrust → thrust, else null', () => {
  assert.strictEqual(weaponAnimForBody('thrust'), 'thrust');
  assert.strictEqual(weaponAnimForBody('slash'), 'slash');
  assert.strictEqual(weaponAnimForBody('backslash'), 'slash');
  assert.strictEqual(weaponAnimForBody('halfslash'), 'slash');
  assert.strictEqual(weaponAnimForBody('cast'), null);
  assert.strictEqual(weaponAnimForBody('hurt'), null);
  assert.strictEqual(weaponAnimForBody(null), null);
});

// ---------- weaponAttackSrc ----------

test('M59: weaponAttackSrc — resolves classic attack sheets for covered weapons', () => {
  assert.strictEqual(weaponAttackSrc({ name: 'Dagger' }, 'slash'),
    '/assets/lpc/weapon/dagger_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Dagger' }, 'thrust'),
    '/assets/lpc/weapon/dagger_thrust.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Spear' }, 'thrust'),
    '/assets/lpc/weapon/spear_thrust.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Mace' }, 'thrust'),
    '/assets/lpc/weapon/mace_thrust.png');
});

test('M59: weaponAttackSrc — null when the weapon lacks that classic anim', () => {
  // mace has no classic slash (universal only)
  assert.strictEqual(weaponAttackSrc({ name: 'Mace' }, 'slash'), null);
  // spear has no slash sheet
  assert.strictEqual(weaponAttackSrc({ name: 'Spear' }, 'slash'), null);
  // longsword is oversize-only → not in the registry at all
  assert.strictEqual(weaponAttackSrc({ name: 'Longsword' }, 'slash'), null);
  assert.strictEqual(weaponAttackSrc({ name: 'Longsword' }, 'thrust'), null);
  // casts / unmatched anim → null (caller falls back to walk)
  assert.strictEqual(weaponAttackSrc({ name: 'Dagger' }, null), null);
  // unknown weapon → null
  assert.strictEqual(weaponAttackSrc({ name: 'Banana' }, 'slash'), null);
});

test('M59: weaponAttackSrc — composes with weaponAnimForBody for a thrust body anim', () => {
  // spear's lance-thrust → body "thrust" → weapon thrust sheet
  assert.strictEqual(weaponAttackSrc({ name: 'Spear' }, weaponAnimForBody('thrust')),
    '/assets/lpc/weapon/spear_thrust.png');
  // a slashing body anim on the spear → no sheet → walk fallback (null)
  assert.strictEqual(weaponAttackSrc({ name: 'Spear' }, weaponAnimForBody('slash')), null);
});

// ---------- registry ↔ disk ----------

test('M59: every WEAPON_ATTACK_ANIMS sheet exists on disk with the right name', () => {
  for (const [key, anims] of Object.entries(WEAPON_ATTACK_ANIMS)) {
    for (const anim of Object.keys(anims)) {
      const p = join(REPO, 'public', 'assets', 'lpc', 'weapon', `${key}_${anim}.png`);
      assert.ok(existsSync(p), `missing asset: ${key}_${anim}.png`);
      assert.ok(anims[anim] > 0, `${key}.${anim} frame count must be positive`);
    }
  }
});
