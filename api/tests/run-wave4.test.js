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
