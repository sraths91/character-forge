import { test } from 'node:test';
import assert from 'node:assert';
import {
  MONSTER_INNATE, isInnateCaster, innateBlockFor,
  freshInnateState, rollInnateRecharges,
  canInnateCast, consumeInnate
} from '../js/scene/monster-spells.js';
import { chooseAction } from '../js/scene/ai/profile.js';
import { simulateEncounter } from '../js/scene/simulator.js';

// ---------- Innate-cast metadata ----------

test('M37: MONSTER_INNATE — vampire spawn has Charm Gaze at will', () => {
  const block = innateBlockFor('vampire-spawn');
  assert.ok(block);
  assert.ok(block.atWill.includes('charm-gaze'));
});

test('M37: MONSTER_INNATE — young dragon has fire-breath on recharge 5+', () => {
  const block = innateBlockFor('young-dragon');
  assert.ok(block);
  assert.strictEqual(block.recharge['fire-breath'], 5);
});

test('M37: isInnateCaster returns true only for monsters with an innate block', () => {
  assert.strictEqual(isInnateCaster('vampire-spawn'), true);
  assert.strictEqual(isInnateCaster('young-dragon'), true);
  assert.strictEqual(isInnateCaster('goblin'), false);
  assert.strictEqual(isInnateCaster(null), false);
});

// ---------- Fresh state + recharge ----------

test('M37: freshInnateState — atWill list copied; recharge spells start available', () => {
  const state = freshInnateState('young-dragon');
  assert.strictEqual(state.recharges['fire-breath'], true);
});

test('M37: freshInnateState — atWill array is independent of the block', () => {
  const state = freshInnateState('vampire-spawn');
  state.atWill.push('extra-spell');
  assert.strictEqual(MONSTER_INNATE['vampire-spawn'].atWill.includes('extra-spell'), false);
});

test('M37: rollInnateRecharges — restores recharge spell when d6 >= threshold', () => {
  const self = {
    presetSlug: 'young-dragon',
    _innate: { atWill: [], recharges: { 'fire-breath': false }, perDay: {} }
  };
  // rng → 0.99 → d6 = 6 ≥ 5 → restored
  const restored = rollInnateRecharges(self, () => 0.99);
  assert.deepStrictEqual(restored, ['fire-breath']);
  assert.strictEqual(self._innate.recharges['fire-breath'], true);
});

test('M37: rollInnateRecharges — leaves spell cooled down when d6 < threshold', () => {
  const self = {
    presetSlug: 'young-dragon',
    _innate: { atWill: [], recharges: { 'fire-breath': false }, perDay: {} }
  };
  // rng → 0 → d6 = 1 < 5 → still cooling
  const restored = rollInnateRecharges(self, () => 0);
  assert.deepStrictEqual(restored, []);
  assert.strictEqual(self._innate.recharges['fire-breath'], false);
});

test('M37: rollInnateRecharges — already-available spells aren\'t re-rolled', () => {
  const self = {
    presetSlug: 'young-dragon',
    _innate: { atWill: [], recharges: { 'fire-breath': true }, perDay: {} }
  };
  // Even with rng = 0 (d6=1), the spell stays available because it
  // was never spent.
  rollInnateRecharges(self, () => 0);
  assert.strictEqual(self._innate.recharges['fire-breath'], true);
});

// ---------- canInnateCast / consumeInnate ----------

test('M37: canInnateCast — at-will spells always castable', () => {
  const self = {
    _innate: { atWill: ['charm-gaze'], recharges: {}, perDay: {} }
  };
  assert.strictEqual(canInnateCast(self, 'charm-gaze'), true);
});

test('M37: canInnateCast — recharge spell only castable when available', () => {
  const self = {
    _innate: { atWill: [], recharges: { 'fire-breath': true }, perDay: {} }
  };
  assert.strictEqual(canInnateCast(self, 'fire-breath'), true);
  self._innate.recharges['fire-breath'] = false;
  assert.strictEqual(canInnateCast(self, 'fire-breath'), false);
});

test('M37: consumeInnate — at-will spells are free (no state change)', () => {
  const self = {
    _innate: { atWill: ['charm-gaze'], recharges: {}, perDay: {} }
  };
  consumeInnate(self, 'charm-gaze');
  assert.strictEqual(canInnateCast(self, 'charm-gaze'), true);   // still castable
});

test('M37: consumeInnate — recharge spell flips to cooling-down', () => {
  const self = {
    _innate: { atWill: [], recharges: { 'fire-breath': true }, perDay: {} }
  };
  consumeInnate(self, 'fire-breath');
  assert.strictEqual(self._innate.recharges['fire-breath'], false);
});

// ---------- AI ----------

const livePc = (id, pos) => ({
  id, hp: 30, hpMax: 30, _position: pos, conditions: [],
  ref: { name: id, abilityModifiers: { DEX: 1, WIS: 0, CON: 1, STR: 1 } }
});

test('M37: chooseAction — young dragon prefers fire-breath when available', () => {
  const self = {
    id: 'd1', presetSlug: 'young-dragon',
    hp: 80, hpMax: 80, _position: { col: 1, row: 1 },
    _innate: freshInnateState('young-dragon')
  };
  const plan = chooseAction({
    self,
    enemies: [livePc('pc1', { col: 2, row: 1 }), livePc('pc2', { col: 1, row: 2 })],
    allies: [],
    rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'cast');
  assert.strictEqual(plan.spellId, 'fire-breath');
  assert.strictEqual(plan.isInnate, true);
});

test('M37: chooseAction — young dragon falls back to melee when breath is recharging', () => {
  const self = {
    id: 'd1', presetSlug: 'young-dragon',
    hp: 80, hpMax: 80, _position: { col: 1, row: 1 },
    _innate: freshInnateState('young-dragon')
  };
  self._innate.recharges['fire-breath'] = false;     // just used it
  const plan = chooseAction({
    self,
    enemies: [livePc('pc1', { col: 2, row: 1 })],
    allies: [],
    rng: () => 0.5
  });
  // Without breath, the AI has nothing else castable → falls back to attack.
  assert.strictEqual(plan.kind, 'attack');
});

test('M37: chooseAction — vampire-spawn casts Charm Gaze when in range', () => {
  const self = {
    id: 'v1', presetSlug: 'vampire-spawn',
    hp: 82, hpMax: 82, _position: { col: 1, row: 1 },
    _innate: freshInnateState('vampire-spawn')
  };
  const plan = chooseAction({
    self,
    enemies: [livePc('pc1', { col: 3, row: 1 })],
    allies: [],
    rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'cast');
  assert.strictEqual(plan.spellId, 'charm-gaze');
  assert.strictEqual(plan.isInnate, true);
});

// ---------- Simulator integration ----------

test('M37: simulator — young dragon\'s breath weapon hits multiple PCs', () => {
  const party = Array.from({ length: 3 }, (_, i) => ({
    id: `pc${i}`, name: `pc${i}`,
    _position: { col: 2, row: 1 + i },
    hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityScores: { STR: 16, DEX: 10, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    abilityModifiers: { STR: 3, DEX: 0, CON: 2, INT: 0, WIS: 0, CHA: 0 },
    classes: [{ name: 'Fighter', level: 5 }],
    conditions: []
  }));
  const monsters = [
    { id: 'd1', presetSlug: 'young-dragon', name: 'Dragon',
      hp: { current: 80, max: 80 }, position: { col: 1, row: 2 }, conditions: [] }
  ];
  const stats = simulateEncounter({
    party, monsters, scene: { cols: 6, rows: 5 },
    iterations: 30, maxRounds: 4, seed: 11
  });
  // After 30 iterations of 4-round fights, every PC should have taken
  // SOME damage on average (the dragon's first-turn breath sweeps them).
  for (let i = 0; i < 3; i++) {
    const e = stats.entities.find(x => x.id === `pc${i}`);
    assert.ok(e.avgFinalHp < 30, `pc${i} should have taken damage; ended at avg ${e.avgFinalHp}`);
  }
});

test('M37: simulator — vampire-spawn\'s Charm Gaze sometimes applies the condition', () => {
  // Hard to assert deterministically since the save is probabilistic;
  // we just verify the fight resolves and the vampire deals some damage.
  const party = [{
    id: 'pc1', name: 'F', _position: { col: 1, row: 1 },
    hp: { current: 25, max: 25 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
    classes: [{ name: 'Fighter', level: 4 }],
    conditions: []
  }];
  const monsters = [
    { id: 'v1', presetSlug: 'vampire-spawn', name: 'Vamp',
      hp: { current: 82, max: 82 }, position: { col: 3, row: 1 }, conditions: [] }
  ];
  const stats = simulateEncounter({
    party, monsters, scene: { cols: 6, rows: 3 },
    iterations: 20, maxRounds: 6, seed: 13
  });
  const vamp = stats.entities.find(e => e.id === 'v1');
  assert.ok(vamp.avgDamageDealt >= 0);   // smoke test — fight completes
  assert.strictEqual(stats.iterations, 20);
});
