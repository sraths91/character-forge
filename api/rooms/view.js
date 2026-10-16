// Per-seat projection (M64 B7). Every broadcast and snapshot passes
// through here. The projection is a projected EncounterState (what
// shared/protocol.js validates for room.snapshot.encounter): the full
// state minus the RNG, and — for player seats when the encounter has fog
// — minus what stands in unrevealed cells (map/fog.js filterViewForFog).
// Clients build their RenderView from it with map/view.js
// projectBattleView; the server never sends a RenderView.

import { stateHash as sharedStateHash } from '../../src/js/shared/state-hash.js';
import { filterViewForFog } from '../../src/js/map/fog.js';

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
 * Project an EncounterState for one seat. Never includes `rng`. Player
 * seats get the fog filter when `state.fog` is set (entities in hidden
 * cells, their initiative rows and the terrain under fog removed); the
 * DM and `null` (the canonical projection the hash covers) never do.
 * @param {object} state  full EncounterState
 * @param {{role: 'dm'|'player', memberId?: string}|null} viewer
 * @returns {object} projected EncounterState (a fresh copy)
 */
export function viewFor(state, viewer) {
  if (!state) return null;
  const { rng: _rng, ...rest } = state;
  const view = JSON.parse(JSON.stringify(rest));
  if (viewer?.role === 'player' && view.fog) return filterViewForFog(view);
  return view;
}

/** The projection safe to broadcast to every seat (player view). */
export function publicView(state) {
  return viewFor(state, { role: 'player' });
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
