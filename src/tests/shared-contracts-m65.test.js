/**
 * M65 H23 — protocol v1.6 / events v1.4 / EncounterState v1 additions
 * for the campaign loop. The per-type "one valid fixture" checks live in
 * shared-protocol.test.js and shared-events.test.js; these pin the new
 * rules and planted violations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROTOCOL_MINOR, ROOM_STATUSES, DIAGONAL_RULES, INTENT_ROLES, INTENT_PAYLOAD_SPECS, SERVER_MESSAGE_SCOPE, INTENT_PLAN_KINDS,
  validateClientMessage, validateServerMessage
} from '../js/shared/protocol.js';
import { EVENT_CATALOGUE_MINOR, validateEvent } from '../js/shared/events.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';
import { ENCOUNTER_SETUP_SPEC } from '../js/shared/encounter-setup.js';
import { NODE_PAYLOAD_SPECS } from '../js/shared/campaign.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/contracts/${f}`, import.meta.url), 'utf8'));
const CLIENT = load('client-messages.valid.json');
const SERVER = load('server-messages.valid.json');
const EVENTS = load('events.valid.json');
const STATE = load('encounter-state.valid.json');
const clone = (v) => JSON.parse(JSON.stringify(v));
const client = (t) => clone(CLIENT.find(m => m.t === t));
const server = (t) => clone(SERVER.find(m => m.t === t));

function assertNamedError(result, path, code) {
  assert.equal(result.ok, false, `expected failure for ${path} (${code})`);
  const hit = result.errors.find(e => e.path === path && e.code === code);
  assert.ok(hit, `expected {path:"${path}", code:"${code}"}, got ${JSON.stringify(result.errors)}`);
}

const PLAYER_INTENTS = ['rest.spend', 'loot.claim', 'item.equip', 'item.give', 'item.use', 'shop.buy', 'shop.sell',
  'story.choose', 'levelup.choose', 'levelup.reconcile', 'seat.reclaim'];
const DM_INTENTS = ['dm.run.advance', 'dm.run.end', 'dm.node.begin', 'dm.rest.grant', 'dm.loot.assign', 'dm.story.resolve',
  'dm.xp.adjust', 'dm.levelup.confirm', 'dm.levelup.revert', 'dm.character.revive', 'dm.character.retire',
  'dm.seat.fill', 'dm.snapshot.save', 'dm.snapshot.load', 'dm.seat.reclaim.approve'];

test('m65 contracts: protocol v1.6 / events v1.4 are additive minors', () => {
  assert.equal(PROTOCOL_MINOR, 6);
  assert.equal(EVENT_CATALOGUE_MINOR, 4);
  assert.deepEqual([...ROOM_STATUSES], ['lobby', 'setup', 'in-encounter', 'paused', 'encounter-over', 'closed', 'error', 'between'],
    'between is appended; existing statuses keep their order');
  assert.ok(INTENT_PLAN_KINDS.includes('item'));
  assert.deepEqual([...DIAGONAL_RULES], ['5ft', '5-10'], "v1.6: DMG alternating diagonals ('5-10')");
  const settings = client('dm.room.settings');
  assert.equal(settings.p.diagonalRule, '5-10');
  assert.deepEqual(validateClientMessage(settings).errors, []);
  settings.p.diagonalRule = '5-10-5';
  assertNamedError(validateClientMessage(settings), 'p.diagonalRule', 'enum');
  assert.ok(Object.isFrozen(INTENT_PAYLOAD_SPECS));
});

test('m65 contracts: every plan intent exists with the right role', () => {
  for (const t of PLAYER_INTENTS) {
    assert.ok(t in INTENT_ROLES, t);
    assert.equal(INTENT_ROLES[t], ['story.choose', 'seat.reclaim'].includes(t) ? 'player' : 'seat', t);
  }
  for (const t of DM_INTENTS) assert.equal(INTENT_ROLES[t], 'dm', t);
});

test('m65 contracts: seat-scoped intents name their slot', () => {
  for (const t of PLAYER_INTENTS.filter(x => INTENT_ROLES[x] === 'seat')) {
    const m = client(t);
    delete m.p.slotId;
    assertNamedError(validateClientMessage(m), 'p.slotId', 'required');
  }
});

test('m65 contracts: run messages have the plan scopes', () => {
  assert.equal(SERVER_MESSAGE_SCOPE['run.snapshot'], 'private');
  assert.equal(SERVER_MESSAGE_SCOPE['levelup.offer'], 'private');
  assert.equal(SERVER_MESSAGE_SCOPE['run.updated'], 'broadcast');
  assert.equal(SERVER_MESSAGE_SCOPE['run.event'], 'broadcast');
  const priv = server('run.snapshot');
  priv.seq = 3;
  assertNamedError(validateServerMessage(priv), 'seq', 'forbidden_field');
});

test('m65 contracts: one encounter-setup spec for the intent, campaign nodes and templates', () => {
  assert.equal(INTENT_PAYLOAD_SPECS['dm.encounter.setup'], ENCOUNTER_SETUP_SPEC);
  assert.equal(NODE_PAYLOAD_SPECS.encounter.fields.setup.kind, ENCOUNTER_SETUP_SPEC.kind);
  assert.equal(NODE_PAYLOAD_SPECS.encounter.fields.setup.fields, ENCOUNTER_SETUP_SPEC.fields);
});

const CLIENT_VIOLATIONS = [
  ['rest.spend on a nonsense class key', 'rest.spend', m => { m.p.hitDice = { '1x': 1 }; }, 'p.hitDice.1x', 'range'],
  ['shop.buy of zero', 'shop.buy', m => { m.p.qty = 0; }, 'p.qty', 'range'],
  ['shop.buy with an Open5e `ref` instead of refKey', 'shop.buy', m => { m.p.ref = m.p.refKey; delete m.p.refKey; }, 'p.ref', 'unknown_field'],
  ['levelup.choose with an unknown ability', 'levelup.choose', m => { m.p.choices.asi = { LUCK: 2 }; }, 'p.choices.asi.LUCK', 'range'],
  ['levelup.choose with a +3 ASI', 'levelup.choose', m => { m.p.choices.asi = { WIS: 3 }; }, 'p.choices.asi.WIS', 'range'],
  ['dm.run.end with an encounter outcome', 'dm.run.end', m => { m.p.outcome = 'party-victory'; }, 'p.outcome', 'enum'],
  ['dm.rest.grant of a choice rest', 'dm.rest.grant', m => { m.p.type = 'choice'; }, 'p.type', 'enum'],
  ['dm.seat.fill on seat 7', 'dm.seat.fill', m => { m.p.seat = 7; }, 'p.seat', 'range'],
  ['dm.node.begin with a broken setup', 'dm.node.begin', m => { m.p.setup.grid.rows = 0; }, 'p.setup.grid.rows', 'range'],
  ['dm.character.revive by lenient (automatic only)', 'dm.character.revive', m => { m.p.method = 'lenient'; }, 'p.method', 'enum'],
  ['dm.xp.adjust by a fraction', 'dm.xp.adjust', m => { m.p.delta = 0.5; }, 'p.delta', 'type'],
  ['dm.seat.reclaim.approve without a verdict', 'dm.seat.reclaim.approve', m => { delete m.p.approve; }, 'p.approve', 'required']
];

for (const [name, t, mutate, path, code] of CLIENT_VIOLATIONS) {
  test(`m65 contracts: client violation fails — ${name}`, () => {
    const m = client(t);
    mutate(m);
    assertNamedError(validateClientMessage(m), path, code);
  });
}

test('m65 contracts: turn.act may use an item', () => {
  const m = client('turn.act');
  m.p.plan = { kind: 'item', itemId: 'item-1', targetId: 'pc-wizard', targetSide: 'ally' };
  assert.deepEqual(validateClientMessage(m).errors, []);
});

test('m65 contracts: run.event carries a valid run event', () => {
  const m = server('run.event');
  delete m.p.payload.before;
  assertNamedError(validateServerMessage(m), 'p.payload.before', 'required');
  const t = server('run.event');
  t.p.type = 'run.paused';
  assertNamedError(validateServerMessage(t), 'p.type', 'enum');
  const noSeq = server('run.event');
  delete noSeq.seq;
  assertNamedError(validateServerMessage(noSeq), 'seq', 'required');
});

test('m65 contracts: run.snapshot validates any character state it carries', () => {
  const m = server('run.snapshot');
  m.p.characters[0].state.hp.current = -1;
  assertNamedError(validateServerMessage(m), 'p.characters[0].state.hp.current', 'range');
  const s = server('run.snapshot');
  s.p.run.status = 'in-encounter';
  assertNamedError(validateServerMessage(s), 'p.run.status', 'enum');
  const l = server('run.snapshot');
  l.p.characters[1].lifeStatus = 'downed';
  assertNamedError(validateServerMessage(l), 'p.characters[1].lifeStatus', 'enum');
});

test('m65 contracts: run.updated and levelup.offer enforce their fields', () => {
  const u = server('run.updated');
  delete u.p.runSeq;
  assertNamedError(validateServerMessage(u), 'p.runSeq', 'required');
  const o = server('levelup.offer');
  o.p.mode = 'manual';
  assertNamedError(validateServerMessage(o), 'p.mode', 'enum');
});

test('m65 contracts: item.used event (events v1.4)', () => {
  const ev = clone(EVENTS.find(e => e.type === 'item.used'));
  assert.deepEqual(validateEvent(ev).errors, []);
  delete ev.payload.remaining;
  assertNamedError(validateEvent(ev), 'payload.remaining', 'required');
});

test('m65 contracts: EncounterState carries the run fields, all optional', () => {
  assert.deepEqual(validateEncounterState(clone(STATE)).errors, [], 'a phase-1 state is still valid');
  const s = clone(STATE);
  s.runId = 'run-fixture';
  s.nodeId = 'n-goblins';
  s.entities['pc-fighter'].exhaustion = 2;
  s.entities['pc-fighter'].resources.items = { 'item-1': { name: 'Potion of Healing', effect: 'potion-of-healing', max: 2, spent: 1 } };
  s.entities['m-goblin'].statBlock = { slug: 'goblin', xp: 50, cr: '1/4', tokenImageId: null };
  s.entities['m-fanatic'].statBlock.cr = 2;
  assert.deepEqual(validateEncounterState(s).errors, []);
  const nulls = clone(STATE);
  nulls.runId = null;
  nulls.nodeId = null;
  assert.deepEqual(validateEncounterState(nulls).errors, []);
});

const STATE_VIOLATIONS = [
  ['exhaustion 7', s => { s.entities['pc-fighter'].exhaustion = 7; }, 'entities.pc-fighter.exhaustion', 'range'],
  ['a potion overspent', s => { s.entities['pc-fighter'].resources.items = { i1: { name: 'Potion', effect: 'potion-of-healing', max: 1, spent: 2 } }; }, 'entities.pc-fighter.resources.items.i1', 'range'],
  ['an item ledger without its effect', s => { s.entities['pc-fighter'].resources.items = { i1: { name: 'Potion', max: 1, spent: 0 } }; }, 'entities.pc-fighter.resources.items.i1.effect', 'required'],
  ['CR 1/3', s => { s.entities['m-goblin'].statBlock.cr = '1/3'; }, 'entities.m-goblin.statBlock.cr', 'type'],
  ['negative XP', s => { s.entities['m-goblin'].statBlock.xp = -1; }, 'entities.m-goblin.statBlock.xp', 'range'],
  ['a numeric runId', s => { s.runId = 7; }, 'runId', 'type']
];

for (const [name, mutate, path, code] of STATE_VIOLATIONS) {
  test(`m65 contracts: EncounterState violation fails — ${name}`, () => {
    const s = clone(STATE);
    mutate(s);
    assertNamedError(validateEncounterState(s), path, code);
  });
}
