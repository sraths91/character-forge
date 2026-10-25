/**
 * M65 — test builders for the campaign rules: a fully rested state_json v1
 * for a parsed sheet (E6's `initialRunState`, the shared contract), plus
 * scripted rngs.
 */
import { initialRunState } from '../../js/shared/run-state.js';

/**
 * A rested state_json v1 for a parsed sheet, with top-level overrides.
 * @param {object} sheet — parseCharacter output
 * @param {object} [over] — fields to override
 * @returns {object}
 */
export function restedState(sheet, over = {}) {
  return { ...initialRunState(sheet), ...JSON.parse(JSON.stringify(over)) };
}

/**
 * A deterministic rng that returns the given floats in order (cycling).
 * @param {number[]} values — each in [0, 1)
 * @returns {function(): number}
 */
export function scriptedRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

/** rng float that makes a dN roll come up `face`. */
export function faceFloat(face, sides) {
  return (face - 1 + 0.5) / sides;
}
