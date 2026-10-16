/**
 * M64 T5 — EncounterState v1 ↔ engine wrapper adapters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  toEngineSides, applyEngineSides, wrapperFromEntity, applyWrapperToEntity,
  poolFromLedger, ledgerFromPool, stripTransient, dynamicStateOf, TRANSIENT_WRAPPER_FIELDS
} from '../js/scene/encounter-adapters.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { MONSTER_PROFILES } from '../js/scene/ai/profiles.js';
import { parsedDdbFixture } from './helpers/entities.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/encounters/${name}.state.json`, import.meta.url), 'utf8'));
const sheetsFor = (state) => Object.fromEntries(Object.values(state.entities)
  .filter(e => e.kind === 'pc').map(e => [e.sheetRef.characterId, parsedDdbFixture(e.sheetRef.characterId)]));

test('adapters: poolFromLedger / ledgerFromPool round-trip spent counts', () => {
  const ledger = { 1: { max: 4, spent: 1 }, 3: { max: 2, spent: 0 } };
  assert.deepEqual(poolFromLedger(ledger, [1, 2, 3]), { 1: 3, 2: 0, 3: 2 });
  assert.deepEqual(ledgerFromPool(ledger, { 1: 1, 2: 0, 3: 2 }), { 1: { max: 4, spent: 3 }, 3: { max: 2, spent: 0 } });
  assert.deepEqual(ledger[1], { max: 4, spent: 1 }, 'input ledger untouched');
  assert.deepEqual(ledgerFromPool({}, { 2: 2 }), { 2: { max: 2, spent: 0 } }, 'unknown level with slots is added');
});

test('adapters: state → wrappers → state round-trip preserves every resource', () => {
  const state = fixture('counterspell');
  const pc = state.entities['pc-wizard'];
  pc.resources.slots['1'].spent = 2;
  pc.resources.features = { 'action-surge': { max: 1, spent: 1 } };
  pc.resources.pact = { level: 2, max: 2, spent: 1 };
  pc.turnFlags = { sneakUsed: true, smiteSlotUsed: 2 };
  pc.conditions = ['prone', { id: 'paralyzed', sourceId: 'm-fanatic-a', endsOn: 'concentration', save: { stat: 'WIS', dc: 13 } }];
  pc.concentration = { spellId: 'hold-person', targetIds: ['m-fanatic-b'] };
  const mon = state.entities['m-fanatic-a'];
  mon.resources.legendaryBudget = 2;
  mon.resources.innate = { atWill: ['x'], recharges: { y: false }, perDay: { 1: [{ id: 'z', remaining: 0 }] } };
  mon.statBlock = { slug: 'cult-fanatic', profile: { archetype: 'custom', considerations: {} } };
  const { wrappers } = toEngineSides(state, sheetsFor(state));
  const back = applyEngineSides(state, wrappers);
  assert.ok(validateEncounterState(back).ok, JSON.stringify(validateEncounterState(back).errors));
  assert.deepEqual(back, state);
  assert.notEqual(back.entities['pc-wizard'], state.entities['pc-wizard'], 'new objects');
});

test('adapters: wrappers carry the engine fields (ledger, flags, profile, concentration)', () => {
  const state = fixture('counterspell');
  state.entities['m-fanatic-a'].statBlock.profile = MONSTER_PROFILES.orc;
  state.entities['pc-wizard'].concentration = { spellId: 'hold-person', targetIds: [] };
  const sides = toEngineSides(state, sheetsFor(state), 'pc-wizard');
  const wiz = sides.active;
  assert.equal(wiz.id, 'pc-wizard');
  assert.deepEqual(wiz._slots, { 1: 4, 2: 3, 3: 2, 4: 0, 5: 0 });
  assert.equal(wiz._lvl1Slots, undefined);
  assert.deepEqual(wiz._concentrating, { spellId: 'hold-person', spellName: 'Hold Person', targetIds: [] });
  assert.equal(wiz.ref.name, sheetsFor(state)['wizard-l5'].name);
  assert.deepEqual(sides.allies.map(w => w.id).sort(), ['pc-fighter', 'pc-wizard']);
  assert.deepEqual(sides.enemies.map(w => w.id).sort(), ['m-fanatic-a', 'm-fanatic-b']);
  assert.equal(sides.byId.get('m-fanatic-a')._aiProfile.archetype, 'aggressive_charger');
  assert.equal(sides.scene.cols, state.grid.cols);
  assert.throws(() => toEngineSides(state, {}), /no sheet/);
});

test('adapters: an Open5e stat block (attacks, saves) reaches the engine', () => {
  const state = fixture('shield-reaction');
  state.entities['m-gob'].statBlock = {
    slug: 'goblin', name: 'Young Red Dragon',
    attacks: [{ name: 'Bite', bonus: 10, dice: '2d10+6' }, { name: 'Claw', bonus: 10, dice: '2d6+6' }],
    saves: { DEX: 4, CON: 9 }
  };
  const w = toEngineSides(state, sheetsFor(state)).byId.get('m-gob');
  assert.deepEqual(w.attack, { name: 'Bite', bonus: 10, dice: '2d10+6' });
  assert.equal(w.secondary.name, 'Claw');
  assert.deepEqual(w.saves, { DEX: 4, CON: 9 });
});

test('adapters: transient fields never persist; partial wrappers keep the rest', () => {
  const state = fixture('shield-reaction');
  const entity = state.entities['pc-wizard'];
  const sheet = parsedDdbFixture('wizard-l5');
  const w = wrapperFromEntity(entity, sheet);
  w._mctsTargetCtx = { target: w };              // a cycle: must never be serialised
  w._lastPlan = { kind: 'melee' };
  const stripped = stripTransient(w);
  for (const f of [...TRANSIENT_WRAPPER_FIELDS, 'ref']) assert.ok(!(f in stripped), f);
  const e2 = applyWrapperToEntity(entity, { hp: 5.9 });
  assert.equal(e2.hp, 5);
  assert.deepEqual(e2.resources, entity.resources);
  assert.equal(applyWrapperToEntity(entity, { hp: 999 }).hp, entity.hpMax);
  JSON.stringify(applyEngineSides(state, [w]));      // no cycle reaches the state
});

test('adapters: dynamicStateOf drops sheetRef / statBlock', () => {
  const d = dynamicStateOf(fixture('shield-reaction'));
  assert.ok(!('sheetRef' in d.entities['pc-wizard']));
  assert.ok(!('statBlock' in d.entities['m-gob']));
  assert.ok(!('rng' in d));
});

async function shieldTurn(state, attackerId) {
  const sides = toEngineSides(state, sheetsFor(state), attackerId);
  const plan = { kind: 'attack', targetId: 'pc-wizard', targetSide: 'enemy', featuresFired: [] };
  // d20 = 11 (+4 goblin / +4 bugbear) vs AC 12: a hit Shield can stop.
  await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, () => 0.5, { forcePlan: plan });
  return applyEngineSides(state, sides.wrappers);
}

test('adapters: Shield slots decrement across turns through the state', async () => {
  let state = fixture('shield-reaction');
  state.entities['pc-wizard'].resources.reactionUsed = false;
  state = await shieldTurn(state, 'm-gob');
  assert.equal(state.entities['pc-wizard'].resources.slots['1'].spent, 1);
  assert.equal(state.entities['pc-wizard'].resources.reactionUsed, true);
  // New round: the reaction refreshes, the slot does not.
  state.entities['pc-wizard'].resources.reactionUsed = false;
  state = await shieldTurn(state, 'm-bugbear');
  assert.equal(state.entities['pc-wizard'].resources.slots['1'].spent, 2);
  assert.ok(validateEncounterState(state).ok);
});

test('adapters: statBlock.profile (_aiProfile) changes the monster\'s choice', async () => {
  const run = async (profile) => {
    const state = fixture('shield-reaction');
    const gob = state.entities['m-gob'];
    gob.hp = 2;                                         // goblin retreats below 40%
    if (profile) gob.statBlock.profile = profile;
    const sides = toEngineSides(state, sheetsFor(state), 'm-gob');
    await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, createRng({ s: 5 }));
    return sides.active._lastPlan.kind;
  };
  assert.equal(await run(null), 'flee');
  assert.notEqual(await run(MONSTER_PROFILES.orc), 'flee', 'orc profile never retreats');
});

test('adapters: entityFromSheet / entityFromPreset build valid, rested entities', async () => {
  const { entityFromSheet, entityFromPreset } = await import('../js/scene/encounter-adapters.js');
  const { emptyEncounterState } = await import('../js/shared/encounter-state.js');
  const fighter = parsedDdbFixture('fighter-l5');
  const wizard = parsedDdbFixture('wizard-l5');
  const state = emptyEncounterState({ encounterId: 'e1', cols: 10, rows: 6, seed: 1 });
  const f = entityFromSheet(fighter, { pos: { col: 1, row: 1 }, controller: { type: 'player', seatId: 's1' } });
  const w = entityFromSheet(wizard, { pos: { col: 1, row: 2 } });
  const d = entityFromPreset('young-dragon', { id: 'm1', pos: { col: 8, row: 3 } });
  const g = entityFromPreset('goblin', { id: 'm2', pos: { col: 7, row: 3 }, statBlock: { name: 'Boss', ac: 17, hpMax: 21, attacks: [{ name: 'Axe', bonus: 5, dice: '1d8+3' }] } });
  for (const e of [f, w, d, g]) state.entities[e.id] = e;
  const v = validateEncounterState(state);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(f.resources.features['action-surge'], { max: 1, spent: 0 });
  assert.deepEqual(w.resources.slots, { 1: { max: 4, spent: 0 }, 2: { max: 3, spent: 0 }, 3: { max: 2, spent: 0 } });
  assert.ok(d.resources.innate && d.resources.legendaryBudget > 0);
  assert.equal(g.ac, 17);
  assert.equal(g.hpMax, 21);
  const sides = toEngineSides(state, { [fighter.id]: fighter, [wizard.id]: wizard }, 'm2');
  assert.equal(sides.active.attack.name, 'Axe');
  assert.throws(() => entityFromPreset('nope', { id: 'x', pos: { col: 0, row: 0 } }), /unknown monster preset/);
});
