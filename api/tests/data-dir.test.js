// Data-dir resolution and production volume guard (M64 B5). All env is
// injected; nothing here reads process.env or opens a real database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataPaths, DEFAULT_DB_PATH, DB_FILE_NAME } from '../db/database.js';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

test('CF_DATA_DIR wins and the DB file is derived from it', () => {
  const r = resolveDataPaths({ CF_DATA_DIR: '/srv/cf', RAILWAY_VOLUME_MOUNT_PATH: '/app/data' });
  assert.equal(r.dataDir, '/srv/cf');
  assert.equal(r.dbPath, join('/srv/cf', DB_FILE_NAME));
  assert.equal(r.volume, '/app/data');
});

test('RAILWAY_VOLUME_MOUNT_PATH is the next fallback', () => {
  const r = resolveDataPaths({ RAILWAY_VOLUME_MOUNT_PATH: '/app/data' });
  assert.equal(r.dataDir, '/app/data');
  assert.equal(r.dbPath, join('/app/data', DB_FILE_NAME));
});

test('CF_DB_PATH alone puts the data dir next to the DB', () => {
  const r = resolveDataPaths({ CF_DB_PATH: '/var/lib/cf/forge.db' });
  assert.equal(r.dbPath, '/var/lib/cf/forge.db');
  assert.equal(r.dataDir, '/var/lib/cf');
  assert.equal(r.volume, null);
});

test('CF_DB_PATH is kept as given even when a data dir is set', () => {
  const r = resolveDataPaths({ CF_DB_PATH: '/app/data/db/x.db', CF_DATA_DIR: '/app/data/files' });
  assert.equal(r.dbPath, '/app/data/db/x.db');
  assert.equal(r.dataDir, '/app/data/files');
});

test('nothing configured falls back to the repo-root DB', () => {
  const r = resolveDataPaths({});
  assert.equal(r.dbPath, DEFAULT_DB_PATH);
  assert.equal(r.dataDir, dirname(DEFAULT_DB_PATH));
  assert.deepEqual(r.warnings, []);
});

test('production refuses a DB path off the Railway volume', () => {
  assert.throws(
    () => resolveDataPaths({ NODE_ENV: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/app/data', CF_DB_PATH: '/app/character-forge.db' }),
    /Refusing to boot: CF_DB_PATH "\/app\/character-forge\.db" is not on the Railway volume mounted at "\/app\/data"/
  );
});

test('production refuses a sibling directory that only shares a prefix', () => {
  assert.throws(
    () => resolveDataPaths({ NODE_ENV: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/app/data', CF_DB_PATH: '/app/data2/cf.db' }),
    /not on the Railway volume/
  );
});

test('production refuses an in-memory DB when a volume is mounted', () => {
  assert.throws(
    () => resolveDataPaths({ NODE_ENV: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/app/data', CF_DB_PATH: ':memory:' }),
    /not on the Railway volume/
  );
});

test('production refuses a data dir off the volume', () => {
  assert.throws(
    () => resolveDataPaths({ NODE_ENV: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/app/data', CF_DB_PATH: '/app/data/cf.db', CF_DATA_DIR: '/tmp/cf' }),
    /CF_DATA_DIR "\/tmp\/cf" is not on the Railway volume/
  );
});

test('production accepts paths on the volume (including relative segments)', () => {
  const r = resolveDataPaths({ NODE_ENV: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/app/data/', CF_DB_PATH: '/app/data/sub/../cf.db' });
  assert.equal(resolve(r.dbPath), '/app/data/cf.db');
  assert.equal(r.dataDir, '/app/data');
});

test('the guard only applies in production', () => {
  const r = resolveDataPaths({ NODE_ENV: 'development', RAILWAY_VOLUME_MOUNT_PATH: '/app/data', CF_DB_PATH: '/elsewhere/cf.db' });
  assert.equal(r.dbPath, '/elsewhere/cf.db');
});

test('production with nothing configured warns instead of failing', () => {
  const r = resolveDataPaths({ NODE_ENV: 'production' });
  assert.equal(r.dbPath, DEFAULT_DB_PATH);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not persistent/);
});

test('server.js fails fast with a clear message when the DB is off the volume', () => {
  const out = spawnSync(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      RAILWAY_VOLUME_MOUNT_PATH: '/nonexistent-cf-volume',
      CF_DB_PATH: '/nonexistent-cf-elsewhere/cf.db',
      PORT: '0'
    },
    encoding: 'utf8',
    timeout: 15_000
  });
  assert.equal(out.status, 1);
  const line = JSON.parse(out.stderr.trim().split('\n').pop());
  assert.equal(line.level, 'error');
  assert.equal(line.msg, 'startup failed');
  assert.match(line.error, /not on the Railway volume/);
});
