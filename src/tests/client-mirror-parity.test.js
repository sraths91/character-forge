/**
 * M64 phase 1.5 (E2 task 1) — the client mirror reproduces the server's
 * `turn.ended.stateHash` from the event stream alone.
 *
 * Every golden encounter fixture runs through a Room on the REAL engine
 * port (the same harness as api/tests/real-engine.test.js: scripted
 * intents, the DM answering, delegate otherwise) and its journal's event
 * log is folded into the client mirror (client/mirror.js) starting from
 * the projected start state. At every `turn.ended` the mirror's shared
 * `stateHash` must equal the hash the room stamped — no resync.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Room } from '../../api/rooms/room.js';
import { createRoomService } from '../../api/rooms/service.js';
import { createSqliteJournal } from '../../api/rooms/persistence.js';
import { createRealEngine } from '../../api/rooms/real-engine.js';
import { viewFor } from '../../api/rooms/view.js';
import { tempRoot, tempDb, quiet, seedRoom } from '../../api/tests/helpers/server.js';
import * as TM from '../js/scene/turn-manager.js';
import { stateHash, stateHashInput } from '../js/shared/state-hash.js';
import { applyEventToEncounter } from '../js/client/mirror.js';
import { parsedDdbFixture } from './helpers/entities.js';

const { root, cleanup } = tempRoot('cf-mirror-');
after(cleanup);

const FIXTURES = new URL('./fixtures/encounters/', import.meta.url);
const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));

function loadFixture(name) {
  const read = (f) => JSON.parse(readFileSync(new URL(f, FIXTURES), 'utf8'));
  return { state: read(`${name}.state.json`), intents: read(`${name}.intents.json`) };
}

function fixtureSheets(state) {
  const out = {};
  for (const e of Object.values(state.entities)) if (e.kind === 'pc') out[e.sheetRef.characterId] = parsedDdbFixture(e.sheetRef.characterId);
  return out;
}

function script(intents) {
  const byActor = new Map();
  const armed = [];
  for (const s of intents) {
    if (s.t === 'turn.act' || s.t === 'turn.delegate') {
      if (!byActor.has(s.actorId)) byActor.set(s.actorId, []);
      byActor.get(s.actorId).push(s);
    } else if (s.t === 'dm.roll.arm') {
      armed.push({ entityId: s.p.entityId ?? null, rollKind: s.p.rollKind, value: s.p.value });
    }
  }
  const strip = (plan) => { const { innate: _i, ...p } = plan; return p; };
  return { next: (id) => { const q = byActor.get(id); const s = q?.shift(); return s ? { ...s, ...(s.plan ? { plan: strip(s.plan) } : {}) } : null; }, armed };
}

/** Run `name` through a Room on the real engine; return its start state and event log. */
async function runRoom(name, turns, { aiControlled = false, fixture: given = null } = {}) {
  const { state: fixture, intents } = given || loadFixture(name);
  const ts = TM.turnStateFromEncounter(fixture, fixtureSheets(fixture));
  TM.startEncounter(ts, { initiative: 'given' });
  const start = TM.encounterFromTurnState(ts);
  start.phase = 'running';
  const sc = script(intents);
  const sheets = fixtureSheets(start);
  const { db } = await tempDb(root, `${name}-${aiControlled ? 'ai' : 'dm'}.db`);
  const { roomId, dmId } = seedRoom(db);
  const service = createRoomService({ db });
  const engine = createRealEngine({ resolveSheets: () => sheets });
  const state = clone(start);
  for (const e of Object.values(state.entities)) e.controller = { type: aiControlled ? 'ai' : 'dm', seatId: null };
  const real = createSqliteJournal({ db: db.db });
  real.createEncounter({ roomId, encounterId: state.encounterId, state, engineVersion: engine.version });
  real.setStatus(state.encounterId, 'active');
  const events = [];
  const journal = { ...real, flush: (o) => { events.push(...o.events); real.flush(o); } };
  const room = new Room({ id: roomId, service, engine, journal, log: quiet });
  const replies = [];
  const conn = { id: 'c', sendRaw: (text) => replies.push(JSON.parse(text)), close() {} };
  let cid = 0;
  const send = async (t, p) => { await room.handle(conn, dmId, { t, cid: `c${++cid}`, p }); return replies.at(-1); };
  for (const a of sc.armed) await send('dm.roll.arm', a);
  room.resume();
  const answered = new Set();
  for (let guard = 0; guard < 20000; guard++) {
    if (events.filter(e => e.type === 'turn.ended').length >= turns || room.enc.status !== 'active') break;
    const aw = room.turn?.awaiting;
    if (aw && !answered.has(room.turn.turnId)) {
      const turnId = room.turn.turnId;
      answered.add(turnId);
      const step = sc.next(aw.actorId);
      const r = step?.t === 'turn.act' ? await send('turn.act', { turnId, plan: step.plan }) : null;
      if (!r || r.t !== 'ack') await send('turn.delegate', { turnId });
    }
    await tick();
  }
  await tick();
  room.shutdown();
  db.close();
  return { start: { ...viewFor(state, null), controllerless: undefined }, events };
}

/** Fold the log into the mirror; the first mismatching turn.ended, with a diff. */
function replay(start, events) {
  let enc = clone(start);
  delete enc.controllerless;
  let prev = null;
  let checked = 0;
  for (const ev of events) {
    enc = applyEventToEncounter(enc, ev, { prev });
    prev = ev;
    if (ev.type !== 'turn.ended' || typeof ev.payload.stateHash !== 'string') continue;
    checked++;
    if (stateHash(enc) !== ev.payload.stateHash) return { checked, mismatch: ev, mirror: stateHashInput(enc) };
  }
  return { checked, mismatch: null };
}

const FIXTURE_NAMES = [
  'action-surge', 'aoe-save-half', 'concentration-broken', 'counterspell', 'dm-force-roll',
  'downed-dm-sethp', 'flank-and-ranged-in-melee', 'legendary-actions', 'oa-leave-melee',
  'pc-ai-turn', 'shield-reaction', 'upcast-heal'
];

for (const name of FIXTURE_NAMES) {
  for (const aiControlled of [false, true]) {
    test(`mirror parity: ${name} (${aiControlled ? 'all AI' : 'DM-scripted'}) — every turn.ended hash reproduced from events`, async () => {
      const { start, events } = await runRoom(name, 12, { aiControlled });
      const r = replay(start, events);
      assert.ok(r.checked >= 2, `${name}: at least two turns checked`);
      if (r.mismatch) {
        const at = events.indexOf(r.mismatch);
        const turn = events.slice(Math.max(0, at - 40), at + 1).map(e => `${e.seq} ${e.type} ${JSON.stringify(e.payload).slice(0, 140)}`).join('\n');
        assert.fail(`${name}: turn.ended seq ${r.mismatch.seq} hash differs after ${r.checked - 1} matches\nmirror: ${JSON.stringify(r.mirror)}\n${turn}`);
      }
    });
  }
}

// ---- events v1.3 resource.recharged (E1 wave 6) ---------------------------

test('mirror parity: a young dragon whose Fire Breath recharges unspent — the recharge is replayed', async () => {
  const base = loadFixture('aoe-save-half');
  const state = clone(base.state);
  // Fire Breath starts spent; the dragon only ever claws, so a successful
  // recharge roll leaves it available across the turn.ended hash.
  state.entities['m-dragon'].resources.innate.recharges['fire-breath'] = false;
  const claw = { t: 'turn.act', actorId: 'm-dragon', plan: { kind: 'melee', targetId: 'pc-fighter', weaponName: 'Claws' } };
  const intents = Array.from({ length: 8 }, () => [{ t: 'round.start' }, claw]).flat();
  const { start, events } = await runRoom('aoe-recharge', 24, { fixture: { state, intents } });
  const at = events.findIndex(e => e.type === 'resource.recharged');
  assert.ok(at >= 0, 'the recharge roll succeeded at least once');
  assert.deepEqual(events[at].payload, { entityId: 'm-dragon', resource: 'innate', spellId: 'fire-breath', available: 1 });
  const spentAfter = events.slice(at).find(e => e.type === 'resource.spent' && e.payload.resource === 'innate:fire-breath');
  const endedAfter = events.slice(at).find(e => e.type === 'turn.ended');
  assert.ok(endedAfter && (!spentAfter || spentAfter.seq > endedAfter.seq), 'a turn.ended hash is taken while the recharge is unspent');
  const r = replay(start, events);
  assert.ok(r.checked >= 2);
  assert.equal(r.mismatch, null, r.mismatch ? `seq ${r.mismatch.seq}: ${JSON.stringify(r.mirror)}` : '');
});
