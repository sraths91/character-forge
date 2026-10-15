// M64 B8 — encounter persistence and boot recovery with the stub engine.
// The gate: kill (close) mid-encounter, reopen on the same DB, resume, and
// finish with a state (including the RNG) identical to an uninterrupted run.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { openDb } from '../db/database.js';
import { startMultiplayerServer } from '../multiplayer.js';
import { createStubEngine } from '../rooms/engine-port.js';
import { createSqliteJournal } from '../rooms/persistence.js';
import { stateHash } from '../rooms/view.js';
import { validateEventLog } from '../../src/js/shared/events.js';
import { tempRoot, quiet, ddbFixture, api } from './helpers/server.js';
import { TestClient } from './helpers/ws.js';

const { root, cleanup } = tempRoot('cf-persist-');
after(cleanup);

const open = new Set();
after(async () => { for (const s of open) await s.close().catch(() => {}); });

const LOOSE = { roomCreate: { windowMs: 60_000, max: 1000 }, roomJoin: { windowMs: 60_000, max: 1000 } };

async function boot(path, { engine, log = quiet } = {}) {
  const db = await openDb(path, { log: quiet });
  const srv = await startMultiplayerServer({
    db, env: { NODE_ENV: 'test' }, port: 0, host: '127.0.0.1', log, appOpts: { limits: LOOSE },
    ...(engine ? { engine } : {})
  });
  const out = { db, ...srv };
  const close = srv.close;
  out.close = async () => { open.delete(out); await close(); };
  open.add(out);
  return out;
}

/**
 * Drive a table with fixed choices until the encounter ends or `crashAt`
 * fires. Choices: every reaction prompt answered `true`; every pc-1 turn
 * attacks the goblin; on pc-1's 2nd turn the DM first sets the goblin's
 * HP (a DM edit at the intent safe point, logged with the intent).
 * `crashAt` = the exchange of pc-1's 2nd turn: nobody acks its cinema.
 */
function drive(dm, player, plan, { crash = false } = {}) {
  return new Promise((resolve, reject) => {
    const onFrame = (c) => async (data) => {
      try {
        const m = JSON.parse(String(data));
        if (m.t === 'encounter.ended') return resolve('ended');
        if (c === player && m.t === 'prompt.open') await player.send('prompt.answer', { promptId: m.p.promptId, answer: true });
        if (c === dm && m.t === 'turn.started' && m.p.payload.actorId === 'pc-1') {
          plan.pcTurns++;
          if (plan.pcTurns === 2) {
            const r = await dm.send('dm.entity.patch', { entityId: 'gob', hp: 25 });
            if (r.t !== 'ack') throw new Error(`patch failed: ${JSON.stringify(r.p)}`);
          }
          const r = await player.send('turn.act', { turnId: m.p.turnId, plan: { kind: 'melee', targetId: 'gob' } });
          if (r.t !== 'ack') throw new Error(`act failed: ${JSON.stringify(r.p)}`);
        }
        if (m.t === 'exchange') {
          if (crash && plan.pcTurns === 2 && m.p.payload.attackerId === 'pc-1') return resolve('crash');
          c.sendRaw({ v: 1, t: 'cinema.done', cid: `cd-${m.seq}-${c.name}`, p: { exchangeId: m.p.payload.exchangeId } });
        }
      } catch (err) { reject(err); }
    };
    dm.ws.on('message', onFrame(dm));
    player.ws.on('message', onFrame(player));
  });
}

async function newTable(srv) {
  const room = (await api(srv.url, '/api/rooms', { method: 'POST', body: {} })).body;
  const p = (await api(srv.url, '/api/rooms/join', { method: 'POST', body: { code: room.code, displayName: 'P' } })).body;
  const imp = await api(srv.url, `/api/import?room=${room.roomId}`, { method: 'POST', token: p.token, body: { json: ddbFixture('fighter-l5') } });
  await api(srv.url, `/api/rooms/${room.roomId}/seats/1/claim`, { method: 'POST', token: p.token, body: { characterId: imp.body.character.id } });
  return { room, p };
}

async function startEncounter(dm) {
  for (const [t, p] of [
    ['dm.encounter.setup', { map: null, grid: { cols: 6, rows: 4 }, monsters: [{ id: 'gob', name: 'Goblin', hp: 30, ac: 11 }], placements: {} }],
    ['dm.initiative.set', { order: ['gob', 'pc-1'] }],
    ['dm.encounter.start', { seed: 4242 }]
  ]) {
    const r = await dm.send(t, p);
    assert.equal(r.t, 'ack', `${t}: ${JSON.stringify(r.p)}`);
  }
}

function finalState(db) {
  const row = db.db.prepare('SELECT * FROM encounters ORDER BY created_at DESC LIMIT 1').get();
  const events = db.db.prepare('SELECT event_json FROM encounter_events WHERE encounter_id = ? ORDER BY seq').all(row.id).map(r => JSON.parse(r.event_json));
  return { row, state: JSON.parse(row.snapshot_json), events };
}

test('kill mid-encounter, reopen, resume: identical final state, RNG and event types', async () => {
  // Reference: one uninterrupted run.
  const refPath = join(mkdtempSync(join(root, 'ref-')), 'ref.db');
  const ref = await boot(refPath);
  let refFinal;
  {
    const { room, p } = await newTable(ref);
    const dm = await TestClient.connect(ref.url, room.dmToken, { name: 'dm' });
    const pl = await TestClient.connect(ref.url, p.token, { name: 'p' });
    const plan = { pcTurns: 0 };
    const done = drive(dm, pl, plan);
    await startEncounter(dm);
    assert.equal(await done, 'ended');
    assert.ok(plan.pcTurns >= 3, `long enough to crash in the middle (pc turns: ${plan.pcTurns})`);
    await new Promise(r => setTimeout(r, 20));
    refFinal = finalState(ref.db);
    dm.close(); pl.close();
    await ref.close();
  }
  assert.equal(refFinal.row.status, 'ended');
  assert.equal(refFinal.state.phase, 'ended');

  // Crash run: same table, closed while pc-1's 2nd attack is mid-cinema.
  const path = join(mkdtempSync(join(root, 'crash-')), 'crash.db');
  const a = await boot(path);
  const { room, p } = await newTable(a);
  const plan = { pcTurns: 0 };
  {
    const dm = await TestClient.connect(a.url, room.dmToken, { name: 'dm' });
    const pl = await TestClient.connect(a.url, p.token, { name: 'p' });
    const done = drive(dm, pl, plan, { crash: true });
    await startEncounter(dm);
    assert.equal(await done, 'crash');
    await a.close();   // graceful shutdown mid-turn (B9 path)
  }
  // The DB holds an active encounter with an in-flight turn.
  const mid = await openDb(path, { log: quiet });
  const row = mid.db.prepare("SELECT * FROM encounters WHERE status = 'active'").get();
  assert.ok(row, 'still active');
  assert.ok(row.head_seq > row.snapshot_seq, 'events past the snapshot');
  const log = JSON.parse(row.turn_log_json);
  assert.deepEqual(log.answers.map(x => x.kind), ['intent', 'roll', 'roll'].slice(0, log.answers.length));
  assert.equal(log.answers[0].dmCommands.length, 1, 'the DM edit is logged with the intent');
  mid.close();

  // Reopen: recovered paused; the DM resumes once the table is back.
  const b = await boot(path);
  try {
    const live = b.registry.get(room.roomId);
    assert.equal(live.status, 'paused');
    const dm = await TestClient.connect(b.url, room.dmToken, { name: 'dm2' });
    const pl = await TestClient.connect(b.url, p.token, { name: 'p2' });
    assert.equal(dm.snapshot.p.room.status, 'paused');
    assert.ok(dm.snapshot.p.history.length > 0, 'history restored');
    const done = drive(dm, pl, plan);
    assert.equal((await dm.send('dm.resume', {})).t, 'ack');
    assert.equal(await done, 'ended');
    await new Promise(r => setTimeout(r, 20));
    const got = finalState(b.db);
    assert.equal(got.row.status, 'ended');
    // Room-scoped ids (encounter, seat, pasted character) differ between the two tables; nothing else may.
    const norm = (st) => JSON.parse(JSON.stringify({ ...st, encounterId: 'E', lastEventSeq: 0 })
      .replace(/"seatId":"s_[^"]+"/g, '"seatId":"S"').replace(/paste:[^:"]+:/g, 'paste:R:'));
    assert.deepEqual(norm(got.state), norm(refFinal.state));
    assert.equal(stateHash(got.state), stateHash(refFinal.state));
    assert.deepEqual(got.state.rng, refFinal.state.rng, 'identical RNG state');
    // Same engine-event story (seqs differ: presence broadcasts interleave).
    const types = (evs) => evs.map(e => e.type);
    assert.deepEqual(types(got.events), types(refFinal.events));
    assert.ok(validateEventLog(got.events).ok);
    for (const c of [dm, pl]) { assert.deepEqual(c.invalid, []); assert.deepEqual(c.gaps, []); }
    dm.close(); pl.close();
  } finally {
    await b.close();
  }
});

test('an engine_version mismatch marks the encounter abandoned on boot', async () => {
  const path = join(mkdtempSync(join(root, 'ver-')), 'v.db');
  const a = await boot(path);
  const { room } = await newTable(a);
  const dm = await TestClient.connect(a.url, room.dmToken);
  await dm.send('dm.encounter.setup', { map: null, grid: { cols: 4, rows: 4 }, monsters: [{ id: 'gob' }], placements: {} });
  dm.close();
  await a.close();
  const lines = [];
  const b = await boot(path, { engine: createStubEngine({ version: 99 }), log: (level, msg, extra) => lines.push({ level, msg, ...extra }) });
  try {
    const row = b.db.db.prepare('SELECT status, ended_at FROM encounters').get();
    assert.equal(row.status, 'abandoned');
    assert.ok(row.ended_at > 0);
    assert.ok(lines.some(l => l.level === 'warn' && /engine version/.test(l.msg)));
    const dm2 = await TestClient.connect(b.url, room.dmToken);
    assert.equal(dm2.snapshot.p.encounter, null);
    assert.equal(dm2.snapshot.p.room.status, 'lobby');
    dm2.close();
  } finally { await b.close(); }
});

test('events and the turn-end snapshot land in one transaction; seq never goes backwards', async () => {
  const path = join(mkdtempSync(join(root, 'tx-')), 'tx.db');
  const db = await openDb(path, { log: quiet });
  try {
    db.db.prepare("INSERT INTO rooms (id, code, dm_token_hash, created_at, last_active_at) VALUES ('r', 'AAAAAA', 'h', 1, 1)").run();
    const j = createSqliteJournal({ db: db.db });
    j.createEncounter({ roomId: 'r', encounterId: 'e', state: { v: 1 }, engineVersion: 1 });
    const ev = (seq, type = 'move') => ({ seq, type, round: 1, turnId: 't', cinemaGroup: null, payload: {} });
    j.flush({ roomId: 'r', roomSeq: 5, encounterId: 'e', events: [ev(4), ev(5)], turnLog: { turnId: 't', answers: [{ kind: 'roll', value: 3 }] }, snapshot: null });
    let row = db.db.prepare("SELECT * FROM encounters WHERE id='e'").get();
    assert.deepEqual([row.head_seq, row.snapshot_seq, JSON.parse(row.turn_log_json).answers.length], [5, 0, 1]);
    // A failing flush (duplicate seq) rolls back everything, including the snapshot.
    assert.throws(() => j.flush({ roomId: 'r', roomSeq: 7, encounterId: 'e', events: [ev(6), ev(5)], turnLog: null, snapshot: { state: { v: 2 }, seq: 6 } }));
    row = db.db.prepare("SELECT * FROM encounters WHERE id='e'").get();
    assert.deepEqual([row.head_seq, row.snapshot_seq, row.snapshot_json], [5, 0, '{"v":1}']);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM encounter_events WHERE seq = 6").get().n, 0);
    assert.equal(db.db.prepare("SELECT seq FROM rooms WHERE id='r'").get().seq, 5);
    j.flush({ roomId: 'r', roomSeq: 7, encounterId: 'e', events: [ev(6), ev(7, 'turn.ended')], turnLog: null, snapshot: { state: { v: 2 }, seq: 7 }, status: 'active' });
    row = db.db.prepare("SELECT * FROM encounters WHERE id='e'").get();
    assert.deepEqual([row.head_seq, row.snapshot_seq, row.turn_log_json, row.status], [7, 7, null, 'active']);
    j.flush({ roomId: 'r', roomSeq: 3, encounterId: null, events: [], turnLog: null, snapshot: null });
    assert.equal(db.db.prepare("SELECT seq FROM rooms WHERE id='r'").get().seq, 7, 'room seq is monotonic');
    const live = j.loadLive('r');
    assert.deepEqual([live.tail.length, live.history.length, live.headSeq], [0, 4, 7]);
    assert.deepEqual(j.liveRoomIds(), ['r']);
    assert.equal(j.stats().flushes, 3);
  } finally { db.close(); }
});

test('write-time p99 is reported, with a warning over the budget', async () => {
  const path = join(mkdtempSync(join(root, 'p99-')), 'p.db');
  const db = await openDb(path, { log: quiet });
  try {
    db.db.prepare("INSERT INTO rooms (id, code, dm_token_hash, created_at, last_active_at) VALUES ('r', 'AAAAAA', 'h', 1, 1)").run();
    const lines = [];
    let t = 0;
    const j = createSqliteJournal({ db: db.db, log: (level, msg, extra) => lines.push({ level, msg, ...extra }), reportEvery: 4, clock: () => (t += 3) });
    for (let i = 1; i <= 4; i++) j.flush({ roomId: 'r', roomSeq: i, encounterId: null, events: [], turnLog: null, snapshot: null });
    assert.deepEqual(lines.map(l => [l.level, l.p99Ms, l.overBudget]), [['info', 3, false]]);
    const slow = createSqliteJournal({ db: db.db, log: (level, msg, extra) => lines.push({ level, msg, ...extra }), reportEvery: 2, clock: () => (t += 9) });
    slow.flush({ roomId: 'r', roomSeq: 10, encounterId: null, events: [], turnLog: null, snapshot: null });
    slow.flush({ roomId: 'r', roomSeq: 11, encounterId: null, events: [], turnLog: null, snapshot: null });
    assert.equal(lines.at(-1).level, 'warn');
    assert.equal(lines.at(-1).budgetMs, 5);
    assert.equal(lines.at(-1).overBudget, true);
  } finally { db.close(); }
});
