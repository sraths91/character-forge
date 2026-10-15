/**
 * M64 R1 — multi-term dice; crits double every die (PHB p196).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { parseDiceExpr, rollDamage, rollDice } from '../js/scene/combat-roll.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

test('R1: parseDiceExpr parses multi-term expressions', () => {
  assert.deepStrictEqual(parseDiceExpr('1d8+3+3d6'), {
    terms: [{ count: 1, sides: 8, sign: 1 }, { count: 3, sides: 6, sign: 1 }], mod: 3
  });
  assert.deepStrictEqual(parseDiceExpr(' 2d6 - 1d4 + 2 '), {
    terms: [{ count: 2, sides: 6, sign: 1 }, { count: 1, sides: 4, sign: -1 }], mod: 2
  });
  assert.deepStrictEqual(parseDiceExpr('d20'), { terms: [{ count: 1, sides: 20, sign: 1 }], mod: 0 });
  assert.strictEqual(parseDiceExpr('3'), null, 'no dice term');
  assert.strictEqual(parseDiceExpr('1d8++3'), null);
  assert.strictEqual(parseDiceExpr('1d1'), null);
  assert.strictEqual(parseDiceExpr(null), null);
});

test('R1: rollDamage("1d8+3+3d6") always lands in [7, 29]', () => {
  const rng = createRng({ s: 7 });
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 2000; i++) {
    const r = rollDamage('1d8+3+3d6', {}, rng);
    assert.strictEqual(r.rolls.length, 4);
    lo = Math.min(lo, r.total); hi = Math.max(hi, r.total);
  }
  assert.ok(lo >= 7 && hi <= 29, `range ${lo}..${hi}`);
});

test('R1: a crit doubles the dice of every term, not the flat mod', () => {
  const always1 = () => 0;           // every die shows 1
  const r = rollDamage('1d8+3+3d6', { crit: true }, always1);
  assert.strictEqual(r.rolls.length, 8, '2×1d8 + 2×3d6');
  assert.strictEqual(r.total, 8 + 3);
  const max = () => 0.999999;
  assert.strictEqual(rollDamage('1d8+3+3d6', { crit: true }, max).total, 16 + 36 + 3);
});

test('R1: single-term specs consume the rng exactly as before', () => {
  const a = createRng({ s: 11 }); const b = createRng({ s: 11 });
  const r1 = rollDice('2d6+2', a);
  const faces = [1 + Math.floor(b() * 6), 1 + Math.floor(b() * 6)];
  assert.deepStrictEqual(r1.rolls, faces);
  assert.strictEqual(a(), b(), 'stream aligned afterwards');
});

function rogue() {
  return buildPc({
    ref: {
      name: 'Rogue', classes: [{ name: 'Rogue', level: 5 }],
      equipment: { mainhand: { name: 'Rapier' } },
      abilityModifiers: { STR: 0, DEX: 4, CON: 1, INT: 0, WIS: 0, CHA: 0 }
    },
    weapon: { name: 'Rapier' }, _position: { col: 1, row: 1 }
  });
}

test('R1: a Rogue 5 Sneak Attack hit deals more than the plain hit (same rng)', async () => {
  const scene = buildScene();
  const run = async (featuresFired) => {
    const pc = rogue();
    const m = buildMonster({ hp: 200, hpMax: 200, ac: 5, position: { col: 2, row: 1 } });
    const plan = { kind: 'melee', targetId: m.id, weapon: pc.weapon, featuresFired };
    await runOneAttack(pc, [m], [pc], scene, createRng({ s: 3 }), { forcePlan: plan });
    return 200 - m.hp;
  };
  const plain = await run([]);
  const sneak = await run(['sneak-attack']);
  assert.ok(plain > 0, 'plain hit lands');
  assert.ok(sneak > plain, `sneak ${sneak} > plain ${plain}`);
  assert.ok(sneak - plain >= 3, '3d6 adds at least 3');
});
