import { test } from 'node:test';
import assert from 'node:assert';
import {
  terrainFromScene, backgroundFor, BACKGROUNDS
} from '../js/anim/cinema-backgrounds.js';
import { SCENE_PRESETS } from '../js/scene/scene-state.js';

/** Tiny canvas-ctx mock that records the calls a background painter
 *  emits. Enough to verify each painter actually paints something. */
function mockCtx() {
  const calls = [];
  const record = (kind, ...args) => calls.push([kind, ...args]);
  const ctx = {
    calls,
    canvas: { width: 800, height: 480 },
    save: () => record('save'),
    restore: () => record('restore'),
    translate: (x, y) => record('translate', x, y),
    scale: (a, b) => record('scale', a, b),
    fillRect: (x, y, w, h) => record('fillRect', x, y, w, h),
    strokeRect: (x, y, w, h) => record('strokeRect', x, y, w, h),
    beginPath: () => record('beginPath'),
    moveTo: (x, y) => record('moveTo', x, y),
    lineTo: (x, y) => record('lineTo', x, y),
    bezierCurveTo: (a, b, c, d, e, f) => record('bezierCurveTo', a, b, c, d, e, f),
    quadraticCurveTo: (a, b, c, d) => record('quadraticCurveTo', a, b, c, d),
    closePath: () => record('closePath'),
    fill: () => record('fill'),
    stroke: () => record('stroke'),
    createLinearGradient: () => {
      const g = { addColorStop: () => {} };
      record('createLinearGradient');
      return g;
    },
    createRadialGradient: () => {
      const g = { addColorStop: () => {} };
      record('createRadialGradient');
      return g;
    },
    set fillStyle(v) { record('fillStyle', v); },
    set strokeStyle(v) { record('strokeStyle', v); },
    set lineWidth(v) { record('lineWidth', v); }
  };
  return ctx;
}

// ---------- terrainFromScene ----------

test('M44.2: terrainFromScene — explicit preset slug wins', () => {
  const scene = { map: { preset: 'forest', color: '#ffffff' } };
  assert.strictEqual(terrainFromScene(scene), 'forest');
});

test('M44.2: terrainFromScene — reverse-maps the colour to a slug', () => {
  // Build a scene with the grass preset's colour but NO preset field
  const grass = SCENE_PRESETS.grass.map.color;
  const scene = { map: { color: grass } };
  assert.strictEqual(terrainFromScene(scene), 'grass');
});

test('M44.2: terrainFromScene — unknown colour falls back to grass', () => {
  const scene = { map: { color: '#fe5512' } };
  assert.strictEqual(terrainFromScene(scene), 'grass');
});

test('M44.2: terrainFromScene — null scene safely defaults to grass', () => {
  assert.strictEqual(terrainFromScene(null), 'grass');
  assert.strictEqual(terrainFromScene(undefined), 'grass');
});

test('M44.2: terrainFromScene — explicit preset ignored if not in BACKGROUNDS', () => {
  const scene = { map: { preset: 'imaginary' } };
  assert.strictEqual(terrainFromScene(scene), 'grass');
});

test('M44.2: terrainFromScene — every SCENE_PRESETS colour resolves to its slug', () => {
  // Ensures the BACKGROUNDS table stays in sync with SCENE_PRESETS;
  // a future preset addition that forgets to land a background here
  // breaks this test loudly.
  for (const [slug, preset] of Object.entries(SCENE_PRESETS)) {
    const scene = { map: { color: preset.map.color } };
    assert.strictEqual(terrainFromScene(scene), slug,
      `${slug}'s colour should reverse-map to itself`);
  }
});

// ---------- backgroundFor ----------

test('M44.2: backgroundFor — returns the painter for a known slug', () => {
  for (const slug of Object.keys(BACKGROUNDS)) {
    assert.strictEqual(typeof backgroundFor(slug), 'function');
  }
});

test('M44.2: backgroundFor — unknown slug falls back to grass', () => {
  assert.strictEqual(backgroundFor('not-real'), BACKGROUNDS.grass);
});

// ---------- Each painter actually paints something ----------

test('M44.2: every background painter emits fillRect calls', () => {
  for (const [slug, paint] of Object.entries(BACKGROUNDS)) {
    const ctx = mockCtx();
    paint(ctx, { W: 800, H: 480, t: 0 });
    const fillRects = ctx.calls.filter(c => c[0] === 'fillRect');
    assert.ok(fillRects.length > 0, `${slug} should fillRect at least once`);
  }
});

test('M44.2: every background painter draws a floor line', () => {
  // floorLine() ends with stroke() on a line at H * 0.62 + 20
  for (const [slug, paint] of Object.entries(BACKGROUNDS)) {
    const ctx = mockCtx();
    paint(ctx, { W: 800, H: 480, t: 0 });
    assert.ok(ctx.calls.some(c => c[0] === 'stroke'),
      `${slug} should stroke at least once (floor line)`);
  }
});

test('M44.2: every background painter is pure — no exceptions across the eight terrains', () => {
  for (const [slug, paint] of Object.entries(BACKGROUNDS)) {
    const ctx = mockCtx();
    assert.doesNotThrow(() => paint(ctx, { W: 800, H: 480, t: 0 }),
      `${slug} should paint without throwing`);
  }
});
