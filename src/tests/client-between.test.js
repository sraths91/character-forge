/**
 * M65 C24 — the between-node hub (views/between.js) and the run-store
 * status fix (run.started is not node entry).
 *
 *   - pure previews: restPreview (applyRest at the lowest / middle /
 *     highest hit-die roll), equipPreview (items.js → acFor / deriveAttack),
 *     stashSplit, item kinds;
 *   - run store: run.started keeps the run in 'lobby'; node.entered sets
 *     'in-node' only for encounter nodes; encounter.result's {state,
 *     lifeStatus}; run.updated's pendingRest;
 *   - the hub against the REAL server in-process (helpers/run-table.js):
 *     claim / assign from the stash, unequip the Shield (the preview's AC),
 *     declare hit dice and take the DM's short rest inside the preview's
 *     range, drink a potion, then begin the encounter node — the GATE: the
 *     equip preview's AC is the AC entityFromSheet gives the next encounter.
 *   - v1.7 stash coin: the even split (coin by coin, remainder stays),
 *     `currency.changed` folding purses and the stash live, and on the
 *     real server a player's `stash.take` on a free loot node and the DM's
 *     `dm.stash.split` (pre-filled even split, edited) on a DM loot node.
 *   - v1.7 downtime healing: downtimeOptions / healPreview
 *     (castDowntimeHeal at the lowest / highest roll), `heal.cast` folded
 *     into HP and slots, and on the real server the cleric's Cure Wounds
 *     on the fighter landing inside the preview, then the DM's Healing
 *     Word for the player's seat labelled and logged as an override.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mount as mountBetween, restPreview, equipPreview, stashSplit, evenAllocations, checkAllocations, downtimeOptions, healPreview, isPotion, isEquippable, combatLine } from '../js/client/views/between.js';
import { createRunStore } from '../js/client/run-store.js';
import { refusalText, cpText, coinsText } from '../js/client/run-model.js';
import { itemsFromInventory } from '../js/campaign/items.js';
import { initialRunState } from '../js/shared/run-state.js';
import { parseCharacter } from '../../api/lib/ddb-parser.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { flush } from './helpers/client-fixtures.js';
import { bootRunTable, cleric4Raw, GOBLIN_SETUP, until } from './helpers/run-table.js';

const ROOT = mkdtempSync(join(tmpdir(), 'cf-c24-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('C24 pure: restPreview spans the hit-die rolls and refuses an overspend; long rest is exact', () => {
  const sheet = parseCharacter(cleric4Raw());
  const state = { ...initialRunState(sheet), hp: { current: 5, temp: 0 } };
  const con = sheet.abilityModifiers.CON;
  const pv = restPreview(sheet, state, 'short', { spend: { Cleric: 1 } });
  assert.equal(pv.ok, true);
  assert.deepEqual([pv.hp.before, pv.hp.low, pv.hp.mid, pv.hp.high], [5, 5 + Math.max(0, 1 + con), 5 + Math.max(0, 5 + con), 5 + Math.max(0, 8 + con)]);
  assert.equal(pv.hitDice.Cleric.available, 3, 'the declared die is shown as spent');
  const over = restPreview(sheet, state, 'short', { spend: { Cleric: 9 } });
  assert.equal(over.ok, false);
  assert.match(over.error, /Only 4 Cleric hit dice left \(asked for 9\)/);
  const long = restPreview(sheet, { ...state, slots: { ...state.slots, spell: { 1: { spent: 2 }, 2: { spent: 0 } } } }, 'long');
  assert.deepEqual([long.hp.low, long.hp.high, long.hp.max], [sheet.hp.max, sheet.hp.max, sheet.hp.max]);
  assert.ok(long.recovered.includes('level 1 slots'));
  assert.equal(restPreview(sheet, { ...state, hp: { current: 0, temp: 0 } }, 'long').error, 'A long rest needs at least 1 HP.');
  assert.equal(restPreview(null, state, 'short').ok, false);
});

test('C24 pure: equipPreview is items.js + acFor (Shield off: AC −2), stash split, item kinds', () => {
  const sheet = parseCharacter(cleric4Raw());
  const items = itemsFromInventory(sheet, { ownerSlotId: 's1' }).map((it, k) => ({ ...it, id: `i${k}` }));
  const shield = items.find(i => i.name === 'Shield');
  const mace = items.find(i => i.name === 'Mace');
  const off = equipPreview(sheet, items, shield.id, false);
  assert.equal(off.ok, true);
  assert.equal(off.after.ac, off.before.ac - 2);
  assert.equal(off.before.ac, combatLine(sheet).ac);
  assert.equal(off.after.attack.name, 'Mace');
  const noMace = equipPreview(sheet, items, mace.id, false);
  assert.equal(noMace.after.attack.name, 'Unarmed Strike');
  assert.equal(equipPreview(sheet, items, 'nope', true).ok, false);
  assert.equal(equipPreview(null, items, shield.id, true).ok, false);
  assert.ok(isEquippable(shield) && !isPotion(shield));
  assert.ok(isPotion({ name: 'Potion of Healing', data: {} }) && !isEquippable({ name: 'Rope', data: {} }));
  assert.deepEqual(stashSplit({ currency: { gp: 30 } }, [{ lifeStatus: 'active' }, { lifeStatus: 'active' }, { lifeStatus: 'dead' }]), { totalCp: 3000, ways: 2, eachCp: 1500 });
  assert.equal(cpText(1500), '15 gp');
  assert.equal(coinsText({ gp: 3, sp: 2 }), '3 gp 2 sp');
});

test('C24 refusals: codes read as sentences, details specialise them', () => {
  assert.equal(refusalText({ code: 'insufficient-funds', frame: { details: { costCp: 20000, haveCp: 3000 } } }),
    'Not enough coin: it costs 200 gp and you have 30 gp (the party stash cannot cover it either).');
  assert.equal(refusalText({ code: 'E_ENCOUNTER_LIVE', message: 'x' }), 'Wait until the encounter ends.');
  assert.equal(refusalText({ code: 'E_INVALID_INTENT', message: 'only 1 left' }), 'only 1 left');
  assert.equal(refusalText({ code: 'ddb-level-ahead', frame: { details: { ddbLevel: 9, grantedLevel: 5 } } }),
    'D&D Beyond is at level 9, ahead of the level the game has granted (5). Level up in the game first.');
  assert.equal(refusalText({ code: 'whatever', message: 'server says' }), 'server says');
});

let roomSeq = 500;
const ev = (seq, type, payload) => ({ v: 1, t: 'run.event', seq: ++roomSeq, ts: 1, p: { seq, type, nodeId: null, actorKind: 'system', actorId: null, override: false, payload } });
const snap = (p) => ({ v: 1, t: 'run.snapshot', ts: 1, p });

test('C24 run store: run.started is not node entry; node.entered status follows the node kind', () => {
  const rs = createRunStore();
  rs.apply(snap({ run: { id: 'r1', status: 'lobby', currentNodeId: null, seq: 0, stash: { currency: { gp: 4 } }, settings: { xpMode: 'xp' } }, nodes: [], edges: [], characters: [], items: [], levelUps: [], pendingRest: {} }));
  assert.equal(rs.apply(ev(1, 'run.started', { campaignId: 'c1', startNodeId: 'n1', seats: [] })), 'applied');
  assert.deepEqual([rs.getState().status, rs.getState().currentNodeId, rs.getState().visitedIds], ['lobby', null, []], 'the start node is not entered');
  assert.equal(rs.getState().campaignId, 'c1');
  assert.deepEqual(rs.getState().stash, { currency: { gp: 4 } });
  rs.apply(ev(2, 'node.entered', { nodeId: 'n1', kind: 'encounter', fromNodeId: null }));
  assert.deepEqual([rs.getState().status, rs.getState().currentNodeId], ['in-node', 'n1']);
  rs.apply(ev(3, 'node.completed', { nodeId: 'n1', kind: 'encounter' }));
  assert.deepEqual([rs.getState().status, rs.getState().completed], ['between', true]);
  rs.apply(ev(4, 'node.entered', { nodeId: 'n2', kind: 'rest', fromNodeId: 'n1' }));
  assert.deepEqual([rs.getState().status, rs.getState().completed], ['between', false]);
  rs.apply({ v: 1, t: 'run.updated', seq: ++roomSeq, ts: 1, p: { runId: 'r1', status: 'between', currentNodeId: 'n2', runSeq: 4, completed: false, pendingRest: { s1: { Cleric: 1 } } } });
  assert.deepEqual(rs.getState().pendingRest, { s1: { Cleric: 1 } });
});

test('C24 run store: encounter.result patches {state, lifeStatus}; rest.taken patches the state', () => {
  const rs = createRunStore();
  const st = (hp) => ({ schema_v: 1, hp: { current: hp, temp: 0 } });
  rs.apply(snap({ run: { id: 'r1', status: 'in-node', currentNodeId: 'n1', seq: 1 }, nodes: [], edges: [], characters: [{ slotId: 's1', seat: 1, level: 3, xp: 0, lifeStatus: 'active' }], items: [], levelUps: [] }));
  rs.apply(ev(2, 'encounter.result', { encounterId: 'e', outcome: 'party-victory', rounds: 2, before: {}, after: { s1: { state: st(3), lifeStatus: 'active' } } }));
  assert.deepEqual(rs.getState().characters[0].state, st(3));
  assert.deepEqual(rs.getState().result, { outcome: 'party-victory' });
  rs.apply(ev(3, 'rest.taken', { type: 'short', slotIds: ['s1'], rolls: {}, before: {}, after: { s1: st(9) } }));
  assert.deepEqual(rs.getState().characters[0].state, st(9));
});

test('C24 v1.7 stash coin: evenAllocations divides coin by coin; checkAllocations mirrors the server', () => {
  const chars = [{ slotId: 's2', seat: 2, lifeStatus: 'active' }, { slotId: 's1', seat: 1, lifeStatus: 'active' }, { slotId: 's3', seat: 3, lifeStatus: 'dead' }];
  assert.deepEqual(evenAllocations({ currency: { gp: 31, sp: 5, cp: 0 } }, chars), {
    allocations: [{ slotId: 's1', gp: 15, sp: 2 }, { slotId: 's2', gp: 15, sp: 2 }], left: { gp: 1, sp: 1 }
  });
  assert.deepEqual(evenAllocations({ currency: {} }, chars).allocations, [{ slotId: 's1' }, { slotId: 's2' }]);
  const stash = { currency: { gp: 20 } };
  assert.deepEqual(checkAllocations(stash, [{ slotId: 's1', gp: '12' }, { slotId: 's2', gp: 8, sp: 0 }]), { ok: true, allocations: [{ slotId: 's1', gp: 12 }, { slotId: 's2', gp: 8 }], left: {} });
  assert.equal(checkAllocations(stash, [{ slotId: 's1', gp: 15 }, { slotId: 's2', gp: 15 }]).error, 'The stash has only 20 gp.');
  assert.equal(checkAllocations(stash, [{ slotId: 's1', sp: 1 }]).error, 'The stash has only 0 sp.');
  assert.equal(checkAllocations(stash, [{ slotId: 's1' }]).error, 'Hand out some coin first.');
  assert.deepEqual(checkAllocations(stash, [{ slotId: 's1', gp: 5 }]).left, { gp: 15 });
});

test('C24 v1.7 run store: currency.changed sets the purse and the stash coin; loot.granted the stash', () => {
  const rs = createRunStore();
  rs.apply(snap({ run: { id: 'r1', status: 'between', currentNodeId: 'n1', seq: 1, stash: { currency: { gp: 20 } } }, nodes: [], edges: [], characters: [{ slotId: 's1', seat: 1, level: 3, xp: 0, lifeStatus: 'active' }], items: [], levelUps: [] }));
  assert.equal(rs.getState().synced, true);
  assert.equal(rs.apply(ev(2, 'currency.changed', { slotId: 's1', delta: { gp: 12 }, reason: 'stash.split', before: { currency: { gp: 3 }, stash: { gp: 20 } }, after: { currency: { gp: 15 }, stash: { gp: 8 } } })), 'applied');
  assert.deepEqual(rs.getState().characters[0].state, { currency: { gp: 15 } }, 'the purse');
  assert.deepEqual(rs.getState().stash, { currency: { gp: 8 } });
  rs.apply(ev(3, 'loot.granted', { items: [], currency: { sp: 5 }, before: { stash: { currency: { gp: 8 } } }, after: { stash: { currency: { gp: 8, sp: 5 } } } }));
  assert.deepEqual(rs.getState().stash, { currency: { gp: 8, sp: 5 } });
  rs.apply(ev(4, 'currency.changed', { slotId: 'nobody', delta: { gp: 1 }, reason: 'x', before: {}, after: { currency: { gp: 1 } } }));
  assert.deepEqual(rs.getState().characters[0].state.currency, { gp: 15 }, 'an unknown seat changes nothing');
});

// ------------------------------------------------------------ real server

const NODES = [
  { id: 'n-loot', kind: 'loot', title: 'The hoard', start: true, payload: { items: [{ origin: 'open5e', ref: 'srd_potion-of-healing', qty: 2 }, { origin: 'dm', name: 'Rope', qty: 1 }], currency: { gp: 30 }, assign: 'free' }, next: [{ to: 'n-camp' }] },
  { id: 'n-camp', kind: 'rest', title: 'Camp', payload: { type: 'short' }, next: [{ to: 'n-fight' }] },
  { id: 'n-fight', kind: 'encounter', title: 'Ambush', payload: { setup: GOBLIN_SETUP }, next: [] }
];

function hub(t, who) {
  const dom = createFakeDom();
  const root = dom.root();
  const un = mountBetween(root, t.ctx(who));
  const rowOf = (attr, id) => dom.findAll(root, n => n.dataset?.[attr] === id)[0];
  const act = (action, pred = () => true) => {
    const el = dom.byAction(root, action).find(pred);
    assert.ok(el, `${who}: button ${action}`);
    el.click();
  };
  const seatLine = (slotId) => dom.findAll(root, n => n.dataset?.field === 'seat-line' && n.dataset.slot === slotId)[0]?.textContent || '';
  const status = () => dom.findAll(root, n => /play-status/.test(n.className))[0].textContent;
  return { dom, root, un, rowOf, act, status, seatLine, text: () => root.textContent };
}

test('C24 hub on the real server: stash, equip preview = next encounter AC, short rest, potion', async () => {
  const t = await bootRunTable(ROOT, { nodes: NODES });
  try {
    const pr = () => t.sessions.player.runStore.getState();
    const dr = () => t.sessions.dm.runStore.getState();
    assert.deepEqual([pr().status, pr().currentNodeId], ['between', 'n-loot']);
    const cleric = pr().characters.find(c => c.seat === 1);
    const fighter = pr().characters.find(c => c.seat === 2);
    const P = hub(t, 'player');
    const D = hub(t, 'dm');
    await until(() => /AC \d+/.test(P.seatLine(cleric.slotId)), 'the player\'s seat card with its sheet');

    // Stash: 30 gp split two ways; the player claims one potion, the DM assigns the rope.
    assert.match(P.text(), /Coin: 30 gp — an even split is 15 gp each for 2/);
    const potion = pr().items.find(i => i.ownerSlotId === null && i.name === 'Potion of Healing');
    const rope = pr().items.find(i => i.ownerSlotId === null && i.name === 'Rope');
    assert.equal(D.dom.byAction(D.root, 'loot-claim').length, 0, 'the DM assigns, not claims');
    P.act('loot-claim', el => el.dataset.item === potion.id);
    await until(() => pr().items.some(i => i.ownerSlotId === cleric.slotId && i.name === 'Potion of Healing'), 'the claimed potion');
    const assignSel = D.dom.findAll(D.root, n => n.dataset?.field === 'assign-to' && n.dataset.key === rope.id)[0];
    assignSel.value = fighter.slotId;
    D.dom.fire(assignSel, 'change');
    D.act('loot-assign', el => el.dataset.item === rope.id);
    await until(() => dr().items.some(i => i.id === rope.id && i.ownerSlotId === fighter.slotId), 'the assigned rope');
    assert.equal(D.dom.byAction(D.root, 'item-equip').length > 0, true, 'the DM manages the AI fighter\'s gear');

    // Equip: the Shield's preview, then the intent.
    const shield = pr().items.find(i => i.ownerSlotId === cleric.slotId && i.name === 'Shield');
    await until(() => /AC \d+ → \d+/.test(P.rowOf('item', shield.id)?.textContent || ''), 'the shield preview');
    const [, acNow, acAfter] = /AC (\d+) → (\d+)/.exec(P.rowOf('item', shield.id).textContent).map(Number);
    assert.equal(acAfter, acNow - 2);
    const v0 = cleric.version;
    P.act('item-equip', el => el.dataset.item === shield.id);
    await until(() => pr().characters.find(c => c.slotId === cleric.slotId).version > v0 && new RegExp(`AC ${acAfter} ·`).test(P.seatLine(cleric.slotId)), 'the refetched run sheet');

    // Hurt the cleric (server side), then the DM takes the party to camp.
    const store = t.liveRoom().run.store;
    const c = store.getCharacter(cleric.slotId);
    store.updateCharacter(c.runId, cleric.slotId, c.version, { state: { ...c.state, hp: { current: 5, temp: 0 } } });
    D.act('run-advance', el => el.dataset.to === 'n-camp');
    await until(() => pr().currentNodeId === 'n-camp' && pr().characters.find(x => x.slotId === cleric.slotId).state.hp.current === 5, 'camp');

    // Short rest: pick one hit die, read the preview, declare, the DM grants.
    await until(() => P.dom.findAll(P.root, n => n.dataset?.field === 'hd')[0], 'the hit-dice picker');
    const hd = P.dom.findAll(P.root, n => n.dataset?.field === 'hd')[0];
    hd.value = '1';
    P.dom.fire(hd, 'change');
    await flush();
    const pvText = P.dom.findAll(P.root, n => n.dataset?.preview === 'rest-short')[0].textContent;
    const [, lo, hi] = /HP 5 → (\d+)–(\d+)/.exec(pvText).map(Number);
    P.act('rest-declare');
    await until(() => pr().pendingRest?.[cleric.slotId]?.Cleric === 1 && /declared: 1 Cleric/.test(P.text()), 'the declared die');
    assert.match(D.text(), /Declared: Fixture Cleric 1 Cleric/);
    assert.equal(P.dom.byAction(P.root, 'rest-grant').length, 0, 'players cannot grant');
    D.act('rest-grant', el => el.dataset.type === 'short');
    await until(() => pr().completed && pr().characters.find(x => x.slotId === cleric.slotId).state.hp.current > 5, 'the rest');
    const hpAfterRest = pr().characters.find(x => x.slotId === cleric.slotId).state.hp.current;
    assert.ok(hpAfterRest >= lo && hpAfterRest <= hi, `rested HP ${hpAfterRest} within the preview ${lo}–${hi}`);
    assert.equal(pr().characters.find(x => x.slotId === cleric.slotId).state.hitDice.Cleric.spent, 1, "the run started rested; one die spent");

    // A potion between nodes.
    const mine = pr().items.find(i => i.ownerSlotId === cleric.slotId && i.name === 'Potion of Healing');
    P.act('item-use', el => el.dataset.item === mine.id);
    await until(() => !pr().items.some(i => i.id === mine.id), 'the potion drunk');
    await until(() => /regains \d+ HP/.test(P.status()), 'the heal message');
    const healed = Number(/regains (\d+) HP/.exec(P.status())[1]);
    assert.equal(pr().characters.find(x => x.slotId === cleric.slotId).state.hp.current, Math.min(hpAfterRest + healed, cleric.state.hp.current));

    // A refusal reads as text: give the equipped mace away.
    // (the hub hides Give for equipped items; send the intent directly)
    const mace = pr().items.find(i => i.ownerSlotId === cleric.slotId && i.name === 'Mace');
    const err = await t.sessions.player.send({ t: 'item.give', p: { slotId: cleric.slotId, itemId: mace.id, toSlotId: null } }).catch(e => e);
    assert.equal(refusalText(err), 'unequip Mace first');

    // GATE: begin the encounter node; the cleric's entity AC is the preview's.
    D.act('run-advance', el => el.dataset.to === 'n-fight');
    await until(() => dr().status === 'in-node' && dr().currentNodeId === 'n-fight', 'the encounter node entered (not begun)');
    assert.match(P.text(), /The DM is setting up this encounter/);
    D.act('run-begin');
    await until(() => t.liveRoom().enc?.status === 'setup', 'the encounter built');
    const pc = Object.values(t.liveRoom().enc.state.entities).find(e => e.kind === 'pc' && e.controller?.seatId === cleric.slotId);
    assert.equal(pc.ac, acAfter, 'equip preview AC === entityFromSheet AC in the next encounter');
    await until(() => t.sessions.player.store.getState().room?.status === 'setup', 'the room in setup');

    P.un();
    D.un();
    assert.equal(P.dom.activeListeners(), 0);
    assert.equal(D.dom.activeListeners(), 0);
  } finally {
    await t.close();
  }
});

const COIN_NODES = [
  { id: 'n-purse', kind: 'loot', title: 'Goblin purse', start: true, payload: { items: [], currency: { gp: 30, sp: 5 }, assign: 'free' }, next: [{ to: 'n-chest' }] },
  { id: 'n-chest', kind: 'loot', title: 'The chief\'s chest', payload: { items: [], currency: { gp: 20 }, assign: 'dm' }, next: [] }
];

test('C24 v1.7 hub on the real server: a player takes coin on a free loot node; the DM splits the stash', async () => {
  const t = await bootRunTable(ROOT, { nodes: COIN_NODES });
  try {
    const pr = () => t.sessions.player.runStore.getState();
    const dr = () => t.sessions.dm.runStore.getState();
    const cleric = pr().characters.find(c => c.seat === 1);
    const fighter = pr().characters.find(c => c.seat === 2);
    const gp = (r, slotId) => r.characters.find(c => c.slotId === slotId).state.currency?.gp ?? 0;
    const sp = (r, slotId) => r.characters.find(c => c.slotId === slotId).state.currency?.sp ?? 0;
    const [gp1, sp1, gp2] = [gp(pr(), cleric.slotId), sp(pr(), cleric.slotId), gp(pr(), fighter.slotId)];
    const P = hub(t, 'player');
    const D = hub(t, 'dm');
    const field = (H, name, key) => H.dom.findAll(H.root, n => n.dataset?.field === name && n.dataset.key === key)[0];
    const setField = (H, name, key, v) => { const el = field(H, name, key); assert.ok(el, `${name} ${key}`); el.value = String(v); H.dom.fire(el, 'change'); };

    // Free loot node: the player takes 10 gp 5 sp for the cleric; no split control for players.
    await until(() => field(P, 'take', `${cleric.slotId}:gp`), 'the take inputs');
    assert.equal(P.dom.byAction(P.root, 'stash-split').length, 0);
    assert.equal(P.dom.findAll(P.root, n => n.dataset?.takeSlot === fighter.slotId).length, 0, 'only the seats the player controls');
    setField(P, 'take', `${cleric.slotId}:gp`, 10);
    setField(P, 'take', `${cleric.slotId}:sp`, 5);
    const frames = [];
    const off = t.sessions.player.ws.on('message', (m) => { if (m.t === 'run.event' && m.p.type === 'currency.changed') frames.push(m.p); });
    P.act('stash-take', el => el.dataset.slot === cleric.slotId);
    await until(() => gp(pr(), cleric.slotId) === gp1 + 10 && /takes 10 gp 5 sp/.test(P.status()), 'the taken coin');
    assert.equal(sp(pr(), cleric.slotId), sp1 + 5);
    assert.deepEqual(pr().stash.currency.gp, 20);
    assert.deepEqual(frames.map(f => [f.payload.slotId, f.payload.reason, f.payload.delta]), [[cleric.slotId, 'stash.take', { gp: 10, sp: 5 }]]);
    off?.();

    // The DM's split: pre-filled with the even split of what is left (20 gp → 10 / 10).
    await until(() => field(D, 'split', `${fighter.slotId}:gp`)?.value === '10', 'the even split pre-filled');
    assert.equal(field(D, 'split', `${cleric.slotId}:gp`).value, '10');
    assert.match(D.dom.findAll(D.root, n => n.dataset?.preview === 'stash-split')[0].textContent, /the stash is emptied/);
    // Over-allocating is caught before sending.
    setField(D, 'split', `${cleric.slotId}:gp`, 15);
    assert.match(D.dom.findAll(D.root, n => n.dataset?.preview === 'stash-split')[0].textContent, /The stash has only 20 gp/);
    assert.equal(D.dom.byAction(D.root, 'stash-split')[0].disabled, true);
    setField(D, 'split', `${cleric.slotId}:gp`, 12);
    setField(D, 'split', `${fighter.slotId}:gp`, 6);
    assert.match(D.dom.findAll(D.root, n => n.dataset?.preview === 'stash-split')[0].textContent, /2 gp stays in the stash/);
    D.act('stash-split');
    await until(() => gp(dr(), fighter.slotId) === gp2 + 6 && gp(pr(), cleric.slotId) === gp1 + 22, 'the split purses (both clients)');
    assert.deepEqual(dr().stash.currency.gp, 2);
    assert.ok(dr().log.some(e => e.type === 'currency.changed' && e.payload.reason === 'stash.split' && e.payload.slotId === fighter.slotId), 'the split in the DM\'s run log');
    // After the split the inputs reset to the new even split (2 gp → 1 / 1).
    await until(() => field(D, 'split', `${fighter.slotId}:gp`)?.value === '1', 'the new even split');

    // A DM loot node: players see no take control.
    D.act('run-advance', el => el.dataset.to === 'n-chest');
    await until(() => pr().currentNodeId === 'n-chest' && pr().stash.currency.gp === 22, 'the chest');
    assert.equal(P.dom.byAction(P.root, 'stash-take').length, 0);
    assert.match(P.text(), /The DM splits the coin/);
    P.un();
    D.un();
    assert.equal(P.dom.activeListeners(), 0);
    assert.equal(D.dom.activeListeners(), 0);
  } finally {
    await t.close();
  }
});

test('C24 v1.7 pure: downtimeOptions lists known healing spells with their slots; healPreview spans the roll', () => {
  const sheet = parseCharacter(cleric4Raw());
  const state = { schema_v: 1, hp: { current: 10, temp: 0 }, slots: { spell: { 1: { spent: 4 }, 2: { spent: 1 } }, pact: { spent: 0 } } };
  const opts = downtimeOptions(sheet, state);
  assert.deepEqual(opts.map(o => [o.id, o.slots.map(x => `${x.kind}:${x.level}:${x.left}`)]), [
    ['cure-wounds', ['spell:2:2']], ['healing-word', ['spell:2:2']]
  ], 'level-1 slots spent: only level 2 is offered; Prayer of Healing is not on the sheet');
  assert.deepEqual(downtimeOptions(null, state), []);
  const target = { id: 'f', sheet: { ...sheet, hp: { max: 40 } }, state: { schema_v: 1, hp: { current: 3, temp: 0 } } };
  const pv = healPreview({ caster: { id: 'c', sheet, state, lifeStatus: 'active' }, spellId: 'cure-wounds', slotLevel: 2, targets: [target] });
  assert.equal(pv.ok, true, pv.error);
  assert.equal(pv.dice, '2d8');
  assert.equal(pv.bonus, 4, 'Disciple of Life: 2 + the slot level');
  assert.deepEqual([pv.low, pv.high], [2 + pv.mod + 4, 16 + pv.mod + 4]);
  assert.deepEqual([pv.targets[0].before, pv.targets[0].low, pv.targets[0].high], [3, 3 + pv.low, 3 + pv.high]);
  assert.equal(healPreview({ caster: { id: 'c', sheet, state }, spellId: 'cure-wounds', slotLevel: 1, targets: [target] }).error, 'The caster has no slot left for it.');
  assert.equal(healPreview({ caster: { id: 'c', sheet, state }, spellId: 'cure-wounds', slotLevel: 2, targets: [{ ...target, sheet: null }] }).ok, false, 'waits for the sheets');
});

test('C24 v1.7 run store: heal.cast sets the caster and the targets from its after', () => {
  const rs = createRunStore();
  rs.apply(snap({ run: { id: 'r1', status: 'between', currentNodeId: 'n1', seq: 1 }, nodes: [], edges: [], items: [], levelUps: [],
    characters: [{ slotId: 's1', seat: 1, level: 3, xp: 0, lifeStatus: 'active' }, { slotId: 's2', seat: 2, level: 3, xp: 0, lifeStatus: 'dying' }] }));
  const st = (hp, spent) => ({ hp: { current: hp, temp: 0 }, ...(spent ? { slots: { spell: { 1: { spent } } } } : {}) });
  assert.equal(rs.apply(ev(2, 'heal.cast', { casterSlotId: 's1', spellId: 'healing-word', slotLevel: 1, targetSlotIds: ['s2'], healed: { s2: 7 },
    before: { s1: { state: st(9, 0), lifeStatus: 'active' }, s2: { state: st(0), lifeStatus: 'dying' } },
    after: { s1: { state: st(9, 1), lifeStatus: 'active' }, s2: { state: st(7), lifeStatus: 'active' } } })), 'applied');
  assert.deepEqual(rs.getState().characters.map(c => [c.state.hp.current, c.lifeStatus]), [[9, 'active'], [7, 'active']]);
  assert.equal(rs.getState().characters[0].state.slots.spell[1].spent, 1);
});

const HEAL_NODES = [
  { id: 'n-camp', kind: 'rest', title: 'Camp', start: true, payload: { type: 'short' }, next: [] }
];

test('C24 v1.7 hub on the real server: Cure Wounds between nodes lands in the preview; the DM casting for a player\'s seat is an override', async () => {
  const t = await bootRunTable(ROOT, { nodes: HEAL_NODES });
  try {
    const pr = () => t.sessions.player.runStore.getState();
    const dr = () => t.sessions.dm.runStore.getState();
    const cleric = pr().characters.find(c => c.seat === 1);
    const fighter = pr().characters.find(c => c.seat === 2);
    const hp = (r, slotId) => r.characters.find(c => c.slotId === slotId).state.hp.current;
    // Wound both seats server-side, then resync both clients.
    const store = t.liveRoom().run.store;
    for (const [slotId, cur] of [[fighter.slotId, 5], [cleric.slotId, 4]]) {
      const c = store.getCharacter(slotId);
      store.updateCharacter(c.runId, slotId, c.version, { state: { ...c.state, hp: { current: cur, temp: 0 } } });
    }
    for (const who of ['dm', 'player']) await t.sessions[who].send({ t: 'resync', p: {} });
    await until(() => hp(pr(), fighter.slotId) === 5 && hp(dr(), cleric.slotId) === 4, 'the wounds');
    const spent0 = pr().characters.find(c => c.slotId === cleric.slotId).state.slots?.spell?.[1]?.spent ?? 0;
    const P = hub(t, 'player');
    const D = hub(t, 'dm');
    const row = (H, slotId) => H.rowOf('healSlot', slotId);
    const preview = (H, slotId) => H.dom.findAll(H.root, n => n.dataset?.preview === 'heal' && n.dataset.slot === slotId)[0]?.textContent || '';

    // The player: only the cleric casts; Cure Wounds on the fighter with a level-1 slot.
    await until(() => /HP 5 → \d+–\d+/.test(preview(P, cleric.slotId)), 'the player\'s heal preview');
    assert.equal(row(P, fighter.slotId), undefined, 'the fighter knows no healing spell and is not the player\'s');
    assert.equal(P.dom.findAll(P.root, n => n.dataset?.field === 'heal-override').length, 0);
    const [, lo, hi] = /HP 5 → (\d+)–(\d+)/.exec(preview(P, cleric.slotId)).map(Number);
    const sent = [];
    const send0 = t.sessions.player.send;
    t.sessions.player.send = (intent) => { sent.push(intent); return send0(intent); };
    P.act('heal-cast', el => el.dataset.slot === cleric.slotId);
    await until(() => hp(pr(), fighter.slotId) > 5 && /casts Cure Wounds: Fixture Fighter \+\d+ HP/.test(P.status()), 'the healed fighter');
    t.sessions.player.send = send0;
    assert.deepEqual(sent.map(i => i.t), ['cast.downtime']);
    assert.deepEqual(sent[0].p, { casterSlotId: cleric.slotId, spellId: 'cure-wounds', targetSlotId: fighter.slotId, slotLevel: 1, slotKind: 'spell' });
    const healed = hp(pr(), fighter.slotId);
    assert.ok(healed >= lo && healed <= hi, `healed to ${healed}, inside the preview ${lo}–${hi}`);
    assert.equal(pr().characters.find(c => c.slotId === cleric.slotId).state.slots.spell[1].spent, spent0 + 1, 'a level-1 slot spent');
    const ev1 = pr().log.at(-1);
    assert.deepEqual([ev1.type, ev1.actorKind, ev1.override], ['heal.cast', 'player', false]);

    // The DM casts Healing Word for the player's cleric (on herself): an override, labelled as such.
    await until(() => D.dom.findAll(D.root, n => n.dataset?.field === 'heal-override' && n.dataset.slot === cleric.slotId).length === 1, 'the override label');
    const spellSel = D.dom.findAll(D.root, n => n.dataset?.field === 'heal-spell' && n.dataset.key === cleric.slotId)[0];
    spellSel.value = 'healing-word';
    D.dom.fire(spellSel, 'change');
    const tgtSel = D.dom.findAll(D.root, n => n.dataset?.field === 'heal-target' && n.dataset.key === cleric.slotId)[0];
    tgtSel.value = cleric.slotId;
    D.dom.fire(tgtSel, 'change');
    const slotSel = D.dom.findAll(D.root, n => n.dataset?.field === 'heal-slot' && n.dataset.key === cleric.slotId)[0];
    slotSel.value = 'spell:2';
    D.dom.fire(slotSel, 'change');
    await until(() => /Fixture Cleric HP 4 → \d+–\d+/.test(preview(D, cleric.slotId)), 'the DM\'s preview for the cleric herself');
    const btn = D.dom.byAction(D.root, 'heal-cast').find(el => el.dataset.slot === cleric.slotId);
    assert.match(btn.textContent, /Cast Healing Word \(DM override\)/);
    btn.click();
    await until(() => hp(dr(), cleric.slotId) > 4 && hp(pr(), cleric.slotId) > 4, 'the healed cleric on both clients');
    const ev2 = dr().log.at(-1);
    assert.deepEqual([ev2.type, ev2.actorKind, ev2.override, ev2.payload.slotLevel, ev2.payload.spellId], ['heal.cast', 'dm', true, 2, 'healing-word']);
    assert.match(D.status(), /\(DM override\)/);
    // A refusal reads as text (Prayer of Healing is not on this cleric's sheet).
    const err = await t.sessions.player.send({ t: 'cast.downtime', p: { casterSlotId: cleric.slotId, spellId: 'prayer-of-healing', targetSlotIds: [fighter.slotId] } }).catch(e => e);
    assert.equal(refusalText(err), 'The caster does not know that spell.');
    P.un();
    D.un();
    assert.equal(P.dom.activeListeners(), 0);
    assert.equal(D.dom.activeListeners(), 0);
  } finally {
    await t.close();
  }
});
