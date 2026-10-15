/**
 * M64 E5 — dependency-free base64 for small binary layers (terrain flags,
 * fog bitsets). Works identically in the browser and in Node without
 * `Buffer`, `btoa` or `atob`, so the shared state helpers stay portable.
 *
 * Standard alphabet (RFC 4648 §4) with `=` padding, matching the
 * `/^[A-Za-z0-9+/]*={0,2}$/` pattern `shared/encounter-state.js` validates.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/**
 * Encode bytes as padded base64.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let out = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63];
  }
  const rest = n - i;
  if (rest === 1) {
    const v = bytes[i] << 16;
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + '==';
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(v >> 18) & 63] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + '=';
  }
  return out;
}

/**
 * Decode padded (or unpadded) base64. Invalid characters are skipped, so
 * a corrupt string yields a short array rather than throwing; callers
 * that need an exact length pad or truncate.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function base64ToBytes(str) {
  const s = typeof str === 'string' ? str : '';
  const vals = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 61) break;   // '='
    const v = code < 128 ? LOOKUP[code] : -1;
    if (v >= 0) vals.push(v);
  }
  const outLen = Math.floor((vals.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let buf = 0;
  let bits = 0;
  let o = 0;
  for (const v of vals) {
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < outLen) out[o++] = (buf >> bits) & 0xFF;
    }
  }
  return out;
}
