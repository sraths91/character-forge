// M64 Wave 4 — the real engine port (api/rooms/real-engine.js).
//
// The golden parity gate: E6's encounter fixtures, the same seed and the
// same scripted intents, run (a) straight through E1's turn manager with
// one live TurnState and (b) through a Room driving the real engine port
// (JSON state per turn, prompts, journal) must produce the same
// turn-by-turn stateHash sequence. Plus unit tests for setup, intent
// validation, DM commands and engine selection.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Room } from '../rooms/room.js';
import { createRoomService } from '../rooms/service.js';
import { createSqliteJournal } from '../rooms/persistence.js';
import { createRealEngine, REAL_ENGINE_VERSION, presetSlugFor, statBlockFromOpen5e, sheetForSeat } from '../rooms/real-engine.js';
import { createEngine } from '../multiplayer.js';
import { createStubEngine } from '../rooms/engine-port.js';
import * as TM from '../../src/js/scene/turn-manager.js';
import { planFromIntent } from '../../src/js/scene/intent-validation.js';
import { createRng } from '../../src/js/scene/rng.js';
import { stateHash } from '../../src/js/shared/state-hash.js';
import { validateEncounterState } from '../../src/js/shared/encounter-state.js';
import { validateEvent } from '../../src/js/shared/events.js';
import { parsedDdbFixture } from '../../src/tests/helpers/entities.js';
import { tempRoot, tempDb, quiet, seedRoom } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-real-');
after(cleanup);

const FIXTURES = new URL('../../src/tests/fixtures/encounters/', import.meta.url);
const clone = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));

function loadFixture(name) {
  const state = JSON.parse(readFileSync(new URL(`${name}.state.json`, FIXTURES), 'utf8'));
  const intents = JSON.parse(readFileSync(new URL(`${name}.intents.json`, FIXTURES), 'utf8'));
  return { state, intents };
}

function fixtureSheets(state) {
  const out = {};
  for (const e of Object.values(state.entities)) if (e.kind === 'pc') out[e.sheetRef.characterId] = parsedDdbFixture(e.sheetRef.characterId);
  return out;
}

/** Fixture → a running round-1 state (initiative as given) both runs start from. */
function startState(name) {
  const { state, intents } = loadFixture(name);
  const ts = TM.turnStateFromEncounter(state, fixtureSheets(state));
  TM.startEncounter(ts, { initiative: 'given' });
  const start = TM.encounterFromTurnState(ts);
  start.phase = 'running';
  return { start, intents };
}

/** Per-actor queues of scripted turn steps; armed rolls in order. */
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

/** (a) Straight through the turn manager: one TurnState for the whole run. */
async function runDirect(name, turns) {
  const { start, intents } = startState(name);
  const sc = script(intents);
  const sheets = fixtureSheets(start);
  const validator = createRealEngine({ resolveSheets: () => sheets });
  const ts = TM.turnStateFromEncounter(clone(start), sheets);
  const rng = createRng(start.rng);
  const armed = sc.armed.slice();
  const onRoll = async ({ kind, actorId, result }) => {
    const i = armed.findIndex(a => a.rollKind === kind && (a.entityId == null || a.entityId === actorId));
    if (i < 0) return result;
    const [a] = armed.splice(i, 1);
    if (kind === 'attack') return result.d20 ? { ...result, d20: { ...result.d20, kept: a.value } } : result;
    if (kind === 'save') return { ...result, kept: a.value };
    return { ...result, total: a.value };
  };
  const hashes = [];
  const emitted = [];
  for (let n = 0; n < turns && ts.phase === 'running'; n++) {
    const actorId = ts.initiative[ts.turnIndex].entityId;
    let memo;
    const prompts = {
      ...(armed.length ? { onRoll } : {}),
      // Read only when the actor's turn actually runs (memoised for the turn).
      get forcePlan() {
        if (memo !== undefined) return memo;
        const cur = TM.encounterFromTurnState(ts);
        const step = sc.next(actorId);
        memo = null;
        if (step?.t === 'turn.act' && validator.validateIntent(cur, { actorId, plan: step.plan }).ok) {
          memo = planFromIntent(cur, { actorId, plan: step.plan }, { sheets });
        }
        return memo;
      }
    };
    await TM.runTurn(ts, { rng, prompts, planSource: 'dm', emit: (ev) => emitted.push(ev) });
    hashes.push(stateHash(TM.encounterFromTurnState(ts)));
  }
  const tmHashes = emitted.filter(e => e.type === 'turn.ended').map(e => e.payload.stateHash);
  return { hashes, tmHashes };
}

/** (b) Through a Room on the real engine port, the DM answering every intent. */
async function runRoom(name, turns) {
  const { start, intents } = startState(name);
  const sc = script(intents);
  const sheets = fixtureSheets(start);
  const { db } = await tempDb(root);
  const { roomId, dmId } = seedRoom(db);
  const service = createRoomService({ db });
  const engine = createRealEngine({ resolveSheets: () => sheets });
  const state = clone(start);
  for (const e of Object.values(state.entities)) e.controller = { type: 'dm', seatId: null };
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
  for (const a of sc.armed) assert.equal((await send('dm.roll.arm', a)).t, 'ack');
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
  for (const ev of events) assert.ok(validateEvent(ev).ok, `${name}: invalid ${ev.type}`);
  const types = events.map(e => e.type);
  return { hashes: events.filter(e => e.type === 'turn.ended').map(e => e.payload.stateHash).slice(0, turns), types, state: room.enc.state, db };
}

// Every fixture whose script is turns only (plus armed rolls); the DM
// mid-round HP edit of downed-dm-sethp has no between-turns equivalent here.
const PARITY = [
  'action-surge', 'aoe-save-half', 'concentration-broken', 'counterspell', 'dm-force-roll',
  'flank-and-ranged-in-melee', 'legendary-actions', 'oa-leave-melee', 'pc-ai-turn',
  'shield-reaction', 'upcast-heal'
];
const TURNS = 6;

for (const name of PARITY) {
  test(`parity: ${name} — the room on the real engine reproduces the turn manager's stateHash sequence`, async () => {
    const direct = await runDirect(name, TURNS);
    const viaRoom = await runRoom(name, TURNS);
    try {
      assert.ok(direct.hashes.length >= 2, `${name}: at least two turns ran`);
      assert.ok(new Set(direct.hashes).size >= 2, `${name}: the turns changed the state`);
      assert.ok(viaRoom.types.some(t => t === 'exchange' || t === 'spell.cast'), `${name}: something resolved`);
      if (process.env.PARITY_DEBUG) console.log(name, direct.hashes.length, viaRoom.types.join(','));
      assert.deepEqual(viaRoom.hashes, direct.hashes, `${name}: stateHash sequence diverged`);
      for (const h of direct.tmHashes) assert.ok(direct.hashes.includes(h), 'turn.ended.stateHash is the post-turn hash');
      assert.ok(validateEncounterState(viaRoom.state).ok, 'the room snapshot is a valid EncounterState');
      assert.equal(viaRoom.types.filter(t => t === 'reaction.offered').length, viaRoom.types.filter(t => t === 'reaction.resolved').length);
    } finally { viaRoom.db.close(); }
  });
}

// ------------------------------------------------------------- setup

const seat = (n, fixture, extra = {}) => ({
  slotId: `s_${n}`, seat: n, characterId: String(n), characterName: null, controller: 'player', aiArchetype: null,
  seed: parsedDdbFixture(fixture), ...extra
});

test('buildEncounter: rested PCs from seat seeds, monsters from presets and the Open5e cache', () => {
  const lookups = [];
  const engine = createRealEngine({
    monsterLookup: (slug) => { lookups.push(slug); return slug === 'srd_ogre' ? { key: 'srd_ogre', name: 'Ogre', hit_points: 59, armor_class: 11, type: 'giant', cr: 2 } : null; }
  });
  const st = engine.buildEncounter({
    encounterId: 'e1', seed: 5, setup: {
      map: null, grid: { cols: 10, rows: 8 }, placements: { gob: { col: 4, row: 4 } },
      monsters: [{ id: 'gob', slug: 'goblin', hp: 9 }, { id: 'ogre', slug: 'srd_ogre' }, { id: 'thing', slug: 'homebrew_thing', name: 'Strange Orc Thing' }, { id: 'plain' }]
    },
    party: [seat(1, 'fighter-l5'), seat(2, 'wizard-l5', { controller: 'ai', aiArchetype: 'cleric' })]
  });
  assert.ok(validateEncounterState(st).ok, JSON.stringify(validateEncounterState(st).errors));
  assert.equal(st.engineVersion, undefined);
  assert.equal(engine.version, REAL_ENGINE_VERSION);
  const f = st.entities['pc-1'];
  assert.deepEqual([f.hp, f.hpMax, f.ac, f.controller.type, f.controller.seatId], [44, 44, 18, 'player', 's_1']);
  assert.equal(st.entities['pc-2'].controller.type, 'ai');
  assert.ok(Object.values(st.entities['pc-2'].resources.slots).every(l => l.spent === 0), 'rested');
  assert.deepEqual([st.entities.gob.hp, st.entities.gob.pos], [9, { col: 4, row: 4 }]);
  assert.deepEqual([st.entities.ogre.name, st.entities.ogre.hpMax, st.entities.ogre.ac, st.entities.ogre.statBlock.slug], ['Ogre', 59, 11, 'troll']);
  assert.ok(st.entities.ogre.statBlock.profile, 'an inferred AI profile rides the stat block');
  assert.deepEqual(lookups, ['srd_ogre', 'homebrew_thing']);
  assert.equal(st.entities.thing.statBlock.slug, 'orc');
  assert.equal(st.entities.plain.statBlock.slug, 'goblin', 'no slug: the stub-compatible default');
  // The AI seat's archetype becomes the sheet's AI profile.
  assert.ok(engine.sheetsFor(st)[st.entities['pc-2'].sheetRef.characterId]._aiProfile);
});

test('buildEncounter with importLiveState seeds HP and spent slots from the sheet', () => {
  const engine = createRealEngine();
  const wiz = parsedDdbFixture('wizard-l5');
  wiz.hp = { ...wiz.hp, current: 11 };
  wiz.slotsUsed = { spell: { 1: 3, 3: 1 }, pact: {} };
  const party = [{ ...seat(1, 'wizard-l5'), seed: wiz }];
  const setup = { map: null, grid: { cols: 6, rows: 6 }, monsters: [], placements: {} };
  const rested = engine.buildEncounter({ encounterId: 'e2', seed: 1, setup, party });
  const live = engine.buildEncounter({ encounterId: 'e3', seed: 1, setup, party, settings: { importLiveState: true } });
  assert.equal(rested.entities['pc-1'].hp, 32);
  assert.equal(live.entities['pc-1'].hp, 11);
  assert.equal(live.entities['pc-1'].resources.slots['1'].spent, Math.min(3, live.entities['pc-1'].resources.slots['1'].max));
  assert.equal(live.entities['pc-1'].resources.slots['3'].spent, 1);
  assert.ok(validateEncounterState(live).ok);
});

test('presetSlugFor / statBlockFromOpen5e / sheetForSeat', () => {
  assert.equal(presetSlugFor({ slug: 'srd_goblin' }), 'goblin');
  assert.equal(presetSlugFor({ preset: 'skeleton', slug: 'srd_wight' }), 'skeleton');
  assert.equal(presetSlugFor({}), 'goblin');
  assert.equal(presetSlugFor({ slug: 'srd_aboleth', name: 'Aboleth' }), 'bandit');
  assert.equal(presetSlugFor({ slug: 'srd_wight', name: 'Wight' }, 'Undead'), 'skeleton');
  assert.deepEqual(statBlockFromOpen5e(null), {});
  assert.equal(statBlockFromOpen5e({ name: 'X', hit_points: 0, armor_class: 99 }).hpMax, undefined);
  assert.equal(sheetForSeat({ seed: null }), null);
  assert.equal(sheetForSeat({ seed: { id: 1 }, aiArchetype: 'auto' })._aiProfile, undefined);
});

test('sheets survive a restart through the resolver; a missing sheet is a clear error', () => {
  const a = createRealEngine();
  const st = a.buildEncounter({ encounterId: 'e4', seed: 1, setup: { map: null, grid: { cols: 6, rows: 6 }, monsters: [{ id: 'gob' }], placements: {} }, party: [seat(1, 'cleric-l5')] });
  const calls = [];
  const b = createRealEngine({ resolveSheets: (s) => { calls.push(s.encounterId); return { [st.entities['pc-1'].sheetRef.characterId]: parsedDdbFixture('cleric-l5') }; } });
  assert.ok(b.sheetsFor(st));
  b.sheetsFor(st);
  assert.deepEqual(calls, ['e4'], 'resolved once, then cached');
  assert.throws(() => createRealEngine().sheetsFor(st), /no character sheet for pc-1/);
  assert.equal(createRealEngine().validateIntent(st, { actorId: 'pc-1', plan: { kind: 'attack', targetId: 'gob' } }).code, 'no-sheet');
});

// ---------------------------------------------------------- turns & DM

function running(engine, monsters = [{ id: 'gob', hp: 20 }], party = [seat(1, 'fighter-l5')], grid = { cols: 8, rows: 6 }) {
  const st = engine.buildEncounter({ encounterId: `e-${Math.random().toString(36).slice(2)}`.replace(/[^a-z0-9-]/g, ''), seed: 77, setup: { map: null, grid, monsters, placements: {} }, party });
  return st;
}

test('startEncounter rolls initiative (or keeps a set order) without touching state.rng', async () => {
  const engine = createRealEngine();
  const st = running(engine);
  const rng = createRng({ s: 99 });
  const { state } = await engine.startEncounter(st, { rng, emit: () => {} });
  assert.equal(state.phase, 'running');
  assert.equal(state.round, 1);
  assert.equal(state.initiative.length, 2);
  assert.deepEqual(state.rng, st.rng, 'the room writes rng back, not the port');
  assert.notDeepEqual(rng.state(), { algo: 'mulberry32', s: 99 }, 'initiative drew from ctx.rng');
  const set = engine.applyDmCommand(st, { type: 'dm.initiative.set', payload: { order: ['gob', 'pc-1'] } }, { rng, emit: () => {} }).state;
  const kept = (await engine.startEncounter(set, { rng, emit: () => {} })).state;
  assert.deepEqual(kept.initiative.map(r => r.entityId), ['gob', 'pc-1']);
});

test('validateIntent: turn, side, range bands and line of sight', async () => {
  const engine = createRealEngine();
  const st = running(engine, [{ id: 'gob', hp: 20 }], [seat(1, 'wizard-l5'), seat(2, 'fighter-l5')], { cols: 30, rows: 6 });
  const set = engine.applyDmCommand(st, { type: 'dm.initiative.set', payload: { order: ['pc-1', 'pc-2', 'gob'] } }, { rng: createRng({ s: 1 }), emit: () => {} }).state;
  const s = (await engine.startEncounter(set, { rng: createRng({ s: 1 }), emit: () => {} })).state;
  assert.deepEqual(engine.validateIntent(s, { actorId: 'pc-1', plan: { kind: 'attack', targetId: 'gob' } }), { ok: true });
  assert.equal(engine.validateIntent(s, { actorId: 'pc-2', plan: { kind: 'attack', targetId: 'gob' } }).code, 'not-your-turn');
  assert.equal(engine.validateIntent(s, { actorId: 'pc-1', plan: { kind: 'attack', targetId: 'pc-2' } }).code, 'wrong-side');
  // Light crossbow 80/320: a goblin 125 ft away is in long range, 400 ft is out.
  const far = clone(s);
  far.entities.gob.pos = { col: 25, row: 5 };
  assert.equal(engine.validateIntent(far, { actorId: 'pc-1', plan: { kind: 'attack', targetId: 'gob' } }).ok, true);
  // Total cover between them blocks a shot that needs no move.
  const walled = engine.applyDmCommand(s, { type: 'dm.entity.patch', payload: { entityId: 'gob', position: { col: 0, row: 4 } } }, { rng: createRng({ s: 1 }), emit: () => {} }).state;
  walled.grid.terrain = { v: 1, cols: 30, rows: 6, flags: Buffer.from(Array.from({ length: 180 }, (_, i) => (i === 60 ? 16 : 0))).toString('base64') };
  assert.equal(engine.validateIntent(walled, { actorId: 'pc-1', plan: { kind: 'attack', targetId: 'gob', moveTo: { col: 0, row: 0 } } }).code, 'out-of-range');
  assert.equal(engine.validateIntent(walled, { actorId: 'pc-1', plan: { kind: 'cast', spellId: 'nope', targetId: 'gob' } }).code, 'unknown-spell');
});

test('validateIntent: class features at the turn\'s safe point (a legal Action Surge passes; spent / wrong class / unknown fail)', async () => {
  const engine = createRealEngine();
  const st = running(engine, [{ id: 'gob', hp: 20 }], [seat(1, 'fighter-l5'), seat(2, 'wizard-l5')]);
  const set = engine.applyDmCommand(st, { type: 'dm.initiative.set', payload: { order: ['pc-1', 'pc-2', 'gob'] } }, { rng: createRng({ s: 1 }), emit: () => {} }).state;
  const s = (await engine.startEncounter(set, { rng: createRng({ s: 1 }), emit: () => {} })).state;
  const surge = { kind: 'attack', targetId: 'gob', features: ['action-surge'] };
  assert.deepEqual(engine.validateIntent(s, { actorId: 'pc-1', plan: surge }), { ok: true });
  assert.deepEqual(engine.validateIntent(s, { actorId: 'pc-1', plan: { kind: 'feature', features: ['second-wind'] } }), { ok: true });
  const spent = clone(s);
  spent.entities['pc-1'].resources.features['action-surge'].spent = spent.entities['pc-1'].resources.features['action-surge'].max;
  assert.equal(engine.validateIntent(spent, { actorId: 'pc-1', plan: surge }).code, 'bad-feature', 'no use left this rest');
  assert.equal(engine.validateIntent(s, { actorId: 'pc-1', plan: { ...surge, features: ['nope'] } }).code, 'bad-feature');
  const wiz = { ...s, turnIndex: 1 };
  assert.match(engine.validateIntent(wiz, { actorId: 'pc-2', plan: { kind: 'attack', targetId: 'gob', features: ['action-surge'] } }).reason, /Action Surge is not available/);
  // The other rules still run first: a surge on the wrong turn is not-your-turn.
  assert.equal(engine.validateIntent(s, { actorId: 'pc-2', plan: { kind: 'attack', targetId: 'gob', features: ['action-surge'] } }).code, 'not-your-turn');
});

test('applyDmCommand: patch via the adapters, add/remove through the initiative helpers, initiative roll', async () => {
  const engine = createRealEngine();
  const rng = createRng({ s: 3 });
  const ctx = { rng, emit: () => {} };
  const st = running(engine);
  const started = (await engine.startEncounter(st, ctx)).state;
  let s = engine.applyDmCommand(started, { type: 'dm.entity.patch', payload: { entityId: 'gob', hp: 99, addConditions: ['prone', 'prone'], hpTemp: 4 } }, ctx).state;
  assert.deepEqual([s.entities.gob.hp, s.entities.gob.conditions, s.entities.gob.hpTemp], [20, ['prone'], 4]);
  s = engine.applyDmCommand(s, { type: 'dm.entity.patch', payload: { entityId: 'gob', removeConditions: ['prone'] } }, ctx).state;
  assert.deepEqual(s.entities.gob.conditions, []);
  assert.throws(() => engine.applyDmCommand(s, { type: 'dm.entity.patch', payload: { entityId: 'gob', position: { col: 99, row: 0 } } }, ctx), { code: 'E_INVALID_INTENT' });
  assert.throws(() => engine.applyDmCommand(s, { type: 'dm.entity.patch', payload: { entityId: 'x', hp: 1 } }, ctx), { code: 'E_INVALID_INTENT' });
  const added = engine.applyDmCommand(s, { type: 'dm.entity.add', payload: { entity: { id: 'orc1', slug: 'orc' }, initiativeScore: 100 } }, ctx).state;
  assert.equal(added.initiative[0].entityId, 'orc1', 'slotted by score');
  assert.equal(added.initiative[added.turnIndex].entityId, s.initiative[s.turnIndex].entityId, 'the current actor keeps its turn');
  assert.ok(validateEncounterState(added).ok);
  const removed = engine.applyDmCommand(added, { type: 'dm.entity.remove', payload: { entityId: 'orc1' } }, ctx).state;
  assert.equal(removed.entities.orc1, undefined);
  assert.equal(removed.initiative.length, 2);
  assert.ok(validateEncounterState(removed).ok);
  const rolled = engine.applyDmCommand(removed, { type: 'dm.initiative.roll', payload: {} }, ctx).state;
  assert.equal(rolled.initiative.length, 2);
  assert.throws(() => engine.applyDmCommand(s, { type: 'dm.nope', payload: {} }, ctx), { code: 'E_INVALID_INTENT' });
  assert.deepEqual(started.entities.gob.conditions, [], 'inputs are never mutated');
});

test('createEngine selects the real engine by default, the stub with CF_ENGINE=stub', async () => {
  const { db } = await tempDb(root);
  try {
    const service = createRoomService({ db });
    assert.equal(createEngine({ kind: undefined, db, store: service.store }).version, REAL_ENGINE_VERSION);
    assert.equal(createEngine({ kind: 'real', db, store: service.store }).version, REAL_ENGINE_VERSION);
    assert.equal(createEngine({ kind: 'stub', db, store: service.store }).version, createStubEngine().version);
    assert.throws(() => createEngine({ kind: 'nope', db, store: service.store }), /CF_ENGINE/);
  } finally { db.close(); }
});
