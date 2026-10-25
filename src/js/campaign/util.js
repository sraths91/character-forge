/**
 * M65 — small pure helpers shared by the campaign rules.
 * No DOM, no `node:` imports, no rng.
 */

/** JSON deep clone (state_json / sheet_json are plain JSON). */
export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * 5e ability modifier of a score.
 * @param {number} score
 * @returns {number}
 */
export function abilityMod(score) {
  return Math.floor(((Number(score) || 10) - 10) / 2);
}

/**
 * A sheet's modifier for `stat` (abilityModifiers, else derived from abilityScores).
 * @param {object} sheet
 * @param {'STR'|'DEX'|'CON'|'INT'|'WIS'|'CHA'} stat
 * @returns {number}
 */
export function sheetMod(sheet, stat) {
  const m = sheet?.abilityModifiers?.[stat];
  if (Number.isFinite(m)) return m;
  return abilityMod(sheet?.abilityScores?.[stat]);
}

/**
 * Total character level (sheet.level, else the sum of class levels; min 1).
 * @param {object} sheet
 * @returns {number}
 */
export function sheetLevel(sheet) {
  if (Number.isFinite(sheet?.level) && sheet.level > 0) return sheet.level;
  const sum = (sheet?.classes || []).reduce((a, c) => a + (Number(c?.level) || 0), 0);
  return sum > 0 ? sum : 1;
}

/**
 * Hit die of `className` on a sheet (state hit dice, sheet hitDice, then
 * the progression ladder); null when unknown.
 * @param {object} sheet
 * @param {object} state
 * @param {string} className
 * @returns {number|null}
 */
export function hitDieOf(sheet, state, className) {
  return Number(state?.hitDice?.[className]?.die)
    || Number(sheet?.hitDice?.[className]?.die)
    || Number(sheet?.progression?.[className]?.hitDie)
    || null;
}

/**
 * Record a leaf change for a run event (`{path, before, after}`), skipping no-ops.
 * @param {{path: string, before: unknown, after: unknown}[]} deltas
 * @param {string} path
 * @param {unknown} before
 * @param {unknown} after
 */
export function pushDelta(deltas, path, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  deltas.push({ path, before: clone(before), after: clone(after) });
}
