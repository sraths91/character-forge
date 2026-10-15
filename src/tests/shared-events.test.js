/**
 * M64 H1 — engine event catalogue v1 contract tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EVENT_CATALOGUE_VERSION, EVENT_TYPES, EVENT_PAYLOAD_SPECS, REACTION_KINDS, REACTION_SOURCES,
  PLAN_SOURCES, ADVANTAGE_MODES, FIZZLE_REASONS, ENCOUNTER_OUTCOMES,
  validateEvent, validateEventLog, makeEvent
} from '../js/shared/events.js';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/contracts/events.valid.json', import.meta.url), 'utf8'));
const byType = (type) => clone(FIXTURES.find(e => e.type === type));

/** Deep copy of a JSON fixture. */
const clone = (v) => JSON.parse(JSON.stringify(v));

function assertNamedError(result, path, code) {
  assert.equal(result.ok, false, `expected failure for ${path} (${code})`);
  const hit = result.errors.find(e => e.path === path && e.code === code);
  assert.ok(hit, `expected {path:"${path}", code:"${code}"}, got ${JSON.stringify(result.errors)}`);
}

test('events: catalogue is frozen, versioned, and matches the M64 plan list', () => {
  assert.equal(EVENT_CATALOGUE_VERSION, 1);
  assert.ok(Object.isFrozen(EVENT_TYPES));
  assert.deepEqual([...EVENT_TYPES], [
    'turn.started', 'turn.ended', 'turn.skipped', 'plan.chosen', 'move',
    'reaction.offered', 'reaction.resolved', 'attack.rolled', 'damage', 'heal',
    'save.rolled', 'spell.cast', 'spell.countered', 'spell.fizzled',
    'condition.applied', 'condition.removed', 'concentration.started', 'concentration.broken',
    'resource.spent', 'feature.used', 'entity.downed', 'exchange', 'dm.override',
    'turn.rejected', 'encounter.ended'
  ]);
  for (const t of EVENT_TYPES) assert.ok(EVENT_PAYLOAD_SPECS[t], `${t} has a payload spec`);
  assert.deepEqual(Object.keys(EVENT_PAYLOAD_SPECS).sort(), [...EVENT_TYPES].sort());
  for (const list of [REACTION_KINDS, REACTION_SOURCES, PLAN_SOURCES, ADVANTAGE_MODES, FIZZLE_REASONS, ENCOUNTER_OUTCOMES]) {
    assert.ok(Object.isFrozen(list));
  }
  assert.deepEqual([...REACTION_KINDS], ['oa', 'shield', 'counterspell']);
});

test('events: the fixture has one valid example of every event type', () => {
  assert.deepEqual(FIXTURES.map(e => e.type).sort(), [...EVENT_TYPES].sort());
  for (const ev of FIXTURES) {
    const r = validateEvent(ev);
    assert.deepEqual(r.errors, [], `${ev.type} should be valid`);
  }
});

test('events: the fixture log validates as an ordered log', () => {
  assert.deepEqual(validateEventLog(FIXTURES).errors, []);
});

test('events: makeEvent builds a valid envelope with null defaults', () => {
  const ev = makeEvent({ seq: 1, type: 'entity.downed', round: 2, payload: { entityId: 'm1' } });
  assert.deepEqual(ev, { seq: 1, type: 'entity.downed', round: 2, turnId: null, cinemaGroup: null, payload: { entityId: 'm1' } });
  assert.equal(validateEvent(ev).ok, true);
});

test('events: payloads may add fields (additive change, no version bump)', () => {
  const ev = byType('damage');
  ev.payload.resisted = true;
  assert.equal(validateEvent(ev).ok, true);
});

const VIOLATIONS = [
  ['unknown type', 'damage', e => { e.type = 'damage.dealt'; }, 'type', 'enum'],
  ['seq zero', 'damage', e => { e.seq = 0; }, 'seq', 'range'],
  ['wall-clock field on envelope', 'damage', e => { e.ts = 1760400000000; }, 'ts', 'unknown_field'],
  ['missing round', 'damage', e => { delete e.round; }, 'round', 'required'],
  ['turnId must be string or null', 'damage', e => { e.turnId = 7; }, 'turnId', 'type'],
  ['payload not an object', 'damage', e => { e.payload = 'x'; }, 'payload', 'type'],
  ['missing required payload id', 'damage', e => { delete e.payload.targetId; }, 'payload.targetId', 'required'],
  ['negative damage', 'damage', e => { e.payload.amount = -3; }, 'payload.amount', 'range'],
  ['object ref instead of id', 'damage', e => { e.payload.targetId = { id: 'm-goblin', hp: 7 }; }, 'payload.targetId', 'type'],
  ['leaked wrapper ref', 'exchange', e => { e.payload.cinema.ref = { name: 'Hero' }; }, 'payload.cinema.ref', 'forbidden_field'],
  ['leaked underscore field', 'plan.chosen', e => { e.payload._mctsTargetCtx = {}; }, 'payload._mctsTargetCtx', 'forbidden_field'],
  ['bad reaction kind', 'reaction.offered', e => { e.payload.kind = 'opportunity'; }, 'payload.kind', 'enum'],
  ['bad reaction source', 'reaction.resolved', e => { e.payload.by = 'robot'; }, 'payload.by', 'enum'],
  ['bad plan source', 'plan.chosen', e => { e.payload.source = 'cheat'; }, 'payload.source', 'enum'],
  ['d20 out of range', 'attack.rolled', e => { e.payload.d20 = [21]; }, 'payload.d20[0]', 'range'],
  ['three d20s', 'attack.rolled', e => { e.payload.d20 = [1, 2, 3]; }, 'payload.d20', 'range'],
  ['bad advantage mode', 'attack.rolled', e => { e.payload.advantage = 'elven-accuracy'; }, 'payload.advantage', 'enum'],
  ['bad save stat', 'save.rolled', e => { e.payload.stat = 'LUCK'; }, 'payload.stat', 'enum'],
  ['cast above level 9', 'spell.cast', e => { e.payload.castAtLevel = 10; }, 'payload.castAtLevel', 'range'],
  ['bad fizzle reason', 'spell.fizzled', e => { e.payload.reason = 'nope'; }, 'payload.reason', 'enum'],
  ['move outside grid (negative)', 'move', e => { e.payload.to = { col: -1, row: 0 }; }, 'payload.to.col', 'range'],
  ['exchange missing fxSeed', 'exchange', e => { delete e.payload.cinema.fxSeed; }, 'payload.cinema.fxSeed', 'required'],
  ['exchange missing durationMs (v1.1)', 'exchange', e => { delete e.payload.cinema.durationMs; }, 'payload.cinema.durationMs', 'required'],
  ['exchange missing cinema.spell (v1.1)', 'exchange', e => { delete e.payload.cinema.spell; }, 'payload.cinema.spell', 'required'],
  ['exchange modifiers not an array (v1.1)', 'exchange', e => { e.payload.cinema.modifiers = 'sneak'; }, 'payload.cinema.modifiers', 'type'],
  ['exchange effect hp missing', 'exchange', e => { delete e.payload.effects[0].hp; }, 'payload.effects[0].hp', 'required'],
  ['bad encounter outcome', 'encounter.ended', e => { e.payload.outcome = 'won'; }, 'payload.outcome', 'enum'],
  ['function in payload', 'dm.override', e => { e.payload.after = () => 12; }, 'payload.after', 'not_json_safe'],
  ['undefined in payload', 'heal', e => { e.payload.note = undefined; }, 'payload.note', 'not_json_safe']
];

for (const [name, type, mutate, path, code] of VIOLATIONS) {
  test(`events: planted violation fails — ${name}`, () => {
    const ev = byType(type);
    mutate(ev);
    assertNamedError(validateEvent(ev), path, code);
  });
}

test('events: log rejects non-increasing seq and non-arrays', () => {
  const log = clone(FIXTURES.slice(0, 3));
  log[2].seq = 2;
  assertNamedError(validateEventLog(log), '[2].seq', 'order');
  assertNamedError(validateEventLog({}), '', 'type');
  const bad = clone(FIXTURES.slice(0, 2));
  delete bad[1].payload.actorId;
  assertNamedError(validateEventLog(bad), '[1].payload.actorId', 'required');
});

test('events: validateEvent never throws on garbage', () => {
  for (const bad of [null, undefined, 1, 'x', [], { type: 'damage' }]) {
    assert.equal(validateEvent(bad).ok, false);
  }
});
