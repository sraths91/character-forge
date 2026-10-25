// M65 B28 — solo rooms: POST /api/rooms {mode: 'solo'} sets
// dmDrivesAiSeats; every seat no player holds fights as controller 'dm'
// unless auto-fight is on, and the DM can toggle auto-fight
// mid-encounter (the waiting turn goes to the AI at once).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { startMultiplayerServer } from '../multiplayer.js';
import { normalizeRoomSettings } from '../rooms/service.js';
import { tempRoot, tempDb, quiet, api } from './helpers/server.js';
import { makeRunRoom } from './helpers/runs.js';

const { root, cleanup } = tempRoot('cf-solo-');
after(cleanup);

const ok = (reply) => { assert.equal(reply?.t, 'ack', JSON.stringify(reply?.p)); return reply.p; };
const SETUP = {
  map: null, grid: { cols: 10, rows: 8 },
  monsters: [{ slug: 'goblin', id: 'gob-1' }, { slug: 'goblin', id: 'gob-2' }],
  placements: { 'gob-1': { col: 6, row: 2 }, 'gob-2': { col: 7, row: 4 } }
};
const tick = () => new Promise(res => setImmediate(res));

test('B28: POST /api/rooms {mode: \'solo\'} → dmDrivesAiSeats; a bad mode is 400', async () => {
  const { db } = await tempDb(root);
  const srv = await startMultiplayerServer({ db, env: { NODE_ENV: 'test', CF_MULTIPLAYER: '1' }, port: 0, host: '127.0.0.1', log: quiet, janitorOpts: false });
  try {
    const solo = await api(srv.url, '/api/rooms', { method: 'POST', body: { mode: 'solo' } });
    assert.equal(solo.status, 201);
    assert.equal(solo.body.mode, 'solo');
    const desc = await api(srv.url, `/api/rooms/${solo.body.roomId}`, { token: solo.body.dmToken });
    assert.equal(desc.body.room.settings.dmDrivesAiSeats, true);
    assert.equal(desc.body.room.settings.autoFight, false);
    const table = await api(srv.url, '/api/rooms', { method: 'POST', body: {} });
    assert.equal((await api(srv.url, `/api/rooms/${table.body.roomId}`, { token: table.body.dmToken })).body.room.settings.dmDrivesAiSeats, false);
    assert.equal((await api(srv.url, '/api/rooms', { method: 'POST', body: { mode: 'party' } })).status, 400);
  } finally { await srv.close(); }
  assert.deepEqual(normalizeRoomSettings({}).dmDrivesAiSeats, false);
});

test('B28: one DM drives every PC, then toggles auto-fight mid-encounter', async () => {
  const { db } = await tempDb(root);
  const ctx = makeRunRoom(db, {
    settings: { dmDrivesAiSeats: true },
    seats: [{ seat: 1, fixture: 'cleric-l5' }, { seat: 2, fixture: 'fighter-l5' }, { seat: 3, fixture: 'wizard-l5' }]
  });
  const r = ctx.open();
  const frames = r.connect(ctx.dmId, 'dm', 'DM', { autoDelegate: false });
  ok(await r.dm('dm.encounter.setup', SETUP));
  const pcs = Object.values(r.room.enc.state.entities).filter(e => e.kind === 'pc');
  assert.equal(pcs.length, 3);
  assert.deepEqual(pcs.map(e => e.controller.type), ['dm', 'dm', 'dm'], 'the DM drives every AI seat');
  ok(await r.dm('dm.encounter.start', {}));
  // Wait for the first PC turn: it waits for the DM.
  for (let i = 0; i < 5000 && !(r.room.turn?.awaiting); i++) await tick();
  const aw = r.room.turn.awaiting;
  assert.equal(aw.ownerId, ctx.dmId);
  assert.equal(r.room.enc.state.entities[aw.actorId].kind, 'pc');
  // The DM plays that turn by hand (delegating is one valid act).
  ok(await r.dm('turn.delegate', { turnId: r.room.turn.turnId }));
  for (let i = 0; i < 5000 && !(r.room.turn?.awaiting && r.room.turn.awaiting !== aw); i++) await tick();
  const next = r.room.turn?.awaiting;
  assert.ok(next && next.ownerId === ctx.dmId, 'the next PC turn waits for the DM too');
  // Auto-fight on, mid-encounter: the waiting turn goes to the AI, and so does every later one.
  ok(await r.dm('dm.room.settings', { autoFight: true }));
  await r.settle();
  assert.equal(r.room.enc.status, 'ended', 'the AI finished the fight without the DM');
  const final = Object.values(r.room.enc.state.entities).filter(e => e.kind === 'pc');
  assert.deepEqual(final.map(e => e.controller.type), ['ai', 'ai', 'ai']);
  assert.ok(frames.some(f => f.t === 'entity.updated' && f.p.patch.controller?.type === 'ai'), 'the controller change was broadcast');
  assert.ok(frames.some(f => f.t === 'room.settings' && f.p.settings.autoFight === true));
});

test('B28: a seat a player holds stays the player\'s in a solo room', async () => {
  const { db } = await tempDb(root);
  const ctx = makeRunRoom(db, { settings: { dmDrivesAiSeats: true }, players: ['Pat'], seats: [{ seat: 1, fixture: 'cleric-l5', player: 0 }, { seat: 2, fixture: 'fighter-l5' }] });
  const r = ctx.open();
  r.connect(ctx.dmId, 'dm');
  ok(await r.dm('dm.encounter.setup', SETUP));
  const types = Object.values(r.room.enc.state.entities).filter(e => e.kind === 'pc').map(e => e.controller.type);
  assert.deepEqual(types, ['player', 'dm']);
  ok(await r.dm('dm.room.settings', { autoFight: true }));
  assert.deepEqual(Object.values(r.room.enc.state.entities).filter(e => e.kind === 'pc').map(e => e.controller.type), ['player', 'ai']);
});
