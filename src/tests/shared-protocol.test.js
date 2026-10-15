/**
 * M64 H1 — ws envelope + message catalogue v1 contract tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROTOCOL_VERSION, MAX_CID_LENGTH, INTENT_TYPES, INTENT_ROLES, SERVER_MESSAGE_TYPES,
  SERVER_MESSAGE_SCOPE, ERROR_CODES, CLOSE_CODES, ROOM_STATUSES, PROMPT_KINDS, ROLL_KINDS,
  INTENT_PLAN_KINDS, validateClientMessage, validateServerMessage
} from '../js/shared/protocol.js';
import { EVENT_TYPES } from '../js/shared/events.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/contracts/${f}`, import.meta.url), 'utf8'));
const CLIENT = load('client-messages.valid.json');
const SERVER = load('server-messages.valid.json');
const STATE = load('encounter-state.valid.json');
const client = (t) => clone(CLIENT.find(m => m.t === t));
const server = (t) => clone(SERVER.find(m => m.t === t));

/** Deep copy of a JSON fixture. */
const clone = (v) => JSON.parse(JSON.stringify(v));

function assertNamedError(result, path, code) {
  assert.equal(result.ok, false, `expected failure for ${path} (${code})`);
  const hit = result.errors.find(e => e.path === path && e.code === code);
  assert.ok(hit, `expected {path:"${path}", code:"${code}"}, got ${JSON.stringify(result.errors)}`);
}

test('protocol: constants are frozen and versioned', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(MAX_CID_LENGTH, 64);
  for (const c of [INTENT_TYPES, INTENT_ROLES, SERVER_MESSAGE_TYPES, SERVER_MESSAGE_SCOPE, ERROR_CODES,
    CLOSE_CODES, ROOM_STATUSES, PROMPT_KINDS, ROLL_KINDS, INTENT_PLAN_KINDS]) {
    assert.ok(Object.isFrozen(c));
  }
  assert.deepEqual([...ROLL_KINDS], ['attack', 'damage', 'save']);
  assert.equal(CLOSE_CODES.TOO_BIG, 1009);
  assert.equal(CLOSE_CODES.SUPERSEDED, 4409);
});

test('protocol: every dm.* intent is DM-only and every intent has a role', () => {
  for (const t of INTENT_TYPES) {
    assert.ok(['any', 'player', 'seat', 'addressee', 'dm'].includes(INTENT_ROLES[t]), t);
    if (t.startsWith('dm.')) assert.equal(INTENT_ROLES[t], 'dm', `${t} must be DM-only`);
    else assert.notEqual(INTENT_ROLES[t], 'dm', `${t} is DM-only but lacks the dm. prefix`);
  }
});

test('protocol: engine events are sequenced broadcasts; plan names replace R1 duplicates', () => {
  for (const t of EVENT_TYPES) assert.equal(SERVER_MESSAGE_SCOPE[t], 'broadcast', t);
  for (const r1Name of ['entity.moved', 'cast.begin', 'cast.countered', 'reaction.pending']) {
    assert.ok(!SERVER_MESSAGE_TYPES.includes(r1Name), `${r1Name} is replaced by an engine event`);
  }
  for (const t of ['hello.ok', 'room.snapshot', 'ack', 'error', 'prompt.open', 'prompt.closed']) {
    assert.equal(SERVER_MESSAGE_SCOPE[t], 'private', t);
  }
});

test('protocol: one valid fixture per intent type, all pass', () => {
  assert.deepEqual(CLIENT.map(m => m.t).sort(), [...INTENT_TYPES].sort());
  for (const m of CLIENT) assert.deepEqual(validateClientMessage(m).errors, [], m.t);
});

test('protocol: one valid fixture per room message type, all pass', () => {
  const roomTypes = SERVER_MESSAGE_TYPES.filter(t => !EVENT_TYPES.includes(t));
  for (const t of roomTypes) assert.ok(SERVER.some(m => m.t === t), `missing fixture for ${t}`);
  for (const m of SERVER) assert.deepEqual(validateServerMessage(m).errors, [], m.t);
});

test('protocol: room.snapshot carries a projected EncounterState (no RNG)', () => {
  const m = server('room.snapshot');
  const view = clone(STATE);
  delete view.rng;
  m.p.encounter = view;
  assert.deepEqual(validateServerMessage(m).errors, []);
  m.p.encounter = clone(STATE);
  assertNamedError(validateServerMessage(m), 'p.encounter.rng', 'forbidden_field');
  delete view.encounterId;
  m.p.encounter = view;
  assertNamedError(validateServerMessage(m), 'p.encounter.encounterId', 'required');
});

const CLIENT_VIOLATIONS = [
  ['wrong version', 'turn.act', m => { m.v = 2; }, 'v', 'version'],
  ['missing cid', 'turn.act', m => { delete m.cid; }, 'cid', 'required'],
  ['cid too long', 'turn.act', m => { m.cid = 'x'.repeat(65); }, 'cid', 'range'],
  ['unknown intent', 'turn.act', m => { m.t = 'turn.cheat'; }, 't', 'enum'],
  ['server seq on a client message', 'turn.act', m => { m.seq = 5; }, 'seq', 'unknown_field'],
  ['unknown payload field (strict)', 'turn.act', m => { m.p.damage = 999; }, 'p.damage', 'unknown_field'],
  ['missing turnId', 'turn.act', m => { delete m.p.turnId; }, 'p.turnId', 'required'],
  ['bad plan kind', 'turn.act', m => { m.p.plan.kind = 'wish'; }, 'p.plan.kind', 'enum'],
  ['castAtLevel 10', 'turn.act', m => { m.p.plan.castAtLevel = 10; }, 'p.plan.castAtLevel', 'range'],
  ['duplicate features', 'turn.act', m => { m.p.plan.features = ['action-surge', 'action-surge']; }, 'p.plan.features[1]', 'duplicate'],
  ['path too long', 'turn.act', m => { m.p.plan.path = Array.from({ length: 65 }, () => ({ col: 0, row: 0 })); }, 'p.plan.path', 'range'],
  ['hello without token', 'hello', m => { delete m.p.token; }, 'p.token', 'required'],
  ['negative hp patch', 'dm.entity.patch', m => { m.p.hp = -1; }, 'p.hp', 'range'],
  ['player roll kind', 'dm.roll.arm', m => { m.p.rollKind = 'initiative'; }, 'p.rollKind', 'enum'],
  ['bad controller', 'dm.seat.setController', m => { m.p.controller = 'robot'; }, 'p.controller', 'enum'],
  ['terrain flags out of byte', 'dm.terrain.paint', m => { m.p.flags = 256; }, 'p.flags', 'range'],
  ['empty initiative order', 'dm.initiative.set', m => { m.p.order = []; }, 'p.order', 'range'],
  ['payload not object', 'resync', m => { m.p = []; }, 'p', 'type'],
  ['non-JSON answer', 'prompt.answer', m => { m.p.answer = () => true; }, 'p.answer', 'not_json_safe']
];

for (const [name, t, mutate, path, code] of CLIENT_VIOLATIONS) {
  test(`protocol: client violation fails — ${name}`, () => {
    const m = client(t);
    mutate(m);
    assertNamedError(validateClientMessage(m), path, code);
  });
}

const SERVER_VIOLATIONS = [
  ['wrong version', 'ack', m => { m.v = 0; }, 'v', 'version'],
  ['missing ts', 'ack', m => { delete m.ts; }, 'ts', 'required'],
  ['unknown type', 'ack', m => { m.t = 'entity.moved'; }, 't', 'enum'],
  ['private message with seq', 'ack', m => { m.seq = 4; }, 'seq', 'forbidden_field'],
  ['broadcast without seq', 'member.joined', m => { delete m.seq; }, 'seq', 'required'],
  ['bad error code', 'error', m => { m.p.code = 'E_OOPS'; }, 'p.code', 'enum'],
  ['bad prompt kind', 'prompt.open', m => { m.p.kind = 'opportunity'; }, 'p.kind', 'enum'],
  ['bad room status', 'room.status', m => { m.p.status = 'sleeping'; }, 'p.status', 'enum'],
  ['event seq mismatch', 'attack.rolled', m => { m.p.seq = 99; }, 'p.seq', 'ref'],
  ['event type mismatch', 'attack.rolled', m => { m.p.type = 'damage'; }, 'p.type', 'ref'],
  ['invalid engine event payload', 'attack.rolled', m => { delete m.p.payload.hit; }, 'p.payload.hit', 'required'],
  ['redacted unknown type', 'redacted', m => { m.p.type = 'secret'; }, 'p.type', 'enum']
];

for (const [name, t, mutate, path, code] of SERVER_VIOLATIONS) {
  test(`protocol: server violation fails — ${name}`, () => {
    const m = server(t);
    mutate(m);
    assertNamedError(validateServerMessage(m), path, code);
  });
}

test('protocol: validators never throw on garbage', () => {
  for (const bad of [null, undefined, 0, 'hello', [], { t: 'hello' }]) {
    assert.equal(validateClientMessage(bad).ok, false);
    assert.equal(validateServerMessage(bad).ok, false);
  }
});
