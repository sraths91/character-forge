// M64 W5 — migration 0003 (encounters.sheets_json) and sheet recovery.
//
// Upgrade path: a DB at 0002 with a live encounter gains the nullable
// column, keeps its rows, and enforces the JSON CHECK. The journal writes
// the PC sheets at setup; after a "restart" (a fresh engine port) the
// sheets come back from the encounter row with no seats and no character
// cache, and only a pre-0003 row falls back to the seats.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { runMigrations, loadMigrations, MIGRATIONS_DIR } from '../db/migrate.js';
import { createSqliteJournal } from '../rooms/persistence.js';
import { createRoomService } from '../rooms/service.js';
import { createEngine } from '../multiplayer.js';
import { parsedDdbFixture } from '../../src/tests/helpers/entities.js';
import { tempRoot, tempDb, seedRoom } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-m0003-');
after(cleanup);

const CHECK = /CHECK constraint failed/;

test('0003 upgrades a 0002 database: sheets_json is added, NULL on existing rows, JSON-checked', async () => {
  const dir = mkdtempSync(join(root, 'up-'));
  const upTo2 = mkdtempSync(join(dir, 'migrations-'));
  for (const f of ['0001_baseline.sql', '0002_multiplayer.sql']) copyFileSync(join(MIGRATIONS_DIR, f), join(upTo2, f));
  const db = new Database(join(dir, 'cf.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  assert.equal((await runMigrations(db, { dir: upTo2, log: () => {} })).version, 2);
  db.prepare("INSERT INTO rooms (id, code, dm_token_hash, created_at, last_active_at) VALUES ('r1', 'ABC234', 'h', 1, 1)").run();
  db.prepare(`INSERT INTO encounters (id, room_id, status, engine_version, snapshot_json, created_at, updated_at)
    VALUES ('e1', 'r1', 'active', 2, '{"v":1}', 1, 1)`).run();
  assert.equal(db.prepare('PRAGMA table_info(encounters)').all().some(c => c.name === 'sheets_json'), false);

  const res = await runMigrations(db, { log: () => {} });
  assert.deepEqual(res.applied, ['0003_encounter_sheets.sql']);
  assert.equal(res.version, loadMigrations().at(-1).version);
  assert.ok(res.backupPath, 'a populated DB is backed up before 0003');
  const col = db.prepare('PRAGMA table_info(encounters)').all().find(c => c.name === 'sheets_json');
  assert.deepEqual([col.type, col.notnull, col.dflt_value], ['TEXT', 0, null]);
  const row = db.prepare("SELECT snapshot_json, sheets_json FROM encounters WHERE id = 'e1'").get();
  assert.deepEqual(row, { snapshot_json: '{"v":1}', sheets_json: null }, 'existing rows are untouched');
  assert.throws(() => db.prepare("UPDATE encounters SET sheets_json = 'nope' WHERE id = 'e1'").run(), CHECK);
  db.prepare(`UPDATE encounters SET sheets_json = '{"1":{"id":1}}' WHERE id = 'e1'`).run();
  db.close();
});

/** A built encounter for one fighter seat (no seat rows, no character cache). */
function build(engine, encounterId) {
  const seed = parsedDdbFixture('fighter-l5');
  return engine.buildEncounter({
    encounterId, seed: 9,
    setup: { map: null, grid: { cols: 6, rows: 6 }, monsters: [{ id: 'gob' }], placements: {} },
    party: [{ slotId: 's_1', seat: 1, characterId: String(seed.id), characterName: null, controller: 'ai', aiArchetype: 'fighter', seed }]
  });
}

test('sheets persist with the encounter; a fresh engine (restart) recovers them without seats or the character cache', async () => {
  const { db } = await tempDb(root);
  try {
    const { roomId } = seedRoom(db);
    const { store } = createRoomService({ db });
    const logs = [];
    const log = (level, msg) => logs.push([level, msg]);
    const journal = createSqliteJournal({ db: db.db });
    const before = createEngine({ db, store, log });
    const state = build(before, 'e-keep');
    const sheets = before.sheetsFor(state);
    journal.createEncounter({ roomId, encounterId: 'e-keep', state, engineVersion: before.version, sheets });
    assert.deepEqual(journal.sheetsFor('e-keep'), sheets);
    const cid = state.entities['pc-1'].sheetRef.characterId;
    assert.ok(sheets[cid]._aiProfile, 'the AI archetype is frozen into the stored sheet');
    assert.equal(store.listSeats(roomId).length, 0);
    assert.equal(db.getCharacterByDdbId(cid), null);

    const after = createEngine({ db, store, log });   // a new process: empty sheet cache
    assert.deepEqual(after.sheetsFor(state), sheets);
    assert.deepEqual(after.validateIntent(state, { actorId: 'pc-1', plan: { kind: 'dodge' } }).ok, true);
    assert.equal(logs.some(([l]) => l === 'warn'), false, 'no fallback was needed');

    // A pre-0003 row (no sheets) falls back to the seats, and says so.
    const old = build(before, 'e-old');
    journal.createEncounter({ roomId: seedRoom(db, { code: 'ABCDEG' }).roomId, encounterId: 'e-old', state: old, engineVersion: before.version });
    assert.equal(journal.sheetsFor('e-old'), null);
    assert.throws(() => createEngine({ db, store, log }).sheetsFor(old), /no character sheet for pc-1/);
    assert.ok(logs.some(([l, m]) => l === 'warn' && /pre-0003/.test(m)));
  } finally { db.close(); }
});
