import { test } from 'node:test';
import assert from 'node:assert';
import { hash2, makeValueNoise2D, fbm2D } from '../js/scene/noise.js';

// ---------- hash2 ----------

test('map-noise: hash2 — output is in [0, 1)', () => {
  for (let i = 0; i < 200; i++) {
    const v = hash2(12345, i, i * 7);
    assert.ok(v >= 0 && v < 1, `hash2 out of range: ${v}`);
  }
});

test('map-noise: hash2 — deterministic for same (seed,x,y)', () => {
  assert.strictEqual(hash2(99, 3, 4), hash2(99, 3, 4));
  assert.strictEqual(hash2(0, -5, 10), hash2(0, -5, 10));
});

test('map-noise: hash2 — decorrelates axes (x,y) != (y,x) generally', () => {
  // Not a hard guarantee for every pair, but the multiplier choice
  // should make swapped coords differ for this sample.
  let differ = 0;
  for (let i = 1; i < 50; i++) {
    if (hash2(7, i, i + 1) !== hash2(7, i + 1, i)) differ++;
  }
  assert.ok(differ > 40, `expected most swapped pairs to differ, got ${differ}/49`);
});

test('map-noise: hash2 — different seeds give different fields', () => {
  assert.notStrictEqual(hash2(1, 2, 3), hash2(2, 2, 3));
});

// ---------- makeValueNoise2D ----------

test('map-noise: value noise — output in [0,1) and smooth', () => {
  const n = makeValueNoise2D(42);
  for (let i = 0; i < 100; i++) {
    const v = n(i * 0.3, i * 0.17);
    assert.ok(v >= 0 && v < 1, `noise out of range: ${v}`);
  }
});

test('map-noise: value noise — integer lattice points equal their hash', () => {
  const seed = 7;
  const n = makeValueNoise2D(seed);
  // At integer coords the bilinear blend collapses to the corner hash.
  assert.ok(Math.abs(n(3, 5) - hash2(seed, 3, 5)) < 1e-9);
  assert.ok(Math.abs(n(0, 0) - hash2(seed, 0, 0)) < 1e-9);
});

test('map-noise: value noise — continuity (adjacent samples close)', () => {
  const n = makeValueNoise2D(11);
  let maxJump = 0;
  let prev = n(0, 0);
  for (let i = 1; i < 200; i++) {
    const cur = n(i * 0.05, 0);
    maxJump = Math.max(maxJump, Math.abs(cur - prev));
    prev = cur;
  }
  // A 0.05-step should never jump more than the lattice span allows.
  assert.ok(maxJump < 0.2, `value noise not smooth, max jump ${maxJump}`);
});

test('map-noise: value noise — deterministic per seed', () => {
  const a = makeValueNoise2D(123);
  const b = makeValueNoise2D(123);
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(a(i * 0.4, i * 0.9), b(i * 0.4, i * 0.9));
  }
});

// ---------- fbm2D ----------

test('map-noise: fbm2D — output normalized to [0,1]', () => {
  const n = makeValueNoise2D(5);
  for (let i = 0; i < 100; i++) {
    const v = fbm2D(n, i * 0.2, i * 0.3, { octaves: 4 });
    assert.ok(v >= 0 && v <= 1, `fbm out of range: ${v}`);
  }
});

test('map-noise: fbm2D — more octaves still bounded', () => {
  const n = makeValueNoise2D(8);
  const v = fbm2D(n, 1.5, 2.5, { octaves: 8, persistence: 0.6 });
  assert.ok(v >= 0 && v <= 1);
});

test('map-noise: fbm2D — deterministic', () => {
  const n = makeValueNoise2D(2024);
  const a = fbm2D(n, 3.3, 4.4, { octaves: 5 });
  const b = fbm2D(n, 3.3, 4.4, { octaves: 5 });
  assert.strictEqual(a, b);
});

test('map-noise: fbm2D — octaves:1 equals the base sampler', () => {
  const n = makeValueNoise2D(3);
  const v = fbm2D(n, 2.2, 1.1, { octaves: 1, frequency: 1 });
  assert.ok(Math.abs(v - n(2.2, 1.1)) < 1e-9);
});
