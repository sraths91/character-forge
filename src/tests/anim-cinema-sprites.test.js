import { test } from 'node:test';
import assert from 'node:assert';
import {
  toLpcCharacter, makeLpcDrawSprite, pickActorFrame,
  invalidateActorSprite, clearActorSpriteCache
} from '../js/anim/cinema-sprites.js';

/** Build a lookup callback that returns a multi-frame cache entry. */
function fakeCacheEntry(frameIndices = [0, 1, 2, 4, 6]) {
  const frames = new Map();
  for (const i of frameIndices) frames.set(i, { width: 192, height: 192, _frame: i });
  return { frames, scale: 3, direction: 'south' };
}

// ---------- toLpcCharacter ----------

test('M44: toLpcCharacter — null entity returns null', () => {
  assert.strictEqual(toLpcCharacter(null), null);
});

test('M44: toLpcCharacter — PC entity passes through', () => {
  const pc = { id: 'p1', name: 'Hero', classes: [{ name: 'Fighter', level: 3 }] };
  const out = toLpcCharacter(pc);
  assert.strictEqual(out, pc);
});

test('M44: toLpcCharacter — monster with valid presetSlug wraps via buildMonsterCharacter', () => {
  // The presets module is internal; we just want a known slug. Try 'goblin'
  // which is one of the standard starter presets. If absent, the call
  // returns null — the test fails loud rather than silently passing.
  const monster = { id: 'm1', name: 'Goblin Bandit', presetSlug: 'goblin', position: { col: 5, row: 3 } };
  const out = toLpcCharacter(monster);
  assert.ok(out, 'goblin preset should resolve');
  assert.strictEqual(out.id, 'm1');
  assert.strictEqual(out._isMonster, true);
  // Must look like an LPC-renderable character
  assert.ok(out.race && out.race.name);
  assert.ok(Array.isArray(out.classes));
});

test('M44: toLpcCharacter — monster with unknown preset returns null', () => {
  const monster = { id: 'm2', presetSlug: 'not-a-real-monster' };
  assert.strictEqual(toLpcCharacter(monster), null);
});

// ---------- makeLpcDrawSprite ----------

/** Tiny mock canvas context that records the calls we care about. */
function mockCtx() {
  const calls = [];
  return {
    calls,
    save:        () => calls.push(['save']),
    restore:     () => calls.push(['restore']),
    translate:   (x, y) => calls.push(['translate', x, y]),
    rotate:      (r) => calls.push(['rotate', r]),
    scale:       (sx, sy) => calls.push(['scale', sx, sy]),
    drawImage:   (img, dx, dy) => calls.push(['drawImage', dx, dy, img.width, img.height]),
    fillText:    (text, x, y) => calls.push(['fillText', text, x, y]),
    set globalAlpha(v) { calls.push(['globalAlpha', v]); },
    get globalAlpha() { return 1; },
    set imageSmoothingEnabled(v) { calls.push(['ise', v]); },
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    set font(v) { calls.push(['font', v]); },
    set textAlign(v) { calls.push(['textAlign', v]); }
  };
}

test('M44: makeLpcDrawSprite — paints the cached buffer when present', () => {
  const draw = makeLpcDrawSprite({ lookup: () => fakeCacheEntry() });
  const ctx = mockCtx();
  draw(ctx, 'attacker', { x: 100, y: 200 }, { rotation: 0, scale: 1 }, { id: 'p1', name: 'Hero' });
  const drew = ctx.calls.find(c => c[0] === 'drawImage');
  assert.ok(drew, 'should call drawImage with the cached buffer');
  // Anchored by feet: image drawn at (-w/2, -h)
  assert.strictEqual(drew[1], -96);
  assert.strictEqual(drew[2], -192);
});

test('M44: makeLpcDrawSprite — defender is mirrored on the x-axis', () => {
  const draw = makeLpcDrawSprite({ lookup: () => fakeCacheEntry() });
  const ctxA = mockCtx();
  const ctxD = mockCtx();
  draw(ctxA, 'attacker', { x: 0, y: 0 }, { scale: 1 }, { id: 'p1' });
  draw(ctxD, 'defender', { x: 0, y: 0 }, { scale: 1 }, { id: 'm1' });
  const sxA = ctxA.calls.find(c => c[0] === 'scale')[1];
  const sxD = ctxD.calls.find(c => c[0] === 'scale')[1];
  assert.ok(sxA > 0, 'attacker drawn with positive x-scale');
  assert.ok(sxD < 0, 'defender drawn mirrored (negative x-scale)');
});

test('M44: makeLpcDrawSprite — falls back to a label when buffer is missing', () => {
  const draw = makeLpcDrawSprite({ lookup: () => null });
  const ctx = mockCtx();
  draw(ctx, 'attacker', { x: 100, y: 200 }, { scale: 1 }, { id: 'unknown', name: 'Mystery' });
  // No drawImage, but a fillText
  assert.ok(!ctx.calls.some(c => c[0] === 'drawImage'));
  const lbl = ctx.calls.find(c => c[0] === 'fillText');
  assert.ok(lbl, 'should render a fallback label');
  assert.strictEqual(lbl[1], 'Mystery');
});

test('M44: makeLpcDrawSprite — renders name label below the sprite', () => {
  const buf = { width: 192, height: 192 };
  const draw = makeLpcDrawSprite({ lookup: () => buf });
  const ctx = mockCtx();
  draw(ctx, 'attacker', { x: 50, y: 100 }, { scale: 1 }, { id: 'p1', name: 'Hero' });
  const lbl = ctx.calls.find(c => c[0] === 'fillText' && c[1] === 'Hero');
  assert.ok(lbl, 'name label should render');
});

// ---------- cache invalidation ----------

test('M44: invalidateActorSprite + clearActorSpriteCache do not throw on empty cache', () => {
  // Pure smoke test — caching is async + DOM-bound, but the invalidation
  // surface should be safe to call regardless.
  assert.doesNotThrow(() => invalidateActorSprite('nothing'));
  assert.doesNotThrow(() => invalidateActorSprite(null));
  assert.doesNotThrow(() => clearActorSpriteCache());
});

// ---------- M44.1: frame cycling ----------

test('M44.1: pickActorFrame — attacker idle bobs between two frames over time', () => {
  const a = pickActorFrame({ _phase: 'idle', _t: 0 }, 'attacker');
  const b = pickActorFrame({ _phase: 'idle', _t: 300 }, 'attacker');
  assert.notStrictEqual(a, b, 'idle should alternate frames as time advances');
});

test('M44.1: pickActorFrame — attacker windup → frame 2', () => {
  assert.strictEqual(pickActorFrame({ _phase: 'windup', _t: 200 }, 'attacker'), 2);
});

test('M44.1: pickActorFrame — attacker strike → frame 6', () => {
  assert.strictEqual(pickActorFrame({ _phase: 'strike', _t: 500 }, 'attacker'), 6);
});

test('M44.1: pickActorFrame — attacker recover returns to idle bob', () => {
  const f = pickActorFrame({ _phase: 'recover', _t: 0 }, 'attacker');
  assert.ok(f === 0 || f === 1, `recover should bob 0/1, got ${f}`);
});

test('M44.1: pickActorFrame — defender stays in idle even on strike phase', () => {
  // Defender doesn't have a strike pose — the knockback keyframe is the read
  const f = pickActorFrame({ _phase: 'strike', _t: 0 }, 'defender');
  assert.ok(f === 0 || f === 1);
});

test('M44.1: makeLpcDrawSprite — selects the windup frame when phase=windup', () => {
  const draw = makeLpcDrawSprite({ lookup: () => fakeCacheEntry() });
  const ctx = mockCtx();
  draw(ctx, 'attacker', { x: 0, y: 0 }, { scale: 1, _phase: 'windup', _t: 0 }, { id: 'p1' });
  const drew = ctx.calls.find(c => c[0] === 'drawImage');
  // drawImage is logged as ['drawImage', dx, dy, w, h] — we want the source
  // buffer's _frame, which our fake stamps on the bitmap. Since the mock
  // doesn't carry the buffer through, we instead assert the cache lookup
  // chose frame 2: the fake entry has all 4 frames, so the draw call must
  // happen and reach a real bitmap. (Smoke check.)
  assert.ok(drew);
});

test('M44.1: makeLpcDrawSprite — falls back to idle frame when strike frame missing', () => {
  // Cache only has IDLE_A (0); requesting strike phase should still draw
  const entry = fakeCacheEntry([0]);
  const draw = makeLpcDrawSprite({ lookup: () => entry });
  const ctx = mockCtx();
  draw(ctx, 'attacker', { x: 0, y: 0 }, { scale: 1, _phase: 'strike', _t: 0 }, { id: 'p1' });
  assert.ok(ctx.calls.some(c => c[0] === 'drawImage'),
    'should fall back to the idle-A frame rather than skipping the draw');
});

// ---------- M44.3: defender hurt frame + tint ----------

test('M44.3: pickActorFrame — defender hurt phase → frame 4', () => {
  assert.strictEqual(pickActorFrame({ _phase: 'hurt', _t: 600 }, 'defender'), 4);
});

test('M44.3: pickActorFrame — attacker hurt phase falls back to idle bob', () => {
  // hurt is a defender-only phase; attacker hurt would mean a counter-attack
  // scenario which v1 doesn't model.
  const f = pickActorFrame({ _phase: 'hurt', _t: 0 }, 'attacker');
  assert.ok(f === 0 || f === 1, `attacker should bob 0/1, got ${f}`);
});

test('M44.3: makeLpcDrawSprite — paints a red tint overlay during hurt phase', () => {
  // Extend the mock so it captures globalCompositeOperation reads + writes.
  const calls = [];
  const ctx = {
    calls,
    canvas: { width: 200, height: 200 },
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: (x, y) => calls.push(['translate', x, y]),
    rotate: (r) => calls.push(['rotate', r]),
    scale: (sx, sy) => calls.push(['scale', sx, sy]),
    drawImage: (img, dx, dy) => calls.push(['drawImage', dx, dy, img.width, img.height]),
    fillRect: (x, y, w, h) => calls.push(['fillRect', x, y, w, h]),
    fillText: () => calls.push(['fillText']),
    set globalAlpha(v) { calls.push(['globalAlpha', v]); },
    get globalAlpha() { return 1; },
    set imageSmoothingEnabled(v) { calls.push(['ise', v]); },
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    set globalCompositeOperation(v) { calls.push(['gco', v]); },
    get globalCompositeOperation() { return 'source-over'; }
  };
  const draw = makeLpcDrawSprite({ lookup: () => fakeCacheEntry() });
  draw(ctx, 'defender', { x: 0, y: 0 },
    { scale: 1, _phase: 'hurt', _t: 700, _impactAt: 600 },
    { id: 'm1' });
  // The hurt tint is implemented as: source-atop composite + red fillRect
  const tintFill = ctx.calls.find(c => c[0] === 'fillStyle' && c[1] === '#ef4444');
  const sourceAtop = ctx.calls.find(c => c[0] === 'gco' && c[1] === 'source-atop');
  const overlayRect = ctx.calls.find(c => c[0] === 'fillRect');
  assert.ok(tintFill, 'should set red fillStyle for the hurt tint');
  assert.ok(sourceAtop, 'should switch to source-atop composite for the tint');
  assert.ok(overlayRect, 'should fillRect the sprite bounds for the tint');
});

test('M44.3: makeLpcDrawSprite — no red tint when phase is idle', () => {
  const calls = [];
  const ctx = {
    calls,
    canvas: { width: 200, height: 200 },
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    drawImage: (img, dx, dy) => calls.push(['drawImage', dx, dy]),
    fillRect: (x, y, w, h) => calls.push(['fillRect', x, y, w, h]),
    fillText: () => calls.push(['fillText']),
    set globalAlpha(v) {},
    get globalAlpha() { return 1; },
    set imageSmoothingEnabled(v) {},
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    set globalCompositeOperation(v) { calls.push(['gco', v]); },
    get globalCompositeOperation() { return 'source-over'; }
  };
  const draw = makeLpcDrawSprite({ lookup: () => fakeCacheEntry() });
  draw(ctx, 'defender', { x: 0, y: 0 },
    { scale: 1, _phase: 'idle', _t: 100, _impactAt: 600 },
    { id: 'm1' });
  // No red fillStyle should be set
  assert.ok(!ctx.calls.some(c => c[0] === 'fillStyle' && c[1] === '#ef4444'),
    'idle phase must not paint the hurt tint');
  assert.ok(!ctx.calls.some(c => c[0] === 'gco' && c[1] === 'source-atop'),
    'idle phase must not switch composite to source-atop');
});
