// M64 phase 1.5 Wave 6 — DM edits the server now wires: the dying state
// (`dm.entity.patch {status, deathSaves}`), the fog brush (`dm.fog.paint`)
// and token images (`dm.entity.patch {imageUrl}`).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../rooms/room.js';
import { createRoomService } from '../rooms/service.js';
import { createSqliteJournal } from '../rooms/persistence.js';
import { createRealEngine } from '../rooms/real-engine.js';
import { createRng } from '../../src/js/scene/rng.js';
import { validateEncounterState } from '../../src/js/shared/encounter-state.js';
import { validateEvent } from '../../src/js/shared/events.js';
import { validateServerMessage } from '../../src/js/shared/protocol.js';
import { parsedDdbFixture } from '../../src/tests/helpers/entities.js';
import { tempRoot, tempDb, quiet, seedRoom, seedPlayer } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-w6-');
after(cleanup);

const seat = (n, fixture) => ({
  slotId: `s_${n}`, seat: n, characterId: String(n), characterName: null, controller: 'ai', aiArchetype: null,
  seed: parsedDdbFixture(fixture)
});

function built(engine, extra = {}) {
  return engine.buildEncounter({
    encounterId: `e-${Math.random().toString(36).slice(2, 10)}`, seed: 9,
    setup: { map: null, grid: { cols: 8, rows: 6 }, monsters: [{ id: 'gob', hp: 20 }], placements: { gob: { col: 6, row: 5 }, 'pc-1': { col: 0, row: 0 } }, ...extra },
    party: [seat(1, 'fighter-l5')]
  });
}

function collect() {
  const events = [];
  const emit = (ev) => { const st = { seq: events.length + 1, round: 0, turnId: null, cinemaGroup: null, ...ev }; events.push(st); return st; };
  return { events, ctx: { rng: createRng({ s: 1 }), emit } };
}

const patch = (engine, state, payload, ctx) => engine.applyDmCommand(state, { type: 'dm.entity.patch', payload }, ctx).state;

// ------------------------------------------------------------ dying state

test('dm.entity.patch status: downed → stable → dead → active, each with its E1 life event', () => {
  const engine = createRealEngine();
  const { events, ctx } = collect();
  let s = built(engine);
  s = patch(engine, s, { entityId: 'pc-1', status: 'downed', deathSaves: { successes: 1, failures: 2 } }, ctx);
  let pc = s.entities['pc-1'];
  assert.deepEqual([pc.hp, pc.status, pc.deathSaves, pc.conditions.includes('unconscious')], [0, 'downed', { successes: 1, failures: 2, stable: false }, true]);
  s = patch(engine, s, { entityId: 'pc-1', status: 'stable' }, ctx);
  assert.deepEqual([s.entities['pc-1'].status, s.entities['pc-1'].deathSaves], ['stable', { successes: 1, failures: 2, stable: true }]);
  s = patch(engine, s, { entityId: 'pc-1', status: 'dead' }, ctx);
  assert.equal(s.entities['pc-1'].status, 'dead');
  s = patch(engine, s, { entityId: 'pc-1', status: 'active' }, ctx);
  pc = s.entities['pc-1'];
  assert.deepEqual([pc.hp, pc.status, pc.deathSaves, pc.conditions.includes('unconscious')], [1, undefined, undefined, false]);
  assert.deepEqual(events.map(e => e.type), ['entity.downed', 'entity.stabilized', 'entity.died', 'entity.revived']);
  assert.deepEqual(events[2].payload, { entityId: 'pc-1', byId: null, cause: 'failures' });
  assert.deepEqual(events[3].payload, { entityId: 'pc-1', hp: 1, byId: null });
  for (const ev of events) assert.ok(validateEvent(ev).ok, ev.type);
  assert.ok(validateEncounterState(s).ok);
});

test('dm.entity.patch deathSaves: counter edits are silent; stable flips follow the tally flag; monsters only die', () => {
  const engine = createRealEngine();
  const { events, ctx } = collect();
  let s = patch(engine, built(engine), { entityId: 'pc-1', hp: 0 }, ctx);
  assert.equal(s.entities['pc-1'].status, 'downed', 'an HP edit flips the status silently');
  s = patch(engine, s, { entityId: 'pc-1', deathSaves: { successes: 2, failures: 1 } }, ctx);
  assert.deepEqual(s.entities['pc-1'].deathSaves, { successes: 2, failures: 1, stable: false });
  assert.deepEqual(events, [], 'no death.save, no life event for a tally edit');
  s = patch(engine, s, { entityId: 'pc-1', deathSaves: { successes: 2, failures: 1, stable: true } }, ctx);
  assert.equal(s.entities['pc-1'].status, 'stable');
  assert.deepEqual(events.map(e => e.type), ['entity.stabilized']);
  s = patch(engine, s, { entityId: 'gob', status: 'dead' }, ctx);
  assert.deepEqual([s.entities.gob.hp, s.entities.gob.status, s.entities.gob.deathSaves], [0, 'dead', undefined]);
  assert.deepEqual(events.at(-1).payload, { entityId: 'gob', byId: null, cause: 'monster' });
  for (const bad of [
    { entityId: 'gob', status: 'downed' },
    { entityId: 'gob', deathSaves: { successes: 1, failures: 0 } },
    { entityId: 'pc-1', status: 'active', deathSaves: { successes: 1, failures: 0 } }
  ]) assert.throws(() => patch(engine, s, bad, ctx), { code: 'E_INVALID_INTENT' }, JSON.stringify(bad));
  const back = patch(engine, s, { entityId: 'gob', status: 'active' }, ctx);
  assert.deepEqual([back.entities.gob.hp, back.entities.gob.status], [1, undefined]);
});

// ------------------------------------------------------------ room wiring

/** A Room holding a built (not yet running) encounter, the DM and one player attached. */
async function liveRoom(setupExtra = {}) {
  const { db } = await tempDb(root);
  const { roomId, dmId } = seedRoom(db);
  const player = seedPlayer(db, roomId);
  const service = createRoomService({ db });
  const engine = createRealEngine();
  const state = built(engine, setupExtra);
  const journal = createSqliteJournal({ db: db.db });
  journal.createEncounter({ roomId, encounterId: state.encounterId, state, engineVersion: engine.version });
  journal.setStatus(state.encounterId, 'active');
  const room = new Room({ id: roomId, service, engine, journal, log: quiet });
  const frames = { dm: [], player: [] };
  const conn = (k) => ({ id: k, sendRaw: (text) => frames[k].push(JSON.parse(text)), close() {} });
  const conns = { dm: conn('dm'), player: conn('player') };
  room.attach(conns.dm, { participantId: dmId, role: 'dm', displayName: 'DM' }, 'h1');
  room.attach(conns.player, { participantId: player.id, role: 'player', displayName: 'Pat' }, 'h2');
  frames.dm.length = 0;
  frames.player.length = 0;
  let cid = 0;
  const send = async (t, p) => {
    const id = `c${++cid}`;
    await room.handle(conns.dm, dmId, { t, cid: id, p });
    return frames.dm.find(m => (m.t === 'ack' || m.t === 'error') && m.p.cid === id);
  };
  return { db, room, frames, send };
}

test('room: a status patch emits the life event, dm.override and entity.updated with status / deathSaves', async () => {
  const { db, room, frames, send } = await liveRoom();
  try {
    const r = await send('dm.entity.patch', { entityId: 'pc-1', status: 'downed', deathSaves: { successes: 0, failures: 1 } });
    assert.equal(r.t, 'ack', JSON.stringify(r.p));
    const seen = frames.dm.filter(m => ['entity.downed', 'dm.override', 'entity.updated'].includes(m.t));
    assert.deepEqual(seen.map(m => m.t), ['entity.downed', 'dm.override', 'entity.updated']);
    const upd = seen[2].p;
    assert.deepEqual([upd.patch.hp, upd.patch.status, upd.patch.deathSaves], [0, 'downed', { successes: 0, failures: 1, stable: false }]);
    assert.deepEqual(seen[1].p.payload.before.status, 'active');
    for (const m of frames.dm) assert.ok(validateServerMessage(m).ok, m.t);
    // Back to active: the patch spells the default out so a mirror can clear it.
    frames.dm.length = 0;
    await send('dm.entity.patch', { entityId: 'pc-1', status: 'active' });
    const up2 = frames.dm.find(m => m.t === 'entity.updated').p.patch;
    assert.deepEqual([up2.status, up2.deathSaves, up2.hp], ['active', null, 1]);
    assert.ok(frames.dm.some(m => m.t === 'entity.revived'));
    assert.equal(room.enc.state.entities['pc-1'].status, undefined);
  } finally { room.shutdown(); db.close(); }
});
