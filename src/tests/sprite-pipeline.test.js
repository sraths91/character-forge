import { test } from 'node:test';
import assert from 'node:assert';
import {
  slugify, assetFileName, buildProvenanceEntry, upsertManifest,
  validateProcessedMeta, parseSipsProps, TARGET_CELL,
  parseSliceSpec, parseHexColor, prepFrameName
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
    slug: 'goblin-shaman', pose: 'idle', direction: null,
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

// ---------- M60 Phase 2: prep arg parsers ----------

test('M60.2: parseSliceSpec — CxR forms', () => {
  assert.deepStrictEqual(parseSliceSpec('4x1'), { cols: 4, rows: 1 });
  assert.deepStrictEqual(parseSliceSpec('2x2'), { cols: 2, rows: 2 });
  assert.deepStrictEqual(parseSliceSpec(' 3X2 '), { cols: 3, rows: 2 }, 'tolerant of X and spaces');
});

test('M60.2: parseSliceSpec — rejects malformed specs', () => {
  assert.throws(() => parseSliceSpec('4'), /CxR/);
  assert.throws(() => parseSliceSpec('axb'), /CxR/);
  assert.throws(() => parseSliceSpec('0x1'), /≥ 1/);
  assert.throws(() => parseSliceSpec(''), /CxR/);
});

test('M60.2: parseHexColor — #rrggbb and rrggbb', () => {
  assert.deepStrictEqual(parseHexColor('#1a2b3c'), { r: 0x1a, g: 0x2b, b: 0x3c });
  assert.deepStrictEqual(parseHexColor('f8f8f8'), { r: 248, g: 248, b: 248 });
  assert.deepStrictEqual(parseHexColor('#FFFFFF'), { r: 255, g: 255, b: 255 });
});

test('M60.2: parseHexColor — rejects bad colors', () => {
  assert.throws(() => parseHexColor('#fff'), /#rrggbb/);     // 3-digit not supported
  assert.throws(() => parseHexColor('xyzxyz'), /#rrggbb/);
  assert.throws(() => parseHexColor('auto'), /#rrggbb/);     // 'auto' handled by the CLI, not here
});

test('M60.2: prepFrameName — single vs multi-frame naming', () => {
  assert.strictEqual(prepFrameName('goblin', 0, 1), 'goblin_prep.png');
  assert.strictEqual(prepFrameName('strip', 0, 4), 'strip_prep_0.png');
  assert.strictEqual(prepFrameName('strip', 3, 4), 'strip_prep_3.png');
});

// ---------- M60 Phase 3: directional register ----------

test('M60.3: assetFileName — optional direction adds a 3rd segment; 2-arg unchanged', () => {
  assert.strictEqual(assetFileName('goblin', 'idle'), 'goblin_idle.png');
  assert.strictEqual(assetFileName('goblin', 'idle', 'south'), 'goblin_idle_south.png');
  assert.strictEqual(assetFileName('goblin', 'idle', null), 'goblin_idle.png', 'null direction = no segment');
});

test('M60.3: buildProvenanceEntry — direction sets the field and the filename', () => {
  const e = buildProvenanceEntry({ slug: 'goblin', pose: 'idle', direction: 'west', at: 'T' });
  assert.strictEqual(e.direction, 'west');
  assert.strictEqual(e.file, 'public/assets/generated/goblin_idle_west.png');
  const d = buildProvenanceEntry({ slug: 'goblin', pose: 'idle', at: 'T' });
  assert.strictEqual(d.direction, null, 'missing direction normalizes to null');
  assert.strictEqual(d.file, 'public/assets/generated/goblin_idle.png');
});

test('M60.3: upsertManifest — distinct directions of the same (slug,pose) coexist', () => {
  let m = { schemaVersion: 1, assets: [] };
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'goblin', pose: 'idle', direction: 'south', at: 'T' }));
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'goblin', pose: 'idle', direction: 'north', at: 'T' }));
  assert.strictEqual(m.assets.length, 2);
  assert.deepStrictEqual(m.assets.map(a => a.direction).sort(), ['north', 'south']);
  // re-registering one direction replaces just that one
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'goblin', pose: 'idle', direction: 'south', model: 'v2', at: 'T2' }));
  assert.strictEqual(m.assets.length, 2, 'no duplicate of south');
  assert.strictEqual(m.assets.find(a => a.direction === 'south').model, 'v2');
});

test('M60.3: upsertManifest — directionless re-register still replaces (null sentinel)', () => {
  let m = { schemaVersion: 1, assets: [] };
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'orc', pose: 'idle', model: 'v1', at: 'T' }));
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'orc', pose: 'idle', model: 'v2', at: 'T2' }));
  assert.strictEqual(m.assets.length, 1, 'directionless dedup holds');
  assert.strictEqual(m.assets[0].model, 'v2');
  // ...and a directional variant is still a separate entry
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'orc', pose: 'idle', direction: 'east', at: 'T3' }));
  assert.strictEqual(m.assets.length, 2);
});

test('M60.3: upsertManifest — LEGACY entry (no direction field) dedups vs a directionless entry', () => {
  // A pre-Phase-3 manifest entry has no `direction` key at all (undefined).
  const legacy = { slug: 'goblin', pose: 'idle', file: 'x', generatedAt: 'old' };
  let m = { schemaVersion: 1, assets: [legacy] };
  m = upsertManifest(m, buildProvenanceEntry({ slug: 'goblin', pose: 'idle', model: 'new', at: 'T' }));
  assert.strictEqual(m.assets.length, 1, 'undefined-direction legacy === null-direction new');
  assert.strictEqual(m.assets[0].model, 'new');
});
