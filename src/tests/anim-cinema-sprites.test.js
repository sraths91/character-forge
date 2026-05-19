import { test } from 'node:test';
import assert from 'node:assert';
import {
  toLpcCharacter, makeLpcDrawSprite,
  invalidateActorSprite, clearActorSpriteCache
} from '../js/anim/cinema-sprites.js';

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
  const buf = { width: 192, height: 192 };
  const draw = makeLpcDrawSprite({ lookup: () => buf });
  const ctx = mockCtx();
  draw(ctx, 'attacker', { x: 100, y: 200 }, { rotation: 0, scale: 1 }, { id: 'p1', name: 'Hero' });
  const drew = ctx.calls.find(c => c[0] === 'drawImage');
  assert.ok(drew, 'should call drawImage with the cached buffer');
  // Anchored by feet: image drawn at (-w/2, -h)
  assert.strictEqual(drew[1], -96);
  assert.strictEqual(drew[2], -192);
});

test('M44: makeLpcDrawSprite — defender is mirrored on the x-axis', () => {
  const buf = { width: 192, height: 192 };
  const draw = makeLpcDrawSprite({ lookup: () => buf });
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
