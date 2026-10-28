// M65 T24 — run-driver's replayRunEvents covers E3's Wave 4 run events:
// `currency.changed` (stash coin → a seat's purse) and `heal.cast` (a
// between-node healing spell: caster slot + targets' HP). After a real
// RunController plays them, the replay of its log equals the stored
// characters (state, xp, level, lifeStatus) — the projection the S21 run
// smoke compares against the final run.snapshot.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, tempDb } from '../../api/tests/helpers/server.js';
import { makeRunRoom, runLog } from '../../api/tests/helpers/runs.js';
import { loadRunScript, replayRunEvents } from './helpers/run-driver.js';

const { root, cleanup } = tempRoot('cf-run-replay-w4-');
after(cleanup);

const SCRIPT = loadRunScript('fight-rest-fight');
const RUN_ID = 'run-t24';
const ok = (reply) => { assert.equal(reply?.t, 'ack', JSON.stringify(reply?.p)); return reply.p; };

/** A coin-carrying campaign: the den leads to a free loot node, then a DM-split chest. */
const LOOT_CAMPAIGN = {
  ...SCRIPT.campaign,
  nodes: [
    ...SCRIPT.campaign.nodes.map(n => (n.id === 'n-den' ? { ...n, next: [{ to: 'n-free' }] } : n)),
    { id: 'n-free', kind: 'loot', title: 'Goblin purse', ord: 10, payload: { items: [], currency: { gp: 30, sp: 5 }, assign: 'free' }, next: [{ to: 'n-dm' }] },
    { id: 'n-dm', kind: 'loot', title: 'The chief\'s chest', ord: 11, payload: { items: [], currency: { gp: 20 }, assign: 'dm' }, next: [] }
  ]
};

/** Pat on the cleric (slot-1), the fighter (slot-2) an AI seat; the run started. */
async function table(campaign) {
  const { db } = await tempDb(root);
  const ctx = makeRunRoom(db, { players: ['Pat'], seats: [{ seat: 1, fixture: 'cleric-l5', player: 0 }, { seat: 2, fixture: 'fighter-l5' }] });
  const r = ctx.open();
  const pat = ctx.players[0].id;
  r.connect(ctx.dmId, 'dm');
  r.connect(pat, 'player', 'Pat');
  r.room.run.start({ campaign, runId: RUN_ID, seed: SCRIPT.seed, xp: {} });
  return { r, send: (t, p) => r.send(pat, t, p) };
}

/** The S21 smoke's projection: what the snapshot and the replay can both produce. */
const projection = (rows) => Object.fromEntries(rows.map(r => [r.slotId, { state: r.state, xp: r.xp, level: r.level, lifeStatus: r.lifeStatus }]));
const stored = (r) => projection(['slot-1', 'slot-2'].map(id => ({ slotId: id, ...r.runStore.getCharacter(id) })));
const replayed = (r) => projection(Object.entries(replayRunEvents(runLog(r.runStore, RUN_ID))).map(([slotId, x]) => ({ slotId, ...x })));

test('T24: replayRunEvents applies currency.changed — stash.take and dm.stash.split purses match the controller', async () => {
  const t = await table(LOOT_CAMPAIGN);
  ok(await t.r.dm('dm.run.advance', { toNodeId: 'n-free', override: true }));
  ok(await t.send('stash.take', { slotId: 'slot-1', amount: { gp: 10, sp: 5 } }));
  ok(await t.r.dm('dm.run.advance', { toNodeId: 'n-dm', override: true }));
  ok(await t.r.dm('dm.stash.split', { allocations: [{ slotId: 'slot-1', gp: 12 }, { slotId: 'slot-2', gp: 8 }] }));
  const log = runLog(t.r.runStore, RUN_ID);
  assert.equal(log.filter(e => e.type === 'currency.changed').length, 3, 'one take + two split moves');
  const want = stored(t.r);
  assert.ok(want['slot-1'].state.currency.gp >= 22 && want['slot-2'].state.currency.gp >= 8, 'the coin reached the purses');
  assert.deepStrictEqual(replayed(t.r), want, 'the replay of the log is the controller\'s characters');
});

test('T24: replayRunEvents applies heal.cast — the target\'s HP and the caster\'s spent slot match the controller', async () => {
  const t = await table(SCRIPT.campaign);
  ok(await t.r.dm('dm.node.begin', {}));
  ok(await t.r.dm('dm.encounter.start', {}));
  await t.r.settle();
  ok(await t.r.dm('dm.run.advance', { toNodeId: 'n-camp', override: true }));
  ok(await t.send('cast.downtime', { casterSlotId: 'slot-1', spellId: 'cure-wounds', targetSlotId: 'slot-2', slotLevel: 1 }));
  ok(await t.r.dm('cast.downtime', { casterSlotId: 'slot-1', spellId: 'healing-word', targetSlotIds: ['slot-1'], slotLevel: 2 }));
  const log = runLog(t.r.runStore, RUN_ID);
  assert.equal(log.filter(e => e.type === 'heal.cast').length, 2);
  const want = stored(t.r);
  assert.ok((want['slot-1'].state.slots.spell['1']?.spent ?? 0) >= 1 && (want['slot-1'].state.slots.spell['2']?.spent ?? 0) >= 1, 'both slots spent');
  assert.deepStrictEqual(replayed(t.r), want, 'the replay of the log is the controller\'s characters');
});
