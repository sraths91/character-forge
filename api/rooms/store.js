// SQLite access for rooms, participants, seats and room-scoped characters
// (M64 B4/B6). Every statement is prepared once, when the store is built.

import { hashToken } from './tokens.js';

/**
 * @typedef {object} MemberAuth
 * @property {string} participantId
 * @property {string} roomId
 * @property {'dm'|'player'} role
 * @property {string} displayName
 */

/**
 * Build the room store over a migrated connection (schema >= 0002).
 * @param {import('better-sqlite3').Database} conn
 * @param {{now?: () => number}} [opts]
 */
export function createRoomStore(conn, { now = Date.now } = {}) {
  const q = {
    playerByHash: conn.prepare(`
      SELECT p.id, p.room_id, p.role, p.display_name
      FROM participants p JOIN rooms r ON r.id = p.room_id
      WHERE p.token_hash = ? AND p.status = 'active' AND r.status <> 'closed'`),
    dmByHash: conn.prepare(`
      SELECT p.id, p.room_id, p.role, p.display_name
      FROM rooms r JOIN participants p ON p.room_id = r.id AND p.role = 'dm' AND p.status = 'active'
      WHERE r.dm_token_hash = ? AND r.status <> 'closed'`),
    addRoomCharacter: conn.prepare(`
      INSERT INTO room_characters (room_id, character_id, participant_id, added_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(room_id, character_id) DO NOTHING`),
    listRoomCharacters: conn.prepare(`
      SELECT c.ddb_id, c.name, c.source, c.updated_at
      FROM room_characters rc JOIN characters c ON c.id = rc.character_id
      WHERE rc.room_id = ? ORDER BY c.updated_at DESC LIMIT ?`),
    roomHasCharacter: conn.prepare(`
      SELECT c.id, c.ddb_id, c.name, c.parsed_json
      FROM room_characters rc JOIN characters c ON c.id = rc.character_id
      WHERE rc.room_id = ? AND c.ddb_id = ?`),

    insertRoom: conn.prepare(`
      INSERT INTO rooms (id, code, dm_token_hash, name, settings_json, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    roomById: conn.prepare('SELECT * FROM rooms WHERE id = ?'),
    openRoomByCode: conn.prepare("SELECT * FROM rooms WHERE code = ? AND status <> 'closed'"),
    setRoomStatus: conn.prepare('UPDATE rooms SET status = ?, last_active_at = ?, closed_at = ? WHERE id = ?'),
    touchRoom: conn.prepare('UPDATE rooms SET last_active_at = ? WHERE id = ?'),
    setRoomSeq: conn.prepare('UPDATE rooms SET seq = ?, last_active_at = ? WHERE id = ? AND seq < ?'),
    setRoomSettings: conn.prepare('UPDATE rooms SET settings_json = ? WHERE id = ?'),
    insertParticipant: conn.prepare(`
      INSERT INTO participants (id, room_id, display_name, role, token_hash, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    participant: conn.prepare('SELECT * FROM participants WHERE id = ? AND room_id = ?'),
    participants: conn.prepare('SELECT * FROM participants WHERE room_id = ? ORDER BY created_at, id'),
    countActivePlayers: conn.prepare("SELECT COUNT(*) AS n FROM participants WHERE room_id = ? AND role = 'player' AND status = 'active'"),
    setParticipantStatus: conn.prepare('UPDATE participants SET status = ? WHERE id = ? AND room_id = ?'),
    touchParticipant: conn.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?'),
    seats: conn.prepare(`
      SELECT s.*, c.ddb_id AS character_ddb_id, c.name AS character_name
      FROM party_slots s LEFT JOIN characters c ON c.id = s.character_id
      WHERE s.room_id = ? ORDER BY s.seat`),
    seat: conn.prepare(`
      SELECT s.*, c.ddb_id AS character_ddb_id, c.name AS character_name
      FROM party_slots s LEFT JOIN characters c ON c.id = s.character_id
      WHERE s.room_id = ? AND s.seat = ?`),
    seatOf: conn.prepare('SELECT * FROM party_slots WHERE room_id = ? AND controller_participant_id = ?'),
    upsertSeat: conn.prepare(`
      INSERT INTO party_slots (id, room_id, seat, character_id, seed_parsed_json, controller_participant_id,
        ai_archetype, claimed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, seat) DO UPDATE SET
        character_id = excluded.character_id,
        seed_parsed_json = excluded.seed_parsed_json,
        sheet_json = CASE WHEN party_slots.character_id IS excluded.character_id THEN party_slots.sheet_json END,
        state_json = CASE WHEN party_slots.character_id IS excluded.character_id THEN party_slots.state_json END,
        controller_participant_id = excluded.controller_participant_id,
        ai_archetype = excluded.ai_archetype,
        claimed_at = excluded.claimed_at,
        updated_at = excluded.updated_at`),
    deleteSeat: conn.prepare('DELETE FROM party_slots WHERE room_id = ? AND seat = ?'),
    setDmTokenHash: conn.prepare('UPDATE rooms SET dm_token_hash = ?, last_active_at = ? WHERE id = ?'),
    setSeatController: conn.prepare('UPDATE party_slots SET controller_participant_id = ?, claimed_at = ?, updated_at = ? WHERE room_id = ? AND id = ?'),
    seatById: conn.prepare(`
      SELECT s.*, c.ddb_id AS character_ddb_id, c.name AS character_name
      FROM party_slots s LEFT JOIN characters c ON c.id = s.character_id
      WHERE s.room_id = ? AND s.id = ?`),
    clearController: conn.prepare(`
      UPDATE party_slots SET controller_participant_id = NULL, updated_at = ?
      WHERE room_id = ? AND controller_participant_id = ?`)
  };

  const tx = (fn) => conn.transaction(fn);

  /**
   * Resolve a bearer token (player or DM) to its member, or null.
   * @param {string|null|undefined} token
   * @returns {MemberAuth|null}
   */
  function authenticate(token) {
    if (!token) return null;
    const h = hashToken(token);
    const row = q.playerByHash.get(h) || q.dmByHash.get(h);
    if (!row) return null;
    return { participantId: row.id, roomId: row.room_id, role: row.role, displayName: row.display_name };
  }

  /**
   * Record that a character was imported into a room.
   * @param {{roomId: string, characterId: number, participantId?: string|null}} args
   */
  function addRoomCharacter({ roomId, characterId, participantId = null }) {
    q.addRoomCharacter.run(roomId, characterId, participantId, now());
  }

  /**
   * Characters imported into a room, newest first.
   * @param {string} roomId
   * @param {number} [limit=50]
   */
  function listRoomCharacters(roomId, limit = 50) {
    return q.listRoomCharacters.all(roomId, limit).map(r => ({
      ddbId: r.ddb_id, name: r.name, source: r.source, updatedAt: r.updated_at
    }));
  }

  /**
   * A room-scoped character by ddb id, or null.
   * @param {string} roomId
   * @param {string} ddbId
   * @returns {{id: number, ddbId: string, name: string, parsed: object}|null}
   */
  function getRoomCharacter(roomId, ddbId) {
    const r = q.roomHasCharacter.get(roomId, String(ddbId));
    return r ? { id: r.id, ddbId: r.ddb_id, name: r.name, parsed: JSON.parse(r.parsed_json) } : null;
  }

  const roomRow = (r) => r && ({
    id: r.id, code: r.code, name: r.name, status: r.status, seq: r.seq,
    settings: JSON.parse(r.settings_json), createdAt: r.created_at, lastActiveAt: r.last_active_at, closedAt: r.closed_at
  });
  const memberRow = (p) => p && ({
    id: p.id, roomId: p.room_id, displayName: p.display_name, role: p.role, status: p.status,
    createdAt: p.created_at, lastSeenAt: p.last_seen_at
  });
  const seatRow = (s) => s && ({
    id: s.id, roomId: s.room_id, seat: s.seat, characterId: s.character_ddb_id ?? null,
    characterName: s.character_name ?? null, controllerParticipantId: s.controller_participant_id,
    aiArchetype: s.ai_archetype, claimedAt: s.claimed_at,
    seed: s.seed_parsed_json ? JSON.parse(s.seed_parsed_json) : null,
    state: s.state_json ? JSON.parse(s.state_json) : null,
    // M65: the run columns (null / defaults outside a run).
    runId: s.run_id ?? null, characterRowId: s.character_id ?? null,
    sheet: s.sheet_json ? JSON.parse(s.sheet_json) : null
  });

  return {
    tx,
    authenticate, addRoomCharacter, listRoomCharacters, getRoomCharacter,
    /** @param {{id, code, dmTokenHash, name, settings, now}} r */
    insertRoom: (r) => q.insertRoom.run(r.id, r.code, r.dmTokenHash, r.name ?? null, JSON.stringify(r.settings || {}), r.now, r.now),
    getRoom: (id) => roomRow(q.roomById.get(id)),
    getOpenRoomByCode: (code) => roomRow(q.openRoomByCode.get(code)),
    setRoomStatus: (id, status) => q.setRoomStatus.run(status, now(), status === 'closed' ? now() : null, id),
    touchRoom: (id) => q.touchRoom.run(now(), id),
    /** Persist the room seq (monotonic: never moves backwards). */
    setRoomSeq: (id, seq) => q.setRoomSeq.run(seq, now(), id, seq),
    setRoomSettings: (id, settings) => q.setRoomSettings.run(JSON.stringify(settings), id),
    /** @param {{id, roomId, displayName, role, tokenHash}} p */
    insertParticipant: (p) => q.insertParticipant.run(p.id, p.roomId, p.displayName, p.role, p.tokenHash ?? null, now(), now()),
    getParticipant: (roomId, id) => memberRow(q.participant.get(id, roomId)),
    listParticipants: (roomId) => q.participants.all(roomId).map(memberRow),
    countActivePlayers: (roomId) => q.countActivePlayers.get(roomId).n,
    setParticipantStatus: (roomId, id, status) => q.setParticipantStatus.run(status, id, roomId).changes > 0,
    touchParticipant: (id) => q.touchParticipant.run(now(), id),
    listSeats: (roomId) => q.seats.all(roomId).map(seatRow),
    getSeat: (roomId, seat) => seatRow(q.seat.get(roomId, seat)),
    seatOfParticipant: (roomId, pid) => q.seatOf.get(roomId, pid)?.seat ?? null,
    /** @param {{id, roomId, seat, characterRowId, seedParsed, controller, archetype}} s */
    upsertSeat: (s) => q.upsertSeat.run(s.id, s.roomId, s.seat, s.characterRowId, JSON.stringify(s.seedParsed),
      s.controller ?? null, s.archetype ?? null, now(), now()),
    deleteSeat: (roomId, seat) => q.deleteSeat.run(roomId, seat).changes > 0,
    /** A seat by its slot id, or null. */
    getSeatById: (roomId, slotId) => seatRow(q.seatById.get(roomId, slotId)),
    /** Hand a seat to another participant (seat.reclaim); null = AI. */
    setSeatController: (roomId, slotId, pid) => q.setSeatController.run(pid ?? null, now(), now(), roomId, slotId).changes > 0,
    /** Replace the room's DM token hash (DM recovery with the campaign key, M65 B26). */
    setDmTokenHash: (roomId, hash) => q.setDmTokenHash.run(hash, now(), roomId).changes > 0,
    clearControllerSeats: (roomId, pid) => q.clearController.run(now(), roomId, pid).changes
  };
}
