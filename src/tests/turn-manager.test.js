/**
 * M64 T7 — the engine turn manager.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTurnState, turnStateFromEncounter, encounterFromTurnState, rollInitiative,
  startEncounter, currentActor, beginTurnResets, victoryCheck, runTurn, runRound,
  runEncounter, skipTurn, endEncounter, setPaused, initiativeIndexOf, OUTCOMES
} from '../js/scene/turn-manager.js';
import { createRng } from '../js/scene/rng.js';
import { validateEvent } from '../js/shared/events.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';
import { stateHash } from '../js/shared/state-hash.js';
import { buildPc, buildMonster, buildScene, parsedDdbFixture } from './helpers/entities.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/encounters/${n}.state.json`, import.meta.url), 'utf8'));
const sheets = () => ({ 'fighter-l5': parsedDdbFixture('fighter-l5'), 'wizard-l5': parsedDdbFixture('wizard-l5') });

function sink() {
  const events = [];
  let seq = 0;
  return {
    events,
    types: () => events.map(e => e.type),
    emit: (ev) => {
      const full = { seq: ++seq, type: ev.type, round: ev.round, turnId: ev.turnId, cinemaGroup: ev.cinemaGroup ?? null, payload: ev.payload };
      const v = validateEvent(full);
      assert.ok(v.ok, `${ev.type}: ${JSON.stringify(v.errors)}`);
      events.push(full);
    }
  };
}

function duel() {
  const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 } });
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  return createTurnState({ wrappers: [pc, gob], sides: { pc: 'party', gob: 'hostile' }, scene: buildScene() });
}

test('turn-manager: initiative rolls d20 + DEX, highest first, deterministic', () => {
  const a = rollInitiative(duel(), createRng({ s: 4 }));
  const b = rollInitiative(duel(), createRng({ s: 4 }));
  assert.deepEqual(a, b);
  assert.equal(a.length, 2);
  assert.ok(a[0].score >= a[1].score);
  const ts = startEncounter(duel(), { initiative: 'given' });
  assert.deepEqual(ts.initiative.map(r => r.entityId), ['pc', 'gob'], 'given = roster order');
  assert.equal(ts.round, 1);
  assert.equal(currentActor(ts).id, 'pc');
  assert.equal(initiativeIndexOf(ts, 'gob'), 1);
  assert.throws(() => createTurnState({ wrappers: [buildPc()], sides: {}, scene: {} }), /no side/);
});

test('turn-manager: per-creature resets at the start of its own turn', () => {
  const pc = buildPc({ _reactionUsed: true, _shieldActive: true, _recklessUntilNextTurn: true, _sneakAttackUsedThisTurn: true });
  beginTurnResets(pc);
  assert.equal(pc._reactionUsed, false);
  assert.equal(pc._shieldActive, false);
  assert.equal(pc._recklessUntilNextTurn, false);
  assert.equal(pc._sneakAttackUsedThisTurn, false);
  const dragon = buildMonster({ presetSlug: 'young-dragon', _legendaryBudget: 0 });
  beginTurnResets(dragon);
  assert.equal(dragon._legendaryBudget, 3);
});

test('turn-manager: a turn emits turn.started … turn.ended and advances', async () => {
  const ts = startEncounter(duel(), { initiative: 'given' });
  // A sturdier goblin: the Fighter 5 makes two attacks (R10) and must not
  // end the encounter on its first turn.
  ts.entities.gob.hp = ts.entities.gob.hpMax = 40;
  const s = sink();
  const r = await runTurn(ts, { rng: createRng({ s: 2 }), emit: s.emit });
  assert.equal(r.actorId, 'pc');
  assert.equal(r.ran, true);
  assert.equal(s.types()[0], 'turn.started');
  assert.ok(s.types().includes('turn.ended'));
  assert.ok(s.events.every(e => e.turnId === 'r1t0' && e.round === 1));
  assert.equal(ts.turnIndex, 1);
});

test('turn-manager: downed and incapacitated creatures are skipped', async () => {
  const ts = startEncounter(duel(), { initiative: 'given' });
  ts.entities.pc.conditions.push('paralyzed');
  const s = sink();
  const r = await runTurn(ts, { rng: createRng({ s: 2 }), emit: s.emit });
  assert.equal(r.skipped, 'incapacitated');
  assert.deepEqual(s.types(), ['turn.skipped']);
  ts.entities.gob.hp = 0;
  ts.entities.pc.conditions = [];
  const ts2 = startEncounter(duel(), { initiative: 'given' });
  ts2.entities.pc.hp = 0;
  const r2 = await runTurn(ts2, { rng: createRng({ s: 2 }) });
  assert.equal(r2.skipped, 'down');
  assert.equal(r2.ended, true);
  assert.equal(r2.outcome, 'hostile-victory');
});

test('turn-manager: victory check, encounter.ended and the round cap', async () => {
  const ts = startEncounter(duel(), { initiative: 'given' });
  assert.equal(victoryCheck(ts), null);
  ts.entities.gob.hp = 0;
  assert.equal(victoryCheck(ts), 'party-victory');
  ts.entities.pc.conditions = ['stunned'];
  assert.equal(victoryCheck(ts, 'hp'), 'party-victory');
  assert.equal(victoryCheck(ts, 'standing'), 'draw');
  const capped = startEncounter(duel(), { initiative: 'given', maxRounds: 1 });
  capped.entities.pc.hp = 999; capped.entities.gob.hp = 999; capped.entities.gob.hpMax = 999;
  const s = sink();
  const outcome = await runEncounter(capped, { rng: createRng({ s: 1 }), emit: s.emit });
  assert.equal(outcome, 'draw');
  assert.equal(capped.round, 1);
  assert.equal(s.events.at(-1).type, 'encounter.ended');
  assert.ok(OUTCOMES.includes(outcome));
});

test('turn-manager: legendary actions fire after an opposing turn', async () => {
  const ts = turnStateFromEncounter(fixture('legendary-actions'), sheets());
  startEncounter(ts, { initiative: 'given' });
  assert.equal(currentActor(ts).id, 'pc-fighter');
  const s = sink();
  await runTurn(ts, { rng: createRng({ s: 11 }), emit: s.emit });
  assert.ok(s.events.some(e => e.type === 'feature.used' && e.payload.featureId.startsWith('legendary:')), 'dragon spent a legendary action');
  assert.ok(ts.entities['m-dragon']._legendaryBudget < 3);
  const ended = s.events.find(e => e.type === 'turn.ended');
  assert.equal(ended.payload.stateHash, stateHash(encounterFromTurnState(ts)), 'turn.ended carries THE state hash');
});

test('turn-manager: EncounterState round-trip, skipTurn, pause and endEncounter', async () => {
  const state = fixture('shield-reaction');
  const ts = turnStateFromEncounter(state, sheets());
  startEncounter(ts, { rng: createRng({ s: 3 }) });
  const rng = createRng({ s: 3 });
  await runTurn(ts, { rng });
  const next = encounterFromTurnState(ts, rng);
  assert.ok(validateEncounterState(next).ok, JSON.stringify(validateEncounterState(next).errors));
  assert.equal(next.round, ts.round);
  assert.deepEqual(next.rng, rng.state());
  assert.equal(state.round, 0, 'base state untouched');

  const before = ts.turnIndex;
  const s = sink();
  skipTurn(ts, { emit: s.emit }, 'dm');
  assert.equal(s.events[0].type, 'turn.skipped');
  assert.equal(s.events[0].payload.reason, 'dm');
  assert.notEqual(ts.turnIndex, before);

  setPaused(ts, true);
  const p = await runTurn(ts, { rng });
  assert.equal(p.paused, true);
  setPaused(ts, false);
  const flag = { v: true };
  assert.equal((await runTurn(ts, { rng, isPaused: () => flag.v })).paused, true);

  endEncounter(ts, { emit: s.emit });
  assert.equal(ts.phase, 'ended');
  assert.equal(s.events.at(-1).payload.outcome, 'dm-ended');
  assert.equal((await runTurn(ts, { rng })).ended, true);
});

test('turn-manager: runRound stops at the round boundary', async () => {
  const ts = startEncounter(duel(), { initiative: 'given' });
  ts.entities.gob.hp = 500; ts.entities.gob.hpMax = 500;
  const results = await runRound(ts, { rng: createRng({ s: 5 }) });
  assert.equal(results.length, 2);
  assert.equal(results.at(-1).roundEnded, true);
  assert.equal(ts.round, 2);
  await assert.rejects(runTurn(createTurnState({ wrappers: [], sides: {}, scene: {} }), {}), /startEncounter/);
});
