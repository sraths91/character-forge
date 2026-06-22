import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  weaponAttackSrc, weaponAttackBehindSrc, weaponAnimForBody, WEAPON_ATTACK_ANIMS
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
  // oversize swords now resolve their slash sheet; "sword"/"blade" map to longsword
  assert.strictEqual(weaponAttackSrc({ name: 'Longsword' }, 'slash'),
    '/assets/lpc/weapon/longsword_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Steel Longsword' }, 'slash'),
    '/assets/lpc/weapon/longsword_slash.png');
  // the rest of the 192px oversize roster (rapier / saber / halberd / axes)
  assert.strictEqual(weaponAttackSrc({ name: 'Rapier' }, 'slash'),
    '/assets/lpc/weapon/rapier_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Falchion' }, 'slash'),
    '/assets/lpc/weapon/saber_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Halberd' }, 'slash'),
    '/assets/lpc/weapon/halberd_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Greataxe' }, 'slash'),
    '/assets/lpc/weapon/waraxe_slash.png');
  // Group B — slash_128 (128px) swords, cropped to 6 frames at import
  assert.strictEqual(weaponAttackSrc({ name: 'Greatsword' }, 'slash'),
    '/assets/lpc/weapon/longsword_alt_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Scimitar' }, 'slash'),
    '/assets/lpc/weapon/scimitar_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Katana' }, 'slash'),
    '/assets/lpc/weapon/katana_slash.png');
  // remaining melee slashers: magic blades, flail, scythe, mace-cleave, shortsword
  assert.strictEqual(weaponAttackSrc({ name: 'Flame Tongue' }, 'slash'),
    '/assets/lpc/weapon/glowsword_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Flail' }, 'slash'),
    '/assets/lpc/weapon/flail_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Scythe' }, 'slash'),
    '/assets/lpc/weapon/scythe_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Mace' }, 'slash'),
    '/assets/lpc/weapon/mace_slash.png');
  assert.strictEqual(weaponAttackSrc({ name: 'Shortsword' }, 'slash'),
    '/assets/lpc/weapon/arming_slash.png');
});

test('M59-followup: weaponAttackBehindSrc — oversize blades resolve a behind sheet, classics do not', () => {
  // every 192px oversize slash ships a behind-body companion sheet
  assert.strictEqual(weaponAttackBehindSrc({ name: 'Longsword' }, 'slash'),
    '/assets/lpc/weapon/longsword_slash_behind.png');
  assert.strictEqual(weaponAttackBehindSrc({ name: 'Rapier' }, 'slash'),
    '/assets/lpc/weapon/rapier_slash_behind.png');
  assert.strictEqual(weaponAttackBehindSrc({ name: 'Battleaxe' }, 'slash'),
    '/assets/lpc/weapon/waraxe_slash_behind.png');
  // classic single-layer weapons have no behind sheet
  assert.strictEqual(weaponAttackBehindSrc({ name: 'Dagger' }, 'slash'), null);
  assert.strictEqual(weaponAttackBehindSrc({ name: 'Spear' }, 'thrust'), null);
  // unmatched anim / weapon → null
  assert.strictEqual(weaponAttackBehindSrc({ name: 'Longsword' }, 'thrust'), null);
  assert.strictEqual(weaponAttackBehindSrc({ name: 'Longsword' }, null), null);
  assert.strictEqual(weaponAttackBehindSrc({ name: 'Banana' }, 'slash'), null);
});

test('M59: weaponAttackSrc — null when the weapon lacks a matching classic anim', () => {
  // spear has no slash sheet (thrust only)
  assert.strictEqual(weaponAttackSrc({ name: 'Spear' }, 'slash'), null);
  // oversize swords have only a slash sheet registered (no oversize thrust yet)
  assert.strictEqual(weaponAttackSrc({ name: 'Longsword' }, 'thrust'), null);
  assert.strictEqual(weaponAttackSrc({ name: 'Greataxe' }, 'thrust'), null);
  assert.strictEqual(weaponAttackSrc({ name: 'Scimitar' }, 'thrust'), null);
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

// ---------- behind-layer sheets ↔ disk + geometry ----------

test('M59-followup: every behind sheet on disk matches its foreground (same dims)', () => {
  // Check the behind files directly by registry key (NOT via pickWeapon —
  // some keys like `longsword_alt` collide with the generic "sword" rule).
  // A behind sheet is optional (single-layer weapons have none); when one
  // exists it must decode identically to its foreground (same cellW + frames).
  for (const [key, anims] of Object.entries(WEAPON_ATTACK_ANIMS)) {
    for (const anim of Object.keys(anims)) {
      const bp = join(REPO, 'public', 'assets', 'lpc', 'weapon', `${key}_${anim}_behind.png`);
      if (!existsSync(bp)) continue;   // single-layer weapon — no behind sheet
      const fg = pngSize(join(REPO, 'public', 'assets', 'lpc', 'weapon', `${key}_${anim}.png`));
      const bg = pngSize(bp);
      assert.strictEqual(bg.h, fg.h, `${key}_${anim}_behind: height ${bg.h} ≠ fg ${fg.h}`);
      assert.strictEqual(bg.w, fg.w, `${key}_${anim}_behind: width ${bg.w} ≠ fg ${fg.w}`);
    }
  }
});

// ---------- geometry invariant ----------

function pngSize(path) {
  const b = readFileSync(path);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

// The cinema derives cellW = height/4 (4 directions) and frames =
// width/cellW. For a registered weapon to sync with the body it MUST
// yield the body's frame count for that anim (slash 6 / thrust 8). This
// pins the format so a re-download of a wrong-layout sheet fails loudly.
// (Registered weapons are all classic 64px here; the cellW=height/4 rule
// also handles 192px oversize sheets for the future revised-body work.)
const BODY_FRAMES = { slash: 6, thrust: 8 };

test('M59: every registered attack sheet decodes (cellW=height/4) to the body frame count', () => {
  for (const [key, anims] of Object.entries(WEAPON_ATTACK_ANIMS)) {
    for (const [anim, listed] of Object.entries(anims)) {
      const { w, h } = pngSize(join(REPO, 'public', 'assets', 'lpc', 'weapon', `${key}_${anim}.png`));
      assert.strictEqual(h % 4, 0, `${key}_${anim}: height ${h} not /4`);
      const cellW = h / 4;
      assert.strictEqual(w % cellW, 0, `${key}_${anim}: width ${w} not a multiple of cellW ${cellW}`);
      const frames = w / cellW;
      assert.strictEqual(frames, BODY_FRAMES[anim],
        `${key}_${anim}: ${frames} frames ≠ body ${BODY_FRAMES[anim]} (would desync)`);
      assert.strictEqual(frames, listed, `${key}_${anim}: registry says ${listed}, sheet has ${frames}`);
      // cellW must be a clean multiple of the 64 base (classic 64 / oversize 192)
      assert.strictEqual(cellW % 64, 0, `${key}_${anim}: cellW ${cellW} not a multiple of 64`);
    }
  }
});
