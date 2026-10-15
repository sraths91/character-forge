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
      WHERE rc.room_id = ? AND c.ddb_id = ?`)
  };

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

  return { authenticate, addRoomCharacter, listRoomCharacters, getRoomCharacter };
}
