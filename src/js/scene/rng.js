/**
 * M64 — RNG plumbing for the combat engine.
 *
 * Every die the engine rolls goes through an injected `rng` function
 * (() → [0, 1)). There is deliberately no `Math.random` fallback: one
 * missed argument used to silently de-seed a whole simulation (the
 * concentration-save leak found in the M64 review). Engine entry points
 * call `requireRng` so a missing rng fails loudly at the call site.
 *
 * The seeded generator is mulberry32. Its whole state is one uint32, so
 * `createRng` exposes it via `.state()` → `{ algo: 'mulberry32', s }`:
 * plain JSON a server can persist in an encounter snapshot and later
 * hand back to `createRng(state)` to resume the exact same stream.
 *
 * Pure module, no imports — safe to load in the browser, in Node and in
 * a worker.
 */

/** Algorithm tag carried in every serialized RNG state. */
export const RNG_ALGO = 'mulberry32';

/**
 * Assert that `rng` is a callable RNG and return it.
 *
 * @param {unknown} rng — candidate RNG function
 * @param {string} where — caller name, used in the error message
 * @returns {function(): number} the same rng
 * @throws {TypeError} when rng is not a function
 */
export function requireRng(rng, where) {
  if (typeof rng !== 'function') {
    throw new TypeError(`${where}: rng is required (pass a seeded rng or Math.random explicitly)`);
  }
  return rng;
}

/**
 * mulberry32 output function: maps an already-advanced uint32 state to
 * a float in [0, 1). Shared by createRng (and therefore seedRng).
 *
 * @param {number} s — uint32 state after the +0x6D2B79F5 step
 * @returns {number} float in [0, 1)
 */
export function mulberry32Output(s) {
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * @typedef {object} RngState
 * @property {'mulberry32'} [algo] — defaults to 'mulberry32'; anything else throws
 * @property {number} s — uint32 generator state (coerced with >>> 0)
 */

/**
 * Create a seeded, serializable RNG.
 *
 * `createRng({ s: seed })` starts a stream; `createRng(rng.state())`
 * (or the JSON round-trip of it) resumes it exactly where it left off.
 *
 * @param {RngState} state
 * @returns {(function(): number) & { state: function(): { algo: 'mulberry32', s: number } }}
 * @throws {TypeError} on a missing / non-integer `s` or an unknown algo
 */
export function createRng(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('createRng: state object { s } is required');
  }
  if (state.algo !== undefined && state.algo !== RNG_ALGO) {
    throw new TypeError(`createRng: unsupported algo "${state.algo}" (expected "${RNG_ALGO}")`);
  }
  if (!Number.isInteger(state.s)) {
    throw new TypeError('createRng: state.s must be an integer');
  }
  let s = state.s >>> 0;
  const rng = function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    return mulberry32Output(s);
  };
  rng.state = () => ({ algo: RNG_ALGO, s });
  return rng;
}
