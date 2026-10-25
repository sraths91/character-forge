/**
 * M65 H22 — run event catalogue v1 contract tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RUN_EVENT_CATALOGUE_VERSION, RUN_EVENT_TYPES, MUTATING_RUN_EVENT_TYPES, RUN_EVENT_PAYLOAD_SPECS,
  RUN_ACTOR_KINDS, REVIVE_METHODS, isMutatingRunEvent, validateRunEvent, validateRunEventLog, makeRunEvent
} from '../js/shared/run-events.js';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/contracts/run-events.valid.json', import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const fixture = (type) => clone(FIXTURES.find(e => e.type === type));

function assertNamedError(result, path, code) {
  assert.equal(result.ok, false, `expected failure for ${path} (${code})`);
  const hit = result.errors.find(e => e.path === path && e.code === code);
  assert.ok(hit, `expected {path:"${path}", code:"${code}"}, got ${JSON.stringify(result.errors)}`);
}

test('run-events: catalogue is frozen, versioned, and matches the M65 plan list', () => {
  assert.equal(RUN_EVENT_CATALOGUE_VERSION, 1);
  assert.deepEqual([...RUN_EVENT_TYPES], [
    'run.started', 'run.ended', 'node.entered', 'node.completed', 'encounter.result', 'xp.awarded',
    'level.queued', 'level.applied', 'level.reverted', 'rest.taken', 'loot.granted', 'item.moved', 'item.used',
    'currency.changed', 'shop.bought', 'shop.sold', 'character.died', 'character.revived', 'character.retired',
    'character.joined', 'seat.filled', 'story.chosen', 'snapshot.saved', 'snapshot.restored', 'dm.override'
  ]);
  assert.deepEqual(Object.keys(RUN_EVENT_PAYLOAD_SPECS).sort(), [...RUN_EVENT_TYPES].sort());
  for (const t of MUTATING_RUN_EVENT_TYPES) assert.ok(RUN_EVENT_TYPES.includes(t), t);
  for (const c of [RUN_EVENT_TYPES, MUTATING_RUN_EVENT_TYPES, RUN_EVENT_PAYLOAD_SPECS, RUN_ACTOR_KINDS, REVIVE_METHODS]) {
    assert.ok(Object.isFrozen(c));
  }
  assert.deepEqual([...RUN_ACTOR_KINDS], ['dm', 'player', 'system']);
  assert.equal(isMutatingRunEvent('rest.taken'), true);
  assert.equal(isMutatingRunEvent('node.entered'), false);
});

test('run-events: the fixture has one valid example of every type and is an ordered log', () => {
  assert.deepEqual([...new Set(FIXTURES.map(e => e.type))].sort(), [...RUN_EVENT_TYPES].sort());
  for (const ev of FIXTURES) assert.deepEqual(validateRunEvent(ev).errors, [], ev.type);
  assert.deepEqual(validateRunEventLog(FIXTURES).errors, []);
});

for (const type of MUTATING_RUN_EVENT_TYPES) {
  test(`run-events: a mutating ${type} without {before, after} fails`, () => {
    for (const key of ['before', 'after']) {
      const ev = fixture(type);
      delete ev.payload[key];
      assertNamedError(validateRunEvent(ev), `payload.${key}`, 'required');
    }
    const nulls = fixture(type);
    nulls.payload.before = null;
    assert.deepEqual(validateRunEvent(nulls).errors, [], 'before may be null (a thing that did not exist yet)');
  });
}

test('run-events: lifecycle markers need no {before, after}', () => {
  for (const type of RUN_EVENT_TYPES.filter(t => !isMutatingRunEvent(t))) {
    const ev = fixture(type);
    assert.equal(ev.payload.before, undefined, `${type} fixture carries no before`);
    assert.deepEqual(validateRunEvent(ev).errors, [], type);
  }
});

const VIOLATIONS = [
  ['unknown type', e => { e.type = 'run.paused'; }, 'run.started', 'type', 'enum'],
  ['seq 0', e => { e.seq = 0; }, 'run.started', 'seq', 'range'],
  ['missing nodeId key', e => { delete e.nodeId; }, 'run.started', 'nodeId', 'required'],
  ['unknown actor kind', e => { e.actorKind = 'bot'; }, 'run.started', 'actorKind', 'enum'],
  ['player event without its participant', e => { e.actorId = null; }, 'story.chosen', 'actorId', 'required'],
  ['an override not by the DM', e => { e.actorKind = 'system'; e.actorId = null; }, 'dm.override', 'override', 'forbidden_field'],
  ['unknown envelope field', e => { e.room = 'r1'; }, 'run.started', 'room', 'unknown_field'],
  ['run outcome outside the enum', e => { e.payload.outcome = 'party-victory'; }, 'run.ended', 'payload.outcome', 'enum'],
  ['node kind outside the enum', e => { e.payload.kind = 'puzzle'; }, 'node.entered', 'payload.kind', 'enum'],
  ['encounter outcome outside the enum', e => { e.payload.outcome = 'victory'; }, 'encounter.result', 'payload.outcome', 'enum'],
  ['negative XP award', e => { e.payload.perCharacter['slot-1'] = -5; }, 'xp.awarded', 'payload.perCharacter.slot-1', 'range'],
  ['level 21', e => { e.payload.toLevel = 21; }, 'level.queued', 'payload.toLevel', 'range'],
  ['rest type choice (unresolved)', e => { e.payload.type = 'choice'; }, 'rest.taken', 'payload.type', 'enum'],
  ['fractional coin delta', e => { e.payload.delta.gp = 0.5; }, 'currency.changed', 'payload.delta.gp', 'type'],
  ['unknown revive method', e => { e.payload.method = 'wish'; }, 'character.revived', 'payload.method', 'enum'],
  ['seat 0', e => { e.payload.seat = 0; }, 'seat.filled', 'payload.seat', 'range'],
  ['a leaked wrapper field', e => { e.payload._position = { col: 1, row: 1 }; }, 'node.entered', 'payload._position', 'forbidden_field'],
  ['a leaked ref', e => { e.payload.seats[0].ref = {}; }, 'run.started', 'payload.seats[0].ref', 'forbidden_field'],
  ['a non-JSON payload', e => { e.payload.when = new Date(0); }, 'snapshot.saved', 'payload.when', 'not_json_safe']
];

for (const [name, mutate, type, path, code] of VIOLATIONS) {
  test(`run-events: planted violation fails — ${name}`, () => {
    const ev = fixture(type);
    mutate(ev);
    assertNamedError(validateRunEvent(ev), path, code);
  });
}

test('run-events: before/after may carry whole sheets (no leak check inside them)', () => {
  const ev = fixture('level.applied');
  ev.payload.before = { sheet: { _legacy: 1, ref: 'x' } };
  assert.deepEqual(validateRunEvent(ev).errors, []);
});

test('run-events: payloads may add fields (additive change, no version bump)', () => {
  const ev = fixture('rest.taken');
  ev.payload.hitDiceSpent = { Cleric: 1 };
  assert.deepEqual(validateRunEvent(ev).errors, []);
});

test('run-events: log rejects non-increasing seq and non-arrays', () => {
  const log = clone(FIXTURES.slice(0, 3));
  log[2].seq = log[1].seq;
  assertNamedError(validateRunEventLog(log), '[2].seq', 'order');
  assertNamedError(validateRunEventLog({}), '', 'type');
});

test('run-events: makeRunEvent builds a valid envelope with system defaults', () => {
  const ev = makeRunEvent({ seq: 4, type: 'node.completed', payload: { nodeId: 'n1', kind: 'rest' } });
  assert.deepEqual(ev, { seq: 4, type: 'node.completed', nodeId: null, actorKind: 'system', actorId: null, override: false, payload: { nodeId: 'n1', kind: 'rest' } });
  assert.deepEqual(validateRunEvent(ev).errors, []);
});

test('run-events: validators never throw on garbage', () => {
  for (const g of [undefined, null, 0, 'x', [], {}, { type: 'rest.taken', payload: null }, { type: 'rest.taken', payload: [1] }, [null, { seq: 'a' }]]) {
    assert.doesNotThrow(() => validateRunEvent(g));
    assert.doesNotThrow(() => validateRunEventLog(g));
  }
});
