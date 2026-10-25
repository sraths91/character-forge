/**
 * M65 T21 — the run-state seam: `entityFromSheet(sheet, {runState})` seeds
 * an encounter entity from state_json v1 and `runStateFromEntity(entity,
 * prev)` writes the result back (spent, not remaining; untouched keys
 * preserved).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entityFromSheet, entityFromPreset, runStateFromEntity, wrapperFromEntity, applyEngineSides,
  featureKeyForRunResource, runResourceKeyForFeature, exhaustionEffects, itemSpendFromEntity,
  endsWithEncounter
} from '../js/scene/encounter-adapters.js';
import { emptyEncounterState, validateEncounterState } from '../js/shared/encounter-state.js';
import { initialRunState, validateRunState } from '../js/shared/run-state.js';
import { turnStateFromEncounter, startEncounter, runEncounter, encounterFromTurnState } from '../js/scene/turn-manager.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { canonicalJson, fnv1a } from './helpers/golden-runner.js';
import { parsedDdbFixture, DDB_FIXTURES, buildScene } from './helpers/entities.js';

const POS = { col: 1, row: 2 };
const OPTS = { pos: POS, controller: { type: 'player', seatId: 's1' } };

/** Hashes of the phase-1.5 rested entities (main bb0eb05, before T21). */
const PHASE_15_HASHES = { 'fighter-l5': '6333a7ff', 'wizard-l5': '71499689', 'cleric-l5': '2a0c32e2' };

test('T21: without a runState every fixture entity is byte-identical to phase 1.5', () => {
  for (const name of DDB_FIXTURES) {
    const sheet = parsedDdbFixture(name);
    assert.equal(fnv1a(canonicalJson(entityFromSheet(sheet, OPTS))), PHASE_15_HASHES[name], name);
    assert.equal(fnv1a(canonicalJson(entityFromSheet(sheet, { ...OPTS, runState: null, items: null }))), PHASE_15_HASHES[name], `${name} (null options)`);
  }
});

test('T21: resource key map — feat:* / spell:* map (run-state helpers), ddb:* / item:* / dm:* do not', () => {
  assert.equal(featureKeyForRunResource('feat:action-surge'), 'action-surge');
  assert.equal(featureKeyForRunResource('feat:second-wind'), 'second-wind');
  assert.equal(featureKeyForRunResource('feat:rage'), 'rage');
  assert.equal(featureKeyForRunResource('spell:misty-step'), 'spell:misty-step');
  assert.equal(featureKeyForRunResource('feat:legendary-resistance'), 'legendary-resistance');
  assert.equal(featureKeyForRunResource('ddb:12345'), null);
  assert.equal(featureKeyForRunResource('item:ri-1'), null);
  assert.equal(featureKeyForRunResource('dm:blessing'), null);
  assert.equal(featureKeyForRunResource('feat:'), null);
  assert.equal(featureKeyForRunResource('bardic'), null);
  for (const k of ['action-surge', 'second-wind', 'rage', 'channel-divinity', 'spell:misty-step', 'legendary-resistance']) {
    assert.equal(featureKeyForRunResource(runResourceKeyForFeature(k)), k, k);
  }
});

test('T21: SRD exhaustion table (2 speed halved, 3 attack/save disadvantage, 4 HP max halved, 5 speed 0, 6 dead)', () => {
  const rows = [0, 1, 2, 3, 4, 5, 6].map(n => {
    const f = exhaustionEffects(n);
    return [f.level, f.abilityCheckDisadvantage, f.speedHalved, f.attackSaveDisadvantage, f.hpMaxHalved, f.speedZero, f.dead];
  });
  assert.deepEqual(rows, [
    [0, false, false, false, false, false, false],
    [1, true, false, false, false, false, false],
    [2, true, true, false, false, false, false],
    [3, true, true, true, false, false, false],
    [4, true, true, true, true, false, false],
    [5, true, false, true, true, true, false],
    [6, true, false, true, true, true, true]
  ]);
  assert.equal(exhaustionEffects(9).level, 6);
  assert.equal(exhaustionEffects(-2).level, 0);
});

function wizardState(over = {}) {
  return {
    schema_v: 1,
    hp: { current: 20, temp: 3 },
    deathSaves: { successes: 0, failures: 0, stable: false },
    hitDice: { Wizard: { die: 6, spent: 2 } },
    slots: { spell: { 1: { spent: 3 }, 2: { spent: 1 }, 3: { spent: 0 } }, pact: { spent: 0 } },
    resources: {
      'feat:arcane-recovery': { label: 'Arcane Recovery', max: 1, spent: 1, recovery: ['lr'] },
      'ddb:777': { label: 'Lucky', max: 3, spent: 2, recovery: ['lr'] }
    },
    conditions: ['poisoned'],
    conditionMeta: { poisoned: { sourceId: 'sewer-rat', persistent: true } },
    exhaustion: 0,
    inspiration: true,
    currency: { cp: 0, sp: 7, ep: 0, gp: 42, pp: 0 },
    concentration: null,
    ...over
  };
}

test('T21: a runState seeds HP, temp HP, spent slots, feature uses and persistent conditions', () => {
  const sheet = parsedDdbFixture('wizard-l5');
  const e = entityFromSheet(sheet, { ...OPTS, runState: wizardState() });
  assert.deepEqual([e.hp, e.hpMax, e.hpTemp, e.speedFt], [20, 32, 3, 30]);
  assert.deepEqual(e.resources.slots, { 1: { max: 4, spent: 3 }, 2: { max: 3, spent: 1 }, 3: { max: 2, spent: 0 } });
  assert.deepEqual(e.resources.features['arcane-recovery'], { max: 1, spent: 1 });
  assert.equal(e.resources.features['ddb:777'], undefined, 'ddb:* is not an engine ledger');
  assert.deepEqual(validateRunState(wizardState(), { sheet }).errors, []);
  assert.deepEqual(e.conditions, [{ id: 'poisoned', sourceId: 'sewer-rat', endsOn: 'persistent' }], 'a DM-marked persistent condition');
  assert.equal(e.status, undefined, 'active');
  assert.equal(e.exhaustion, undefined);
  assert.deepEqual(validateEncounterState(stateWith([e])).errors, []);
  const w = wrapperFromEntity(e, sheet);
  assert.deepEqual(w._slots, { 1: 1, 2: 2, 3: 2, 4: 0, 5: 0 });
});

test('T21: maxima come from the sheet; an overspent run state is clamped; unknown slot levels are ignored', () => {
  const sheet = parsedDdbFixture('wizard-l5');
  const rs = wizardState({
    hp: { current: 999, temp: 0 },
    slots: { spell: { 1: { spent: 9 }, 7: { spent: 1 } }, pact: { spent: 0 } },
    resources: { 'feat:arcane-recovery': { label: 'x', max: 5, spent: 4, recovery: ['lr'] } }
  });
  const e = entityFromSheet(sheet, { ...OPTS, runState: rs });
  assert.equal(e.hp, 32);
  assert.deepEqual(e.resources.slots['1'], { max: 4, spent: 4 });
  assert.equal(e.resources.slots['7'], undefined);
  assert.deepEqual(e.resources.features['arcane-recovery'], { max: 1, spent: 1 });
});

test('T21: a ledger the sheet lacks (Rage from an earlier fight) is seeded from the run state', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const e = entityFromSheet(sheet, { ...OPTS, runState: { hp: { current: 44, temp: 0 }, resources: { 'feat:rage': { label: 'Rage', max: 3, spent: 2, recovery: ['lr'] } } } });
  assert.deepEqual(e.resources.features.rage, { max: 3, spent: 2 });
  assert.deepEqual(e.resources.features['action-surge'], { max: 1, spent: 0 }, 'absent from the state = unspent');
});

test('T21: 0 HP seeds the dying state from the tallies (downed / stable / dead)', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const at0 = (deathSaves) => entityFromSheet(sheet, { ...OPTS, runState: { hp: { current: 0, temp: 0 }, deathSaves } });
  const downed = at0({ successes: 1, failures: 2, stable: false });
  assert.deepEqual([downed.hp, downed.status, downed.deathSaves], [0, 'downed', { successes: 1, failures: 2, stable: false }]);
  assert.deepEqual(downed.conditions, ['unconscious']);
  const stable = at0({ successes: 3, failures: 1, stable: true });
  assert.equal(stable.status, 'stable');
  const dead = at0({ successes: 0, failures: 3, stable: false });
  assert.equal(dead.status, 'dead');
  assert.deepEqual(dead.conditions, []);
  for (const e of [downed, stable, dead]) assert.deepEqual(validateEncounterState(stateWith([e])).errors, []);
  const w = wrapperFromEntity(downed, sheet);
  assert.deepEqual([w.status, w.deathSaves.failures, w.conditions], ['downed', 2, ['unconscious']]);
});

test('T21: exhaustion seeds speed and HP max (2: half speed, 4: half HP max, 5: speed 0, 6: dead)', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const ex = (n) => entityFromSheet(sheet, { ...OPTS, runState: { hp: { current: 44, temp: 0 }, exhaustion: n } });
  assert.deepEqual([ex(1).speedFt, ex(1).hpMax, ex(1).exhaustion], [30, 44, 1]);
  assert.deepEqual([ex(2).speedFt, ex(2).hpMax], [15, 44]);
  assert.deepEqual([ex(3).speedFt, ex(3).hpMax], [15, 44]);
  assert.deepEqual([ex(4).speedFt, ex(4).hpMax, ex(4).hp], [15, 22, 22]);
  assert.deepEqual([ex(5).speedFt, ex(5).hpMax], [0, 22]);
  const six = ex(6);
  assert.deepEqual([six.hp, six.status, six.exhaustion], [0, 'dead', 6]);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.deepEqual(validateEncounterState(stateWith([ex(n)])).errors, [], `exhaustion ${n}`);
  assert.equal(wrapperFromEntity(ex(3), sheet).exhaustion, 3, 'the resolver reads it off the wrapper');
  assert.equal(runStateFromEntity(ex(3), { exhaustion: 3 }).exhaustion, 3);
});

test('T21: persistent conditions round-trip through conditionMeta; everything encounter-scoped is dropped on write-back', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const rs = {
    hp: { current: 30, temp: 0 },
    conditions: ['cursed', 'charmed'],
    conditionMeta: { cursed: { sourceId: 'hag', persistent: true } }
  };
  const e = entityFromSheet(sheet, { ...OPTS, runState: rs });
  assert.deepEqual(e.conditions, [{ id: 'cursed', sourceId: 'hag', endsOn: 'persistent' }, 'charmed'],
    'only the DM-marked one is persistent; an imported plain condition ends with the encounter');
  assert.deepEqual(validateEncounterState(stateWith([e])).errors, []);
  // In the fight: Rage, prone, a bite's plain 'poisoned' (R7 default
  // 'encounter'), and a DM-marked persistent disease.
  e.conditions.push(
    { id: 'raging', sourceId: e.id, endsOn: 'encounter', appliedRound: 1 }, { id: 'prone', endsOn: 'turn-start' },
    'poisoned', { id: 'sewer-plague', sourceId: null, endsOn: 'persistent' });
  assert.deepEqual(e.conditions.map(endsWithEncounter), [false, true, true, true, true, false]);
  const back = runStateFromEntity(e, rs);
  assert.deepEqual(back.conditions, ['cursed', 'sewer-plague']);
  assert.deepEqual(back.conditionMeta, { cursed: { sourceId: 'hag', persistent: true }, 'sewer-plague': { persistent: true } });
  // The wrapper keeps the persistent lifecycle through a turn.
  const w = wrapperFromEntity(e, sheet);
  assert.equal(w._conditionMeta.cursed.endsOn, 'persistent');
});

test('T21: runStateFromEntity writes spent (not remaining) and keeps every key the engine does not own', () => {
  const sheet = parsedDdbFixture('wizard-l5');
  const prev = wizardState();
  const e = entityFromSheet(sheet, { ...OPTS, runState: prev });
  e.hp = 7;   // test fixture edit (an encounter happened)
  e.hpTemp = 0;
  e.resources.slots['2'].spent = 3;
  const out = runStateFromEntity(e, prev);
  assert.deepEqual(out.hp, { current: 7, temp: 0 });
  assert.deepEqual(out.slots, { spell: { 1: { spent: 3 }, 2: { spent: 3 }, 3: { spent: 0 } }, pact: { spent: 0 } });
  for (const k of ['schema_v', 'hitDice', 'inspiration', 'currency']) assert.deepEqual(out[k], prev[k], k);
  assert.deepEqual(out.resources['ddb:777'], prev.resources['ddb:777']);
  assert.deepEqual(out.resources['feat:arcane-recovery'], prev.resources['feat:arcane-recovery']);
  assert.deepEqual(validateRunState(out, { sheet }).errors, []);
  assert.equal(prev.hp.current, 20, 'prev not mutated');
  assert.equal(prev.slots.spell['2'].spent, 1, 'prev not mutated');
});

test('T21: identity — seeding then writing back with no encounter returns the run state unchanged', () => {
  const rng = createRng({ s: 99 });
  for (let i = 0; i < 30; i++) {
    for (const name of DDB_FIXTURES) {
      const sheet = parsedDdbFixture(name);
      const rs = randomRunState(sheet, rng);
      assert.deepEqual(validateRunState(rs, { sheet }).errors, [], `${name} #${i} generator`);
      const e = entityFromSheet(sheet, { ...OPTS, runState: rs });
      assert.deepEqual(runStateFromEntity(e, rs), rs, `${name} #${i}`);
      // Keys outside state_json v1 (a later version's) are carried too.
      const withExtra = { ...rs, extra: { kept: [1, 'two', { three: 3 }] } };
      assert.deepEqual(runStateFromEntity(entityFromSheet(sheet, { ...OPTS, runState: withExtra }), withExtra), withExtra);
    }
  }
});

test('T21: property — over simulated encounters the write-back keeps every untouched key', async () => {
  const rng = createRng({ s: 2026 });
  const sheets = Object.fromEntries(DDB_FIXTURES.map(n => [n, parsedDdbFixture(n)]));
  let fights = 0;
  let changed = 0;
  for (let i = 0; i < 12; i++) {
    const prev = {};
    const state = emptyEncounterState({ encounterId: `e${i}`, cols: 10, rows: 8, seed: 1000 + i });
    const bySheetId = {};
    DDB_FIXTURES.forEach((name, row) => {
      const sheet = sheets[name];
      prev[name] = randomRunState(sheet, rng);
      const e = entityFromSheet(sheet, { pos: { col: 1, row: row + 1 }, runState: prev[name] });
      state.entities[e.id] = e;
      bySheetId[e.sheetRef.characterId] = sheet;
    });
    ['goblin', 'cult-fanatic', 'goblin'].forEach((slug, k) => {
      const m = entityFromPreset(slug, { id: `m${k}`, pos: { col: 6, row: k + 1 } });
      state.entities[m.id] = m;
    });
    assert.deepEqual(validateEncounterState(state).errors, []);
    const fightRng = createRng({ s: 7 + i });
    const ts = turnStateFromEncounter(state, bySheetId);
    startEncounter(ts, { rng: fightRng, initiative: 'roll', maxRounds: 6 });
    await runEncounter(ts, { rng: fightRng });
    const after = encounterFromTurnState(ts, fightRng);
    assert.deepEqual(validateEncounterState(after).errors, []);
    fights++;
    for (const name of DDB_FIXTURES) {
      const sheet = sheets[name];
      const entity = after.entities[String(sheet.id)];
      const before = prev[name];
      const out = runStateFromEntity(entity, before);
      if (canonicalJson(out) !== canonicalJson(before)) changed++;
      // Keys the engine never owns are deep-equal.
      assert.deepEqual(validateRunState(out, { sheet }).errors, [], `${name}: valid state_json v1`);
      for (const k of ['schema_v', 'hitDice', 'inspiration', 'currency']) assert.deepEqual(out[k], before[k], `${name}: ${k}`);
      for (const [rk, r] of Object.entries(before.resources)) {
        if (!featureKeyForRunResource(rk)) { assert.deepEqual(out.resources[rk], r, `${name}: ${rk}`); continue; }
        const { spent: _a, ...restOut } = out.resources[rk];
        const { spent: _b, ...restPrev } = r;
        assert.deepEqual(restOut, restPrev, `${name}: ${rk} (all but spent)`);
        assert.ok(out.resources[rk].spent >= r.spent, `${name}: ${rk} recovers nothing in a fight`);
        assert.ok(out.resources[rk].spent <= r.max, `${name}: ${rk} within max`);
      }
      for (const [lvl, l] of Object.entries(before.slots.spell)) {
        assert.ok(out.slots.spell[lvl].spent >= l.spent, `${name}: slot ${lvl} recovers nothing in a fight`);
        assert.ok(out.slots.spell[lvl].spent <= entity.resources.slots[lvl].max, `${name}: slot ${lvl} within max`);
      }
      assert.deepEqual(out.slots.pact, before.slots.pact, `${name}: pact (no pact caster)`);
      assert.deepEqual(out.conditionMeta.poisoned, before.conditionMeta.poisoned, `${name}: DM meta kept`);
      // Re-seeding the written state reproduces the encounter's end.
      const again = entityFromSheet(sheet, { pos: POS, runState: out });
      assert.equal(again.hp, entity.hp, `${name}: hp`);
      assert.equal(again.hpTemp, entity.hpTemp, `${name}: temp hp`);
      assert.deepEqual(again.resources.slots, entity.resources.slots, `${name}: slots`);
      assert.equal(again.status ?? 'active', entity.status ?? 'active', `${name}: life status`);
      for (const [fk, l] of Object.entries(entity.resources.features)) {
        assert.deepEqual(again.resources.features[fk], l, `${name}: ${fk}`);
      }
    }
  }
  assert.equal(fights, 12);
  assert.ok(changed > 0, 'the fights spent something');
});

test('T21: a feat Misty Step spends its own use, and the spend lands in runState.resources[\'spell:misty-step\']', async () => {
  const sheet = parsedDdbFixture('cleric-l5');
  for (const prev of [
    { hp: { current: 38, temp: 0 }, resources: { 'spell:misty-step': { label: 'Misty Step', max: 1, spent: 0, recovery: ['lr'] } } },
    { hp: { current: 38, temp: 0 }, resources: {} }
  ]) {
    const state = emptyEncounterState({ encounterId: 'e', cols: 8, rows: 6, seed: 3 });
    const pc = entityFromSheet(sheet, { id: 'cl', pos: { col: 1, row: 1 }, runState: prev });
    state.entities.cl = pc;
    state.entities.gob = entityFromPreset('goblin', { id: 'gob', pos: { col: 2, row: 1 } });
    const w = wrapperFromEntity(pc, sheet);
    const gob = wrapperFromEntity(state.entities.gob);
    const slotsBefore = { ...w._slots };
    await runOneAttack(w, [gob], [w], buildScene({ cols: 8, rows: 6 }), createRng({ s: 4 }), {
      forcePlan: { kind: 'cast', spellId: 'misty-step', castAtLevel: 2, targetId: null, targetSide: 'enemy', featuresFired: [], moveTo: { col: 1, row: 4 } }
    });
    assert.deepEqual(w._position, { col: 1, row: 4 });
    assert.deepEqual(w._slots, slotsBefore, 'no slot spent');
    const after = applyEngineSides(state, [w]).entities.cl;
    const out = runStateFromEntity(after, prev);
    assert.deepEqual(out.resources['spell:misty-step'], { label: 'Misty Step', max: 1, spent: 1, recovery: ['lr'] });
    assert.deepEqual(out.slots.spell, {}, 'no slot written');
  }
});

test('T21/T23: run items become resources.items; itemSpendFromEntity reports the spend', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const e = entityFromSheet(sheet, {
    ...OPTS,
    items: { 'ri-1': { name: 'Potion of Healing', effect: 'potion-of-healing', max: 2, spent: 0 }, 'ri-2': { name: 'Potion of Greater Healing', max: 1, spent: 5 } }
  });
  assert.deepEqual(e.resources.items, {
    'ri-1': { name: 'Potion of Healing', effect: 'potion-of-healing', max: 2, spent: 0 },
    'ri-2': { name: 'Potion of Greater Healing', effect: 'potion-of-greater-healing', max: 1, spent: 1 }
  });
  assert.deepEqual(validateEncounterState(stateWith([e])).errors, []);
  const w = wrapperFromEntity(e, sheet);
  w._items['ri-1'].spent = 1;
  const after = applyEngineSides(stateWith([e]), [w]).entities[e.id];
  assert.deepEqual(itemSpendFromEntity(after), { 'ri-1': 1, 'ri-2': 1 });
  assert.equal(entityFromSheet(sheet, { ...OPTS, items: {} }).resources.items, undefined, 'empty map = no items key');
});

// ---------------------------------------------------------------------

function stateWith(entities) {
  const s = emptyEncounterState({ encounterId: 'e', cols: 10, rows: 8, seed: 1 });
  for (const e of entities) s.entities[e.id] = e;
  return s;
}

/**
 * A valid state_json v1 for `sheet`: E6's initialRunState with random
 * spends within the sheet's maxima, a DDB resource, a DM-marked
 * persistent condition and some exhaustion.
 */
function randomRunState(sheet, rng) {
  const rs = initialRunState(sheet);
  const rested = entityFromSheet(sheet, { pos: POS });
  const pick = (n) => Math.floor(rng() * n);
  for (const [lvl, l] of Object.entries(rs.slots.spell)) l.spent = pick((rested.resources.slots[lvl]?.max ?? 0) + 1);
  rs.resources['ddb:4242'] = { label: 'Something DDB', max: 3, spent: pick(4), recovery: ['lr'] };
  rs.resources['ddb:99'] = { label: 'Other', max: 1, spent: 0, recovery: ['sr', 'lr'] };
  for (const [fk, l] of Object.entries(rested.resources.features)) {
    const key = runResourceKeyForFeature(fk);
    rs.resources[key] = { ...(rs.resources[key] || { label: `L ${fk}`, recovery: ['sr'] }), max: l.max, spent: pick(l.max + 1) };
  }
  rs.hp = { current: 1 + pick(rested.hpMax), temp: pick(4) };
  for (const hd of Object.values(rs.hitDice)) hd.spent = pick(3);
  rs.conditions = ['poisoned'];
  rs.conditionMeta = { poisoned: { sourceId: 'sewer-rat', persistent: true } };
  rs.exhaustion = pick(4);
  rs.inspiration = rng() < 0.5;
  rs.currency = { cp: pick(50), sp: pick(10), ep: 0, gp: pick(200), pp: pick(3) };
  return rs;
}
