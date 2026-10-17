// Room lifecycle and seat assignment (M64 B6). Shared by the HTTP API and
// the ws gateway so both apply the same rules. Emits change events the
// live room registry listens to ('kick', 'seat', 'join').

import { EventEmitter } from 'node:events';
import { PC_PROFILES } from '../../src/js/scene/ai/pc-profiles.js';
import { generateToken, hashToken, newId, generateRoomCode, normalizeRoomCode, sanitizeDisplayName } from './tokens.js';
import { createRoomStore } from './store.js';

/** Most party seats per room (product decision 8). */
export const MAX_SEATS = 6;
/** Most active players per room (spectators beyond the six seats included). */
export const MAX_PLAYERS = 12;
/**
 * Room settings defaults; stored in rooms.settings_json and edited with
 * `dm.room.settings` (M64 W5). `fudgeVisibility` decides whether DM edits
 * (dm.override) reach players or the DM only; `importLiveState` seeds PCs
 * with D&D Beyond's current HP / used slots on the next encounter build;
 * `diagonalRule` is the grid's diagonal cost (5 ft only in phase 1).
 */
export const DEFAULT_ROOM_SETTINGS = Object.freeze({
  reactionTimeoutMs: 20_000,
  importLiveState: false,
  fudgeVisibility: 'public',
  diagonalRule: '5ft'
});

/**
 * The four room settings from a stored settings_json object, reading the
 * pre-W5 names (`importDdbState`, `dmOverrideVisibility`) as aliases.
 * @param {object|null|undefined} raw
 * @returns {{reactionTimeoutMs: number, importLiveState: boolean, fudgeVisibility: 'public'|'dm-only', diagonalRule: '5ft'}}
 */
export function normalizeRoomSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ms = Number(r.reactionTimeoutMs);
  const fudge = r.fudgeVisibility ?? r.dmOverrideVisibility;
  return {
    reactionTimeoutMs: Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_ROOM_SETTINGS.reactionTimeoutMs,
    importLiveState: r.importLiveState === true || r.importDdbState === true,
    fudgeVisibility: fudge === 'dm-only' ? 'dm-only' : 'public',
    diagonalRule: r.diagonalRule === '5ft' ? '5ft' : DEFAULT_ROOM_SETTINGS.diagonalRule
  };
}
/** AI archetypes a DM may assign to an AI seat ('auto' infers from class). */
export const AI_ARCHETYPES = Object.freeze(['auto', ...Object.keys(PC_PROFILES)]);

/** A rule violation with an HTTP status and a stable code. */
export class RoomError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {object} opts
 * @param {import('../db/database.js').DbHandle} opts.db
 * @param {() => number} [opts.now]
 * @param {(max: number) => number} [opts.codeRand]  injectable for collision tests
 */
export function createRoomService({ db, now = Date.now, codeRand } = {}) {
  const store = createRoomStore(db.db, { now });
  const events = new EventEmitter();

  /**
   * Create a room and its DM. The DM token is returned exactly once.
   * @param {{name?: string|null}} [args]
   * @returns {{roomId: string, code: string, dmToken: string, participantId: string}}
   */
  function createRoom({ name = null } = {}) {
    let roomName = null;
    if (name !== null && name !== undefined) {
      const r = sanitizeDisplayName(name);
      if (!r.ok) throw new RoomError(400, 'BAD_REQUEST', `name: ${r.error}`);
      roomName = r.name;
    }
    const roomId = newId();
    const dmToken = generateToken();
    const participantId = newId('p_');
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateRoomCode(codeRand);
      try {
        store.tx(() => {
          store.insertRoom({ id: roomId, code, dmTokenHash: hashToken(dmToken), name: roomName, settings: DEFAULT_ROOM_SETTINGS, now: now() });
          store.insertParticipant({ id: participantId, roomId, displayName: 'DM', role: 'dm' });
        })();
        return { roomId, code, dmToken, participantId };
      } catch (err) {
        if (/UNIQUE constraint failed: rooms\.code/.test(err.message)) continue; // open-code collision: retry
        throw err;
      }
    }
    throw new RoomError(503, 'CODE_EXHAUSTED', 'Could not allocate a room code; try again');
  }

  /**
   * Join an open room by code.
   * @param {{code: unknown, displayName: unknown}} args
   * @returns {{roomId: string, participantId: string, token: string, displayName: string}}
   */
  function joinRoom({ code, displayName }) {
    const c = normalizeRoomCode(code);
    if (!c) throw new RoomError(400, 'BAD_CODE', 'A room code is 6 letters/digits');
    const nm = sanitizeDisplayName(displayName);
    if (!nm.ok) throw new RoomError(400, 'BAD_NAME', nm.error);
    const room = store.getOpenRoomByCode(c);
    if (!room) throw new RoomError(404, 'ROOM_NOT_FOUND', 'No open room with that code');
    const participantId = newId('p_');
    const token = generateToken();
    store.tx(() => {
      if (store.countActivePlayers(room.id) >= MAX_PLAYERS) throw new RoomError(409, 'E_ROOM_FULL', 'The room is full');
      store.insertParticipant({ id: participantId, roomId: room.id, displayName: nm.name, role: 'player', tokenHash: hashToken(token) });
      store.touchRoom(room.id);
    })();
    events.emit('join', { roomId: room.id, participantId, displayName: nm.name });
    return { roomId: room.id, participantId, token, displayName: nm.name };
  }

  function requireDm(auth, roomId) {
    if (!auth || auth.roomId !== roomId) throw new RoomError(401, 'UNAUTHENTICATED', 'A token for this room is required');
    if (auth.role !== 'dm') throw new RoomError(403, 'E_FORBIDDEN', 'Only the DM can do that');
  }
  function requireMember(auth, roomId) {
    if (!auth || auth.roomId !== roomId) throw new RoomError(401, 'UNAUTHENTICATED', 'A token for this room is required');
  }
  function seatNumber(seat) {
    const n = Number(seat);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS) throw new RoomError(400, 'BAD_SEAT', `seat must be 1..${MAX_SEATS}`);
    return n;
  }
  function roomCharacter(roomId, characterId) {
    if (typeof characterId !== 'string' && typeof characterId !== 'number') {
      throw new RoomError(400, 'BAD_REQUEST', 'characterId is required');
    }
    const ch = store.getRoomCharacter(roomId, String(characterId));
    if (!ch) throw new RoomError(404, 'CHARACTER_NOT_IN_ROOM', 'Import the character into this room first');
    return ch;
  }

  /**
   * DM kicks a player: status 'kicked' (the token hash is dead from now on)
   * and any seat they controlled becomes an AI seat.
   * @param {import('./store.js').MemberAuth} auth
   * @param {string} roomId
   * @param {string} participantId
   */
  function kick(auth, roomId, participantId) {
    requireDm(auth, roomId);
    const target = store.getParticipant(roomId, String(participantId || ''));
    if (!target) throw new RoomError(404, 'NOT_FOUND', 'No such participant');
    if (target.role === 'dm') throw new RoomError(400, 'BAD_REQUEST', 'The DM cannot be kicked');
    let seats = 0;
    store.tx(() => {
      store.setParticipantStatus(roomId, target.id, 'kicked');
      seats = store.clearControllerSeats(roomId, target.id);
    })();
    events.emit('kick', { roomId, participantId: target.id });
    if (seats) events.emit('seat', { roomId });
    return { ok: true };
  }

  /**
   * Claim a seat for a player with a character imported into the room. A
   * player claims for themselves; the DM may pass `participantId`. A player
   * already seated elsewhere moves (their old seat is emptied).
   */
  function claimSeat(auth, roomId, seat, { characterId, participantId } = {}) {
    requireMember(auth, roomId);
    const n = seatNumber(seat);
    let pid = auth.participantId;
    if (auth.role === 'dm') {
      if (!participantId) throw new RoomError(400, 'BAD_REQUEST', 'The DM must name the participantId to seat (or use /ai)');
      const p = store.getParticipant(roomId, String(participantId));
      if (!p || p.status !== 'active' || p.role !== 'player') throw new RoomError(404, 'NOT_FOUND', 'No such active player');
      pid = p.id;
    } else if (participantId && participantId !== auth.participantId) {
      throw new RoomError(403, 'E_FORBIDDEN', 'Players can only seat themselves');
    }
    const ch = roomCharacter(roomId, characterId);
    store.tx(() => {
      const current = store.getSeat(roomId, n);
      if (current?.controllerParticipantId && current.controllerParticipantId !== pid) {
        throw new RoomError(409, 'E_SEAT_TAKEN', 'That seat belongs to another player');
      }
      const old = store.seatOfParticipant(roomId, pid);
      if (old !== null && old !== n) store.deleteSeat(roomId, old);
      store.upsertSeat({ id: current?.id || newId('s_'), roomId, seat: n, characterRowId: ch.id, seedParsed: ch.parsed, controller: pid, archetype: null });
    })();
    events.emit('seat', { roomId });
    return store.getSeat(roomId, n);
  }

  /** DM assigns an imported character to a seat as an AI seat with an archetype. */
  function assignAiSeat(auth, roomId, seat, { characterId, archetype = 'auto', force = false } = {}) {
    requireDm(auth, roomId);
    const n = seatNumber(seat);
    if (!AI_ARCHETYPES.includes(archetype)) {
      throw new RoomError(400, 'BAD_ARCHETYPE', `archetype must be one of ${AI_ARCHETYPES.join(', ')}`);
    }
    const ch = roomCharacter(roomId, characterId);
    store.tx(() => {
      const current = store.getSeat(roomId, n);
      if (current?.controllerParticipantId && !force) {
        throw new RoomError(409, 'E_SEAT_TAKEN', 'A player holds that seat (pass force: true to take it over)');
      }
      store.upsertSeat({ id: current?.id || newId('s_'), roomId, seat: n, characterRowId: ch.id, seedParsed: ch.parsed, controller: null, archetype });
    })();
    events.emit('seat', { roomId });
    return store.getSeat(roomId, n);
  }

  /** Empty a seat: the DM any seat, a player only their own. */
  function releaseSeat(auth, roomId, seat) {
    requireMember(auth, roomId);
    const n = seatNumber(seat);
    const current = store.getSeat(roomId, n);
    if (!current) throw new RoomError(404, 'NOT_FOUND', 'That seat is empty');
    if (auth.role !== 'dm' && current.controllerParticipantId !== auth.participantId) {
      throw new RoomError(403, 'E_FORBIDDEN', 'Not your seat');
    }
    store.deleteSeat(roomId, n);
    events.emit('seat', { roomId });
    return { ok: true };
  }

  /** Public room summary for a member (no token hashes). */
  function describe(auth, roomId) {
    requireMember(auth, roomId);
    const room = store.getRoom(roomId);
    return {
      room: { id: room.id, code: room.code, name: room.name, status: room.status, settings: normalizeRoomSettings(room.settings) },
      me: { participantId: auth.participantId, role: auth.role, displayName: auth.displayName },
      members: store.listParticipants(roomId).filter(p => p.status === 'active')
        .map(p => ({ id: p.id, displayName: p.displayName, role: p.role })),
      seats: store.listSeats(roomId).map(publicSeat)
    };
  }

  return {
    store, events,
    authenticate: store.authenticate,
    createRoom, joinRoom, kick, claimSeat, assignAiSeat, releaseSeat, describe
  };
}

/**
 * The seat as clients see it.
 * @param {ReturnType<ReturnType<typeof createRoomStore>['getSeat']>} s
 */
export function publicSeat(s) {
  return {
    seat: s.seat, slotId: s.id, characterId: s.characterId, characterName: s.characterName,
    controller: s.controllerParticipantId ? 'player' : 'ai',
    memberId: s.controllerParticipantId, aiArchetype: s.aiArchetype
  };
}
