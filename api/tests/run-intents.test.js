// M65 B25 — between-node intents: one role test per intent (the seat's
// controller, another player, the DM), the campaign rule codes on the
// wire, and one run_events row with {before, after} per mutation.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, tempDb } from './helpers/server.js';
import { makeRunRoom, runLog } from './helpers/runs.js';
import { loadRunScript } from '../../src/tests/helpers/run-driver.js';
import { validateRunEventLog, isMutatingRunEvent } from '../../src/js/shared/run-events.js';
import { INTENT_ROLES } from '../../src/js/shared/protocol.js';
import { RUN_INTENTS } from '../runs/run-controller.js';

const { root, cleanup } = tempRoot('cf-run-intents-');
after(cleanup);

const BASE = loadRunScript('fight-rest-fight').campaign;
const ambush = BASE.nodes.find(n => n.id === 'n-ambush');
const den = BASE.nodes.find(n => n.id === 'n-den');
const CAMPAIGN = {
  v: 1, id: 'camp-b25', name: 'Between nodes', ruleset: 'srd-5.1', settings: { xpMode: 'xp', deathMode: 'standard', levelUpMode: 'choose' },
  nodes: [
    { ...ambush, next: [{ to: 'n-loot' }] },
    { id: 'n-loot', kind: 'loot', title: 'The goblins\' hoard', ord: 1, payload: { items: [{ origin: 'dm', name: 'Potion of Healing', qty: 2 }, { origin: 'dm', name: 'Rope', qty: 1 }], currency: { gp: 30 }, assign: 'free' }, next: [{ to: 'n-shop' }] },
    { id: 'n-shop', kind: 'shop', title: 'Pedlar', ord: 2, payload: { stock: [{ ref: 'srd_potion-of-healing', qty: 3 }, { ref: 'srd_lantern', qty: 1 }] }, next: [{ to: 'n-story' }] },
    {
      id: 'n-story', kind: 'story', title: 'The fork', ord: 3, payload: { text: 'Two roads.', choices: [{ id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }] },
      next: [{ to: 'n-camp', when: { choice: 'left' } }, { to: 'n-den', when: { choice: 'right' } }]
    },
    { id: 'n-camp', kind: 'rest', title: 'Camp', ord: 4, payload: { type: 'long' }, next: [{ to: 'n-den' }] },
    { ...den, ord: 5 }
  ]
};

const POTION = { key: 'srd_potion-of-healing', name: 'Potion of Healing', cost: '50.00', category: { key: 'potion' }, document: { key: 'srd-2014' } };

async function runRoom() {
  const { db } = await tempDb(root);
  db.db.prepare(`INSERT INTO items_cache (key, document_key, kind, name, payload_json, fetched_at) VALUES (?, 'srd-2014', 'magicitem', ?, ?, 1)`)
    .run(POTION.key, POTION.name, JSON.stringify(POTION));
  db.db.prepare(`INSERT INTO items_cache (key, document_key, kind, name, payload_json, fetched_at) VALUES ('srd_command', 'srd-2014', 'spell', 'Command', ?, 1)`)
    .run(JSON.stringify({ key: 'srd_command', name: 'Command', level: 1, school: { name: 'Enchantment' } }));
  const ctx = makeRunRoom(db, { players: ['Pat', 'Sam'], seats: [{ seat: 1, fixture: 'cleric-l5', player: 0 }, { seat: 2, fixture: 'fighter-l5' }] });
  const r = ctx.open();
  r.room.run.start({ campaign: CAMPAIGN, runId: 'run-b25', seed: 11 });
  const pat = ctx.players[0].id;
  const sam = ctx.players[1].id;
  const as = (who) => (t, p) => r.send(who, t, p);
  return { db, ctx, r, pat: as(pat), sam: as(sam), dm: r.dm, patId: pat, samId: sam };
}

const ok = (reply) => { assert.equal(reply?.t, 'ack', JSON.stringify(reply?.p)); return reply.p; };
const refused = (reply, code) => { assert.equal(reply?.t, 'error', JSON.stringify(reply?.p)); assert.equal(reply.p.code, code, reply.p.message); };
const char = (r, slotId) => r.runStore.getCharacter(slotId);
const items = (r, owner) => r.runStore.listItems('run-b25').filter(i => (owner === undefined ? true : i.ownerSlotId === owner));
const lastEvent = (r) => runLog(r.runStore, 'run-b25').at(-1);

/** Reach a node by DM override (skipping the encounter). */
async function goto(t, nodeId) {
  ok(await t.dm('dm.run.advance', { toNodeId: nodeId, override: true }));
}

test('B25: every run intent is handled by the controller, and protocol roles are what the room enforces', () => {
  for (const t of RUN_INTENTS) assert.ok(INTENT_ROLES[t], `${t} is a protocol intent`);
  for (const t of RUN_INTENTS.filter(x => x.startsWith('dm.'))) assert.equal(INTENT_ROLES[t], 'dm');
});

test('B25: players cannot send DM run intents (E_FORBIDDEN), the DM cannot send player-only ones', async () => {
  const t = await runRoom();
  const samples = {
    'dm.run.advance': { toNodeId: 'n-loot' }, 'dm.run.end': { outcome: 'abandoned' }, 'dm.node.begin': {}, 'dm.rest.grant': { type: 'short' },
    'dm.loot.assign': { itemId: 'x', toSlotId: null }, 'dm.story.resolve': { nodeId: 'n-story', choiceId: 'left' },
    'dm.xp.adjust': { slotId: 'slot-1', delta: 10 }, 'dm.levelup.confirm': { levelUpId: 'lu-1' }, 'dm.levelup.revert': { levelUpId: 'lu-1' },
    'dm.character.revive': { slotId: 'slot-1', method: 'dm' }, 'dm.character.retire': { slotId: 'slot-2' },
    'dm.seat.fill': { seat: 3, characterId: '1', controller: 'ai' }, 'dm.snapshot.save': {}, 'dm.snapshot.load': { snapshotId: 'x' },
    'dm.seat.reclaim.approve': { slotId: 'slot-1', memberId: 'p', approve: true }
  };
  for (const [type, p] of Object.entries(samples)) refused(await t.pat(type, p), 'E_FORBIDDEN');
  refused(await t.dm('story.choose', { nodeId: 'n-story', choiceId: 'left' }), 'E_FORBIDDEN');
  refused(await t.dm('seat.reclaim', { slotId: 'slot-1' }), 'E_FORBIDDEN');
});

test('B25: rest.spend + dm.rest.grant — only the seat\'s controller declares; rule codes come back as error codes', async () => {
  const t = await runRoom();
  await goto(t, 'n-camp');
  refused(await t.sam('rest.spend', { slotId: 'slot-1', hitDice: { Cleric: 1 } }), 'E_FORBIDDEN');
  refused(await t.dm('rest.spend', { slotId: 'slot-1', hitDice: { Cleric: 1 } }), 'E_FORBIDDEN');
  refused(await t.pat('rest.spend', { slotId: 'slot-1', hitDice: { Cleric: 9 } }), 'hit-dice-overspent');
  ok(await t.pat('rest.spend', { slotId: 'slot-1', hitDice: { Cleric: 1 } }));
  ok(await t.dm('rest.spend', { slotId: 'slot-2', hitDice: { Fighter: 1 } }), 'the DM declares for an AI seat');
  refused(await t.pat('dm.rest.grant', { type: 'long' }), 'E_FORBIDDEN');
  ok(await t.dm('dm.rest.grant', { type: 'long' }));
  const log = runLog(t.r.runStore, 'run-b25');
  const rest = log.find(e => e.type === 'rest.taken');
  assert.deepEqual([rest.payload.type, rest.payload.slotIds, rest.actorKind], ['long', ['slot-1', 'slot-2'], 'system']);
  assert.equal(log.at(-1).type, 'node.completed');
});

test('B25: loot.claim / dm.loot.assign — a loot node fills the stash; players claim, the DM assigns', async () => {
  const t = await runRoom();
  await goto(t, 'n-loot');
  const granted = runLog(t.r.runStore, 'run-b25').find(e => e.type === 'loot.granted');
  assert.deepEqual(granted.payload.items.map(i => [i.name, i.qty]), [['Potion of Healing', 2], ['Rope', 1]]);
  assert.equal(t.r.runStore.getRun('run-b25').stash.currency.gp, 30);
  const potion = items(t.r, null).find(i => i.name === 'Potion of Healing');
  refused(await t.sam('loot.claim', { slotId: 'slot-1', itemId: potion.id }), 'E_FORBIDDEN');
  const claimed = ok(await t.pat('loot.claim', { slotId: 'slot-1', itemId: potion.id, qty: 1 }));
  assert.equal(items(t.r, 'slot-1').find(i => i.id === claimed.itemId).qty, 1);
  assert.equal(t.r.runStore.getItem('run-b25', potion.id).qty, 1, 'a partial claim splits the stack');
  const ev = lastEvent(t.r);
  assert.deepEqual([ev.type, ev.actorKind, ev.actorId, ev.payload.toSlotId, ev.payload.qty], ['item.moved', 'player', t.patId, 'slot-1', 1]);
  refused(await t.pat('dm.loot.assign', { itemId: potion.id, toSlotId: 'slot-2' }), 'E_FORBIDDEN');
  ok(await t.dm('dm.loot.assign', { itemId: potion.id, toSlotId: 'slot-2' }));
  assert.equal(t.r.runStore.getItem('run-b25', potion.id).ownerSlotId, 'slot-2');
});

test('B25: item.equip / item.give / item.use — the owner only; equipment rewrites the run sheet; a potion heals', async () => {
  const t = await runRoom();
  const shield = items(t.r, 'slot-1').find(i => i.name === 'Shield');
  assert.ok(shield.equipped);
  refused(await t.sam('item.equip', { slotId: 'slot-1', itemId: shield.id, equipped: false }), 'E_FORBIDDEN');
  ok(await t.pat('item.equip', { slotId: 'slot-1', itemId: shield.id, equipped: false }));
  assert.equal(t.r.runStore.getItem('run-b25', shield.id).equipped, false);
  assert.equal(char(t.r, 'slot-1').sheet.equipment.offhand, null);
  ok(await t.pat('item.equip', { slotId: 'slot-1', itemId: shield.id, equipped: true }));
  assert.equal(char(t.r, 'slot-1').sheet.equipment.offhand?.name, 'Shield');

  const potion = items(t.r, 'slot-2').find(i => /Potion/.test(i.name));
  refused(await t.pat('item.give', { slotId: 'slot-2', itemId: potion.id, toSlotId: 'slot-1' }), 'E_FORBIDDEN');
  ok(await t.dm('item.give', { slotId: 'slot-2', itemId: potion.id, toSlotId: 'slot-1', qty: 1 }));
  const mine = items(t.r, 'slot-1').find(i => /Potion/.test(i.name));
  // Hurt the cleric, then drink.
  const c = char(t.r, 'slot-1');
  t.r.runStore.updateCharacter('run-b25', 'slot-1', c.version, { state: { ...c.state, hp: { current: 5, temp: 0 } } });
  refused(await t.sam('item.use', { slotId: 'slot-1', itemId: mine.id }), 'E_FORBIDDEN');
  const used = ok(await t.pat('item.use', { slotId: 'slot-1', itemId: mine.id }));
  assert.ok(used.healed >= 4 && used.healed <= 10, `healed ${used.healed}`);
  assert.equal(char(t.r, 'slot-1').state.hp.current, 5 + used.healed);
  assert.ok(!t.r.runStore.getItem('run-b25', mine.id), 'the last potion is gone');
  const ev = lastEvent(t.r);
  assert.equal(ev.type, 'item.used');
  assert.equal(ev.payload.before.state.hp.current, 5);
});

test('B25: shop.buy / shop.sell — stock, prices, the purse and the stash', async () => {
  const t = await runRoom();
  refused(await t.pat('shop.buy', { slotId: 'slot-1', refKey: 'srd_potion-of-healing', qty: 1 }), 'E_INVALID_INTENT');   // no shop here
  await goto(t, 'n-shop');
  refused(await t.sam('shop.buy', { slotId: 'slot-1', refKey: 'srd_potion-of-healing', qty: 1 }), 'E_FORBIDDEN');
  refused(await t.pat('shop.buy', { slotId: 'slot-1', refKey: 'srd_lantern', qty: 1 }), 'E_INVALID_INTENT');   // unpriced
  refused(await t.pat('shop.buy', { slotId: 'slot-1', refKey: 'srd_potion-of-healing', qty: 4 }), 'E_INVALID_INTENT');   // stock 3
  const gpBefore = char(t.r, 'slot-1').state.currency.gp;
  const bought = ok(await t.pat('shop.buy', { slotId: 'slot-1', refKey: 'srd_potion-of-healing', qty: 2 }));
  assert.equal(bought.costCp, 10000);
  assert.equal(char(t.r, 'slot-1').state.currency.gp, gpBefore - 100);
  refused(await t.pat('shop.buy', { slotId: 'slot-1', refKey: 'srd_potion-of-healing', qty: 2 }), 'E_INVALID_INTENT');   // 1 left
  refused(await t.sam('shop.sell', { slotId: 'slot-1', itemId: bought.itemId, qty: 1 }), 'E_FORBIDDEN');
  const sold = ok(await t.pat('shop.sell', { slotId: 'slot-1', itemId: bought.itemId, qty: 1 }));
  assert.equal(sold.gainedCp, 2500, 'sold back at half');
  assert.equal(t.r.runStore.getItem('run-b25', bought.itemId).qty, 1);
  assert.deepEqual(lastEvent(t.r).payload.price, { gp: 25 });
});

test('B25: story.choose (players) / dm.story.resolve (DM) pick the edge', async () => {
  const t = await runRoom();
  await goto(t, 'n-story');
  refused(await t.pat('story.choose', { nodeId: 'n-shop', choiceId: 'left' }), 'E_STALE');
  ok(await t.pat('story.choose', { nodeId: 'n-story', choiceId: 'right' }));
  refused(await t.dm('dm.run.advance', { toNodeId: 'n-camp' }), 'E_INVALID_INTENT');
  ok(await t.dm('dm.story.resolve', { nodeId: 'n-story', choiceId: 'left' }));
  const ev = lastEvent(t.r);
  assert.deepEqual([ev.type, ev.actorKind, ev.payload.choiceId], ['story.chosen', 'dm', 'left']);
  ok(await t.dm('dm.run.advance', { toNodeId: 'n-camp' }));
});

test('B25: dm.xp.adjust queues a level; levelup.choose (owner) → dm.levelup.confirm → dm.levelup.revert', async () => {
  const t = await runRoom();
  const frames = t.r.connect(t.patId, 'player', 'Pat');
  refused(await t.pat('dm.xp.adjust', { slotId: 'slot-1', delta: 7500 }), 'E_FORBIDDEN');
  ok(await t.dm('dm.xp.adjust', { slotId: 'slot-1', delta: 7500, reason: 'milestone' }));
  const log = runLog(t.r.runStore, 'run-b25');
  assert.deepEqual(log.slice(-2).map(e => e.type), ['dm.override', 'level.queued']);
  assert.equal(log.at(-1).payload.levelUpId, 'lu-1');
  const offer = frames.filter(f => f.t === 'levelup.offer').at(-1);
  assert.deepEqual([offer.p.levelUpId, offer.p.fromLevel, offer.p.toLevel, offer.p.status], ['lu-1', 5, 6, 'pending_player']);
  refused(await t.sam('levelup.choose', { slotId: 'slot-1', levelUpId: 'lu-1', choices: {} }), 'E_FORBIDDEN');
  refused(await t.pat('levelup.choose', { slotId: 'slot-1', levelUpId: 'lu-1', choices: { asi: { STR: 2 } } }), 'asi-not-offered');
  ok(await t.pat('levelup.choose', { slotId: 'slot-1', levelUpId: 'lu-1', choices: { spells: ['Command'] } }));
  refused(await t.pat('dm.levelup.confirm', { levelUpId: 'lu-1' }), 'E_FORBIDDEN');
  const hpBefore = char(t.r, 'slot-1').sheet.hp.max;
  ok(await t.dm('dm.levelup.confirm', { levelUpId: 'lu-1' }));
  const c = char(t.r, 'slot-1');
  assert.equal(c.level, 6);
  assert.ok(c.sheet.hp.max > hpBefore);
  assert.ok(c.sheet.spells.some(s => s.name === 'Command'));
  assert.equal(lastEvent(t.r).type, 'level.applied');
  ok(await t.dm('dm.levelup.revert', { levelUpId: 'lu-1' }));
  assert.equal(char(t.r, 'slot-1').level, 5);
  assert.equal(char(t.r, 'slot-1').sheet.hp.max, hpBefore);
  assert.equal(lastEvent(t.r).type, 'level.reverted');
});

test('B25: levelup.reconcile (owner) diffs the latest D&D Beyond import; the DM confirms', async () => {
  const t = await runRoom();
  const row = t.ctx.seated[0].characterRowId;
  const fresh = JSON.parse(t.db.db.prepare('SELECT parsed_json FROM characters WHERE id = ?').get(row).parsed_json);
  fresh.feats = [...(fresh.feats || []), 'Alert'];
  t.db.db.prepare('UPDATE characters SET parsed_json = ? WHERE id = ?').run(JSON.stringify(fresh), row);
  refused(await t.sam('levelup.reconcile', { slotId: 'slot-1' }), 'E_FORBIDDEN');
  const q = ok(await t.pat('levelup.reconcile', { slotId: 'slot-1' }));
  assert.ok(q.proposals >= 1);
  ok(await t.dm('dm.levelup.confirm', { levelUpId: q.levelUpId }));
  assert.ok(char(t.r, 'slot-1').sheet.feats.includes('Alert'));
  // A DDB sheet ahead of the granted level is refused with the rule's code.
  fresh.level = 9;
  fresh.classes = fresh.classes.map(c => ({ ...c, level: 9 }));
  t.db.db.prepare('UPDATE characters SET parsed_json = ? WHERE id = ?').run(JSON.stringify(fresh), row);
  refused(await t.pat('levelup.reconcile', { slotId: 'slot-1' }), 'ddb-level-ahead');
});

test('B25: dm.character.revive / dm.character.retire / dm.seat.fill (archive before the seat is reused)', async () => {
  const t = await runRoom();
  const c2 = char(t.r, 'slot-2');
  t.r.runStore.updateCharacter('run-b25', 'slot-2', c2.version, { state: { ...c2.state, hp: { current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 3, stable: false } }, lifeStatus: 'dead' });
  refused(await t.dm('dm.character.revive', { slotId: 'slot-2', method: 'revivify', casterSlotId: 'slot-1' }), 'no-spell');
  ok(await t.dm('dm.character.revive', { slotId: 'slot-2', method: 'dm' }));
  assert.equal(char(t.r, 'slot-2').lifeStatus, 'active');
  const rev = lastEvent(t.r);
  assert.deepEqual([rev.type, rev.override, rev.payload.before.lifeStatus], ['character.revived', true, 'dead']);

  ok(await t.dm('dm.character.retire', { slotId: 'slot-2', reason: 'went home' }));
  const archived = t.r.runStore.listArchived('run-b25');
  assert.deepEqual(archived.map(a => [a.slotId, a.reason, a.level]), [['slot-2', 'went home', 5]]);
  assert.ok(!t.r.runStore.getCharacter('slot-2'));
  assert.ok(items(t.r, null).some(i => i.name === 'Longsword'), 'the retired character\'s gear went to the stash');

  // Fill seat 1 (Pat's cleric) with the fighter for Sam: the cleric is archived first.
  const fighter = String(t.ctx.seated[1].sheet.id);
  ok(await t.dm('dm.seat.fill', { seat: 1, characterId: fighter, controller: 'player', memberId: t.samId }));
  const arch = t.r.runStore.listArchived('run-b25');
  assert.equal(arch.length, 2);
  assert.equal(arch[1].reason, 'replaced');
  assert.equal(arch[1].sheet.name, t.ctx.seated[0].sheet.name, 'the archive holds the old sheet, copied before upsertSeat nulled it');
  const seat1 = char(t.r, 'slot-1');
  assert.equal(seat1.sheet.name, t.ctx.seated[1].sheet.name);
  const log = runLog(t.r.runStore, 'run-b25');
  assert.deepEqual(log.slice(-2).map(e => e.type), ['seat.filled', 'character.joined']);
  refused(await t.pat('rest.spend', { slotId: 'slot-1', hitDice: { Fighter: 1 } }), 'E_FORBIDDEN');
  ok(await t.sam('rest.spend', { slotId: 'slot-1', hitDice: { Fighter: 1 } }));
});

test('B25: every mutation is one run_events row with {before, after}; the log validates', async () => {
  const t = await runRoom();
  await goto(t, 'n-loot');
  const potion = items(t.r, null).find(i => /Potion/.test(i.name));
  ok(await t.pat('loot.claim', { slotId: 'slot-1', itemId: potion.id }));
  await goto(t, 'n-shop');
  ok(await t.pat('shop.buy', { slotId: 'slot-1', refKey: 'srd_potion-of-healing', qty: 1 }));
  ok(await t.dm('dm.xp.adjust', { slotId: 'slot-2', delta: 100 }));
  const log = runLog(t.r.runStore, 'run-b25');
  assert.deepEqual(validateRunEventLog(log).errors, []);
  for (const ev of log) if (isMutatingRunEvent(ev.type)) assert.ok('before' in ev.payload && 'after' in ev.payload, ev.type);
  assert.deepEqual(log.slice(-2).map(e => e.type), ['shop.bought', 'dm.override']);
  assert.ok(log.some(e => e.type === 'item.moved' && e.actorKind === 'player'));
});
