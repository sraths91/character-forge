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
import { createFog, revealCells, isRevealed } from '../../src/js/map/fog.js';
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

// ------------------------------------------------------------ fog brush

test('dm.fog.paint: the brush on state.fog; no fog is an invalid intent', () => {
  const engine = createRealEngine();
  const { ctx } = collect();
  const fog = revealCells(createFog(8, 6), 8, 6, [{ col: 0, row: 0 }]);
  const s = built(engine, { fog });
  const cmd = (payload) => ({ type: 'dm.fog.paint', payload });
  const shown = engine.applyDmCommand(s, cmd({ cells: [{ col: 6, row: 5 }, { col: 99, row: 0 }], op: 'reveal' }), ctx).state;
  assert.equal(isRevealed(shown.fog, 8, 6, 5), true);
  assert.equal(isRevealed(s.fog, 8, 6, 5), false, 'the input is not mutated');
  const hidden = engine.applyDmCommand(shown, cmd({ cells: [{ col: 0, row: 0 }], op: 'hide' }), ctx).state;
  assert.equal(isRevealed(hidden.fog, 8, 0, 0), false);
  assert.throws(() => engine.applyDmCommand(built(engine), cmd({ cells: [{ col: 0, row: 0 }], op: 'reveal' }), ctx), { code: 'E_INVALID_INTENT' });
});

test('room: dm.fog.paint broadcasts encounter.fog and re-snapshots player seats with the revealed creature', async () => {
  const fog = revealCells(createFog(8, 6), 8, 6, [{ col: 0, row: 0 }]);
  const { db, room, frames, send } = await liveRoom({ fog });
  try {
    const r = await send('dm.fog.paint', { cells: [{ col: 6, row: 5 }], op: 'reveal' });
    assert.equal(r.t, 'ack', JSON.stringify(r.p));
    for (const k of ['dm', 'player']) {
      const m = frames[k].find(f => f.t === 'encounter.fog');
      assert.ok(m, `${k} got encounter.fog`);
      assert.equal(isRevealed(m.p.fog, 8, 6, 5), true);
      for (const f of frames[k]) assert.ok(validateServerMessage(f).ok, `${k} ${f.t}`);
    }
    const snap = frames.player.find(f => f.t === 'room.snapshot');
    assert.ok(snap, 'the player seat is re-baselined');
    assert.ok(snap.p.encounter.entities.gob, 'the goblin in the revealed cell is now in the player projection');
    assert.ok(snap.p.seq >= frames.player.find(f => f.t === 'encounter.fog').seq, 'the snapshot covers the fog broadcast');
    assert.equal(isRevealed(room.enc.state.fog, 8, 6, 5), true, 'persisted on the authoritative state');
    // Hide it again: the player loses the goblin.
    frames.player.length = 0;
    await send('dm.fog.paint', { cells: [{ col: 6, row: 5 }], op: 'hide' });
    assert.equal(frames.player.find(f => f.t === 'room.snapshot').p.encounter.entities.gob, undefined);
  } finally { room.shutdown(); db.close(); }
});
