// M65 phase 2 Wave 4 (E3) — the server gaps the Wave 3 client and smokes
// found: one levelup.offer per change, the resumed turn re-announced,
// level-up picks and rest declarations in the run log (and persisted),
// the run hash on the wire plus the events / snapshots routes, the stash
// split, auto level-ups and confirmed XP, reconcile safety, and downtime
// healing spells.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, tempDb } from './helpers/server.js';
import { makeRunRoom, runLog } from './helpers/runs.js';
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

test('W4-3: levelup.choose writes one level.chosen run event ({status, choices} before / after) by the player', async () => {
  const t = await table({ xp: {} });
  ok(await t.r.dm('dm.xp.adjust', { slotId: 'slot-1', delta: 20000 }));
  const lu = t.r.runStore.listLevelUps('run-w4').find(l => l.slotId === 'slot-1');
  const levelUpId = lu.id.split('.').at(-1);
  ok(await t.send('levelup.choose', { slotId: 'slot-1', levelUpId, choices: {} }));
  const ev = runLog(t.r.runStore, 'run-w4').at(-1);
  assert.deepEqual([ev.type, ev.actorKind, ev.actorId], ['level.chosen', 'player', t.pat]);
  assert.deepEqual(ev.payload, {
    levelUpId, slotId: 'slot-1', fromLevel: 5, toLevel: 6, choices: {},
    before: { status: 'pending_player', choices: null }, after: { status: 'pending_dm', choices: {} }
  });
  assert.ok(t.patFrames.some(f => f.t === 'run.event' && f.p.type === 'level.chosen'), 'broadcast as a run.event');
  assert.equal(t.r.runStore.getLevelUp('run-w4', lu.id).status, 'pending_dm');
});

test('W4-3: rest.spend writes rest.declared and persists in runs.pending_json; a restart keeps it, and the grant spends it', async () => {
  const t = await table();
  ok(await t.r.dm('dm.run.advance', { toNodeId: 'n-camp', override: true }));
  ok(await t.send('rest.spend', { slotId: 'slot-1', hitDice: { Cleric: 2 } }));
  ok(await t.r.dm('rest.spend', { slotId: 'slot-2', hitDice: { Fighter: 1 } }));
  const log = runLog(t.r.runStore, 'run-w4');
  assert.deepEqual(log.slice(-2).map(e => [e.type, e.actorKind, e.payload.slotId, e.payload.hitDice, 'before' in e.payload]), [
    ['rest.declared', 'player', 'slot-1', { Cleric: 2 }, false],
    ['rest.declared', 'dm', 'slot-2', { Fighter: 1 }, false]
  ]);
  const declared = { 'slot-1': { Cleric: 2 }, 'slot-2': { Fighter: 1 } };
  assert.deepEqual(t.r.runStore.getRun('run-w4').pending, { rest: declared });
  assert.deepEqual(t.patFrames.filter(f => f.t === 'run.updated').at(-1).p.pendingRest, declared);

  t.r.room.shutdown();
  const r2 = t.ctx.open();
  assert.deepEqual(r2.room.run.snapshotFor({ role: 'dm', id: t.ctx.dmId }).pendingRest, declared, 'the declarations survive the restart');
  ok(await r2.dm('dm.rest.grant', { type: 'short' }));
  const rest = runLog(r2.runStore, 'run-w4').find(e => e.type === 'rest.taken');
  assert.deepEqual([rest.payload.rolls['slot-1'].length, rest.payload.rolls['slot-2'].length], [2, 1], 'the declared dice were rolled');
  assert.deepEqual(r2.runStore.getRun('run-w4').pending, { rest: {} }, 'spent declarations are cleared');
});

test('W4-3: migration 0007 adds runs.pending_json (default {}, JSON-checked)', async () => {
  const { db } = await tempDb(root);
  const col = db.db.prepare("SELECT * FROM pragma_table_info('runs') WHERE name = 'pending_json'").get();
  assert.deepEqual([col.type, col.notnull, col.dflt_value], ['TEXT', 1, "'{}'"]);
  makeRunRoom(db).open().room.run.start({ campaign: SCRIPT.campaign, runId: 'run-m7', seed: 1 });
  assert.equal(db.db.prepare('SELECT pending_json FROM runs WHERE id = ?').get('run-m7').pending_json, '{}');
  assert.throws(() => db.db.prepare('UPDATE runs SET pending_json = ? WHERE id = ?').run('{nope', 'run-m7'), /CHECK/);
});

/** The script's campaign plus a free loot node and a DM-assigned one. */
const LOOT_CAMPAIGN = {
  ...SCRIPT.campaign,
  nodes: [
    ...SCRIPT.campaign.nodes.map(n => (n.id === 'n-den' ? { ...n, next: [{ to: 'n-free' }] } : n)),
    { id: 'n-free', kind: 'loot', title: 'Goblin purse', ord: 10, payload: { items: [], currency: { gp: 30, sp: 5 }, assign: 'free' }, next: [{ to: 'n-dm' }] },
    { id: 'n-dm', kind: 'loot', title: 'The chief\'s chest', ord: 11, payload: { items: [], currency: { gp: 20 }, assign: 'dm' }, next: [] }
  ]
};
const purse = (r, slotId) => r.runStore.getCharacter(slotId).state.currency;
const stashCoin = (r) => r.runStore.getRun('run-w4').stash.currency;
const refused = (reply, code) => { assert.equal(reply?.t, 'error', JSON.stringify(reply?.p)); assert.equal(reply.p.code, code, reply.p.message); };

test('W4-5: dm.stash.split hands the stash\'s coin to seats, one currency.changed each with {currency, stash} before / after', async () => {
  const t = await table({ campaign: LOOT_CAMPAIGN });
  ok(await t.r.dm('dm.run.advance', { toNodeId: 'n-dm', override: true }));
  assert.equal(stashCoin(t.r).gp, 20);
  const gp1 = purse(t.r, 'slot-1').gp;
  const gp2 = purse(t.r, 'slot-2').gp;
  refused(await t.send('dm.stash.split', { allocations: [{ slotId: 'slot-1', gp: 20 }] }), 'E_FORBIDDEN');
  refused(await t.r.dm('dm.stash.split', { allocations: [{ slotId: 'slot-1', gp: 15 }, { slotId: 'slot-2', gp: 15 }] }), 'insufficient-funds');
  refused(await t.r.dm('dm.stash.split', { allocations: [{ slotId: 'slot-1' }] }), 'E_INVALID_INTENT');
  const at = runLog(t.r.runStore, 'run-w4').length;
  ok(await t.r.dm('dm.stash.split', { allocations: [{ slotId: 'slot-1', gp: 12 }, { slotId: 'slot-2', gp: 8 }] }));
  assert.deepEqual([purse(t.r, 'slot-1').gp, purse(t.r, 'slot-2').gp, stashCoin(t.r).gp], [gp1 + 12, gp2 + 8, 0]);
  const evs = runLog(t.r.runStore, 'run-w4').slice(at);
  assert.deepEqual(evs.map(e => [e.type, e.actorKind, e.payload.slotId, e.payload.delta, e.payload.reason]), [
    ['currency.changed', 'dm', 'slot-1', { gp: 12 }, 'stash.split'],
    ['currency.changed', 'dm', 'slot-2', { gp: 8 }, 'stash.split']
  ]);
  assert.deepEqual([evs[0].payload.before.stash.gp, evs[0].payload.after.stash.gp, evs[1].payload.before.stash.gp, evs[1].payload.after.stash.gp], [20, 8, 8, 0]);
  assert.deepEqual([evs[0].payload.before.currency.gp, evs[0].payload.after.currency.gp], [gp1, gp1 + 12]);
  refused(await t.send('stash.take', { slotId: 'slot-1', amount: { gp: 1 } }), 'E_FORBIDDEN');
});

test('W4-5: stash.take — the seat\'s controller takes coin on a free loot node; never another seat, never more than is there', async () => {
  const t = await table({ campaign: LOOT_CAMPAIGN });
  ok(await t.r.dm('dm.run.advance', { toNodeId: 'n-free', override: true }));
  const sp = purse(t.r, 'slot-1').sp;
  refused(await t.send('stash.take', { slotId: 'slot-2', amount: { gp: 5 } }), 'E_FORBIDDEN');
  refused(await t.send('stash.take', { slotId: 'slot-1', amount: { pp: 1 } }), 'insufficient-funds');
  const taken = ok(await t.send('stash.take', { slotId: 'slot-1', amount: { gp: 10, sp: 5 } }));
  assert.equal(taken.currency.sp, sp + 5);
  assert.deepEqual([stashCoin(t.r).gp, stashCoin(t.r).sp], [20, 0]);
  const ev = runLog(t.r.runStore, 'run-w4').at(-1);
  assert.deepEqual([ev.type, ev.actorKind, ev.actorId, ev.payload.delta, ev.payload.reason], ['currency.changed', 'player', t.pat, { gp: 10, sp: 5 }, 'stash.take']);
  assert.ok(t.patFrames.some(f => f.t === 'run.event' && f.p.type === 'currency.changed'));
  ok(await t.r.dm('stash.take', { slotId: 'slot-2', amount: { gp: 20 } }), 'the DM takes for an AI seat');
  assert.equal(stashCoin(t.r).gp, 0);
});
