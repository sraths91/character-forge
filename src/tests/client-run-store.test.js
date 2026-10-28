/**
 * M65 C23 — the client run store (seq-ordered run events, resync on a
 * gap, run.snapshot apply) and the run map (players see visited nodes and
 * offered edges only; the DM sees every node and advances).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunStore, visitedFromSnapshot, reduceRunEvent, initialRunState } from '../js/client/run-store.js';
import { createStore } from '../js/client/store.js';
import { screenFor } from '../js/client/selectors.js';
import { mount as mountRunMap, runMapModel } from '../js/client/views/run-map.js';
import { layoutGraph, playerRunGraph, edgeLabel } from '../js/client/campaign-graph.js';
import { validateServerMessage, validateClientMessage } from '../js/shared/protocol.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { snapshotMsg, flush } from './helpers/client-fixtures.js';

const SECRET = 'Secret Dragon Lair';
const NODES = [
  { id: 'n1', kind: 'story', title: 'The Tavern', start: true, visited: true, next: [{ to: 'n2' }] },
  { id: 'n2', kind: 'encounter', title: 'Goblin Ambush', visited: true, next: [{ to: 'n3', when: { outcome: 'party-victory' } }, { to: 'n4', when: { outcome: 'hostile-victory' } }] },
  { id: 'n3', kind: 'loot', title: SECRET, visited: false, next: [] },
  { id: 'n4', kind: 'rest', title: 'Hidden Shrine', visited: false, next: [] }
];
const CHARS = [{ slotId: 's1', seat: 1, level: 3, xp: 900, lifeStatus: 'active' }, { slotId: 's2', seat: 2, level: 3, xp: 900, lifeStatus: 'active' }];

function runSnapshot({ seq = 4, nodes = NODES, edges = [{ to: 'n3', when: { outcome: 'party-victory' } }], current = 'n2', status = 'between', visitedNodeIds } = {}) {
  return {
    v: 1, t: 'run.snapshot', ts: 1,
    p: { run: { id: 'run1', status, currentNodeId: current, seq, ...(visitedNodeIds ? { visitedNodeIds } : {}) }, nodes, edges, characters: CHARS, items: [], levelUps: [] }
  };
}

let roomSeq = 100;
function runEvent(seq, type, payload, extra = {}) {
  return { v: 1, t: 'run.event', seq: ++roomSeq, ts: 1, p: { seq, type, nodeId: null, actorKind: 'system', actorId: null, override: false, payload, ...extra } };
}

test('fixtures are protocol-valid', () => {
  assert.deepEqual(validateServerMessage(runSnapshot()).errors, []);
  assert.deepEqual(validateServerMessage(runEvent(5, 'node.entered', { nodeId: 'n3', kind: 'loot', fromNodeId: 'n2' })).errors, []);
});

test('run store: snapshot then in-order events apply; a duplicate run seq is ignored', () => {
  const rs = createRunStore();
  assert.equal(rs.apply(runSnapshot()), 'applied');
  assert.equal(rs.getState().seq, 4);
  assert.deepEqual(rs.getState().visitedIds, ['n1', 'n2']);
  const ev = runEvent(5, 'xp.awarded', { total: 100, perCharacter: { s1: 50, s2: 50 }, before: { s1: 900, s2: 900 }, after: { s1: 950, s2: 950 } });
  assert.equal(rs.apply(ev), 'applied');
  assert.equal(rs.getState().characters[0].xp, 950);
  const before = rs.getState();
  assert.equal(rs.apply({ ...ev, seq: ++roomSeq }), 'duplicate', 'same run seq on a new room seq');
  assert.equal(rs.apply(runEvent(3, 'xp.awarded', { total: 1, perCharacter: {}, before: {}, after: { s1: 1 } })), 'duplicate', 'older run seq');
  assert.equal(rs.getState(), before, 'state untouched');
  assert.equal(rs.getStats().duplicate, 2);
});

test('run store: an out-of-order run event asks for one resync and drops until the next snapshot', () => {
  const rs = createRunStore();
  const asks = [];
  rs.onResyncNeeded((i) => asks.push(i));
  rs.apply(runSnapshot());
  assert.equal(rs.apply(runEvent(7, 'node.entered', { nodeId: 'n3', kind: 'loot', fromNodeId: 'n2' })), 'gap');
  assert.deepEqual(asks.map(a => [a.reason, a.expected, a.got]), [['gap', 5, 7]]);
  assert.equal(rs.apply(runEvent(5, 'node.completed', { nodeId: 'n2', kind: 'encounter' })), 'dropped', 'waiting for the snapshot');
  assert.equal(rs.getState().seq, 4);
  assert.equal(rs.getState().currentNodeId, 'n2', 'nothing out of order was applied');
  assert.equal(asks.length, 1, 'one resync request');
  assert.equal(rs.apply(runSnapshot({ seq: 7, current: 'n3', status: 'in-node', edges: [], visitedNodeIds: ['n1', 'n2', 'n3'] })), 'applied');
  assert.equal(rs.apply(runEvent(8, 'node.completed', { nodeId: 'n3', kind: 'loot' })), 'applied');
  assert.equal(rs.getState().status, 'between');
});

test('run store: events before the first snapshot and a run.updated ahead of the slice both resync', () => {
  const rs = createRunStore();
  const asks = [];
  rs.onResyncNeeded((i) => asks.push(i.reason));
  assert.equal(rs.apply(runEvent(1, 'node.completed', { nodeId: 'n1', kind: 'story' })), 'dropped');
  rs.apply(runSnapshot());
  assert.equal(rs.apply({ v: 1, t: 'run.updated', seq: ++roomSeq, ts: 1, p: { runId: 'run1', status: 'in-node', currentNodeId: 'n3', runSeq: 4 } }), 'applied');
  assert.equal(rs.getState().currentNodeId, 'n3');
  assert.deepEqual(rs.getState().edges, [], 'offers end when the node changes');
  assert.equal(rs.apply({ v: 1, t: 'run.updated', seq: ++roomSeq, ts: 1, p: { runId: 'run1', status: 'between', currentNodeId: 'n3', runSeq: 9 } }), 'gap');
  assert.deepEqual(asks, ['unsynced', 'gap']);
});

test('run store: a stale snapshot is ignored; invalid frames are counted; levelup.offer kept until applied', () => {
  const rs = createRunStore();
  rs.apply(runSnapshot({ seq: 4 }));
  assert.equal(rs.apply(runSnapshot({ seq: 2 })), 'duplicate');
  assert.equal(rs.apply({ v: 1, t: 'run.event', seq: ++roomSeq, ts: 1, p: { seq: 5, type: 'xp.awarded', nodeId: null, actorKind: 'system', actorId: null, override: false, payload: {} } }), 'invalid', 'a mutating event without before/after');
  assert.equal(rs.apply({ v: 1, t: 'room.status', seq: 1, ts: 1, p: { status: 'lobby' } }), 'ignored');
  const offer = { v: 1, t: 'levelup.offer', ts: 1, p: { levelUpId: 'lu1', slotId: 's1', fromLevel: 3, toLevel: 4, mode: 'choose', status: 'pending_player', auto: {} } };
  assert.equal(rs.apply(offer), 'applied');
  assert.ok(rs.getState().offers.lu1);
  rs.apply(runEvent(5, 'level.queued', { levelUpId: 'lu1', slotId: 's1', fromLevel: 3, toLevel: 4 }));
  rs.apply(runEvent(6, 'level.applied', { levelUpId: 'lu1', slotId: 's1', fromLevel: 3, toLevel: 4, before: {}, after: {} }));
  assert.equal(rs.getState().characters[0].level, 4);
  assert.equal(rs.getState().offers.lu1, undefined);
  assert.equal(rs.getState().levelUps[0].status, 'applied');
  assert.equal(rs.getStats().invalid, 1);
});

test('visitedFromSnapshot: visitedNodeIds, then flags, then (players) every node; current always counts', () => {
  assert.deepEqual(visitedFromSnapshot({ run: { currentNodeId: 'b', visitedNodeIds: ['a'] }, nodes: [] }), ['a', 'b']);
  assert.deepEqual(visitedFromSnapshot({ run: { currentNodeId: null }, nodes: [{ id: 'a', visited: true }, { id: 'b', visited: false }] }), ['a']);
  assert.deepEqual(visitedFromSnapshot({ run: { currentNodeId: 'a' }, nodes: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(visitedFromSnapshot({ run: { currentNodeId: 'a' }, nodes: [{ id: 'a' }, { id: 'b' }] }, { dm: true }), ['a']);
  const s = reduceRunEvent({ ...initialRunState(), synced: true }, { seq: 1, type: 'run.ended', payload: { outcome: 'victory' } });
  assert.equal(s.status, 'ended');
});

test('campaign graph: edge labels, a branching layout, and a player graph with anonymous offers', () => {
  assert.equal(edgeLabel({ when: { outcome: 'party-victory' } }), 'victory');
  assert.equal(edgeLabel({ when: { choice: 'c1' } }, { payload: { choices: [{ id: 'c1', label: 'Take the left door' }] } }), 'Take the left door');
  assert.equal(edgeLabel({ label: 'Onward', when: { outcome: 'draw' } }), 'Onward');
  const g = layoutGraph(NODES);
  assert.equal(g.start, 'n1');
  const at = Object.fromEntries(g.nodes.map(n => [n.id, n]));
  assert.ok(at.n2.x > at.n1.x && at.n3.x === at.n4.x && at.n3.y !== at.n4.y, 'branches share a column');
  assert.deepEqual(g.edges.map(e => e.label), ['', 'victory', 'defeat']);
  const pg = playerRunGraph(NODES, ['n1', 'n2'], [{ to: 'n3', when: { outcome: 'party-victory' } }], 'n2');
  assert.deepEqual(pg.map(n => n.title), ['The Tavern', 'Goblin Ambush', '']);
  assert.ok(!JSON.stringify(pg).includes(SECRET));
});

function roomStore(role) {
  const store = createStore({ hashState: null });
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: role === 'dm' ? 'mem_dm' : 'mem_p', role, seats: [], serverNow: 1, cfg: {} } });
  store.apply(snapshotMsg(10, null, { code: 'ABC123', status: 'lobby', members: [], seats: [] }));
  return store;
}

test('run map (player): unvisited titles never render, even when the snapshot carries them', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const rs = createRunStore({ isDm: () => false });
  rs.apply(runSnapshot());   // a DM-shaped snapshot by mistake: n3 / n4 present but unvisited
  const sent = [];
  const un = mountRunMap(root, { store: roomStore('player'), runStore: rs, send: async (i) => { sent.push(i); return {}; } });
  const text = () => root.textContent;
  assert.match(text(), /The Tavern/);
  assert.match(text(), /Goblin Ambush/);
  assert.doesNotMatch(text(), new RegExp(SECRET));
  assert.doesNotMatch(text(), /Hidden Shrine/);
  assert.match(text(), /victory/, 'the offered edge shows its condition');
  assert.equal(dom.byAction(root, 'run-advance').length, 0, 'players cannot advance');
  assert.equal(root.querySelector('[data-field="goto-node"]'), null);
  // Entering n3 makes it visited: now (and only now) its title may show.
  rs.apply(runEvent(5, 'node.entered', { nodeId: 'n3', kind: 'loot', fromNodeId: 'n2' }));
  await flush();
  assert.match(text(), new RegExp(SECRET));
  assert.doesNotMatch(text(), /Hidden Shrine/);
  un();
  assert.equal(dom.activeListeners(), 0);
  assert.equal(root.children.length, 0);
  assert.equal(sent.length, 0);
});

test('run map (DM): every node, offered edges advance, and "go to any node" is an override', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const store = roomStore('dm');
  const rs = createRunStore({ isDm: () => true });
  rs.apply(runSnapshot());
  const sent = [];
  const un = mountRunMap(root, { store, runStore: rs, send: async (i) => { assert.deepEqual(validateClientMessage({ v: 1, cid: '01J00000000000000000000000', ...i }).errors, []); sent.push(i); return {}; } });
  assert.match(root.textContent, new RegExp(SECRET));
  assert.match(root.textContent, /Hidden Shrine/);
  const go = dom.byAction(root, 'run-advance');
  assert.equal(go.length, 1);
  go[0].click();
  root.querySelector('[data-field="goto-node"]').value = 'n4';
  dom.byAction(root, 'run-goto')[0].click();
  await flush();
  assert.deepEqual(sent, [
    { t: 'dm.run.advance', p: { toNodeId: 'n3' } },
    { t: 'dm.run.advance', p: { toNodeId: 'n4', override: true } }
  ]);
  un();
  assert.equal(dom.activeListeners(), 0);
});

test('run map (v1.7): the head shows the run log position and wireHash, updated by run.updated', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const rs = createRunStore({ isDm: () => false });
  const snap = runSnapshot();
  rs.apply({ ...snap, p: { ...snap.p, runHash: '1a2b', wireHash: '3c4d' } });
  const un = mountRunMap(root, { store: roomStore('player'), runStore: rs, send: async () => ({}) });
  const chip = () => root.querySelector('[data-field="run-hash"]');
  assert.equal(chip().textContent, 'log #4 · 3c4d');
  rs.apply(runEvent(5, 'node.entered', { nodeId: 'n3', kind: 'loot', fromNodeId: 'n2' }));
  rs.apply({ v: 1, t: 'run.updated', seq: ++roomSeq, ts: 1, p: { runId: 'run1', status: 'between', currentNodeId: 'n3', runSeq: 5, runHash: '5e', wireHash: '6f' } });
  await flush();
  assert.equal(chip().textContent, 'log #5 · 6f');
  un();
  // An older server (no hashes): no chip.
  const rs2 = createRunStore();
  rs2.apply(runSnapshot());
  const un2 = mountRunMap(root, { store: roomStore('player'), runStore: rs2, send: async () => ({}) });
  assert.equal(root.querySelector('[data-field="run-hash"]'), null);
  un2();
  assert.equal(dom.activeListeners(), 0);
});

test('runMapModel: a player offer to an unvisited node names no title', () => {
  const rs = createRunStore();
  rs.apply(runSnapshot());
  const m = runMapModel(rs.getState(), { dm: false });
  assert.deepEqual(m.offers, [{ to: 'n3', label: 'victory', title: null }]);
  assert.equal(runMapModel(rs.getState(), { dm: true }).offers[0].title, SECRET);
});

test('routing: a room between nodes shows the run map screen to everyone', () => {
  assert.equal(screenFor({ synced: true, me: { role: 'player' }, room: { status: 'between' } }), 'between');
  assert.equal(screenFor({ synced: true, me: { role: 'dm' }, room: { status: 'between' } }), 'between');
});
