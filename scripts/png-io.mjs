// M60 Phase 1 — PNG file I/O for the sprite-prep pipeline.
//
// Thin wrapper around pngjs (devDep, pure-JS, uses node:zlib — zero
// runtime deps). pngjs ships as CJS, so under ESM we default-import then
// destructure (`import pkg from 'pngjs'; const { PNG } = pkg`) — a named
// `import { PNG }` is not guaranteed for a CJS module. (pngjs3, the ESM
// fork, bundles browserify-zlib and breaks in Node, so plain pngjs it is.)
//
// The rest of the pipeline works on a plain `{ width, height, rgba }`
// where `rgba` is a tightly-packed RGBA byte array (no row padding);
// pngjs returns exactly that as `.data` at `idx = (width*y + x) << 2`.
// Keeping pngjs at this boundary lets the transforms stay pure +
// canvas-free.

import { readFileSync, writeFileSync } from 'node:fs';
import pkg from 'pngjs';

const { PNG } = pkg;

/**
 * Read a PNG into `{ width, height, rgba }`. pngjs normalizes palette /
 * grayscale / 16-bit / tRNS to 8-bit RGBA, so callers always get 4
 * tightly-packed bytes per pixel regardless of the source encoding.
 * `rgba` is a Node Buffer (a Uint8Array subclass) of length w*h*4.
 */
export function readPng(path) {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, rgba: png.data };
}

/**
 * Encode `{ width, height, rgba }` to a PNG file. pngjs re-filters
 * adaptively on write, so the output bytes won't match any prior file
 * byte-for-byte — but a read→write→read round-trip preserves the RGBA
 * array exactly (which is the invariant the tests assert).
 */
export function writePng(path, { width, height, rgba }) {
  const expected = width * height * 4;
  if (!rgba || rgba.length !== expected) {
    throw new Error(`writePng: rgba length ${rgba?.length} != ${expected} (w=${width} h=${height})`);
  }
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  writeFileSync(path, PNG.sync.write(png));
}
