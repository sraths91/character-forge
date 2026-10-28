/**
 * M65 C27 — the DM's run dashboard (views/run-dashboard.js) against the
 * REAL server in-process.
 *
 *   - pure: dashboardModel (state from the snapshot, maxima from the run
 *     sheet; `ddb:*` pools flagged DM-adjudicated), rowCells, runEventText;
 *   - GATE: every dashboard action is exactly one protocol-valid intent,
 *     and after each one the dashboard's model AND its rendered rows equal
 *     what the server's own `run.snapshot` (GET /api/rooms/:id/run) gives:
 *     XP adjust, snapshot save, a level-up confirm, revive, snapshot load,
 *     retire, fill a seat, the override advance and the end of the run.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mount as mountDashboard, dashboardModel, rowCells, runEventText } from '../js/client/views/run-dashboard.js';
import { createRunStore } from '../js/client/run-store.js';
import { validateClientMessage, PROTOCOL_VERSION } from '../js/shared/protocol.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { flush } from './helpers/client-fixtures.js';
import { bootRunTable, GOBLIN_SETUP, until } from './helpers/run-table.js';

const ROOT = mkdtempSync(join(tmpdir(), 'cf-c27-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('C27 pure: dashboardModel, rowCells, runEventText', () => {
  const run = {
    characters: [{
      slotId: 's1', seat: 1, name: 'Saris', level: 4, xp: 2700, lifeStatus: 'active', version: 3, memberId: 'p1', controller: 'player',
      state: {
        hp: { current: 20, temp: 3 }, hitDice: { Cleric: { die: 8, spent: 1 } }, slots: { spell: { 1: { spent: 2 }, 2: { spent: 0 } }, pact: { spent: 0 } },
        resources: { 'ddb:77': { label: 'Healing Hands', max: 2, spent: 1, recovery: ['lr'] }, 'feat:channel-divinity': { label: 'Channel Divinity', max: 1, spent: 0, recovery: ['sr'] } },
        exhaustion: 1, conditions: ['poisoned'], currency: { gp: 12 }
      }
    }]
  };
  const sheet = { hp: { max: 31 }, classes: [{ name: 'Cleric', level: 4 }], spellSlotTable: { spell: { 1: 4, 2: 3 }, pact: null } };
  const [row] = dashboardModel(run, (s, v) => (s === 's1' && v === 3 ? sheet : null));
  assert.deepEqual(row.hp, { current: 20, temp: 3, max: 31 });
  assert.deepEqual(row.slots, [{ level: 1, max: 4, left: 2 }, { level: 2, max: 3, left: 3 }]);
  assert.deepEqual(row.resources.map(r => [r.key, r.left, r.dm]), [['ddb:77', 1, true], ['feat:channel-divinity', 1, false]]);
  assert.equal(row.nextXp, 6500);
  assert.deepEqual(rowCells(row), [
    '1. Saris (player)', 'L4 · XP 2700/6500', 'active', 'HP 20/31 +3', 'Cleric d8 3/4', 'L1 2/4 L2 3/3',
    'Healing Hands* 1/2, Channel Divinity 1/1', 'exhaustion 1, poisoned', '12 gp'
  ]);
  assert.equal(dashboardModel(run)[0].hp.max, null, 'no sheet yet');
  assert.equal(runEventText({ type: 'dm.override', payload: { kind: 'xp', slotId: 's1', before: { xp: 1 }, after: { xp: 9 }, reason: 'milestone' } }, run), 'XP override: Saris 1 → 9 (milestone).');
  assert.equal(runEventText({ type: 'currency.changed', payload: { slotId: 's1', delta: { gp: 12, sp: 5 }, reason: 'stash.split' } }, run), 'Saris +12 gp 5 sp (stash split).');
  assert.equal(runEventText({ type: 'currency.changed', payload: { slotId: 's1', delta: { gp: -2 }, reason: 'stash.take' } }, run), 'Saris −2 gp (taken from the stash).');
  assert.equal(runEventText({ type: 'node.entered', override: true, payload: { nodeId: 'n' } }, { nodes: [{ id: 'n', title: 'Den' }] }), 'Entered Den (override).');
});

const NODES = [
  { id: 'n-camp', kind: 'rest', title: 'Camp', start: true, payload: { type: 'short' }, next: [{ to: 'n-fight' }] },
  { id: 'n-fight', kind: 'encounter', title: 'Ambush', payload: { setup: GOBLIN_SETUP }, next: [{ to: 'n-town' }] },
  { id: 'n-town', kind: 'shop', title: 'Town', payload: { stock: [] }, next: [] }
];

test('C27 GATE: every dashboard action is one intent; the dashboard matches the server snapshot after each', async () => {
  const t = await bootRunTable(ROOT, { nodes: NODES });
  try {
    const dom = createFakeDom();
    const root = dom.root();
    const sent = [];
    const base = t.ctx('dm');
    const ctx = { ...base, send: (intent) => { sent.push(intent); return base.send(intent); } };
    const un = mountDashboard(root, ctx);
    const dr = () => t.sessions.dm.runStore.getState();
    // Run sheets for the comparison, fetched by (slot, version) like the view does.
    const sheets = [];
    const loadAll = async (r) => { for (const c of r.characters) sheets.push([c.slotId, c.version, (await t.apis.dm.getSeatSheet(t.room.roomId, c.slotId)).sheet]); };
    const sheetFor = (s, v) => sheets.slice().reverse().find(([a, b]) => a === s && b === v)?.[2] ?? null;

    /** The dashboard (model and DOM) equals the server's run.snapshot. */
    const check = async (label) => {
      const snap = await t.serverSnapshot('dm');
      await until(() => dr().seq === snap.run.seq, `${label}: the client caught up to run seq ${snap.run.seq}`);
      const fresh = createRunStore({ isDm: () => true });
      fresh.apply({ v: 1, t: 'run.snapshot', ts: 1, p: snap });
      await loadAll(fresh.getState());
      const want = dashboardModel(fresh.getState(), sheetFor);
      assert.deepEqual(dashboardModel(dr(), sheetFor), want, `${label}: model`);
      await until(() => want.every(row => {
        const tr = dom.findAll(root, n => n.tagName === 'TR' && n.dataset?.slot === row.slotId)[0];
        return tr && rowCells(row).every((cell, i) => dom.findAll(tr, n => n.dataset?.cell === String(i))[0]?.textContent === cell);
      }) && dom.findAll(root, n => n.tagName === 'TR' && n.dataset?.slot).length === want.length, `${label}: rendered rows`);
      assert.match(dom.findAll(root, n => n.dataset?.field === 'dash-where')[0].textContent, new RegExp(`Status: ${snap.run.status}`));
    };
    const click = async (action, pred = () => true) => {
      const before = sent.length;
      const el = dom.byAction(root, action).find(pred);
      assert.ok(el, `button ${action}`);
      el.click();
      await until(() => sent.length > before, `${action} sent`);
      await flush();
      assert.equal(sent.length, before + 1, `${action}: exactly one intent`);
      const msg = { v: PROTOCOL_VERSION, cid: '01J00000000000000000000000', ...sent.at(-1) };
      assert.deepEqual(validateClientMessage(msg).errors, [], `${action}: a valid ${sent.at(-1).t}`);
      return sent.at(-1);
    };
    const set = (field, key, value, ev = 'change') => {
      const el = dom.findAll(root, n => n.dataset?.field === field && (key === undefined || n.dataset.key === key))[0];
      assert.ok(el, `field ${field}`);
      el.value = String(value);
      dom.fire(el, ev);
    };
    const statusText = () => dom.findAll(root, n => /play-status/.test(n.className))[0].textContent;

    await until(() => !root.firstChild.hidden && dom.findAll(root, n => n.tagName === 'TR' && n.dataset?.slot).length === 2, 'the party table');
    await check('start');
    const [cleric, fighter] = dr().characters.slice().sort((a, b) => a.seat - b.seat);

    // XP adjust (fighter).
    set('xp', fighter.slotId, 100, 'input');
    set('xp-reason', fighter.slotId, 'clever plan', 'input');
    assert.deepEqual((await click('dash-xp', el => el.dataset.slot === fighter.slotId)).p, { slotId: fighter.slotId, delta: 100, reason: 'clever plan' });
    await until(() => /has 6600 XP/.test(statusText()), 'xp ack');
    await check('xp adjust');
    await until(() => /XP override: Fixture Fighter 6500 → 6600 \(clever plan\)/.test(root.textContent), 'the run log line');

    // Snapshot save.
    set('snap-label', undefined, 'before the level', 'input');
    await click('dash-snap-save');
    await until(() => dom.byAction(root, 'dash-snap-load').length === 1, 'the saved snapshot listed');
    await check('snapshot save');

    // XP → a pending level-up for the cleric; confirm it from the dashboard.
    set('xp', cleric.slotId, 3800, 'input');
    await click('dash-xp', el => el.dataset.slot === cleric.slotId);
    await until(() => dom.byAction(root, 'dash-lu-confirm').length === 1, 'the pending level-up');
    await check('level queued');
    await click('dash-lu-confirm');
    await until(() => dr().characters.find(c => c.slotId === cleric.slotId).level === 5, 'level 5');
    await check('level confirmed');

    // Kill the fighter server-side, then revive it from the dashboard.
    const store = t.liveRoom().run.store;
    const f = store.getCharacter(fighter.slotId);
    store.updateCharacter(f.runId, fighter.slotId, f.version, { state: { ...f.state, hp: { current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 3, stable: false } }, lifeStatus: 'dead' });
    await t.sessions.dm.send({ t: 'resync', p: {} });
    await until(() => dom.byAction(root, 'dash-revive').length === 1, 'the revive control');
    await check('dead');
    await click('dash-revive');
    await until(() => dr().characters.find(c => c.slotId === fighter.slotId).lifeStatus === 'active', 'revived');
    await check('revive');

    // Load the snapshot: the cleric is level 4 again, XP as saved.
    await click('dash-snap-load');
    await until(() => dr().characters.find(c => c.slotId === cleric.slotId).level === 4, 'restored');
    await check('snapshot load');

    // Retire the fighter; fill seat 2 with it again as an AI seat at level 5.
    set('retire-reason', fighter.slotId, 'went home', 'input');
    assert.deepEqual((await click('dash-retire', el => el.dataset.slot === fighter.slotId)).p, { slotId: fighter.slotId, reason: 'went home' });
    await until(() => dr().characters.length === 1, 'retired');
    await check('retire');
    dom.byAction(root, 'dash-load-chars')[0].click();   // a read (GET), not an intent
    await until(() => dom.findAll(root, n => n.dataset?.field === 'fill-char')[0], 'the room characters');
    set('fill-seat', undefined, 2);
    set('fill-char', undefined, t.fighter.character.id);
    set('fill-level', undefined, 5, 'input');
    assert.deepEqual((await click('dash-fill')).p, { seat: 2, characterId: t.fighter.character.id, controller: 'ai', level: 5 });
    await until(() => dr().characters.length === 2, 'filled');
    await check('fill seat');

    // Travel: the offered edge, the override, the end.
    await click('dash-advance', el => el.dataset.to === 'n-fight');
    await until(() => dr().currentNodeId === 'n-fight' && dr().status === 'in-node', 'at the fight');
    await check('advance');
    assert.equal(dom.byAction(root, 'dash-begin').length, 1, 'an unfought encounter offers Begin');
    set('goto', undefined, 'n-town');
    assert.deepEqual((await click('dash-goto')).p, { toNodeId: 'n-town', override: true });
    await until(() => dr().currentNodeId === 'n-town', 'override');
    await check('override');
    set('outcome', undefined, 'victory');
    await click('dash-end');
    await until(() => dr().status === 'ended', 'ended');
    await check('end');

    assert.ok(sent.every(i => validateClientMessage({ v: PROTOCOL_VERSION, cid: '01J00000000000000000000000', ...i }).ok));
    assert.deepEqual([...new Set(sent.map(i => i.t))].sort(), [
      'dm.character.retire', 'dm.character.revive', 'dm.levelup.confirm', 'dm.run.advance', 'dm.run.end', 'dm.seat.fill',
      'dm.snapshot.load', 'dm.snapshot.save', 'dm.xp.adjust'
    ]);
    un();
    assert.equal(dom.activeListeners(), 0);
  } finally {
    await t.close();
  }
});

test('C27: hidden for players and outside a run', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const rs = createRunStore();
  const store = { getState: () => ({ me: { role: 'player' } }), subscribe: () => () => {} };
  const un = mountDashboard(root, { store, runStore: rs, send: async () => ({}), api: {}, room: null });
  assert.equal(root.firstChild.hidden, true);
  un();
  assert.equal(dom.activeListeners(), 0);
});
