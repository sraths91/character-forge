import { test } from 'node:test';
import assert from 'node:assert';
import {
  BIOMES, isBiome, listBiomes, generateMapModel
} from '../js/scene/map-generator.js';
import { SCENE_PRESETS } from '../js/scene/scene-state.js';

const ZONES = ['water', 'shore', 'low', 'mid', 'high'];

// ---------- Biome registry ----------

test('map-generator: biome slugs mirror SCENE_PRESETS exactly', () => {
  assert.deepStrictEqual(listBiomes().sort(), Object.keys(SCENE_PRESETS).sort());
});

test('map-generator: every biome defines levels + all five zones', () => {
  for (const slug of listBiomes()) {
    const spec = BIOMES[slug];
    assert.ok(spec.levels, `${slug} levels`);
    for (const z of ZONES) {
      assert.ok(spec.zones[z], `${slug} missing zone ${z}`);
      assert.ok(Array.isArray(spec.zones[z].fill) && spec.zones[z].fill.length === 2,
        `${slug}/${z} fill pair`);
      assert.ok(Array.isArray(spec.zones[z].features), `${slug}/${z} features array`);
    }
  }
});

test('map-generator: elevation thresholds are ascending', () => {
  for (const slug of listBiomes()) {
    const { water, shore, low, mid } = BIOMES[slug].levels;
    assert.ok(water <= shore && shore <= low && low <= mid,
      `${slug} thresholds not ascending`);
  }
});

test('map-generator: every fill + feature colour is valid hex', () => {
  for (const slug of listBiomes()) {
    for (const z of ZONES) {
      const zspec = BIOMES[slug].zones[z];
      for (const c of zspec.fill) assert.match(c, /^#[0-9a-f]{6}$/i, `${slug}/${z} fill ${c}`);
      assert.match(zspec.edge, /^#[0-9a-f]{6}$/i, `${slug}/${z} edge ${zspec.edge}`);
      for (const f of zspec.features) {
        assert.ok(f.r <= 0.46, `${slug}/${z}/${f.type} radius ${f.r} over cap`);
        for (const c of f.palette) assert.match(c, /^#[0-9a-f]{6}$/i, `${slug}/${z}/${f.type} ${c}`);
      }
    }
  }
});

test('map-generator: isBiome', () => {
  assert.strictEqual(isBiome('forest'), true);
  assert.strictEqual(isBiome('nonsense'), false);
  assert.strictEqual(isBiome(null), false);
});

// ---------- generateMapModel ----------

test('map-generator: deterministic — same inputs → identical features', () => {
  const a = generateMapModel({ biome: 'forest', cols: 10, rows: 7, seed: 42 });
  const b = generateMapModel({ biome: 'forest', cols: 10, rows: 7, seed: 42 });
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

test('map-generator: model exposes continuous fields + zone classifier', () => {
  const m = generateMapModel({ biome: 'grass', cols: 6, rows: 6, seed: 5 });
  assert.strictEqual(typeof m.elevation, 'function');
  assert.strictEqual(typeof m.moisture, 'function');
  assert.strictEqual(typeof m.zoneAt, 'function');
  assert.strictEqual(typeof m.zoneFill, 'function');
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const e = m.elevation(c, r);
      const mo = m.moisture(c, r);
      assert.ok(e >= 0 && e <= 1, `elevation ${e}`);
      assert.ok(mo >= 0 && mo <= 1, `moisture ${mo}`);
      assert.ok(ZONES.includes(m.zoneAt(c, r)), `zone ${m.zoneAt(c, r)}`);
    }
  }
});

test('map-generator: regions are coherent (zone matches the field)', () => {
  // A cell classified 'water' must have elevation below the water level,
  // proving the classifier reads the same field the renderer paints.
  const m = generateMapModel({ biome: 'swamp', cols: 12, rows: 10, seed: 8 });
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 12; c++) {
      const z = m.zoneAt(c, r);
      const e = m.elevation(c, r);
      if (z === 'water') assert.ok(e < m.levels.water, `water cell e=${e}`);
      if (z === 'high')  assert.ok(e >= m.levels.mid, `high cell e=${e}`);
    }
  }
});

test('map-generator: features carry their originating zone', () => {
  const m = generateMapModel({ biome: 'forest', cols: 10, rows: 8, seed: 3 });
  for (const f of m.features) {
    assert.ok(ZONES.includes(f.zone), `feature zone ${f.zone}`);
    // The feature's cell should actually classify to that zone.
    assert.strictEqual(m.zoneAt(f.col, f.row), f.zone);
  }
});

test('map-generator: features stay in bounds + one per cell', () => {
  const m = generateMapModel({ biome: 'cave', cols: 10, rows: 7, seed: 7 });
  const seen = new Set();
  for (const f of m.features) {
    assert.ok(f.col >= 0 && f.col < 10 && f.row >= 0 && f.row < 7, 'in bounds');
    assert.ok(f.x >= f.col && f.x <= f.col + 1 && f.y >= f.row && f.y <= f.row + 1, 'in cell');
    const key = `${f.col},${f.row}`;
    assert.ok(!seen.has(key), `two features on ${key}`);
    seen.add(key);
  }
});

test('map-generator: model exposes phase-2/3 arrays (empty for now)', () => {
  const m = generateMapModel({ biome: 'grass', cols: 5, rows: 5, seed: 1 });
  assert.deepStrictEqual(m.rivers, []);
  assert.deepStrictEqual(m.paths, []);
  assert.deepStrictEqual(m.structures, []);
});

test('map-generator: unknown biome falls back to grass', () => {
  assert.strictEqual(generateMapModel({ biome: 'nope', cols: 5, rows: 5, seed: 1 }).biome, 'grass');
});

test('map-generator: degenerate inputs are safe', () => {
  assert.doesNotThrow(() => generateMapModel({ biome: 'grass', cols: 1, rows: 1, seed: 0 }));
  assert.doesNotThrow(() => generateMapModel({}));
});

test('map-generator: produces features on a normal map', () => {
  const m = generateMapModel({ biome: 'forest', cols: 12, rows: 9, seed: 12345 });
  assert.ok(m.features.length > 0);
});
