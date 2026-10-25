// M65 B26 — save / load and rejoin: run_snapshots between nodes only,
// load appends snapshot.restored and never deletes events, seat.reclaim
// (automatic when the old participant left or was kicked, else the DM
// approves). DM recovery with the campaign key is in runs-http.test.js.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, tempDb, seedPlayer } from './helpers/server.js';
import { makeRunRoom, runLog } from './helpers/runs.js';
import { loadRunScript } from '../../src/tests/helpers/run-driver.js';
import { validateRunSnapshot } from '../../src/js/shared/run-state.js';
import { validateRunEventLog } from '../../src/js/shared/run-events.js';

const { root, cleanup } = tempRoot('cf-run-save-');
after(cleanup);

const SCRIPT = loadRunScript('fight-rest-fight');
const ok = (reply) => { assert.equal(reply?.t, 'ack', JSON.stringify(reply?.p)); return reply.p; };
const refused = (reply, code) => { assert.equal(reply?.t, 'error', JSON.stringify(reply?.p)); assert.equal(reply.p.code, code, reply.p.message); };

async function runRoom(opts = {}) {
  const { db } = await tempDb(root);
  const ctx = makeRunRoom(db, opts);
  const r = ctx.open();
  r.room.run.start({ campaign: SCRIPT.campaign, runId: 'run-b26', seed: SCRIPT.seed });
  return { db, ctx, r };
}

test('B26: dm.snapshot.save — DM only, between nodes only; the blob validates', async () => {
  const { r, ctx } = await runRoom({ players: ['Pat'], seats: [{ seat: 1, fixture: 'cleric-l5', player: 0 }, { seat: 2, fixture: 'fighter-l5' }] });
  refused(await r.dm('dm.snapshot.save', { label: 'too early' }), 'E_INVALID_INTENT');   // in-node: the encounter is not fought
  ok(await r.dm('dm.run.advance', { toNodeId: 'n-camp', override: true }));
  refused(await r.send(ctx.players[0].id, 'dm.snapshot.save', {}), 'E_FORBIDDEN');
  const saved = ok(await r.dm('dm.snapshot.save', { label: 'camp' }));
  const snap = r.runStore.getSnapshot('run-b26', saved.snapshotId);
  assert.deepEqual(validateRunSnapshot(snap.blob).errors, []);
  assert.equal(snap.label, 'camp');
  const ev = runLog(r.runStore, 'run-b26').at(-1);
  assert.deepEqual([ev.type, ev.payload.snapshotId, ev.payload.atSeq], ['snapshot.saved', saved.snapshotId, saved.atSeq]);
});

test('B26: dm.snapshot.load restores characters, items, level-ups, stash, RNG and the node walk; the log only grows', async () => {
  const { r, ctx } = await runRoom({ players: ['Pat'], seats: [{ seat: 1, fixture: 'cleric-l5', player: 0 }, { seat: 2, fixture: 'fighter-l5' }] });
  ok(await r.dm('dm.run.advance', { toNodeId: 'n-camp', override: true }));
  const saved = ok(await r.dm('dm.snapshot.save', {}));
  const before = { chars: r.runStore.listCharacters('run-b26').map(c => [c.state, c.xp, c.level]), items: r.runStore.listItems('run-b26'), rng: r.runStore.getRun('run-b26').rng };
  // Change everything a snapshot covers.
  ok(await r.dm('dm.xp.adjust', { slotId: 'slot-2', delta: 20000 }));
  ok(await r.dm('dm.levelup.confirm', { levelUpId: 'lu-1', choices: { asi: { CON: 1, WIS: 1 } } }));
  ok(await r.dm('rest.spend', { slotId: 'slot-2', hitDice: { Fighter: 1 } }));
  ok(await r.dm('dm.rest.grant', { type: 'short' }));
  ok(await r.dm('dm.run.advance', { toNodeId: 'n-den' }));
  assert.equal(r.runStore.getCharacter('slot-2').level, 6);
  const potion = r.runStore.listItems('run-b26').find(i => /Potion/.test(i.name));
  ok(await r.dm('dm.loot.assign', { itemId: potion.id, toSlotId: null }));
  const logBefore = runLog(r.runStore, 'run-b26');
  refused(await r.send(ctx.players[0].id, 'dm.snapshot.load', { snapshotId: saved.snapshotId }), 'E_FORBIDDEN');
  ok(await r.dm('dm.snapshot.load', { snapshotId: saved.snapshotId }));
  assert.deepEqual(r.runStore.listCharacters('run-b26').map(c => [c.state, c.xp, c.level]), before.chars);
  assert.deepEqual(r.runStore.listItems('run-b26').map(i => [i.id, i.ownerSlotId, i.qty]), before.items.map(i => [i.id, i.ownerSlotId, i.qty]));
  assert.deepEqual(r.runStore.getRun('run-b26').rng, before.rng);
  assert.deepEqual(r.runStore.listLevelUps('run-b26'), [], 'the level-up queued after the save is gone');
  const log = runLog(r.runStore, 'run-b26');
  assert.deepEqual(log.slice(0, logBefore.length), logBefore, 'no event was deleted or changed');
  assert.equal(log.length, logBefore.length + 1);
  assert.equal(log.at(-1).type, 'snapshot.restored');
  assert.deepEqual(validateRunEventLog(log).errors, []);
  // The node walk is back at the camp: its edge is on offer again.
  assert.equal(r.room.run.progress.currentNodeId, 'n-camp');
  assert.equal(r.room.run.progress.completed, false);
  ok(await r.dm('dm.run.advance', { toNodeId: 'n-den' }));
});

test('B26: a restore survives a restart (the walk is rebuilt from the log)', async () => {
  const { r, ctx } = await runRoom();
  ok(await r.dm('dm.run.advance', { toNodeId: 'n-camp', override: true }));
  const saved = ok(await r.dm('dm.snapshot.save', {}));
  ok(await r.dm('dm.run.advance', { toNodeId: 'n-den' }));
  ok(await r.dm('dm.snapshot.load', { snapshotId: saved.snapshotId }));
  r.room.shutdown();
  const r2 = ctx.open();
  assert.equal(r2.room.run.progress.currentNodeId, 'n-camp');
  assert.deepEqual(r2.room.run.progress, r.room.run.progress);
});

test('B26: seat.reclaim — automatic after a kick; DM approval while the old player is still in the room', async () => {
  const { r, ctx, db } = await runRoom({ players: ['Pat', 'Sam'], seats: [{ seat: 1, fixture: 'cleric-l5', player: 0 }, { seat: 2, fixture: 'fighter-l5', player: 1 }] });
  const [pat, sam] = ctx.players;
  // Pat lost their browser: a new participant joins by code.
  const pat2 = seedPlayer(db, ctx.roomId, 'Pat again');
  r.room.memberJoined({ participantId: pat2.id, displayName: 'Pat again' });
  refused(await r.dm('seat.reclaim', { slotId: 'slot-1' }), 'E_FORBIDDEN');
  const pending = ok(await r.send(pat2.id, 'seat.reclaim', { slotId: 'slot-1' }));
  assert.equal(pending.pending, true);
  assert.deepEqual(r.room.run.snapshotFor({ role: 'dm', id: ctx.dmId }).reclaims.map(x => [x.slotId, x.memberId]), [['slot-1', pat2.id]]);
  assert.equal(r.room.run.snapshotFor({ role: 'player', id: pat2.id }).reclaims, undefined, 'players do not see the queue');
  refused(await r.send(sam.id, 'dm.seat.reclaim.approve', { slotId: 'slot-1', memberId: pat2.id, approve: true }), 'E_FORBIDDEN');
  ok(await r.dm('dm.seat.reclaim.approve', { slotId: 'slot-1', memberId: pat2.id, approve: true }));
  assert.equal(r.room.seats.find(x => x.id === 'slot-1').controllerParticipantId, pat2.id);
  const ev = runLog(r.runStore, 'run-b26').at(-1);
  assert.deepEqual([ev.type, ev.payload.before.memberId, ev.payload.after.memberId], ['seat.filled', pat.id, pat2.id]);

  // Sam is kicked; his new browser reclaims at once.
  r.service.kick({ participantId: ctx.dmId, roomId: ctx.roomId, role: 'dm' }, ctx.roomId, sam.id);
  r.room.seatsChanged();
  const sam2 = seedPlayer(db, ctx.roomId, 'Sam again');
  r.room.memberJoined({ participantId: sam2.id, displayName: 'Sam again' });
  const auto = ok(await r.send(sam2.id, 'seat.reclaim', { slotId: 'slot-2' }));
  assert.equal(auto.reclaimed, true);
  assert.equal(r.room.seats.find(x => x.id === 'slot-2').controllerParticipantId, sam2.id);
  refused(await r.send(sam2.id, 'seat.reclaim', { slotId: 'slot-1' }), 'E_SEAT_TAKEN');
});
