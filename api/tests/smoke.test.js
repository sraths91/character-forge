// M64 S1 — end-to-end smoke test of the phase 1 table.
//
// The real server (rooms + ws gateway + SQLite journal + the REAL engine)
// boots in-process on port 0. The browser client modules (E2's
// createApi / createSession → createWsClient → store) drive it over a
// real `ws` socket: a DM creates a room, a player joins, imports the
// synthetic fighter by JSON paste, claims seat 1; the DM sets up a preset
// goblin and starts with seed 42; on the player's turn the player sends a
// melee `turn.act`, both tables answer `cinema.done`. Asserted: identical
// seq streams on both clients, the event-type golden, the `turn.ended`
// stateHash against a resync snapshot, the goblin's HP story, and the
// health endpoint's connection count. Teardown leaves no handles.
//
// Restart variant: the same table against `node api/server.js` as a child
// process; SIGTERM mid-encounter (1012 to every client, exit 0 < 5 s),
// then a restart on the same DB brings the DM back to a paused table
// whose stateHash is the last `turn.ended` the clients saw.
//
// Re-bless the golden:  UPDATE_GOLDEN=1 node --test api/tests/smoke.test.js
// (only in a commit that says why).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { startMultiplayerServer } from '../multiplayer.js';
import { createApi } from '../../src/js/client/api.js';
import { createSession } from '../../src/js/client/session.js';
import { stateHash } from '../../src/js/shared/state-hash.js';
import { tempRoot, tempDb, quiet, ddbFixture } from './helpers/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'smoke.events.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const SEED = 42;
const SMOKE_BUDGET_MS = 5000;

const { root, cleanup } = tempRoot('cf-smoke-');
after(cleanup);

/** A `ws` WebSocket the browser client can construct, remembered for teardown. */
function trackedWebSocket(sockets) {
  return class TrackedWebSocket extends WebSocket {
    constructor(url) {
      super(url);
      sockets.add(this);
    }
  };
}

/**
 * One table seat: an E2 session plus a frame recorder and auto-responders
 * (cinema.done for every exchange; reaction prompts take their autoAnswer).
 */
function tableClient(name, wsUrl, token, WebSocketCtor) {
  const session = createSession({ url: wsUrl, token, WebSocketCtor, wsOptions: { logger: { warn: () => {} } } });
  const c = { name, session, frames: [], closes: [], waiters: [], failures: [] };
  const answer = (intent) => session.send(intent).catch((err) => c.failures.push(`${intent.t}: ${err.code} ${err.message}`));
  session.ws.on('message', (msg) => {
    c.frames.push(msg);
    if (msg.t === 'exchange') answer({ t: 'cinema.done', p: { exchangeId: msg.p.payload.exchangeId } });
    if (msg.t === 'prompt.open') answer({ t: 'prompt.answer', p: { promptId: msg.p.promptId, answer: msg.p.autoAnswer ?? false } });
    for (const w of [...c.waiters]) {
      if (!w.pred(msg)) continue;
      c.waiters.splice(c.waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  });
  session.ws.on('close', (e) => c.closes.push(e.code));
  return c;
}

/** The first frame (already received or future) matching `pred`. */
function until(c, pred, { timeoutMs = 10_000, since = 0 } = {}) {
  const hit = c.frames.slice(since).find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = {
      pred,
      resolve,
      timer: setTimeout(() => {
        c.waiters.splice(c.waiters.indexOf(w), 1);
        reject(new Error(`${c.name}: timed out; last frames: ${c.frames.slice(-6).map(f => f.t).join(', ')}`));
      }, timeoutMs)
    };
    c.waiters.push(w);
  });
}

const isEvent = (type, pred = () => true) => (m) => m.t === type && m.seq !== undefined && pred(m.p);
const lastSeq = (c) => c.frames.reduce((s, f) => (f.t === 'room.snapshot' ? f.p.seq : (f.seq ?? s)), 0);
const sequenced = (c, after) => c.frames.filter(f => f.seq !== undefined && f.seq > after);
const send = async (c, t, p = {}) => {
  const ack = await c.session.send({ t, p });
  assert.equal(ack.ok, true, `${c.name} ${t}`);
  return ack;
};

/**
 * Play the scripted table up to the end of the player's first turn:
 * room → join → import (JSON paste) → connect both → seat.claim → setup
 * (preset goblin) → start (seed 42) → on pc-1's turn the DM pauses (so
 * the table is quiescent after it) and the player sends a melee turn.act.
 * Ends with a DM resync once both clients hold every broadcast.
 * @param {string} base  http(s) origin of the server
 * @param {Set<WebSocket>} sockets  filled with every client socket
 */
async function playFirstPlayerTurn(base, sockets) {
  const WebSocketCtor = trackedWebSocket(sockets);
  const wsUrl = `${base.replace(/^http/, 'ws')}/ws`;
  const anon = createApi({ fetch: globalThis.fetch, base });
  const room = await anon.createRoom('Smoke table');
  const join = await anon.joinRoom(room.code, 'Robin');
  const playerApi = createApi({ fetch: globalThis.fetch, base, token: () => join.token });
  const imp = await playerApi.importCharacter(room.roomId, { json: ddbFixture('fighter-l5') });
  assert.match(imp.character.id, /^paste:/, 'a room paste never collides with a url import');

  const dm = tableClient('dm', wsUrl, room.dmToken, WebSocketCtor);
  await dm.session.connect();
  await until(dm, m => m.t === 'room.snapshot');
  const player = tableClient('player', wsUrl, join.token, WebSocketCtor);
  await player.session.connect();
  const playerSnap = await until(player, m => m.t === 'room.snapshot');
  const from = playerSnap.p.seq;

  const claim = await send(player, 'seat.claim', { characterId: imp.character.id });
  assert.equal(claim.seat, 1);
  await send(dm, 'dm.encounter.setup', {
    map: null, grid: { cols: 6, rows: 4 },
    monsters: [{ id: 'gob', preset: 'goblin', name: 'Goblin', hp: 30 }], placements: {}
  });
  await send(dm, 'dm.encounter.start', { seed: SEED });

  const started = await until(player, isEvent('turn.started', p => p.payload.actorId === 'pc-1'));
  const turnId = started.p.turnId;
  await send(dm, 'dm.pause');
  await send(player, 'turn.act', { turnId, plan: { kind: 'melee', targetId: 'gob' } });
  for (const c of [dm, player]) await until(c, isEvent('turn.ended', p => p.payload.actorId === 'pc-1'));

  const resyncFrom = dm.frames.length;
  await send(dm, 'resync');
  const snapshot = await until(dm, m => m.t === 'room.snapshot', { since: resyncFrom });
  for (const c of [dm, player]) {
    for (let i = 0; i < 200 && lastSeq(c) < snapshot.p.seq; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(lastSeq(c), snapshot.p.seq, `${c.name} holds every broadcast`);
  }
  return { room, join, dm, player, from, turnId, snapshot };
}

/** The common broadcast window both clients saw: [seq, t] pairs. */
function window(c, from) {
  return sequenced(c, from).map(f => [f.seq, f.t]);
}

/** Check (or, with UPDATE_GOLDEN=1, write) the event-type golden. */
function checkGolden(types) {
  if (UPDATE) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify({
      about: 'M64 S1 smoke: broadcast types both clients see from the player\'s connect to the end of pc-1\'s first turn (seed 42, preset goblin at 30 HP, melee turn.act).',
      seed: SEED,
      types
    }, null, 2)}\n`);
    return;
  }
  assert.ok(existsSync(GOLDEN), 'no smoke golden; run UPDATE_GOLDEN=1 node --test api/tests/smoke.test.js and commit the reason');
  assert.deepEqual(types, JSON.parse(readFileSync(GOLDEN, 'utf8')).types, 'the smoke event sequence diverged from its golden');
}

/** Shared assertions on a played table. */
function assertTable({ dm, player, from, turnId, snapshot }) {
  for (const c of [dm, player]) assert.deepEqual(c.failures, [], `${c.name}: auto-answers failed`);
  // Same seq stream (gap-free, identical types) on both clients.
  const dmWin = window(dm, from);
  assert.deepEqual(window(player, from), dmWin, 'both clients received the same seq sequence');
  assert.ok(dmWin.length > 5);
  dmWin.forEach(([seq], i) => assert.equal(seq, from + 1 + i, 'seq is gap-free'));
  for (const c of [dm, player]) assert.deepEqual(c.session.store.getStats().gap, 0, `${c.name}: store saw no gap`);
  const types = dmWin.map(([, t]) => t);
  checkGolden(types);

  // turn.ended.stateHash: identical on both clients; the last one is the
  // hash of the DM's resync snapshot (the table is paused after pc-1).
  const hashes = (c) => sequenced(c, from).filter(f => f.t === 'turn.ended').map(f => f.p.payload.stateHash);
  assert.deepEqual(hashes(player), hashes(dm));
  assert.ok(hashes(dm).every(h => typeof h === 'string' && h.length > 0));
  const enc = snapshot.p.encounter;
  assert.equal(snapshot.p.stateHash, hashes(dm).at(-1), 'the snapshot hash is the last turn.ended hash');
  assert.equal(stateHash(enc), snapshot.p.stateHash, 'the client recomputes the same hash from the snapshot');
  assert.equal(enc.rng, undefined, 'the projection never carries the RNG');

  // The goblin's HP story is consistent with the attack log.
  const turnEvents = sequenced(dm, from).filter(f => f.p?.turnId === turnId).map(f => f.p);
  const attacks = turnEvents.filter(e => e.type === 'attack.rolled' && e.payload.attackerId === 'pc-1' && e.payload.targetId === 'gob');
  assert.ok(attacks.length >= 1, 'pc-1 rolled an attack at the goblin');
  const hits = turnEvents.filter(e => e.type === 'damage' && e.payload.targetId === 'gob');
  const gob = enc.entities.gob;
  if (attacks.some(a => a.payload.hit)) {
    assert.ok(hits.length >= 1, 'a hit deals damage');
    assert.equal(gob.hp, hits.at(-1).payload.hpAfter, 'the snapshot HP is the last damage hpAfter');
    assert.ok(gob.hp < gob.hpMax, 'the goblin\'s HP changed');
  } else {
    assert.equal(hits.length, 0, 'a miss deals no damage');
    assert.equal(gob.hp, gob.hpMax, 'a logged miss leaves the goblin unhurt');
  }
  // The player's mirror agrees with the DM's snapshot.
  assert.equal(player.session.store.getState().encounter.entities.gob.hp, gob.hp);
  return types;
}

test('S1 smoke: DM + player play one turn on the real engine, in-process, under 5 s', async () => {
  const t0 = performance.now();
  const { db } = await tempDb(root, 'smoke.db');
  const env = { NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_ENGINE: 'real' };
  const srv = await startMultiplayerServer({ db, env, port: 0, host: '127.0.0.1', log: quiet, gatewayOpts: { heartbeatMs: 60_000 } });
  const sockets = new Set();
  let table = null;
  try {
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.connections, 0);

    table = await playFirstPlayerTurn(srv.url, sockets);
    assertTable(table);
    assert.equal(srv.registry.get(table.room.roomId).seq, table.snapshot.p.seq, 'the room is quiescent at the snapshot seq');

    const live = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(live.connections, 2);
    assert.equal(live.sockets, 2);
  } finally {
    if (table) for (const c of [table.dm, table.player]) c.session.close();
    for (const ws of sockets) ws.terminate();
    await srv.close();
    srv.httpServer.closeAllConnections();
  }
  const ms = performance.now() - t0;
  assert.ok(ms < SMOKE_BUDGET_MS, `smoke took ${ms.toFixed(0)} ms`);
  if (process.env.SMOKE_TIMING) console.log(`smoke: ${ms.toFixed(0)} ms`);
});

// ------------------------------------------------------------ restart

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * Spawn `node api/server.js` (multiplayer, real engine) on `dataDir` and
 * resolve once its startup log line names the bound port.
 *
 * api/server.js maps PORT=0 to its 3101 default (`Number(env.PORT) || 3101`),
 * so the child gets a free port picked here; the port is still read back
 * from the "API listening" log line.
 */
async function spawnServer(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(HERE, '..', 'server.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_ENGINE: 'real',
      CF_DATA_DIR: dataDir, CF_DB_PATH: '', PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, at: performance.now() })));
  let out = '';
  const bound = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 20_000);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.includes('API listening')) continue;
        clearTimeout(timer);
        resolve(JSON.parse(line).port);
        return;
      }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${out}`)); });
  });
  assert.equal(bound, port, 'the startup log names the bound port');
  return { child, url: `http://127.0.0.1:${bound}`, exited };
}

async function stopChild(srv) {
  if (srv.child.exitCode === null && srv.child.signalCode === null) srv.child.kill('SIGKILL');
  await srv.exited;
}

test('S1 restart: SIGTERM mid-encounter closes 1012 and exits; a restart on the same DB restores a paused table with the same stateHash', async () => {
  const dataDir = mkdtempSync(join(root, 'child-'));
  const sockets = new Set();
  const a = await spawnServer(dataDir);
  let b = null;
  let table = null;
  let dm2 = null;
  try {
    table = await playFirstPlayerTurn(a.url, sockets);
    // Same table, same seed, another process: the same story.
    assert.deepEqual(assertTable(table), JSON.parse(readFileSync(GOLDEN, 'utf8')).types);
    const { dm, player, room } = table;

    // Mid-encounter: resume; the goblin's AI turn runs and pc-1's next
    // turn starts and waits for its intent.
    const before = dm.frames.length;
    await send(dm, 'dm.resume');
    await until(player, isEvent('turn.started', p => p.payload.actorId === 'pc-1'), { since: player.frames.length });
    const durable = sequenced(dm, 0).filter(f => f.t === 'turn.ended').at(-1).p.payload.stateHash;
    assert.ok(dm.frames.slice(before).some(f => f.t === 'turn.ended' && f.p.payload.actorId === 'gob'), 'the goblin took its turn');
    assert.equal((await (await fetch(`${a.url}/api/health`)).json()).connections, 2);

    // SIGTERM: every client gets 1012 and the process exits 0 within 5 s.
    const t0 = performance.now();
    a.child.kill('SIGTERM');
    const exit = await a.exited;
    const ms = exit.at - t0;
    assert.equal(exit.code, 0, `exit code ${exit.code} (${exit.signal})`);
    assert.ok(ms < 5000, `exited in ${ms.toFixed(0)} ms`);
    if (process.env.SMOKE_TIMING) console.log(`restart: SIGTERM → exit ${ms.toFixed(0)} ms`);
    for (const c of [dm, player]) {
      for (let i = 0; i < 200 && c.closes.length === 0; i++) await new Promise(r => setTimeout(r, 5));
      assert.equal(c.closes[0], 1012, `${c.name} closed 1012`);
      assert.ok(c.frames.some(f => f.t === 'room.closing'), `${c.name} saw room.closing`);
      c.session.close();   // stop the client's reconnect backoff
    }

    // Restart on the same DB: the DM reconnects to a recovered, paused
    // table whose state is the last turn end the clients saw.
    b = await spawnServer(dataDir);
    dm2 = tableClient('dm2', `${b.url.replace(/^http/, 'ws')}/ws`, room.dmToken, trackedWebSocket(sockets));
    await dm2.session.connect();
    const snap = await until(dm2, m => m.t === 'room.snapshot');
    assert.equal(snap.p.room.status, 'paused');
    assert.equal(snap.p.room.paused, true);
    assert.equal(snap.p.stateHash, durable, 'the restored snapshot carries the last turn.ended stateHash');
    assert.equal(stateHash(snap.p.encounter), durable);
    assert.equal(snap.p.encounter.phase, 'running');
    assert.ok(snap.p.history.length > 0, 'history restored');
  } finally {
    if (table) for (const c of [table.dm, table.player]) c.session.close();
    dm2?.session.close();
    for (const ws of sockets) ws.terminate();
    if (b) {
      b.child.kill('SIGTERM');
      await b.exited;
    }
    await stopChild(a);
    if (b) await stopChild(b);
  }
});
