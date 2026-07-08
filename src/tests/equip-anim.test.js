import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { equipAnimSrc, equipHoldFrame, EQUIP_ATTACK } from '../js/sprite/lpc-config.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- equipAnimSrc resolver ----------

test('M63: equipAnimSrc swaps idle→attack src for equipment with a shipped attack sheet', () => {
  assert.strictEqual(
    equipAnimSrc('/assets/lpc/torso/legion_male.png', 'slash'),
    '/assets/lpc/torso/legion_male_slash.png');
  assert.strictEqual(
    equipAnimSrc('/assets/lpc/arms/gauntlets_male.png', 'slash'),
    '/assets/lpc/arms/gauntlets_male_slash.png');
  assert.strictEqual(
    equipAnimSrc('/assets/lpc/legs/pants_male.png', 'slash'),
    '/assets/lpc/legs/pants_male_slash.png');
});

test('M63: equipAnimSrc falls back to the idle src when there is no attack sheet', () => {
  // no animation → idle unchanged (the idle render path)
  assert.strictEqual(equipAnimSrc('/assets/lpc/torso/legion_male.png', null),
    '/assets/lpc/torso/legion_male.png');
  // variant we haven't sourced an attack sheet for (sleeveless/robe) → idle
  assert.strictEqual(equipAnimSrc('/assets/lpc/torso/sleeveless_male.png', 'slash'),
    '/assets/lpc/torso/sleeveless_male.png');
  // animation we don't ship for equipment at all (cast) → idle
  assert.strictEqual(equipAnimSrc('/assets/lpc/torso/legion_male.png', 'cast'),
    '/assets/lpc/torso/legion_male.png');
  // per-piece gap: leather torso lacks backslash upstream → idle fallback
  assert.strictEqual(equipAnimSrc('/assets/lpc/torso/leather_male.png', 'backslash'),
    '/assets/lpc/torso/leather_male.png');
  // malformed / empty
  assert.strictEqual(equipAnimSrc('', 'slash'), '');
  assert.strictEqual(equipAnimSrc('/nope.png', 'slash'), '/nope.png');
});

// ---------- equipHoldFrame (pin missing-anim pieces to a still frame) ----------

test('M63: equipHoldFrame pins pieces with no sheet for the anim to frame 0', () => {
  // arms armour + leather torso lack backslash/halfslash upstream → hold still
  assert.strictEqual(equipHoldFrame('/assets/lpc/arms/gauntlets_male.png', 'backslash'), 0);
  assert.strictEqual(equipHoldFrame('/assets/lpc/arms/bracers_female.png', 'halfslash'), 0);
  assert.strictEqual(equipHoldFrame('/assets/lpc/torso/leather_male.png', 'backslash'), 0);
  // pieces that HAVE the anim animate normally (undefined = use the global frame)
  assert.strictEqual(equipHoldFrame('/assets/lpc/arms/gauntlets_male.png', 'slash'), undefined);
  assert.strictEqual(equipHoldFrame('/assets/lpc/torso/legion_male.png', 'backslash'), undefined);
  // idle render (no animation) never holds
  assert.strictEqual(equipHoldFrame('/assets/lpc/arms/gauntlets_male.png', null), undefined);
});

// ---------- assets on disk + frame-match to the body slash ----------

test('M63: EVERY registered equipment attack sheet exists and frame-matches the body anim', () => {
  // frame count of each body animation is the sync target for its equipment
  const bodyFrames = {};
  for (const anim of ['slash', 'thrust', 'backslash', 'halfslash']) {
    const { w, h } = pngSize(join(REPO, 'public', 'assets', 'lpc', 'body', `male_${anim}.png`));
    bodyFrames[anim] = w / (h / 4);
  }
  const entries = Object.entries(EQUIP_ATTACK);
  assert.ok(entries.length >= 29, `expected the full rolled-out set (got ${entries.length})`);
  for (const [key, anims] of entries) {
    for (const anim of anims) {
      const rel = `${key}_${anim}.png`;   // e.g. torso/plate_male_thrust.png
      const p = join(REPO, 'public', 'assets', 'lpc', rel);
      assert.ok(existsSync(p), `missing ${rel}`);
      const { w, h } = pngSize(p);
      // must match the body anim's frame count or the layer desyncs
      assert.strictEqual(w / (h / 4), bodyFrames[anim],
        `${rel}: ${w / (h / 4)} frames ≠ body ${anim} ${bodyFrames[anim]} (desync)`);
      // resolver points at this file for that anim
      assert.strictEqual(equipAnimSrc(`/assets/lpc/${key}.png`, anim), `/assets/lpc/${rel}`);
    }
  }
});

function pngSize(path) {
  const b = readFileSync(path);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
