// Schema tests for 0002_multiplayer.sql (M64 B2): every CHECK, every
// partial unique index, and the cascade on room delete. Temp-file DBs only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../db/database.js';

const quiet = () => {};
const root = mkdtempSync(join(tmpdir(), 'cf-m0002-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
async function fresh() {
  const h = await openDb(join(root, `t${++n}.db`), { log: quiet });
  return h;
}

const CHECK = /CHECK constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;
const FK = /FOREIGN KEY constraint failed/;
const NOT_NULL = /NOT NULL constraint failed/;

function seedRoom(db, { id = 'r1', code = 'ABC234', status = 'lobby', dmHash = `h-${id}` } = {}) {
  db.prepare(`INSERT INTO rooms (id, code, dm_token_hash, status, created_at, last_active_at)
    VALUES (?, ?, ?, ?, 1, 1)`).run(id, code, dmHash, status);
}
function seedParticipant(db, { id, room = 'r1', role = 'player', token = `t-${id}`, status = 'active', name = 'Pat' }) {
  db.prepare(`INSERT INTO participants (id, room_id, display_name, role, token_hash, status, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1)`).run(id, room, name, role, token, status);
}
function seedCharacter(db, ddbId = 'c1') {
  return db.prepare(`INSERT INTO characters (ddb_id, name, raw_json, parsed_json, source, created_at, updated_at)
    VALUES (?, 'C', '{}', '{}', 'url', 1, 1) RETURNING id`).get(ddbId).id;
}
function seedSlot(db, { id, room = 'r1', seat, characterId = null, controller = null, seed = null, state = null, archetype = null }) {
  db.prepare(`INSERT INTO party_slots (id, room_id, seat, character_id, seed_parsed_json, state_json,
    controller_participant_id, ai_archetype, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, room, seat, characterId, seed, state, controller, archetype);
}
function seedEncounter(db, { id, room = 'r1', status = 'setup', snapshot = '{}', snapSeq = 0, headSeq = 0, turnLog = null }) {
  db.prepare(`INSERT INTO encounters (id, room_id, status, engine_version, snapshot_json, snapshot_seq, head_seq,
    turn_log_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, 1)`)
    .run(id, room, status, snapshot, snapSeq, headSeq, turnLog);
}

test('0002 creates every multiplayer table as STRICT', async () => {
  const h = await fresh();
  const tables = ['users', 'rooms', 'participants', 'room_characters', 'party_slots', 'uploaded_maps', 'encounters', 'encounter_events'];
  for (const t of tables) {
    const sql = h.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t)?.sql;
    assert.ok(sql, `${t} exists`);
    assert.match(sql, /STRICT/, `${t} is STRICT`);
  }
  assert.match(h.db.prepare("SELECT sql FROM sqlite_master WHERE name='encounter_events'").get().sql, /WITHOUT ROWID/);
  h.close();
});

test('rooms: code shape CHECK (6 Crockford base32 chars)', async () => {
  const h = await fresh();
  seedRoom(h.db, { id: 'ok', code: '0123ZZ' });
  for (const [i, bad] of ['ABCDE', 'ABCDEFG', 'ABCDEI', 'ABCDEL', 'ABCDEO', 'ABCDEU', 'abcdef', 'ABC-12'].entries()) {
    assert.throws(() => seedRoom(h.db, { id: `b${i}`, code: bad }), CHECK, bad);
  }
  h.close();
});

test('rooms: status CHECK, name length CHECK, settings json CHECK, seq CHECK', async () => {
  const h = await fresh();
  assert.throws(() => seedRoom(h.db, { id: 'x', status: 'open' }), CHECK);
  seedRoom(h.db);
  assert.throws(() => h.db.prepare("UPDATE rooms SET name = ? WHERE id='r1'").run('n'.repeat(65)), CHECK);
  h.db.prepare("UPDATE rooms SET name = ? WHERE id='r1'").run('n'.repeat(64));
  assert.throws(() => h.db.prepare("UPDATE rooms SET settings_json = 'nope' WHERE id='r1'").run(), CHECK);
  assert.throws(() => h.db.prepare("UPDATE rooms SET seq = -1 WHERE id='r1'").run(), CHECK);
  h.close();
});

test('rooms: open codes are unique, a closed room frees its code', async () => {
  const h = await fresh();
  seedRoom(h.db, { id: 'a', code: 'QQQQQQ' });
  assert.throws(() => seedRoom(h.db, { id: 'b', code: 'QQQQQQ' }), UNIQUE);
  h.db.prepare("UPDATE rooms SET status='closed' WHERE id='a'").run();
  seedRoom(h.db, { id: 'b', code: 'QQQQQQ' });
  // dm token hashes are globally unique
  assert.throws(() => seedRoom(h.db, { id: 'c', code: 'RRRRRR', dmHash: 'h-b' }), UNIQUE);
  h.close();
});

test('participants: role, status, name length and player-needs-token CHECKs', async () => {
  const h = await fresh();
  seedRoom(h.db);
  assert.throws(() => seedParticipant(h.db, { id: 'p0', role: 'admin' }), CHECK);
  assert.throws(() => seedParticipant(h.db, { id: 'p0', status: 'banned' }), CHECK);
  assert.throws(() => seedParticipant(h.db, { id: 'p0', name: '' }), CHECK);
  assert.throws(() => seedParticipant(h.db, { id: 'p0', name: 'x'.repeat(33) }), CHECK);
  assert.throws(() => seedParticipant(h.db, { id: 'p0', token: null }), CHECK);
  seedParticipant(h.db, { id: 'dm', role: 'dm', token: null, name: 'DM' });
  seedParticipant(h.db, { id: 'p1', name: 'x'.repeat(32) });
  assert.throws(() => seedParticipant(h.db, { id: 'p2', token: 't-p1' }), UNIQUE);
  assert.throws(() => seedParticipant(h.db, { id: 'p3', room: 'nope' }), FK);
  h.close();
});

test('participants: one active DM per room (partial unique index)', async () => {
  const h = await fresh();
  seedRoom(h.db);
  seedParticipant(h.db, { id: 'dm1', role: 'dm', token: null });
  assert.throws(() => seedParticipant(h.db, { id: 'dm2', role: 'dm', token: null }), UNIQUE);
  h.db.prepare("UPDATE participants SET status='left' WHERE id='dm1'").run();
  seedParticipant(h.db, { id: 'dm2', role: 'dm', token: null });
  h.close();
});

test('party_slots: seat range, json, archetype and controller-needs-character CHECKs', async () => {
  const h = await fresh();
  seedRoom(h.db);
  seedParticipant(h.db, { id: 'p1' });
  const cid = seedCharacter(h.db);
  assert.throws(() => seedSlot(h.db, { id: 's0', seat: 0 }), CHECK);
  assert.throws(() => seedSlot(h.db, { id: 's7', seat: 7 }), CHECK);
  assert.throws(() => seedSlot(h.db, { id: 'sj', seat: 1, state: 'not json' }), CHECK);
  assert.throws(() => seedSlot(h.db, { id: 'sa', seat: 1, archetype: '' }), CHECK);
  assert.throws(() => seedSlot(h.db, { id: 'sc', seat: 1, controller: 'p1' }), CHECK);
  seedSlot(h.db, { id: 's1', seat: 1, characterId: cid, controller: 'p1', state: '{"schema_v":1}' });
  seedSlot(h.db, { id: 's6', seat: 6, characterId: cid, archetype: 'brute' });
  h.close();
});

test('party_slots: UNIQUE(room, seat) and one seat per player (partial unique index)', async () => {
  const h = await fresh();
  seedRoom(h.db);
  seedParticipant(h.db, { id: 'p1' });
  const cid = seedCharacter(h.db);
  seedSlot(h.db, { id: 's1', seat: 1, characterId: cid, controller: 'p1' });
  assert.throws(() => seedSlot(h.db, { id: 's1b', seat: 1, characterId: cid }), UNIQUE);
  assert.throws(() => seedSlot(h.db, { id: 's2', seat: 2, characterId: cid, controller: 'p1' }), UNIQUE);
  // Any number of AI seats (NULL controller).
  seedSlot(h.db, { id: 's3', seat: 3, characterId: cid });
  seedSlot(h.db, { id: 's4', seat: 4, characterId: cid });
  // Deleting the participant turns the seat into an AI seat.
  h.db.prepare("DELETE FROM participants WHERE id='p1'").run();
  assert.equal(h.db.prepare("SELECT controller_participant_id AS c FROM party_slots WHERE id='s1'").get().c, null);
  h.close();
});

test('uploaded_maps: mime, size, dimension, pixel-count, sha and grid CHECKs; per-room sha unique', async () => {
  const h = await fresh();
  seedRoom(h.db);
  const sha = 'a'.repeat(64);
  const ins = (id, o = {}) => h.db.prepare(`INSERT INTO uploaded_maps (id, room_id, rel_path, mime, bytes, sha256, width, height, grid_json, created_at)
    VALUES (?, 'r1', 'maps/r1/x.png', ?, ?, ?, ?, ?, ?, 1)`).run(id, o.mime ?? 'image/png', o.bytes ?? 10, o.sha ?? sha,
    o.w ?? 100, o.h ?? 100, o.grid ?? null);
  assert.throws(() => ins('m', { mime: 'image/gif' }), CHECK);
  assert.throws(() => ins('m', { mime: 'image/svg+xml' }), CHECK);
  assert.throws(() => ins('m', { bytes: 0 }), CHECK);
  assert.throws(() => ins('m', { w: 0 }), CHECK);
  assert.throws(() => ins('m', { h: 8193 }), CHECK);
  assert.throws(() => ins('m', { w: 8192, h: 8192 }), CHECK); // 67 MP > 16.7 MP
  assert.throws(() => ins('m', { sha: 'abc' }), CHECK);
  assert.throws(() => ins('m', { grid: '{' }), CHECK);
  ins('m1', { w: 4096, h: 4096, grid: '{"cellPx":70}' });
  assert.throws(() => ins('m2'), UNIQUE);
  ins('m3', { sha: 'b'.repeat(64) });
  h.close();
});

test('encounters: status, json and seq-order CHECKs; one live encounter per room', async () => {
  const h = await fresh();
  seedRoom(h.db);
  assert.throws(() => seedEncounter(h.db, { id: 'e', status: 'running' }), CHECK);
  assert.throws(() => seedEncounter(h.db, { id: 'e', snapshot: '{bad' }), CHECK);
  assert.throws(() => seedEncounter(h.db, { id: 'e', snapSeq: 5, headSeq: 4 }), CHECK);
  assert.throws(() => seedEncounter(h.db, { id: 'e', snapSeq: -1, headSeq: 0 }), CHECK);
  assert.throws(() => seedEncounter(h.db, { id: 'e', turnLog: 'x' }), CHECK);
  assert.throws(() => h.db.prepare(`INSERT INTO encounters (id, room_id, snapshot_json, created_at, updated_at)
    VALUES ('e', 'r1', '{}', 1, 1)`).run(), NOT_NULL); // engine_version required
  seedEncounter(h.db, { id: 'e1', status: 'setup' });
  assert.throws(() => seedEncounter(h.db, { id: 'e2', status: 'active' }), UNIQUE);
  seedEncounter(h.db, { id: 'e3', status: 'ended' });
  seedEncounter(h.db, { id: 'e4', status: 'abandoned' });
  h.db.prepare("UPDATE encounters SET status='ended' WHERE id='e1'").run();
  seedEncounter(h.db, { id: 'e5', status: 'active', snapSeq: 3, headSeq: 7 });
  h.close();
});

test('encounter_events: seq >= 1, json CHECK, (encounter, seq) primary key', async () => {
  const h = await fresh();
  seedRoom(h.db);
  seedEncounter(h.db, { id: 'e1' });
  const ins = (seq, json = '{}') => h.db.prepare(`INSERT INTO encounter_events (encounter_id, seq, type, event_json, created_at)
    VALUES ('e1', ?, 'move', ?, 1)`).run(seq, json);
  assert.throws(() => ins(0), CHECK);
  assert.throws(() => ins(1, 'nope'), CHECK);
  ins(1);
  assert.throws(() => ins(1), /UNIQUE|PRIMARY KEY/);
  assert.throws(() => h.db.prepare(`INSERT INTO encounter_events (encounter_id, seq, type, event_json, created_at)
    VALUES ('missing', 1, 'move', '{}', 1)`).run(), FK);
  h.close();
});

test('users stub: provider identity unique; deleting a user nulls participants.user_id', async () => {
  const h = await fresh();
  h.db.prepare("INSERT INTO users (id, provider, provider_user_id, created_at) VALUES ('u1', 'discord', '42', 1)").run();
  assert.throws(() => h.db.prepare("INSERT INTO users (id, provider, provider_user_id, created_at) VALUES ('u2', 'discord', '42', 1)").run(), UNIQUE);
  seedRoom(h.db);
  seedParticipant(h.db, { id: 'p1' });
  h.db.prepare("UPDATE participants SET user_id='u1' WHERE id='p1'").run();
  h.db.prepare("DELETE FROM users WHERE id='u1'").run();
  assert.equal(h.db.prepare("SELECT user_id FROM participants WHERE id='p1'").get().user_id, null);
  h.close();
});

test('deleting a room cascades to every child table but keeps characters', async () => {
  const h = await fresh();
  seedRoom(h.db);
  seedParticipant(h.db, { id: 'p1' });
  const cid = seedCharacter(h.db);
  h.db.prepare("INSERT INTO room_characters (room_id, character_id, participant_id, added_at) VALUES ('r1', ?, 'p1', 1)").run(cid);
  seedSlot(h.db, { id: 's1', seat: 1, characterId: cid, controller: 'p1' });
  h.db.prepare(`INSERT INTO uploaded_maps (id, room_id, rel_path, mime, bytes, sha256, width, height, created_at)
    VALUES ('m1', 'r1', 'maps/r1/x.png', 'image/png', 1, ?, 1, 1, 1)`).run('c'.repeat(64));
  seedEncounter(h.db, { id: 'e1', headSeq: 1 });
  h.db.prepare("UPDATE encounters SET map_id='m1' WHERE id='e1'").run();
  h.db.prepare("INSERT INTO encounter_events (encounter_id, seq, type, event_json, created_at) VALUES ('e1', 1, 'move', '{}', 1)").run();

  h.db.prepare("DELETE FROM rooms WHERE id='r1'").run();
  for (const t of ['participants', 'room_characters', 'party_slots', 'uploaded_maps', 'encounters', 'encounter_events']) {
    assert.equal(h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM characters').get().n, 1);
  h.close();
});

test('deleting a character nulls seats and drops room_characters rows', async () => {
  const h = await fresh();
  seedRoom(h.db);
  const cid = seedCharacter(h.db);
  h.db.prepare("INSERT INTO room_characters (room_id, character_id, added_at) VALUES ('r1', ?, 1)").run(cid);
  seedSlot(h.db, { id: 's1', seat: 1, characterId: cid, seed: '{}' });
  h.db.prepare('DELETE FROM characters WHERE id = ?').run(cid);
  assert.equal(h.db.prepare("SELECT character_id FROM party_slots WHERE id='s1'").get().character_id, null);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM room_characters').get().n, 0);
  h.close();
});
