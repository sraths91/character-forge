// Migration runner tests (M64 B1). Every DB here is a temp file under
// os.tmpdir() — never the repo's character-forge.db or a Railway volume.
// File-backed rather than :memory: because WAL and backups behave
// differently in memory (E6 §4c).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMigrations, loadMigrations, getMigrationVersion, MIGRATIONS_DIR } from '../db/migrate.js';
import { createQueries, openDb } from '../db/database.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const V0_SCHEMA = readFileSync(join(HERE, 'fixtures', 'db', 'v0-schema.sql'), 'utf8');
const quiet = () => {};

const root = mkdtempSync(join(tmpdir(), 'cf-migrate-'));
after(() => rmSync(root, { recursive: true, force: true }));

function tempDir() {
  return mkdtempSync(join(root, 'case-'));
}
function openFile(dir, name = 'test.db') {
  const db = new Database(join(dir, name));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
// Copies only the baseline so these tests can plant their own 0002+ files.
function migrationsCopy(dir) {
  const target = mkdtempSync(join(dir, 'migrations-'));
  copyFileSync(join(MIGRATIONS_DIR, '0001_baseline.sql'), join(target, '0001_baseline.sql'));
  return target;
}
const SHIPPED = loadMigrations();
const LATEST = SHIPPED[SHIPPED.length - 1].version;
const SHIPPED_NAMES = SHIPPED.map(m => m.name);
function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(r => r.name);
}
function masterSnapshot(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}

test('baseline migration is byte-identical to the frozen v0 schema', () => {
  assert.equal(readFileSync(join(MIGRATIONS_DIR, '0001_baseline.sql'), 'utf8'), V0_SCHEMA);
});

test('fresh DB: all tables created, version recorded, no backup taken', async () => {
  const dir = tempDir();
  const db = openFile(dir);
  const res = await runMigrations(db, { log: quiet });
  assert.deepEqual(res.applied, SHIPPED_NAMES);
  assert.equal(res.version, LATEST);
  assert.equal(res.backupPath, null);
  for (const t of ['characters', 'item_sprites', 'monsters', 'schema_migrations']) assert.ok(tableNames(db).includes(t), t);
  assert.equal(getMigrationVersion(db), LATEST);
  assert.equal(db.pragma('user_version', { simple: true }), LATEST);
  const row = db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version').get();
  assert.equal(row.name, '0001_baseline.sql');
  assert.match(row.checksum, /^[a-f0-9]{64}$/);
  assert.ok(row.applied_at > 0);
  assert.ok(!readdirSync(dir).some(f => f.endsWith('.bak')));
  db.close();
});

test('re-running is a no-op', async () => {
  const dir = tempDir();
  const db = openFile(dir);
  await runMigrations(db, { log: quiet });
  const before = db.prepare('SELECT * FROM schema_migrations').all();
  const res = await runMigrations(db, { log: quiet });
  assert.deepEqual(res.applied, []);
  assert.equal(res.version, LATEST);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(), before);
  db.close();
});

test('editing an applied migration file refuses to boot', async () => {
  const dir = tempDir();
  const migs = migrationsCopy(dir);
  const db = openFile(dir);
  await runMigrations(db, { dir: migs, log: quiet });
  appendFileSync(join(migs, '0001_baseline.sql'), '\n-- sneaky edit\n');
  await assert.rejects(runMigrations(db, { dir: migs, log: quiet }), /edited after it was applied/);
  db.close();
});

test('a broken migration leaves no partial tables and no schema_migrations row', async () => {
  const dir = tempDir();
  const migs = migrationsCopy(dir);
  writeFileSync(join(migs, '0002_broken.sql'),
    'CREATE TABLE partial_a (x INTEGER);\nCREATE TABLE partial_b (y INTEGER);\nCREATE TABLE oops (\n');
  const db = openFile(dir);
  await assert.rejects(runMigrations(db, { dir: migs, log: quiet }), /0002_broken\.sql failed and was rolled back/);
  const names = tableNames(db);
  assert.ok(!names.includes('partial_a'));
  assert.ok(!names.includes('partial_b'));
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version), [1]);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  db.close();
});

test('v0 database keeps its rows, is backed up, and reads through the query API', async () => {
  const dir = tempDir();
  const path = join(dir, 'character-forge.db');
  const seed = new Database(path);
  seed.pragma('journal_mode = WAL');
  seed.exec(V0_SCHEMA);
  const parsed = { id: 'v0-1', name: 'Seed Fighter', level: 5 };
  seed.prepare(`INSERT INTO characters (ddb_id, name, raw_json, parsed_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('v0-1', 'Seed Fighter', '{"id":"v0-1"}', JSON.stringify(parsed), 'paste', 1, 2);
  seed.close();

  const db = openFile(dir, 'character-forge.db');
  const res = await runMigrations(db, { log: quiet });
  assert.deepEqual(res.applied, SHIPPED_NAMES);
  assert.equal(res.backupPath, `${path}.pre-0001.bak`);
  assert.ok(existsSync(res.backupPath));

  const got = createQueries(db).getCharacterByDdbId('v0-1');
  assert.equal(got.name, 'Seed Fighter');
  assert.equal(got.source, 'paste');
  assert.deepEqual(got.parsed, parsed);
  db.close();

  const bak = new Database(res.backupPath, { readonly: true });
  assert.equal(bak.prepare('SELECT COUNT(*) AS n FROM characters').get().n, 1);
  assert.equal(getMigrationVersion(bak), 0);
  bak.close();
});

test('sqlite_master of a fresh DB equals that of a DB upgraded from v0', async () => {
  const dir = tempDir();
  const fresh = openFile(dir, 'fresh.db');
  await runMigrations(fresh, { log: quiet });

  const upgraded = openFile(dir, 'upgraded.db');
  upgraded.exec(V0_SCHEMA);
  await runMigrations(upgraded, { log: quiet });

  assert.deepEqual(masterSnapshot(upgraded), masterSnapshot(fresh));
  fresh.close();
  upgraded.close();
});

test('a database newer than the code refuses to boot', async () => {
  const dir = tempDir();
  const db = openFile(dir);
  await runMigrations(db, { log: quiet });
  db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (9999, '9999_future.sql', 'x', 1)").run();
  await assert.rejects(runMigrations(db, { log: quiet }), new RegExp(`version 9999 but this code only knows up to ${LATEST}`));
  db.close();
});

test('an applied migration missing from the code refuses to boot', async () => {
  const dir = tempDir();
  const migs = migrationsCopy(dir);
  writeFileSync(join(migs, '0002_extra.sql'), 'CREATE TABLE extra (x INTEGER);\n');
  writeFileSync(join(migs, '0003_more.sql'), 'CREATE TABLE more (x INTEGER);\n');
  const db = openFile(dir);
  await runMigrations(db, { dir: migs, log: quiet });
  rmSync(join(migs, '0002_extra.sql'));
  await assert.rejects(runMigrations(db, { dir: migs, log: quiet }), /0002_extra\.sql is missing/);
  db.close();
});

test('pre-migration backups are pruned to the last three', async () => {
  const dir = tempDir();
  const migs = migrationsCopy(dir);
  const db = openFile(dir, 'keep.db');
  await runMigrations(db, { dir: migs, log: quiet });
  for (let v = 2; v <= 5; v++) {
    writeFileSync(join(migs, `000${v}_t${v}.sql`), `CREATE TABLE t${v} (x INTEGER);\n`);
    const res = await runMigrations(db, { dir: migs, log: quiet });
    assert.equal(res.backupPath, join(dir, `keep.db.pre-000${v}.bak`));
  }
  const baks = readdirSync(dir).filter(f => f.endsWith('.bak')).sort();
  assert.deepEqual(baks, ['keep.db.pre-0003.bak', 'keep.db.pre-0004.bak', 'keep.db.pre-0005.bak']);
  assert.equal(getMigrationVersion(db), 5);
  db.close();
});

test('in-memory DBs migrate without a backup', async () => {
  const db = new Database(':memory:');
  db.exec(V0_SCHEMA);
  const res = await runMigrations(db, { log: quiet });
  assert.equal(res.version, LATEST);
  assert.equal(res.backupPath, null);
  db.close();
});

test('getMigrationVersion is 0 before the runner has ever run', () => {
  const db = new Database(':memory:');
  assert.equal(getMigrationVersion(db), 0);
  db.close();
});

test('loadMigrations rejects bad names, duplicates and transaction control', () => {
  const dir = tempDir();
  const bad = (files) => {
    const d = mkdtempSync(join(dir, 'm-'));
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(d, name), sql);
    return d;
  };
  assert.throws(() => loadMigrations(bad({ '2_oops.sql': 'SELECT 1;' })), /bad migration file name/);
  assert.throws(() => loadMigrations(bad({ '0002_a.sql': 'SELECT 1;', '0002_b.sql': 'SELECT 1;' })), /duplicate migration version 0002/);
  assert.throws(() => loadMigrations(bad({ '0002_tx.sql': 'BEGIN;\nCREATE TABLE z (x);\nCOMMIT;\n' })), /transaction control/);
  assert.throws(() => loadMigrations(bad({ '0002_fk.sql': 'PRAGMA foreign_keys = OFF;\n' })), /transaction control/);
  const ok = loadMigrations(bad({ '0002_b.sql': 'SELECT 2;', '0001_a.sql': 'SELECT 1;', 'README.md': 'x' }));
  assert.deepEqual(ok.map(m => m.version), [1, 2]);
});

test('openDb migrates, exposes the version, and refuses a newer DB', async () => {
  const dir = tempDir();
  const path = join(dir, 'open.db');
  const h = await openDb(path, { log: quiet });
  assert.equal(h.path, path);
  assert.equal(h.migrationVersion(), LATEST);
  assert.equal(h.db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(h.db.pragma('foreign_keys', { simple: true }), 1);
  h.db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (42, '0042_x.sql', 'x', 1)").run();
  h.close();
  h.close(); // idempotent
  await assert.rejects(openDb(path, { log: quiet }), /version 42/);
});

test('openDb({ migrate: false }) leaves the schema untouched', async () => {
  const h = await openDb(':memory:', { migrate: false });
  assert.deepEqual(tableNames(h.db), []);
  assert.equal(h.migrationVersion(), 0);
  h.close();
});
