/**
 * M64 phase 1.5 (E2 task 4) — room settings: `dm.room.settings` from the
 * DM's card, the `room.settings` broadcast, and the claim screen's
 * "starts rested" / "imports current HP" line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/client/store.js';
import { roomSettingsOf, seedingCopy } from '../js/client/selectors.js';
import { mount as mountSettings, settingsPatch } from '../js/client/views/room-settings.js';
import { mount as mountClaim } from '../js/client/views/claim.js';
import { createFakeServer, demoCharacter } from '../js/client/fake-transport.js';
import { createApi } from '../js/client/api.js';
import { createSession } from '../js/client/session.js';
import { validateClientMessage, validateServerMessage } from '../js/shared/protocol.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { snapshotMsg, manualTimers, flush } from './helpers/client-fixtures.js';

function storeFor(role, settings) {
  const store = createStore({ hashState: null });
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: role === 'dm' ? 'mem_dm' : 'mem_p', role, seats: [], serverNow: 1, cfg: {} } });
  store.apply(snapshotMsg(10, null, { code: 'ABC123', status: 'lobby', settings, members: [], seats: [] }));
  return store;
}

test('roomSettingsOf: E3 v1.4 names, the dmOverrideVisibility alias, and defaults for older servers', () => {
  assert.deepEqual(roomSettingsOf({}), { reactionTimeoutMs: 20000, importLiveState: false, fudgeVisibility: 'public', diagonalRule: '5ft' });
  assert.equal(roomSettingsOf({ room: { settings: { dmOverrideVisibility: 'dm-only' } } }).fudgeVisibility, 'dm-only');
  assert.equal(roomSettingsOf({ room: { settings: { fudgeVisibility: 'public', dmOverrideVisibility: 'dm-only' } } }).fudgeVisibility, 'public');
  assert.match(seedingCopy({ room: { settings: { importLiveState: true } } }), /current D&D Beyond HP/);
  assert.match(seedingCopy({}), /fully rested/);
});

test('settingsPatch: only changed keys, bounds checked', () => {
  const cur = { reactionTimeoutMs: 20000, importLiveState: false, fudgeVisibility: 'public' };
  assert.deepEqual(settingsPatch(cur, { seconds: 30, importLiveState: true, fudgeVisibility: 'public' }).payload, { reactionTimeoutMs: 30000, importLiveState: true });
  assert.equal(settingsPatch(cur, { seconds: 20, importLiveState: false, fudgeVisibility: 'public' }).reason, 'Nothing changed.');
  assert.equal(settingsPatch(cur, { seconds: 500, importLiveState: false, fudgeVisibility: 'public' }).ok, false);
  assert.deepEqual(settingsPatch(cur, { seconds: 20, importLiveState: false, fudgeVisibility: 'dm-only' }).payload, { fudgeVisibility: 'dm-only' });
});

test('the store folds room.settings into room.settings; the message is contract-valid', () => {
  const store = storeFor('dm', { reactionTimeoutMs: 20000 });
  const msg = { v: 1, t: 'room.settings', seq: 11, ts: 1, p: { settings: { reactionTimeoutMs: 45000, importLiveState: true, fudgeVisibility: 'dm-only', diagonalRule: '5ft' } } };
  assert.equal(validateServerMessage(msg).ok, true);
  assert.equal(store.apply(msg), 'applied');
  assert.deepEqual(roomSettingsOf(store.getState()), { reactionTimeoutMs: 45000, importLiveState: true, fudgeVisibility: 'dm-only', diagonalRule: '5ft' });
});

test('settings card: DM-only, shows the current values, sends dm.room.settings with the changes', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const store = storeFor('dm', { reactionTimeoutMs: 20000, importLiveState: false, fudgeVisibility: 'public' });
  const sent = [];
  const un = mountSettings(root, { store, send: async (i) => { assert.equal(validateClientMessage({ v: 1, cid: '01J00000000000000000000000', ...i }).ok, true); sent.push(i); return { ok: true }; } });
  assert.equal(root.querySelector('[data-field="reaction-seconds"]').value, '20');
  root.querySelector('[data-field="reaction-seconds"]').value = '40';
  root.querySelector('[data-field="import-live"]').checked = true;
  root.querySelector('[data-field="fudge"]').value = 'dm-only';
  dom.byAction(root, 'settings-save')[0].click();
  await flush();
  assert.deepEqual(sent, [{ t: 'dm.room.settings', p: { reactionTimeoutMs: 40000, importLiveState: true, fudgeVisibility: 'dm-only' } }]);
  un();
  assert.equal(root.children.length, 0);
  const pdom = createFakeDom();
  const proot = pdom.root();
  const un2 = mountSettings(proot, { store: storeFor('player', {}), send: async () => ({}) });
  assert.equal(proot.children[0].hidden, true, 'players never see the card');
  un2();
});

test('claim screen: "starts rested" vs "imports current HP/slots" follows the setting', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const store = storeFor('player', { importLiveState: false });
  const un = mountClaim(root, { store, api: { listCharacters: async () => ({ characters: [] }) }, room: { roomId: 'r1', role: 'player' }, loadSheet: async () => null });
  const line = () => dom.findAll(root, n => /play-seeding/.test(n.className))[0].textContent;
  assert.match(line(), /fully rested/);
  store.apply({ v: 1, t: 'room.settings', seq: 11, ts: 1, p: { settings: { reactionTimeoutMs: 20000, importLiveState: true, fudgeVisibility: 'public', diagonalRule: '5ft' } } });
  await flush();
  assert.match(line(), /current D&D Beyond HP, spell slots and used features/);
  un();
});

test('fake transport: dm.room.settings round-trips; dm-only fudges reach players as redacted; import-live HP seeds the PC', async () => {
  const timers = manualTimers();
  const server = createFakeServer({ characters: [], timers, now: () => 1 });
  const created = await createApi({ fetch: server.fetch }).createRoom('T');
  const dm = createSession({ url: 'ws://fake/ws', token: created.dmToken, WebSocketCtor: server.WebSocket, wsOptions: { timers, now: () => 1 } });
  await dm.connect();
  const join = await createApi({ fetch: server.fetch }).joinRoom(created.code, 'Robin');
  const player = createSession({ url: 'ws://fake/ws', token: join.token, WebSocketCtor: server.WebSocket, wsOptions: { timers, now: () => 1 } });
  await player.connect();
  const hurt = { ...demoCharacter('c-h', 'Hurt', { hp: 30 }), hp: { max: 30, current: 12, temp: 0 } };
  const imp = await createApi({ fetch: server.fetch, token: () => join.token }).importCharacter(created.roomId, { json: hurt });
  await player.send({ t: 'seat.claim', p: { characterId: imp.character.id } });
  const ack = await dm.send({ t: 'dm.room.settings', p: { importLiveState: true, fudgeVisibility: 'dm-only' } });
  assert.equal(ack.ok, true);
  await flush();
  for (const c of [dm, player]) assert.equal(roomSettingsOf(c.store.getState()).importLiveState, true);
  await assert.rejects(dm.send({ t: 'dm.room.settings', p: {} }), (e) => e.code === 'E_INVALID_INTENT');
  await dm.send({ t: 'dm.encounter.setup', p: { map: null, grid: { cols: 4, rows: 4 }, monsters: [{ id: 'gob', slug: 'goblin' }], placements: {} } });
  await flush();
  assert.equal(player.store.getState().encounter.entities['pc-1'].hp, 12, 'imports the current HP');
  await dm.send({ t: 'dm.entity.patch', p: { entityId: 'gob', hp: 1 } });
  await flush();
  assert.ok(dm.store.getState().history.some(e => e.type === 'dm.override'), 'the DM sees the fudge');
  assert.equal(player.store.getState().history.some(e => e.type === 'dm.override'), false, 'the player does not');
  assert.equal(player.store.getState().seq, dm.store.getState().seq, 'seq stays gap-free');
  assert.equal(player.store.getStats().gap, 0);
  dm.close();
  player.close();
});
