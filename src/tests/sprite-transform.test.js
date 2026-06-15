import { test } from 'node:test';
import assert from 'node:assert';
import {
  nnDownscale, sliceGrid, keyBackground, countColors
} from '../../scripts/sprite-transform.mjs';

/** Build an image by a per-pixel RGBA function. */
function makeImg(width, height, fn) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const [r, g, b, a] = fn(x, y);
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return { width, height, rgba };
}
function pixelAt(img, x, y) {
  const i = (img.width * y + x) << 2;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}

// ---------- nnDownscale ----------

test('M60.1: nnDownscale — ×2 of perfectly-blocked art is exact', () => {
  // 4×4 made of 2×2 blocks; each block a distinct color → ×2 recovers it.
  const colors = [[10, 0, 0, 255], [0, 20, 0, 255], [0, 0, 30, 255], [40, 40, 40, 255]];
  const img = makeImg(4, 4, (x, y) => colors[(y >> 1) * 2 + (x >> 1)]);
  const out = nnDownscale(img, 2);
  assert.strictEqual(out.width, 2);
  assert.strictEqual(out.height, 2);
  assert.deepStrictEqual(pixelAt(out, 0, 0), colors[0]);
  assert.deepStrictEqual(pixelAt(out, 1, 0), colors[1]);
  assert.deepStrictEqual(pixelAt(out, 0, 1), colors[2]);
  assert.deepStrictEqual(pixelAt(out, 1, 1), colors[3]);
});

test('M60.1: nnDownscale — center sampling survives a phase where top-left would not', () => {
  // 4×4: a 1px noisy border around a 2×2 true-color core, blocks at
  // offset 1. Top-left sampling (x*2) would hit the noisy seam at col/row
  // 0/2; center sampling (x*2+1) lands on the real color.
  const core = [123, 45, 67, 255];
  const noise = [200, 200, 200, 255];
  const img = makeImg(4, 4, (x, y) =>
    (x === 0 || y === 0) ? noise : core);
  const out = nnDownscale(img, 2);
  // center of cell (0,0) is pixel (1,1) = core; cell (1,1) center = (3,3) = core
  assert.deepStrictEqual(pixelAt(out, 0, 0), core, 'center sample avoids the seam');
  assert.deepStrictEqual(pixelAt(out, 1, 1), core);
});

test('M60.1: nnDownscale — ×8 produces 64 from 512 (shape)', () => {
  const img = makeImg(512, 8, () => [1, 2, 3, 255]);
  const out = nnDownscale(img, 8);
  assert.strictEqual(out.width, 64);
  assert.strictEqual(out.height, 1);
  assert.strictEqual(out.rgba.length, 64 * 1 * 4);
});

test('M60.1: nnDownscale — rejects non-integer and non-dividing factors', () => {
  const img = makeImg(10, 10, () => [0, 0, 0, 255]);
  assert.throws(() => nnDownscale(img, 1.5), /integer/);
  assert.throws(() => nnDownscale(img, 3), /divisible/);   // 10 % 3 !== 0
  assert.throws(() => nnDownscale(img, 0), /integer/);
});

// ---------- sliceGrid ----------

test('M60.1: sliceGrid — 4×1 strip yields 4 cells with the right pixels', () => {
  // 8×2 strip, 4 cells of 2×2; cell k is filled with color value k.
  const img = makeImg(8, 2, (x) => { const k = x >> 1; return [k, k, k, 255]; });
  const frames = sliceGrid(img, 4, 1);
  assert.strictEqual(frames.length, 4);
  frames.forEach((f, k) => {
    assert.strictEqual(f.width, 2);
    assert.strictEqual(f.height, 2);
    assert.deepStrictEqual(pixelAt(f, 0, 0), [k, k, k, 255]);
    assert.deepStrictEqual(pixelAt(f, 1, 1), [k, k, k, 255]);
  });
});

test('M60.1: sliceGrid — 2×2 grid is row-major', () => {
  // Each quadrant a distinct color.
  const img = makeImg(4, 4, (x, y) => {
    const q = (y >> 1) * 2 + (x >> 1);
    return [q * 10, 0, 0, 255];
  });
  const frames = sliceGrid(img, 2, 2);
  assert.strictEqual(frames.length, 4);
  assert.deepStrictEqual(pixelAt(frames[0], 0, 0), [0, 0, 0, 255]);
  assert.deepStrictEqual(pixelAt(frames[1], 0, 0), [10, 0, 0, 255]);
  assert.deepStrictEqual(pixelAt(frames[2], 0, 0), [20, 0, 0, 255]);
  assert.deepStrictEqual(pixelAt(frames[3], 0, 0), [30, 0, 0, 255]);
});

test('M60.1: sliceGrid — rejects a grid that does not divide evenly', () => {
  const img = makeImg(5, 4, () => [0, 0, 0, 255]);
  assert.throws(() => sliceGrid(img, 2, 1), /divisible/);   // 5 % 2 !== 0
  assert.throws(() => sliceGrid(img, 0, 1), /positive integers/);
});

// ---------- keyBackground ----------

test('M60.1: keyBackground — keyed color → alpha 0, sprite untouched', () => {
  const bg = [120, 200, 80, 255];
  const sprite = [10, 20, 30, 255];
  const img = makeImg(2, 1, (x) => (x === 0 ? bg : sprite));
  const out = keyBackground(img, { r: 120, g: 200, b: 80 }, 8);
  assert.deepStrictEqual(pixelAt(out, 0, 0), [120, 200, 80, 0], 'bg keyed transparent');
  assert.deepStrictEqual(pixelAt(out, 1, 0), sprite, 'sprite untouched');
});

test('M60.1: keyBackground — tolerance keys near-matches but not the sprite', () => {
  const img = makeImg(3, 1, (x) =>
    [[122, 198, 82, 255], [120, 200, 80, 255], [10, 20, 30, 255]][x]);
  const out = keyBackground(img, { r: 120, g: 200, b: 80 }, 4);
  assert.strictEqual(pixelAt(out, 0, 0)[3], 0, 'within tolerance → keyed');
  assert.strictEqual(pixelAt(out, 1, 0)[3], 0, 'exact → keyed');
  assert.strictEqual(pixelAt(out, 2, 0)[3], 255, 'sprite preserved');
});

test('M60.1: keyBackground — does not mutate the input', () => {
  const img = makeImg(1, 1, () => [50, 50, 50, 255]);
  const snapshot = Array.from(img.rgba);
  keyBackground(img, { r: 50, g: 50, b: 50 }, 0);
  assert.deepStrictEqual(Array.from(img.rgba), snapshot);
});

// ---------- countColors ----------

test('M60.1: countColors — counts distinct opaque colors, ignores transparent', () => {
  // 3 opaque colors + 1 transparent pixel.
  const img = makeImg(2, 2, (x, y) => {
    const k = y * 2 + x;
    return [[1, 1, 1, 255], [2, 2, 2, 255], [3, 3, 3, 255], [9, 9, 9, 0]][k];
  });
  assert.strictEqual(countColors(img), 3);
});

test('M60.1: countColors — identical pixels count once', () => {
  const img = makeImg(4, 4, () => [7, 7, 7, 255]);
  assert.strictEqual(countColors(img), 1);
});
