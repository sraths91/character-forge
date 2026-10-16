/**
 * M64 C9 — a scripted table over the fake transport (E3's wire shapes):
 * DM creates a room, a player joins, imports and claims a character, the
 * DM sets up and starts the encounter, the goblin attacks, the player is
 * offered Shield (reaction prompt with a server deadline), declines, the
 * exchange plays through each client's playback queue (cinema.done paces
 * the server), turn.ended; then the player's own attack goes out as a
 * validated turn.act. Every server message is checked against the shared
 * contracts by the fake; the expectations below are derived from the
 * events themselves, not hard-coded numbers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeServer, demoCharacter } from '../js/client/fake-transport.js';
import { createApi } from '../js/client/api.js';
import { createSession } from '../js/client/session.js';
import { createRenderAdapter } from '../js/client/render-adapter.js';
import { attackIntent } from '../js/client/intents.js';
import { turnInfo, myEntityIds, seatsOf } from '../js/client/selectors.js';
import { validateClientMessage } from '../js/shared/protocol.js';
import { validateEventLog } from '../js/shared/events.js';
import { manualTimers, flush } from './helpers/client-fixtures.js';

const WIZ = demoCharacter('c-ilsa', 'Ilsa', { cls: 'Wizard', level: 3, hp: 18, weapon: 'Quarterstaff', dice: '1d6', armor: 12, spellSlots: { 1: 2 } });

async function until(cond, label, rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await flush(2);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function instantCinema() {
  return { async setActors() {}, resetHp() {}, playRound: () => Promise.resolve({ completed: true }) };
}

async function table() {
  const timers = manualTimers();
  let clock = 1_000_000;
  const server = createFakeServer({ characters: [], now: () => clock, timers, seed: 7 });
  const dmApi = createApi({ fetch: server.fetch });
  const created = await dmApi.createRoom('Test table');
  const dm = createSession({ url: 'ws://fake/ws', token: created.dmToken, WebSocketCtor: server.WebSocket, wsOptions: { timers, now: () => clock } });
  await dm.connect();
  const join = await createApi({ fetch: server.fetch }).joinRoom(created.code, 'Robin');
  const playerApi = createApi({ fetch: server.fetch, token: () => join.token });
  const player = createSession({ url: 'ws://fake/ws', token: join.token, WebSocketCtor: server.WebSocket, wsOptions: { timers, now: () => clock } });
  await player.connect();
  // Both clients run a playback queue; the player's plays the cinema.
  const done = { dm: [], player: [] };
  const dmAdapter = createRenderAdapter({ canvas: null, store: dm.store, cinemaEnabled: false, timers, onExchangeDone: (id) => { done.dm.push(id); dm.send({ t: 'cinema.done', p: { exchangeId: id } }); } });
  const plAdapter = createRenderAdapter({ canvas: null, store: player.store, cinema: instantCinema(), timers, onExchangeDone: (id) => { done.player.push(id); player.send({ t: 'cinema.done', p: { exchangeId: id } }); } });
  dm.setPlayback(dmAdapter);
  player.setPlayback(plAdapter);
  return { server, timers, created, join, dm, player, dmApi, playerApi, done, plAdapter, advanceClock: (ms) => { clock += ms; } };
}

test('C9 session: lobby → claim → setup → attack → reaction prompt → exchange → turn.ended', async () => {
  const t = await table();
  const { dm, player, created } = t;

  // Lobby: both see the room, the DM sees the player.
  assert.equal(dm.store.getState().me.role, 'dm');
  assert.equal(player.store.getState().me.role, 'player');
  await until(() => dm.store.getState().room.members.length === 2 || Object.keys(dm.store.getState().members).length > 0, 'member.joined');

  // Claim: import (the id comes back rewritten) and claim over ws.
  const imp = await t.playerApi.importCharacter(created.roomId, { json: WIZ });
  assert.equal(imp.character.id, `paste:${created.roomId}:c-ilsa`);
  const ack = await player.send({ t: 'seat.claim', p: { characterId: imp.character.id } });
  assert.equal(ack.ok, true);
  await until(() => seatsOf(dm.store.getState())[0].characterId === imp.character.id, 'seat.updated on the DM');
  assert.equal(seatsOf(dm.store.getState())[0].memberId, t.join.participantId);

  // Setup + start, with the goblin first in initiative and its attack roll armed to land within Shield range.
  await dm.send({ t: 'dm.encounter.setup', p: { map: { kind: 'color', color: '#3d5a3d' }, grid: { cols: 8, rows: 6 }, monsters: [{ id: 'm-1', slug: 'goblin', name: 'Goblin', hp: 30 }], placements: { 'pc-1': { col: 2, row: 2 }, 'm-1': { col: 3, row: 2 } }, initiativeMode: 'individual' } });
  await until(() => player.store.getPresented().encounter?.phase === 'setup', 'encounter.created');
  const pcAc = player.store.getState().encounter.entities['pc-1'].ac;
  assert.deepEqual(myEntityIds(player.store.getState()), ['pc-1']);
  await dm.send({ t: 'dm.initiative.set', p: { order: ['m-1', 'pc-1'] } });
  await dm.send({ t: 'dm.roll.arm', p: { entityId: 'm-1', rollKind: 'attack', value: pcAc - 4 + 1 } });   // total = AC + 1
  await dm.send({ t: 'dm.encounter.start', p: {} });

  // The goblin attacks; the player gets the Shield prompt with a server deadline.
  await until(() => player.store.getState().openPrompt?.kind === 'shield', 'shield prompt');
  const prompt = player.store.getState().openPrompt;
  assert.equal(prompt.payload.reactorId, 'pc-1');
  assert.equal(prompt.deadlineAt - prompt.serverNow, 20000, 'the countdown comes from the server deadline');
  assert.equal(dm.store.getState().openPrompt, null, 'prompts are private to the addressee');
  assert.equal(player.store.getPresented().encounter.entities['pc-1'].hp, 18, 'nothing presented before the exchange');
  await player.send({ t: 'prompt.answer', p: { promptId: prompt.promptId, answer: false } });

  // Exchange → both queues report cinema.done → turn.ended.
  await until(() => player.store.getPresented().history.some(e => e.type === 'turn.ended'), 'first turn.ended (player presented)');
  const hist = player.store.getPresented().history;
  const firstEnd = hist.findIndex(e => e.type === 'turn.ended');
  const goblinTurn = hist.slice(0, firstEnd + 1).map(e => e.type).filter(x => x !== 'resource.spent');
  assert.deepEqual(goblinTurn, ['turn.started', 'plan.chosen', 'dm.override', 'reaction.offered', 'reaction.resolved', 'attack.rolled', 'damage', 'exchange', 'turn.ended']);
  const override = hist.find(e => e.type === 'dm.override');
  assert.deepEqual([override.payload.kind, override.payload.after], ['roll.attack', pcAc - 3], 'the armed roll is logged as a DM edit');
  const resolved = hist.find(e => e.type === 'reaction.resolved');
  assert.deepEqual([resolved.payload.used, resolved.payload.by], [false, 'player']);
  const rolled = hist.find(e => e.type === 'attack.rolled');
  assert.equal(rolled.payload.total, pcAc + 1);
  assert.equal(rolled.payload.hit, true);
  const dmg = hist.find(e => e.type === 'damage');
  const exch = hist.find(e => e.type === 'exchange');
  assert.equal(exch.payload.effects[0].hp.after, dmg.payload.hpAfter);
  assert.equal(player.store.getPresented().encounter.entities['pc-1'].hp, dmg.payload.hpAfter, 'presented HP = the exchange result');
  assert.deepEqual(t.done.player, [exch.payload.exchangeId]);
  await until(() => t.done.dm.length === 1, 'DM cinema.done');

  // The player's turn: a validated turn.act attack.
  await until(() => turnInfo(player.store.getState()).mine, 'player turn');
  const ti = turnInfo(player.store.getState());
  const sheets = { [imp.character.id]: imp.character };
  const intent = attackIntent(player.store.getState().encounter, { actorId: ti.actorId, turnId: ti.turnId, targetId: 'm-1', weaponName: 'Quarterstaff', sheets });
  assert.equal(intent.ok, true, intent.reason);
  assert.equal(validateClientMessage({ v: 1, cid: '01J00000000000000000000000', ...intent.intent }).ok, true);
  await player.send(intent.intent);
  await until(() => player.store.getPresented().history.filter(e => e.type === 'turn.ended').length >= 2, 'second turn.ended');

  // Both clients agree on the sequence and the presented state.
  const pAuth = player.store.getState();
  const dAuth = dm.store.getState();
  await until(() => dm.store.getState().seq === player.store.getState().seq, 'equal seq');
  assert.equal(validateEventLog(pAuth.history).ok, true);
  const secondTurn = pAuth.history.slice(pAuth.history.findIndex(e => e.type === 'turn.ended') + 1);
  const types = secondTurn.slice(0, secondTurn.findIndex(e => e.type === 'turn.ended') + 1).map(e => e.type).filter(x => x !== 'damage' && x !== 'entity.downed');
  assert.deepEqual(types.slice(0, 3), ['turn.started', 'plan.chosen', 'attack.rolled']);
  assert.ok(types.includes('exchange') && types.at(-1) === 'turn.ended');
  assert.equal(secondTurn.find(e => e.type === 'plan.chosen').payload.source, 'player');
  assert.deepEqual(pAuth.encounter.entities, dAuth.encounter.entities);
  t.plAdapter.skip();
  assert.deepEqual(player.store.getPresented().encounter, player.store.getState().encounter);
  assert.equal(t.server.invalid.length, 0, 'no client message failed the shared contract');
  dm.close();
  player.close();
});

test('C9 session: a player sending dm.* gets an error; a stale turn.act is refused', async () => {
  const t = await table();
  await assert.rejects(t.player.send({ t: 'dm.pause', p: {} }), (e) => e.code === 'E_FORBIDDEN');
  await assert.rejects(t.player.send({ t: 'turn.act', p: { turnId: 'nope', plan: { kind: 'dodge' } } }), (e) => e.code === 'E_STALE');
  t.dm.close();
  t.player.close();
});
