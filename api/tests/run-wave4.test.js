// M65 phase 2 Wave 4 (E3) — the server gaps the Wave 3 client and smokes
// found: one levelup.offer per change, the resumed turn re-announced,
// level-up picks and rest declarations in the run log (and persisted),
// the run hash on the wire plus the events / snapshots routes, the stash
// split, auto level-ups and confirmed XP, reconcile safety, and downtime
// healing spells.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, tempDb } from './helpers/server.js';
import { makeRunRoom } from './helpers/runs.js';
import { loadRunScript } from '../../src/tests/helpers/run-driver.js';

const { root, cleanup } = tempRoot('cf-run-wave4-');
after(cleanup);

const SCRIPT = loadRunScript('fight-rest-fight');
const ok = (reply) => { assert.equal(reply?.t, 'ack', JSON.stringify(reply?.p)); return reply.p; };

/**
 * A run room with Pat on the cleric (slot-1) and the fighter (slot-2) an
 * AI seat 50 XP short of level 6; the DM and Pat are connected.
 * @param {{campaign?: object, xp?: object}} [o]
 */
async function table({ campaign = SCRIPT.campaign, xp = { 'slot-2': 13950 } } = {}) {
  const { db } = await tempDb(root);
  const ctx = makeRunRoom(db, { players: ['Pat'], seats: [{ seat: 1, fixture: 'cleric-l5', player: 0 }, { seat: 2, fixture: 'fighter-l5' }] });
  const r = ctx.open();
  const pat = ctx.players[0].id;
  const dmFrames = r.connect(ctx.dmId, 'dm');
  const patFrames = r.connect(pat, 'player', 'Pat');
  r.room.run.start({ campaign, runId: 'run-w4', seed: SCRIPT.seed, xp });
  return { db, ctx, r, pat, dmFrames, patFrames, send: (t, p) => r.send(pat, t, p) };
}

/** levelup.offer frames since `from`, counted per levelUpId. */
const offerCounts = (frames, from = 0) => {
  const out = {};
  for (const f of frames.slice(from)) if (f.t === 'levelup.offer') out[f.p.levelUpId] = (out[f.p.levelUpId] || 0) + 1;
  return out;
};

async function fightAmbush(r) {
  ok(await r.dm('dm.node.begin', {}));
  ok(await r.dm('dm.encounter.start', {}));
  await r.settle();
}

test('W4-1: an encounter that queues a level-up offers it once to the DM; dm.xp.adjust offers once to the seat and the DM', async () => {
  const t = await table();
  const from = t.dmFrames.length;
  await fightAmbush(t.r);
  const lu = t.r.runStore.listLevelUps('run-w4');
  assert.equal(lu.length, 1, 'the fighter queued level 6');
  assert.deepEqual(offerCounts(t.dmFrames, from), { 'lu-1': 1 }, 'the DM gets the AI seat\'s offer once');
  assert.deepEqual(offerCounts(t.patFrames), {}, 'Pat does not control the fighter');

  const dmAt = t.dmFrames.length;
  const patAt = t.patFrames.length;
  ok(await t.r.dm('dm.xp.adjust', { slotId: 'slot-1', delta: 20000, reason: 'milestone' }));
  const id = t.r.runStore.listLevelUps('run-w4').find(l => l.slotId === 'slot-1').id.split('.').at(-1);
  assert.equal(offerCounts(t.patFrames, patAt)[id], 1, 'Pat gets her offer once');
  assert.equal(offerCounts(t.dmFrames, dmAt)[id], 1, 'and the DM once');
  assert.equal(offerCounts(t.dmFrames, dmAt)['lu-1'], 1, 'a change re-offers each open level-up once');
});

const tick = () => new Promise(res => setImmediate(res));
/** Spin until the room's turn waits for `ownerId`'s intent. */
async function waitingFor(room, ownerId) {
  for (let i = 0; i < 5000 && room.turn?.awaiting?.ownerId !== ownerId; i++) await tick();
  assert.equal(room.turn?.awaiting?.ownerId, ownerId, 'the turn waits for the player');
  return room.turn.turnId;
}

test('W4-2: a turn recovered at boot is re-announced on dm.resume (same turnId), across two restarts and a rejected intent', async () => {
  const { db } = await tempDb(root);
  const ctx = makeRunRoom(db, { players: ['Pat'], seats: [{ seat: 1, fixture: 'cleric-l5', player: 0 }, { seat: 2, fixture: 'fighter-l5' }] });
  const pat = ctx.players[0].id;
  const r = ctx.open();
  r.connect(ctx.dmId, 'dm');
  r.connect(pat, 'player', 'Pat', { autoDelegate: false });
  r.room.run.start({ campaign: SCRIPT.campaign, runId: 'run-w4', seed: SCRIPT.seed });
  ok(await r.dm('dm.node.begin', {}));
  ok(await r.dm('dm.encounter.start', {}));
  const turnId = await waitingFor(r.room, pat);
  const rejected = await r.send(pat, 'turn.act', { turnId, plan: { kind: 'melee', targetId: 'nobody' } });
  assert.equal(rejected.t, 'error', 'a rejected intent leaves a turn.rejected in the tail');
  r.room.shutdown();

  // Restart 1: paused; the resume re-asks and re-announces the same turn.
  const r2 = ctx.open();
  assert.equal(r2.room.status, 'paused');
  const dm2 = r2.connect(ctx.dmId, 'dm');
  const pat2 = r2.connect(pat, 'player', 'Pat', { autoDelegate: false });
  ok(await r2.dm('dm.resume', {}));
  assert.equal(await waitingFor(r2.room, pat), turnId, 'the same turn waits again');
  for (const frames of [dm2, pat2]) {
    const again = frames.filter(f => f.t === 'turn.started' && f.p.payload.resumed === true);
    assert.equal(again.length, 1, 'one re-announcement');
    assert.equal(again[0].p.turnId, turnId);
    assert.ok(again[0].seq > frames.find(f => f.t === 'room.snapshot').p.seq, 'a sequenced broadcast after the reconnect snapshot');
  }
  r2.room.shutdown();

  // Restart 2: the earlier re-announcement is replay noise, not a divergence.
  const r3 = ctx.open();
  r3.connect(ctx.dmId, 'dm');
  const pat3 = r3.connect(pat, 'player', 'Pat');   // hands every turn to the AI from here on
  ok(await r3.dm('dm.resume', {}));
  await r3.settle();
  const again = pat3.filter(f => f.t === 'turn.started' && f.p.payload.resumed === true);
  assert.deepEqual(again.map(f => f.p.turnId), [turnId], 'announced again after the second restart');
  assert.equal(r3.room.status, 'between', 'the encounter ran to its end and the run is between nodes');
  assert.equal(r3.runStore.getRun('run-w4').status, 'between');
});
