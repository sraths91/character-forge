/**
 * M65 (E6's restart finding) — a restarted server brings a room back
 * `paused` and resumes its waiting turn under the same turnId without a new
 * `turn.started`. The client re-requests a snapshot when `room.status`
 * flips paused → in-encounter and no `turn.started` follows within the
 * session's grace period (store.js resume watch + session.js timer).
 *
 * v1.7 (E3 W4): the server now re-announces the recovered turn after
 * `dm.resume` — `turn.started {actorId, resumed: true}` under the same
 * turnId — so on a REAL restart (same DB, same port, the clients'
 * sockets reconnecting by themselves) the fallback resync must not fire:
 * the re-announcement closes the watch, the mirror (the paused snapshot's
 * turn-end state + the re-announced turn's resets) agrees with the server,
 * and the resumed turn ends on the server's state hash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/client/store.js';
import { createSession } from '../js/client/session.js';
import { snapshotMsg, eventMsg, roomMsg, manualTimers } from './helpers/client-fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { openDb } from '../../api/db/database.js';
import { startMultiplayerServer } from '../../api/multiplayer.js';
import { quiet } from '../../api/tests/helpers/server.js';
import { createApi } from '../js/client/api.js';
import { currentTurn } from '../js/client/intents.js';
import { turnInfo } from '../js/client/selectors.js';
import { formatEvent } from '../js/client/log-format.js';
import { applyEventToEncounter } from '../js/client/mirror.js';
import { loadDdbFixture } from './helpers/entities.js';
import { until } from './helpers/run-table.js';

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

test('mirror + log: a resumed turn.started brings the start-of-turn resets (idempotently) and reads as a resumption', () => {
  const enc = {
    round: 2, turnIndex: 1, phase: 'running', initiative: [{ entityId: 'gob', score: 12 }, { entityId: 'pc', score: 10 }],
    entities: { pc: { id: 'pc', name: 'Fighter', hp: 9, turnFlags: { dodging: true }, reactionUsed: true }, gob: { id: 'gob', name: 'Goblin', hp: 7, turnFlags: {} } }
  };
  // The reconnect snapshot is the turn-end state: the original turn.started is only in the history.
  const fresh = applyEventToEncounter(enc, { type: 'turn.started', round: 2, payload: { actorId: 'pc' } });
  const resumed = applyEventToEncounter(enc, { type: 'turn.started', round: 2, payload: { actorId: 'pc', resumed: true } });
  assert.deepEqual(resumed, fresh, 'the re-announcement brings the same resets');
  assert.deepEqual(applyEventToEncounter(fresh, { type: 'turn.started', round: 2, payload: { actorId: 'pc', resumed: true } }), fresh, 'and changes nothing on a state that had them');
  assert.equal(formatEvent({ type: 'turn.started', round: 2, payload: { actorId: 'pc', resumed: true } }, () => 'Fighter').text, '— Fighter\'s turn resumes (round 2) —');
  const s = { history: [{ type: 'turn.started', turnId: 't1', payload: { actorId: 'pc' } }, { type: 'turn.started', turnId: 't1', payload: { actorId: 'pc', resumed: true } }] };
  assert.deepEqual(currentTurn(s), { turnId: 't1', actorId: 'pc', resumed: true });
  assert.equal(turnInfo(s).resumed, true);
});

test('REAL restart: the server re-announces the turn (resumed, same turnId); the fallback resync never fires and the turn ends on the server\'s hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-resume-'));
  const path = join(root, 'r.db');
  const env = { NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_ENGINE: 'real' };
  const boot = async (port = 0) => {
    const db = await openDb(path, { log: quiet });
    const srv = await startMultiplayerServer({ db, env, port, host: '127.0.0.1', log: quiet, gatewayOpts: { heartbeatMs: 60_000 }, janitorOpts: false });
    return { srv, close: async () => { await srv.close(); srv.httpServer.closeAllConnections(); } };
  };
  const sockets = new Set();
  const WS = class extends WebSocket { constructor(url) { super(url); sockets.add(this); } };
  let a = await boot();
  let b = null;
  const sessions = [];
  try {
    const port = new URL(a.srv.url).port;
    const anon = createApi({ fetch: globalThis.fetch, base: a.srv.url });
    const room = await anon.createRoom('Restart');
    const join_ = await anon.joinRoom(room.code, 'Pat');
    const papi = createApi({ fetch: globalThis.fetch, base: a.srv.url, token: () => join_.token });
    const wsUrl = `${a.srv.url.replace(/^http/, 'ws')}/ws`;
    const mk = (token) => {
      // A fast reconnect (the restarted server comes back on the same port) and a short grace period.
      const s = createSession({ url: wsUrl, token, WebSocketCtor: WS, resumeGraceMs: 150, wsOptions: { logger: { warn: () => {} }, random: () => 0, backoff: { baseMs: 50, maxMs: 200, jitter: 0 } } });
      sessions.push(s);
      return s;
    };
    const dm = mk(room.dmToken);
    const pl = mk(join_.token);
    await dm.connect();
    await pl.connect();
    const fighter = await papi.importCharacter(room.roomId, { json: loadDdbFixture('fighter-l5') });
    await pl.send({ t: 'seat.claim', p: { characterId: fighter.character.id } });
    await dm.send({ t: 'dm.encounter.setup', p: { map: null, grid: { cols: 6, rows: 4 }, monsters: [{ id: 'gob', name: 'Goblin', hp: 60, ac: 11 }], placements: {} } });
    await until(() => dm.store.getState().encounter, 'the encounter set up');
    const pcId = Object.values(dm.store.getState().encounter.entities).find(e => e.kind === 'pc').id;
    await dm.send({ t: 'dm.initiative.set', p: { order: [pcId, 'gob'] } });
    for (const s of sessions) {
      s.ws.on('message', (m) => { if (m.t === 'exchange') s.send({ t: 'cinema.done', p: { exchangeId: m.p.payload.exchangeId } }).catch(() => {}); });
    }
    await dm.send({ t: 'dm.encounter.start', p: { seed: 4242 } });
    // Round 1: Pat attacks; the goblin acts; then her round-2 turn (its start-of-turn resets
    // clear round 1's flags) waits for her intent when the server goes down.
    await until(() => currentTurn(pl.store.getState()).actorId === pcId, 'the fighter\'s first turn');
    await pl.send({ t: 'turn.act', p: { turnId: currentTurn(pl.store.getState()).turnId, plan: { kind: 'melee', targetId: 'gob' } } });
    const round2 = () => pl.store.getState().history.some(e => e.type === 'turn.started' && e.payload?.actorId === pcId && e.round === 2);
    await until(() => round2() && currentTurn(pl.store.getState()).actorId === pcId, 'the fighter\'s round-2 turn waits for Pat');
    const { turnId } = currentTurn(pl.store.getState());

    // The server restarts (graceful shutdown mid-turn); the same DB comes back on the same port.
    await a.close();
    a = null;
    b = await boot(Number(port));
    const reasons = [];
    for (const s of sessions) s.store.onResyncNeeded((i) => reasons.push(i.reason));
    const resumeLog = [];
    const info = globalThis.console.info;
    globalThis.console.info = (line) => { if (/session\.resume_resync/.test(String(line))) resumeLog.push(line); else info(line); };
    try {
      await until(() => sessions.every(s => s.ws.status() === 'open' && s.store.getState().room?.status === 'paused'), 'both clients reconnected to the paused room', 15000);
      await dm.send({ t: 'dm.resume', p: {} });
      const resumed = (s) => s.store.getState().history.find(e => e.type === 'turn.started' && e.payload?.resumed === true);
      await until(() => sessions.every(resumed), 'the re-announced turn on both clients');
      for (const s of sessions) {
        assert.equal(resumed(s).turnId, turnId, 'the same turn');
        assert.equal(resumed(s).payload.actorId, pcId);
        assert.equal(s.store.resumePending(), false, 'the re-announcement closed the resume watch');
      }
      assert.deepEqual(currentTurn(pl.store.getState()), { turnId, actorId: pcId, resumed: true });
      assert.equal(turnInfo(pl.store.getState()).mine, true, 'Pat\'s turn again, with no resync');
      // Past the grace period: the 1.5 s fallback (150 ms here) never fired.
      await new Promise(r => setTimeout(r, 400));
      assert.deepEqual(reasons.filter(r => r === 'resume-without-turn'), [], 'no resume-without-turn resync');
      assert.deepEqual(resumeLog, [], 'session.resume_resync never logged');

      // Pat acts on the re-announced turn; it ends on the server's hash (no mismatch resync).
      const ack = await pl.send({ t: 'turn.act', p: { turnId, plan: { kind: 'melee', targetId: 'gob' } } });
      assert.ok(ack, 'the intent was accepted');
      await until(() => pl.store.getState().history.some(e => e.type === 'turn.ended' && e.turnId === turnId), 'the resumed turn ended');
      for (const s of sessions) assert.equal(s.store.getStats().hashMismatch, 0, 'the mirror agrees with turn.ended.stateHash');
      assert.deepEqual(reasons, [], 'no resync of any kind after the restart');
    } finally {
      globalThis.console.info = info;
    }
  } finally {
    for (const s of sessions) s.close();
    for (const ws of sockets) ws.terminate();
    if (a) await a.close();
    if (b) await b.close();
    rmSync(root, { recursive: true, force: true });
  }
});
