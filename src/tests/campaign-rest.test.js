// M65 R25 — short and long rests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REST_TYPES, hitDicePool, applyRest } from '../js/campaign/rest.js';
import { CampaignRuleError } from '../js/campaign/errors.js';
import { createRng } from '../js/scene/rng.js';
import { parsedDdbFixture } from './helpers/entities.js';
import { restedState, scriptedRng, faceFloat } from './helpers/campaign-state.js';

const cleric = () => parsedDdbFixture('cleric-l5');
const fighter = () => parsedDdbFixture('fighter-l5');

function warlockSheet() {
  return {
    name: 'Lock', level: 3, classes: [{ name: 'Warlock', level: 3 }],
    abilityModifiers: { CON: 1 }, hp: { max: 24 },
    hitDice: { Warlock: { die: 8, spent: 0 } },
    spellSlotTable: { classes: [], spell: {}, pact: { level: 2, max: 2 } },
    resources: {}
  };
}

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof CampaignRuleError && e.code === code);

test('REST_TYPES: data-driven short / long definitions (frozen)', () => {
  assert.deepEqual(Object.keys(REST_TYPES), ['short', 'long']);
  assert.deepEqual([...REST_TYPES.short.recoverPeriods], ['sr']);
  assert.deepEqual([...REST_TYPES.long.recoverPeriods], ['sr', 'lr']);
  assert.deepEqual([...REST_TYPES.long.dawnPeriods], ['dawn', 'day']);
  assert.equal(REST_TYPES.long.minHp, 1);
  assert.ok(Object.isFrozen(REST_TYPES.long));
});

test('hitDicePool: max = class level, available = max − spent', () => {
  const s = cleric();
  assert.deepEqual(hitDicePool(s, restedState(s, { hitDice: { Cleric: { die: 8, spent: 3 } } })),
    { Cleric: { die: 8, max: 5, spent: 3, available: 2 } });
});

test('3-node run: fight → short rest (hit dice, sr + pact) → fight → long rest', () => {
  const s = cleric();
  // Node 1 (fight): took damage, spent slots, Channel Divinity (sr) and Misty Step (lr).
  let state = restedState(s);
  state.hp.current = 10;
  state.slots.spell[1].spent = 3;
  state.slots.spell[3].spent = 1;
  state.resources['feat:channel-divinity'].spent = 1;
  state.resources['spell:misty-step'].spent = 1;

  // Node 2 (short rest): spend 2 hit dice: rolls 5 and 8, CON +2 each.
  const rng = scriptedRng([faceFloat(5, 8), faceFloat(8, 8)]);
  const short = applyRest(s, state, 'short', { spend: { Cleric: 2 }, rng });
  assert.deepEqual(short.rolls, [
    { className: 'Cleric', die: 8, roll: 5, con: 2, healed: 7 },
    { className: 'Cleric', die: 8, roll: 8, con: 2, healed: 10 }
  ]);
  assert.equal(short.state.hp.current, 27);
  assert.equal(short.state.hitDice.Cleric.spent, 2);
  assert.equal(short.state.resources['feat:channel-divinity'].spent, 0, 'sr recovers');
  assert.equal(short.state.resources['spell:misty-step'].spent, 1, 'lr does not');
  assert.equal(short.state.slots.spell[1].spent, 3, 'levelled slots do not');
  assert.equal(short.preparedSwap, false);
  assert.ok(short.deltas.some(d => d.path === 'hp.current' && d.before === 10 && d.after === 27));
  assert.ok(short.deltas.some(d => d.path === 'resources.feat:channel-divinity.spent' && d.before === 1 && d.after === 0));
  assert.equal(state.hp.current, 10, 'input state not mutated');

  // Node 3 (fight) then a long rest.
  state = short.state;
  state.hp.current = 4;
  state.hp.temp = 5;
  state.exhaustion = 2;
  const long = applyRest(s, state, 'long');
  assert.equal(long.state.hp.current, 38);
  assert.equal(long.state.hp.temp, 0);
  assert.equal(long.state.hitDice.Cleric.spent, 0, '5 HD total → 2 back; 2 were spent');
  assert.deepEqual(long.state.slots.spell, { 1: { spent: 0 }, 2: { spent: 0 }, 3: { spent: 0 } });
  assert.equal(long.state.resources['spell:misty-step'].spent, 0);
  assert.equal(long.state.exhaustion, 1);
  assert.equal(long.preparedSwap, true);
  assert.deepEqual(long.rolls, []);
});

test('short rest: pact slots recover', () => {
  const s = warlockSheet();
  const state = restedState(s);
  state.slots.pact.spent = 2;
  const r = applyRest(s, state, 'short');
  assert.equal(r.state.slots.pact.spent, 0);
  assert.ok(r.deltas.some(d => d.path === 'slots.pact.spent' && d.before === 2 && d.after === 0));
});

test('short rest: overspending hit dice is rejected before anything is rolled', () => {
  const s = cleric();
  const state = restedState(s, { hitDice: { Cleric: { die: 8, spent: 4 } } });
  let rolled = 0;
  const rng = () => { rolled++; return 0.5; };
  throwsCode(() => applyRest(s, state, 'short', { spend: { Cleric: 2 }, rng }), 'hit-dice-overspent');
  assert.equal(rolled, 0);
  throwsCode(() => applyRest(s, state, 'short', { spend: { Wizard: 1 }, rng }), 'unknown-class');
  throwsCode(() => applyRest(s, state, 'short', { spend: { Cleric: 1.5 }, rng }), 'bad-spend');
  assert.throws(() => applyRest(s, restedState(s), 'short', { spend: 1 }), TypeError, 'rng is required to roll');
  // A count works for a single-class sheet.
  assert.equal(applyRest(s, restedState(s, { hp: { current: 1, temp: 0 } }), 'short', { spend: 1, rng: () => 0 }).state.hitDice.Cleric.spent, 1);
});

test('short rest: healing never exceeds max; a low roll with negative CON heals 0, not negative', () => {
  const s = { ...fighter(), abilityModifiers: { ...fighter().abilityModifiers, CON: -3 } };
  const state = restedState(s, { hp: { current: 40, temp: 0 } });
  const r = applyRest(s, state, 'short', { spend: { Fighter: 2 }, rng: scriptedRng([faceFloat(1, 10), faceFloat(10, 10)]) });
  assert.deepEqual(r.rolls.map(x => x.healed), [0, 4]);
  assert.equal(r.state.hp.current, 44);
});

test('short rest at 0 HP: hit dice lift a stable PC and clear death saves', () => {
  const s = cleric();
  const state = restedState(s, { hp: { current: 0, temp: 0 }, deathSaves: { successes: 3, failures: 1, stable: true } });
  const r = applyRest(s, state, 'short', { spend: { Cleric: 1 }, rng: () => 0.99 });
  assert.equal(r.state.hp.current, 10);
  assert.deepEqual(r.state.deathSaves, { successes: 0, failures: 0, stable: false });
});

test('long rest at 0 HP is refused; a dead character cannot rest; unknown types throw', () => {
  const s = cleric();
  throwsCode(() => applyRest(s, restedState(s, { hp: { current: 0, temp: 0 } }), 'long'), 'needs-hp');
  throwsCode(() => applyRest(s, restedState(s, { deathSaves: { successes: 0, failures: 3, stable: false } }), 'short'), 'dead');
  throwsCode(() => applyRest(s, restedState(s), 'short', { lifeStatus: 'dead' }), 'dead');
  throwsCode(() => applyRest(s, restedState(s), 'nap'), 'unknown-rest-type');
  throwsCode(() => applyRest(s, restedState(s), 'long', { spend: { Cleric: 1 } }), 'no-hit-dice-on-long-rest');
});

test('long rest: half the total hit dice back (min 1), largest dice first', () => {
  const s = {
    level: 3, classes: [{ name: 'Fighter', level: 1 }, { name: 'Wizard', level: 2 }],
    abilityModifiers: { CON: 0 }, hp: { max: 20 }, resources: {},
    hitDice: { Fighter: { die: 10, spent: 0 }, Wizard: { die: 6, spent: 0 } }, spellSlotTable: { spell: {} }
  };
  const state = restedState(s, { hitDice: { Fighter: { die: 10, spent: 1 }, Wizard: { die: 6, spent: 2 } } });
  const r = applyRest(s, state, 'long');
  // 3 HD total → floor(1.5) = 1 back, the d10 first.
  assert.deepEqual(r.state.hitDice, { Fighter: { die: 10, spent: 0 }, Wizard: { die: 6, spent: 2 } });
  // A level-1 character still regains 1.
  const one = { level: 1, classes: [{ name: 'Fighter', level: 1 }], abilityModifiers: { CON: 0 }, hp: { max: 12 }, hitDice: { Fighter: { die: 10, spent: 1 } } };
  assert.equal(applyRest(one, restedState(one, { hitDice: { Fighter: { die: 10, spent: 1 } } }), 'long').state.hitDice.Fighter.spent, 0);
});

test('long rest: dawn / day resources need dawnIsLongRest', () => {
  const s = cleric();
  const state = restedState(s);
  state.resources['ddb:item-charges'] = { label: 'Wand', max: 3, spent: 3, recovery: [{ period: 'dawn' }] };
  state.resources['ddb:dm'] = { label: 'DM-managed', max: 1, spent: 1, recovery: [] };
  assert.equal(applyRest(s, state, 'long').state.resources['ddb:item-charges'].spent, 3);
  const r = applyRest(s, state, 'long', { dawnIsLongRest: true });
  assert.equal(r.state.resources['ddb:item-charges'].spent, 0);
  assert.equal(r.state.resources['ddb:dm'].spent, 1, 'no recovery period: DM-managed');
});

test('long rest: exhaustion 5 → 4 keeps the HP max halved; 4 → 3 restores it', () => {
  const s = cleric();
  assert.equal(applyRest(s, restedState(s, { exhaustion: 5, hp: { current: 5, temp: 0 } }), 'long').state.hp.current, 19);
  const r = applyRest(s, restedState(s, { exhaustion: 4, hp: { current: 5, temp: 0 } }), 'long');
  assert.equal(r.state.exhaustion, 3);
  assert.equal(r.state.hp.current, 38);
});

test('rests replay: the same seeded rng gives the same result', () => {
  const s = cleric();
  const state = restedState(s, { hp: { current: 3, temp: 0 } });
  const a = applyRest(s, state, 'short', { spend: { Cleric: 3 }, rng: createRng({ s: 42 }) });
  const b = applyRest(s, state, 'short', { spend: { Cleric: 3 }, rng: createRng({ s: 42 }) });
  assert.deepEqual(a, b);
});
