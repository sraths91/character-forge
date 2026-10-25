// M65 B23 — the runs store (prepared statements, optimistic version lock
// on party_slots) and the janitor's run rules.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { createRunStore, RunStoreError } from '../runs/store.js';
import { createJanitor } from '../lib/janitor.js';
import { tempRoot, tempDb } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-runs-');
after(cleanup);

const DAY = 24 * 60 * 60 * 1000;

function seed(conn) {
  conn.exec(`
    INSERT INTO characters (id, ddb_id, name, raw_json, parsed_json, created_at, updated_at) VALUES (1, 'c1', 'Saris', '{}', '{}', 1, 1), (2, 'c2', 'Brom', '{}', '{}', 1, 1);
    INSERT INTO rooms (id, code, dm_token_hash, created_at, last_active_at) VALUES ('r1', 'ABC234', 'h1', 1, 1);
    INSERT INTO party_slots (id, room_id, seat, character_id, updated_at) VALUES ('s1', 'r1', 1, 1, 1), ('s2', 'r1', 2, 2, 1);
  `);
}

async function setup() {
  const { db } = await tempDb(root);
  seed(db.db);
  let t = 1000;
  // Count prepares made after construction: every statement is hoisted.
  let prepares = 0;
  const conn = new Proxy(db.db, {
    get(target, prop) {
      if (prop === 'prepare') return (...a) => { prepares++; return target.prepare(...a); };
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  const store = createRunStore(conn, { now: () => ++t });
  const built = prepares;
  return { db, store, preparesAfterBuild: () => prepares - built };
}

test('runs: create, read by id / room, status lifecycle, ended is final', async () => {
  const { db, store, preparesAfterBuild } = await setup();
  const id = store.createRun({ campaignId: null, roomId: 'r1', campaign: { v: 1, nodes: [] }, settings: { xpMode: 'xp' }, rng: { s: 42 } });
  const run = store.getRun(id);
  assert.deepEqual([run.status, run.seq, run.roomId, run.outcome, run.endedAt], ['lobby', 0, 'r1', null, null]);
  assert.deepEqual(run.campaign, { v: 1, nodes: [] });
  assert.deepEqual(run.rng, { s: 42 });
  assert.equal(store.getRunByRoom('r1').id, id);
  assert.throws(() => store.createRun({ roomId: 'r1', campaign: {} }), /UNIQUE constraint failed: runs.room_id/);

  store.setStatus(id, 'in-node');
  store.setCurrentNode(id, 'n1');
  store.setStash(id, { gp: 12 });
  store.setRng(id, { s: 7 });
  store.setSettings(id, { xpMode: 'milestone' });
  store.setCampaign(id, { v: 1, nodes: [{ id: 'n1' }] });
  store.setStatus(id, 'between');
  let r = store.getRun(id);
  assert.deepEqual([r.status, r.currentNodeId, r.stash, r.rng, r.settings.xpMode, r.campaign.nodes.length], ['between', 'n1', { gp: 12 }, { s: 7 }, 'milestone', 1]);
  assert.throws(() => store.setStatus(id, 'ended'), (e) => e.code === 'BAD_OUTCOME', 'an ended run needs an outcome');
  assert.throws(() => store.setStatus(id, 'ended', { outcome: 'tpk' }), (e) => e.code === 'BAD_OUTCOME');
  assert.throws(() => store.setStatus(id, 'done'), (e) => e.code === 'BAD_STATUS');
  store.setStatus(id, 'ended', { outcome: 'victory' });
  r = store.getRun(id);
  assert.deepEqual([r.status, r.outcome, r.endedAt > 0], ['ended', 'victory', true]);
  assert.throws(() => store.setStatus(id, 'between'), (e) => e instanceof RunStoreError && e.code === 'E_RUN_ENDED');
  assert.throws(() => store.setStatus('nope', 'between'), (e) => e.code === 'NOT_FOUND');
  assert.equal(preparesAfterBuild(), 0, 'no statement is prepared after the store is built');
  db.close();
});

test('run events: seq bumps with each append, read back after a seq', async () => {
  const { db, store, preparesAfterBuild } = await setup();
  const id = store.createRun({ roomId: 'r1', campaign: {} });
  const seqs = store.tx(() => [
    store.appendEvent(id, { type: 'run.started', actorKind: 'dm', actorId: 'p_dm' }),
    store.appendEvent(id, { type: 'node.entered', actorKind: 'system', nodeId: 'n1', payload: { before: null, after: 'n1' } }),
    store.appendEvent(id, { type: 'dm.override', actorKind: 'dm', override: true, payload: { what: 'xp' } })
  ])();
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.equal(store.getRun(id).seq, 3);
  const evs = store.listEvents(id, { afterSeq: 1 });
  assert.deepEqual(evs.map(e => [e.seq, e.type, e.nodeId, e.override]), [[2, 'node.entered', 'n1', false], [3, 'dm.override', null, true]]);
  assert.deepEqual(evs[0].payload, { before: null, after: 'n1' });
  assert.throws(() => store.appendEvent('nope', { type: 'x', actorKind: 'dm' }), (e) => e.code === 'NOT_FOUND');
  // A failed append inside a transaction rolls the seq back too.
  assert.throws(() => store.tx(() => { store.appendEvent(id, { type: 'ok', actorKind: 'dm' }); store.appendEvent(id, { type: 'bad', actorKind: 'npc' }); })(), /CHECK/);
  assert.equal(store.getRun(id).seq, 3);
  assert.equal(preparesAfterBuild(), 0);
  db.close();
});

test('run characters: attach, the view, and the optimistic version lock', async () => {
  const { db, store, preparesAfterBuild } = await setup();
  const id = store.createRun({ roomId: 'r1', campaign: {} });
  const c = store.attachSeat(id, 's1', { sheet: { name: 'Saris', level: 4 }, state: { v: 1, hpSpent: 0 }, level: 4, seedRawSha: 'a'.repeat(64) });
  assert.deepEqual([c.runId, c.level, c.xp, c.lifeStatus, c.version], [id, 4, 0, 'active', 1]);
  assert.throws(() => store.attachSeat(id, 's1', { sheet: {}, state: {} }), (e) => e.code === 'E_SEAT_IN_RUN');
  assert.deepEqual(store.listCharacters(id).map(x => x.slotId), ['s1'], 'only run seats show in run_characters');

  // Two writers read version 1; the first wins, the second gets E_VERSION.
  const v1 = store.getCharacter('s1').version;
  const v2 = store.updateCharacter(id, 's1', v1, { state: { v: 1, hpSpent: 7 }, xp: 300 });
  assert.equal(v2, 2);
  assert.throws(() => store.updateCharacter(id, 's1', v1, { state: { v: 1, hpSpent: 0 } }), (e) => e instanceof RunStoreError && e.status === 409 && e.code === 'E_VERSION');
  let now = store.getCharacter('s1');
  assert.deepEqual([now.version, now.xp, now.state.hpSpent, now.sheet.name, now.level], [2, 300, 7, 'Saris', 4], 'only the patched fields change');
  store.updateCharacter(id, 's1', 2, { lifeStatus: 'dead', level: 5, sheet: { name: 'Saris', level: 5 } });
  now = store.getCharacter('s1');
  assert.deepEqual([now.version, now.lifeStatus, now.level, now.sheet.level, now.xp], [3, 'dead', 5, 5, 300]);
  assert.throws(() => store.updateCharacter(id, 's1', 3, { lifeStatus: 'undead' }), /CHECK/);
  assert.equal(store.getCharacter('s1').version, 3, 'a refused write does not bump the version');
  assert.throws(() => store.updateCharacter(id, 's2', 0, { xp: 1 }), (e) => e.code === 'NOT_FOUND', 'a seat outside the run');

  // Archive before reuse, then detach.
  const arId = store.archiveSeat(id, 's1', 'dead');
  const [ar] = store.listArchived(id);
  assert.deepEqual([ar.id, ar.slotId, ar.seat, ar.name, ar.level, ar.xp, ar.lifeStatus, ar.reason], [arId, 's1', 1, 'Saris', 5, 300, 'dead', 'dead']);
  assert.deepEqual(ar.sheet, { name: 'Saris', level: 5 });
  assert.throws(() => store.archiveSeat(id, 's2', 'x'), (e) => e.code === 'NOT_FOUND');
  assert.equal(store.detachSeat(id, 's1'), true);
  assert.deepEqual(store.listCharacters(id), []);
  assert.equal(preparesAfterBuild(), 0);
  db.close();
});

test('run items, level-ups and snapshots', async () => {
  const { db, store, preparesAfterBuild } = await setup();
  const id = store.createRun({ roomId: 'r1', campaign: {} });
  store.attachSeat(id, 's1', { sheet: {}, state: {}, level: 4 });
  const potion = store.addItem(id, { ownerSlotId: 's1', origin: 'open5e', refKey: 'srd_potion-of-healing', name: 'Potion of Healing', qty: 2 });
  const rope = store.addItem(id, { origin: 'dm', name: 'Rope', data: { feet: 50 } });
  assert.deepEqual(store.listItems(id, { ownerSlotId: null }).map(i => i.name), ['Rope'], 'the stash');
  assert.deepEqual(store.listItems(id, { ownerSlotId: 's1' }).map(i => [i.name, i.qty]), [['Potion of Healing', 2]]);
  assert.equal(store.listItems(id).length, 2);
  const moved = store.updateItem(id, rope, { ownerSlotId: 's1', equipped: true });
  assert.deepEqual([moved.ownerSlotId, moved.equipped, moved.data.feet], ['s1', true, 50]);
  assert.equal(store.updateItem(id, potion, { qty: 1 }).qty, 1);
  assert.throws(() => store.updateItem(id, potion, { qty: -1 }), /CHECK/);
  assert.throws(() => store.updateItem(id, 'nope', { qty: 1 }), (e) => e.code === 'NOT_FOUND');
  assert.equal(store.deleteItem(id, potion), true);

  const lu = store.addLevelUp(id, { slotId: 's1', fromLevel: 4, className: 'Cleric', mode: 'choose', auto: { hp: 5 } });
  assert.deepEqual(store.pendingLevelUps('s1').map(l => [l.fromLevel, l.toLevel, l.status]), [[4, 5, 'pending_player']]);
  assert.equal(store.decideLevelUp(id, lu, { fromStatus: 'pending_player', status: 'pending_dm', choices: { asi: { WIS: 2 } } }), true);
  assert.equal(store.decideLevelUp(id, lu, { fromStatus: 'pending_player', status: 'pending_dm' }), false, 'compare-and-set');
  assert.equal(store.decideLevelUp(id, lu, { fromStatus: 'pending_dm', status: 'applied', granted: [{ path: 'level', before: 4, after: 5 }], decidedBy: 'p_dm' }), true);
  const done = store.getLevelUp(id, lu);
  assert.deepEqual([done.status, done.choices.asi.WIS, done.granted[0].after, done.decidedBy, done.auto.hp], ['applied', 2, 5, 'p_dm', 5]);
  assert.deepEqual(store.pendingLevelUps('s1'), []);
  assert.equal(store.listLevelUps(id).length, 1);

  const snap = store.saveSnapshot(id, { label: 'Before the crypt', atSeq: 0, blob: { v: 1, seats: [] }, createdBy: 'p_dm' });
  assert.deepEqual(store.listSnapshots(id).map(x => [x.id, x.label, x.blob]), [[snap, 'Before the crypt', undefined]], 'the list leaves the blob out');
  assert.deepEqual(store.getSnapshot(id, snap).blob, { v: 1, seats: [] });
  assert.equal(preparesAfterBuild(), 0);
  db.close();
});

test('encounter write-back mark: linked, applied exactly once, swept while unapplied', async () => {
  const { db, store, preparesAfterBuild } = await setup();
  const id = store.createRun({ roomId: 'r1', campaign: {} });
  db.db.prepare("INSERT INTO encounters (id, room_id, status, engine_version, snapshot_json, created_at, updated_at, ended_at, outcome) VALUES ('e1', 'r1', 'ended', 1, '{}', 1, 1, 5, 'party-victory')").run();
  assert.deepEqual(store.unappliedEncounters(), [], 'not a run encounter yet');
  assert.equal(store.markEncounterApplied('e1'), false, 'a non-run encounter is never marked');
  assert.equal(store.linkEncounter('e1', id, 'n1'), true);
  assert.deepEqual(store.unappliedEncounters(), [{ encounterId: 'e1', roomId: 'r1', runId: id, nodeId: 'n1', outcome: 'party-victory', endedAt: 5 }]);
  assert.equal(store.markEncounterApplied('e1'), true);
  assert.equal(store.markEncounterApplied('e1'), false, 'the second caller loses');
  assert.deepEqual(store.unappliedEncounters(), []);
  assert.equal(preparesAfterBuild(), 0);
  db.close();
});

test('janitor: a 31-day-idle room with a run survives; ended runs age out at 90 days, then their room goes', async () => {
  const { db } = await tempDb(root);
  const NOW = 200 * DAY;
  const room = (id, code) => db.db.prepare('INSERT INTO rooms (id, code, dm_token_hash, created_at, last_active_at) VALUES (?, ?, ?, 1, ?)').run(id, code, `h-${id}`, NOW - 31 * DAY);
  const run = (id, roomId, status, endedAt = null) => db.db.prepare(
    'INSERT INTO runs (id, room_id, status, outcome, campaign_json, created_at, updated_at, ended_at) VALUES (?, ?, ?, ?, \'{}\', 1, 1, ?)'
  ).run(id, roomId, status, status === 'ended' ? 'victory' : null, endedAt);
  room('between', 'AAAAA1'); run('run-b', 'between', 'between');
  room('paused', 'AAAAA2'); run('run-p', 'paused', 'paused');
  room('lobby', 'AAAAA3'); run('run-l', 'lobby', 'lobby');
  room('fresh-end', 'AAAAA4'); run('run-f', 'fresh-end', 'ended', NOW - 10 * DAY);
  room('old-end', 'AAAAA5'); run('run-o', 'old-end', 'ended', NOW - 91 * DAY);
  room('plain', 'AAAAA6');
  db.db.prepare("INSERT INTO party_slots (id, room_id, seat, updated_at, run_id, xp) VALUES ('s-b', 'between', 1, 1, 'run-b', 900)").run();
  db.db.prepare("INSERT INTO run_events (run_id, seq, ts, actor_kind, type) VALUES ('run-o', 1, 1, 'dm', 'run.started')").run();

  const removed = [];
  const j = createJanitor({ db, dataDir: '/data', now: () => NOW, fs: { statSync: () => ({ size: 1 }), rmSync: (p) => removed.push(p) } });
  const out = j.runOnce();
  assert.equal(out.runsDeleted, 1, 'only the run ended 91 days ago');
  assert.deepEqual(out.roomsDeleted.sort(), ['old-end', 'plain']);
  const ids = db.db.prepare('SELECT id FROM rooms ORDER BY id').all().map(r => r.id);
  assert.deepEqual(ids, ['between', 'fresh-end', 'lobby', 'paused']);
  assert.equal(db.db.prepare("SELECT xp FROM party_slots WHERE id = 's-b'").get().xp, 900, 'the paused campaign keeps its party');
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'run-o'").get().n, 0, 'the aged run\'s log goes with it');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 4);
  assert.deepEqual(j.runOnce(), { eventsDeleted: 0, runsDeleted: 0, roomsDeleted: [], walCheckpoint: false }, 'idempotent');
  db.close();
});
