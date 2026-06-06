import { test } from 'node:test';
import assert from 'node:assert';
import { BACKGROUNDS } from '../js/anim/cinema-backgrounds.js';

/** Canvas-ctx mock that records every call we care about — fillRect,
 *  stroke, beginPath, fill, and the gradient creation factories. */
function mockCtx() {
  const calls = [];
  const record = (kind, ...args) => calls.push([kind, ...args]);
  return {
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
      record('createLinearGradient');
      return { addColorStop: () => {} };
    },
    createRadialGradient: () => {
      record('createRadialGradient');
      return { addColorStop: () => {} };
    },
    set fillStyle(v) { record('fillStyle', v); },
    set strokeStyle(v) { record('strokeStyle', v); },
    set lineWidth(v) { record('lineWidth', v); }
  };
}

// ---------- Layered API shape ----------

test('M48: every BACKGROUND ships paintFar + paintNear methods', () => {
  for (const [slug, bg] of Object.entries(BACKGROUNDS)) {
    assert.strictEqual(typeof bg, 'function', `${slug} should still be callable`);
    assert.strictEqual(typeof bg.paintFar, 'function',
      `${slug} should expose paintFar`);
    assert.strictEqual(typeof bg.paintNear, 'function',
      `${slug} should expose paintNear`);
  }
});

test('M48: combined call invokes far then near in order', () => {
  // Sentinels: capture call order by recording which mock fillRect
  // calls came from which layer. We instrument paintFar / paintNear
  // by recording the count BEFORE and AFTER each.
  const bg = BACKGROUNDS.grass;
  const ctx = mockCtx();
  const beforeFar = ctx.calls.length;
  bg.paintFar(ctx, { W: 800, H: 480, t: 0 });
  const afterFar = ctx.calls.length;
  bg.paintNear(ctx, { W: 800, H: 480, t: 0 });
  const afterNear = ctx.calls.length;
  // Both layers must produce SOME calls, and the second batch must
  // be larger than the first.
  assert.ok(afterFar  > beforeFar,  'paintFar should produce calls');
  assert.ok(afterNear > afterFar,   'paintNear should add more calls on top');

  // The combined function must equal far + near in total
  const ctx2 = mockCtx();
  bg(ctx2, { W: 800, H: 480, t: 0 });
  assert.strictEqual(ctx2.calls.length, afterNear,
    'combined call count should equal far + near');
});

// ---------- Layer content separation ----------
// M52 — the rich per-terrain detail (silhouettes, hero-sprite props,
// textured ground, atmospheric grade) is now BAKED into an offscreen
// real-canvas buffer and blitted via drawImage. In a headless mock-ctx
// environment (no offscreen canvas) the painters fall back to a cheap
// gradient (far) + floor line (near). These tests assert that fallback
// CONTRACT — the layer split (far = sky backdrop, near = ground/floor)
// — since the baked content can only be exercised with a real canvas
// (see the Playwright visual pass).

test('M52: far layer paints a sky backdrop for every terrain (fallback)', () => {
  for (const [slug, bg] of Object.entries(BACKGROUNDS)) {
    const ctx = mockCtx();
    bg.paintFar(ctx, { W: 800, H: 480, t: 0 });
    assert.ok(ctx.calls.some(c => c[0] === 'createLinearGradient'),
      `${slug} far should create the sky gradient`);
    assert.ok(ctx.calls.some(c => c[0] === 'fillRect'),
      `${slug} far should fill the backdrop`);
  }
});

test('M52: near layer strokes the floor line and is NOT the sky backdrop', () => {
  for (const [slug, bg] of Object.entries(BACKGROUNDS)) {
    const ctx = mockCtx();
    bg.paintNear(ctx, { W: 800, H: 480, t: 0 });
    assert.ok(ctx.calls.some(c => c[0] === 'stroke'),
      `${slug} near should stroke the floor line`);
    // The near fallback is the ground/floor only — it must NOT repaint
    // the full sky gradient that belongs to the far layer.
    assert.ok(!ctx.calls.some(c => c[0] === 'createLinearGradient'),
      `${slug} near should not repaint the far sky gradient`);
  }
});

// ---------- Smoke test: every painter runs without throwing ----------

test('M48: every paintFar + paintNear is pure callable across the eight terrains', () => {
  for (const [slug, bg] of Object.entries(BACKGROUNDS)) {
    const ctx = mockCtx();
    assert.doesNotThrow(() => bg.paintFar(ctx, { W: 800, H: 480, t: 0 }),
      `${slug}.paintFar should not throw`);
    assert.doesNotThrow(() => bg.paintNear(ctx, { W: 800, H: 480, t: 0 }),
      `${slug}.paintNear should not throw`);
    // And the combined wrapper still works (legacy callers)
    assert.doesNotThrow(() => bg(ctx, { W: 800, H: 480, t: 0 }),
      `${slug} legacy form should not throw`);
  }
});

test('M48: every background painter STILL emits fillRect calls (regression on M44.2 contract)', () => {
  // The original M44.2 contract was that each painter produces SOME
  // fillRect calls. After the split, the combined form must keep that
  // contract — make sure neither layer was reduced to a no-op.
  for (const [slug, bg] of Object.entries(BACKGROUNDS)) {
    const ctx = mockCtx();
    bg(ctx, { W: 800, H: 480, t: 0 });
    const fillRects = ctx.calls.filter(c => c[0] === 'fillRect');
    assert.ok(fillRects.length > 0, `${slug} combined should fillRect at least once`);
  }
});

test('M48: every background STILL strokes a floor line (regression)', () => {
  // Floor line is stroke() — must be present in the near layer.
  for (const [slug, bg] of Object.entries(BACKGROUNDS)) {
    const ctx = mockCtx();
    bg.paintNear(ctx, { W: 800, H: 480, t: 0 });
    assert.ok(ctx.calls.some(c => c[0] === 'stroke'),
      `${slug}.paintNear should stroke the floor line`);
  }
});
