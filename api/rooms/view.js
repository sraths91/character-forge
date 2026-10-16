// Per-seat projection (M64 B7). Every broadcast and snapshot passes
// through here. Phase 1 projects the full state minus the RNG; phase 2's
// fog becomes a filter in viewFor, not a refactor.

import { stateHash as sharedStateHash } from '../../src/js/shared/state-hash.js';

/**
 * The canonical state hash (src/js/shared/state-hash.js, dynamic fields
 * only), computed over the projected state — the same function clients
 * run on their mirror. Sent at every `turn.ended` and in `room.snapshot`.
 * @param {object|null} state  full or projected EncounterState
 * @returns {string}
 */
export function stateHash(state) {
  return sharedStateHash(state ? viewFor(state, null) : null);
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
