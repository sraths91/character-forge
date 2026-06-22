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
  // mace has no classic slash (universal only)
  assert.strictEqual(weaponAttackSrc({ name: 'Mace' }, 'slash'), null);
  // spear has no slash sheet
  assert.strictEqual(weaponAttackSrc({ name: 'Spear' }, 'slash'), null);
  // oversize swords have only a slash sheet registered (no oversize thrust yet)
  assert.strictEqual(weaponAttackSrc({ name: 'Longsword' }, 'thrust'), null);
  assert.strictEqual(weaponAttackSrc({ name: 'Greataxe' }, 'thrust'), null);
  // Group B (greatsword/scimitar/katana) is the 128px/13-frame slash_128
  // format — not synced to our 6-frame body, so NOT registered (DEFERRED).
  assert.strictEqual(weaponAttackSrc({ name: 'Scimitar' }, 'slash'), null);
  assert.strictEqual(weaponAttackSrc({ name: 'Katana' }, 'slash'), null);
  assert.strictEqual(weaponAttackSrc({ name: 'Greatsword' }, 'slash'), null);
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

test('M59-followup: each behind sheet exists and matches its foreground (192px / same frames)', () => {
  // any weapon that resolves a behind sheet must have it on disk and it
  // must decode identically to the foreground (same cellW + frame count).
  for (const [key, anims] of Object.entries(WEAPON_ATTACK_ANIMS)) {
    for (const anim of Object.keys(anims)) {
      const behind = weaponAttackBehindSrc({ name: key }, anim);
      if (!behind) continue;
      const file = behind.replace('/assets/lpc/weapon/', '');
      const bp = join(REPO, 'public', 'assets', 'lpc', 'weapon', file);
      assert.ok(existsSync(bp), `missing behind sheet: ${file}`);
      const fg = pngSize(join(REPO, 'public', 'assets', 'lpc', 'weapon', `${key}_${anim}.png`));
      const bg = pngSize(bp);
      assert.strictEqual(bg.h, fg.h, `${file}: behind height ${bg.h} ≠ fg ${fg.h}`);
      assert.strictEqual(bg.w, fg.w, `${file}: behind width ${bg.w} ≠ fg ${fg.w}`);
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
