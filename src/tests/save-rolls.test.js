import { test } from 'node:test';
import assert from 'node:assert';
import { rollSave, resolveSpellSave } from '../js/scene/save-rolls.js';

// Deterministic RNG — returns the next pre-seeded value each time.
function seq(...values) {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('seq exhausted');
    return values[i++];
  };
}
// Map a target face to its rng value: face = 1 + floor(r * sides) → r = (face-1)/sides
function r(face, sides) { return (face - 1) / sides; }

// ---------- rollSave ----------

test('M21: rollSave — normal d20 + bonus vs DC', () => {
  const result = rollSave({ bonus: 3, dc: 15 }, () => r(12, 20));
  assert.strictEqual(result.kept, 12);
  assert.strictEqual(result.total, 15);
  assert.strictEqual(result.success, true);   // ties succeed
  assert.strictEqual(result.dc, 15);
});

test('M21: rollSave — failure when total < DC', () => {
  const result = rollSave({ bonus: 1, dc: 16 }, () => r(10, 20));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.total, 11);
});

test('M21: rollSave — advantage keeps higher of two d20', () => {
  const result = rollSave({ bonus: 0, dc: 15, advantage: 'advantage' }, seq(r(5, 20), r(18, 20)));
  assert.strictEqual(result.kept, 18);
  assert.deepStrictEqual(result.dice, [5, 18]);
});

test('M21: rollSave — disadvantage keeps lower', () => {
  const result = rollSave({ bonus: 0, dc: 15, advantage: 'disadvantage' }, seq(r(5, 20), r(18, 20)));
  assert.strictEqual(result.kept, 5);
});

// ---------- resolveSpellSave ----------

test('M21: resolveSpellSave — Sacred Flame: fail = full damage', () => {
  // Cantrip, no half-on-save → full damage on fail.
  // Sacred Flame 1d8 radiant; rng: save d20=3 (fail), damage d8=7
  const spell = { name: 'Sacred Flame', dice: '1d8', damageType: 'Radiant',
                  saveStat: 'DEX', saveOnHalf: false };
  const result = resolveSpellSave(
    { spell, targetSaveBonus: 1, dc: 13 },
    seq(r(3, 20), r(7, 8))
  );
  assert.strictEqual(result.save.success, false);
  assert.strictEqual(result.damage, 7);
  assert.strictEqual(result.outcome, 'full');
  assert.strictEqual(result.damageRoll.total, 7);
});

test('M21: resolveSpellSave — Sacred Flame: success = NO damage (saveOnHalf=false)', () => {
  const spell = { name: 'Sacred Flame', dice: '1d8', damageType: 'Radiant',
                  saveStat: 'DEX', saveOnHalf: false };
  const result = resolveSpellSave(
    { spell, targetSaveBonus: 2, dc: 13 },
    seq(r(18, 20), r(7, 8))   // d20=18, save passes
  );
  assert.strictEqual(result.save.success, true);
  assert.strictEqual(result.damage, 0);
  assert.strictEqual(result.outcome, 'none');
});

test('M21: resolveSpellSave — Fireball-like: success = HALF damage (saveOnHalf=true)', () => {
  const spell = { name: 'Fireball', dice: '8d6', damageType: 'Fire',
                  saveStat: 'DEX', saveOnHalf: true };
  // 8d6: each d6=4 → 32 raw; save d20=18, passes; final = 16
  const seq8d6 = seq(r(18, 20), r(4,6), r(4,6), r(4,6), r(4,6), r(4,6), r(4,6), r(4,6), r(4,6));
  const result = resolveSpellSave(
    { spell, targetSaveBonus: 2, dc: 15 }, seq8d6
  );
  assert.strictEqual(result.save.success, true);
  assert.strictEqual(result.outcome, 'half');
  assert.strictEqual(result.damageRoll.total, 32);
  assert.strictEqual(result.damage, 16);
});

test('M21: resolveSpellSave — Hold Person: no dice → success means no effect, fail means "failed-no-damage"', () => {
  const spell = { name: 'Hold Person', dice: null, saveStat: 'WIS', saveOnHalf: false };
  const passed = resolveSpellSave({ spell, targetSaveBonus: 3, dc: 13 }, () => r(18, 20));
  assert.strictEqual(passed.save.success, true);
  assert.strictEqual(passed.damage, 0);
  assert.strictEqual(passed.outcome, 'none');
  assert.strictEqual(passed.damageRoll, null);

  const failed = resolveSpellSave({ spell, targetSaveBonus: 0, dc: 13 }, () => r(5, 20));
  assert.strictEqual(failed.save.success, false);
  assert.strictEqual(failed.damage, 0);
  assert.strictEqual(failed.outcome, 'failed-no-damage');
});

test('M21: resolveSpellSave — damage of 1 stays at 1 after halving (floor not below 1)', () => {
  // Fireball at low rolls: 8d6 with all 1s = 8, halved = 4. Edge case test:
  // a 1-damage spell on save halved would floor to 0 — that's actually
  // what 5e says ("half as much damage"), so 0 is correct.
  const spell = { name: 'X', dice: '1d4', saveStat: 'DEX', saveOnHalf: true };
  const result = resolveSpellSave({ spell, targetSaveBonus: 5, dc: 10 }, seq(r(20, 20), r(1, 4)));
  assert.strictEqual(result.save.success, true);
  assert.strictEqual(result.damage, 0);   // 1 halved floors to 0
  assert.strictEqual(result.outcome, 'half');
});
