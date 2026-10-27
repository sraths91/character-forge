// M65 S22 — run restart variants against `node api/server.js` as a child
// process (PORT=0, the kernel-bound port read from the startup log; every
// wait is on a frame, never a sleep — the S1 restart fix).
//
// The S21 table (helpers/run-table.js) is played up to a cut, the DM
// resyncs for the pre-kill run.snapshot, the process gets SIGTERM (exit 0,
// 1012 to every client), and a second process on the same data dir takes
// the reconnecting table. At each cut the DM's first run.snapshot after the
// restart hashes exactly as the pre-kill one, and the run goes on:
//   between   — after the ambush: the room reopens 'between'; the rest node
//               is entered and the fighter's hit die rolls
//   level-up  — after the den, the fighter's level 6 chosen (pending_dm, a
//               level_ups row and no run event) and the cleric's pending:
//               both offers come back, the DM confirms the chosen one
//   mid-fight — node 3 with the fighter's turn waiting for its intent: the
//               encounter comes back paused at the last turn end, resumes
//               (the same turn re-asks), ends once, and the loot lands

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { tempRoot } from './helpers/server.js';
import { until, untilSeq, sendOk, closedWith, spawnServer, stopChild } from './helpers/table.js';
import {
  openRunTable, reconnectTable, tableClients, slotOf, marks, untilRun, fight, beginFight, runSnapshotHash, wireRunLog
} from './helpers/run-table.js';

const { root, cleanup } = tempRoot('cf-run-restart-');
after(cleanup);

/** The DM's resync: the room.snapshot and run.snapshot it answers with; every client then holds every broadcast. */
async function dmResync(t) {
  const from = t.dm.frames.length;
  await sendOk(t.dm, 'resync');
  const room = await until(t.dm, m => m.t === 'room.snapshot', { since: from });
  const run = await until(t.dm, m => m.t === 'run.snapshot', { since: from });
  for (const c of tableClients(t)) await untilSeq(c, room.p.seq);
  return { room: room.p, run: run.p };
}

/** Node 1 (the wounded ambush) → the rest node, the fighter's hit die → node 3 entered. */
async function toDen(t) {
  await fight(t, { wound: true });
  await sendOk(t.dm, 'dm.run.advance', { toNodeId: 'n-camp' });
  await sendOk(t.players.sam.c, 'rest.spend', { slotId: slotOf(t, 'sam'), hitDice: { Fighter: 1 } });
  const mk = marks(t);
  await sendOk(t.dm, 'dm.rest.grant', { type: 'short' });
  await untilRun(t, mk, { status: 'between', nodeId: 'n-camp', completed: true });
  await sendOk(t.dm, 'dm.run.advance', { toNodeId: 'n-den' });
}

/**
 * Play to a cut on process A, SIGTERM it, restart on the same data dir,
 * reconnect the table, and hand both sides to `check`.
 * @param {(t: object) => Promise<object|void>} playTo  leaves the table quiescent; its result is passed on
 * @param {(t: object, ctx: object) => Promise<void>} check
 */
async function restartAt(playTo, check) {
  const dataDir = mkdtempSync(join(root, 'child-'));
  const sockets = new Set();
  const a = await spawnServer(dataDir);
  let b = null;
  let t = null;
  try {
    t = await openRunTable(a.url, sockets);
    const played = await playTo(t);
    const pre = await dmResync(t);
    const preLogs = new Map(tableClients(t).map(c => [c.name, wireRunLog(c)]));

    const t0 = performance.now();
    a.child.kill('SIGTERM');
    const exit = await a.exited;
    assert.equal(exit.code, 0, `exit code ${exit.code} (${exit.signal})`);
    assert.ok(exit.at - t0 < 5000, `exited in ${(exit.at - t0).toFixed(0)} ms`);
    for (const c of tableClients(t)) {
      assert.equal(await closedWith(c), 1012, `${c.name} closed 1012`);
      c.session.close();   // stop the client's reconnect backoff
    }

    b = await spawnServer(dataDir);
    t.hold = null;
    await reconnectTable(t, b.url);
    const post = { room: t.dm.frames.find(m => m.t === 'room.snapshot').p, run: t.dm.frames.find(m => m.t === 'run.snapshot').p };
    assert.equal(runSnapshotHash(post.run), runSnapshotHash(pre.run), 'the reconnecting DM\'s run.snapshot hashes as the pre-kill one');
    assert.deepEqual(post.run, pre.run);
    for (const { name } of [{ name: 'sam' }, { name: 'pat' }]) {
      const c = t.players[name].c;
      assert.equal(c.frames.find(m => m.t === 'run.snapshot').p.run.seq, pre.run.run.seq, `${name}'s run.snapshot is at the pre-kill run seq`);
    }
    await check(t, { pre, post, played, preLogs });
    for (const c of tableClients(t)) assert.deepEqual(c.failures, [], `${c.name}: auto-answers failed`);
  } finally {
    if (t) for (const c of t.clients) c.session.close();
    for (const ws of sockets) ws.terminate();
    if (b) {
      b.child.kill('SIGTERM');
      await b.exited;
    }
    await stopChild(a);
    if (b) await stopChild(b);
  }
}

/** The run events every client received after the restart: identical, gap-free from `fromSeq + 1`. */
function assertRunContinues(t, fromSeq) {
  const logs = tableClients(t).map(c => wireRunLog(c));
  for (const [i, c] of tableClients(t).entries()) {
    assert.deepEqual(logs[i], logs[0], `${c.name}: same run.event stream after the restart`);
    assert.equal(c.session.runStore.getState().seq, fromSeq + logs[0].length, `${c.name}: its run store saw no gap`);
  }
  logs[0].forEach((e, i) => assert.equal(e.seq, fromSeq + 1 + i, 'the run seq continues where it stopped'));
  return logs[0];
}

test('S22 restart: SIGTERM between nodes → identical run hash; the run continues into the rest node', async () => {
  await restartAt(
    async (t) => { await fight(t, { wound: true }); },
    async (t, { pre, post }) => {
      assert.equal(post.run.run.status, 'between');
      assert.equal(post.room.room.status, 'between', 'a run room reopens between nodes');
      assert.equal(post.run.run.currentNodeId, 'n-ambush');
      await sendOk(t.dm, 'dm.run.advance', { toNodeId: 'n-camp' });
      await sendOk(t.players.sam.c, 'rest.spend', { slotId: slotOf(t, 'sam'), hitDice: { Fighter: 1 } });
      const mk = marks(t);
      await sendOk(t.dm, 'dm.rest.grant', { type: 'short' });
      await untilRun(t, mk, { status: 'between', nodeId: 'n-camp', completed: true });
      const log = assertRunContinues(t, pre.run.run.seq);
      assert.deepEqual(log.map(e => e.type), ['node.entered', 'rest.taken', 'node.completed']);
      assert.equal(log[1].payload.rolls[slotOf(t, 'sam')].length, 1, 'the fighter rolled his hit die after the restart');
    }
  );
});

test('S22 restart: SIGTERM with level-ups pending (one chosen, one offered) → identical run hash; offers return, the DM confirms', async () => {
  await restartAt(
    async (t) => {
      await toDen(t);
      await fight(t);
      const sam = t.players.sam.c;
      const offer = await until(sam, m => m.t === 'levelup.offer' && m.p.slotId === slotOf(t, 'sam'));
      await until(t.players.pat.c, m => m.t === 'levelup.offer');
      // levelup.choose writes a level_ups row, not a run event: it must survive the restart too.
      await sendOk(sam, 'levelup.choose', { slotId: slotOf(t, 'sam'), levelUpId: offer.p.levelUpId, choices: { asi: { STR: 1, CON: 1 } } });
      return { levelUpId: offer.p.levelUpId };
    },
    async (t, { pre, post, played }) => {
      const sam = slotOf(t, 'sam');
      const pat = slotOf(t, 'pat');
      const status = (snap) => Object.fromEntries(snap.levelUps.map(l => [l.slotId, l.status]));
      assert.deepEqual(status(post.run), { [sam]: 'pending_dm', [pat]: 'pending_player' });
      assert.deepEqual(status(pre.run), status(post.run));
      // The offers come back on reconnect: each seat its own, the DM both.
      for (const [name, slot] of [['sam', sam], ['pat', pat]]) {
        const c = t.players[name].c;
        const o = await until(c, m => m.t === 'levelup.offer');
        assert.equal(o.p.slotId, slot, `${name} is offered only their own level-up`);
      }
      await until(t.dm, m => m.t === 'levelup.offer' && m.p.slotId === sam);
      await until(t.dm, m => m.t === 'levelup.offer' && m.p.slotId === pat);
      const samOffer = t.players.sam.c.frames.find(m => m.t === 'levelup.offer').p;
      assert.deepEqual([samOffer.status, samOffer.picked], ['pending_dm', { asi: { STR: 1, CON: 1 } }], 'the chosen ASI survived the restart');

      const mk = marks(t);
      await sendOk(t.dm, 'dm.levelup.confirm', { levelUpId: played.levelUpId });
      for (const c of tableClients(t)) await until(c, m => m.t === 'run.event' && m.p.type === 'level.applied', { since: mk.get(c) });
      const log = assertRunContinues(t, pre.run.run.seq);
      assert.deepEqual(log.map(e => [e.type, e.payload.slotId, e.payload.toLevel]), [['level.applied', sam, 6]]);
    }
  );
});

test('S22 restart: SIGTERM mid-encounter in node 3 → identical run hash; the encounter comes back paused, resumes, ends once', async () => {
  await restartAt(
    async (t) => {
      await toDen(t);
      // The fighter's first turn in the den waits for its intent.
      t.hold = (msg, c) => c.name === 'sam';
      const mk = marks(t);
      await beginFight(t);
      const sam = t.players.sam.c;
      const held = await until(sam, m => m.t === 'turn.started' && m.seq !== undefined && m.p.payload.actorId === t.actorOf.sam, { since: mk.get(sam) });
      // The last turn end of this fight (null when the fighter acts first).
      const ended = t.dm.frames.slice(mk.get(t.dm)).filter(f => f.t === 'turn.ended').at(-1);
      return { turnId: held.p.turnId, durable: ended ? ended.p.payload.stateHash : null };
    },
    async (t, { pre, post, played }) => {
      assert.equal(pre.room.room.turn.awaitingIntent, true, 'the kill came while the fighter\'s turn waited');
      assert.equal(post.run.run.status, 'in-node');
      assert.equal(post.room.room.status, 'paused', 'the encounter comes back paused');
      assert.equal(post.room.room.paused, true);
      if (played.durable) assert.equal(post.room.stateHash, played.durable, 'at the last turn end the clients saw');
      assert.equal(post.room.encounter.phase, 'running');

      const mk = marks(t);
      const acted = t.acts.sam;
      await sendOk(t.dm, 'dm.resume');
      // The interrupted turn re-runs under the same turnId and asks again,
      // re-announced by a fresh turn.started (resumed: true) on every
      // client (W4): the fighter's client answers it like any turn, with
      // no resync.
      const sam = t.players.sam.c;
      for (const c of tableClients(t)) {
        const again = await until(c, m => m.t === 'turn.started' && m.seq !== undefined && m.p.payload.resumed === true, { since: mk.get(c) });
        assert.deepEqual([again.p.turnId, again.p.payload.actorId], [played.turnId, t.actorOf.sam], `${c.name}: the same turn is announced again`);
      }
      await untilRun(t, mk, { status: 'between', nodeId: 'n-den', completed: true });
      assert.ok(t.acts.sam > acted, 'the fighter\'s client answered the re-announced turn with turn.act');
      assert.equal(sam.frames.slice(mk.get(sam)).filter(m => m.t === 'room.snapshot').length, 0, 'without a resync');
      for (const c of tableClients(t)) assert.ok(!c.frames.slice(mk.get(c)).some(f => f.t === 'turn.rejected'), `${c.name}: no turn.act was rejected`);

      const log = assertRunContinues(t, pre.run.run.seq);
      const types = log.map(e => e.type);
      assert.equal(types.filter(x => x === 'encounter.result').length, 1, 'the encounter ended once');
      assert.deepEqual(types, ['encounter.result', 'xp.awarded', 'level.queued', 'level.queued', 'loot.granted', 'node.completed']);
      assert.equal(log[0].payload.outcome, 'party-victory');
    }
  );
});
