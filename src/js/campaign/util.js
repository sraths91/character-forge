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

/**
 * Slots left between nodes: levelled slots of exactly `level` (sheet max −
 * state spent), or the pact slots when `kind` is 'pact' (pact slot level
 * must equal `level`).
 * @param {object} sheet — run sheet (spellSlotTable)
 * @param {object} state — state_json v1 (slots)
 * @param {number} level
 * @param {'spell'|'pact'} [kind]
 * @returns {number}
 */
export function slotsLeft(sheet, state, level, kind = 'spell') {
  if (kind === 'pact') {
    const pact = sheet?.spellSlotTable?.pact;
    if (!pact || Number(pact.level) !== Number(level)) return 0;
    return Math.max(0, (Number(pact.max) || 0) - (Number(state?.slots?.pact?.spent) || 0));
  }
  const max = Number(sheet?.spellSlotTable?.spell?.[level]) || 0;
  return Math.max(0, max - (Number(state?.slots?.spell?.[level]?.spent) || 0));
}

/**
 * The lowest slot at or above `minLevel` that is left (levelled first, then
 * pact), or null.
 * @param {object} sheet
 * @param {object} state
 * @param {number} minLevel
 * @returns {{level: number, kind: 'spell'|'pact'}|null}
 */
export function lowestSlotAtLeast(sheet, state, minLevel) {
  for (let lv = Math.max(1, minLevel); lv <= 9; lv++) {
    if (slotsLeft(sheet, state, lv, 'spell') > 0) return { level: lv, kind: 'spell' };
  }
  const pact = sheet?.spellSlotTable?.pact;
  if (pact && Number(pact.level) >= minLevel && slotsLeft(sheet, state, pact.level, 'pact') > 0) return { level: Number(pact.level), kind: 'pact' };
  return null;
}

/**
 * Spend one slot in a state_json clone (caller checked availability).
 * @param {object} state — mutated
 * @param {{level: number, kind: 'spell'|'pact'}} slot
 */
export function spendSlotIn(state, slot) {
  state.slots = { spell: {}, pact: {}, ...(state.slots || {}) };
  if (slot.kind === 'pact') {
    state.slots.pact = { ...(state.slots.pact || {}), spent: (Number(state.slots.pact?.spent) || 0) + 1 };
  } else {
    state.slots.spell = { ...(state.slots.spell || {}) };
    const cur = state.slots.spell[slot.level] || { spent: 0 };
    state.slots.spell[slot.level] = { ...cur, spent: (Number(cur.spent) || 0) + 1 };
  }
}

/**
 * The sheet's spell record by name (case-insensitive), or null.
 * @param {object} sheet
 * @param {string} name
 * @returns {object|null}
 */
export function sheetSpell(sheet, name) {
  const n = String(name || '').trim().toLowerCase();
  return (sheet?.spells || []).find(s => String(s?.name || '').trim().toLowerCase() === n) || null;
}
