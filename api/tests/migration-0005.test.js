// M64 phase 1.5 W6 — migration 0005 (uploaded_maps.kind): additive, every
// existing upload becomes a 'map', and the CHECK admits only map / token.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { runMigrations, loadMigrations, MIGRATIONS_DIR } from '../db/migrate.js';
import { tempRoot } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-m0005-');
after(cleanup);

test('0005 upgrades a 0004 database: kind defaults to map on existing rows and is CHECKed', async () => {
  const dir = mkdtempSync(join(root, 'up-'));
  const upTo4 = mkdtempSync(join(dir, 'migrations-'));
  for (const m of loadMigrations().filter(x => x.version <= 4)) copyFileSync(join(MIGRATIONS_DIR, m.name), join(upTo4, m.name));
  const db = new Database(join(dir, 'cf.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  assert.equal((await runMigrations(db, { dir: upTo4, log: () => {} })).version, 4);
  db.prepare("INSERT INTO rooms (id, code, dm_token_hash, created_at, last_active_at) VALUES ('r1', 'ABC234', 'h', 1, 1)").run();
  const insert = (id, sha, kind) => db.prepare(`INSERT INTO uploaded_maps (id, room_id, rel_path, mime, bytes, sha256, width, height, created_at${kind ? ', kind' : ''})
    VALUES (?, 'r1', 'maps/r1/x.png', 'image/png', 10, ?, 4, 4, 1${kind ? ', ?' : ''})`).run(...(kind ? [id, sha, kind] : [id, sha]));
  insert('m1', 'a'.repeat(64));

  const res = await runMigrations(db, { log: () => {} });
  assert.equal(res.applied[0], '0005_map_kind.sql');
  assert.ok(res.backupPath, 'a populated DB is backed up before 0005');
  const col = db.prepare('PRAGMA table_info(uploaded_maps)').all().find(c => c.name === 'kind');
  assert.deepEqual([col.type, col.notnull, col.dflt_value], ['TEXT', 1, "'map'"]);
  assert.equal(db.prepare("SELECT kind FROM uploaded_maps WHERE id = 'm1'").get().kind, 'map', 'existing uploads are maps');
  insert('m2', 'b'.repeat(64), 'token');
  assert.throws(() => insert('m3', 'c'.repeat(64), 'sprite'), /CHECK constraint failed/);
  db.close();
});
