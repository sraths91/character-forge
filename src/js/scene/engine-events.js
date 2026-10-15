/**
 * M64 T4 — engine event emission helpers.
 *
 * The combat engine reports every state change through a synchronous
 * `ctx.emit(ev)` where `ev = { type, payload, cinemaGroup }` uses the
 * event catalogue v1 names and payloads (src/js/shared/events.js). The
 * envelope fields `seq`, `round` and `turnId` are stamped by the caller
 * (turn manager / server / golden harness), which owns the sequence.
 * Payloads carry ids only — never wrapper references.
 *
 * `ctx` is the engine's 7th, optional argument (`runOneAttack(attacker,
 * enemies, allies, scene, rng, prompts, ctx)`):
 *   ctx.emit(ev)          — sync sink; absent → nothing is built or sent
 *   ctx.turnId            — prefix for cinema-group ids (optional)
 *   ctx.planSource        — 'player' | 'dm' for a forcePlan (default by kind)
 *   ctx.reactionDeadlineMs — echoed in reaction.offered (optional)
 * The simulator passes nothing, so its hot loop allocates no events.
 *
 * Pure module: no DOM, no clock, no randomness (fxSeed is a hash).
 */

/** Shared empty context (the simulator's default). */
export const NO_CTX = Object.freeze({});

const groupCounters = new WeakMap();

/**
 * Whether this ctx collects events.
 * @param {object} ctx
 * @returns {boolean}
 */
export function canEmit(ctx) {
  return !!ctx && typeof ctx.emit === 'function';
}

/**
 * Emit one event (no-op without a sink).
 * @param {object} ctx
 * @param {string} type — EVENT_TYPES entry
 * @param {object} payload — ids only
 * @param {string|null} [cinemaGroup]
 */
export function emitEvent(ctx, type, payload, cinemaGroup = null) {
  if (!canEmit(ctx)) return;
  ctx.emit({ type, payload, cinemaGroup });
}

/**
 * Allocate the next cinema-group id for this ctx (`<turnId>.x<n>`), or
 * null when nothing is collected.
 * @param {object} ctx
 * @returns {string|null}
 */
export function nextCinemaGroup(ctx) {
  if (!canEmit(ctx)) return null;
  const n = (groupCounters.get(ctx) || 0) + 1;
  groupCounters.set(ctx, n);
  return `${ctx.turnId ?? 'turn'}.x${n}`;
}

/**
 * Deterministic uint32 seed for client-side cinema effects, derived from
 * the exchange id (FNV-1a) so it never draws from the combat rng.
 * @param {string} s
 * @returns {number}
 */
export function fxSeedOf(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Entity id as the events carry it (string), or null.
 * @param {object|null} w — wrapper
 * @returns {string|null}
 */
export function idOf(w) {
  return w?.id != null ? String(w.id) : null;
}

/** Who answered a prompt. */
const BY = new Set(['player', 'auto', 'timeout', 'dm']);

/**
 * Normalise a prompt answer. Callbacks may resolve a boolean (browser
 * dialogs) or `{ answer, by }` (the M64 prompt adapter). Without a
 * callback the engine's heuristic answered: by 'auto'.
 * @param {unknown} v
 * @param {boolean} prompted — a callback produced `v`
 * @returns {{answer: boolean, by: 'player'|'auto'|'timeout'|'dm'}}
 */
export function normalizeAnswer(v, prompted) {
  if (v && typeof v === 'object') {
    return { answer: !!v.answer, by: BY.has(v.by) ? v.by : 'player' };
  }
  return { answer: !!v, by: prompted ? 'player' : 'auto' };
}
