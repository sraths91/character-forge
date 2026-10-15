/**
 * M64 T8 — DM hooks: onPlanReady, onRoll (+ withD20), the checkpointed
 * HP / condition queue, initiative insert/remove; every override emits
 * dm.override.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOneAttack, runMonsterSpell } from '../js/scene/combat-engine.js';
import { withD20, withSaveD20, rollAttack } from '../js/scene/combat-roll.js';
import { setEntityHp, setEntityConditions } from '../js/scene/encounter-adapters.js';
import {
  createTurnState, startEncounter, runTurn, turnStateFromEncounter, encounterFromTurnState,
  queueDmCommand, applyDmCommands, insertInitiative, removeInitiative, currentActor
} from '../js/scene/turn-manager.js';
import { simulateEncounter } from '../js/scene/simulator.js';
import { createRng } from '../js/scene/rng.js';
import { validateEvent } from '../js/shared/events.js';
import { buildPc, buildMonster, buildScene, parsedDdbFixture } from './helpers/entities.js';

function collect() {
  const events = [];
  let seq = 0;
  const emit = (ev) => {
    const full = { seq: ++seq, type: ev.type, round: ev.round ?? 1, turnId: ev.turnId ?? 't', cinemaGroup: ev.cinemaGroup ?? null, payload: ev.payload };
    assert.ok(validateEvent(full).ok, JSON.stringify(validateEvent(full).errors));
    events.push(full);
  };
  return { events, emit, overrides: () => events.filter(e => e.type === 'dm.override').map(e => e.payload) };
}
const goblinTurn = () => ({ kind: 'attack', targetId: 'pc1', targetSide: 'enemy', featuresFired: [] });

test('T8: withD20 / withSaveD20 recompute hit, crit and success', () => {
  const atk = rollAttack({ bonus: 4, targetAC: 15 }, () => 0.3);   // d20 7 → 11, miss
  assert.equal(atk.hit, false);
  const nat20 = withD20(atk, 20);
  assert.deepEqual([nat20.hit, nat20.crit, nat20.total], [true, true, 24]);
  const one = withD20({ ...atk, bonus: 30 }, 1);
  assert.deepEqual([one.hit, one.crit], [false, false], 'a natural 1 always misses');
  assert.equal(withD20(atk, 11).hit, true, '11 + 4 = 15 vs AC 15');
  assert.notEqual(nat20, atk);
  const save = { kept: 3, dice: [3], bonus: 2, total: 5, dc: 13, success: false };
  assert.deepEqual([withSaveD20(save, 15).total, withSaveD20(save, 15).success], [17, true]);
});

test('T8: onPlanReady can replace the AI plan (dm.override kind plan)', async () => {
  const c = collect();
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  const a = buildPc({ id: 'pc1', _position: { col: 1, row: 1 } });
  const b = buildPc({ id: 'pc2', _position: { col: 3, row: 1 }, hp: 30 });
  await runOneAttack(gob, [a, b], [gob], buildScene(), createRng({ s: 1 }), {
    onPlanReady: async ({ plan }) => ({ ...plan, kind: 'attack', targetId: 'pc2', targetSide: 'enemy' })
  }, { emit: c.emit });
  const [ov] = c.overrides();
  assert.equal(ov.kind, 'plan');
  assert.equal(ov.after.targetId, 'pc2');
  assert.equal(gob._lastPlan.targetId, 'pc2');
  const chosen = c.events.find(e => e.type === 'plan.chosen').payload;
  assert.equal(chosen.source, 'dm');
  assert.equal(chosen.targetId, 'pc2');
});

test('T8: onPlanReady returning null skips the turn (plan.skip)', async () => {
  const c = collect();
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  const pc = buildPc({ id: 'pc1' });
  await runOneAttack(gob, [pc], [gob], buildScene(), createRng({ s: 1 }), { onPlanReady: () => null }, { emit: c.emit });
  assert.equal(pc.hp, 30);
  assert.equal(c.overrides()[0].kind, 'plan.skip');
  assert.equal(c.events.at(-1).type, 'turn.skipped');
  assert.equal(c.events.at(-1).payload.reason, 'dm');
});

test('T8: onRoll overrides attack, damage and save rolls after the draw', async () => {
  const c = collect();
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  const pc = buildPc({ id: 'pc1', ac: 30 });
  const draws = [];
  const rng = () => { draws.push(1); return 0.4; };
  await runOneAttack(gob, [pc], [gob], buildScene(), rng, {
    forcePlan: goblinTurn(),
    onRoll: async ({ kind, result }) => (kind === 'attack' ? withD20(result, 20) : kind === 'damage' ? { ...result, total: 13 } : result)
  }, { emit: c.emit });
  assert.deepEqual(c.overrides().map(o => o.kind), ['roll.attack', 'roll.damage']);
  assert.equal(pc.hp, 30 - 13);
  assert.equal(draws.length, 1 + 2, 'd20 + crit-doubled 1d6: the override never re-draws');
  // A single-target save.
  const c2 = collect();
  const fan = buildMonster({ id: 'fan', presetSlug: 'cult-fanatic', _slots: { 1: 4, 2: 3 } });
  const target = buildPc({ id: 'pc9', ref: { name: 'T', classes: [{ name: 'Fighter', level: 1 }], abilityModifiers: { WIS: 0 } } });
  await runMonsterSpell({
    attacker: fan, target, plan: { spellId: 'hold-person', castAtLevel: 2 }, rng: () => 0.99,
    prompts: { onRoll: async ({ kind, result }) => (kind === 'save' ? withSaveD20(result, 1) : result) }, ctx: { emit: c2.emit }
  });
  assert.ok(target.conditions.includes('paralyzed'), 'the forced failure lands');
  assert.equal(c2.overrides()[0].kind, 'roll.save');
  assert.equal(c2.overrides()[0].entityId, 'pc9');
});

test('T8: with no hooks (and with identity hooks) the outcome is byte-identical', async () => {
  const run = async (prompts) => {
    const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
    const pc = buildPc({ id: 'pc1' });
    await runOneAttack(gob, [pc], [gob], buildScene(), createRng({ s: 8 }), prompts);
    return JSON.stringify([gob, pc]);
  };
  assert.equal(await run({}), await run({ onRoll: async ({ result }) => result, onPlanReady: async ({ plan }) => plan }));
  const enc = () => ({
    party: [{ id: 'f', name: 'f', _position: { col: 1, row: 1 }, hp: { current: 30, max: 30 }, equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } }, abilityModifiers: { STR: 3, DEX: 1, CON: 2 }, classes: [{ name: 'Fighter', level: 5 }], conditions: [] }],
    monsters: [{ id: 'm', name: 'goblin', presetSlug: 'goblin', hp: { current: 20, max: 20 }, position: { col: 3, row: 3 }, conditions: [] }],
    scene: { cols: 8, rows: 6 }, iterations: 30, seed: 3
  });
  assert.deepEqual(await simulateEncounter(enc()), await simulateEncounter(enc()));
});

test('T8: setEntityHp / setEntityConditions are pure state edits', () => {
  const state = JSON.parse(readFileSync(new URL('./fixtures/encounters/shield-reaction.state.json', import.meta.url), 'utf8'));
  const r = setEntityHp(state, 'm-gob', 999);
  assert.equal(r.after, 7);
  assert.equal(r.before, 7);
  const z = setEntityHp(state, 'm-gob', -4);
  assert.equal(z.state.entities['m-gob'].hp, 0);
  assert.equal(state.entities['m-gob'].hp, 7, 'input untouched');
  const c = setEntityConditions(state, 'pc-wizard', ['prone', 'prone', { id: 'poisoned', sourceId: null }]);
  assert.deepEqual(c.after, ['prone', 'poisoned']);
  assert.deepEqual(c.before, []);
  assert.equal(setEntityHp(state, 'nobody', 1).entity, null);
});

function tsDuel() {
  const pc = buildPc({ id: 'pc1', _position: { col: 1, row: 1 } });
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  const ally = buildPc({ id: 'pc2', _position: { col: 5, row: 5 }, hp: 30 });
  return startEncounter(createTurnState({ wrappers: [gob, pc, ally], sides: { pc1: 'party', pc2: 'party', gob: 'hostile' }, scene: buildScene() }), { initiative: 'given' });
}

test('T8: a DM-zeroed target mid-prompt is not attacked', async () => {
  const ts = tsDuel();
  ts.entities.pc1.ref.spells = ['Shield'];
  ts.entities.pc1._slots = { 1: 1 };
  ts.entities.pc1.ac = 12;
  const c = collect();
  await runTurn(ts, {
    rng: () => 0.5, emit: c.emit,
    prompts: {
      forcePlan: goblinTurn(),
      onShieldReaction: async () => {
        // The control lane applies a queued DM edit while the engine waits.
        queueDmCommand(ts, { kind: 'hp', entityId: 'pc1', value: 0 });
        applyDmCommands(ts, { emit: c.emit });
        return false;
      }
    }
  });
  assert.equal(ts.entities.pc1.hp, 0);
  assert.equal(ts.entities.gob.damageDealt, 0, 'no damage after the edit');
  assert.ok(!c.events.some(e => e.type === 'damage'));
  assert.deepEqual(c.overrides()[0], { kind: 'hp', entityId: 'pc1', before: 30, after: 0 });
});

test('T8: an HP edit made while a plan is pending survives write-back', async () => {
  const state = JSON.parse(readFileSync(new URL('./fixtures/encounters/shield-reaction.state.json', import.meta.url), 'utf8'));
  const ts = turnStateFromEncounter(state, { 'wizard-l5': parsedDdbFixture('wizard-l5') });
  startEncounter(ts, { initiative: 'given' });
  ts.turnIndex = ts.initiative.findIndex(r => r.entityId === 'm-gob');
  await runTurn(ts, {
    rng: createRng({ s: 2 }),
    prompts: {
      onPlanReady: async ({ plan }) => {
        queueDmCommand(ts, { kind: 'hp', entityId: 'm-bugbear', value: 5 });
        applyDmCommands(ts);
        return plan;
      }
    }
  });
  const next = encounterFromTurnState(ts);
  assert.equal(next.entities['m-bugbear'].hp, 5);
});

test('T8: queued edits apply at the next safe point; conditions too', async () => {
  const ts = tsDuel();
  const c = collect();
  queueDmCommand(ts, { kind: 'conditions', entityId: 'gob', value: ['prone', 'prone'] });
  assert.deepEqual(ts.entities.gob.conditions, [], 'not applied yet');
  await runTurn(ts, { rng: createRng({ s: 1 }), emit: c.emit });
  assert.ok(c.events[0].type === 'dm.override' && c.events[0].payload.kind === 'conditions');
  assert.deepEqual(c.events[0].payload.after, ['prone']);
  assert.throws(() => queueDmCommand(ts, { kind: 'ac', entityId: 'gob', value: 1 }), /hp or conditions/);
});

test('T8: insertInitiative / removeInitiative keep the current actor', () => {
  const ts = tsDuel();
  ts.turnIndex = 1;                                   // pc1's turn
  const c = collect();
  const idx = insertInitiative(ts, { wrapper: buildMonster({ id: 'orc' }), side: 'hostile', score: 99 }, { emit: c.emit });
  assert.equal(idx, 0);
  assert.equal(currentActor(ts).id, 'pc1', 'still pc1\'s turn');
  assert.equal(c.overrides()[0].kind, 'initiative.insert');
  assert.ok(removeInitiative(ts, 'gob', { emit: c.emit }));
  assert.equal(currentActor(ts).id, 'pc1');
  assert.ok(!ts.entities.gob);
  assert.equal(c.overrides()[1].kind, 'initiative.remove');
  assert.equal(removeInitiative(ts, 'nope'), false);
  assert.throws(() => insertInitiative(ts, { wrapper: buildPc({ id: 'pc1' }), side: 'party' }), /already/);
});
