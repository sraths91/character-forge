/**
 * M64 H2 — determinism tripwires for golden tests.
 *
 * Install BEFORE importing any engine module (use a dynamic import after
 * calling installTripwires) so even module-load-time calls are caught.
 * node:test runs each test file in its own process, so replacing these
 * globals cannot leak into other suites.
 */

/** The frozen wall clock every golden run sees (2026-10-14T00:00:00Z). */
export const FROZEN_NOW = 1791936000000;

/**
 * Replace Math.random with a thrower and freeze Date.now.
 * @returns {() => void} restore function
 */
export function installTripwires() {
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => {
    throw new Error('unseeded rng: Math.random called on the engine path (golden tripwire, M64 H2)');
  };
  Date.now = () => FROZEN_NOW;
  return () => { Math.random = realRandom; Date.now = realNow; };
}
