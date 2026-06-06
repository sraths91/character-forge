import { test } from 'node:test';
import assert from 'node:assert';
import {
  BIOME_FEATURES, isBiome, listBiomes, generateMapModel
} from '../js/scene/map-generator.js';
import { SCENE_PRESETS } from '../js/scene/scene-state.js';

// ---------- Biome registry ----------

test('map-generator: biome slugs mirror SCENE_PRESETS exactly', () => {
  const gen = listBiomes().sort();
  const presets = Object.keys(SCENE_PRESETS).sort();
  assert.deepStrictEqual(gen, presets,
    'generator biomes must stay in sync with SCENE_PRESETS');
});

test('map-generator: every biome defines ground palette + features', () => {
  for (const slug of listBiomes()) {
    const spec = BIOME_FEATURES[slug];
    assert.ok(spec.ground?.base && spec.ground.light && spec.ground.dark, `${slug} ground`);
    assert.ok(Array.isArray(spec.features) && spec.features.length > 0, `${slug} features`);
    assert.ok(typeof spec.maxCoverage === 'number', `${slug} maxCoverage`);
  }
});

test('map-generator: every feature has a valid hex palette + radius cap', () => {
  for (const slug of listBiomes()) {
    for (const f of BIOME_FEATURES[slug].features) {
      assert.ok(f.r <= 0.42, `${slug}/${f.type} radius ${f.r} exceeds 0.42 cap`);
      assert.ok(Array.isArray(f.palette) && f.palette.length > 0, `${slug}/${f.type} palette`);
      for (const c of f.palette) {
        assert.match(c, /^#[0-9a-f]{6}$/i, `${slug}/${f.type} bad color ${c}`);
      }
      assert.ok(Array.isArray(f.band) && f.band.length === 2, `${slug}/${f.type} band`);
    }
  }
});

test('map-generator: isBiome', () => {
  assert.strictEqual(isBiome('forest'), true);
  assert.strictEqual(isBiome('cave'), true);
  assert.strictEqual(isBiome('nonsense'), false);
  assert.strictEqual(isBiome(null), false);
});

// ---------- generateMapModel ----------

test('map-generator: deterministic — same inputs → identical model', () => {
  const a = generateMapModel({ biome: 'forest', cols: 10, rows: 7, seed: 42 });
  const b = generateMapModel({ biome: 'forest', cols: 10, rows: 7, seed: 42 });
  assert.strictEqual(a.features.length, b.features.length);
  assert.deepStrictEqual(
    a.features.map(f => `${f.type}@${f.col},${f.row}:${f.variant}`),
    b.features.map(f => `${f.type}@${f.col},${f.row}:${f.variant}`)
  );
});

test('map-generator: different seeds → different layouts', () => {
  const a = generateMapModel({ biome: 'forest', cols: 12, rows: 8, seed: 1 });
  const b = generateMapModel({ biome: 'forest', cols: 12, rows: 8, seed: 2 });
  const sa = a.features.map(f => `${f.type}@${f.col},${f.row}`).join('|');
  const sb = b.features.map(f => `${f.type}@${f.col},${f.row}`).join('|');
  assert.notStrictEqual(sa, sb);
});

test('map-generator: all features land inside grid bounds', () => {
  const m = generateMapModel({ biome: 'swamp', cols: 8, rows: 6, seed: 99 });
  for (const f of m.features) {
    assert.ok(f.col >= 0 && f.col < 8, `col ${f.col} OOB`);
    assert.ok(f.row >= 0 && f.row < 6, `row ${f.row} OOB`);
    // cell-space center stays within the cell's neighborhood
    assert.ok(f.x >= f.col && f.x <= f.col + 1, `x ${f.x} outside cell`);
    assert.ok(f.y >= f.row && f.y <= f.row + 1, `y ${f.y} outside cell`);
  }
});

test('map-generator: at most one feature per cell (readability)', () => {
  const m = generateMapModel({ biome: 'cave', cols: 10, rows: 7, seed: 7 });
  const seen = new Set();
  for (const f of m.features) {
    const key = `${f.col},${f.row}`;
    assert.ok(!seen.has(key), `two features on cell ${key}`);
    seen.add(key);
  }
});

test('map-generator: coverage respects the biome budget', () => {
  const cols = 12, rows = 10;
  const m = generateMapModel({ biome: 'forest', cols, rows, seed: 3 });
  const budget = BIOME_FEATURES.forest.maxCoverage * cols * rows;
  assert.ok(m.features.length <= Math.ceil(budget),
    `${m.features.length} features exceeds budget ${budget}`);
});

test('map-generator: unknown biome falls back to grass', () => {
  const m = generateMapModel({ biome: 'not-real', cols: 5, rows: 5, seed: 1 });
  assert.strictEqual(m.biome, 'grass');
});

test('map-generator: produces some features on a normal-size map', () => {
  // Sanity: a 10x7 forest with a typical seed should not be barren.
  const m = generateMapModel({ biome: 'forest', cols: 10, rows: 7, seed: 12345 });
  assert.ok(m.features.length > 0, 'expected at least one feature');
});

test('map-generator: field sampler returns [0,1]', () => {
  const m = generateMapModel({ biome: 'grass', cols: 6, rows: 6, seed: 5 });
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const e = m.field(c, r);
      assert.ok(e >= 0 && e <= 1, `field(${c},${r})=${e} out of range`);
    }
  }
});

test('map-generator: degenerate inputs are safe', () => {
  assert.doesNotThrow(() => generateMapModel({ biome: 'grass', cols: 1, rows: 1, seed: 0 }));
  assert.doesNotThrow(() => generateMapModel({}));
});
