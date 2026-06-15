import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from '../../scripts/png-io.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'filtered-rgba.png');

/** The fixture's known pattern (see fixtures/make-filtered-rgba.py). */
function expectedPixel(x, y) {
  return [x * 60, y * 60, 30, 255 - (x + y) * 15];
}

// ---------- decode against an EXTERNAL (Paeth-filtered) encoder ----------

test('M60.1: readPng — decodes the Paeth-filtered fixture to exact RGBA', () => {
  const img = readPng(FIXTURE);
  assert.strictEqual(img.width, 4);
  assert.strictEqual(img.height, 4);
  assert.strictEqual(img.rgba.length, 4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (4 * y + x) << 2;
      const got = [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
      assert.deepStrictEqual(got, expectedPixel(x, y),
        `pixel ${x},${y} — pngjs must reverse the Paeth filter`);
    }
  }
});

test('M60.1: readPng — rgba is tightly packed (w*h*4, no row padding)', () => {
  const img = readPng(FIXTURE);
  assert.strictEqual(img.rgba.length, img.width * img.height * 4);
});

// ---------- write → read round-trips the RGBA ARRAY (not file bytes) ----------

test('M60.1: writePng → readPng round-trips the RGBA array byte-identical', () => {
  const src = readPng(FIXTURE);
  const tmp = join(tmpdir(), `cf-png-io-${process.pid}.png`);
  try {
    writePng(tmp, src);
    const back = readPng(tmp);
    assert.strictEqual(back.width, src.width);
    assert.strictEqual(back.height, src.height);
    // File bytes differ (pngjs re-filters adaptively); RGBA must not.
    assert.deepStrictEqual(Array.from(back.rgba), Array.from(src.rgba));
  } finally {
    rmSync(tmp, { force: true });
  }
});

test('M60.1: writePng — accepts a Uint8Array and rejects a mis-sized buffer', () => {
  const tmp = join(tmpdir(), `cf-png-io-size-${process.pid}.png`);
  try {
    const rgba = new Uint8Array(2 * 1 * 4);
    rgba.set([10, 20, 30, 255, 40, 50, 60, 128]);
    writePng(tmp, { width: 2, height: 1, rgba });
    const back = readPng(tmp);
    assert.deepStrictEqual(Array.from(back.rgba), [10, 20, 30, 255, 40, 50, 60, 128]);
    assert.throws(() => writePng(tmp, { width: 2, height: 2, rgba }), /length/);
  } finally {
    rmSync(tmp, { force: true });
  }
});

// ---------- indexed-color decodes to RGBA (G2: degrade, don't throw) ----------

/** CRC32 (PNG chunk checksum) — small table-free implementation. */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(tag, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, c]);
}

test('M60.1: readPng — an indexed-color (palette) PNG decodes to RGBA, not a throw', () => {
  // Minimal 1×1 indexed PNG (color type 3): one red palette entry.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 3; // 8-bit, color type 3 (indexed)
  const plte = Buffer.from([220, 30, 40]); // palette[0] = red
  const idat = deflateSync(Buffer.from([0x00, 0x00])); // filter 0, palette index 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('PLTE', plte),
    pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))
  ]);
  const tmp = join(tmpdir(), `cf-png-io-idx-${process.pid}.png`);
  try {
    writeFileSync(tmp, png);
    const img = readPng(tmp);
    assert.strictEqual(img.width, 1);
    assert.strictEqual(img.rgba.length, 4, 'palette expanded to RGBA');
    assert.deepStrictEqual([img.rgba[0], img.rgba[1], img.rgba[2]], [220, 30, 40]);
  } finally {
    rmSync(tmp, { force: true });
  }
});
