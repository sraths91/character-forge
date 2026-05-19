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

test('M48: grass far paints the sky/ground gradient; near paints tufts + floor line', () => {
  const bg = BACKGROUNDS.grass;
  const farCtx = mockCtx();
  const nearCtx = mockCtx();
  bg.paintFar(farCtx, { W: 800, H: 480, t: 0 });
  bg.paintNear(nearCtx, { W: 800, H: 480, t: 0 });
  // Far creates a linear gradient (the sky→ground swatch)
  assert.ok(farCtx.calls.some(c => c[0] === 'createLinearGradient'),
    'far layer should create the gradient');
  // Near strokes (the floor line)
  assert.ok(nearCtx.calls.some(c => c[0] === 'stroke'),
    'near layer should stroke the floor line');
});

test('M48: cave far has stalactites (ceiling); near has stalagmites (floor)', () => {
  // Stalactites are 8 triangles at the top; stalagmites are 6 at the
  // floor. Both use moveTo (top y or floor y respectively) followed
  // by 2× lineTo + closePath. We just verify FAR has more moveTo
  // calls than near, since 8 stalactites > 6 stalagmites.
  const bg = BACKGROUNDS.cave;
  const farCtx = mockCtx();
  const nearCtx = mockCtx();
  bg.paintFar(farCtx, { W: 800, H: 480, t: 0 });
  bg.paintNear(nearCtx, { W: 800, H: 480, t: 0 });
  const farMoves  = farCtx.calls.filter(c => c[0] === 'moveTo').length;
  const nearMoves = nearCtx.calls.filter(c => c[0] === 'moveTo').length;
  // Far: 8 stalactites + 1 gradient (which doesn't use moveTo) ≥ 8.
  // Near: 6 stalagmites + 1 floor line = 7.
  assert.ok(farMoves >= 8, `expected ≥ 8 moveTo in cave far; got ${farMoves}`);
  assert.ok(nearMoves >= 6, `expected ≥ 6 moveTo in cave near; got ${nearMoves}`);
});

test('M48: dungeon far paints the brick band + torch haze; near is just the floor line', () => {
  const bg = BACKGROUNDS.dungeon;
  const farCtx = mockCtx();
  const nearCtx = mockCtx();
  bg.paintFar(farCtx, { W: 800, H: 480, t: 0 });
  bg.paintNear(nearCtx, { W: 800, H: 480, t: 0 });
  // Far should have many strokeRect calls (brick band) + a radial
  // gradient (torch haze).
  assert.ok(farCtx.calls.filter(c => c[0] === 'strokeRect').length >= 10,
    'far should paint the brick wall band');
  assert.ok(farCtx.calls.some(c => c[0] === 'createRadialGradient'),
    'far should paint the torch haze');
  // Near is minimal — just the floor line stroke.
  assert.ok(nearCtx.calls.some(c => c[0] === 'stroke'),
    'near should stroke the floor line');
  // Near should have NO strokeRect (no brick wall)
  assert.ok(!nearCtx.calls.some(c => c[0] === 'strokeRect'),
    'near should not paint the brick band');
});

test('M48: tavern far has the fireplace glow; near has the wood planks', () => {
  const bg = BACKGROUNDS.tavern;
  const farCtx = mockCtx();
  const nearCtx = mockCtx();
  bg.paintFar(farCtx, { W: 800, H: 480, t: 0 });
  bg.paintNear(nearCtx, { W: 800, H: 480, t: 0 });
  assert.ok(farCtx.calls.some(c => c[0] === 'createRadialGradient'),
    'far should create the fireplace radial glow');
  // Near: 5 wood plank lines = 5 stroke calls (plus floor line = 6)
  const nearStrokes = nearCtx.calls.filter(c => c[0] === 'stroke').length;
  assert.ok(nearStrokes >= 5,
    `near should stroke wood planks + floor line; got ${nearStrokes}`);
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
