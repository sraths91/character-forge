// Pure image sniffing (M64 B10): identify PNG / JPEG / WebP by magic bytes
// and read their pixel dimensions from the header, without decoding. GIF
// and SVG are recognised only so they can be rejected by name.
// No I/O, no dependencies; works on a Buffer or Uint8Array.

/** Accepted formats: mime → file extension. */
export const IMAGE_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });

/**
 * @typedef {{ok: true, mime: string, ext: string, width: number, height: number}
 *   | {ok: false, reason: 'unsupported'|'truncated'|'gif'|'svg'|'corrupt', mime?: string}} SniffResult
 */

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function png(b) {
  // Signature (8) + IHDR chunk: length (4) "IHDR" (4) width (4) height (4).
  if (b.length < 24) return { ok: false, reason: 'truncated', mime: 'image/png' };
  if (ascii(b, 12, 4) !== 'IHDR') return { ok: false, reason: 'corrupt', mime: 'image/png' };
  return { ok: true, mime: 'image/png', ext: 'png', width: u32be(b, 16), height: u32be(b, 20) };
}

// SOFn markers that carry the frame size (not DHT C4, JPG C8, DAC CC).
const SOF = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);

function jpeg(b) {
  let o = 2;
  while (o < b.length) {
    if (b[o] !== 0xFF) return { ok: false, reason: 'corrupt', mime: 'image/jpeg' };
    while (o < b.length && b[o] === 0xFF) o++;          // fill bytes
    if (o >= b.length) break;
    const marker = b[o++];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue; // no length
    if (marker === 0xD9 || marker === 0xDA) break;      // EOI / SOS before any SOF
    if (o + 2 > b.length) break;
    const len = u16be(b, o);
    if (len < 2) return { ok: false, reason: 'corrupt', mime: 'image/jpeg' };
    if (SOF.has(marker)) {
      if (o + 7 > b.length) break;
      return { ok: true, mime: 'image/jpeg', ext: 'jpg', height: u16be(b, o + 3), width: u16be(b, o + 5) };
    }
    o += len;
  }
  return { ok: false, reason: 'truncated', mime: 'image/jpeg' };
}

function webp(b) {
  if (b.length < 30) return { ok: false, reason: 'truncated', mime: 'image/webp' };
  const chunk = ascii(b, 12, 4);
  const d = 20;   // chunk payload
  if (chunk === 'VP8 ') {
    // frame tag (3) + start code 9D 01 2A + 14-bit width / height.
    if (b[d + 3] !== 0x9D || b[d + 4] !== 0x01 || b[d + 5] !== 0x2A) return { ok: false, reason: 'corrupt', mime: 'image/webp' };
    return { ok: true, mime: 'image/webp', ext: 'webp', width: u16le(b, d + 6) & 0x3FFF, height: u16le(b, d + 8) & 0x3FFF };
  }
  if (chunk === 'VP8L') {
    if (b[d] !== 0x2F) return { ok: false, reason: 'corrupt', mime: 'image/webp' };
    const bits = b[d + 1] | (b[d + 2] << 8) | (b[d + 3] << 16) | (b[d + 4] << 24);
    return { ok: true, mime: 'image/webp', ext: 'webp', width: (bits & 0x3FFF) + 1, height: ((bits >>> 14) & 0x3FFF) + 1 };
  }
  if (chunk === 'VP8X') {
    return { ok: true, mime: 'image/webp', ext: 'webp', width: u24le(b, d + 4) + 1, height: u24le(b, d + 7) + 1 };
  }
  return { ok: false, reason: 'corrupt', mime: 'image/webp' };
}

/**
 * Identify an image from its bytes.
 * @param {Uint8Array} bytes
 * @returns {SniffResult}
 */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return png(b);
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return jpeg(b);
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return { ok: false, reason: 'gif' };
  const head = Buffer.from(b.subarray(0, 512)).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')) || head.startsWith('<!doctype svg')) return { ok: false, reason: 'svg' };
  return { ok: false, reason: 'unsupported' };
}

/** Limits for uploaded maps (M64 B10). */
export const MAP_LIMITS = Object.freeze({ maxSide: 8192, maxPixels: 16_777_216 });

/**
 * Check sniffed dimensions against the caps (8192 px per side, 16.7 MP).
 * @param {{width: number, height: number}} d
 * @param {{maxSide: number, maxPixels: number}} [limits=MAP_LIMITS]
 * @returns {string|null} why it is rejected, or null when within the caps
 */
export function dimensionProblem({ width, height }, limits = MAP_LIMITS) {
  if (!(width >= 1 && height >= 1)) return 'image has no pixels';
  if (width > limits.maxSide || height > limits.maxSide) return `each side must be at most ${limits.maxSide} px (got ${width}x${height})`;
  if (width * height > limits.maxPixels) return `at most ${limits.maxPixels} pixels (got ${width * height})`;
  return null;
}

/** Token images (M64 1.5 W6): one creature's picture, ≤ 1024 px per side. */
export const TOKEN_LIMITS = Object.freeze({ maxSide: 1024, maxPixels: 1024 * 1024 });

const EXT_MIME = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' });

/**
 * The upload rules shared by room maps and campaign assets: magic bytes
 * (PNG / JPEG / WebP; GIF and SVG refused by name), a declared
 * Content-Type or file name that disagrees with the bytes, and the
 * per-kind dimension caps.
 * @param {Uint8Array} body
 * @param {{kind?: 'map'|'token', declaredType?: string, filename?: string}} [opts]
 * @returns {{ok: true, sniff: SniffResult} | {ok: false, status: number, code: string, message: string}}
 */
export function checkImageUpload(body, { kind = 'map', declaredType = '', filename = '' } = {}) {
  const noun = kind === 'token' ? 'token image' : 'map';
  if (!body || body.length === 0) return { ok: false, status: 400, code: 'EMPTY', message: 'Send the image bytes as the request body' };
  const sniff = sniffImage(body);
  if (!sniff.ok) {
    const what = sniff.reason === 'gif' ? 'GIF' : sniff.reason === 'svg' ? 'SVG' : null;
    return {
      ok: false, status: 415, code: 'UNSUPPORTED_MEDIA',
      message: what ? `${what} ${noun}s are not accepted; use PNG, JPEG or WebP` : `Not a readable PNG, JPEG or WebP image (${sniff.reason})`
    };
  }
  const declared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== sniff.mime) {
    return { ok: false, status: 415, code: 'UNSUPPORTED_MEDIA', message: `Content-Type ${declared} does not match the image bytes (${sniff.mime})` };
  }
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename || '')?.[1]?.toLowerCase();
  if (filename && EXT_MIME[ext] !== sniff.mime) {
    return { ok: false, status: 415, code: 'UNSUPPORTED_MEDIA', message: `The file name ${filename} does not match the image bytes (${sniff.mime})` };
  }
  const problem = dimensionProblem(sniff, kind === 'token' ? TOKEN_LIMITS : MAP_LIMITS);
  if (problem) return { ok: false, status: 422, code: 'BAD_DIMENSIONS', message: problem };
  return { ok: true, sniff };
}
