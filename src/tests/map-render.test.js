import { test } from 'node:test';
import assert from 'node:assert';
import { paintMapModel, paintGeneratedBackground } from '../js/scene/map-render.js';
import { generateMapModel, listBiomes } from '../js/scene/map-generator.js';

/** Mock 2D context that records the draw calls we care about and
 *  swallows the rest. Mirrors anim-cinema-backgrounds.test.js. */
function mockCtx() {
  const calls = [];
  const rec = (k, ...a) => calls.push([k, ...a]);
  return {
    calls,
    canvas: { width: 640, height: 448 },
    save: () => rec('save'),
    restore: () => rec('restore'),
    beginPath: () => rec('beginPath'),
    closePath: () => rec('closePath'),
    moveTo: () => {},
    lineTo: () => {},
    arc: () => rec('arc'),
    ellipse: () => rec('ellipse'),
    fill: () => rec('fill'),
    stroke: () => rec('stroke'),
    fillRect: (x, y, w, h) => rec('fillRect', x, y, w, h),
    strokeRect: () => rec('strokeRect'),
    set fillStyle(v) { rec('fillStyle', v); },
    set strokeStyle(v) { rec('strokeStyle', v); },
    set lineWidth(v) {},
    set lineCap(v) {},
    set globalAlpha(v) {},
    get globalAlpha() { return 1; }
  };
}

// ---------- paintMapModel ----------

test('map-render: paints a base ground fill first', () => {
  const ctx = mockCtx();
  const model = generateMapModel({ biome: 'grass', cols: 10, rows: 7, seed: 1 });
  paintMapModel(ctx, model, { cellPx: 48 });
  const firstFill = ctx.calls.find(c => c[0] === 'fillRect');
  assert.ok(firstFill, 'should fillRect the ground');
  // The very first fillStyle set should be the ground base color
  const firstStyle = ctx.calls.find(c => c[0] === 'fillStyle');
  assert.strictEqual(firstStyle[1], model.ground.base);
});

test('map-render: every biome paints without throwing + emits features', () => {
  for (const biome of listBiomes()) {
    const ctx = mockCtx();
    const model = generateMapModel({ biome, cols: 10, rows: 7, seed: 4242 });
    assert.doesNotThrow(() => paintMapModel(ctx, model, { cellPx: 48 }),
      `${biome} should paint`);
    // Features draw via arc / ellipse / fillRect / stroke — at least one
    // drawing primitive beyond the base fill should fire when features exist.
    if (model.features.length > 0) {
      const drew = ctx.calls.some(c => ['arc', 'ellipse', 'stroke'].includes(c[0]));
      assert.ok(drew, `${biome} with ${model.features.length} features drew nothing`);
    }
  }
});

test('map-render: mottle scales with cell size (more tiles at larger cellPx)', () => {
  const model = generateMapModel({ biome: 'forest', cols: 6, rows: 6, seed: 9 });
  const small = mockCtx();
  const large = mockCtx();
  paintMapModel(small, model, { cellPx: 24 });
  paintMapModel(large, model, { cellPx: 96 });
  const smallRects = small.calls.filter(c => c[0] === 'fillRect').length;
  const largeRects = large.calls.filter(c => c[0] === 'fillRect').length;
  assert.ok(largeRects >= smallRects,
    `larger cells should not produce fewer mottle tiles (${smallRects} vs ${largeRects})`);
});

test('map-render: null ctx / model are safe no-ops', () => {
  const ctx = mockCtx();
  assert.doesNotThrow(() => paintMapModel(null, {}, { cellPx: 48 }));
  assert.doesNotThrow(() => paintMapModel(ctx, null, { cellPx: 48 }));
});

test('map-render: missing cellPx falls back to a default', () => {
  const ctx = mockCtx();
  const model = generateMapModel({ biome: 'grass', cols: 4, rows: 4, seed: 1 });
  assert.doesNotThrow(() => paintMapModel(ctx, model, {}));
  assert.ok(ctx.calls.some(c => c[0] === 'fillRect'));
});

// ---------- paintGeneratedBackground ----------

test('map-render: paintGeneratedBackground resolves a scene + paints', () => {
  const ctx = mockCtx();
  const scene = {
    cols: 8, rows: 6,
    map: { kind: 'generated', biome: 'cave', seed: 777 }
  };
  assert.doesNotThrow(() => paintGeneratedBackground(ctx, scene, 48));
  assert.ok(ctx.calls.some(c => c[0] === 'fillRect'), 'should paint ground');
});

test('map-render: paintGeneratedBackground tolerates missing map fields', () => {
  const ctx = mockCtx();
  // No biome / seed → generator falls back to grass / seed 1
  assert.doesNotThrow(() =>
    paintGeneratedBackground(ctx, { cols: 5, rows: 5, map: { kind: 'generated' } }, 40));
});

test('map-render: paintGeneratedBackground null scene is a no-op', () => {
  const ctx = mockCtx();
  assert.doesNotThrow(() => paintGeneratedBackground(ctx, null, 48));
});
