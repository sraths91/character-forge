/**
 * M64 contract 2 of 3 — engine event catalogue v1.
 *
 * Every state change the engine makes is described by one event:
 *   { seq, type, round, turnId, cinemaGroup, payload }
 * Events carry ids only (never wrapper/object references) and no
 * wall-clock time, so a log replays identically anywhere. The server
 * persists them (`encounter_events`) and broadcasts each one as a
 * sequenced ws message whose `t` is the event type (see protocol.js).
 *
 * Source: docs/M64-ONLINE-TABLE-PLAN.md "Contracts" §2, payload fields
 * from the E1 engine review §4 and R1 §3.5 (`exchange`). Envelope keys
 * are strict; payloads must carry their required fields but may add
 * fields (additive payload changes need no version bump). Payloads may
 * never contain a `ref` key or an `_underscore` key at any depth — that
 * is how a leaked engine wrapper shows up.
 *
 * Imported by both Vite and Node: no DOM, no Node built-ins.
 */

import {
  createCollector, checkSpec, checkJsonSafe, joinPath, isPlainObject,
  str, int, bool, oneOf, arrayOf, shape, anyJson, optional, nullable,
  VALIDATION_CODES
} from './check.js';
import { ABILITIES } from './encounter-state.js';

/**
 * Catalogue version. Bump on any breaking payload or type change.
 * v1.1 (additive, 2026-10-15, E1): `exchange.payload.cinema` pins the
 * animation inputs (weapon, style, swing, modifiers[], smiteSlot,
 * attackerLevel, killing, spell, outcome, fxSeed, durationMs). The
 * engine emits `durationMs: 0` (it cannot import the anim builders);
 * the server falls back to its fixed pacing cap when it is 0.
 */
export const EVENT_CATALOGUE_VERSION = 1;
/** Additive minor revision of catalogue v1. */
export const EVENT_CATALOGUE_MINOR = 1;

/** Every event type, in catalogue order. */
export const EVENT_TYPES = Object.freeze([
  'turn.started', 'turn.ended', 'turn.skipped',
  'plan.chosen',
  'move',
  'reaction.offered', 'reaction.resolved',
  'attack.rolled',
  'damage', 'heal',
  'save.rolled',
  'spell.cast', 'spell.countered', 'spell.fizzled',
  'condition.applied', 'condition.removed',
  'concentration.started', 'concentration.broken',
  'resource.spent',
  'feature.used',
  'entity.downed',
  'exchange',
  'dm.override',
  'turn.rejected',
  'encounter.ended'
]);

/** Reaction kinds offered to a creature. */
export const REACTION_KINDS = Object.freeze(['oa', 'shield', 'counterspell']);
/** Who answered a reaction. */
export const REACTION_SOURCES = Object.freeze(['player', 'auto', 'timeout', 'dm']);
/** Who chose a plan. */
export const PLAN_SOURCES = Object.freeze(['ai', 'player', 'dm']);
/** Advantage modes on a d20 roll. */
export const ADVANTAGE_MODES = Object.freeze(['normal', 'advantage', 'disadvantage']);
/** Why a spell produced no effect. */
export const FIZZLE_REASONS = Object.freeze(['shield', 'counterspell']);
/** How an encounter ended. */
export const ENCOUNTER_OUTCOMES = Object.freeze(['party-victory', 'hostile-victory', 'draw', 'dm-ended']);

/**
 * @typedef {object} EncounterEvent
 * @property {number} seq          — room-monotonic, >= 1
 * @property {string} type         — one of EVENT_TYPES
 * @property {number} round        — encounter round (0 before round 1)
 * @property {string|null} turnId  — server-issued turn id, null between turns
 * @property {string|null} cinemaGroup — events sharing a group replay as one cinema
 * @property {object} payload      — per-type, see EVENT_PAYLOAD_SPECS
 */

const ID = str({ maxLength: 128 });
const POS = shape({ col: int(0), row: int(0) });
const LOOSE = { strict: false };

/**
 * Required payload fields per event type. Payloads are non-strict:
 * extra fields are allowed, listed ones are enforced.
 */
export const EVENT_PAYLOAD_SPECS = Object.freeze({
  'turn.started': shape({ actorId: ID }, LOOSE),
  'turn.ended': shape({ actorId: ID, stateHash: optional(str()) }, LOOSE),
  'turn.skipped': shape({ actorId: ID, reason: str() }, LOOSE),
  'plan.chosen': shape({
    actorId: ID,
    kind: str(),
    targetId: nullable(ID),
    source: oneOf(PLAN_SOURCES),
    weapon: optional(nullable(str())),
    spellId: optional(nullable(str())),
    castAtLevel: optional(nullable(int(0, 9))),
    featuresFired: optional(arrayOf(str())),
    archetype: optional(nullable(str()))
  }, LOOSE),
  move: shape({ actorId: ID, from: POS, to: POS, path: optional(arrayOf(POS)) }, LOOSE),
  'reaction.offered': shape({
    reactorId: ID, kind: oneOf(REACTION_KINDS), autoAnswer: bool(),
    deadlineMs: optional(nullable(int(0)))
  }, LOOSE),
  'reaction.resolved': shape({
    reactorId: ID, kind: oneOf(REACTION_KINDS), used: bool(), by: oneOf(REACTION_SOURCES)
  }, LOOSE),
  'attack.rolled': shape({
    attackerId: ID, targetId: ID,
    weapon: nullable(str()),
    isReaction: bool(),
    advantage: oneOf(ADVANTAGE_MODES),
    d20: arrayOf(int(1, 20), { min: 1, max: 2 }),
    kept: int(1, 20),
    bonus: int(),
    total: int(),
    ac: int(0),
    hit: bool(),
    crit: bool(),
    shielded: bool()
  }, LOOSE),
  damage: shape({
    sourceId: nullable(ID), targetId: ID,
    amount: int(0),
    type: nullable(str()),
    hpBefore: int(0), hpAfter: int(0),
    parts: optional(shape({}, LOOSE))
  }, LOOSE),
  heal: shape({
    sourceId: nullable(ID), targetId: ID,
    amount: int(0), hpBefore: int(0), hpAfter: int(0)
  }, LOOSE),
  'save.rolled': shape({
    entityId: ID, stat: oneOf(ABILITIES), dc: int(0),
    d20: arrayOf(int(1, 20), { min: 1, max: 2 }),
    total: int(), success: bool(), reason: str()
  }, LOOSE),
  'spell.cast': shape({
    casterId: ID, spellId: str(), castAtLevel: int(0, 9),
    slotSpent: nullable(int(1, 9)), innate: bool(), targetIds: arrayOf(ID)
  }, LOOSE),
  'spell.countered': shape({ casterId: ID, counterId: ID, check: nullable(shape({}, LOOSE)) }, LOOSE),
  'spell.fizzled': shape({ casterId: ID, reason: oneOf(FIZZLE_REASONS) }, LOOSE),
  'condition.applied': shape({ entityId: ID, condition: str(), sourceId: nullable(ID) }, LOOSE),
  'condition.removed': shape({ entityId: ID, condition: str(), sourceId: nullable(ID) }, LOOSE),
  'concentration.started': shape({ casterId: ID, spellId: str() }, LOOSE),
  'concentration.broken': shape({ casterId: ID, spellId: str() }, LOOSE),
  'resource.spent': shape({ entityId: ID, resource: str(), level: nullable(int(0, 9)) }, LOOSE),
  'feature.used': shape({ entityId: ID, featureId: str() }, LOOSE),
  'entity.downed': shape({ entityId: ID }, LOOSE),
  exchange: shape({
    exchangeId: ID,
    attackerId: ID,
    defenderId: nullable(ID),
    reaction: bool(),
    cast: bool(),
    roll: optional(nullable(shape({}, LOOSE))),
    damage: optional(nullable(shape({}, LOOSE))),
    effects: arrayOf(shape({
      entityId: ID,
      hp: shape({ before: int(0), after: int(0), max: int(0) }, LOOSE)
    }, LOOSE)),
    // v1.1 (additive, M64 E1 for E2's cinema-plan): every animation
    // input the client's pure Sequence builder needs, pinned.
    cinema: shape({
      weapon: nullable(shape({ name: str(), damageType: nullable(str()), magical: bool() }, LOOSE)),
      style: nullable(str()),
      swing: nullable(str()),
      modifiers: arrayOf(str()),
      smiteSlot: nullable(int(1, 9)),
      attackerLevel: int(0, 30),
      killing: bool(),
      spell: nullable(shape({ id: str(), kind: str(), aoe: bool(), damageType: nullable(str()) }, LOOSE)),
      outcome: nullable(shape({}, LOOSE)),
      fxSeed: int(0, 0xFFFFFFFF),
      durationMs: int(0)
    }, LOOSE)
  }, LOOSE),
  'dm.override': shape({
    kind: str(), entityId: nullable(ID), before: anyJson(), after: anyJson()
  }, LOOSE),
  'turn.rejected': shape({ actorId: ID, reason: str(), code: optional(str()) }, LOOSE),
  'encounter.ended': shape({ outcome: oneOf(ENCOUNTER_OUTCOMES) }, LOOSE)
});

const ENVELOPE = shape({
  seq: int(1),
  type: oneOf(EVENT_TYPES),
  round: int(0),
  turnId: nullable(ID),
  cinemaGroup: nullable(ID),
  payload: shape({}, LOOSE)
});

function checkNoLeakedFields(c, value, path) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkNoLeakedFields(c, v, joinPath(path, i)));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    const p = joinPath(path, k);
    if (k === 'ref' || k.startsWith('_')) {
      c.add(p, VALIDATION_CODES.FORBIDDEN_FIELD, 'events carry ids only — engine wrapper fields must not leak');
    }
    checkNoLeakedFields(c, v, p);
  }
}

/**
 * Validate one event against catalogue v1.
 * @param {unknown} ev
 * @returns {import('./check.js').ValidationResult}
 */
export function validateEvent(ev) {
  const c = createCollector();
  checkJsonSafe(c, ev, '');
  checkSpec(c, ev, ENVELOPE, '');
  if (ev && typeof ev === 'object' && EVENT_TYPES.includes(ev.type) && isPlainObject(ev.payload)) {
    checkSpec(c, ev.payload, EVENT_PAYLOAD_SPECS[ev.type], 'payload');
    checkNoLeakedFields(c, ev.payload, 'payload');
  }
  return c.result();
}

/**
 * Validate an ordered event log: every event valid and `seq` strictly
 * increasing (gaps are allowed — the room seq also numbers non-engine
 * broadcasts).
 * @param {unknown} events
 * @returns {import('./check.js').ValidationResult}
 */
export function validateEventLog(events) {
  const c = createCollector();
  if (!Array.isArray(events)) {
    c.add('', VALIDATION_CODES.TYPE, 'expected an array of events');
    return c.result();
  }
  let last = 0;
  events.forEach((ev, i) => {
    for (const err of validateEvent(ev).errors) {
      c.add(err.path ? `[${i}].${err.path}` : `[${i}]`, err.code, err.message);
    }
    if (ev && Number.isInteger(ev.seq)) {
      if (ev.seq <= last) c.add(`[${i}].seq`, VALIDATION_CODES.ORDER, `seq ${ev.seq} is not greater than ${last}`);
      last = Math.max(last, ev.seq);
    }
  });
  return c.result();
}

/**
 * Build an event object (no validation; pair with validateEvent in tests).
 * @param {{seq: number, type: string, round: number, turnId?: string|null, cinemaGroup?: string|null, payload?: object}} args
 * @returns {EncounterEvent}
 */
export function makeEvent({ seq, type, round, turnId = null, cinemaGroup = null, payload = {} }) {
  return { seq, type, round, turnId, cinemaGroup, payload };
}

