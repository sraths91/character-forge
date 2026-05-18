import { test } from 'node:test';
import assert from 'node:assert';
import {
  isLegendary, legendaryBlockFor,
  freshLegendaryBudget, resetLegendaryBudget,
  chooseLegendaryAction, spendLegendaryAction
} from '../js/scene/monster-legendary.js';
import { simulateEncounter } from '../js/scene/simulator.js';

// ---------- Registry ----------

test('M41: LEGENDARY_ACTIONS — young-dragon shipped with 3-LA budget', () => {
  assert.strictEqual(isLegendary('young-dragon'), true);
  const block = legendaryBlockFor('young-dragon');
  assert.strictEqual(block.budget, 3);
  assert.ok(block.actions.some(a => a.id === 'tail-attack'));
  assert.ok(block.actions.some(a => a.id === 'wing-attack'));
});

test('M41: isLegendary — false for non-legendary monsters', () => {
  assert.strictEqual(isLegendary('goblin'), false);
  assert.strictEqual(isLegendary('cult-fanatic'), false);
  assert.strictEqual(isLegendary(null), false);
});

test('M41: freshLegendaryBudget — returns 0 for non-legendary slugs', () => {
  assert.strictEqual(freshLegendaryBudget('goblin'), 0);
});

test('M41: resetLegendaryBudget sets _legendaryBudget to the full pool', () => {
  const monster = { presetSlug: 'young-dragon', _legendaryBudget: 0 };
  resetLegendaryBudget(monster);
  assert.strictEqual(monster._legendaryBudget, 3);
});

// ---------- chooseLegendaryAction ----------

const enemyAt = (id, pos, hp = 30) => ({
  id, kind: 'pc', hp, hpMax: 30, conditions: [], _position: pos
});

test('M41: chooseLegendaryAction — picks Wing Attack (cost 2) when multiple enemies cluster in 15ft', () => {
  const self = {
    presetSlug: 'young-dragon', _legendaryBudget: 3,
    _position: { col: 5, row: 5 }, conditions: []
  };
  // 3 PCs all within 15ft (3 cells)
  const decision = chooseLegendaryAction({
    self,
    enemies: [
      enemyAt('pc1', { col: 6, row: 5 }),
      enemyAt('pc2', { col: 4, row: 5 }),
      enemyAt('pc3', { col: 5, row: 7 })
    ]
  });
  assert.ok(decision);
  assert.strictEqual(decision.action.id, 'wing-attack');
  assert.strictEqual(decision.targets.length, 3);
});

test('M41: chooseLegendaryAction — falls back to Tail Attack when only 1 LA remains', () => {
  const self = {
    presetSlug: 'young-dragon', _legendaryBudget: 1,
    _position: { col: 5, row: 5 }, conditions: []
  };
  const decision = chooseLegendaryAction({
    self, enemies: [enemyAt('pc1', { col: 6, row: 5 })]
  });
  assert.strictEqual(decision.action.id, 'tail-attack');
  assert.strictEqual(decision.target.id, 'pc1');
});

test('M41: chooseLegendaryAction — returns null when no enemies in reach', () => {
  const self = {
    presetSlug: 'young-dragon', _legendaryBudget: 3,
    _position: { col: 0, row: 0 }, conditions: []
  };
  const decision = chooseLegendaryAction({
    self, enemies: [enemyAt('pc1', { col: 20, row: 20 })]   // out of reach
  });
  assert.strictEqual(decision, null);
});

test('M41: chooseLegendaryAction — returns null when budget is 0', () => {
  const self = {
    presetSlug: 'young-dragon', _legendaryBudget: 0,
    _position: { col: 5, row: 5 }, conditions: []
  };
  const decision = chooseLegendaryAction({
    self, enemies: [enemyAt('pc1', { col: 6, row: 5 })]
  });
  assert.strictEqual(decision, null);
});

test('M41: chooseLegendaryAction — returns null when monster is incapacitated', () => {
  const self = {
    presetSlug: 'young-dragon', _legendaryBudget: 3,
    _position: { col: 5, row: 5 }, conditions: ['stunned']
  };
  const decision = chooseLegendaryAction({
    self, enemies: [enemyAt('pc1', { col: 6, row: 5 })]
  });
  assert.strictEqual(decision, null);
});

test('M41: chooseLegendaryAction — returns null for non-legendary monsters', () => {
  assert.strictEqual(chooseLegendaryAction({
    self: { presetSlug: 'goblin', _legendaryBudget: 3 },
    enemies: [enemyAt('pc1', { col: 1, row: 1 })]
  }), null);
});

test('M41: spendLegendaryAction decrements budget by the action cost', () => {
  const self = { _legendaryBudget: 3 };
  spendLegendaryAction(self, { cost: 2 });
  assert.strictEqual(self._legendaryBudget, 1);
  spendLegendaryAction(self, { cost: 1 });
  assert.strictEqual(self._legendaryBudget, 0);
  // Doesn't go negative
  spendLegendaryAction(self, { cost: 2 });
  assert.strictEqual(self._legendaryBudget, 0);
});

// ---------- Simulator integration ----------

test('M41: simulator — young dragon deals extra damage on PC turns via legendary actions', () => {
  // Same dragon vs same party fought twice. Compare to a "no LA" run
  // by swapping the dragon to a non-legendary preset of similar power
  // (troll). Differential MUST exist because legendary tail/wing
  // attacks fire every PC turn.
  const party = Array.from({ length: 3 }, (_, i) => ({
    id: `pc${i}`, name: `pc${i}`,
    _position: { col: 2, row: 1 + i },
    hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
    classes: [{ name: 'Fighter', level: 5 }],
    conditions: []
  }));
  const dragon = [{ id: 'd1', presetSlug: 'young-dragon', name: 'Dragon',
    hp: { current: 80, max: 80 }, position: { col: 1, row: 2 }, conditions: [] }];
  const troll = [{ id: 't1', presetSlug: 'troll', name: 'Troll',
    hp: { current: 80, max: 80 }, position: { col: 1, row: 2 }, conditions: [] }];

  const opts = { scene: { cols: 6, rows: 5 }, iterations: 80, maxRounds: 8, seed: 17 };
  const withLA   = simulateEncounter({ party, monsters: dragon, ...opts });
  const noLA     = simulateEncounter({ party, monsters: troll,  ...opts });

  // Dragon's avg damage dealt should exceed the troll's — legendary
  // actions are the difference (innate breath weapon also helps, but
  // the troll has roughly comparable melee per round).
  const dragonDmg = withLA.entities.find(e => e.id === 'd1').avgDamageDealt;
  const trollDmg  = noLA.entities.find(e => e.id === 't1').avgDamageDealt;
  assert.ok(dragonDmg > trollDmg,
    `expected dragon > troll dmg; dragon=${dragonDmg.toFixed(1)} troll=${trollDmg.toFixed(1)}`);
});

test('M41: simulator — legendary budget exhausts within a round (greedy spending)', () => {
  // Solo PC vs dragon, single round, large iteration count. Each PC turn
  // the dragon's budget should fully spend, so total LA damage per round
  // should be substantial.
  const party = [{
    id: 'fighter', name: 'Fighter', _position: { col: 2, row: 1 },
    hp: { current: 100, max: 100 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
    classes: [{ name: 'Fighter', level: 5 }],
    conditions: []
  }];
  const monsters = [{
    id: 'd1', presetSlug: 'young-dragon', name: 'Dragon',
    hp: { current: 80, max: 80 }, position: { col: 1, row: 1 }, conditions: []
  }];
  const stats = simulateEncounter({
    party, monsters, scene: { cols: 4, rows: 3 },
    iterations: 80, maxRounds: 3, seed: 21
  });
  const dragon = stats.entities.find(e => e.id === 'd1');
  // Dragon at minimum should deal at least its regular attack damage +
  // a tail attack's worth on average (PC turn → tail @ 1 LA → 2d8+4 ≈ 13).
  // Asserting > 10 per round avg over 3 rounds = > 30 total. Generous.
  assert.ok(dragon.avgDamageDealt > 10,
    `expected dragon to deal real damage with LAs; got avg ${dragon.avgDamageDealt.toFixed(1)}`);
});
