/**
 * M64 — reaction-dialog labels read from the ONE slot ledger (T5).
 *
 * The Shield dialog used to print `_lvl1Slots`, a separate estimate T5
 * retired (Shield now spends the lowest available slot from `_slots` /
 * `_pact`). Both the forge (engine wrappers / live PCs) and the play
 * client (EncounterState `resources.slots{lvl:{max,spent}}` + `pact`)
 * build the label here so the cost line matches what will be spent.
 *
 * Pure: no DOM.
 */

/**
 * Slot pool `{level: remaining}` plus pact from either an engine wrapper
 * (`_slots`, `_pact`) or an EncounterState entity (`resources`).
 * @param {object|null} entity
 * @returns {{pool: Record<string, number>, pact: {level?: number, max?: number, spent?: number}|null}}
 */
export function slotPoolOf(entity) {
  if (!entity || typeof entity !== 'object') return { pool: {}, pact: null };
  const ledger = entity.resources?.slots;
  if (ledger && typeof ledger === 'object') {
    const pool = {};
    for (const [lvl, l] of Object.entries(ledger)) pool[lvl] = Math.max(0, (l?.max ?? 0) - (l?.spent ?? 0));
    const pact = entity.resources.pact && entity.resources.pact.level ? entity.resources.pact : null;
    return { pool, pact };
  }
  const pool = {};
  for (const [lvl, n] of Object.entries(entity._slots || {})) pool[lvl] = Math.max(0, Number(n) || 0);
  return { pool, pact: entity._pact && entity._pact.level ? entity._pact : null };
}

/**
 * The slot a Shield (or any min-level reaction spell) would burn, and how
 * many of that level remain.
 * @param {object|null} entity
 * @param {number} [minLevel=1]
 * @returns {{level: number|null, remaining: number, pact: boolean}}
 */
export function reactionSlotOf(entity, minLevel = 1) {
  const { pool, pact } = slotPoolOf(entity);
  for (let lvl = Math.max(1, minLevel); lvl <= 9; lvl++) {
    const n = pool[lvl] ?? pool[String(lvl)] ?? 0;
    if (n > 0) return { level: lvl, remaining: n, pact: false };
  }
  if (pact && pact.level >= minLevel) {
    const left = (pact.max ?? 0) - (pact.spent ?? 0);
    if (left > 0) return { level: pact.level, remaining: left, pact: true };
  }
  return { level: null, remaining: 0, pact: false };
}

const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

/**
 * "1 reaction · 1 of 3 1st-level slots" for the slot the reaction spends.
 * @param {object|null} entity
 * @param {number} [minLevel=1] — 1 for Shield, 3 for Counterspell
 * @returns {string}
 */
export function reactionCostLabel(entity, minLevel = 1) {
  const s = reactionSlotOf(entity, minLevel);
  if (!s.level) return `1 reaction · no slot of level ${minLevel}+ left`;
  const kind = s.pact ? 'pact slot' : `${ORD[s.level] || `${s.level}th`}-level slot`;
  return `1 reaction · 1 of ${s.remaining} ${kind}${s.remaining === 1 ? '' : 's'}`;
}
