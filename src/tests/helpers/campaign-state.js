/**
 * M65 — test builders for the campaign rules: a fully rested state_json v1
 * for a parsed sheet. (E6's src/js/shared/run-state.js owns the real
 * `initialRunState`; once it lands on main, these tests should validate
 * against it.)
 */

/**
 * A rested state_json v1 for a parsed sheet.
 * @param {object} sheet — parseCharacter output
 * @param {object} [over] — fields to override
 * @returns {object}
 */
export function restedState(sheet, over = {}) {
  const spell = {};
  for (const lvl of Object.keys(sheet?.spellSlotTable?.spell || {})) spell[lvl] = { spent: 0 };
  const hitDice = {};
  for (const [cls, h] of Object.entries(sheet?.hitDice || {})) hitDice[cls] = { die: h.die, spent: 0 };
  const resources = {};
  for (const [k, r] of Object.entries(sheet?.resources || {})) {
    resources[k] = { label: r.label, max: r.max, spent: 0, recovery: JSON.parse(JSON.stringify(r.recovery || [])) };
  }
  return {
    schema_v: 1,
    hp: { current: sheet?.hp?.max ?? 1, temp: 0 },
    deathSaves: { successes: 0, failures: 0, stable: false },
    hitDice,
    slots: { spell, pact: sheet?.spellSlotTable?.pact ? { spent: 0 } : {} },
    resources,
    conditions: [],
    conditionMeta: {},
    exhaustion: 0,
    inspiration: false,
    currency: { ...(sheet?.currency || { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }) },
    concentration: null,
    ...over
  };
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
