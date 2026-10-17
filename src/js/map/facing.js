/**
 * M64 E5 / phase 1.5 — per-token facing on the grid (R2 R7).
 *
 * The LPC idle crops ship four directions; a token faces the direction
 * of its last move, or its current target when it attacks. Facing is
 * presentation, not rules: the server never decides it. Each client
 * folds the event stream into `local.facings` (entity id → direction)
 * with the pure helpers below, and passes it to
 * `projectBattleView(state, appearances, {facings})`, which copies it
 * onto `view.tokens[].facing`. Two clients that saw the same events hold
 * the same facings, so their views stay deep-equal.
 *
 *   local.facings = applyFacingEvent(local.facings, event, state.entities)
 *
 * or, for a client that only diffs snapshots (reconnect, no event log):
 *
 *   local.facings = facingsFromPositions(local.facings, prevPositions, positionsOf(state))
 *
 * Pure, Node-safe, no DOM. Inputs are never mutated; an unchanged result
 * is the same object (cheap equality for redraw checks).
 */

/** The four LPC sheet rows. */
export const FACINGS = Object.freeze(['north', 'east', 'south', 'west']);

/**
 * Grid direction from one cell to another. The dominant axis wins; a
 * perfect diagonal faces east/west (side views read better than backs).
 * @param {{col: number, row: number}|null|undefined} from
 * @param {{col: number, row: number}|null|undefined} to
 * @returns {'north'|'east'|'south'|'west'|null} null when the cells coincide or are missing
 */
export function directionBetween(from, to) {
  if (!from || !to) return null;
  const dc = to.col - from.col;
  const dr = to.row - from.row;
  if (!Number.isFinite(dc) || !Number.isFinite(dr) || (dc === 0 && dr === 0)) return null;
  if (Math.abs(dc) >= Math.abs(dr)) return dc > 0 ? 'east' : 'west';
  return dr > 0 ? 'south' : 'north';
}

/** True for one of the four facings. */
export function isFacing(v) {
  return FACINGS.includes(v);
}

function posOf(entities, id) {
  if (!entities || id == null) return null;
  const e = entities instanceof Map ? entities.get(String(id)) : entities[String(id)];
  if (!e) return null;
  if (e.pos) return e.pos;
  if (Number.isFinite(e.col) && Number.isFinite(e.row)) return e;
  return null;
}

function withFacing(facings, id, dir) {
  const base = facings && typeof facings === 'object' ? facings : {};
  if (!dir || base[id] === dir) return facings || base;
  return { ...base, [id]: dir };
}

/**
 * Fold one encounter event into the facings map.
 *   - `move`: the actor faces along the last step of its path (or from → to).
 *   - `attack.rolled`: the attacker faces its target (positions from `entities`).
 * Every other event returns `facings` unchanged.
 * @param {Record<string, string>|null|undefined} facings
 * @param {{type: string, payload?: object}} event — shared/events.js envelope
 * @param {Record<string, {pos?: {col: number, row: number}}>|Map<string, object>} [entities]
 *   — EncounterState.entities (or id → {col,row}); needed for attacks
 * @returns {Record<string, string>} a new map when something changed, else the input
 */
export function applyFacingEvent(facings, event, entities = null) {
  const p = event?.payload;
  if (!p) return facings || {};
  if (event.type === 'move' && p.actorId != null) {
    const path = Array.isArray(p.path) ? p.path.filter(Boolean) : [];
    let dir = null;
    for (let i = path.length - 1; i > 0 && !dir; i--) dir = directionBetween(path[i - 1], path[i]);
    if (!dir) dir = directionBetween(p.from, p.to);
    return withFacing(facings, String(p.actorId), dir);
  }
  if (event.type === 'attack.rolled' && p.attackerId != null && p.targetId != null) {
    const dir = directionBetween(posOf(entities, p.attackerId), posOf(entities, p.targetId));
    return withFacing(facings, String(p.attackerId), dir);
  }
  return facings || {};
}

/**
 * Entity id → position for every placed entity of an EncounterState.
 * @param {{entities?: Record<string, {pos?: {col: number, row: number}}>}} state
 * @returns {Record<string, {col: number, row: number}>}
 */
export function positionsOf(state) {
  const out = {};
  for (const [id, e] of Object.entries(state?.entities || {})) {
    if (e?.pos) out[id] = { col: e.pos.col, row: e.pos.row };
  }
  return out;
}

/**
 * Snapshot-diff fallback: every entity whose position changed faces the
 * way it moved.
 * @param {Record<string, string>|null|undefined} facings
 * @param {Record<string, {col: number, row: number}>|null|undefined} prev — positionsOf(previous state)
 * @param {Record<string, {col: number, row: number}>|null|undefined} next — positionsOf(new state)
 * @returns {Record<string, string>}
 */
export function facingsFromPositions(facings, prev, next) {
  let out = facings || {};
  for (const [id, to] of Object.entries(next || {})) {
    out = withFacing(out, id, directionBetween(prev?.[id], to));
  }
  return out;
}

/**
 * Facing of one entity: the client map first, then a persisted
 * `entity.facing`, else null (the renderer defaults to south).
 * @param {Record<string, string>|Map<string, string>|null|undefined} facings
 * @param {{id: string, facing?: string}} entity
 * @returns {string|null}
 */
export function facingFor(facings, entity) {
  const id = String(entity?.id);
  const local = facings instanceof Map ? facings.get(id) : facings?.[id];
  if (isFacing(local)) return local;
  return isFacing(entity?.facing) ? entity.facing : null;
}
