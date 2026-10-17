/**
 * M64 R9 — dying: downed PCs, death saves, stable / dead, revival by any
 * healing, massive damage, monsters dying at 0, and the contract fields
 * (`status`, `deathSaves`, death.* events).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDamage, applyHealing, setHpRaw, rollDeathSave, isDying, isDead, isAlive, runOneAttack
} from '../js/scene/combat-engine.js';
import { createTurnState, startEncounter, runTurn, victoryCheck } from '../js/scene/turn-manager.js';
import { wrapperFromEntity, applyWrapperToEntity, setEntityHp, entityFromSheet } from '../js/scene/encounter-adapters.js';
import { validateEncounterState, emptyEncounterState, ENTITY_STATUSES } from '../js/shared/encounter-state.js';
import { stateHash, stateHashInput } from '../js/shared/state-hash.js';
import { validateEvent } from '../js/shared/events.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene, parsedDdbFixture } from './helpers/entities.js';

function sink() {
  const events = [];
  let seq = 0;
  return {
    events,
    types: () => events.map(e => e.type),
    ctx: { emit: (ev) => events.push({ seq: ++seq, round: 1, turnId: 't', ...ev }), turnId: 't' }
  };
}

/** rng that returns the given d20 faces in order (1 + floor(r * 20)). */
function d20s(...faces) {
  const q = faces.map(f => (f - 1) / 20 + 0.001);
  return () => (q.length ? q.shift() : 0.5);
}

const pc = (o = {}) => buildPc({ status: 'active', deathSaves: { successes: 0, failures: 0, stable: false }, ...o });

test('R9: a PC dropped to 0 HP is downed and unconscious, not removed', () => {
  const p = pc({ hp: 5, hpMax: 30 });
  const s = sink();
  const r = applyDamage(p, 8, 'Slashing', { attacker: buildMonster(), ctx: s.ctx });
  assert.equal(r.downed, true);
  assert.equal(p.hp, 0);
  assert.equal(p.status, 'downed');
  assert.ok(p.conditions.includes('unconscious'));
  assert.deepEqual(p.deathSaves, { successes: 0, failures: 0, stable: false });
  assert.equal(isDying(p), true);
  assert.equal(isAlive(p), false);
  assert.deepEqual(s.types(), ['damage', 'entity.downed', 'condition.applied']);
  for (const e of s.events) assert.ok(validateEvent(e).ok, e.type);
});

test('R9: massive damage (overflow >= hpMax) kills outright; damage >= hpMax at 0 HP too', () => {
  const p = pc({ hp: 5, hpMax: 10 });
  const s = sink();
  applyDamage(p, 15, null, { ctx: s.ctx });
  assert.equal(p.status, 'dead');
  assert.deepEqual(s.types(), ['damage', 'entity.downed', 'entity.died']);
  assert.equal(s.events[2].payload.cause, 'massive');
  const q = pc({ hp: 0, hpMax: 10, status: 'downed', conditions: ['unconscious'] });
  const s2 = sink();
  applyDamage(q, 10, null, { ctx: s2.ctx });
  assert.equal(q.status, 'dead');
  assert.deepEqual(s2.types(), ['damage', 'death.save', 'entity.died']);
  // The dead take no more damage and no healing.
  const s3 = sink();
  applyDamage(q, 5, null, { ctx: s3.ctx });
  assert.equal(applyHealing(q, 10, { ctx: s3.ctx }).amount, 0);
  assert.deepEqual(s3.types(), []);
  assert.equal(isDead(q), true);
});

test('R9: damage while downed is one failure (two on a crit); three failures = dead', () => {
  const p = pc({ hp: 0, hpMax: 30, status: 'downed', conditions: ['unconscious'] });
  const s = sink();
  applyDamage(p, 3, 'Slashing', { ctx: s.ctx });
  assert.equal(p.deathSaves.failures, 1);
  assert.equal(p.hp, 0);
  const ds = s.events.find(e => e.type === 'death.save');
  assert.deepEqual(ds.payload, { entityId: 'pc1', d20: null, success: false, crit: false, successes: 0, failures: 1, cause: 'damage' });
  assert.equal(s.events[0].payload.amount, 0);
  applyDamage(p, 3, 'Slashing', { ctx: s.ctx, crit: true });
  assert.equal(p.deathSaves.failures, 3);
  assert.equal(p.status, 'dead');
  assert.equal(s.events.at(-1).type, 'entity.died');
  assert.equal(s.events.at(-1).payload.cause, 'failures');
});

test('R9: a melee hit within 5 ft on a downed PC auto-crits: two failures', async () => {
  const p = pc({ id: 'pc', hp: 0, hpMax: 30, status: 'downed', conditions: ['unconscious'], _position: { col: 1, row: 1 } });
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  const s = sink();
  await runOneAttack(gob, [p], [gob], buildScene(), createRng({ s: 4 }), { forcePlan: { kind: 'attack', targetId: 'pc' } }, s.ctx);
  const roll = s.events.find(e => e.type === 'attack.rolled');
  assert.equal(roll.payload.crit, true);
  assert.equal(p.deathSaves.failures, 2);
  assert.equal(p.status, 'downed');
});

test('R9: death saves at the start of the turn — success, nat 1, stable after three successes', () => {
  const p = pc({ hp: 0, hpMax: 30, status: 'downed', conditions: ['unconscious'] });
  const s = sink();
  rollDeathSave(p, d20s(10), s.ctx);
  assert.deepEqual(p.deathSaves, { successes: 1, failures: 0, stable: false });
  rollDeathSave(p, d20s(1), s.ctx);
  assert.deepEqual(p.deathSaves, { successes: 1, failures: 2, stable: false });
  assert.equal(s.events[1].payload.crit, true, 'a natural 1');
  rollDeathSave(p, d20s(15), s.ctx);
  rollDeathSave(p, d20s(12), s.ctx);
  assert.equal(p.status, 'stable');
  assert.deepEqual(p.deathSaves, { successes: 3, failures: 2, stable: true });
  assert.deepEqual(s.types(), ['death.save', 'death.save', 'death.save', 'death.save', 'entity.stabilized']);
  for (const e of s.events) assert.ok(validateEvent(e).ok, e.type);
  // Stable: no more saves.
  assert.equal(rollDeathSave(p, d20s(5), s.ctx).rolled, false);
  // A hit on a stable PC sets it dying again: successes reset, a failure added.
  const q = pc({ hp: 0, hpMax: 30, status: 'stable', conditions: ['unconscious'], deathSaves: { successes: 3, failures: 0, stable: true } });
  applyDamage(q, 2, null, {});
  assert.equal(q.status, 'downed');
  assert.deepEqual(q.deathSaves, { successes: 0, failures: 1, stable: false });
});

test('R9: three failed saves kill; a natural 20 revives at 1 HP', () => {
  const p = pc({ hp: 0, hpMax: 30, status: 'downed', conditions: ['unconscious'] });
  for (const f of [5, 9, 2]) rollDeathSave(p, d20s(f));
  assert.equal(p.status, 'dead');
  const q = pc({ hp: 0, hpMax: 30, status: 'downed', conditions: ['unconscious'], deathSaves: { successes: 2, failures: 2, stable: false } });
  const s = sink();
  const r = rollDeathSave(q, d20s(20), s.ctx);
  assert.equal(r.revived, true);
  assert.equal(q.hp, 1);
  assert.equal(q.status, 'active');
  assert.ok(!q.conditions.includes('unconscious'));
  assert.deepEqual(q.deathSaves, { successes: 0, failures: 0, stable: false });
  assert.deepEqual(s.types(), ['death.save', 'heal', 'condition.removed', 'entity.revived']);
});

test('R9: any healing brings a dying PC back and resets the tallies', () => {
  const p = pc({ hp: 0, hpMax: 30, status: 'downed', conditions: ['unconscious'], deathSaves: { successes: 1, failures: 2, stable: false } });
  const s = sink();
  applyHealing(p, 4, { ctx: s.ctx, source: buildPc({ id: 'cleric' }) });
  assert.equal(p.hp, 4);
  assert.equal(p.status, 'active');
  assert.deepEqual(p.deathSaves, { successes: 0, failures: 0, stable: false });
  assert.deepEqual(s.types(), ['heal', 'condition.removed', 'entity.revived']);
  assert.deepEqual(s.events[2].payload, { entityId: 'pc1', hp: 4, byId: 'cleric' });
  // DM edits flip the status silently.
  setHpRaw(p, 0);
  assert.equal(p.status, 'downed');
  assert.ok(p.conditions.includes('unconscious'));
  setHpRaw(p, 9);
  assert.equal(p.status, 'active');
  assert.ok(!p.conditions.includes('unconscious'));
});

test('R9: monsters die at 0 HP', () => {
  const m = buildMonster({ status: 'active' });
  const s = sink();
  applyDamage(m, 50, null, { ctx: s.ctx, attacker: pc() });
  assert.equal(m.status, 'dead');
  assert.deepEqual(s.types(), ['damage', 'entity.downed', 'entity.died']);
  assert.equal(m.deathSaves, undefined, 'monsters make no death saves');
});

function duel({ pcHp = 30, gobHp = 7 } = {}) {
  const hero = pc({ id: 'pc', hp: pcHp, hpMax: 30, _position: { col: 1, row: 1 } });
  const ally = pc({ id: 'ally', hp: 30, hpMax: 30, _position: { col: 6, row: 5 } });
  const gob = buildMonster({ id: 'gob', hp: gobHp, hpMax: 50, position: { col: 2, row: 1 }, status: 'active' });
  return startEncounter(createTurnState({
    wrappers: [hero, ally, gob], sides: { pc: 'party', ally: 'party', gob: 'hostile' }, scene: buildScene()
  }), { initiative: 'given' });
}

test('R9: the turn manager rolls the save at turn start; a nat 20 takes the turn, otherwise it is skipped', async () => {
  const ts = duel();
  const hero = ts.entities.pc;
  setHpRaw(hero, 0);
  const s = sink();
  const r = await runTurn(ts, { rng: d20s(8), emit: s.ctx.emit });
  assert.equal(r.skipped, 'down');
  assert.deepEqual(s.types(), ['death.save', 'turn.skipped']);
  assert.equal(hero.deathSaves.failures, 1);
  // The party still stands (the ally) — no encounter end.
  assert.equal(victoryCheck(ts), null);
  // Next time round: a natural 20 revives and the PC acts.
  const ts2 = duel({ gobHp: 50 });
  setHpRaw(ts2.entities.pc, 0);
  const s2 = sink();
  const r2 = await runTurn(ts2, { rng: d20s(20, 15, 10, 10, 10, 10, 10, 10), emit: s2.ctx.emit });
  assert.equal(r2.ran, true);
  assert.equal(ts2.entities.pc.status, 'active');
  assert.deepEqual(s2.types().slice(0, 5), ['death.save', 'heal', 'condition.removed', 'entity.revived', 'turn.started']);
});

test('R9: a side with only downed / dead members loses', () => {
  const ts = duel();
  setHpRaw(ts.entities.pc, 0);
  setHpRaw(ts.entities.ally, 0);
  ts.entities.ally.status = 'dead';
  assert.equal(victoryCheck(ts), 'hostile-victory');
});

test('R9: AI monsters prefer live targets; a dead ally is no heal candidate', async () => {
  const downed = pc({ id: 'down', hp: 0, hpMax: 30, status: 'downed', conditions: ['unconscious'], _position: { col: 2, row: 2 } });
  const live = pc({ id: 'live', hp: 30, hpMax: 30, _position: { col: 4, row: 1 } });
  const gob = buildMonster({ id: 'gob', position: { col: 3, row: 2 } });
  const s = sink();
  await runOneAttack(gob, [downed, live], [gob], buildScene(), createRng({ s: 2 }), {}, s.ctx);
  const rolls = s.events.filter(e => e.type === 'attack.rolled');
  assert.ok(rolls.length >= 1);
  assert.ok(rolls.every(e => e.payload.targetId === 'live'));
  // A cleric AI never targets a dead ally with a heal.
  const cleric = buildPc({ id: 'cl', ref: parsedDdbFixture('cleric-l5'), _position: { col: 1, row: 1 }, _slots: { 1: 4, 2: 3, 3: 2 } });
  const dead = pc({ id: 'dead', hp: 0, hpMax: 30, status: 'dead', _position: { col: 1, row: 2 } });
  const foe = buildMonster({ id: 'foe', hp: 30, hpMax: 30, position: { col: 2, row: 1 } });
  const s2 = sink();
  await runOneAttack(cleric, [foe], [cleric, dead], buildScene(), createRng({ s: 2 }), {}, s2.ctx);
  assert.ok(!s2.events.some(e => e.type === 'heal' && e.payload.targetId === 'dead'));
  assert.equal(dead.hp, 0);
});

test('R9: adapters persist status / deathSaves only when not active; the hash ignores active entities', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const state = emptyEncounterState({ encounterId: 'e', cols: 6, rows: 6, seed: 1 });
  state.entities.f = entityFromSheet(sheet, { id: 'f', pos: { col: 1, row: 1 } });
  const before = stateHash(state);
  assert.equal(stateHashInput(state).entities.f.status, undefined);
  const w = wrapperFromEntity(state.entities.f, sheet);
  assert.equal(w.status, 'active');
  assert.deepEqual(w.deathSaves, { successes: 0, failures: 0, stable: false });
  // An untouched active wrapper writes nothing new.
  const same = applyWrapperToEntity(state.entities.f, w);
  assert.equal(same.status, undefined);
  assert.equal(same.deathSaves, undefined);
  assert.equal(stateHash({ ...state, entities: { f: same } }), before);
  // Downed: stored, validated, hashed.
  applyDamage(w, w.hp, null, {});
  assert.equal(w.status, 'downed');
  w.deathSaves.successes = 1;
  w.deathSaves.failures = 2;
  const down = applyWrapperToEntity(state.entities.f, w);
  assert.equal(down.status, 'downed');
  assert.deepEqual(down.deathSaves, { successes: 1, failures: 2, stable: false });
  const st = { ...state, entities: { f: down } };
  assert.deepEqual(validateEncounterState(st).errors, []);
  assert.notEqual(stateHash(st), before);
  assert.equal(stateHashInput(st).entities.f.status, 'downed');
  const back = wrapperFromEntity(down, sheet);
  assert.equal(back.status, 'downed');
  assert.deepEqual(back.deathSaves, { successes: 1, failures: 2, stable: false });
  // A bad status is rejected by the contract.
  assert.equal(validateEncounterState({ ...state, entities: { f: { ...down, status: 'dying' } } }).ok, false);
  assert.deepEqual([...ENTITY_STATUSES], ['active', 'downed', 'stable', 'dead']);
});

test('R9: setEntityHp (server DM edit) flips the status like setHpRaw', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const state = emptyEncounterState({ encounterId: 'e', cols: 6, rows: 6, seed: 1 });
  state.entities.f = entityFromSheet(sheet, { id: 'f', pos: { col: 1, row: 1 } });
  const zero = setEntityHp(state, 'f', 0).state;
  assert.equal(zero.entities.f.status, 'downed');
  assert.ok(zero.entities.f.conditions.includes('unconscious'));
  assert.deepEqual(validateEncounterState(zero).errors, []);
  const up = setEntityHp(zero, 'f', 12).state;
  assert.equal(up.entities.f.status, undefined);
  assert.equal(up.entities.f.deathSaves, undefined);
  assert.ok(!up.entities.f.conditions.includes('unconscious'));
});
