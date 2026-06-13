import { test } from 'node:test';
import assert from 'node:assert';
import {
  slugify, assetFileName, buildProvenanceEntry, upsertManifest,
  validateProcessedMeta, parseSipsProps, TARGET_CELL
} from '../../scripts/sprite-pipeline.mjs';

// ---------- slugify ----------

test('M60 spike: slugify — lowercases, hyphenates, strips junk', () => {
  assert.strictEqual(slugify('Goblin Shaman'), 'goblin-shaman');
  assert.strictEqual(slugify('  Fire  Elemental!! '), 'fire-elemental');
  assert.strictEqual(slugify('Beholder (boss)'), 'beholder-boss');
  assert.strictEqual(slugify('already-slugged'), 'already-slugged');
  assert.strictEqual(slugify(''), '');
});

// ---------- assetFileName ----------

test('M60 spike: assetFileName — <slug>_<pose>.png', () => {
  assert.strictEqual(assetFileName('goblin-shaman', 'idle'), 'goblin-shaman_idle.png');
  assert.strictEqual(assetFileName('orc', 'attack'), 'orc_attack.png');
});

// ---------- buildProvenanceEntry ----------

test('M60 spike: buildProvenanceEntry — deterministic shape with passed-in date', () => {
  const e = buildProvenanceEntry({
    slug: 'goblin-shaman', pose: 'idle', model: 'SD_PixelArt',
    prompt: 'a goblin shaman', seed: 7, source: 'Draw Things',
    license: 'Apache-2.0', at: '2026-06-12T00:00:00.000Z'
  });
  assert.deepStrictEqual(e, {
    slug: 'goblin-shaman', pose: 'idle',
    file: 'public/assets/generated/goblin-shaman_idle.png',
    model: 'SD_PixelArt', prompt: 'a goblin shaman', seed: 7,
    source: 'Draw Things', license: 'Apache-2.0',
    generatedAt: '2026-06-12T00:00:00.000Z'
  });
});

test('M60 spike: buildProvenanceEntry — optional fields default to null', () => {
  const e = buildProvenanceEntry({ slug: 'orc', pose: 'idle', at: 'T' });
  assert.strictEqual(e.model, null);
  assert.strictEqual(e.prompt, null);
  assert.strictEqual(e.seed, null);
  assert.strictEqual(e.source, null);
  assert.strictEqual(e.license, null);
});

// ---------- upsertManifest ----------

test('M60 spike: upsertManifest — inserts and keeps sorted, without mutating input', () => {
  const base = { schemaVersion: 1, assets: [] };
  const a = buildProvenanceEntry({ slug: 'orc', pose: 'idle', at: 'T' });
  const m1 = upsertManifest(base, a);
  assert.strictEqual(base.assets.length, 0, 'input not mutated');
  assert.strictEqual(m1.assets.length, 1);
  const b = buildProvenanceEntry({ slug: 'goblin', pose: 'idle', at: 'T' });
  const m2 = upsertManifest(m1, b);
  assert.deepStrictEqual(m2.assets.map(x => x.slug), ['goblin', 'orc'], 'sorted');
});

test('M60 spike: upsertManifest — re-registering (slug,pose) replaces, not duplicates', () => {
  let m = { schemaVersion: 1, assets: [] };
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'orc', pose: 'idle', model: 'v1', at: 'T' }));
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'orc', pose: 'idle', model: 'v2', at: 'T2' }));
  assert.strictEqual(m.assets.length, 1, 'no duplicate');
  assert.strictEqual(m.assets[0].model, 'v2', 'latest wins');
  // A different pose of the same slug is a distinct entry
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'orc', pose: 'attack', at: 'T3' }));
  assert.strictEqual(m.assets.length, 2);
});

// ---------- validateProcessedMeta ----------

test('M60 spike: validateProcessedMeta — passes a 64×64 transparent sprite', () => {
  const v = validateProcessedMeta({ width: TARGET_CELL, height: TARGET_CELL, hasAlpha: true });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.problems, []);
});

test('M60 spike: validateProcessedMeta — flags wrong size and missing alpha', () => {
  const v = validateProcessedMeta({ width: 512, height: 512, hasAlpha: false });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.problems.length, 2);
  assert.ok(v.problems[0].includes('64×64'));
  assert.ok(v.problems[1].includes('alpha'));
});

// ---------- parseSipsProps ----------

test('M60 spike: parseSipsProps — extracts dims + alpha from sips output', () => {
  const stdout = [
    '/tmp/goblin.png',
    '  pixelWidth: 64',
    '  pixelHeight: 64',
    '  hasAlpha: yes'
  ].join('\n');
  assert.deepStrictEqual(parseSipsProps(stdout), { width: 64, height: 64, hasAlpha: true });
});

test('M60 spike: parseSipsProps — hasAlpha no → false', () => {
  const stdout = '  pixelWidth: 128\n  pixelHeight: 96\n  hasAlpha: no\n';
  assert.deepStrictEqual(parseSipsProps(stdout), { width: 128, height: 96, hasAlpha: false });
});
