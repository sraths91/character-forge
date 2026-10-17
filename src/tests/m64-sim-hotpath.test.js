// M64 round 4 — simulator hot-path guards.
//
// The 200×4v4 bench went from ~27 ms (Wave 1) to ~50 ms (round 3). Most
// of it was one `delete attacker._mctsTargetCtx` per turn: deleting a
// property drops the wrapper into V8 dictionary mode, so every later
// property read on it (the whole AI planner) took the slow path. The
// rest was allocation in the condition helpers (run for every creature
// after every turn) and re-parsing the same dice specs. These tests pin
// the fixes deterministically, so they don't depend on wall-clock time.

import { test } from 'node:test';
import assert from 'node:assert';
import v8 from 'node:v8';
import { simulateEncounter, seedRng } from '../js/scene/simulator.js';
import { parseDiceExpr, rollDamage } from '../js/scene/combat-roll.js';
import { conditionIds, hasCondition, isIncapacitatedBy } from '../js/scene/conditions.js';

v8.setFlagsFromString('--allow-natives-syntax');
const hasFastProperties = new Function('o', 'return %HasFastProperties(o)');

function pc(id, col, cls) {
  return {
    id, name: id, _position: { col, row: 1 }, hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 16, WIS: 14, CHA: 14 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 3, WIS: 2, CHA: 2 },
    classes: [{ name: cls, level: 5 }], conditions: [],
    spells: [{ name: 'Shield' }, { name: 'Magic Missile' }, { name: 'Cure Wounds' }]
  };
}

test('M64 r4: AI-planned PC wrappers keep fast properties and a JSON-pure _mctsTargetCtx', async () => {
  let seen = null;
  await simulateEncounter({
    party: [pc('f', 1, 'Fighter'), pc('w', 2, 'Wizard'), pc('p', 3, 'Paladin')],
    monsters: ['goblin', 'orc'].map((slug, i) => ({
      id: 'm' + i, presetSlug: slug, name: slug, hp: { current: 40, max: 40 },
      position: { col: 1 + i, row: 4 }, conditions: []
    })),
    scene: { cols: 10, rows: 8 }, iterations: 1, maxRounds: 4, seed: 3,
    onIterationEnd: (it) => { seen = it; }
  });
  for (const w of seen.pcs) {
    assert.ok(w._lastPlan, `${w.id} never planned a turn`);
    assert.strictEqual(w._mctsTargetCtx, null, `${w.id}: planner context outlived the turn`);
    assert.strictEqual(hasFastProperties(w), true, `${w.id}: wrapper fell into dictionary mode`);
  }
});

test('M64 r4: parseDiceExpr still returns a fresh object; the roll cache is not poisoned by callers', () => {
  const a = parseDiceExpr('2d6+3');
  a.terms[0].count = 99;
  a.mod = 1000;
  assert.notStrictEqual(parseDiceExpr('2d6+3'), a);
  assert.deepStrictEqual(parseDiceExpr('2d6+3'), { terms: [{ count: 2, sides: 6, sign: 1 }], mod: 3 });
  const r1 = rollDamage('2d6+3', { crit: true }, seedRng(9));
  const r2 = rollDamage('2d6+3', { crit: true }, seedRng(9));
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(r1.rolls.length, 4);
  assert.strictEqual(r1.mod, 3);
  assert.strictEqual(rollDamage('nonsense', {}, seedRng(1)).total, 0);
});

test('M64 r4: condition helpers read mixed string/object lists without sharing arrays', () => {
  const e = { conditions: ['poisoned', { id: 'stunned', sourceId: 'x' }, null, { id: '' }] };
  const ids = conditionIds(e);
  assert.deepStrictEqual(ids, ['poisoned', 'stunned']);
  assert.notStrictEqual(conditionIds(e), ids);
  assert.strictEqual(hasCondition(e, 'stunned'), true);
  assert.strictEqual(hasCondition(e, ''), false);
  assert.strictEqual(hasCondition(e, 'prone'), false);
  assert.strictEqual(isIncapacitatedBy(e), true);
  assert.strictEqual(isIncapacitatedBy({ conditions: ['poisoned', { id: 'prone' }] }), false);
  assert.strictEqual(isIncapacitatedBy({}), false);
  assert.deepStrictEqual(conditionIds(null), []);
});
