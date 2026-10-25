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
// Phase 1.5 rules over the wire (goldens smoke-extra-attack / smoke-death-save):
// fighter-l5's one Attack action arrives as two `attack.rolled` in one
// turn (R10); a PC dropped to 0 by the goblin makes its death save on its
// next turn and the `death.save` frame is identical on both clients (R9).
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMultiplayerServer } from '../multiplayer.js';
import { createApi } from '../../src/js/client/api.js';
import { stateHash } from '../../src/js/shared/state-hash.js';
import { tempRoot, tempDb, quiet, ddbFixture } from './helpers/server.js';
import {
  trackedWebSocket, tableClient, closedWith, until, untilSeq, isEvent, lastSeq, sequenced, sendOk, spawnServer, stopChild
} from './helpers/table.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'smoke.events.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const SEED = 42;
const SMOKE_BUDGET_MS = 5000;

const { root, cleanup } = tempRoot('cf-smoke-');
after(cleanup);

const send = sendOk;

/**
 * Play the scripted table up to the end of the player's first turn:
 * room → join → import (JSON paste) → connect both → seat.claim → setup
 * (preset goblin) → start (seed 42) → on pc-1's turn the DM pauses (so
 * the table is quiescent after it) and the player sends a melee turn.act.
 * Ends with a DM resync once both clients hold every broadcast.
 * @param {string} base  http(s) origin of the server
 * @param {Set<WebSocket>} sockets  filled with every client socket
 * @param {{dmHold?: function}} [opts]  dmHold(msg, client): leave that DM prompt open
 */
async function playFirstPlayerTurn(base, sockets, { dmHold = null, goblinHp = 30, aiAlly = null } = {}) {
  const WebSocketCtor = trackedWebSocket(sockets);
  const wsUrl = `${base.replace(/^http/, 'ws')}/ws`;
  const anon = createApi({ fetch: globalThis.fetch, base });
  const room = await anon.createRoom('Smoke table');
  const join = await anon.joinRoom(room.code, 'Robin');
  const playerApi = createApi({ fetch: globalThis.fetch, base, token: () => join.token });
  const imp = await playerApi.importCharacter(room.roomId, { json: ddbFixture('fighter-l5') });
  assert.match(imp.character.id, /^paste:/, 'a room paste never collides with a url import');

  const dm = tableClient('dm', wsUrl, room.dmToken, WebSocketCtor, { hold: dmHold });
  await dm.session.connect();
  await until(dm, m => m.t === 'room.snapshot');
  const player = tableClient('player', wsUrl, join.token, WebSocketCtor);
  await player.session.connect();
  const playerSnap = await until(player, m => m.t === 'room.snapshot');
  const from = playerSnap.p.seq;

  const claim = await send(player, 'seat.claim', { characterId: imp.character.id });
  assert.equal(claim.seat, 1);
  if (aiAlly) {
    const dmApi = createApi({ fetch: globalThis.fetch, base, token: () => room.dmToken });
    const ally = await dmApi.importCharacter(room.roomId, { json: ddbFixture(aiAlly) });
    await dmApi.aiSeat(room.roomId, 2, ally.character.id, 'auto');
  }
  await send(dm, 'dm.encounter.setup', {
    map: null, grid: { cols: 6, rows: 4 },
    monsters: [{ id: 'gob', preset: 'goblin', name: 'Goblin', hp: goblinHp }], placements: {}
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
    await untilSeq(c, snapshot.p.seq);
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


// ------------------------------------------------- phase 1.5 rules (R9, R10)

/** Check (or, with UPDATE_GOLDEN=1, write) a golden file under golden/. */
function checkGoldenFile(name, about, data) {
  const file = join(HERE, 'golden', name);
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ about, seed: SEED, ...data }, null, 2)}\n`);
    return;
  }
  assert.ok(existsSync(file), `no golden ${name}; run UPDATE_GOLDEN=1 node --test api/tests/smoke.test.js and commit the reason`);
  const { about: _a, seed: _s, ...want } = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(data, want, `${name}: the event story diverged from its golden`);
}

/** The broadcast frames after `from`, as [seq, t, p] (what both clients must agree on). */
const frames = (c, from) => sequenced(c, from).map(f => [f.seq, f.t, f.p]);

/** A compact, stable projection of one event for the goldens. */
function brief({ type, payload: p }) {
  switch (type) {
    case 'attack.rolled': return [type, { attackerId: p.attackerId, targetId: p.targetId, weapon: p.weapon, kept: p.kept, total: p.total, ac: p.ac, hit: p.hit, crit: p.crit }];
    case 'damage': return [type, { sourceId: p.sourceId, targetId: p.targetId, amount: p.amount, hpAfter: p.hpAfter }];
    case 'exchange': return [type, { exchangeId: p.exchangeId, attackerId: p.attackerId, defenderId: p.defenderId }];
    case 'death.save': return [type, p];
    case 'entity.downed': case 'turn.skipped': case 'condition.applied': case 'turn.started': return [type, p];
    case 'turn.ended': return [type, { actorId: p.actorId }];
    default: return [type];
  }
}

/** Boot the in-process real-engine server, run `fn(srv, sockets)`, tear down. */
async function withServer(dbName, fn) {
  const { db } = await tempDb(root, dbName);
  const env = { NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_ENGINE: 'real' };
  const srv = await startMultiplayerServer({ db, env, port: 0, host: '127.0.0.1', log: quiet, gatewayOpts: { heartbeatMs: 60_000 } });
  const sockets = new Set();
  const clients = [];
  try {
    await fn(srv, sockets, clients);
  } finally {
    for (const c of clients) c.session.close();
    for (const ws of sockets) ws.terminate();
    await srv.close();
    srv.httpServer.closeAllConnections();
  }
}

test('S1 rules: Extra Attack (R10) — fighter-l5\'s one Attack action is two attack.rolled in one turn, identical on both clients', async () => {
  await withServer('smoke-extra.db', async (srv, sockets, clients) => {
    const table = await playFirstPlayerTurn(srv.url, sockets, { goblinHp: 200 });
    const { dm, player, from, turnId } = table;
    clients.push(dm, player);
    for (const c of [dm, player]) assert.deepEqual(c.failures, [], `${c.name}: auto-answers failed`);
    assert.deepEqual(frames(player, from), frames(dm, from), 'both clients hold the same frames, payloads included');

    const turn = sequenced(dm, from).filter(f => f.p?.turnId === turnId).map(f => f.p);
    const attacks = turn.filter(e => e.type === 'attack.rolled' && e.payload.attackerId === 'pc-1');
    assert.equal(attacks.length, 2, 'Extra Attack: two attack rolls in pc-1\'s turn');
    assert.ok(attacks.every(a => a.payload.targetId === 'gob' && a.payload.weapon === 'Longsword' && !a.payload.isReaction));
    assert.equal(turn.filter(e => e.type === 'plan.chosen').length, 1, 'one Attack action, one plan');
    const exchanges = turn.filter(e => e.type === 'exchange').map(e => e.payload.exchangeId);
    assert.equal(exchanges.length, 2, 'one cinema exchange per swing');
    assert.match(exchanges[1], /\.s2$/, 'the second swing is the same exchange\'s swing 2');
    const hp = turn.filter(e => e.type === 'damage' && e.payload.targetId === 'gob').map(e => e.payload.hpAfter);
    assert.equal(table.snapshot.p.encounter.entities.gob.hp, hp.at(-1) ?? 200, 'the snapshot HP is the last damage hpAfter');

    checkGoldenFile('smoke-extra-attack.events.json',
      'M64 phase 1.5 R10 over the wire: pc-1 (fixture fighter-l5, Extra Attack) takes one melee turn.act against a preset goblin at 200 HP, seed 42; the events of that turn, compacted.',
      { turn: turn.map(brief) });
  });
});

test('S1 rules: dying (R9) — a PC dropped to 0 makes its death save, and the death.save reaches both clients identically', async () => {
  // pc-1 (player, fighter-l5) + pc-2 (AI seat, wizard-l5) vs a 200-HP
  // goblin, seed 42. After pc-1's first turn the DM sets pc-1 to 1 HP,
  // arms the goblin's next attack d20 at 19 and turns plan review on; the
  // DM's client holds the goblin's plan prompt once a death save has been
  // seen, so the table stops at a known point.
  const deathSeen = (c) => c.frames.some(f => f.t === 'death.save');
  const dmHold = (m, c) => m.p.kind === 'plan' && m.p.payload?.entityId === 'gob' && deathSeen(c);
  await withServer('smoke-dying.db', async (srv, sockets, clients) => {
    const table = await playFirstPlayerTurn(srv.url, sockets, { dmHold, goblinHp: 200, aiAlly: 'wizard-l5' });
    const { dm, player, room } = table;
    clients.push(dm, player);
    const mark = table.snapshot.p.seq;

    await send(dm, 'dm.review.set', { plans: true });
    await send(dm, 'dm.entity.patch', { entityId: 'pc-1', hp: 1 });
    await send(dm, 'dm.roll.arm', { entityId: 'gob', rollKind: 'attack', value: 19 });
    await send(dm, 'dm.resume');
    await until(dm, m => m.t === 'prompt.open' && dm.held.includes(m));
    // The broker flushes before it prompts: every broadcast so far is out.
    const head = srv.registry.get(room.roomId).seq;
    for (const c of [dm, player]) {
      await untilSeq(c, head);
      assert.equal(lastSeq(c), head, `${c.name} holds every broadcast`);
      assert.deepEqual(c.failures, [], `${c.name}: auto-answers failed`);
    }

    const dmFrames = frames(dm, mark);
    assert.deepEqual(frames(player, mark), dmFrames, 'both clients hold the same frames, payloads included');
    dmFrames.forEach(([seq], i) => assert.equal(seq, mark + 1 + i, 'seq is gap-free'));
    // Engine events carry {type, payload}; room broadcasts (room.status,
    // entity.updated) only their frame type.
    const events = dmFrames.map(([, t, p]) => ({ type: t, payload: p.payload ?? p }));

    // The goblin's armed hit takes pc-1 from 1 HP to 0: downed, unconscious.
    const drop = events.find(e => e.type === 'damage' && e.payload.targetId === 'pc-1');
    assert.equal(drop?.payload.sourceId, 'gob');
    assert.equal(drop.payload.hpAfter, 0, 'pc-1 drops to 0');
    assert.ok(events.some(e => e.type === 'entity.downed' && e.payload.entityId === 'pc-1'));
    assert.ok(events.some(e => e.type === 'condition.applied' && e.payload.entityId === 'pc-1' && e.payload.condition === 'unconscious'));
    assert.ok(!events.some(e => e.type === 'entity.died' || e.type === 'encounter.ended'), 'dying is not dead; the table plays on');

    // pc-1's next turn is its death save, then the skip.
    const saves = events.filter(e => e.type === 'death.save');
    assert.equal(saves.length, 1);
    const save = saves[0];
    assert.equal(save.payload.entityId, 'pc-1');
    assert.equal(save.payload.cause, 'roll');
    assert.equal(save.payload.success, save.payload.d20 >= 10);
    const at = events.indexOf(save);
    assert.deepEqual([events[at + 1].type, events[at + 1].payload], ['turn.skipped', { actorId: 'pc-1', reason: 'down' }]);
    const saveFrame = (c) => sequenced(c, mark).find(f => f.t === 'death.save');
    assert.deepEqual(saveFrame(player), saveFrame(dm), 'the death.save frame is identical on both clients');

    // The authoritative state agrees: downed, the tallies of that save.
    const resyncFrom = dm.frames.length;
    await send(dm, 'resync');
    const snap = await until(dm, m => m.t === 'room.snapshot', { since: resyncFrom });
    const pc1 = snap.p.encounter.entities['pc-1'];
    assert.equal(pc1.hp, 0);
    assert.equal(pc1.status, 'downed');
    assert.equal(pc1.deathSaves.successes, save.payload.successes);
    assert.equal(pc1.deathSaves.failures, save.payload.failures);
    assert.equal(stateHash(snap.p.encounter), snap.p.stateHash);
    const mirror = player.session.store.getState().encounter.entities['pc-1'];
    assert.equal(mirror.hp, 0, 'the player\'s mirror shows pc-1 at 0 HP');

    checkGoldenFile('smoke-death-save.events.json',
      'M64 phase 1.5 R9 over the wire: fighter-l5 (player) + wizard-l5 (AI seat) vs a 200-HP preset goblin, seed 42; after pc-1\'s first turn the DM sets pc-1 to 1 HP and arms the goblin\'s attack d20 at 19; the broadcasts from the resume to the goblin\'s next plan prompt, compacted.',
      { events: events.map(brief) });
  });
});

// ------------------------------------------------------------ restart

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
    // Both clients are waited on, from marks taken before the resume: the
    // two sockets drain independently, so the DM's frames may trail the
    // player's (reading the DM's last turn.ended after waiting only on the
    // player raced).
    const before = dm.frames.length;
    const marks = new Map([dm, player].map(c => [c, c.frames.length]));
    await send(dm, 'dm.resume');
    for (const c of [dm, player]) await until(c, isEvent('turn.started', p => p.payload.actorId === 'pc-1'), { since: marks.get(c) });
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
      assert.equal(await closedWith(c), 1012, `${c.name} closed 1012`);
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
