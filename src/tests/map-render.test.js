import { test } from 'node:test';
import assert from 'node:assert';
import { paintMapModel, paintGeneratedBackground } from '../js/scene/map-render.js';
import { generateMapModel, listBiomes } from '../js/scene/map-generator.js';

/** Mock 2D context recording the draw calls we assert on. Includes
 *  gradient stubs since the painterly renderer uses them. */
function mockCtx() {
  const calls = [];
  const rec = (k, ...a) => calls.push([k, ...a]);
  const grad = () => ({ addColorStop: () => {} });
  return {
    calls,
    canvas: { width: 640, height: 448 },
    save: () => rec('save'),
    restore: () => rec('restore'),
    beginPath: () => rec('beginPath'),
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => rec('arc'),
    ellipse: () => rec('ellipse'),
    fill: () => rec('fill'),
    stroke: () => rec('stroke'),
    fillRect: (x, y, w, h) => rec('fillRect', x, y, w, h),
    strokeRect: () => rec('strokeRect'),
    createLinearGradient: () => { rec('linearGradient'); return grad(); },
    createRadialGradient: () => { rec('radialGradient'); return grad(); },
    set fillStyle(v) { rec('fillStyle', v); },
    set strokeStyle(v) {},
    set lineWidth(v) {},
    set lineCap(v) {},
    set shadowColor(v) {},
    set shadowBlur(v) {},
    set globalAlpha(v) {},
    get globalAlpha() { return 1; }
  };
}

test('map-render: paints a ground gradient + tiles for every biome', () => {
  for (const biome of listBiomes()) {
    const ctx = mockCtx();
    const model = generateMapModel({ biome, cols: 10, rows: 7, seed: 4242 });
    assert.doesNotThrow(() => paintMapModel(ctx, model, { cellPx: 48 }), `${biome} paints`);
    const tiles = ctx.calls.filter(c => c[0] === 'fillRect').length;
    assert.ok(tiles > 50, `${biome} should paint many ground tiles (got ${tiles})`);
  }
});

test('map-render: features draw with gradients/shapes when present', () => {
  for (const biome of listBiomes()) {
    const ctx = mockCtx();
    const model = generateMapModel({ biome, cols: 12, rows: 9, seed: 99 });
    paintMapModel(ctx, model, { cellPx: 48 });
    if (model.features.length > 0) {
      const drew = ctx.calls.some(c => ['arc', 'ellipse', 'stroke', 'radialGradient'].includes(c[0]));
      assert.ok(drew, `${biome} with ${model.features.length} features drew nothing`);
    }
  }
});

test('map-render: deterministic paint — same model → same call sequence', () => {
  const model = generateMapModel({ biome: 'forest', cols: 8, rows: 6, seed: 7 });
  const a = mockCtx(); const b = mockCtx();
  paintMapModel(a, model, { cellPx: 40 });
  paintMapModel(b, model, { cellPx: 40 });
  assert.strictEqual(a.calls.length, b.calls.length);
});

test('map-render: smaller tiles → more ground fills (gradient resolution)', () => {
  const model = generateMapModel({ biome: 'grass', cols: 6, rows: 6, seed: 9 });
  const coarse = mockCtx(); const fine = mockCtx();
  paintMapModel(coarse, model, { cellPx: 24 });
  paintMapModel(fine, model, { cellPx: 96 });
  const c = coarse.calls.filter(x => x[0] === 'fillRect').length;
  const f = fine.calls.filter(x => x[0] === 'fillRect').length;
  assert.ok(f >= c, `larger cells should not paint fewer tiles (${c} vs ${f})`);
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

test('map-render: paintGeneratedBackground resolves a scene + paints', () => {
  const ctx = mockCtx();
  const scene = { cols: 8, rows: 6, map: { kind: 'generated', biome: 'cave', seed: 777 } };
  assert.doesNotThrow(() => paintGeneratedBackground(ctx, scene, 48));
  assert.ok(ctx.calls.some(c => c[0] === 'fillRect'));
});

test('map-render: paintGeneratedBackground tolerates missing fields + null', () => {
  const ctx = mockCtx();
  assert.doesNotThrow(() =>
    paintGeneratedBackground(ctx, { cols: 5, rows: 5, map: { kind: 'generated' } }, 40));
  assert.doesNotThrow(() => paintGeneratedBackground(ctx, null, 48));
});
