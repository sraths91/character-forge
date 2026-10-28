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
 *     retire, fill a seat, the override advance and the end of the run —
 *     and (v1.7) the run log fetched with `GET /api/runs/:runId/events?since=`
 *     (incrementally) re-hashes to the server's `wireHash`, which the
 *     client's run store and the dashboard's verified line both carry;
 *   - v1.7 reconnect: a fresh DM page rebuilds the run log and the
 *     snapshot list from `GET …/events` and `GET …/snapshots`.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';
import { mount as mountDashboard, dashboardModel, rowCells, runEventText, verifyWireLog } from '../js/client/views/run-dashboard.js';
import { createRunStore } from '../js/client/run-store.js';
import { createSession } from '../js/client/session.js';
import { runHash } from '../js/shared/run-state.js';
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
  assert.equal(runEventText({ type: 'heal.cast', override: true, payload: { casterSlotId: 's1', spellId: 'healing-word', slotLevel: 2, slotKind: 'spell', targetSlotIds: ['s1'], healed: { s1: 9 } } }, run),
    'Saris casts Healing Word (level 2) — DM override: Saris +9 HP.');
  assert.equal(runEventText({ type: 'node.entered', override: true, payload: { nodeId: 'n' } }, { nodes: [{ id: 'n', title: 'Den' }] }), 'Entered Den (override).');
});

test('C27 v1.7 pure: verifyWireLog; the run store keeps the hashes and merges fetched history', () => {
  const evs = [1, 2, 3].map(seq => ({ seq, type: 'story.chosen', nodeId: 'n', actorKind: 'dm', actorId: null, override: false, payload: { nodeId: 'n', choiceId: `c${seq}` } }));
  const hash = runHash(evs);
  assert.deepEqual(verifyWireLog(evs, { seq: 3, wireHash: hash }), { status: 'ok', hash });
  assert.equal(verifyWireLog(evs, { seq: 3, wireHash: 'abc' }).status, 'mismatch');
  assert.deepEqual(verifyWireLog([evs[0], evs[2]], { seq: 3, wireHash: hash }), { status: 'incomplete', missing: 2 });
  assert.equal(verifyWireLog(evs, { seq: 3, wireHash: null }).status, 'unknown');
  assert.equal(verifyWireLog(new Map(evs.map(e => [e.seq, e])), { seq: 2, wireHash: runHash(evs.slice(0, 2)) }).status, 'ok');

  const rs = createRunStore({ isDm: () => true });
  rs.apply({ v: 1, t: 'run.snapshot', ts: 1, p: { run: { id: 'r1', status: 'between', currentNodeId: 'n', seq: 2 }, nodes: [], edges: [], characters: [], items: [], levelUps: [], runHash: 'aa', wireHash: 'bb' } });
  assert.deepEqual([rs.getState().runHash, rs.getState().wireHash, rs.getState().hashSeq], ['aa', 'bb', 2]);
  assert.equal(rs.mergeHistory('other', evs), 0, 'another run');
  assert.equal(rs.mergeHistory('r1', [...evs, { seq: 2, type: 'nope' }]), 2, 'seq 1 and 2; seq 3 is past the snapshot');
  assert.deepEqual(rs.getState().log.map(e => e.seq), [1, 2]);
  assert.equal(rs.mergeHistory('r1', evs), 0, 'nothing new');
  rs.apply({ v: 1, t: 'run.event', seq: 9, ts: 1, p: evs[2] });
  rs.apply({ v: 1, t: 'run.updated', seq: 10, ts: 1, p: { runId: 'r1', status: 'between', currentNodeId: 'n', runSeq: 3, runHash: 'cc', wireHash: hash } });
  assert.deepEqual([rs.getState().wireHash, rs.getState().hashSeq], [hash, 3]);
  assert.equal(verifyWireLog(rs.getState().log, { seq: rs.getState().hashSeq, wireHash: rs.getState().wireHash }).status, 'ok');
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

    /** The wire log, fetched incrementally (GET /api/runs/:runId/events?since=). */
    const wire = [];
    const fetchWire = async () => {
      for (;;) {
        const since = wire.at(-1)?.seq ?? 0;
        const page = await fetch(`${t.srv.url}/api/runs/${t.run.runId}/events?since=${since}`, { headers: { authorization: `Bearer ${t.room.dmToken}` } }).then(r => r.json());
        wire.push(...page.events);
        if (!page.more) return page;
      }
    };
    /** The dashboard (model and DOM) equals the server's run.snapshot. */
    const check = async (label) => {
      const snap = await t.serverSnapshot('dm');
      await until(() => dr().seq === snap.run.seq && dr().hashSeq === snap.run.seq, `${label}: the client caught up to run seq ${snap.run.seq}`);
      // v1.7: the wire log re-hashes to the server's wireHash; the client holds the same hashes.
      const page = await fetchWire();
      assert.equal(page.seq, snap.run.seq, `${label}: the events route is at the snapshot's seq`);
      assert.deepEqual(wire.map(e => e.seq), Array.from({ length: snap.run.seq }, (_, i) => i + 1), `${label}: a whole log`);
      assert.equal(runHash(wire), snap.wireHash, `${label}: wireHash recomputed from GET …/events`);
      assert.deepEqual([page.wireHash, page.runHash], [snap.wireHash, snap.runHash], `${label}: the route's hashes`);
      assert.deepEqual([dr().wireHash, dr().runHash], [snap.wireHash, snap.runHash], `${label}: the run store's hashes`);
      await until(() => {
        const el = dom.findAll(root, n => n.dataset?.field === 'dash-hash')[0];
        return el?.dataset.status === 'ok' && el.textContent.includes(snap.wireHash);
      }, `${label}: the dashboard verified the log`);
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

test('C27 v1.7: a fresh DM page rebuilds the run log and the snapshot list from GET …/events and …/snapshots', async () => {
  const t = await bootRunTable(ROOT, { nodes: NODES });
  try {
    const fighter = t.sessions.dm.runStore.getState().characters.find(c => c.seat === 2);
    await t.sessions.dm.send({ t: 'dm.xp.adjust', p: { slotId: fighter.slotId, delta: 50, reason: 'scouting' } });
    const saved = await t.sessions.dm.send({ t: 'dm.snapshot.save', p: { label: 'at camp' } });
    await t.sessions.dm.send({ t: 'dm.run.advance', p: { toNodeId: 'n-fight' } });
    const seq = (await t.serverSnapshot('dm')).run.seq;
    // The page reloads: a new session (its run store starts empty) and a new dashboard.
    t.sessions.dm.close();
    const sockets = [];
    const WS = class extends WebSocket { constructor(url) { super(url); sockets.push(this); } };
    const fresh = createSession({ url: `${t.srv.url.replace(/^http/, 'ws')}/ws`, token: t.room.dmToken, WebSocketCtor: WS, wsOptions: { logger: { warn: () => {} } } });
    t.sessions.dm = fresh;
    await fresh.connect();
    await until(() => fresh.runStore.getState().synced && fresh.runStore.getState().seq === seq, 'the fresh snapshot');
    assert.deepEqual(fresh.runStore.getState().log, [], 'a snapshot carries no log');
    const calls = [];
    const api = { ...t.apis.dm, runEvents: (...a) => { calls.push(['events', a[1]?.since]); return t.apis.dm.runEvents(...a); }, runSnapshots: (...a) => { calls.push(['snapshots']); return t.apis.dm.runSnapshots(...a); } };
    const dom = createFakeDom();
    const root = dom.root();
    const un = mountDashboard(root, { ...t.ctx('dm'), store: fresh.store, runStore: fresh.runStore, send: (i) => fresh.send(i), api });
    await until(() => fresh.runStore.getState().log.length === seq, 'the log rebuilt');
    assert.deepEqual(fresh.runStore.getState().log.map(e => e.seq), Array.from({ length: seq }, (_, i) => i + 1));
    assert.deepEqual(calls, [['events', 0], ['snapshots']], 'one history fetch from the start, and the snapshot list');
    await until(() => /XP override: Fixture Fighter 6500 → 6550 \(scouting\)/.test(root.textContent), 'an event from before the reload in the log');
    assert.equal(dom.byAction(root, 'dash-snap-load').filter(el => el.dataset.id === saved.snapshotId).length, 1, 'the snapshot from before the reload');
    assert.match(dom.findAll(root, n => n.dataset?.snapshot === saved.snapshotId)[0].textContent, /at camp/);
    await until(() => dom.findAll(root, n => n.dataset?.field === 'dash-hash')[0]?.dataset.status === 'ok', 'the rebuilt log verified against wireHash');
    // Live events after the rebuild extend the same log; no second fetch.
    await fresh.send({ t: 'dm.run.advance', p: { toNodeId: 'n-town', override: true } });
    const seq2 = (await t.serverSnapshot('dm')).run.seq;
    assert.ok(seq2 > seq);
    await until(() => fresh.runStore.getState().hashSeq === seq2 && dom.findAll(root, n => n.dataset?.field === 'dash-hash')[0]?.textContent.includes(`#${seq2}`), 'verified at the next seq');
    assert.equal(dom.findAll(root, n => n.dataset?.field === 'dash-hash')[0].dataset.status, 'ok');
    assert.equal(calls.length, 2, 'live events need no fetch');
    un();
    assert.equal(dom.activeListeners(), 0);
    for (const ws of sockets) ws.terminate();
  } finally {
    await t.close();
  }
});

const FIGHT_NODES = [
  { id: 'n-fight', kind: 'encounter', title: 'Ambush', start: true, payload: { setup: GOBLIN_SETUP }, next: [{ to: 'n-camp' }] },
  { id: 'n-camp', kind: 'rest', title: 'Camp', payload: { type: 'short' }, next: [] }
];

test('C27 v1.7: xpAward confirm — the held award shows on the dashboard; "Confirm XP" is dm.xp.adjust delta 0', async () => {
  const t = await bootRunTable(ROOT, { nodes: FIGHT_NODES, settings: { xpMode: 'xp', levelUpMode: 'choose', xpAward: 'confirm' } });
  const offs = [];
  try {
    // Both clients finish every cinema; the player hands her turns to the AI.
    for (const who of ['dm', 'player']) {
      const s = t.sessions[who];
      offs.push(s.ws.on('message', (m) => {
        if (m.t === 'exchange') s.send({ t: 'cinema.done', p: { exchangeId: m.p.payload.exchangeId } }).catch(() => {});
        if (who === 'player' && m.t === 'turn.started') s.send({ t: 'turn.delegate', p: { turnId: m.p.turnId } }).catch(() => {});
      }));
    }
    const dom = createFakeDom();
    const root = dom.root();
    const sent = [];
    const base = t.ctx('dm');
    const un = mountDashboard(root, { ...base, send: (i) => { sent.push(i); return base.send(i); } });
    const dr = () => t.sessions.dm.runStore.getState();
    const xp0 = Object.fromEntries(dr().characters.map(c => [c.slotId, c.xp]));
    await t.sessions.dm.send({ t: 'dm.node.begin', p: {} });
    await t.sessions.dm.send({ t: 'dm.encounter.start', p: {} });
    await until(() => dr().pendingXp, 'the held award', 20000);
    const held = dr().pendingXp;
    assert.ok(held.total > 0);
    assert.deepEqual((await t.serverSnapshot('dm')).pendingXp, held, 'the client holds what the server holds');
    assert.deepEqual(Object.fromEntries(dr().characters.map(c => [c.slotId, c.xp])), xp0, 'no XP awarded yet');
    await until(() => dom.findAll(root, n => n.dataset?.field === 'dash-pending-xp').length === 1, 'the held-XP row');
    assert.match(root.textContent, new RegExp(`XP held for your confirmation: ${held.total}`));
    dom.byAction(root, 'dash-xp-confirm')[0].click();
    await until(() => dr().pendingXp === null && dom.findAll(root, n => n.dataset?.field === 'dash-pending-xp').length === 0, 'confirmed');
    assert.deepEqual(sent.map(i => [i.t, i.p.delta]), [['dm.xp.adjust', 0]]);
    assert.deepEqual(validateClientMessage({ v: PROTOCOL_VERSION, cid: '01J00000000000000000000000', ...sent[0] }).errors, []);
    for (const c of dr().characters) assert.equal(c.xp, xp0[c.slotId] + (held.perCharacter[c.slotId] || 0), `${c.slotId} got the held XP`);
    await until(() => /XP \(confirmed by the DM\)/.test(root.textContent), 'the confirmed award in the log');
    un();
    assert.equal(dom.activeListeners(), 0);
  } finally {
    for (const off of offs) off();
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
