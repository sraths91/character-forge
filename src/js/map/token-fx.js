/**
 * M64 E5 / phase 1.5 — life-state presentation for grid tokens (R2 R7).
 *
 * E1 puts `entity.status` on EncounterState (optional):
 *   'active'  — up and fighting
 *   'downed'  — a PC at 0 HP making death saves (also 'unconscious')
 *   'stable'  — 0 HP, three successes, no more saves
 *   'dead'    — three failures, massive damage, or any monster at 0 HP
 * Absent ⇒ 'active' unless hp ≤ 0, then 'downed' for PCs and 'dead' for
 * monsters (E1's documented fallback).
 *
 * Renderer behaviour (sprite/compositor.js):
 *   - downed / stable / dead draw the greyed `down` bake (filter matrix
 *     'saturate(0) brightness(0.55)') lying on its side;
 *   - stable adds a small green badge;
 *   - dead fades over DEATH_FADE_MS to DEAD_MARKER_ALPHA and stays as a
 *     faint marker under the living. A token first seen already dead
 *     (reconnect, late join) skips the fade.
 *
 * Pure, Node-safe.
 */

/** Entity life states (mirrors E1's `entity.status` enum). */
export const TOKEN_STATUSES = Object.freeze(['active', 'downed', 'stable', 'dead']);
/** Death fade length, ms. */
export const DEATH_FADE_MS = 600;
/** Opacity a dead token settles at. */
export const DEAD_MARKER_ALPHA = 0.28;

/**
 * Life state of an EncounterState entity.
 * @param {{kind?: string, hp?: number, status?: string, deathSaves?: {failures?: number, stable?: boolean}}} entity
 * @returns {'active'|'downed'|'stable'|'dead'}
 */
export function statusOf(entity) {
  if (TOKEN_STATUSES.includes(entity?.status)) return entity.status;
  if (!(Number.isFinite(entity?.hp) && entity.hp <= 0)) return 'active';
  if (entity.kind === 'monster' || (entity.deathSaves?.failures || 0) >= 3) return 'dead';
  return entity.deathSaves?.stable ? 'stable' : 'downed';
}

/**
 * Whether a status draws the downed (prone, greyed) body.
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isDownStatus(status) {
  return status === 'downed' || status === 'stable' || status === 'dead';
}

/**
 * Opacity of a dead token `elapsedMs` after it died: 1 → DEAD_MARKER_ALPHA,
 * ease-out over DEATH_FADE_MS.
 * @param {number} elapsedMs
 * @returns {number}
 */
export function deathFadeAlpha(elapsedMs) {
  if (!(elapsedMs > 0)) return 1;
  const t = Math.min(1, elapsedMs / DEATH_FADE_MS);
  const eased = 1 - (1 - t) * (1 - t);
  return 1 - (1 - DEAD_MARKER_ALPHA) * eased;
}
