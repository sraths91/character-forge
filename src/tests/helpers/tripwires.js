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
 * Replace Math.random with a thrower and freeze Date.now. With
 * `strictClock` (M65 H24, the composed run) every wall-clock read throws
 * instead: Date.now(), a no-argument `new Date()` / `Date()`, and
 * performance.now() — a run's state must come from its seed and its
 * events alone. `new Date(value)` stays legal (it reads no clock).
 * @param {{strictClock?: boolean}} [opts]
 * @returns {() => void} restore function
 */
export function installTripwires({ strictClock = false } = {}) {
  const realRandom = Math.random;
  const RealDate = globalThis.Date;
  const realNow = RealDate.now;
  const realPerfNow = globalThis.performance?.now;
  Math.random = () => {
    throw new Error('unseeded rng: Math.random called on the engine path (golden tripwire, M64 H2)');
  };
  if (!strictClock) {
    Date.now = () => FROZEN_NOW;
    return () => { Math.random = realRandom; Date.now = realNow; };
  }
  const clock = (what) => () => { throw new Error(`wall clock read: ${what} called on the run path (strict tripwire, M65 H24)`); };
  function TrippedDate(...args) {
    if (!new.target) return clock('Date()')();
    if (args.length === 0) clock('new Date()')();
    return Reflect.construct(RealDate, args, new.target);
  }
  Object.setPrototypeOf(TrippedDate, RealDate);
  TrippedDate.prototype = RealDate.prototype;
  TrippedDate.now = clock('Date.now()');
  globalThis.Date = TrippedDate;
  if (globalThis.performance) globalThis.performance.now = clock('performance.now()');
  return () => {
    Math.random = realRandom;
    globalThis.Date = RealDate;
    if (globalThis.performance) {
      delete globalThis.performance.now;   // drops the own-property shadow
      if (globalThis.performance.now !== realPerfNow) globalThis.performance.now = realPerfNow;
    }
  };
}
