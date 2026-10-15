// Per-seat projection (M64 B7). Every broadcast and snapshot passes
// through here. Phase 1 projects the full state minus the RNG; phase 2's
// fog becomes a filter in viewFor, not a refactor.

/**
 * Hash of an encounter as clients can track it. Uses the shared
 * `stateHash` from src/js/shared/state-hash.js when that module exists
 * (E1, Wave 2/3); until it merges, falls back to the same function the
 * client store (src/js/client/store.js viewStateHash) uses: per entity
 * sorted by id, [id, hp, col, row, sorted condition ids], FNV-1a 32 → 8 hex.
 * TODO(M64 Wave 4): drop the fallback once shared/state-hash.js is on main.
 */
let sharedHash = null;
try {
  const mod = await import('../../src/js/shared/state-hash.js');
  if (typeof mod.stateHash === 'function') sharedHash = mod.stateHash;
} catch { /* not merged yet: use the fallback */ }

/** 'shared' when the canonical shared hash is loaded, else 'fallback'. */
export const STATE_HASH_SOURCE = sharedHash ? 'shared' : 'fallback';

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const conditionId = (c) => (typeof c === 'string' ? c : c?.id);

/**
 * Fallback hash (mirror of the client store's viewStateHash).
 * @param {object|null} encounter
 * @returns {string}
 */
export function fallbackStateHash(encounter) {
  const ents = Object.values(encounter?.entities || {})
    .map(e => [e.id, e.hp, e.pos?.col ?? null, e.pos?.row ?? null, (e.conditions || []).map(conditionId).sort()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return fnv1a(JSON.stringify(ents));
}

/**
 * The canonical client-visible state hash, computed over the projected state.
 * @param {object|null} state  full or projected EncounterState
 * @returns {string}
 */
export function stateHash(state) {
  const view = state ? viewFor(state, null) : null;
  return sharedHash ? sharedHash(view) : fallbackStateHash(view);
}

/**
 * Project an EncounterState for one seat. Never includes `rng`.
 * @param {object} state  full EncounterState
 * @param {{role: 'dm'|'player', memberId: string}|null} _viewer  (phase 2: fog filter)
 * @returns {object} projected EncounterState (a fresh copy)
 */
export function viewFor(state, _viewer) {
  if (!state) return null;
  const { rng: _rng, ...rest } = state;
  return JSON.parse(JSON.stringify(rest));
}

/**
 * Whether a viewer may see an engine event; hidden events are replaced by
 * a `redacted {type}` broadcast with the same seq so seq stays gap-free.
 * @param {object} ev  stamped event
 * @param {{role: string}} viewer
 * @param {{dmOverrideVisibility?: 'public'|'dm-only'}} settings
 * @returns {boolean}
 */
export function canSeeEvent(ev, viewer, settings = {}) {
  if (ev.type === 'dm.override' && settings.dmOverrideVisibility === 'dm-only') return viewer.role === 'dm';
  return true;
}
