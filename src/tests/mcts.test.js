import { test } from 'node:test';
import assert from 'node:assert';
import { mctsEvaluate, estimateBurnValue, shallowRolloutForResource } from '../js/scene/ai/mcts.js';
import { PC_FEATURES } from '../js/scene/ai/pc-features.js';

// ---------- estimateBurnValue (pure heuristic) ----------

test('M42.2: estimateBurnValue — kill window pays huge bonus', () => {
  // damageDelta meets/exceeds target HP → kill saves N*DPR pressure
  const killing = estimateBurnValue({
    damageDelta: 9, targetHp: 8, targetDpr: 5, roundsLeft: 3, resourceTax: 1
  });
  const nonkilling = estimateBurnValue({
    damageDelta: 5, targetHp: 80, targetDpr: 5, roundsLeft: 3, resourceTax: 1
  });
  assert.ok(killing > nonkilling, `killing=${killing} should beat non-killing=${nonkilling}`);
});

test('M42.2: estimateBurnValue — slot scarcity tax reduces value', () => {
  const cheap = estimateBurnValue({
    damageDelta: 9, targetHp: 30, targetDpr: 5, roundsLeft: 3, resourceTax: 0
  });
  const taxed = estimateBurnValue({
    damageDelta: 9, targetHp: 30, targetDpr: 5, roundsLeft: 3, resourceTax: 5
  });
  assert.ok(cheap > taxed, `untaxed (${cheap}) should outvalue taxed (${taxed})`);
});

// ---------- mctsEvaluate orchestration ----------

test('M42.2: mctsEvaluate — returns candidates sorted by total value', () => {
  const candidates = [
    { id: 'a', baseScore: 0.5 },
    { id: 'b', baseScore: 0.5 },
    { id: 'c', baseScore: 0.5 }
  ];
  // Rollout: 'b' is best (returns 10), 'a' middling (5), 'c' bad (0).
  const rollout = (c) => ({ a: 5, b: 10, c: 0 })[c.id];
  const ranked = mctsEvaluate({ candidates, rollout, rollouts: 1 });
  assert.strictEqual(ranked[0].id, 'b');
  assert.strictEqual(ranked[1].id, 'a');
  assert.strictEqual(ranked[2].id, 'c');
});

test('M42.2: mctsEvaluate — averages multiple rollouts per candidate', () => {
  const candidates = [{ id: 'x', baseScore: 0 }];
  let calls = 0;
  const rollout = () => ++calls;   // returns 1, 2, 3, 4 across rollouts
  const ranked = mctsEvaluate({ candidates, rollout, rollouts: 4 });
  // average of 1,2,3,4 = 2.5
  assert.strictEqual(ranked[0].mctsValue, 2.5);
});

test('M42.2: mctsEvaluate — returns empty when given no candidates', () => {
  assert.deepStrictEqual(mctsEvaluate({ candidates: [], rollout: () => 0 }), []);
});

// ---------- shallowRolloutForResource ----------

test('M42.2: shallowRolloutForResource — high slotPool → low tax → high value', () => {
  const ctx = {
    target: { hp: 20, attack: { dice: '1d8+3' } },
    roundsLeft: 3, slotPool: 5
  };
  const cand = { expectedExtraDamage: 9 };
  const v = shallowRolloutForResource({ candidate: cand, ctx });
  assert.ok(v > 0, `should be positive when burning isn't scarce: ${v}`);
});

test('M42.2: shallowRolloutForResource — last slot → high tax → lower value', () => {
  const ctx = {
    target: { hp: 50, attack: { dice: '1d8+3' } },
    roundsLeft: 3, slotPool: 1
  };
  const cand = { expectedExtraDamage: 9 };
  const vScarce = shallowRolloutForResource({ candidate: cand, ctx });
  const vPlenty = shallowRolloutForResource({
    candidate: cand,
    ctx: { ...ctx, slotPool: 5 }
  });
  assert.ok(vPlenty > vScarce,
    `plentiful slots should beat scarce; plenty=${vPlenty} scarce=${vScarce}`);
});

// ---------- Smite slot-level decision via MCTS ----------

test('M42.2: smite picks higher slot when target is tanky and slots plenty', () => {
  // 5 slots across 1st-3rd; target has lots of HP — burning a 3rd slot
  // (5d8 ≈ 22 dmg) should outscore 1st (2d8 ≈ 9) and 2nd (3d8 ≈ 13).
  const pc = {
    classes: [{ name: 'Paladin', level: 9 }],
    _slots: { 1: 4, 2: 3, 3: 2 },
    _mctsTargetCtx: { target: { hp: 80, attack: { dice: '2d8+4' } }, roundsLeft: 4 }
  };
  PC_FEATURES['divine-smite'].consume(pc);
  assert.ok(pc._smiteSlotUsed >= 2,
    `expected higher slot when target is tanky; got ${pc._smiteSlotUsed}`);
});

test('M42.2: smite picks lower slot when target is at low HP', () => {
  // Target almost dead — overkilling with a high slot is wasteful.
  const pc = {
    classes: [{ name: 'Paladin', level: 9 }],
    _slots: { 1: 4, 2: 3, 3: 2 },
    _mctsTargetCtx: { target: { hp: 5, attack: { dice: '2d8+4' } }, roundsLeft: 1 }
  };
  PC_FEATURES['divine-smite'].consume(pc);
  // Lowest slot is enough to kill; AI should choose 1st (or 2nd at most).
  assert.ok(pc._smiteSlotUsed <= 2,
    `expected low slot for low-HP target; got ${pc._smiteSlotUsed}`);
});

test('M42.2: smite falls back to lowest available slot when no MCTS ctx', () => {
  const pc = { _slots: { 1: 0, 2: 0, 3: 1 } };
  PC_FEATURES['divine-smite'].consume(pc);
  assert.strictEqual(pc._smiteSlotUsed, 3);
});
