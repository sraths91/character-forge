// M60 Phase 1 — pure pixel transforms for the sprite-prep pipeline.
//
// Every function operates on a plain `{ width, height, rgba }` image
// where `rgba` is a tightly-packed RGBA `Uint8Array` of length
// `width*height*4` (the shape png-io.mjs reads/writes). No I/O, no
// canvas — pure + deterministic, so they unit-test on synthetic arrays.
// Each returns a FRESH `Uint8Array(w*h*4)` so png-io's writePng never
// receives a mis-sized or aliased buffer.

/** Read the RGBA tuple at (x, y). */
function px(img, x, y) {
  const i = (img.width * y + x) << 2;
  const d = img.rgba;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

/** Write the RGBA tuple at (x, y) into `out` (w = outW). */
function put(out, outW, x, y, r, g, b, a) {
  const i = (outW * y + x) << 2;
  out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
}

/**
 * Integer nearest-neighbor downscale by `factor` (e.g. 8 for 512→64).
 *
 * Samples the CELL CENTER (`x*factor + ⌊factor/2⌋`), not the top-left:
 * for art upscaled by exactly `factor` they're identical within a flat
 * block, but if the source has a sub-pixel phase the center is far more
 * likely to land inside the intended block than on a boundary seam.
 *
 * Rejects non-integer / non-dividing factors — a clean integer factor
 * is a precondition the Phase-0 measurement establishes.
 */
export function nnDownscale(img, factor) {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`nnDownscale: factor must be a positive integer, got ${factor}`);
  }
  if (img.width % factor !== 0 || img.height % factor !== 0) {
    throw new Error(`nnDownscale: ${img.width}×${img.height} not divisible by ${factor}`);
  }
  const outW = img.width / factor;
  const outH = img.height / factor;
  const off = Math.floor(factor / 2);
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const [r, g, b, a] = px(img, x * factor + off, y * factor + off);
      put(out, outW, x, y, r, g, b, a);
    }
  }
  return { width: outW, height: outH, rgba: out };
}

/**
 * Slice an image into a `cols × rows` grid of equal cells (e.g. a
 * 4-direction strip → 4 frames). Returns frames in row-major order.
 * Rejects a grid that doesn't divide the image evenly.
 */
export function sliceGrid(img, cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(`sliceGrid: cols/rows must be positive integers, got ${cols}×${rows}`);
  }
  if (img.width % cols !== 0 || img.height % rows !== 0) {
    throw new Error(`sliceGrid: ${img.width}×${img.height} not divisible by ${cols}×${rows}`);
  }
  const cw = img.width / cols;
  const ch = img.height / rows;
  const frames = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const out = new Uint8Array(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const [r, g, b, a] = px(img, gx * cw + x, gy * ch + y);
          put(out, cw, x, y, r, g, b, a);
        }
      }
      frames.push({ width: cw, height: ch, rgba: out });
    }
  }
  return frames;
}

/**
 * Key a flat background colour to transparency. Any pixel within
 * `tolerance` (per-channel Chebyshev RGB distance, 0–255) of `{r,g,b}`
 * has its alpha set to 0; everything else is copied unchanged.
 *
 * This is a flat-fill matte, NOT a general background remover — it's
 * only reliable because it runs AFTER the downscale, which averages
 * most anti-aliased fringe away. `countColors` surfaces any residual
 * fringe as extra colours.
 */
export function keyBackground(img, { r, g, b }, tolerance = 8) {
  const out = new Uint8Array(img.rgba.length);
  out.set(img.rgba);
  for (let i = 0; i < out.length; i += 4) {
    if (Math.abs(out[i] - r) <= tolerance &&
        Math.abs(out[i + 1] - g) <= tolerance &&
        Math.abs(out[i + 2] - b) <= tolerance) {
      out[i + 3] = 0;
    }
  }
  return { width: img.width, height: img.height, rgba: out };
}

/**
 * Count distinct opaque-ish colours (alpha > 0). A QA signal: a clean
 * pixel-art sprite has a small palette; a high count flags AA fringe,
 * banding, or a noisy background that survived keying. Returns the
 * integer count; fully-transparent pixels are excluded.
 */
export function countColors(img) {
  const seen = new Set();
  const d = img.rgba;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    seen.add((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]);
  }
  return seen.size;
}
