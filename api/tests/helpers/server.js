// Shared helpers for the API tests (M64 Wave 3). Temp-file DBs only.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../../db/database.js';
import { generateToken, hashToken, newId } from '../../rooms/tokens.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const quiet = () => {};

/** A temp root removed by the returned cleanup. */
export function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Open a migrated temp-file DB under `root`. */
export async function tempDb(root, name = 'test.db') {
  const dir = mkdtempSync(join(root, 'db-'));
  return { dir, db: await openDb(join(dir, name), { log: quiet }) };
}

/** A synthetic DDB fixture (data object), by name: cleric-l5 | fighter-l5 | wizard-l5. */
export function ddbFixture(name = 'fighter-l5') {
  const raw = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'src', 'tests', 'fixtures', 'ddb', `${name}.json`), 'utf8'));
  return raw.data || raw;
}

/**
 * Insert a room plus its DM participant directly (bypassing the HTTP API).
 * @returns {{roomId: string, dmToken: string, dmId: string, code: string}}
 */
export function seedRoom(handle, { code = 'ABCDEF' } = {}) {
  const roomId = newId();
  const dmToken = generateToken();
  const dmId = newId('p_');
  handle.db.prepare(`INSERT INTO rooms (id, code, dm_token_hash, created_at, last_active_at) VALUES (?, ?, ?, 1, 1)`)
    .run(roomId, code, hashToken(dmToken));
  handle.db.prepare(`INSERT INTO participants (id, room_id, display_name, role, created_at, last_seen_at)
    VALUES (?, ?, 'DM', 'dm', 1, 1)`).run(dmId, roomId);
  return { roomId, dmToken, dmId, code };
}

/** Insert a player into a room. @returns {{id: string, token: string}} */
export function seedPlayer(handle, roomId, name = 'Pat') {
  const id = newId('p_');
  const token = generateToken();
  handle.db.prepare(`INSERT INTO participants (id, room_id, display_name, role, token_hash, created_at, last_seen_at)
    VALUES (?, ?, ?, 'player', ?, 1, 1)`).run(id, roomId, name, hashToken(token));
  return { id, token };
}

/** JSON fetch helper: returns {status, body, headers}. */
export async function api(base, path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}
