/**
 * M64 R7 — condition lifecycle: {id, sourceId, endsOn, save, appliedRound};
 * end-of-turn repeat saves; concentration conditions end with the
 * concentration; incapacitated creatures skip their turn in every path;
 * charmed blocks attacking the charmer only; speed 0 when grappled or
 * restrained.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONDITION_ENDS_ON, normalizeCondition, hasLifecycle, conditionIds, hasCondition, conditionMeta,
  charmerIds, addConditionTo, removeConditionFrom, wrapperConditions, isIncapacitatedBy
} from '../js/scene/conditions.js';
import {
  runOneAttack, applyCondition, removeCondition, applyDamage, sweepConcentrationConditions,
  startOfTurnConditions, endOfTurnConditions, runMonsterSpell
} from '../js/scene/combat-engine.js';
import { createTurnState, startEncounter, runTurn, queueDmCommand, applyDmCommands } from '../js/scene/turn-manager.js';
import { simulateEncounter } from '../js/scene/simulator.js';
import { wrapperFromEntity, applyWrapperToEntity } from '../js/scene/encounter-adapters.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene, monsterFromPreset } from './helpers/entities.js';

function sink() {
  const events = [];
  return { events, ctx: { emit: (e) => events.push(e) } };
}

/** Hold Person from `caster` on `target` (concentrating), save DC `dc`. */
function holdPerson(caster, target, dc) {
  caster._concentrating = { spellId: 'hold-person', spellName: 'Hold Person', targetIds: [target.id] };
  addConditionTo(target, { id: 'paralyzed', sourceId: caster.id, endsOn: 'concentration', save: { stat: 'WIS', dc }, appliedRound: 1 });
}

/** A TurnState whose current turn is `actorId`. */
function turnState(party, monsters, actorId, scene = buildScene()) {
  const ts = createTurnState({
    wrappers: [...party, ...monsters],
    sides: w => (w.kind === 'pc' ? 'party' : 'hostile'),
    scene,
    initiative: [...party, ...monsters].map((w, i) => ({ entityId: String(w.id), score: 20 - i }))
  });
  startEncounter(ts, { initiative: 'given' });
  ts.turnIndex = ts.initiative.findIndex(r => r.entityId === String(actorId));
  return ts;
}

// ---------- data helpers ----------

test('R7: strings normalise to the lifecycle shape; lifecycle detection', () => {
  assert.deepEqual(CONDITION_ENDS_ON, ['turn-end', 'turn-start', 'source-turn-end', 'concentration', 'encounter']);
  assert.deepEqual(normalizeCondition('poisoned'), { id: 'poisoned', sourceId: null, endsOn: 'encounter', save: null, appliedRound: null });
  assert.deepEqual(normalizeCondition({ id: 'paralyzed', sourceId: 7, endsOn: 'concentration', save: { stat: 'WIS', dc: '13' }, appliedRound: 2 }),
    { id: 'paralyzed', sourceId: '7', endsOn: 'concentration', save: { stat: 'WIS', dc: 13 }, appliedRound: 2 });
  assert.equal(normalizeCondition({ id: 'x', endsOn: 'bogus' }).endsOn, 'encounter');
  assert.equal(normalizeCondition(null), null);
  assert.equal(hasLifecycle(normalizeCondition('prone')), false);
  assert.equal(hasLifecycle(normalizeCondition({ id: 'prone', endsOn: 'turn-start' })), true);
});

test('R7: wrapper helpers keep string ids and carry the lifecycle in _conditionMeta', () => {
  const w = buildPc({ conditions: ['prone'] });
  assert.deepEqual(addConditionTo(w, { id: 'charmed', sourceId: 'm1', endsOn: 'turn-end' }).added, true);
  assert.deepEqual(w.conditions, ['prone', 'charmed']);
  assert.deepEqual(conditionIds(w), ['prone', 'charmed']);
  assert.equal(hasCondition(w, 'charmed'), true);
  assert.deepEqual(charmerIds(w), ['m1']);
  assert.equal(conditionMeta(w, 'prone').endsOn, 'encounter');
  assert.equal(conditionMeta(w, 'nope'), null);
  assert.equal(addConditionTo(w, 'prone').added, false);
  assert.equal(removeConditionFrom(w, 'charmed').sourceId, 'm1');
  assert.deepEqual(w.conditions, ['prone']);
  assert.deepEqual(w._conditionMeta, {});
  assert.equal(isIncapacitatedBy({ conditions: [{ id: 'stunned' }] }), true);
  assert.equal(isIncapacitatedBy({ conditions: ['incapacitated'] }), true);
  const split = wrapperConditions(['prone', { id: 'paralyzed', endsOn: 'concentration', sourceId: 'c' }, 'prone', 'charmed'], { charmed: { id: 'charmed', sourceId: 'v', endsOn: 'turn-end' } });
  assert.deepEqual(split.conditions, ['prone', 'paralyzed', 'charmed']);
  assert.deepEqual(Object.keys(split.meta), ['paralyzed', 'charmed']);
});

test('R7: applyCondition / removeCondition emit the lifecycle events', () => {
  const w = buildMonster({ id: 'm' });
  const { events, ctx } = sink();
  assert.equal(applyCondition(w, { id: 'restrained', sourceId: 'pc', endsOn: 'source-turn-end' }, { ctx }), true);
  assert.equal(applyCondition(w, 'restrained', { ctx }), false);
  removeCondition(w, 'restrained', { ctx, reason: 'dm' });
  assert.deepEqual(events.map(e => e.type), ['condition.applied', 'condition.removed']);
  assert.equal(events[0].payload.endsOn, 'source-turn-end');
  assert.deepEqual(events[1].payload, { entityId: 'm', condition: 'restrained', sourceId: 'pc', reason: 'dm' });
});

test('R7: an incapacitating condition ends the bearer\'s concentration and frees its targets', () => {
  const caster = buildMonster({ id: 'c' });
  const victim = buildPc({ id: 'v' });
  holdPerson(caster, victim, 15);
  const { events, ctx } = sink();
  applyCondition(caster, 'stunned', { ctx, roster: [caster, victim] });
  assert.equal(caster._concentrating, null);
  assert.equal(hasCondition(victim, 'paralyzed'), false);
  assert.deepEqual(events.map(e => e.type), ['condition.applied', 'concentration.broken', 'condition.removed']);
  assert.equal(events[1].payload.reason, 'incapacitated');
  assert.deepEqual(events[1].payload.targetIds, ['v']);
});

// ---------- Hold Person ----------

test('R7: a Hold Person target repeats the WIS save at the end of its turn and is freed on a success', async () => {
  const caster = monsterFromPreset('cult-fanatic', { id: 'fan', position: { col: 5, row: 1 } });
  const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 } });
  holdPerson(caster, pc, 1);   // DC 1: any roll saves
  const ts = turnState([pc], [caster], 'pc');
  const { events, ctx } = sink();
  const r = await runTurn(ts, { rng: createRng({ s: 4 }), emit: ctx.emit });
  assert.equal(r.skipped, 'incapacitated', 'the paralyzed PC takes no action');
  const types = events.map(e => e.type);
  assert.deepEqual(types.slice(0, 4), ['turn.skipped', 'save.rolled', 'condition.removed', 'concentration.broken']);
  assert.equal(events[1].payload.reason, 'condition');
  assert.equal(events[1].payload.stat, 'WIS');
  assert.equal(events[2].payload.reason, 'save');
  assert.equal(events[3].payload.reason, 'ended', 'Hold Person on its only target ends');
  assert.equal(hasCondition(pc, 'paralyzed'), false);
  assert.equal(caster._concentrating, null);
});

test('R7: a failed repeat save keeps the paralysis', async () => {
  const caster = monsterFromPreset('cult-fanatic', { id: 'fan', position: { col: 5, row: 1 } });
  const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 } });
  holdPerson(caster, pc, 99);
  const ts = turnState([pc], [caster], 'pc');
  await runTurn(ts, { rng: createRng({ s: 4 }) });
  assert.equal(hasCondition(pc, 'paralyzed'), true);
  assert.ok(caster._concentrating);
});

test('R7: killing the caster clears the paralysis', async () => {
  const caster = buildMonster({ id: 'fan', hp: 1, hpMax: 33, ac: 1, position: { col: 2, row: 1 } });
  const held = buildPc({ id: 'held', _position: { col: 4, row: 4 } });
  const fighter = buildPc({ id: 'fighter', _position: { col: 1, row: 1 } });
  holdPerson(caster, held, 99);
  const { events, ctx } = sink();
  await runOneAttack(fighter, [caster], [fighter, held], buildScene(), createRng({ s: 2 }), {
    forcePlan: { kind: 'melee', targetId: 'fan', targetSide: 'enemy', weapon: { name: 'Longsword' }, featuresFired: [] }
  }, ctx);
  assert.equal(caster.hp, 0);
  assert.equal(hasCondition(held, 'paralyzed'), false);
  const broken = events.find(e => e.type === 'concentration.broken');
  assert.equal(broken.payload.reason, 'downed');
  const removed = events.find(e => e.type === 'condition.removed');
  assert.deepEqual(removed.payload, { entityId: 'held', condition: 'paralyzed', sourceId: 'fan', reason: 'concentration' });
});

test('R7: concentration broken by a failed CON save also frees the target', () => {
  const caster = buildMonster({ id: 'fan', hp: 50, hpMax: 50, saves: { CON: -20 } });
  const held = buildPc({ id: 'held' });
  holdPerson(caster, held, 99);
  applyDamage(caster, 30, null, { rng: createRng({ s: 1 }), roster: [caster, held] });
  assert.equal(caster._concentrating, null);
  assert.equal(hasCondition(held, 'paralyzed'), false);
});

test('R7: the sweep clears conditions whose source no longer concentrates (no roster at drop time)', () => {
  const caster = buildMonster({ id: 'fan', hp: 3 });
  const held = buildPc({ id: 'held' });
  holdPerson(caster, held, 99);
  applyDamage(caster, 10, null, { rng: createRng({ s: 1 }) });   // downed, no roster
  assert.equal(hasCondition(held, 'paralyzed'), true, 'not cleared without the roster');
  const { events, ctx } = sink();
  assert.equal(sweepConcentrationConditions([caster, held], ctx), 1);
  assert.equal(hasCondition(held, 'paralyzed'), false);
  assert.equal(events[0].payload.reason, 'concentration');
});

test('R7: the turn manager sweeps after every turn (legendary path)', async () => {
  const caster = buildMonster({ id: 'fan', hp: 3, position: { col: 8, row: 5 } });
  const held = buildPc({ id: 'held', _position: { col: 1, row: 1 } });
  const other = buildPc({ id: 'other', _position: { col: 1, row: 3 } });
  holdPerson(caster, held, 99);
  caster._concentrating = null;   // dropped somewhere the roster was not visible
  const ts = turnState([other, held], [caster], 'other');
  await runTurn(ts, { rng: createRng({ s: 3 }) });
  assert.equal(hasCondition(held, 'paralyzed'), false);
});

test('R7: the engine applies Hold Person with its registry lifecycle (save at the caster DC)', async () => {
  const fan = monsterFromPreset('cult-fanatic', { id: 'fan', position: { col: 2, row: 1 } });
  const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 }, ref: { ...buildPc().ref, abilityModifiers: { STR: 0, DEX: 0, CON: 0, INT: 0, WIS: -10, CHA: 0 } } });
  await runMonsterSpell({
    attacker: fan, target: pc, plan: { kind: 'cast', spellId: 'hold-person', castAtLevel: 2, targetId: 'pc' },
    scene: buildScene(), rng: createRng({ s: 1 }), allEnemies: [pc], allies: [fan], ctx: { round: 3 }
  });
  const meta = conditionMeta(pc, 'paralyzed');
  assert.equal(meta.endsOn, 'concentration');
  assert.equal(meta.sourceId, 'fan');
  assert.equal(meta.save.stat, 'WIS');
  assert.ok(meta.save.dc > 0);
  assert.equal(meta.appliedRound, 3);
});

// ---------- incapacitated skip ----------

test('R7: a paralyzed monster does not move — turn manager', async () => {
  const m = buildMonster({ id: 'm', position: { col: 8, row: 1 }, conditions: ['paralyzed'] });
  const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 } });
  const ts = turnState([pc], [m], 'm');
  const { events, ctx } = sink();
  const r = await runTurn(ts, { rng: createRng({ s: 1 }), emit: ctx.emit });
  assert.equal(r.skipped, 'incapacitated');
  assert.deepEqual(m.position, { col: 8, row: 1 });
  assert.ok(!events.some(e => e.type === 'move'));
});

test('R7: a paralyzed monster does not move — simulator', async () => {
  const party = [{ id: 'pc', name: 'pc', _position: { col: 0, row: 0 }, hp: { current: 30, max: 30 }, equipment: { mainhand: { name: 'Longbow' } }, abilityModifiers: { STR: 0, DEX: 3, CON: 1, INT: 0, WIS: 0, CHA: 0 }, classes: [{ name: 'Fighter', level: 3 }], conditions: [] }];
  const monsters = [{ id: 'm', name: 'goblin', presetSlug: 'goblin', hp: { current: 50, max: 50 }, position: { col: 9, row: 6 }, conditions: ['paralyzed'] }];
  const ends = [];
  await simulateEncounter({ party, monsters, scene: { cols: 10, rows: 7 }, iterations: 3, maxRounds: 3, seed: 5, onIterationEnd: ({ mons }) => ends.push({ ...mons[0].position }) });
  assert.deepEqual(ends, [{ col: 9, row: 6 }, { col: 9, row: 6 }, { col: 9, row: 6 }]);
});

test('R7: a paralyzed creature called directly (manual play) skips without moving', async () => {
  const m = buildMonster({ id: 'm', position: { col: 8, row: 1 }, conditions: ['stunned'] });
  const pc = buildPc({ id: 'pc' });
  const { events, ctx } = sink();
  await runOneAttack(m, [pc], [m], buildScene(), createRng({ s: 1 }), {}, ctx);
  assert.deepEqual(m.position, { col: 8, row: 1 });
  assert.deepEqual(events.map(e => [e.type, e.payload.reason]), [['turn.skipped', 'incapacitated']]);
});

// ---------- charmed ----------

test('R7: a charmed PC can attack a non-charmer but not the charmer', async () => {
  const run = async (targetId) => {
    const spawn = buildMonster({ id: 'spawn', hp: 50, hpMax: 50, position: { col: 2, row: 1 } });
    const goblin = buildMonster({ id: 'gob', hp: 50, hpMax: 50, position: { col: 2, row: 2 } });
    const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 } });
    addConditionTo(pc, { id: 'charmed', sourceId: 'spawn', endsOn: 'turn-end' });
    const { events, ctx } = sink();
    await runOneAttack(pc, [spawn, goblin], [pc], buildScene(), createRng({ s: 6 }), {
      forcePlan: { kind: 'melee', targetId, targetSide: 'enemy', weapon: { name: 'Longsword' }, featuresFired: [] }
    }, ctx);
    return events;
  };
  const ok = await run('gob');
  assert.ok(ok.some(e => e.type === 'attack.rolled' && e.payload.targetId === 'gob'), 'attacks the goblin');
  const no = await run('spawn');
  const rej = no.find(e => e.type === 'turn.rejected');
  assert.equal(rej.payload.code, 'charmed');
  assert.ok(!no.some(e => e.type === 'attack.rolled'));
});

test('R7: a charmed AI never picks its charmer', async () => {
  const spawn = buildMonster({ id: 'spawn', hp: 1, hpMax: 50, position: { col: 2, row: 1 } });
  const goblin = buildMonster({ id: 'gob', hp: 50, hpMax: 50, position: { col: 2, row: 2 } });
  const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 } });
  addConditionTo(pc, { id: 'charmed', sourceId: 'spawn', endsOn: 'turn-end' });
  const { events, ctx } = sink();
  await runOneAttack(pc, [spawn, goblin], [pc], buildScene(), createRng({ s: 6 }), {}, ctx);
  const chosen = events.find(e => e.type === 'plan.chosen');
  assert.equal(chosen.payload.targetId, 'gob');
  assert.equal(spawn.hp, 1);
});

// ---------- speed / timed endings ----------

test('R7: grappled or restrained creatures do not move', async () => {
  for (const c of ['grappled', 'restrained']) {
    const pc = buildPc({ id: 'pc', _position: { col: 0, row: 1 }, conditions: [c] });
    const m = buildMonster({ id: 'm', position: { col: 6, row: 1 } });
    const { events, ctx } = sink();
    await runOneAttack(pc, [m], [pc], buildScene(), createRng({ s: 1 }), {
      forcePlan: { kind: 'melee', targetId: 'm', targetSide: 'enemy', featuresFired: [] }
    }, ctx);
    assert.deepEqual(pc._position, { col: 0, row: 1 }, c);
    assert.ok(!events.some(e => e.type === 'move'), c);
  }
});

test('R7: turn-start, turn-end and source-turn-end conditions end on time', () => {
  const a = buildPc({ id: 'a' });
  const b = buildMonster({ id: 'b' });
  addConditionTo(a, { id: 'prone', endsOn: 'turn-start' });
  addConditionTo(a, { id: 'charmed', sourceId: 'b', endsOn: 'turn-end' });
  addConditionTo(a, { id: 'frightened', sourceId: 'b', endsOn: 'source-turn-end' });
  const { events, ctx } = sink();
  startOfTurnConditions(a, ctx);
  assert.deepEqual(a.conditions, ['charmed', 'frightened']);
  endOfTurnConditions(a, [a, b], createRng({ s: 1 }), ctx);
  assert.deepEqual(a.conditions, ['frightened'], 'turn-end gone; the source has not ended its turn');
  endOfTurnConditions(b, [a, b], createRng({ s: 1 }), ctx);
  assert.deepEqual(a.conditions, []);
  assert.deepEqual(events.map(e => e.payload.reason), ['turn-start', 'turn-end', 'source-turn-end']);
});

// ---------- persistence ----------

test('R7: the adapters persist the lifecycle as condition objects and read it back', () => {
  const entity = wrapperFromEntityFixture();
  const w = wrapperFromEntity(entity, null);
  assert.deepEqual(w.conditions, ['prone', 'paralyzed']);
  assert.equal(w._conditionMeta.paralyzed.endsOn, 'concentration');
  addConditionTo(w, { id: 'charmed', sourceId: 'v', endsOn: 'turn-end', appliedRound: 4 });
  removeConditionFrom(w, 'prone');
  const back = applyWrapperToEntity(entity, w);
  assert.deepEqual(back.conditions, [
    entity.conditions[1],
    { id: 'charmed', sourceId: 'v', endsOn: 'turn-end', save: null, appliedRound: 4 }
  ]);
});

function wrapperFromEntityFixture() {
  return {
    id: 'm', kind: 'monster', side: 'hostile', name: 'Goblin',
    controller: { type: 'ai', seatId: null }, pos: { col: 1, row: 1 },
    hp: 7, hpMax: 7, hpTemp: 0, ac: 12, speedFt: 30,
    conditions: ['prone', { id: 'paralyzed', sourceId: 'c', endsOn: 'concentration', save: { stat: 'WIS', dc: 13 } }],
    concentration: null,
    resources: { reactionUsed: false, slots: {}, pact: {}, innate: null, legendaryBudget: 0, features: {} },
    turnFlags: {}, statBlock: { slug: 'goblin' }
  };
}

test('R7: DM condition edits accept objects and keep an existing lifecycle for a string', () => {
  const m = buildMonster({ id: 'm' });
  addConditionTo(m, { id: 'paralyzed', sourceId: 'c', endsOn: 'concentration' });
  const ts = turnState([buildPc({ id: 'pc' })], [m], 'pc');
  queueDmCommand(ts, { kind: 'conditions', entityId: 'm', value: ['paralyzed', { id: 'charmed', sourceId: 'pc', endsOn: 'turn-end' }] });
  applyDmCommands(ts);
  assert.deepEqual(m.conditions, ['paralyzed', 'charmed']);
  assert.equal(conditionMeta(m, 'paralyzed').sourceId, 'c');
  assert.equal(conditionMeta(m, 'charmed').endsOn, 'turn-end');
});
