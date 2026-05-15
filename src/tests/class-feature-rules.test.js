import { test } from 'node:test';
import assert from 'node:assert';
import { evaluateFeatures, registerFeatureRule } from '../js/scene/class-feature-rules.js';

// Rogue context helpers — a synthetic rogue with Sneak Attack already
// parsed (M10) into classFeatures.

function rogueAttacker({ pos = { col: 5, row: 5 }, conditions = [], dice = '2d6' } = {}) {
  return {
    id: 'rogue',
    name: 'Rogue',
    classFeatures: [
      { name: 'Sneak Attack', source: 'Rogue', level: 1, dice, uses: null, description: 'Once per turn...' }
    ],
    conditions,
    _position: pos
  };
}

function monsterTarget({ pos = { col: 5, row: 5 }, conditions = [] } = {}) {
  return { id: 'm1', name: 'Goblin', position: pos, conditions };
}

const FINESSE_WEAPON = { name: 'Rapier' };
const RANGED_WEAPON  = { name: 'Shortbow' };
const HEAVY_WEAPON   = { name: 'Greatsword' };

// ---------- Registry plumbing ----------

test('M15: evaluateFeatures returns [] when attacker has no classFeatures', () => {
  const ctx = { attacker: {}, target: monsterTarget(), weapon: FINESSE_WEAPON, scene: {}, resolvedMode: 'normal' };
  assert.deepStrictEqual(evaluateFeatures(ctx), []);
});

test('M15: evaluateFeatures skips unknown features (registry miss)', () => {
  const attacker = {
    id: 'a', name: 'A',
    classFeatures: [{ name: 'Stonecunning', source: 'Dwarf', level: 1 }]
  };
  const ctx = { attacker, target: monsterTarget(), weapon: FINESSE_WEAPON, scene: {}, resolvedMode: 'normal' };
  assert.deepStrictEqual(evaluateFeatures(ctx), []);
});

test('M15: registerFeatureRule lets a custom rule plug into the registry', () => {
  registerFeatureRule('Test Smite', () => ({ available: true, dice: '99d6', reason: 'Test' }));
  const attacker = {
    id: 'a', name: 'A',
    classFeatures: [{ name: 'Test Smite', source: 'Test', level: 1 }]
  };
  const ctx = { attacker, target: monsterTarget(), weapon: FINESSE_WEAPON, scene: {}, resolvedMode: 'normal' };
  const results = evaluateFeatures(ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].name, 'Test Smite');
  assert.strictEqual(results[0].dice, '99d6');
});

// ---------- Sneak Attack rule ----------

test('M15: Sneak Attack — available with finesse weapon + advantage', () => {
  const ctx = {
    attacker: rogueAttacker(), target: monsterTarget(),
    weapon: FINESSE_WEAPON, scene: {}, resolvedMode: 'advantage'
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.available, true);
  assert.strictEqual(sa.dice, '2d6');
  assert.ok(/advantage/i.test(sa.reason));
});

test('M15: Sneak Attack — available with ranged weapon + advantage', () => {
  const ctx = {
    attacker: rogueAttacker(), target: monsterTarget(),
    weapon: RANGED_WEAPON, scene: {}, resolvedMode: 'advantage'
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.available, true);
});

test('M15: Sneak Attack — blocked when weapon is neither finesse nor ranged', () => {
  const ctx = {
    attacker: rogueAttacker(), target: monsterTarget(),
    weapon: HEAVY_WEAPON, scene: {}, resolvedMode: 'advantage'
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.available, false);
  assert.ok(/finesse or ranged/i.test(sa.blockReason));
});

test('M15: Sneak Attack — blocked when attacker has disadvantage (even with ally adjacent)', () => {
  const ally = { id: 'ally', name: 'Adrin', _position: { col: 4, row: 5 }, conditions: [] };
  const ctx = {
    attacker: rogueAttacker({ pos: { col: 6, row: 5 } }),
    target: monsterTarget({ pos: { col: 5, row: 5 } }),
    weapon: FINESSE_WEAPON, scene: {},
    resolvedMode: 'disadvantage',
    allies: [ally]
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.available, false);
  assert.ok(/disadvantage/i.test(sa.blockReason));
});

test('M15: Sneak Attack — Path B (ally adjacent to target) works with no advantage', () => {
  const ally = { id: 'ally', name: 'Adrin', _position: { col: 4, row: 5 }, conditions: [] };
  const ctx = {
    attacker: rogueAttacker({ pos: { col: 8, row: 8 } }),    // far away, shooting
    target: monsterTarget({ pos: { col: 5, row: 5 } }),
    weapon: RANGED_WEAPON, scene: {},
    resolvedMode: 'normal',
    allies: [ally]
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.available, true);
  assert.ok(/Ally adjacent/i.test(sa.reason));
});

test('M15: Sneak Attack — Path B requires an UN-incapacitated ally', () => {
  const stunnedAlly = { id: 'ally', name: 'Adrin', _position: { col: 4, row: 5 }, conditions: ['stunned'] };
  const ctx = {
    attacker: rogueAttacker({ pos: { col: 8, row: 8 } }),
    target: monsterTarget({ pos: { col: 5, row: 5 } }),
    weapon: FINESSE_WEAPON, scene: {},
    resolvedMode: 'normal',
    allies: [stunnedAlly]
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.available, false);
});

test('M15: Sneak Attack — Path B requires ally within 5 ft (not 10 ft)', () => {
  const farAlly = { id: 'ally', name: 'Adrin', _position: { col: 3, row: 5 } };   // 10 ft from target
  const ctx = {
    attacker: rogueAttacker({ pos: { col: 8, row: 8 } }),
    target: monsterTarget({ pos: { col: 5, row: 5 } }),
    weapon: FINESSE_WEAPON, scene: {},
    resolvedMode: 'normal',
    allies: [farAlly]
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.available, false);
});

test('M15: Sneak Attack — no advantage, no ally → blocked with helpful reason', () => {
  const ctx = {
    attacker: rogueAttacker(), target: monsterTarget(),
    weapon: FINESSE_WEAPON, scene: {},
    resolvedMode: 'normal',
    allies: []
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.available, false);
  assert.ok(/Need advantage OR ally/i.test(sa.blockReason));
});

test('M15: Sneak Attack — Shortsword counts as finesse via name fallback', () => {
  // Shortsword without an explicit properties array — verify the
  // weaponHasFinesse name fallback kicks in.
  const ctx = {
    attacker: rogueAttacker(), target: monsterTarget(),
    weapon: { name: 'Shortsword' }, scene: {},
    resolvedMode: 'advantage'
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.available, true);
});

test('M15: Sneak Attack dice comes from the parsed feature record', () => {
  const ctx = {
    attacker: rogueAttacker({ dice: '5d6' }),   // L9 rogue
    target: monsterTarget(),
    weapon: FINESSE_WEAPON, scene: {},
    resolvedMode: 'advantage'
  };
  const [sa] = evaluateFeatures(ctx);
  assert.strictEqual(sa.dice, '5d6');
});
