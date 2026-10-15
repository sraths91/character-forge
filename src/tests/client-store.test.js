/**
 * M64 C6 — client store: authoritative vs presented, ordered seq,
 * gap / state-hash → resync, validation of every inbound message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore, viewStateHash, applyEventToEncounter, initialClientState } from '../js/client/store.js';
import { validateServerMessage } from '../js/shared/protocol.js';

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/contracts/${f}`, import.meta.url), 'utf8'));
const STATE = read('encounter-state.valid.json');
const EVENTS = read('events.valid.json');
const clone = (v) => JSON.parse(JSON.stringify(v));

function projected() {
  const s = clone(STATE);
  delete s.rng;
  return s;
}

function snapshot(seq = 10, encounter = projected()) {
  return { v: 1, t: 'room.snapshot', ts: 1, p: { seq, room: { code: 'ABC123', status: 'in-encounter' }, encounter, openPrompt: null, history: [] } };
}

/** Wrap an engine event as a sequenced broadcast. */
function ev(seq, type, payload, round = 2) {
  return { v: 1, t: type, seq, ts: 1, p: { seq, type, round, turnId: 't1', cinemaGroup: null, payload } };
}
const damage = (seq, targetId, before, after) =>
  ev(seq, 'damage', { sourceId: 'm-goblin', targetId, amount: before - after, type: 'slashing', hpBefore: before, hpAfter: after });
const room = (seq, t, p) => ({ v: 1, t, seq, ts: 1, p });

test('C6: helper messages are contract-valid', () => {
  assert.equal(validateServerMessage(snapshot()).ok, true);
  assert.equal(validateServerMessage(damage(11, 'pc-fighter', 30, 25)).ok, true);
});

test('C6: initial state is unsynced and broadcasts before the snapshot are dropped', () => {
  const store = createStore();
  assert.deepEqual(store.getState(), initialClientState());
  assert.equal(store.apply(damage(1, 'pc-fighter', 30, 25)), 'dropped');
  assert.equal(store.apply(snapshot()), 'applied');
  assert.equal(store.getState().synced, true);
  assert.equal(store.getState().seq, 10);
  assert.equal(store.getPresented().encounter.entities['pc-fighter'].hp, 30);
});

test('C6: sequenced events update authoritative; presented trails until presentUpTo', () => {
  const store = createStore();
  store.apply(snapshot());
  assert.equal(store.apply(damage(11, 'pc-fighter', 30, 25)), 'applied');
  assert.equal(store.apply(ev(12, 'move', { actorId: 'pc-fighter', from: { col: 2, row: 3 }, to: { col: 3, row: 3 } })), 'applied');
  assert.equal(store.getState().encounter.entities['pc-fighter'].hp, 25);
  assert.deepEqual(store.getState().encounter.entities['pc-fighter'].pos, { col: 3, row: 3 });
  assert.equal(store.getPresented().encounter.entities['pc-fighter'].hp, 30);
  assert.deepEqual(store.getPending().map(m => m.seq), [11, 12]);
  assert.equal(store.presentUpTo(11), 1);
  assert.equal(store.getPresented().encounter.entities['pc-fighter'].hp, 25);
  assert.deepEqual(store.getPresented().encounter.entities['pc-fighter'].pos, { col: 2, row: 3 });
  store.presentUpTo(Infinity);
  assert.deepEqual(store.getPresented().encounter, store.getState().encounter);
  assert.equal(store.getPending().length, 0);
});

test('C6: duplicate and out-of-order seq are ignored', () => {
  const store = createStore();
  store.apply(snapshot());
  store.apply(damage(11, 'pc-fighter', 30, 25));
  const before = store.getState();
  assert.equal(store.apply(damage(11, 'pc-fighter', 25, 20)), 'duplicate');
  assert.equal(store.apply(damage(9, 'pc-fighter', 25, 1)), 'duplicate');
  assert.equal(store.getState(), before);
  assert.equal(store.getStats().duplicate, 2);
});

test('C6: a seq gap triggers onResyncNeeded once and drops until the next snapshot', () => {
  const store = createStore();
  const calls = [];
  store.onResyncNeeded(info => calls.push(info));
  store.apply(snapshot());
  assert.equal(store.apply(damage(13, 'pc-fighter', 30, 25)), 'gap');
  assert.deepEqual(calls, [{ reason: 'gap', expected: 11, got: 13, lastSeq: 10 }]);
  assert.equal(store.apply(damage(11, 'pc-fighter', 30, 25)), 'dropped');
  assert.equal(store.apply(damage(14, 'pc-fighter', 30, 25)), 'dropped');
  assert.equal(calls.length, 1);
  assert.equal(store.getState().encounter.entities['pc-fighter'].hp, 30);
  // the resync snapshot replaces both copies and clears the queue
  const enc = projected();
  enc.entities['pc-fighter'].hp = 20;
  store.apply(snapshot(14, enc));
  assert.equal(store.getState().seq, 14);
  assert.equal(store.getPresented().encounter.entities['pc-fighter'].hp, 20);
  assert.equal(store.apply(damage(15, 'pc-fighter', 20, 18)), 'applied');
});

test('C6: turn.ended stateHash mismatch triggers resync; a match does not', () => {
  const store = createStore();
  const calls = [];
  store.onResyncNeeded(info => calls.push(info.reason));
  store.apply(snapshot());
  store.apply(damage(11, 'pc-fighter', 30, 25));
  const good = viewStateHash(store.getState().encounter);
  store.apply(ev(12, 'turn.ended', { actorId: 'pc-fighter', stateHash: good }));
  assert.deepEqual(calls, []);
  store.apply(ev(13, 'turn.ended', { actorId: 'pc-fighter', stateHash: 'deadbeef' }));
  assert.deepEqual(calls, ['state-hash']);
  assert.equal(store.getStats().hashMismatch, 1);
  // hashState: null disables the check
  const off = createStore({ hashState: null });
  const offCalls = [];
  off.onResyncNeeded(i => offCalls.push(i));
  off.apply(snapshot());
  off.apply(ev(11, 'turn.ended', { actorId: 'pc-fighter', stateHash: 'deadbeef' }));
  assert.equal(offCalls.length, 0);
});

test('C6: invalid inbound messages are ignored and counted', () => {
  const store = createStore();
  store.apply(snapshot());
  const before = store.getState();
  assert.equal(store.apply({ v: 2, t: 'room.status', seq: 11, ts: 1, p: { status: 'paused' } }), 'invalid');
  assert.equal(store.apply({ v: 1, t: 'nope', seq: 11, ts: 1, p: {} }), 'invalid');
  assert.equal(store.apply('{not json'), 'invalid');
  const leaked = damage(11, 'pc-fighter', 30, 25);
  leaked.p.payload._ref = 1;
  assert.equal(store.apply(leaked), 'invalid');
  assert.equal(store.getState(), before);
  assert.equal(store.getStats().invalid, 4);
  // a valid JSON string is accepted
  assert.equal(store.apply(JSON.stringify(damage(11, 'pc-fighter', 30, 25))), 'applied');
});

test('C6: subscribers fire once per change, selector-equality gated, and can unsubscribe', () => {
  const store = createStore();
  store.apply(snapshot());
  const hp = [];
  const unsub = store.subscribe(s => s.encounter?.entities['pc-fighter'].hp, (v, prev) => hp.push([v, prev]));
  const presentedHp = [];
  store.subscribe((_a, p) => p.encounter?.entities['pc-fighter'].hp, v => presentedHp.push(v));
  store.apply(damage(11, 'pc-fighter', 30, 25));
  store.apply(damage(12, 'm-goblin', 7, 2));                   // other entity → no fire
  store.apply(room(13, 'room.status', { status: 'paused' }));   // unrelated → no fire
  assert.deepEqual(hp, [[25, 30]]);
  assert.deepEqual(presentedHp, []);
  store.presentUpTo(13);
  assert.deepEqual(presentedHp, [25]);
  unsub();
  store.apply(damage(14, 'pc-fighter', 25, 10));
  assert.equal(hp.length, 1);
});

test('C6: room broadcasts and private messages update the mirror', () => {
  const store = createStore();
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: 'mem_1', role: 'player', seats: [], serverNow: 5, cfg: {} } });
  store.apply(snapshot());
  store.apply(room(11, 'member.joined', { memberId: 'mem_2', displayName: 'Robin' }));
  store.apply(room(12, 'member.presence', { memberId: 'mem_2', online: false }));
  store.apply(room(13, 'seat.updated', { characterId: 'fighter-l5', memberId: 'mem_1', controller: 'player' }));
  store.apply(room(14, 'entity.updated', { entityId: 'pc-fighter', patch: { hp: 12, position: { col: 0, row: 0 }, _secret: 1 }, cause: 'dm.entity.patch' }));
  store.apply(room(15, 'redacted', { type: 'dm.override' }));
  store.apply(room(16, 'room.status', { status: 'paused' }));
  store.apply({ v: 1, t: 'prompt.open', ts: 1, p: { promptId: 'pr_1', kind: 'shield', payload: {}, autoAnswer: true, deadlineAt: 9, serverNow: 1 } });
  const s = store.getState();
  assert.equal(s.me.memberId, 'mem_1');
  assert.deepEqual(s.members.mem_2, { memberId: 'mem_2', displayName: 'Robin', online: false });
  assert.deepEqual(s.seats['fighter-l5'], { memberId: 'mem_1', controller: 'player' });
  assert.equal(s.encounter.entities['pc-fighter'].hp, 12);
  assert.deepEqual(s.encounter.entities['pc-fighter'].pos, { col: 0, row: 0 });
  assert.equal('_secret' in s.encounter.entities['pc-fighter'], false);
  assert.equal(s.room.status, 'paused');
  assert.equal(s.seq, 16);
  assert.equal(s.openPrompt.promptId, 'pr_1');
  assert.equal(store.getPresented().openPrompt.promptId, 'pr_1');
  assert.equal(store.apply({ v: 1, t: 'prompt.closed', ts: 1, p: { promptId: 'pr_1', reason: 'answered' } }), 'applied');
  assert.equal(store.getState().openPrompt, null);
  assert.equal(store.apply({ v: 1, t: 'ack', ts: 1, p: { cid: 'c1', ok: true } }), 'ignored');
});

test('C6: the store does not alias or mutate inbound messages', () => {
  const store = createStore();
  const snap = snapshot();
  const copy = clone(snap);
  store.apply(snap);
  store.apply(damage(11, 'pc-fighter', 30, 25));
  assert.deepEqual(snap, copy);
  snap.p.encounter.entities['pc-fighter'].hp = 1;
  assert.equal(store.getPresented().encounter.entities['pc-fighter'].hp, 30);
});

test('C6: encounter.created without a state asks for a resync', () => {
  const store = createStore();
  const calls = [];
  store.onResyncNeeded(i => calls.push(i.reason));
  store.apply(snapshot(10, null));
  store.apply(room(11, 'encounter.created', { encounterId: 'enc_2' }));
  assert.deepEqual(calls, ['encounter-created']);
  assert.equal(store.getState().room.encounterId, 'enc_2');
});

test('C6: applyEventToEncounter covers exchange effects, conditions, concentration, turns', () => {
  const fixtureExchange = clone(EVENTS.find(e => e.type === 'exchange'));
  let enc = projected();
  enc = applyEventToEncounter(enc, fixtureExchange);
  assert.equal(enc.entities['m-goblin'].hp, 0);
  assert.equal(enc.lastEventSeq, fixtureExchange.seq);
  const base = { round: 3, turnId: 't2', cinemaGroup: null };
  enc = applyEventToEncounter(enc, { ...base, seq: 30, type: 'condition.applied', payload: { entityId: 'pc-wizard', condition: 'prone', sourceId: null } });
  enc = applyEventToEncounter(enc, { ...base, seq: 31, type: 'condition.applied', payload: { entityId: 'pc-wizard', condition: 'prone', sourceId: null } });
  assert.deepEqual(enc.entities['pc-wizard'].conditions, ['prone']);
  enc = applyEventToEncounter(enc, { ...base, seq: 32, type: 'condition.removed', payload: { entityId: 'pc-fighter', condition: 'paralyzed', sourceId: null } });
  assert.deepEqual(enc.entities['pc-fighter'].conditions, []);
  enc = applyEventToEncounter(enc, { ...base, seq: 33, type: 'concentration.started', payload: { casterId: 'pc-wizard', spellId: 'hold-person', targetIds: ['m-goblin'] } });
  assert.deepEqual(enc.entities['pc-wizard'].concentration, { spellId: 'hold-person', targetIds: ['m-goblin'] });
  enc = applyEventToEncounter(enc, { ...base, seq: 34, type: 'concentration.broken', payload: { casterId: 'pc-wizard', spellId: 'hold-person' } });
  assert.equal(enc.entities['pc-wizard'].concentration, null);
  enc = applyEventToEncounter(enc, { ...base, seq: 35, type: 'turn.started', payload: { actorId: 'm-fanatic' } });
  assert.equal(enc.turnIndex, 2);
  assert.equal(enc.round, 3);
  enc = applyEventToEncounter(enc, { ...base, seq: 36, type: 'encounter.ended', payload: { outcome: 'party-victory' } });
  assert.equal(enc.phase, 'ended');
  // pure: the fixture is untouched
  assert.equal(STATE.entities['m-goblin'].hp, projected().entities['m-goblin'].hp);
});

test('C6: viewStateHash is order-independent and sensitive to hp/pos/conditions', () => {
  const a = projected();
  const b = projected();
  b.entities = Object.fromEntries(Object.entries(b.entities).reverse());
  assert.equal(viewStateHash(a), viewStateHash(b));
  assert.match(viewStateHash(a), /^[0-9a-f]{8}$/);
  b.entities['pc-fighter'].hp -= 1;
  assert.notEqual(viewStateHash(a), viewStateHash(b));
  const c = projected();
  c.entities['pc-fighter'].pos = { col: 9, row: 0 };
  assert.notEqual(viewStateHash(a), viewStateHash(c));
  // resources and turn flags are not part of the view hash
  const d = projected();
  d.entities['pc-fighter'].resources.reactionUsed = true;
  assert.equal(viewStateHash(a), viewStateHash(d));
});
