// Run-room helpers for the M65 B24–B28 tests: a Room over a temp-file DB
// with the real engine, the SQLite journal and the run store, seats
// seeded from the synthetic DDB fixtures, fake connections that record
// (and protocol-check) every frame, and a restart that rebuilds the Room
// from the same DB file.

import { Room } from '../../rooms/room.js';
import { createRoomService } from '../../rooms/service.js';
import { createSqliteJournal } from '../../rooms/persistence.js';
import { createEngine } from '../../multiplayer.js';
import { createRunStore } from '../../runs/store.js';
import { validateClientMessage, validateServerMessage, PROTOCOL_VERSION } from '../../../src/js/shared/protocol.js';
import { makeRunEvent } from '../../../src/js/shared/run-events.js';
import { canonicalJson, hash53 } from '../../../src/js/shared/state-hash.js';
import { parsedDdbFixture } from '../../../src/tests/helpers/entities.js';
import { seedRoom, seedPlayer, quiet } from './server.js';

/** Timers that fire on the next macrotask (cinema caps, prompt deadlines). */
export const fastTimers = {
  setTimer: (fn) => setImmediate(fn),
  clearTimer: (t) => clearImmediate(t)
};

/**
 * Seed a character row + room_characters + party_slots row.
 * @returns {{slotId: string, characterRowId: number, sheet: object}}
 */
export function seedSeat(db, roomId, { seat, fixture, slotId = `slot-${seat}`, controller = null, archetype = 'auto' }) {
  const sheet = parsedDdbFixture(fixture);
  const row = db.upsertCharacter({ ddbId: sheet.id, name: sheet.name, rawJson: { id: sheet.id }, parsedJson: sheet, source: 'test' });
  db.db.prepare('INSERT OR IGNORE INTO room_characters (room_id, character_id, participant_id, added_at) VALUES (?, ?, ?, 1)').run(roomId, row.id, controller);
  db.db.prepare(`INSERT INTO party_slots (id, room_id, seat, character_id, seed_parsed_json, controller_participant_id, ai_archetype, claimed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`).run(slotId, roomId, seat, row.id, JSON.stringify(sheet), controller, archetype);
  return { slotId, characterRowId: row.id, sheet };
}

/**
 * A run room: DM + optional players, seats from fixtures.
 * @param {object} db  openDb handle (migrated)
 * @param {{seats?: object[], players?: string[], code?: string, settings?: object}} [o]
 */
export function makeRunRoom(db, { seats = [{ seat: 1, fixture: 'cleric-l5' }, { seat: 2, fixture: 'fighter-l5' }], players = [], code = 'RN2345', settings = null } = {}) {
  const { roomId, dmId, dmToken } = seedRoom(db, { code });
  if (settings) db.db.prepare('UPDATE rooms SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), roomId);
  const ps = players.map(name => seedPlayer(db, roomId, name));
  const seated = seats.map(s => seedSeat(db, roomId, { ...s, controller: s.player !== undefined ? ps[s.player].id : null }));
  const ctx = { db, roomId, dmId, dmToken, players: ps, seated };
  ctx.open = () => openRoom(ctx);
  return ctx;
}

/** (Re)build the Room from the DB, as a fresh process would. */
export function openRoom(ctx, { log = quiet } = {}) {
  const { db, roomId } = ctx;
  const service = createRoomService({ db });
  const engine = createEngine({ kind: 'real', db, store: service.store, log });
  const journal = createSqliteJournal({ db: db.db });
  const runStore = createRunStore(db.db);
  const room = new Room({ id: roomId, service, engine, journal, log, runs: { store: runStore }, ...fastTimers });
  const frames = new Map();
  const conns = new Map();
  let cid = 0;
  /** Attach a member's socket; every outbound frame is protocol-checked and recorded. */
  const connect = (memberId, role, name = role) => {
    const list = [];
    frames.set(memberId, list);
    const conn = {
      id: `conn-${memberId}`,
      sendRaw(text) {
        const msg = JSON.parse(text);
        const v = validateServerMessage(msg);
        if (!v.ok) throw new Error(`invalid outbound ${msg.t}: ${JSON.stringify(v.errors.slice(0, 3))}`);
        list.push(msg);
        // Players finish every cinema at once.
        if (msg.t === 'exchange') setImmediate(() => room.handle(conn, memberId, { t: 'cinema.done', cid: `cd${++cid}`, p: { exchangeId: msg.p.payload.exchangeId } }));
      },
      close() {}
    };
    conns.set(memberId, conn);
    room.attach(conn, { participantId: memberId, role, displayName: name }, `h-${memberId}`);
    return list;
  };
  /** Send an intent as `memberId`; returns the ack / error frame. */
  const send = async (memberId, t, p = {}) => {
    const msg = { v: PROTOCOL_VERSION, t, cid: `c${++cid}`, p };
    const v = validateClientMessage(msg);
    if (!v.ok) throw new Error(`test sent an invalid ${t}: ${JSON.stringify(v.errors.slice(0, 3))}`);
    const conn = conns.get(memberId) || { id: `x-${memberId}`, sendRaw(text) { (frames.get(memberId) || []).push(JSON.parse(text)); }, close() {} };
    let reply = null;
    const capture = { ...conn, sendRaw(text) { const m = JSON.parse(text); if ((m.t === 'ack' || m.t === 'error') && m.p.cid === msg.cid) reply = m; else conn.sendRaw(text); } };
    await room.handle(capture, memberId, msg);
    return reply;
  };
  const dm = (t, p) => send(ctx.dmId, t, p);
  /** Wait for the room's turn lane to stop (the encounter ended or paused). */
  const settle = async () => { while (room.loopRunning) await room.loopPromise; };
  return { room, service, engine, journal, runStore, frames, connect, send, dm, settle };
}

/** The run log as catalogue v1 events (no ts), oldest first. */
export function runLog(runStore, runId) {
  return runStore.listEvents(runId, { limit: 100000 }).map(e => makeRunEvent({
    seq: e.seq, type: e.type, nodeId: e.nodeId, actorKind: e.actorKind, actorId: e.actorId, override: e.override, payload: e.payload
  }));
}

/** The run hash (run-driver's definition: hash53 of the canonical event log). */
export function runHash(runStore, runId) {
  return hash53(canonicalJson(runLog(runStore, runId)));
}

export { quiet };
