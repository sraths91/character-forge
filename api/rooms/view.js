// Per-seat projection (M64 B7). Every broadcast and snapshot passes
// through here. The projection is a projected EncounterState (what
// shared/protocol.js validates for room.snapshot.encounter): the full
// state minus the RNG, and — for player seats when the encounter has fog
// — minus what stands in unrevealed cells (map/fog.js filterViewForFog).
// Clients build their RenderView from it with map/view.js
// projectBattleView; the server never sends a RenderView.

import { stateHash as sharedStateHash } from '../../src/js/shared/state-hash.js';
import { filterViewForFog, isRevealed } from '../../src/js/map/fog.js';

/**
 * Stand-in id for an entity a player seat may not see (M64 W5). Fog-masked
 * events carry it wherever they named the hidden entity; clients render
 * unknown ids verbatim, so the log reads "Something → Fighter …".
 */
export const HIDDEN_ENTITY_ID = 'Something';

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
 * The state hash a given seat's mirror must reproduce: the full hash for
 * the DM (and `null`), the hash of the fog-filtered projection for a
 * player seat when the encounter has fog.
 * @param {object|null} state  full EncounterState
 * @param {{role: 'dm'|'player'}|null} viewer
 * @returns {string}
 */
export function stateHashFor(state, viewer) {
  return sharedStateHash(state ? viewFor(state, viewer) : null);
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

/**
 * Every entity id a payload names (string values, at any depth, that are
 * known entity ids).
 * @param {unknown} v
 * @param {(id: string) => boolean} isKnown
 * @param {Set<string>} [out]
 * @returns {Set<string>}
 */
function refsOf(v, isKnown, out = new Set()) {
  if (typeof v === 'string') { if (isKnown(v)) out.add(v); return out; }
  if (Array.isArray(v)) { for (const x of v) refsOf(x, isKnown, out); return out; }
  if (v && typeof v === 'object') for (const x of Object.values(v)) refsOf(x, isKnown, out);
  return out;
}

/** A deep copy of `v` with every hidden id replaced by HIDDEN_ENTITY_ID. */
function maskIds(v, hidden) {
  if (typeof v === 'string') return hidden.has(v) ? HIDDEN_ENTITY_ID : v;
  if (Array.isArray(v)) return v.map(x => maskIds(x, hidden));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = maskIds(x, hidden);
    return out;
  }
  return v;
}

/**
 * What a player seat receives for one engine event under fog (M64 W5):
 *  - `{full: true}` — the event as is (nothing it names is hidden);
 *  - `{payload}`    — a masked copy: hidden entity ids become
 *                     HIDDEN_ENTITY_ID ("Something attacks …");
 *  - `null`         — `redacted {type}` (everything it names is hidden).
 * Rules: an event is masked when at least one entity it names is
 * visible. `turn.ended` always goes out (its hash is per seat). An
 * `exchange` whose attacker or defender is hidden is redacted (no cinema
 * of an unseen creature; HP still arrives through damage / heal), and
 * its effects are cut to visible entities. A `move` is shown only when
 * both cells are revealed; one that crosses the fog edge sets `crossed`
 * (the room re-baselines player seats with a snapshot).
 *
 * @param {{type: string, payload: object}} ev  stamped event
 * @param {{isKnown: (id: string) => boolean, isVisible: (id: string) => boolean,
 *   cellRevealed: (pos: {col: number, row: number}) => boolean}} vis
 * @returns {{view: {full: true}|{payload: object}|null, crossed: boolean}}
 */
export function fogEventView(ev, vis) {
  const p = ev.payload || {};
  if (ev.type === 'move') {
    const a = !!p.from && vis.cellRevealed(p.from);
    const b = !!p.to && vis.cellRevealed(p.to);
    if (!a || !b) return { view: null, crossed: a !== b };
  }
  const refs = refsOf(p, vis.isKnown);
  const hidden = new Set([...refs].filter(id => !vis.isVisible(id)));
  if (hidden.size === 0) return { view: { full: true }, crossed: false };
  if (ev.type === 'turn.ended') return { view: { payload: maskIds(p, hidden) }, crossed: false };
  if (hidden.size === refs.size) return { view: null, crossed: false };
  if (ev.type === 'exchange') {
    if (hidden.has(p.attackerId) || (p.defenderId != null && hidden.has(p.defenderId))) return { view: null, crossed: false };
    const cut = { ...p, effects: (p.effects || []).filter(e => !hidden.has(e.entityId)) };
    return { view: { payload: maskIds(cut, hidden) }, crossed: false };
  }
  return { view: { payload: maskIds(p, hidden) }, crossed: false };
}

/**
 * Visibility for fogEventView over a state (+ positions moved since it).
 * @param {object} state  EncounterState with `fog`
 * @param {Map<string, {col: number, row: number}>} [moved]
 */
export function fogVisibility(state, moved = new Map()) {
  const cols = state.grid?.cols;
  const cellRevealed = (pos) => !!pos && isRevealed(state.fog, cols, pos.col, pos.row);
  const posOf = (id) => moved.get(id) ?? state.entities?.[id]?.pos ?? null;
  return {
    cellRevealed,
    isKnown: (id) => moved.has(id) || Object.prototype.hasOwnProperty.call(state.entities || {}, id),
    isVisible: (id) => cellRevealed(posOf(id))
  };
}
