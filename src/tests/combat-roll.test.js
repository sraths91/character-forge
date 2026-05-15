import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseDice, rollDice, rollD20, rollAttack, rollDamage, describeAttack
} from '../js/scene/combat-roll.js';

// Deterministic RNG: returns the next pre-seeded value each time it's
// called. Each value must be in [0, 1) just like Math.random.
function seq(...values) {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('seq exhausted');
    return values[i++];
  };
}

// Helper: choose an rng value that maps to a specific die face.
// For a d20, face = 1 + floor(r * 20), so r = (face - 1) / 20 lands
// at the start of that face's slot.
function r(face, sides) { return (face - 1) / sides; }

test('M6: parseDice handles common forms', () => {
  assert.deepStrictEqual(parseDice('1d8+3'),    { count: 1, sides: 8, mod: 3 });
  assert.deepStrictEqual(parseDice('2d6'),      { count: 2, sides: 6, mod: 0 });
  assert.deepStrictEqual(parseDice('d20'),      { count: 1, sides: 20, mod: 0 });
  assert.deepStrictEqual(parseDice('3d4-1'),    { count: 3, sides: 4, mod: -1 });
  assert.deepStrictEqual(parseDice(' 1d12 + 4'),{ count: 1, sides: 12, mod: 4 });
});

test('M6: parseDice rejects bogus input', () => {
  assert.strictEqual(parseDice(''), null);
  assert.strictEqual(parseDice('hello'), null);
  assert.strictEqual(parseDice('1d1'), null);     // sides must be >= 2
  assert.strictEqual(parseDice(null), null);
});

test('M6: rollDice sums dice and adds modifier', () => {
  // 2d6+2 with rolls 3, 5 → total 10
  const rng = seq(r(3, 6), r(5, 6));
  const result = rollDice('2d6+2', rng);
  assert.strictEqual(result.total, 10);
  assert.deepStrictEqual(result.rolls, [3, 5]);
  assert.strictEqual(result.mod, 2);
});

test('M6: rollD20 normal returns one die', () => {
  const result = rollD20('normal', () => r(14, 20));
  assert.strictEqual(result.kept, 14);
  assert.deepStrictEqual(result.dice, [14]);
});

test('M6: rollD20 advantage keeps the higher', () => {
  const result = rollD20('advantage', seq(r(5, 20), r(17, 20)));
  assert.strictEqual(result.kept, 17);
  assert.deepStrictEqual(result.dice, [5, 17]);
});

test('M6: rollD20 disadvantage keeps the lower', () => {
  const result = rollD20('disadvantage', seq(r(5, 20), r(17, 20)));
  assert.strictEqual(result.kept, 5);
  assert.deepStrictEqual(result.dice, [5, 17]);
});

test('M6: rollAttack — hit when total meets AC', () => {
  // d20=14 +5 = 19 vs AC 18 → hit, no crit
  const atk = rollAttack({ bonus: 5, advantage: 'normal', targetAC: 18 }, () => r(14, 20));
  assert.strictEqual(atk.hit, true);
  assert.strictEqual(atk.crit, false);
  assert.strictEqual(atk.total, 19);
});

test('M6: rollAttack — miss when total is below AC', () => {
  // d20=8 +2 = 10 vs AC 16 → miss
  const atk = rollAttack({ bonus: 2, advantage: 'normal', targetAC: 16 }, () => r(8, 20));
  assert.strictEqual(atk.hit, false);
  assert.strictEqual(atk.crit, false);
});

test('M6: rollAttack — nat 20 always hits and crits', () => {
  // d20=20 vs AC 99 → hit + crit
  const atk = rollAttack({ bonus: 0, advantage: 'normal', targetAC: 99 }, () => r(20, 20));
  assert.strictEqual(atk.hit, true);
  assert.strictEqual(atk.crit, true);
});

test('M6: rollAttack — nat 1 always misses', () => {
  // d20=1 +99 vs AC 1 → miss
  const atk = rollAttack({ bonus: 99, advantage: 'normal', targetAC: 1 }, () => r(1, 20));
  assert.strictEqual(atk.hit, false);
  assert.strictEqual(atk.crit, false);
});

test('M6: rollDamage — normal hit, dice + mod', () => {
  // 1d8+3 with roll 6 → total 9
  const dmg = rollDamage('1d8+3', { crit: false }, () => r(6, 8));
  assert.strictEqual(dmg.total, 9);
  assert.deepStrictEqual(dmg.rolls, [6]);
});

test('M6: rollDamage — crit doubles dice but NOT modifier', () => {
  // 1d8+3 crit → roll twice: 6, 4 → 10 + 3 = 13 (NOT 13×2)
  const dmg = rollDamage('1d8+3', { crit: true }, seq(r(6, 8), r(4, 8)));
  assert.strictEqual(dmg.rolls.length, 2);
  assert.strictEqual(dmg.total, 6 + 4 + 3);
});

test('M6: rollDamage — floors at 1 even with big negative mod', () => {
  // 1d4-10 → roll 2, sum -8, floored to 1
  const dmg = rollDamage('1d4-10', { crit: false }, () => r(2, 4));
  assert.strictEqual(dmg.total, 1);
});

test('M6: describeAttack — hit produces a one-line breakdown', () => {
  const atk = { hit: true, crit: false, d20: { kept: 18, dice: [18], advantage: 'normal' }, bonus: 5, total: 23, ac: 15 };
  const dmg = { total: 7, rolls: [4], mod: 3, spec: '1d8+3', crit: false };
  const s = describeAttack({ attackerName: 'Fighter', targetName: 'Goblin', weaponName: 'Longsword', atk, dmg });
  assert.match(s, /Fighter attacks Goblin/);
  assert.match(s, /HIT/);
  assert.match(s, /Longsword/);
  assert.match(s, /= 7/);
});

test('M6: describeAttack — miss says MISS', () => {
  const atk = { hit: false, crit: false, d20: { kept: 4, dice: [4], advantage: 'normal' }, bonus: 2, total: 6, ac: 15 };
  const dmg = { total: 0, rolls: [], spec: '1d8+3' };
  const s = describeAttack({ attackerName: 'Goblin', targetName: 'Fighter', weaponName: 'Scimitar', atk, dmg });
  assert.match(s, /MISS/);
});

test('M6: describeAttack — crit highlights CRIT', () => {
  const atk = { hit: true, crit: true, d20: { kept: 20, dice: [20], advantage: 'normal' }, bonus: 5, total: 25, ac: 12 };
  const dmg = { total: 18, rolls: [7, 8], mod: 3, spec: '1d8+3', crit: true };
  const s = describeAttack({ attackerName: 'Bard', targetName: 'Lich', weaponName: 'Rapier', atk, dmg });
  assert.match(s, /CRIT/);
});
