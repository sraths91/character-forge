// M64 B11 — janitor with an injected clock and filesystem.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createJanitor, JANITOR_DEFAULTS } from '../lib/janitor.js';
import { tempRoot, tempDb } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-janitor-');
after(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function seed(db) {
  const ins = (id, code, lastActive) => db.db.prepare(
    'INSERT INTO rooms (id, code, dm_token_hash, created_at, last_active_at) VALUES (?, ?, ?, 1, ?)'
  ).run(id, code, `h-${id}`, lastActive);
  ins('idle', 'AAAAAA', NOW - 31 * DAY);
  ins('busy', 'BBBBBB', NOW - 1 * DAY);
  ins('live', 'CCCCCC', NOW - 40 * DAY);
  const enc = (id, room, status, endedAt) => db.db.prepare(
    `INSERT INTO encounters (id, room_id, status, engine_version, snapshot_json, snapshot_seq, head_seq, created_at, updated_at, ended_at)
     VALUES (?, ?, ?, 1, '{}', 0, 2, 1, 1, ?)`).run(id, room, status, endedAt);
  enc('old', 'busy', 'ended', NOW - 8 * DAY);
  enc('recent', 'busy', 'abandoned', NOW - 2 * DAY);
  enc('running', 'live', 'active', null);
  const ev = (e, seq) => db.db.prepare(`INSERT INTO encounter_events (encounter_id, seq, type, event_json, created_at) VALUES (?, ?, 'move', '{}', 1)`).run(e, seq);
  for (const e of ['old', 'recent', 'running']) { ev(e, 1); ev(e, 2); }
}

test('deletes old ended-encounter events, idle rooms with their maps, and keeps live rooms', async () => {
  const { db } = await tempDb(root);
  seed(db);
  const removed = [];
  const fs = { statSync: () => ({ size: 1 }), rmSync: (p, o) => removed.push([p, o]) };
  const registry = { evict: (id) => id !== 'live', all: () => [{ id: 'live' }] };
  const lines = [];
  const j = createJanitor({ db, dataDir: '/data', registry, now: () => NOW, fs, log: (l, m, e) => lines.push({ l, m, ...e }) });
  const out = j.runOnce();
  assert.equal(out.eventsDeleted, 2, 'only the encounter ended > 7 days ago');
  assert.deepEqual(out.roomsDeleted, ['idle']);
  assert.equal(out.walCheckpoint, false);
  assert.deepEqual(removed, [[join('/data', 'maps', 'idle'), { recursive: true, force: true }]]);
  const count = (sql) => db.db.prepare(sql).get().n;
  assert.equal(count("SELECT COUNT(*) AS n FROM rooms WHERE id = 'idle'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM rooms WHERE id = 'live'"), 1, 'live room kept despite being idle in the DB');
  assert.equal(count("SELECT COUNT(*) AS n FROM encounter_events WHERE encounter_id = 'old'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM encounter_events WHERE encounter_id = 'recent'"), 2);
  assert.equal(count("SELECT COUNT(*) AS n FROM encounters WHERE id = 'old'"), 1, 'the final snapshot stays');
  assert.equal(lines.length, 1);
  // Idempotent.
  assert.deepEqual(j.runOnce(), { eventsDeleted: 0, runsDeleted: 0, roomsDeleted: [], walCheckpoint: false });
  db.close();
});

test('checkpoints the WAL only above 64 MB', async () => {
  const { db } = await tempDb(root);
  let size = JANITOR_DEFAULTS.walLimitBytes;
  const stats = [];
  const fs = { statSync: (p) => { stats.push(p); return { size }; }, rmSync: () => {} };
  const j = createJanitor({ db, dataDir: null, now: () => NOW, fs });
  assert.equal(j.runOnce().walCheckpoint, false);
  size += 1;
  assert.equal(j.runOnce().walCheckpoint, true);
  assert.equal(stats[0], `${db.path}-wal`);
  db.close();
});

test('start/stop use an unref\'d interval that stop() clears', async () => {
  const { db } = await tempDb(root);
  const calls = [];
  const fakeTimer = { unref: () => calls.push('unref') };
  const j = createJanitor({
    db, dataDir: null,
    setInterval: (fn, ms) => { calls.push(['set', ms]); return fakeTimer; },
    clearInterval: (t) => calls.push(['clear', t === fakeTimer])
  });
  j.start();
  j.start();
  j.stop();
  j.stop();
  assert.deepEqual(calls, [['set', JANITOR_DEFAULTS.intervalMs], 'unref', ['clear', true]]);
  db.close();
});

test('a failing pass is logged, not thrown', async () => {
  const { db } = await tempDb(root);
  const lines = [];
  const j = createJanitor({ db, dataDir: null, log: (l, m) => lines.push([l, m]) });
  db.db.close();
  assert.deepEqual(j.runOnce(), { eventsDeleted: 0, runsDeleted: 0, roomsDeleted: [], walCheckpoint: false });
  assert.deepEqual(lines, [['error', 'janitor failed']]);
});
