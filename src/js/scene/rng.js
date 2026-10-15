/**
 * M64 — RNG plumbing for the combat engine.
 *
 * Every die the engine rolls goes through an injected `rng` function
 * (() → [0, 1)). There is deliberately no `Math.random` fallback: one
 * missed argument used to silently de-seed a whole simulation (the
 * concentration-save leak found in the M64 review). Engine entry points
 * call `requireRng` so a missing rng fails loudly at the call site.
 *
 * Pure module, no imports — safe to load in the browser, in Node and in
 * a worker.
 */

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
