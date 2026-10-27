// M65 B21 — migration 0006 (campaign loop): additive on a phase-1.5 DB.
//
// 1. A real phase-1.5 table (0001–0005 only: a room, a player seat and an
//    encounter mid-fight) migrates to 0006 with its rows intact, and the
//    S1 restart path (boot recovery → a paused table with the last
//    turn.ended stateHash) works unchanged on the migrated copy.
// 2. Every CHECK, the run_characters view, each partial index, and the
//    runs → rooms FK (no cascade: deleting a run's room fails).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

import { runMigrations, loadMigrations, MIGRATIONS_DIR } from '../db/migrate.js';
import { openDb } from '../db/database.js';
import { startMultiplayerServer } from '../multiplayer.js';
import { createApi } from '../../src/js/client/api.js';
import { createSession } from '../../src/js/client/session.js';
import { stateHash } from '../../src/js/shared/state-hash.js';
import { tempRoot, quiet, ddbFixture } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-m0006-');
after(cleanup);

/** A migrations dir holding the shipped files up to `version`. */
function migrationsUpTo(version) {
  const dir = mkdtempSync(join(root, 'migrations-'));
  for (const m of loadMigrations().filter(x => x.version <= version)) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
  return dir;
}

// ------------------------------------------------------------ a live table

/** One ws table client: frames recorded, exchanges / prompts auto-answered. */
function client(name, url, token, sockets) {
  const Ctor = class extends WebSocket { constructor(u) { super(u); sockets.add(this); } };
  const session = createSession({ url, token, WebSocketCtor: Ctor, wsOptions: { logger: { warn: () => {} } } });
  const c = { name, session, frames: [], waiters: [] };
  const answer = (intent) => session.send(intent).catch(() => {});
  session.ws.on('message', (msg) => {
    c.frames.push(msg);
    if (msg.t === 'exchange') answer({ t: 'cinema.done', p: { exchangeId: msg.p.payload.exchangeId } });
    if (msg.t === 'prompt.open') answer({ t: 'prompt.answer', p: { promptId: msg.p.promptId, answer: msg.p.autoAnswer ?? false } });
    for (const w of [...c.waiters]) if (w.pred(msg)) { c.waiters.splice(c.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(msg); }
  });
  c.until = (pred, since = 0) => {
    const hit = c.frames.slice(since).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => reject(new Error(`${name}: timed out`)), 10_000) };
      c.waiters.push(w);
    });
  };
  c.send = async (t, p = {}) => {
    const ack = await session.send({ t, p });
    assert.equal(ack.ok, true, `${name} ${t}`);
    return ack;
  };
  return c;
}

const ENV = { NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_ENGINE: 'real' };
const boot = (db) => startMultiplayerServer({ db, env: ENV, port: 0, host: '127.0.0.1', log: quiet, gatewayOpts: { heartbeatMs: 60_000 }, janitorOpts: false });
async function shut(srv, clients, sockets) {
  for (const c of clients) c.session.close();
  for (const ws of sockets) ws.terminate();
  await srv.close();
  srv.httpServer.closeAllConnections();
}

test('a phase-1.5 DB with a live room, seats and an active encounter migrates to 0006; the table restores unchanged', async () => {
  const dir = mkdtempSync(join(root, 'live-'));
  const path = join(dir, 'cf.db');

  // --- phase 1.5: schema 0005, a table mid-encounter.
  const old = await openDb(path, { log: quiet, migrationsDir: migrationsUpTo(5) });
  assert.equal(old.migrationVersion(), 5);
  let srv = await boot(old);
  let sockets = new Set();
  let clients = [];
  let room, durable;
  try {
    const anon = createApi({ fetch: globalThis.fetch, base: srv.url });
    room = await anon.createRoom('Phase 1.5 table');
    const join = await anon.joinRoom(room.code, 'Robin');
    const playerApi = createApi({ fetch: globalThis.fetch, base: srv.url, token: () => join.token });
    const imp = await playerApi.importCharacter(room.roomId, { json: ddbFixture('fighter-l5') });
    const wsUrl = `${srv.url.replace(/^http/, 'ws')}/ws`;
    const dm = client('dm', wsUrl, room.dmToken, sockets);
    const player = client('player', wsUrl, join.token, sockets);
    clients = [dm, player];
    await dm.session.connect();
    await player.session.connect();
    await player.until(m => m.t === 'room.snapshot');
    await player.send('seat.claim', { characterId: imp.character.id });
    await dm.send('dm.encounter.setup', { map: null, grid: { cols: 6, rows: 4 }, monsters: [{ id: 'gob', preset: 'goblin', name: 'Goblin', hp: 30 }], placements: {} });
    await dm.send('dm.encounter.start', { seed: 42 });
    const started = await player.until(m => m.t === 'turn.started' && m.p.payload.actorId === 'pc-1');
    await dm.send('dm.pause');
    await player.send('turn.act', { turnId: started.p.turnId, plan: { kind: 'melee', targetId: 'gob' } });
    const ended = await dm.until(m => m.t === 'turn.ended' && m.p.payload.actorId === 'pc-1');
    durable = ended.p.payload.stateHash;
  } finally {
    await shut(srv, clients, sockets);
  }

  // --- the migration, on a copy (the original stays a 0005 DB).
  const copy = join(dir, 'copy.db');
  copyFileSync(path, copy);
  const raw = new Database(copy, { readonly: true });
  const before = {
    seats: raw.prepare('SELECT * FROM party_slots ORDER BY seat').all(),
    encounters: raw.prepare('SELECT * FROM encounters').all(),
    rooms: raw.prepare('SELECT * FROM rooms').all()
  };
  raw.close();
  assert.equal(before.seats.length, 1);
  assert.equal(before.encounters.length, 1);
  assert.equal(before.encounters[0].status, 'active');

  const migrated = await openDb(copy, { log: quiet });
  assert.ok(migrated.migrationVersion() >= 6, 'migrated through 0006 (and any later additive files)');
  const conn = migrated.db;
  const seat = conn.prepare('SELECT * FROM party_slots').get();
  for (const [k, v] of Object.entries(before.seats[0])) assert.deepEqual(seat[k], v, `party_slots.${k} unchanged`);
  assert.deepEqual([seat.run_id, seat.level, seat.xp, seat.life_status, seat.version, seat.seed_raw_sha], [null, null, 0, 'active', 0, null]);
  const enc = conn.prepare('SELECT * FROM encounters').get();
  for (const [k, v] of Object.entries(before.encounters[0])) assert.deepEqual(enc[k], v, `encounters.${k} unchanged`);
  assert.deepEqual([enc.run_id, enc.node_id, enc.run_applied_at], [null, null, null]);
  assert.deepEqual(conn.prepare('SELECT * FROM rooms').all(), before.rooms);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM run_characters').get().n, 0, 'a phase-1 seat is not a run character');
  assert.deepEqual(conn.pragma('foreign_key_check'), []);
  assert.equal(conn.pragma('integrity_check', { simple: true }), 'ok');

  // --- S1's restart path on the migrated copy.
  srv = await boot(migrated);
  sockets = new Set();
  clients = [];
  try {
    const dm2 = client('dm2', `${srv.url.replace(/^http/, 'ws')}/ws`, room.dmToken, sockets);
    clients = [dm2];
    await dm2.session.connect();
    const snap = await dm2.until(m => m.t === 'room.snapshot');
    assert.equal(snap.p.room.status, 'paused');
    assert.equal(snap.p.stateHash, durable, 'the migrated table restores at the last turn.ended stateHash');
    assert.equal(stateHash(snap.p.encounter), durable);
    assert.equal(snap.p.encounter.entities['pc-1'].name.length > 0, true);
  } finally {
    await shut(srv, clients, sockets);
  }
});

// --------------------------------------------------- constraints and view

async function fresh() {
  const db = new Database(join(mkdtempSync(join(root, 'c-')), 'c.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  await runMigrations(db, { log: quiet });
  db.exec(`
    INSERT INTO characters (id, ddb_id, name, raw_json, parsed_json, created_at, updated_at) VALUES (1, 'c1', 'Saris', '{}', '{}', 1, 1);
    INSERT INTO rooms (id, code, dm_token_hash, created_at, last_active_at) VALUES ('r1', 'ABC234', 'h1', 1, 1), ('r2', 'ABC235', 'h2', 1, 1);
    INSERT INTO party_slots (id, room_id, seat, character_id, updated_at) VALUES ('s1', 'r1', 1, 1, 1), ('s2', 'r2', 1, 1, 1);
    INSERT INTO campaigns (id, name, owner_key_hash, created_at, updated_at) VALUES ('c1', 'The Keep', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 1, 1);
    INSERT INTO runs (id, campaign_id, room_id, campaign_json, created_at, updated_at) VALUES ('run1', 'c1', 'r1', '{}', 1, 1);
  `);
  return db;
}
const CK = /CHECK constraint failed/;
const ins = (db, table, row) => {
  const keys = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(row));
};

test('0006: campaigns, nodes, templates and assets CHECKs', async () => {
  const db = await fresh();
  const camp = (o) => ins(db, 'campaigns', { id: 'x', name: 'n', owner_key_hash: 'h'.repeat(43), created_at: 1, updated_at: 1, ...o });
  assert.throws(() => camp({ name: '' }), CK);
  assert.throws(() => camp({ owner_key_hash: 'short' }), CK);
  assert.throws(() => camp({ settings_json: '{bad' }), CK);
  assert.throws(() => camp({ id: 'y', owner_key_hash: 'x'.repeat(43) }), /UNIQUE constraint failed: campaigns.owner_key_hash/);
  assert.equal(db.prepare("SELECT ruleset FROM campaigns WHERE id = 'c1'").get().ruleset, 'srd-5.1');

  const node = (o) => ins(db, 'campaign_nodes', { campaign_id: 'c1', id: 'n1', kind: 'rest', title: 'Camp', updated_at: 1, ...o });
  assert.throws(() => node({ kind: 'dungeon' }), CK);
  assert.throws(() => node({ ord: -1 }), CK);
  assert.throws(() => node({ title: '' }), CK);
  assert.throws(() => node({ is_start: 2 }), CK);
  assert.throws(() => node({ next_json: '{}' }), CK, 'next_json is an array');
  assert.throws(() => node({ payload_json: 'nope' }), CK);
  node({ is_start: 1 });
  assert.deepEqual(db.prepare("SELECT payload_json, next_json FROM campaign_nodes WHERE id = 'n1'").get(), { payload_json: '{}', next_json: '[]' });
  assert.throws(() => node(), /UNIQUE constraint failed/, 'node ids are unique per campaign');
  assert.throws(() => node({ id: 'n2', is_start: 1 }), /UNIQUE constraint failed/, 'one start node per campaign');
  node({ id: 'n2' });
  assert.throws(() => node({ campaign_id: 'nope', id: 'n3' }), /FOREIGN KEY/);

  const tpl = (o) => ins(db, 'encounter_templates', { id: 't1', campaign_id: 'c1', name: 'Ambush', setup_json: '{}', created_at: 1, updated_at: 1, ...o });
  assert.throws(() => tpl({ name: '' }), CK);
  assert.throws(() => tpl({ setup_json: '[' }), CK);
  assert.throws(() => tpl({ setup_v: 0 }), CK);
  tpl();

  const asset = (o) => ins(db, 'campaign_assets', { id: 'a1', campaign_id: 'c1', rel_path: 'campaigns/c1/x.png', mime: 'image/png', bytes: 10, sha256: 'a'.repeat(64), width: 4, height: 4, created_at: 1, ...o });
  assert.throws(() => asset({ kind: 'sprite' }), CK);
  assert.throws(() => asset({ mime: 'image/gif' }), CK);
  assert.throws(() => asset({ bytes: 0 }), CK);
  assert.throws(() => asset({ sha256: 'abc' }), CK);
  assert.throws(() => asset({ width: 8193 }), CK);
  assert.throws(() => asset({ width: 8000, height: 8000 }), CK, '≤ 16.7 MP');
  assert.throws(() => asset({ grid_json: '{' }), CK);
  asset();
  assert.throws(() => asset({ id: 'a2' }), /UNIQUE constraint failed/, 'one row per sha per campaign');

  // Deleting a campaign cascades to its authoring rows and orphans its runs.
  db.prepare("DELETE FROM campaigns WHERE id = 'c1'").run();
  for (const t of ['campaign_nodes', 'encounter_templates', 'campaign_assets']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  assert.equal(db.prepare("SELECT campaign_id FROM runs WHERE id = 'run1'").get().campaign_id, null);
  db.close();
});

test('0006: runs CHECKs, the pinned room and run-scoped rows', async () => {
  const db = await fresh();
  const run = (o) => ins(db, 'runs', { id: 'run2', room_id: 'r2', campaign_json: '{}', created_at: 1, updated_at: 1, ...o });
  assert.throws(() => run({ status: 'between-nodes' }), CK);
  assert.throws(() => run({ status: 'ended' }), CK, 'an ended run has ended_at');
  assert.throws(() => run({ ended_at: 5 }), CK, 'ended_at only on an ended run');
  assert.throws(() => run({ outcome: 'victory' }), CK, 'an outcome only once ended');
  assert.throws(() => run({ status: 'ended', ended_at: 5, outcome: 'tpk' }), CK);
  assert.throws(() => run({ campaign_json: 'x' }), CK);
  assert.throws(() => run({ seq: -1 }), CK);
  assert.throws(() => run({ room_id: 'r1' }), /UNIQUE constraint failed: runs.room_id/, 'one run per room');
  assert.throws(() => run({ room_id: 'nope' }), /FOREIGN KEY/);
  run({ status: 'ended', ended_at: 5, outcome: 'defeat' });

  // The run pins its room: no cascade, the delete fails at the FK.
  assert.throws(() => db.prepare("DELETE FROM rooms WHERE id = 'r1'").run(), /FOREIGN KEY constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM party_slots WHERE room_id = 'r1'").get().n, 1, 'the party survives the refused delete');

  const ev = (o) => ins(db, 'run_events', { run_id: 'run1', seq: 1, ts: 1, actor_kind: 'dm', type: 'run.started', ...o });
  assert.throws(() => ev({ seq: 0 }), CK);
  assert.throws(() => ev({ actor_kind: 'npc' }), CK);
  assert.throws(() => ev({ type: '' }), CK);
  assert.throws(() => ev({ override: 2 }), CK);
  assert.throws(() => ev({ payload_json: '{' }), CK);
  ev();
  assert.throws(() => ev(), /UNIQUE constraint failed|PRIMARY KEY/);

  const snap = (o) => ins(db, 'run_snapshots', { id: 'sn1', run_id: 'run1', at_seq: 1, blob_json: '{}', created_at: 1, ...o });
  assert.throws(() => snap({ at_seq: -1 }), CK);
  assert.throws(() => snap({ blob_json: 'x' }), CK);
  assert.throws(() => snap({ label: 'x'.repeat(81) }), CK);
  snap();

  const item = (o) => ins(db, 'run_items', { id: 'i1', run_id: 'run1', owner_slot_id: 's1', origin: 'open5e', name: 'Potion of Healing', updated_at: 1, ...o });
  assert.throws(() => item({ origin: 'homebrew' }), CK);
  assert.throws(() => item({ qty: -1 }), CK);
  assert.throws(() => item({ equipped: 2 }), CK);
  assert.throws(() => item({ attuned: -1 }), CK);
  assert.throws(() => item({ charges_spent: -1 }), CK);
  assert.throws(() => item({ name: '' }), CK);
  item({ equipped: 1 });

  const lu = (o) => ins(db, 'level_ups', { id: 'l1', run_id: 'run1', slot_id: 's1', from_level: 4, to_level: 5, mode: 'choose', created_at: 1, ...o });
  assert.throws(() => lu({ mode: 'manual' }), CK);
  assert.throws(() => lu({ status: 'done' }), CK);
  assert.throws(() => lu({ to_level: 6 }), CK, 'one level per row');
  assert.throws(() => lu({ from_level: 20, to_level: 21 }), CK);
  assert.throws(() => lu({ granted_json: '{' }), CK);
  lu();
  assert.equal(db.prepare("SELECT status FROM level_ups WHERE id = 'l1'").get().status, 'pending_player');

  const arch = (o) => ins(db, 'run_roster_archive', { id: 'ar1', run_id: 'run1', slot_id: 's1', seat: 1, life_status: 'dead', reason: 'retired', archived_at: 1, ...o });
  assert.throws(() => arch({ seat: 7 }), CK);
  assert.throws(() => arch({ life_status: 'undead' }), CK);
  assert.throws(() => arch({ level: 21 }), CK);
  assert.throws(() => arch({ xp: -5 }), CK);
  assert.throws(() => arch({ reason: '' }), CK);
  arch();

  // A seat removed with its room hands its items to the stash; deleting
  // the run removes every run-scoped row.
  db.prepare("DELETE FROM party_slots WHERE id = 's1'").run();
  assert.equal(db.prepare("SELECT owner_slot_id FROM run_items WHERE id = 'i1'").get().owner_slot_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM level_ups').get().n, 0, 'level-ups go with their seat');
  db.prepare("DELETE FROM runs WHERE id = 'run1'").run();
  for (const t of ['run_events', 'run_snapshots', 'run_items', 'run_roster_archive']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  db.prepare("DELETE FROM rooms WHERE id = 'r1'").run();
  db.close();
});

test('0006: items_cache admits only srd-2014', async () => {
  const db = await fresh();
  const row = (o) => ins(db, 'items_cache', { key: 'srd_longsword', document_key: 'srd-2014', kind: 'item', name: 'Longsword', payload_json: '{}', fetched_at: 1, ...o });
  assert.throws(() => row({ document_key: 'srd-2024' }), CK);
  assert.throws(() => row({ document_key: 'tob' }), CK);
  assert.throws(() => row({ kind: 'monster' }), CK);
  assert.throws(() => row({ payload_json: '{' }), CK);
  row();
  db.close();
});

test('0006: party_slots columns, the run_characters view, and encounters run columns', async () => {
  const db = await fresh();
  const set = (col, v) => db.prepare(`UPDATE party_slots SET ${col} = ? WHERE id = 's1'`).run(v);
  assert.throws(() => set('level', 0), CK);
  assert.throws(() => set('level', 21), CK);
  assert.throws(() => set('xp', -1), CK);
  assert.throws(() => set('xp', null), /NOT NULL/);
  assert.throws(() => set('life_status', 'undead'), CK);
  assert.throws(() => set('version', -1), CK);
  assert.throws(() => set('seed_raw_sha', 'abc'), CK);
  assert.throws(() => set('run_id', 'nope'), /FOREIGN KEY/);

  assert.deepEqual(db.prepare('SELECT * FROM run_characters').all(), [], 'no seat is in a run yet');
  db.prepare("UPDATE party_slots SET run_id = 'run1', level = 4, xp = 2700, life_status = 'stable', version = 3 WHERE id = 's1'").run();
  const rc = db.prepare('SELECT * FROM run_characters').all();
  assert.equal(rc.length, 1);
  assert.deepEqual([rc[0].id, rc[0].run_id, rc[0].room_id, rc[0].level, rc[0].xp, rc[0].life_status, rc[0].version], ['s1', 'run1', 'r1', 4, 2700, 'stable', 3]);
  for (const col of ['seed_parsed_json', 'sheet_json', 'state_json', 'controller_participant_id', 'ai_archetype', 'seed_raw_sha', 'character_id', 'seat']) {
    assert.ok(col in rc[0], `the view exposes ${col}`);
  }

  db.prepare("INSERT INTO encounters (id, room_id, status, engine_version, snapshot_json, created_at, updated_at, run_id, node_id) VALUES ('e1', 'r1', 'ended', 1, '{}', 1, 1, 'run1', 'n1')").run();
  assert.throws(() => db.prepare("UPDATE encounters SET run_id = 'nope' WHERE id = 'e1'").run(), /FOREIGN KEY/);
  db.prepare("DELETE FROM runs WHERE id = 'run1'").run();
  assert.equal(db.prepare("SELECT run_id FROM party_slots WHERE id = 's1'").get().run_id, null, 'party_slots.run_id → SET NULL');
  assert.equal(db.prepare("SELECT run_id FROM encounters WHERE id = 'e1'").get().run_id, null, 'encounters.run_id → SET NULL');
  db.close();
});

test('0006: every partial index exists, is partial, and serves its query', async () => {
  const db = await fresh();
  const partial = (table) => Object.fromEntries(db.pragma(`index_list(${table})`).map(i => [i.name, i.partial]));
  assert.equal(partial('party_slots').idx_party_slots_run, 1);
  assert.equal(partial('encounters').idx_encounters_run_unapplied, 1);
  assert.equal(partial('runs').idx_runs_ended, 1);
  assert.equal(partial('runs').idx_runs_campaign, 1);
  assert.equal(partial('level_ups').idx_level_ups_pending, 1);
  assert.equal(partial('campaign_nodes').ux_campaign_nodes_one_start, 1);
  const plan = (sql, ...a) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a).map(r => r.detail).join(' | ');
  assert.match(plan("SELECT id FROM party_slots WHERE run_id = ? AND run_id IS NOT NULL", 'run1'), /idx_party_slots_run/);
  assert.match(plan("SELECT id FROM run_characters WHERE run_id = ?", 'run1'), /idx_party_slots_run/, 'the view uses the partial index');
  assert.match(plan('SELECT id FROM encounters WHERE run_id IS NOT NULL AND run_applied_at IS NULL'), /idx_encounters_run_unapplied/);
  assert.match(plan("SELECT id FROM runs WHERE status = 'ended' AND ended_at < ?", 5), /idx_runs_ended/);
  assert.match(plan("SELECT id FROM level_ups WHERE slot_id = ? AND status IN ('pending_player', 'pending_dm')", 's1'), /idx_level_ups_pending/);
  db.close();
});
