import { test } from 'node:test';
import assert from 'node:assert';
import { getHeroSprite, clearHeroAtlas, HERO_CONTENT_FRACTION } from '../js/scene/hero-sprites.js';

test('hero-sprites: returns null headless (no canvas) so callers fall back', () => {
  // Node has no document / OffscreenCanvas → makeBuffer null → null sprite.
  clearHeroAtlas();
  assert.strictEqual(getHeroSprite('tree', 0, '#2f5d36'), null);
  assert.strictEqual(getHeroSprite('rock', 1, '#7d7d72'), null);
  assert.strictEqual(getHeroSprite('bush', 2, '#3f6638'), null);
});

test('hero-sprites: unknown type returns null', () => {
  assert.strictEqual(getHeroSprite('dragon', 0, '#fff'), null);
});

test('hero-sprites: HERO_CONTENT_FRACTION is a sane fraction', () => {
  assert.ok(HERO_CONTENT_FRACTION > 0 && HERO_CONTENT_FRACTION < 1);
});

test('hero-sprites: bakes + caches when a canvas factory is available', () => {
  // Simulate a browser-ish env with a minimal canvas factory so the bake
  // path runs and the cache returns a stable object.
  const realDoc = globalThis.document;
  let created = 0;
  const fakeCtx = makeFakeCtx();
  globalThis.document = {
    createElement() {
      created++;
      return { width: 0, height: 0, getContext: () => fakeCtx };
    }
  };
  try {
    clearHeroAtlas();
    const a = getHeroSprite('tree', 0, '#2f5d36');
    assert.ok(a, 'should bake a sprite canvas');
    const createdAfterFirst = created;
    const b = getHeroSprite('tree', 0, '#2f5d36');
    assert.strictEqual(a, b, 'same key returns the cached canvas');
    assert.strictEqual(created, createdAfterFirst, 'cache hit does not rebake');
    // Different variant / color → different sprite.
    const c = getHeroSprite('tree', 1, '#2f5d36');
    assert.notStrictEqual(a, c);
    const d = getHeroSprite('rock', 0, '#7d7d72');
    assert.ok(d);
  } finally {
    globalThis.document = realDoc;
    clearHeroAtlas();
  }
});

/** A no-op 2D context that absorbs every call the bakers make. */
function makeFakeCtx() {
  const noop = () => {};
  return new Proxy({
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop })
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // setters (fillStyle etc.) and methods (arc, fill, …) → no-op fn.
      return noop;
    },
    set() { return true; }
  });
}
