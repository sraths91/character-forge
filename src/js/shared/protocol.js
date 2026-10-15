/**
 * M64 contract 3 of 3 — ws envelope + message catalogue v1.
 *
 *   client → server  { v, t, cid, p }          cid de-dupes retries
 *   server → client  { v, t, seq, ts, p }      broadcast, room-monotonic seq
 *                    { v, t, ts, p }           private (no seq)
 *
 * Sources: docs/M64-ONLINE-TABLE-PLAN.md "Contracts" §3 and R1 §3.3 /
 * Appendix C. Where R1 and the plan's event catalogue name the same
 * thing differently the plan wins, so these R1 server messages are NOT
 * in v1 — their engine events replace them:
 *   entity.moved → move · cast.begin → spell.cast ·
 *   cast.countered → spell.countered · reaction.pending → reaction.offered
 *
 * Engine events (events.js EVENT_TYPES) are broadcast with `t` = event
 * type, `seq` = event.seq, and `p` = the whole event object.
 *
 * Additions beyond R1 Appendix C (all DM-only):
 *   dm.entity.add / dm.entity.remove  — "+ Monster" mid-encounter (T8 insert/removeInitiative)
 *   dm.terrain.paint                  — the plan's `terrain.paint` brush (M6), dm.* prefixed so
 *                                       the gateway's "dm.* is DM-only" rule covers it
 * and one broadcast: `redacted {type}` keeps `seq` gap-free when viewFor
 * hides an event (e.g. a dm-only dm.override) from a seat.
 *
 * Client payloads are strict (unknown fields rejected); server payloads
 * enforce required fields and allow additive ones.
 *
 * Imported by both Vite and Node: no DOM, no Node built-ins.
 */

import {
  createCollector, checkSpec, checkJsonSafe, isPlainObject,
  str, int, num, bool, oneOf, arrayOf, shape, anyJson, optional, nullable,
  VALIDATION_CODES
} from './check.js';
import { CONTROLLER_TYPES, validateEncounterState } from './encounter-state.js';
import { EVENT_TYPES, REACTION_KINDS, ENCOUNTER_OUTCOMES, validateEvent } from './events.js';

/** Wire protocol version; every message's `v` must equal this. */
export const PROTOCOL_VERSION = 1;
/** Longest accepted client message id. */
export const MAX_CID_LENGTH = 64;

/** Who may send an intent. 'seat' = the controller of the acting entity (the DM for dm-controlled ones). */
export const INTENT_ROLES = Object.freeze({
  hello: 'any',
  resync: 'any',
  'seat.claim': 'player',
  'seat.release': 'player',
  'char.setStyle': 'seat',
  'turn.act': 'seat',
  'turn.delegate': 'seat',
  'prompt.answer': 'addressee',
  'cinema.done': 'any',
  'dm.encounter.setup': 'dm',
  'dm.initiative.roll': 'dm',
  'dm.initiative.set': 'dm',
  'dm.encounter.start': 'dm',
  'dm.encounter.end': 'dm',
  'dm.pause': 'dm',
  'dm.resume': 'dm',
  'dm.turn.skip': 'dm',
  'dm.seat.setController': 'dm',
  'dm.entity.patch': 'dm',
  'dm.entity.add': 'dm',
  'dm.entity.remove': 'dm',
  'dm.terrain.paint': 'dm',
  'dm.roll.arm': 'dm',
  'dm.review.set': 'dm',
  'dm.prompt.force': 'dm',
  'dm.member.revoke': 'dm'
});

/** Every client → server message type. */
export const INTENT_TYPES = Object.freeze(Object.keys(INTENT_ROLES));

/** Room-level (non-engine) server message types and their scope. */
const ROOM_MESSAGE_SCOPES = {
  'hello.ok': 'private',
  'room.snapshot': 'private',
  ack: 'private',
  error: 'private',
  'prompt.open': 'private',
  'prompt.closed': 'private',
  'turn.planProposed': 'private',
  'member.joined': 'broadcast',
  'member.left': 'broadcast',
  'member.presence': 'broadcast',
  'seat.updated': 'broadcast',
  'encounter.created': 'broadcast',
  'encounter.initiative': 'broadcast',
  'round.started': 'broadcast',
  'entity.updated': 'broadcast',
  'room.status': 'broadcast',
  'room.closing': 'broadcast',
  redacted: 'broadcast'
};

/** 'broadcast' (sequenced) or 'private' (no seq) for every server message type. */
export const SERVER_MESSAGE_SCOPE = Object.freeze({
  ...ROOM_MESSAGE_SCOPES,
  ...Object.fromEntries(EVENT_TYPES.map(t => [t, 'broadcast']))
});

/** Every server → client message type (room messages + engine events). */
export const SERVER_MESSAGE_TYPES = Object.freeze(Object.keys(SERVER_MESSAGE_SCOPE));

/** Error codes carried by `error` frames. */
export const ERROR_CODES = Object.freeze([
  'E_BAD_MESSAGE', 'E_VERSION', 'E_UNKNOWN_TYPE', 'E_UNAUTHENTICATED', 'E_FORBIDDEN',
  'E_STALE', 'E_NOT_YOUR_TURN', 'E_INVALID_INTENT', 'E_ROOM_FULL', 'E_SEAT_TAKEN',
  'E_RATE_LIMITED', 'E_INTERNAL'
]);

/** ws close codes used by the gateway (B7, B9). */
export const CLOSE_CODES = Object.freeze({
  NORMAL: 1000,
  POLICY: 1008,            // token bucket exceeded
  TOO_BIG: 1009,           // maxPayload
  RESTARTING: 1012,        // graceful shutdown
  HELLO_TIMEOUT: 4401,     // no valid hello within 5 s
  REVOKED: 4403,           // dm.member.revoke
  SUPERSEDED: 4409         // same member connected elsewhere
});

/** Room status values (`room.status`). */
export const ROOM_STATUSES = Object.freeze(['lobby', 'setup', 'in-encounter', 'paused', 'encounter-over', 'closed', 'error']);
/** Prompt kinds: the three reactions plus DM plan / roll review. */
export const PROMPT_KINDS = Object.freeze([...REACTION_KINDS, 'plan', 'roll']);
/** Rolls the DM may arm or edit in phase 1 (monster / AI rolls only). */
export const ROLL_KINDS = Object.freeze(['attack', 'damage', 'save']);
/** Plan kinds a client may submit in `turn.act`. */
export const INTENT_PLAN_KINDS = Object.freeze(['melee', 'ranged', 'attack', 'cast', 'dash', 'dodge', 'disengage', 'move', 'feature']);

const ID = str({ maxLength: 128 });
const POS = shape({ col: int(0), row: int(0) });
const LOOSE = { strict: false };

const PLAN = shape({
  kind: oneOf(INTENT_PLAN_KINDS),
  targetId: optional(nullable(ID)),
  targetSide: optional(oneOf(['enemy', 'ally'])),
  weaponName: optional(str({ maxLength: 128 })),
  spellId: optional(str({ maxLength: 128 })),
  castAtLevel: optional(int(0, 9)),
  moveTo: optional(POS),
  path: optional(arrayOf(POS, { max: 64 })),
  features: optional(arrayOf(str({ maxLength: 64 }), { max: 8, unique: true }))
});

/** Client payload specs (strict). */
const INTENT_PAYLOADS = {
  hello: shape({ token: str({ maxLength: 512 }), protocol: int(1), lastSeq: optional(int(0)) }),
  resync: shape({ lastSeq: optional(int(0)) }),
  'seat.claim': shape({ characterId: ID }),
  'seat.release': shape({ characterId: ID }),
  'char.setStyle': shape({ characterId: ID, style: str({ maxLength: 32 }), swing: nullable(str({ maxLength: 32 })) }),
  'turn.act': shape({ turnId: ID, plan: PLAN }),
  'turn.delegate': shape({ turnId: ID }),
  'prompt.answer': shape({ promptId: ID, answer: anyJson() }),
  'cinema.done': shape({ exchangeId: ID }),
  'dm.encounter.setup': shape({
    map: nullable(shape({}, LOOSE)),
    grid: shape({ cols: int(1, 500), rows: int(1, 500) }, LOOSE),
    monsters: arrayOf(shape({}, LOOSE), { max: 64 }),
    placements: shape({}, LOOSE)
  }),
  'dm.initiative.roll': shape({}),
  'dm.initiative.set': shape({ order: arrayOf(ID, { min: 1, unique: true }) }),
  'dm.encounter.start': shape({ seed: optional(int(0, 0xFFFFFFFF)) }),
  'dm.encounter.end': shape({ outcome: optional(oneOf(ENCOUNTER_OUTCOMES)) }),
  'dm.pause': shape({}),
  'dm.resume': shape({}),
  'dm.turn.skip': shape({ entityId: optional(ID) }),
  'dm.seat.setController': shape({ entityId: ID, controller: oneOf(CONTROLLER_TYPES), memberId: optional(nullable(ID)) }),
  'dm.entity.patch': shape({
    entityId: ID,
    hp: optional(int(0)),
    hpTemp: optional(int(0)),
    addConditions: optional(arrayOf(str({ maxLength: 64 }))),
    removeConditions: optional(arrayOf(str({ maxLength: 64 }))),
    position: optional(POS)
  }),
  'dm.entity.add': shape({ entity: shape({}, LOOSE), initiativeScore: optional(num()) }),
  'dm.entity.remove': shape({ entityId: ID }),
  'dm.terrain.paint': shape({ cells: arrayOf(POS, { min: 1, max: 4096 }), flags: int(0, 255), mode: oneOf(['set', 'clear']) }),
  'dm.roll.arm': shape({ entityId: optional(nullable(ID)), rollKind: oneOf(ROLL_KINDS), value: int() }),
  'dm.review.set': shape({ plans: optional(bool()), rolls: optional(bool()), monsterReactions: optional(bool()) }),
  'dm.prompt.force': shape({ promptId: ID, answer: anyJson() }),
  'dm.member.revoke': shape({ memberId: ID })
};

/** Server room-message payload specs (required fields; extras allowed). */
const SERVER_PAYLOADS = {
  'hello.ok': shape({ memberId: ID, role: oneOf(['dm', 'player']), seats: arrayOf(shape({}, LOOSE)), serverNow: num(0), cfg: shape({}, LOOSE) }, LOOSE),
  'room.snapshot': shape({
    seq: int(0), room: shape({}, LOOSE),
    encounter: nullable(shape({}, LOOSE)),
    openPrompt: optional(nullable(shape({}, LOOSE))),
    history: arrayOf(shape({}, LOOSE))
  }, LOOSE),
  ack: shape({ cid: str({ maxLength: MAX_CID_LENGTH }), ok: bool() }, LOOSE),
  error: shape({ cid: nullable(str({ maxLength: MAX_CID_LENGTH })), code: oneOf(ERROR_CODES), message: str() }, LOOSE),
  'prompt.open': shape({
    promptId: ID, kind: oneOf(PROMPT_KINDS), payload: shape({}, LOOSE),
    autoAnswer: anyJson(), deadlineAt: num(0), serverNow: num(0)
  }, LOOSE),
  'prompt.closed': shape({ promptId: ID, reason: str() }, LOOSE),
  'turn.planProposed': shape({ entityId: ID, plan: shape({}, LOOSE), breakdown: arrayOf(anyJson()) }, LOOSE),
  'member.joined': shape({ memberId: ID, displayName: str({ maxLength: 64 }) }, LOOSE),
  'member.left': shape({ memberId: ID }, LOOSE),
  'member.presence': shape({ memberId: ID, online: bool() }, LOOSE),
  'seat.updated': shape({ characterId: ID, memberId: nullable(ID), controller: oneOf(CONTROLLER_TYPES) }, LOOSE),
  'encounter.created': shape({ encounterId: ID }, LOOSE),
  'encounter.initiative': shape({ order: arrayOf(shape({ entityId: ID, score: num() }, LOOSE)) }, LOOSE),
  'round.started': shape({ round: int(1) }, LOOSE),
  'entity.updated': shape({ entityId: ID, patch: shape({}, LOOSE), cause: str() }, LOOSE),
  'room.status': shape({ status: oneOf(ROOM_STATUSES) }, LOOSE),
  'room.closing': shape({ reason: str() }, LOOSE),
  redacted: shape({ type: oneOf(EVENT_TYPES) }, LOOSE)
};

const CLIENT_ENVELOPE = shape({
  v: anyJson(),
  t: str({ maxLength: 64 }),
  cid: str({ maxLength: MAX_CID_LENGTH }),
  p: shape({}, LOOSE)
});

const SERVER_ENVELOPE = shape({
  v: anyJson(),
  t: str({ maxLength: 64 }),
  seq: optional(int(1)),
  ts: num(0),
  p: shape({}, LOOSE)
});

function checkVersion(c, msg) {
  if (isPlainObject(msg) && msg.v !== PROTOCOL_VERSION) {
    c.add('v', VALIDATION_CODES.VERSION, `expected ${PROTOCOL_VERSION}, got ${JSON.stringify(msg.v)}`);
  }
}

/**
 * Validate a client → server message.
 * @param {unknown} msg
 * @returns {import('./check.js').ValidationResult}
 */
export function validateClientMessage(msg) {
  const c = createCollector();
  checkJsonSafe(c, msg, '');
  checkSpec(c, msg, CLIENT_ENVELOPE, '');
  checkVersion(c, msg);
  if (!isPlainObject(msg) || typeof msg.t !== 'string') return c.result();
  if (!Object.prototype.hasOwnProperty.call(INTENT_PAYLOADS, msg.t)) {
    c.add('t', VALIDATION_CODES.ENUM, `unknown intent type "${msg.t}"`);
    return c.result();
  }
  if (isPlainObject(msg.p)) checkSpec(c, msg.p, INTENT_PAYLOADS[msg.t], 'p');
  return c.result();
}

/**
 * Validate a server → client message. Engine-event broadcasts are
 * validated with validateEvent and must repeat the envelope seq;
 * `room.snapshot.encounter` must be a projected EncounterState.
 * @param {unknown} msg
 * @returns {import('./check.js').ValidationResult}
 */
export function validateServerMessage(msg) {
  const c = createCollector();
  checkJsonSafe(c, msg, '');
  checkSpec(c, msg, SERVER_ENVELOPE, '');
  checkVersion(c, msg);
  if (!isPlainObject(msg) || typeof msg.t !== 'string') return c.result();
  const scope = SERVER_MESSAGE_SCOPE[msg.t];
  if (!scope) {
    c.add('t', VALIDATION_CODES.ENUM, `unknown server message type "${msg.t}"`);
    return c.result();
  }
  if (scope === 'broadcast' && msg.seq === undefined) {
    c.add('seq', VALIDATION_CODES.REQUIRED, `broadcast "${msg.t}" must carry seq`);
  }
  if (scope === 'private' && msg.seq !== undefined) {
    c.add('seq', VALIDATION_CODES.FORBIDDEN_FIELD, `private "${msg.t}" must not carry seq`);
  }
  if (!isPlainObject(msg.p)) return c.result();

  if (EVENT_TYPES.includes(msg.t)) {
    for (const err of validateEvent(msg.p).errors) {
      c.add(err.path ? `p.${err.path}` : 'p', err.code, err.message);
    }
    if (msg.p.type !== msg.t) c.add('p.type', VALIDATION_CODES.REF, `must equal t "${msg.t}"`);
    if (msg.p.seq !== msg.seq) c.add('p.seq', VALIDATION_CODES.REF, 'must equal the envelope seq');
    return c.result();
  }

  checkSpec(c, msg.p, SERVER_PAYLOADS[msg.t], 'p');
  if (msg.t === 'room.snapshot' && isPlainObject(msg.p.encounter)) {
    for (const err of validateEncounterState(msg.p.encounter, { projected: true }).errors) {
      c.add(err.path ? `p.encounter.${err.path}` : 'p.encounter', err.code, err.message);
    }
  }
  return c.result();
}
