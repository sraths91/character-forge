import { test } from 'node:test';
import assert from 'node:assert';
import {
  BIOMES, BIOME_STRUCTURE, isBiome, listBiomes, generateMapModel
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

// ---------- Phase 3: structures ----------

test('map-generator: BIOME_STRUCTURE defines structures for every biome', () => {
  for (const slug of listBiomes()) {
    const s = BIOME_STRUCTURE[slug].structures;
    assert.ok(s && typeof s.count === 'number', `${slug} structures.count`);
    assert.ok(Array.isArray(s.types) && s.types.length > 0, `${slug} structures.types`);
  }
});

test('map-generator: structures placed within bounds + valid footprint', () => {
  for (const slug of listBiomes()) {
    const m = generateMapModel({ biome: slug, cols: 16, rows: 12, seed: 11 });
    for (const s of m.structures) {
      assert.ok(s.col >= 0 && s.col + s.w <= 16, `${slug} struct col OOB`);
      assert.ok(s.row >= 0 && s.row + s.h <= 12, `${slug} struct row OOB`);
      assert.ok(s.w >= 2 && s.h >= 2, `${slug} struct too small`);
      assert.ok(BIOME_STRUCTURE[slug].structures.types.includes(s.type), `${slug} unexpected type ${s.type}`);
    }
  }
});

test('map-generator: structures never overlap each other', () => {
  // dungeon places 2 — check they don't collide across seeds.
  for (let seed = 1; seed < 25; seed++) {
    const m = generateMapModel({ biome: 'dungeon', cols: 18, rows: 12, seed });
    for (let i = 0; i < m.structures.length; i++) {
      for (let j = i + 1; j < m.structures.length; j++) {
        const a = m.structures[i], b = m.structures[j];
        const overlap = a.col < b.col + b.w && a.col + a.w > b.col &&
                        a.row < b.row + b.h && a.row + a.h > b.row;
        assert.ok(!overlap, `seed ${seed}: structures overlap`);
      }
    }
  }
});

test('map-generator: structures sit on land, not water', () => {
  const m = generateMapModel({ biome: 'swamp', cols: 16, rows: 12, seed: 4 });
  for (const s of m.structures) {
    for (let dy = 0; dy < s.h; dy++) {
      for (let dx = 0; dx < s.w; dx++) {
        const e = m.elevation(s.col + dx + 0.5, s.row + dy + 0.5);
        assert.ok(e >= m.levels.shore, `struct cell on water e=${e}`);
      }
    }
  }
});

test('map-generator: features never sit inside a structure footprint', () => {
  const m = generateMapModel({ biome: 'forest', cols: 18, rows: 12, seed: 6 });
  for (const f of m.features) {
    for (const s of m.structures) {
      const inside = f.col >= s.col && f.col < s.col + s.w && f.row >= s.row && f.row < s.row + s.h;
      assert.ok(!inside, `feature ${f.type} inside ${s.type}`);
    }
  }
});

test('map-generator: deterministic structures', () => {
  const a = generateMapModel({ biome: 'dungeon', cols: 16, rows: 12, seed: 33 });
  const b = generateMapModel({ biome: 'dungeon', cols: 16, rows: 12, seed: 33 });
  assert.deepStrictEqual(a.structures, b.structures);
});

test('map-generator: tiny maps skip structures gracefully', () => {
  const m = generateMapModel({ biome: 'grass', cols: 4, rows: 4, seed: 1 });
  assert.deepStrictEqual(m.structures, []);
});

// ---------- M50 Phase B: building variety + interiors ----------

test('map-generator: cutaway buildings carry a deterministic layout', () => {
  // Scan grass seeds until a cottage/house appears (grass offers both).
  let found = null;
  for (let s = 1; s < 60 && !found; s++) {
    const m = generateMapModel({ biome: 'grass', cols: 18, rows: 12, seed: s });
    found = m.structures.find(st => st.type === 'cottage' || st.type === 'house');
    if (found) {
      assert.ok(found.layout, 'cutaway should have a layout');
      assert.ok(Array.isArray(found.layout.rooms) && found.layout.rooms.length >= 1, 'rooms');
      assert.ok(found.layout.door && found.layout.door.side, 'door side');
      assert.ok(Array.isArray(found.layout.furniture), 'furniture');
      // Determinism: same seed → identical layout.
      const m2 = generateMapModel({ biome: 'grass', cols: 18, rows: 12, seed: s });
      const found2 = m2.structures.find(st => st.type === found.type && st.col === found.col && st.row === found.row);
      assert.deepStrictEqual(found.layout, found2.layout);
    }
  }
  assert.ok(found, 'expected a cottage/house across grass seeds');
});

test('map-generator: furniture + rooms stay inside the footprint', () => {
  for (let s = 1; s < 30; s++) {
    const m = generateMapModel({ biome: 'grass', cols: 18, rows: 12, seed: s });
    for (const st of m.structures) {
      if (!st.layout) continue;
      for (const f of st.layout.furniture) {
        assert.ok(f.x >= 0 && f.x <= st.w && f.y >= 0 && f.y <= st.h,
          `${st.type} furniture OOB (${f.x},${f.y}) in ${st.w}x${st.h}`);
      }
      for (const rm of st.layout.rooms) {
        assert.ok(rm.x >= 0 && rm.x + rm.w <= st.w + 0.01 && rm.y >= 0 && rm.y + rm.h <= st.h + 0.01,
          `${st.type} room OOB`);
      }
    }
  }
});

test('map-generator: structure footprints capped to ~1/3 of the map', () => {
  const m = generateMapModel({ biome: 'grass', cols: 9, rows: 9, seed: 4 });
  for (const st of m.structures) {
    assert.ok(st.w <= 3 && st.h <= 3, `footprint ${st.w}x${st.h} too big for 9x9`);
  }
});

test('map-generator: courtyard/tower flagged open/round', () => {
  let cy = null, tw = null;
  for (let s = 1; s < 80 && (!cy || !tw); s++) {
    const d = generateMapModel({ biome: 'desert', cols: 18, rows: 12, seed: s });
    cy = cy || d.structures.find(st => st.type === 'courtyard');
    const f = generateMapModel({ biome: 'forest', cols: 18, rows: 12, seed: s });
    tw = tw || f.structures.find(st => st.type === 'tower');
  }
  if (cy) assert.strictEqual(cy.layout.open, true);
  if (tw) assert.strictEqual(tw.layout.round, true);
});

// ---------- Phase 2: rivers + paths + bridges ----------

test('map-generator: BIOME_STRUCTURE covers every biome', () => {
  for (const slug of listBiomes()) {
    assert.ok(BIOME_STRUCTURE[slug], `missing structure for ${slug}`);
    assert.match(BIOME_STRUCTURE[slug].river, /^#[0-9a-f]{6}$/i);
    assert.match(BIOME_STRUCTURE[slug].path, /^#[0-9a-f]{6}$/i);
  }
});

test('map-generator: rivers/paths counts match the biome budget', () => {
  for (const slug of listBiomes()) {
    const m = generateMapModel({ biome: slug, cols: 14, rows: 10, seed: 5 });
    assert.strictEqual(m.rivers.length, BIOME_STRUCTURE[slug].rivers, `${slug} rivers`);
    assert.strictEqual(m.paths.length, BIOME_STRUCTURE[slug].paths, `${slug} paths`);
  }
});

test('map-generator: a river is a polyline that flows downhill overall', () => {
  // swamp has 2 rivers; check the first descends from source to mouth.
  const m = generateMapModel({ biome: 'swamp', cols: 16, rows: 12, seed: 21 });
  assert.ok(m.rivers.length >= 1);
  const r = m.rivers[0].points;
  assert.ok(r.length >= 2, 'river has points');
  // Every point in bounds.
  for (const p of r) {
    assert.ok(p.x >= 0 && p.x <= 16 && p.y >= 0 && p.y <= 12, `river point OOB ${p.x},${p.y}`);
  }
  // Source should be no lower than the mouth (gradient descent).
  assert.ok(m.elevation(r[0].x, r[0].y) >= m.elevation(r[r.length - 1].x, r[r.length - 1].y) - 0.15,
    'river should not flow strongly uphill');
});

test('map-generator: a path spans the map edge to edge', () => {
  const m = generateMapModel({ biome: 'grass', cols: 16, rows: 10, seed: 9 });
  assert.ok(m.paths.length >= 1);
  const p = m.paths[0].points;
  const first = p[0], last = p[p.length - 1];
  // One coordinate of each endpoint sits on an edge.
  const onEdge = (pt) => pt.x <= 0.5 || pt.x >= 15.5 || pt.y <= 0.5 || pt.y >= 9.5;
  assert.ok(onEdge(first) && onEdge(last), 'path endpoints should touch edges');
});

test('map-generator: deterministic rivers + paths', () => {
  const a = generateMapModel({ biome: 'forest', cols: 14, rows: 10, seed: 77 });
  const b = generateMapModel({ biome: 'forest', cols: 14, rows: 10, seed: 77 });
  assert.deepStrictEqual(a.rivers, b.rivers);
  assert.deepStrictEqual(a.paths, b.paths);
  assert.deepStrictEqual(a.bridges, b.bridges);
});

test('map-generator: features never sit on a river', () => {
  const m = generateMapModel({ biome: 'forest', cols: 16, rows: 12, seed: 3 });
  for (const f of m.features) {
    for (const river of m.rivers) {
      for (const p of river.points) {
        const d = Math.hypot(f.x - p.x, f.y - p.y);
        assert.ok(d > 0.5, `feature ${f.type} too close to river (${d.toFixed(2)})`);
      }
    }
  }
});

test('map-generator: bridges (when present) carry x/y/angle', () => {
  // Scan a few seeds to find a path×river crossing.
  let found = null;
  for (let s = 1; s < 40 && !found; s++) {
    const m = generateMapModel({ biome: 'grass', cols: 16, rows: 12, seed: s });
    if (m.bridges.length) found = m.bridges[0];
  }
  if (found) {
    assert.ok(Number.isFinite(found.x) && Number.isFinite(found.y));
    assert.ok(Number.isFinite(found.angle));
  }
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
