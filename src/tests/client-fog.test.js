/**
 * M64 phase 1.5 (E2 task 5) — the fog-aware client: `redacted` advances
 * seq and logs "something happens", masked ('Something') events no-op on
 * the mirror, the turn order under a filtered view resolves against the
 * per-seat stateHash, and the DM's fog brush sends `dm.fog.paint`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/client/store.js';
import { turnEndedCandidates, applyEventToEncounter } from '../js/client/mirror.js';
import { stateHash } from '../js/shared/state-hash.js';
import { createFog, revealCells, filterViewForFog } from '../js/map/fog.js';
import { formatRedacted } from '../js/client/log-format.js';
import { fogPaintIntent, FOG_BRUSH_FLAG, mount as mountBattle } from '../js/client/views/battle.js';
import { createFakeServer, demoCharacter, HIDDEN_ENTITY_ID } from '../js/client/fake-transport.js';
import { createApi } from '../js/client/api.js';
import { createSession } from '../js/client/session.js';
import { turnInfo } from '../js/client/selectors.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { projectedState, snapshotMsg, manualTimers, manualRaf, flush, clone } from './helpers/client-fixtures.js';

const ev = (seq, type, payload, round = 2) => ({ seq, type, round, turnId: 't', cinemaGroup: null, payload });
const wire = (e) => ({ v: 1, t: e.type, seq: e.seq, ts: 1, p: e });

test('fog: redacted advances seq, is listed for the log, and breaks the prev-event chain', () => {
  const store = createStore();
  store.apply(snapshotMsg(10));
  assert.equal(store.apply({ v: 1, t: 'redacted', seq: 11, ts: 1, p: { type: 'move' } }), 'applied');
  assert.equal(store.getState().seq, 11);
  assert.deepEqual(store.getState().hidden, [{ seq: 11, type: 'move' }]);
  assert.equal(store.apply({ v: 1, t: 'redacted', seq: 12, ts: 1, p: { type: 'feature.used' } }), 'applied');
  // A resource.spent right after a hidden feature.used is not a smite.
  store.apply(wire(ev(13, 'resource.spent', { entityId: 'pc-wizard', resource: 'spell-slot', level: 2 })));
  assert.equal(store.getState().encounter.entities['pc-wizard'].turnFlags.smiteSlotUsed, undefined);
  assert.equal(store.getStats().gap, 0);
  assert.match(formatRedacted('move').text, /out of sight/);
  assert.match(formatRedacted('dm.override').text, /behind the screen/);
});

test('fog: a masked event naming "Something" leaves the mirror untouched', () => {
  const enc = projectedState();
  const next = applyEventToEncounter(enc, ev(30, 'damage', { sourceId: HIDDEN_ENTITY_ID, targetId: HIDDEN_ENTITY_ID, amount: 3, type: null, hpBefore: 9, hpAfter: 6 }));
  assert.deepEqual(next.entities, enc.entities);
});

test('fog: turnEndedCandidates covers the filtered turn order (clamp vs wrap, hidden actor, ended)', () => {
  // Full order: fighter, wizard, fanatic, goblin; the goblin hides in fog.
  const full = clone(projectedState());
  full.fog = revealCells(createFog(full.grid.cols, full.grid.rows), full.grid.cols, full.grid.rows,
    Object.values(full.entities).filter(e => e.id !== 'm-goblin').map(e => e.pos));
  full.turnIndex = 2;   // the fanatic acts
  full.entities['m-goblin'].hp = 7;
  const filtered = (s) => filterViewForFog(s);
  const seen = filtered(full);
  assert.equal(seen.entities['m-goblin'], undefined);
  // After the fanatic, the server's index moves to the hidden goblin: filtered, it clamps to the last row.
  const after = { ...full, turnIndex: 3 };
  const want = stateHash(filtered(after));
  const cands = turnEndedCandidates(seen, ev(40, 'turn.ended', { actorId: 'm-fanatic' }));
  assert.equal(cands.length, 3);
  assert.notEqual(stateHash(cands[0]), want, 'the default (wrap) is wrong here');
  assert.equal(stateHash(cands[1]), want, 'the clamp variant matches');
  // The hidden goblin's own turn.ended (masked): the round wraps.
  const wrapped = { ...full, turnIndex: 0, round: full.round + 1 };
  const c2 = turnEndedCandidates(filtered(after), ev(41, 'turn.ended', { actorId: HIDDEN_ENTITY_ID }));
  assert.ok(c2.some(c => stateHash(c) === stateHash(filtered(wrapped))));
  // Without fog there is one outcome.
  assert.equal(turnEndedCandidates(projectedState(), ev(42, 'turn.ended', { actorId: 'pc-fighter' })).length, 1);
});

test('fog: the store keeps the candidate the server hashed — no resync', () => {
  const full = clone(projectedState());
  full.fog = revealCells(createFog(full.grid.cols, full.grid.rows), full.grid.cols, full.grid.rows,
    Object.values(full.entities).filter(e => e.id !== 'm-goblin').map(e => e.pos));
  full.entities['m-goblin'].hp = 7;
  full.turnIndex = 2;
  const store = createStore();
  store.apply(snapshotMsg(10, filterViewForFog(full)));
  const calls = [];
  store.onResyncNeeded((i) => calls.push(i.reason));
  store.apply(wire(ev(11, 'turn.started', { actorId: 'm-fanatic' })));
  store.apply(wire(ev(12, 'turn.ended', { actorId: 'm-fanatic', stateHash: stateHash(filterViewForFog({ ...full, turnIndex: 3 })) })));
  assert.deepEqual(calls, []);
  assert.equal(store.getStats().fogResolved, 1);
  store.presentUpTo(12);
  assert.deepEqual(store.getPresented().encounter, store.getState().encounter, 'presented replays the same choice');
});

test('fog: fogPaintIntent maps a brush stroke to dm.fog.paint', () => {
  assert.equal(FOG_BRUSH_FLAG & 31, 0, 'never a terrain bit');
  assert.deepEqual(fogPaintIntent({ cells: [{ col: 1, row: 2, extra: 1 }], flag: FOG_BRUSH_FLAG, op: 'set' }), { t: 'dm.fog.paint', p: { cells: [{ col: 1, row: 2 }], op: 'reveal' } });
  assert.equal(fogPaintIntent({ cells: [{ col: 0, row: 0 }], op: 'clear' }).p.op, 'hide');
});

test('fog: the DM battle view shows the fog brush under fog; a stroke sends dm.fog.paint; an old server says so', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const enc = projectedState();
  enc.fog = createFog(enc.grid.cols, enc.grid.rows, { revealed: true });
  const store = createStore({ hashState: null });
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: 'mem_dm', role: 'dm', seats: [], serverNow: 1, cfg: {} } });
  store.apply(snapshotMsg(10, enc, { code: 'ABC123', status: 'in-encounter', members: [], seats: [], turn: null }));
  const sent = [];
  let reject = false;
  const raf = manualRaf();
  const un = mountBattle(root, {
    store,
    send: async (i) => { sent.push(i); if (reject) { const e = new Error('unknown'); e.code = 'E_UNKNOWN_TYPE'; throw e; } return { ok: true }; },
    session: { serverNow: () => 1, setPlayback: () => () => {} },
    sheets: () => ({}),
    deps: { render: async () => ({ needsRedraw: false }), raf: raf.raf, caf: raf.caf, timers: manualTimers(), cinema: { async setActors() {}, resetHp() {}, playRound: () => Promise.resolve() }, cinemaCanvas: false }
  });
  const sel = dom.findAll(root, n => n.tagName === 'SELECT' && /play-fog-brush/.test(n.className))[0];
  assert.equal(sel.hidden, false, 'the DM sees the brush under fog');
  sel.value = 'hide';
  dom.fire(sel, 'change');
  const canvas = dom.findAll(root, n => n.tagName === 'CANVAS' && /play-map-canvas/.test(n.className))[0];
  dom.fire(canvas, 'pointerdown', { clientX: 320, clientY: 210, button: 0 });
  dom.fire(canvas, 'pointerup', { clientX: 320, clientY: 210, button: 0 });
  await flush();
  assert.equal(sent.at(-1)?.t, 'dm.fog.paint');
  assert.equal(sent.at(-1).p.op, 'hide');
  reject = true;
  dom.fire(canvas, 'pointerdown', { clientX: 320, clientY: 210, button: 0 });
  dom.fire(canvas, 'pointerup', { clientX: 320, clientY: 210, button: 0 });
  await flush();
  assert.ok(dom.byText(root, 'does not support the fog brush').length);
  store.apply({ v: 1, t: 'redacted', seq: 11, ts: 1, p: { type: 'attack.rolled' } });
  store.presentUpTo(11);
  await flush();
  assert.ok(dom.findAll(root, n => n.tagName === 'LI' && /roll-hidden/.test(n.className) && /out of sight/.test(n.textContent)).length, 'the log says something happens');
  un();
});

test('fog: fake table with a hidden goblin — the player mirror matches every per-seat hash, zero resyncs', async () => {
  const timers = manualTimers();
  const server = createFakeServer({ characters: [], timers, now: () => 1, seed: 3 });
  const created = await createApi({ fetch: server.fetch }).createRoom('Fog');
  const dm = createSession({ url: 'ws://fake/ws', token: created.dmToken, WebSocketCtor: server.WebSocket, wsOptions: { timers, now: () => 1 } });
  await dm.connect();
  const join = await createApi({ fetch: server.fetch }).joinRoom(created.code, 'Robin');
  const player = createSession({ url: 'ws://fake/ws', token: join.token, WebSocketCtor: server.WebSocket, wsOptions: { timers, now: () => 1 } });
  await player.connect();
  const imp = await createApi({ fetch: server.fetch, token: () => join.token }).importCharacter(created.roomId, { json: demoCharacter('c-r', 'Robin', { hp: 60 }) });
  await player.send({ t: 'seat.claim', p: { characterId: imp.character.id } });
  const cols = 16;
  const rows = 3;
  const fog = revealCells(createFog(cols, rows), cols, rows, [0, 1, 2, 3].flatMap(c => [0, 1, 2].map(r => ({ col: c, row: r }))));
  await dm.send({ t: 'dm.encounter.setup', p: {
    map: null, grid: { cols, rows }, fog,
    monsters: [{ id: 'gob', slug: 'goblin', hp: 40 }, { id: 'lurk', slug: 'goblin', name: 'Lurker', hp: 40 }],
    placements: { 'pc-1': { col: 0, row: 1 }, gob: { col: 1, row: 1 }, lurk: { col: 15, row: 2 } }
  } });
  await flush();
  assert.equal(player.store.getState().encounter.entities.lurk, undefined, 'the lurker is filtered out');
  await dm.send({ t: 'dm.encounter.start', p: { seed: 9 } });
  const sentFor = new Set();
  for (let i = 0; i < 300 && player.store.getState().history.filter(e => e.type === 'turn.ended').length < 8; i++) {
    const s = player.store.getState();
    if (s.openPrompt) await player.send({ t: 'prompt.answer', p: { promptId: s.openPrompt.promptId, answer: false } }).catch(() => {});
    const ti = turnInfo(s);
    if (ti.mine && ti.turnId && !sentFor.has(ti.turnId)) {
      sentFor.add(ti.turnId);
      await player.send({ t: 'turn.act', p: { turnId: ti.turnId, plan: { kind: 'dodge' } } }).catch(() => {});
    }
    timers.advance(5000);
    await flush(2);
  }
  const st = player.store.getStats();
  assert.ok(player.store.getState().history.filter(e => e.type === 'turn.ended').length >= 4, 'turns were checked');
  const redacted = server.sent.filter(x => x.to === join.participantId && x.msg.t === 'redacted').length;
  const masked = server.sent.filter(x => x.to === join.participantId && x.msg.p?.payload?.actorId === HIDDEN_ENTITY_ID).length;
  assert.ok(redacted > 0 && masked > 0, `fog hid events (redacted ${redacted}, masked ${masked})`);
  assert.equal(st.hashMismatch, 0, JSON.stringify(st));
  assert.equal(st.resyncs, 0);
  assert.equal(dm.store.getStats().hashMismatch, 0, 'the DM checks the full hash');
  dm.close();
  player.close();
});
