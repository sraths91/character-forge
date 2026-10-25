/**
 * M65 R29 — exhaustion levels 1–6 (SRD 5.1 Appendix A, "Exhaustion").
 *
 *   1  disadvantage on ability checks
 *   2  speed halved
 *   3  disadvantage on attack rolls and saving throws
 *   4  hit point maximum halved
 *   5  speed reduced to 0
 *   6  death
 * Effects are cumulative. Exhaustion persists across nodes in
 * state_json v1 `exhaustion`; a long rest removes one level (rest.js).
 *
 * `applyExhaustionToEntity` is the seeding hook for
 * `entityFromSheet(sheet, {runState})` (E1 wires it); the level-3 attack
 * disadvantage is read by combat-resolver.js through `exhaustionLevelOf`.
 *
 * Pure module (Node + browser): no DOM, no `node:` imports, no rng.
 */

/** Highest exhaustion level (death). */
export const MAX_EXHAUSTION = 6;

/**
 * Clamp anything to an exhaustion level 0–6.
 * @param {unknown} n
 * @returns {number}
 */
export function clampExhaustion(n) {
  const v = Math.trunc(Number(n) || 0);
  return Math.max(0, Math.min(MAX_EXHAUSTION, v));
}

/**
 * The exhaustion level carried by an entity, wrapper, state_json or
 * sheet: a numeric `exhaustion` field, else an `exhaustion` condition
 * object `{id: 'exhaustion', level}` (a bare 'exhaustion' string = 1).
 * DDB-imported `ddbConditions` are NOT read: they apply only when the DM
 * opts in, through the run state.
 * @param {object} x
 * @returns {number} 0–6
 */
export function exhaustionLevelOf(x) {
  if (!x || typeof x !== 'object') return 0;
  if (x.exhaustion != null && Number.isFinite(Number(x.exhaustion))) return clampExhaustion(x.exhaustion);
  for (const c of (Array.isArray(x.conditions) ? x.conditions : [])) {
    if (c === 'exhaustion') return 1;
    if (c && typeof c === 'object' && c.id === 'exhaustion') return clampExhaustion(c.level ?? 1) || 1;
  }
  return 0;
}

/**
 * Cumulative effects of an exhaustion level.
 * @param {number} level
 * @returns {{level: number, checkDisadvantage: boolean, speedMultiplier: number,
 *   attackDisadvantage: boolean, saveDisadvantage: boolean, hpMaxMultiplier: number, dead: boolean}}
 */
export function exhaustionEffects(level) {
  const lv = clampExhaustion(level);
  return {
    level: lv,
    checkDisadvantage: lv >= 1,
    speedMultiplier: lv >= 5 ? 0 : lv >= 2 ? 0.5 : 1,
    attackDisadvantage: lv >= 3,
    saveDisadvantage: lv >= 3,
    hpMaxMultiplier: lv >= 4 ? 0.5 : 1,
    dead: lv >= 6
  };
}

/**
 * HP maximum after exhaustion (level 4+ halves it, rounded down, min 1).
 * @param {number} hpMax
 * @param {number} level
 * @returns {number}
 */
export function exhaustedHpMax(hpMax, level) {
  const max = Math.max(1, Math.trunc(Number(hpMax) || 1));
  return exhaustionEffects(level).hpMaxMultiplier < 1 ? Math.max(1, Math.floor(max / 2)) : max;
}

/**
 * Speed after exhaustion (level 2–4 halves it, rounded down; 5+ is 0).
 * @param {number} speedFt
 * @param {number} level
 * @returns {number}
 */
export function exhaustedSpeed(speedFt, level) {
  const s = Math.max(0, Math.trunc(Number(speedFt) || 0));
  return Math.floor(s * exhaustionEffects(level).speedMultiplier);
}

/**
 * A run sheet's effective HP maximum given its state_json (exhaustion).
 * @param {object} sheet — run sheet (`hp.max`)
 * @param {object} state — state_json v1 (`exhaustion`)
 * @returns {number}
 */
export function effectiveHpMax(sheet, state) {
  return exhaustedHpMax(sheet?.hp?.max ?? 1, exhaustionLevelOf(state));
}

/**
 * Apply an exhaustion level to a freshly seeded EncounterState entity:
 * records `exhaustion`, halves / zeroes `speedFt`, halves `hpMax` (and
 * clamps `hp`), and at level 6 marks the PC dead (`status: 'dead'`,
 * `hp: 0`, three failed death saves). Returns a new entity; level 0
 * returns an unchanged copy (no `exhaustion` field added).
 * @param {object} entity — EncounterState entity (entityFromSheet output)
 * @param {number} level — 0–6
 * @returns {object}
 */
export function applyExhaustionToEntity(entity, level) {
  const e = JSON.parse(JSON.stringify(entity));
  const lv = clampExhaustion(level);
  if (lv === 0) return e;
  e.exhaustion = lv;
  e.speedFt = exhaustedSpeed(e.speedFt ?? 30, lv);
  e.hpMax = exhaustedHpMax(e.hpMax, lv);
  e.hp = Math.min(Math.max(0, Math.trunc(Number(e.hp) || 0)), e.hpMax);
  if (exhaustionEffects(lv).dead) {
    e.hp = 0;
    e.status = 'dead';
    if (e.kind === 'pc') e.deathSaves = { successes: 0, failures: 3, stable: false };
  }
  return e;
}
