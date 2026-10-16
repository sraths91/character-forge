/**
 * M64 R7 — condition lifecycle data (pure helpers).
 *
 * A condition is `{id, sourceId, endsOn, save, appliedRound}`:
 *
 *   id           — 'paralyzed', 'charmed', … (the engine's string id)
 *   sourceId     — the creature that applied it (null: DM / sheet)
 *   endsOn       — 'turn-end'        : ends at the end of the bearer's turn
 *                  'turn-start'      : ends at the start of the bearer's turn
 *                  'source-turn-end' : ends at the end of the source's turn
 *                  'concentration'   : ends when the source's concentration
 *                                      on it drops
 *                  'encounter'       : lasts until removed (the default)
 *   save         — `{stat, dc}`: the bearer repeats the save at the end of
 *                  each of its turns and the condition ends on a success
 *                  (Hold Person); null for none
 *   appliedRound — the round it was applied (null when unknown)
 *
 * Plain strings ('poisoned') are still accepted everywhere and normalise
 * to `{id, sourceId: null, endsOn: 'encounter', save: null,
 * appliedRound: null}`.
 *
 * Engine wrappers keep `conditions` as string ids — the shape every
 * reader (resolver, AI, reactions, grid rules, the browser) consumes —
 * and carry the lifecycle of any non-trivial condition in
 * `_conditionMeta: {[id]: Condition}`. The EncounterState adapters
 * persist those as condition objects (`entities[id].conditions[]`).
 *
 * Pure: no rng, no events; the engine (combat-engine.js) runs the
 * lifecycle (saves, events) on top of these.
 */

/** Lifecycle end triggers. */
export const CONDITION_ENDS_ON = Object.freeze(['turn-end', 'turn-start', 'source-turn-end', 'concentration', 'encounter']);

/** Conditions that leave a creature incapacitated (PHB p290-292). */
export const INCAPACITATING = Object.freeze(['incapacitated', 'paralyzed', 'stunned', 'unconscious', 'petrified']);

/**
 * The id of a condition given as a string or an object.
 * @param {string|{id: string}|null|undefined} c
 * @returns {string|undefined}
 */
export function conditionId(c) {
  return typeof c === 'string' ? c : c?.id;
}

/**
 * Normalise a string or partial object to the full lifecycle shape.
 * @param {string|object} c
 * @returns {{id: string, sourceId: string|null, endsOn: string, save: {stat: string, dc: number}|null, appliedRound: number|null}|null}
 */
export function normalizeCondition(c) {
  const id = conditionId(c);
  if (!id) return null;
  const o = typeof c === 'object' && c ? c : {};
  const endsOn = CONDITION_ENDS_ON.includes(o.endsOn) ? o.endsOn : 'encounter';
  const save = o.save && typeof o.save.stat === 'string' && Number.isFinite(Number(o.save.dc))
    ? { stat: o.save.stat, dc: Math.trunc(Number(o.save.dc)) }
    : null;
  return {
    id: String(id),
    sourceId: o.sourceId != null ? String(o.sourceId) : null,
    endsOn,
    save,
    appliedRound: Number.isInteger(o.appliedRound) ? o.appliedRound : null
  };
}

/**
 * Whether a normalised condition carries any lifecycle (a plain string
 * would lose nothing).
 * @param {object|null} c — normalised condition
 * @returns {boolean}
 */
export function hasLifecycle(c) {
  return !!c && (c.sourceId != null || c.endsOn !== 'encounter' || c.save != null || c.appliedRound != null);
}

/**
 * Every condition id on an entity (wrapper, EncounterState entity or live
 * record), strings and objects alike.
 * @param {object} entity
 * @returns {string[]}
 */
export function conditionIds(entity) {
  const list = Array.isArray(entity?.conditions) ? entity.conditions : [];
  return list.map(conditionId).filter(Boolean);
}

/**
 * Whether the entity has condition `id`.
 * @param {object} entity
 * @param {string} id
 * @returns {boolean}
 */
export function hasCondition(entity, id) {
  return conditionIds(entity).includes(id);
}

/**
 * Whether the entity is incapacitated by any condition.
 * @param {object} entity
 * @returns {boolean}
 */
export function isIncapacitatedBy(entity) {
  const ids = conditionIds(entity);
  return INCAPACITATING.some(c => ids.includes(c));
}

/**
 * The normalised lifecycle of condition `id` on a wrapper (from
 * `_conditionMeta`, else an object entry, else the plain-string default).
 * Null when the entity does not have it.
 * @param {object} entity
 * @param {string} id
 * @returns {object|null}
 */
export function conditionMeta(entity, id) {
  if (!hasCondition(entity, id)) return null;
  const meta = entity?._conditionMeta?.[id];
  if (meta) return normalizeCondition(meta);
  const entry = (entity.conditions || []).find(c => conditionId(c) === id);
  return normalizeCondition(entry);
}

/**
 * Ids of the creatures that charmed this one (from the lifecycle source).
 * @param {object} entity
 * @returns {string[]}
 */
export function charmerIds(entity) {
  const meta = conditionMeta(entity, 'charmed');
  return meta?.sourceId != null ? [meta.sourceId] : [];
}

/**
 * Add a condition to a wrapper (string id in `conditions`, lifecycle in
 * `_conditionMeta`). Re-applying an existing id refreshes its lifecycle.
 * @param {object} entity — wrapper (mutated)
 * @param {string|object} cond
 * @returns {{added: boolean, condition: object|null}} added is false when
 *   the id was already present
 */
export function addConditionTo(entity, cond) {
  const c = normalizeCondition(cond);
  if (!entity || !c) return { added: false, condition: null };
  if (!Array.isArray(entity.conditions)) entity.conditions = [];
  const had = hasCondition(entity, c.id);
  if (!had) entity.conditions.push(c.id);
  if (hasLifecycle(c)) {
    entity._conditionMeta = { ...(entity._conditionMeta || {}), [c.id]: c };
  } else if (entity._conditionMeta?.[c.id] && !had) {
    const { [c.id]: _gone, ...rest } = entity._conditionMeta;
    entity._conditionMeta = rest;
  }
  return { added: !had, condition: c };
}

/**
 * Remove a condition from a wrapper.
 * @param {object} entity — wrapper (mutated)
 * @param {string} id
 * @returns {object|null} the removed (normalised) condition, or null
 */
export function removeConditionFrom(entity, id) {
  const meta = conditionMeta(entity, id);
  if (!meta) return null;
  entity.conditions = (entity.conditions || []).filter(c => conditionId(c) !== id);
  if (entity._conditionMeta && entity._conditionMeta[id]) {
    const { [id]: _gone, ...rest } = entity._conditionMeta;
    entity._conditionMeta = rest;
  }
  return meta;
}

/**
 * Split a mixed conditions list (strings / objects) into the wrapper form.
 * @param {Array<string|object>} list
 * @param {Record<string, object>} [priorMeta] — lifecycle kept for ids
 *   that arrive as plain strings
 * @returns {{conditions: string[], meta: Record<string, object>}}
 */
export function wrapperConditions(list, priorMeta = {}) {
  const conditions = [];
  const meta = {};
  for (const c of list || []) {
    const n = normalizeCondition(c);
    if (!n || conditions.includes(n.id)) continue;
    conditions.push(n.id);
    if (typeof c === 'object' && hasLifecycle(n)) meta[n.id] = n;
    else if (typeof c === 'string' && priorMeta?.[n.id]) meta[n.id] = normalizeCondition(priorMeta[n.id]);
  }
  return { conditions, meta };
}
