/**
 * M65 — spell-slot maximums from per-class DDB `levelSpellSlots` rows.
 *
 * Shared by the DDB parser (api/lib/ddb-parser.js parseSpellSlotTable)
 * and the level-up rules (level-up.js), so an imported sheet and a
 * game-leveled sheet compute slots the same way.
 *
 * Pure module: no DOM, no `node:` imports, no rng.
 */

/** PHB multiclass spellcaster table (combined caster level → slots 1..9). */
export const MULTICLASS_SLOTS = Object.freeze([
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [2, 0, 0, 0, 0, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0, 0, 0, 0], [4, 2, 0, 0, 0, 0, 0, 0, 0],
  [4, 3, 0, 0, 0, 0, 0, 0, 0], [4, 3, 2, 0, 0, 0, 0, 0, 0], [4, 3, 3, 0, 0, 0, 0, 0, 0],
  [4, 3, 3, 1, 0, 0, 0, 0, 0], [4, 3, 3, 2, 0, 0, 0, 0, 0], [4, 3, 3, 3, 1, 0, 0, 0, 0],
  [4, 3, 3, 3, 2, 0, 0, 0, 0], [4, 3, 3, 3, 2, 1, 0, 0, 0], [4, 3, 3, 3, 2, 1, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 0, 0], [4, 3, 3, 3, 2, 1, 1, 0, 0], [4, 3, 3, 3, 2, 1, 1, 1, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 0], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]
].map(r => Object.freeze(r)));

/**
 * A DDB slot row (slot counts of levels 1..9) → `{ [slotLevel]: count }`
 * with zero entries dropped.
 * @param {number[]} row
 * @returns {Object<string, number>}
 */
export function slotRowToObject(row) {
  const out = {};
  for (let i = 0; i < 9; i++) {
    const n = Number(Array.isArray(row) ? row[i] : 0) || 0;
    if (n > 0) out[i + 1] = n;
  }
  return out;
}

/**
 * True when a DDB `levelSpellSlots` table has at least one slot anywhere.
 * @param {unknown} rows
 * @returns {boolean}
 */
export function hasSlotRows(rows) {
  return Array.isArray(rows) && rows.some(row => Array.isArray(row) && row.some(n => Number(n) > 0));
}

/**
 * One caster class's slot entry at `level` (the parser's
 * `spellSlotTable.classes[]` shape).
 * @param {{name: string, level: number, rows: number[][], divisor?: number, rounding?: number}} c
 * @returns {{name: string, level: number, divisor: number, rounding: number, pact: boolean, slots: Object<string, number>}}
 */
export function casterClassEntry({ name, level, rows, divisor, rounding }) {
  const lv = Number(level) || 0;
  const row = rows[Math.min(lv, rows.length - 1)] || [];
  return {
    name,
    level: lv,
    divisor: Number(divisor) || 1,
    rounding: Number(rounding) || 1,
    pact: /warlock/i.test(String(name || '')),
    slots: slotRowToObject(row)
  };
}

/**
 * Combine per-class caster entries into the sheet's slot maximums:
 * a single non-pact caster uses its own row; several combine through the
 * PHB multiclass table at sum(level / divisor), rounded per DDB's
 * rounding flag (2 = up, otherwise down). Warlock Pact Magic stays apart
 * as `{level, max}` (shape unverified until a real Warlock export lands:
 * read as "slot count at the highest pact slot level").
 * @param {{level: number, divisor: number, rounding: number, pact: boolean, slots: Object<string, number>}[]} classes
 * @returns {{spell: Object<string, number>, pact: {level: number, max: number}|null}}
 */
export function combineSpellSlots(classes) {
  const casters = (classes || []).filter(c => !c.pact);
  let spell = {};
  if (casters.length === 1) {
    spell = { ...casters[0].slots };
  } else if (casters.length > 1) {
    let casterLevel = 0;
    for (const c of casters) {
      const share = c.level / c.divisor;
      casterLevel += c.rounding === 2 ? Math.ceil(share) : Math.floor(share);
    }
    spell = slotRowToObject(MULTICLASS_SLOTS[Math.max(0, Math.min(20, casterLevel))]);
  }
  const lock = (classes || []).find(c => c.pact);
  let pact = null;
  if (lock) {
    const levels = Object.keys(lock.slots).map(Number);
    if (levels.length) {
      const top = Math.max(...levels);
      pact = { level: top, max: lock.slots[top] };
    }
  }
  return { spell, pact };
}
