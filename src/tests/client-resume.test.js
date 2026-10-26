/**
 * M65 (E6's restart finding) — a restarted server brings a room back
 * `paused` and resumes its waiting turn under the same turnId without a new
 * `turn.started`. The client re-requests a snapshot when `room.status`
 * flips paused → in-encounter and no `turn.started` follows within the
 * session's grace period (store.js resume watch + session.js timer).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/client/store.js';
import { createSession } from '../js/client/session.js';
import { snapshotMsg, eventMsg, roomMsg, manualTimers } from './helpers/client-fixtures.js';

function pausedStore() {
  const store = createStore({ hashState: null });
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: 'mem_p', role: 'player', seats: [], serverNow: 1, cfg: {} } });
  assert.equal(store.apply(snapshotMsg(10, undefined, { code: 'ABC123', status: 'paused', turn: null })), 'applied');
  return store;
}

test('store: paused → in-encounter opens a resume watch; turn.started closes it', () => {
  const store = pausedStore();
  const seen = [];
  store.onResumeWatch((info) => seen.push(info));
  assert.equal(store.apply(roomMsg(11, 'room.status', { status: 'in-encounter' })), 'applied');
  assert.deepEqual(seen, [{ seq: 11 }]);
  assert.equal(store.resumePending(), true);
  assert.equal(store.apply(eventMsg(12, 'turn.started', { actorId: 'pc-fighter' })), 'applied');
  assert.equal(store.resumePending(), false);
  const resyncs = [];
  store.onResyncNeeded((i) => resyncs.push(i));
  assert.equal(store.checkResume(11), false, 'the turn was announced: no resync');
  assert.deepEqual(resyncs, []);
});

test('store: no turn.started after the flip → checkResume asks for a snapshot; a stale check does nothing', () => {
  const store = pausedStore();
  const resyncs = [];
  store.onResyncNeeded((i) => resyncs.push(i));
  store.apply(roomMsg(11, 'room.status', { status: 'in-encounter' }));
  assert.equal(store.checkResume(99), false, 'only the flip that opened the watch');
  assert.equal(store.checkResume(11), true);
  assert.deepEqual(resyncs.map(r => r.reason), ['resume-without-turn']);
  // A fresh snapshot (the resync answer) clears everything.
  store.apply(snapshotMsg(13, undefined, { code: 'ABC123', status: 'in-encounter', turn: { turnId: 't9', actorId: 'pc-fighter', awaitingIntent: true } }));
  assert.equal(store.resumePending(), false);
  // in-encounter → paused (a plain DM pause) opens nothing.
  store.apply(roomMsg(14, 'room.status', { status: 'paused' }));
  assert.equal(store.resumePending(), false);
});

test('session: a resumed room with no turn.started within the grace period re-requests a snapshot', () => {
  const timers = manualTimers();
  const store = pausedStore();
  const s = createSession({ url: 'ws://x/ws', token: 't', WebSocketCtor: function Never() { throw new Error('not connected in this test'); }, store, wsOptions: { timers }, resumeGraceMs: 1500 });
  const asked = [];
  s.ws.resync = (seq) => asked.push(seq);
  store.apply(roomMsg(11, 'room.status', { status: 'in-encounter' }));
  timers.advance(1499);
  assert.deepEqual(asked, []);
  timers.advance(1);
  assert.deepEqual(asked, [11], 'one resync from the last applied seq');

  // With the turn announced in time, nothing is asked.
  const store2 = pausedStore();
  const s2 = createSession({ url: 'ws://x/ws', token: 't', WebSocketCtor: function Never() {}, store: store2, wsOptions: { timers }, resumeGraceMs: 1500 });
  const asked2 = [];
  s2.ws.resync = (seq) => asked2.push(seq);
  store2.apply(roomMsg(11, 'room.status', { status: 'in-encounter' }));
  store2.apply(eventMsg(12, 'turn.started', { actorId: 'pc-fighter' }));
  timers.advance(5000);
  assert.deepEqual(asked2, []);
  // close() drops a pending check.
  store2.apply(roomMsg(13, 'room.status', { status: 'paused' }));
  store2.apply(roomMsg(14, 'room.status', { status: 'in-encounter' }));
  s2.close();
  timers.advance(5000);
  assert.deepEqual(asked2, []);
});
