import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { equipAnimSrc } from '../js/sprite/lpc-config.js';

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
  // variant we haven't sourced an attack sheet for → idle
  assert.strictEqual(equipAnimSrc('/assets/lpc/torso/plate_male.png', 'slash'),
    '/assets/lpc/torso/plate_male.png');
  // animation we haven't shipped for this piece (legion has slash, not thrust)
  assert.strictEqual(equipAnimSrc('/assets/lpc/torso/legion_male.png', 'thrust'),
    '/assets/lpc/torso/legion_male.png');
  // malformed / empty
  assert.strictEqual(equipAnimSrc('', 'slash'), '');
  assert.strictEqual(equipAnimSrc('/nope.png', 'slash'), '/nope.png');
});

// ---------- assets on disk + frame-match to the body slash ----------

test('M63: every registered equipment attack sheet exists and is 6f (matches the classic body slash)', () => {
  const bodySlash = pngSize(join(REPO, 'public', 'assets', 'lpc', 'body', 'male_slash.png'));
  const bodyFrames = bodySlash.w / (bodySlash.h / 4);
  for (const rel of ['torso/legion_male_slash.png', 'arms/gauntlets_male_slash.png', 'legs/pants_male_slash.png']) {
    const p = join(REPO, 'public', 'assets', 'lpc', rel);
    assert.ok(existsSync(p), `missing ${rel}`);
    const { w, h } = pngSize(p);
    const cellW = h / 4;
    assert.strictEqual(h, bodySlash.h, `${rel}: height ${h} ≠ body ${bodySlash.h}`);
    assert.strictEqual(w / cellW, bodyFrames, `${rel}: ${w / cellW} frames ≠ body ${bodyFrames} (would desync)`);
  }
});

function pngSize(path) {
  const b = readFileSync(path);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
