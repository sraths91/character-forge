/**
 * M64 C7 — client message ids (`cid`), ULID-shaped.
 *
 * 26 Crockford base32 chars: 10 for the millisecond timestamp, 16 for
 * randomness. Ids made in the same millisecond increment the random part,
 * so a generator's ids sort in creation order. The server keeps the last
 * 256 cids per member to de-dupe retries (R1 §3.3); ids only need to be
 * unique per member, not cryptographically strong. No dependencies.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

function defaultRandomBytes(n) {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(out);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function encodeTime(ms) {
  let t = ms;
  let s = '';
  for (let i = 0; i < TIME_LEN; i++) {
    s = ALPHABET[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s;
}

/** Increment a base32 digit array in place; wraps to zero on overflow. */
function increment(digits) {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] < 31) { digits[i]++; return; }
    digits[i] = 0;
  }
}

/**
 * Create a cid generator.
 * @param {{now?: () => number, randomBytes?: (n: number) => Uint8Array}} [opts]
 * @returns {() => string} returns a new 26-char id per call
 */
export function createCidGenerator({ now = () => Date.now(), randomBytes = defaultRandomBytes } = {}) {
  let lastTime = -1;
  let lastRand = null;
  return function nextCid() {
    const t = Math.max(0, Math.floor(Number(now()) || 0));
    if (t <= lastTime && lastRand) {
      increment(lastRand);
    } else {
      lastTime = t;
      lastRand = Array.from(randomBytes(RAND_LEN), b => b & 31);
    }
    return encodeTime(lastTime) + lastRand.map(d => ALPHABET[d]).join('');
  };
}

/** Is `s` a well-formed cid from this module? */
export function isCid(s) {
  return typeof s === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}

/** Module-level generator using Date.now and crypto.getRandomValues. */
export const newCid = createCidGenerator();
