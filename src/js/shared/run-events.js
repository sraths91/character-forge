/**
 * M65 H22 — run event catalogue v1 (`run_events` rows).
 *
 * Everything that happens to a run between and around its nodes is one
 * run event, persisted before it is broadcast, so a run replays from its
 * log (M65 decision 6: between-node randomness draws from the persisted
 * run RNG). Envelope (mirrors the `run_events` columns; `ts` is optional
 * and never used for replay):
 *
 *   { seq, type, nodeId, actorKind, actorId, override, ts?, payload }
 *
 * Mutating types — anything that changes a character's sheet, state, XP,
 * life status, seat, items or currency — MUST carry `payload.before` and
 * `payload.after` (null allowed: an item that did not exist yet). Lifecycle
 * markers (run / node boundaries, a queued level-up, a story choice, a
 * saved snapshot) carry their own fields only.
 *
 * Payloads are non-strict (additive fields need no version bump); listed
 * fields are enforced. Outside `before` / `after`, payloads may not carry
 * a `ref` key or an `_underscore` key (a leaked engine wrapper).
 *
 * On the wire run events travel as the protocol's `run.event` broadcast
 * (protocol.js v1.6), never under their own type: `item.used` and
 * `dm.override` also name engine events.
 *
 * Additive types (no catalogue version bump; appended so older readers
 * keep their order):
 *   E3 M65 phase 2 Wave 4 — `level.chosen` (a player's level-up picks:
 *   the level_ups row goes pending_player → pending_dm, {before, after}
 *   with status and choices) and `rest.declared` (non-mutating: the hit
 *   dice a seat will spend at the next short rest; `rest.taken` is the
 *   mutation when the DM grants it); `heal.cast` (a between-node healing
 *   spell, campaign/downtime-spells.js: before / after `{[slotId]: {state,
 *   lifeStatus}}` for the caster and every target).
 *
 * Imported by both Vite and Node: no DOM, no Node built-ins. Pure.
 */

import {
  createCollector, checkSpec, checkJsonSafe, joinPath, isPlainObject,
  str, int, bool, num, oneOf, arrayOf, shape, mapOf, anyJson, optional, nullable,
  VALIDATION_CODES
} from './check.js';
import { ENCOUNTER_OUTCOMES } from './events.js';
import { CONTROLLER_TYPES } from './encounter-state.js';
import { NODE_KINDS } from './campaign.js';
import { RUN_OUTCOMES, LIFE_STATUSES } from './run-state.js';

const C = VALIDATION_CODES;

/** Catalogue version. */
export const RUN_EVENT_CATALOGUE_VERSION = 1;
/** Who caused a run event. */
export const RUN_ACTOR_KINDS = Object.freeze(['dm', 'player', 'system']);
/** Rests a run event records (a `choice` rest node resolves to one of these). */
export const RUN_REST_TYPES = Object.freeze(['short', 'long']);
/** How a dead character came back. */
export const REVIVE_METHODS = Object.freeze(['revivify', 'raise-dead', 'lenient', 'dm']);

/** Every run event type, in catalogue order (M65 "Run event catalogue v1"). */
export const RUN_EVENT_TYPES = Object.freeze([
  'run.started', 'run.ended',
  'node.entered', 'node.completed',
  'encounter.result',
  'xp.awarded',
  'level.queued', 'level.applied', 'level.reverted',
  'rest.taken',
  'loot.granted',
  'item.moved', 'item.used',
  'currency.changed',
  'shop.bought', 'shop.sold',
  'character.died', 'character.revived', 'character.retired', 'character.joined',
  'seat.filled',
  'story.chosen',
  'snapshot.saved', 'snapshot.restored',
  'dm.override',
  'level.chosen', 'rest.declared', 'heal.cast'   // E3 M65 W4 (additive)
]);

/** Types that mutate run state and so require `{before, after}`. */
export const MUTATING_RUN_EVENT_TYPES = Object.freeze([
  'encounter.result', 'xp.awarded', 'level.applied', 'level.reverted', 'rest.taken',
  'loot.granted', 'item.moved', 'item.used', 'currency.changed', 'shop.bought', 'shop.sold',
  'character.died', 'character.revived', 'character.retired', 'character.joined',
  'seat.filled', 'snapshot.restored', 'dm.override',
  'level.chosen',   // E3 M65 W4: the level_ups row (status, choices)
  'heal.cast'       // E3 M65 W4: caster + targets {state, lifeStatus}
]);

/**
 * Does this run event type mutate state (and so carry `{before, after}`)?
 * @param {string} type
 * @returns {boolean}
 */
export function isMutatingRunEvent(type) {
  return MUTATING_RUN_EVENT_TYPES.includes(type);
}

const ID = str({ maxLength: 128 });
const LOOSE = { strict: false };
const LEVEL = int(1, 20);
const COIN_DELTA = int(-1e9, 1e9);
const CURRENCY_DELTA = shape({ cp: optional(COIN_DELTA), sp: optional(COIN_DELTA), ep: optional(COIN_DELTA), gp: optional(COIN_DELTA), pp: optional(COIN_DELTA) });
const BA = { before: anyJson(), after: anyJson() };
const mut = (fields) => shape({ ...fields, ...BA }, LOOSE);

/** Required payload fields per run event type (extras allowed). */
export const RUN_EVENT_PAYLOAD_SPECS = Object.freeze({
  'run.started': shape({
    campaignId: nullable(ID),
    startNodeId: ID,
    seats: arrayOf(shape({ slotId: ID, seat: int(1, 6), characterId: nullable(ID) }, LOOSE), { max: 6 })
  }, LOOSE),
  'run.ended': shape({ outcome: oneOf(RUN_OUTCOMES) }, LOOSE),
  'node.entered': shape({ nodeId: ID, kind: oneOf(NODE_KINDS), fromNodeId: nullable(ID) }, LOOSE),
  'node.completed': shape({ nodeId: ID, kind: oneOf(NODE_KINDS) }, LOOSE),
  // before / after: { [slotId]: state_json } for every PC written back.
  'encounter.result': mut({ encounterId: ID, outcome: oneOf(ENCOUNTER_OUTCOMES) }),
  // before / after: { [slotId]: xp }.
  'xp.awarded': mut({ total: int(0), perCharacter: mapOf(int(0)) }),
  'level.queued': shape({ levelUpId: ID, slotId: ID, fromLevel: LEVEL, toLevel: LEVEL }, LOOSE),
  'level.applied': mut({ levelUpId: ID, slotId: ID, fromLevel: LEVEL, toLevel: LEVEL }),
  'level.reverted': mut({ levelUpId: ID, slotId: ID, fromLevel: LEVEL, toLevel: LEVEL }),
  'rest.taken': mut({ type: oneOf(RUN_REST_TYPES), slotIds: arrayOf(ID, { unique: true }) }),
  'loot.granted': mut({ items: arrayOf(shape({ itemId: ID, name: str({ maxLength: 128 }), qty: int(1) }, LOOSE)) }),
  'item.moved': mut({ itemId: ID, fromSlotId: nullable(ID), toSlotId: nullable(ID), qty: int(1) }),
  'item.used': mut({ itemId: ID, slotId: ID, targetSlotId: nullable(ID) }),
  'currency.changed': mut({ slotId: nullable(ID), delta: CURRENCY_DELTA, reason: str({ maxLength: 64 }) }),
  'shop.bought': mut({ slotId: ID, refKey: str({ maxLength: 128 }), qty: int(1), price: CURRENCY_DELTA }),
  'shop.sold': mut({ slotId: ID, itemId: ID, qty: int(1), price: CURRENCY_DELTA }),
  'character.died': mut({ slotId: ID, cause: str({ maxLength: 64 }) }),
  'character.revived': mut({ slotId: ID, method: oneOf(REVIVE_METHODS), lifeStatus: oneOf(LIFE_STATUSES) }),
  'character.retired': mut({ slotId: ID, archiveId: ID, reason: str({ maxLength: 200 }) }),
  'character.joined': mut({ slotId: ID, characterId: ID, level: LEVEL }),
  'seat.filled': mut({ slotId: ID, seat: int(1, 6), controller: oneOf(CONTROLLER_TYPES) }),
  'story.chosen': shape({ nodeId: ID, choiceId: ID }, LOOSE),
  'snapshot.saved': shape({ snapshotId: ID, label: nullable(str({ maxLength: 128 })), atSeq: int(0) }, LOOSE),
  'snapshot.restored': mut({ snapshotId: ID, atSeq: int(0) }),
  'dm.override': mut({ kind: str({ maxLength: 64 }), slotId: nullable(ID) }),
  // E3 M65 W4 — before / after: { status, choices } of the level_ups row.
  'level.chosen': mut({ levelUpId: ID, slotId: ID, fromLevel: LEVEL, toLevel: LEVEL }),
  'rest.declared': shape({ slotId: ID, hitDice: mapOf(int(0, 20)) }, LOOSE),
  'heal.cast': mut({ casterSlotId: ID, spellId: str({ maxLength: 64 }), slotLevel: int(1, 9), targetSlotIds: arrayOf(ID, { min: 1, max: 6, unique: true }) })
});

const ENVELOPE = shape({
  seq: int(1),
  type: oneOf(RUN_EVENT_TYPES),
  nodeId: nullable(ID),
  actorKind: oneOf(RUN_ACTOR_KINDS),
  actorId: nullable(ID),
  override: bool(),
  ts: optional(num(0)),
  payload: shape({}, LOOSE)
});

function checkNoLeakedFields(c, value, path, top) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkNoLeakedFields(c, v, joinPath(path, i), false));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (top && (k === 'before' || k === 'after')) continue;
    const p = joinPath(path, k);
    if (k === 'ref' || k.startsWith('_')) {
      c.add(p, C.FORBIDDEN_FIELD, 'run events carry ids only — engine wrapper fields must not leak');
    }
    checkNoLeakedFields(c, v, p, false);
  }
}

/**
 * Validate one run event against catalogue v1.
 * @param {unknown} ev
 * @returns {import('./check.js').ValidationResult}
 */
export function validateRunEvent(ev) {
  const c = createCollector();
  checkJsonSafe(c, ev, '');
  checkSpec(c, ev, ENVELOPE, '');
  if (!isPlainObject(ev)) return c.result();
  if (ev.actorKind === 'player' && !ev.actorId) c.add('actorId', C.REQUIRED, 'a player event names its participant');
  if (ev.override === true && ev.actorKind !== 'dm') c.add('override', C.FORBIDDEN_FIELD, 'only the DM overrides');
  if (RUN_EVENT_TYPES.includes(ev.type) && isPlainObject(ev.payload)) {
    checkSpec(c, ev.payload, RUN_EVENT_PAYLOAD_SPECS[ev.type], 'payload');
    checkNoLeakedFields(c, ev.payload, 'payload', true);
  }
  return c.result();
}

/**
 * Validate an ordered run event log: every event valid, `seq` strictly
 * increasing.
 * @param {unknown} events
 * @returns {import('./check.js').ValidationResult}
 */
export function validateRunEventLog(events) {
  const c = createCollector();
  if (!Array.isArray(events)) {
    c.add('', C.TYPE, 'expected an array of run events');
    return c.result();
  }
  let last = 0;
  events.forEach((ev, i) => {
    for (const err of validateRunEvent(ev).errors) {
      c.add(err.path ? `[${i}].${err.path}` : `[${i}]`, err.code, err.message);
    }
    if (ev && Number.isInteger(ev.seq)) {
      if (ev.seq <= last) c.add(`[${i}].seq`, C.ORDER, `seq ${ev.seq} is not greater than ${last}`);
      last = Math.max(last, ev.seq);
    }
  });
  return c.result();
}

/**
 * Build a run event (no validation; pair with validateRunEvent).
 * @param {{seq: number, type: string, nodeId?: string|null, actorKind?: string, actorId?: string|null, override?: boolean, payload?: object}} args
 * @returns {{seq: number, type: string, nodeId: string|null, actorKind: string, actorId: string|null, override: boolean, payload: object}}
 */
export function makeRunEvent({ seq, type, nodeId = null, actorKind = 'system', actorId = null, override = false, payload = {} }) {
  return { seq, type, nodeId, actorKind, actorId, override, payload };
}
