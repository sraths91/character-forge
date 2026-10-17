// M64 T1 — the simulator awaits the async combat engine.
//
// Before T1, simulator.js called `runOneAttack` without `await`. Any turn
// that provoked an opportunity attack suspended on `await
// runReactionAttack(...)`, so the mover's move, the triggerer's reaction
// spend and the mover's attack all ran in a microtask AFTER the
// iteration had already been scored. These tests pin the fixed contract:
// once `await simulateEncounter(...)` resolves, every turn has fully
// resolved and nothing changes on a later tick.

import { test } from 'node:test';
import assert from 'node:assert';
import { simulateEncounter } from '../js/scene/simulator.js';

function fighter(id, col, hp, extra = {}) {
  return {
    id, name: id,
    abilityModifiers: { STR: 3, DEX: 1 },
    classes: [{ name: 'Fighter', level: 1 }],
    equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
    hp: { current: hp, max: 200 },
    conditions: [],
    _position: { col, row: 1 },
    ...extra
  };
}

// Goblin at col 0 is adjacent to fighter A (col 1). B (col 5) is
// paralyzed and nearly dead, so the goblin's AI targets B: it must leave
// A's reach, provoking A's opportunity attack, then move and attack B.
function oaScenario() {
  return {
    party: [fighter('A', 1, 200), fighter('B', 5, 3, { conditions: ['paralyzed'] })],
    monsters: [{
      id: 'gob', name: 'Goblin', presetSlug: 'goblin',
      hp: { current: 500, max: 500 }, conditions: [], position: { col: 0, row: 1 }
    }],
    scene: { cols: 10, rows: 5 },
    iterations: 1,
    maxRounds: 1
  };
}

const snapshot = ({ pcs, mons }) => JSON.stringify({
  gob: { pos: mons[0].position, dealt: mons[0].damageDealt, hp: mons[0].hp, plan: mons[0]._lastPlan?.targetId },
  A: { reactionUsed: pcs[0]._reactionUsed, dealt: pcs[0].damageDealt },
  B: { hp: pcs[1].hp }
});

test('M64 T1: OA golden — after await simulateEncounter the mover has moved + attacked, triggerer reaction spent', async () => {
  for (const seed of [1, 2, 3, 4]) {
    let live = null;
    let atReturn = null;
    const stats = await simulateEncounter({
      ...oaScenario(), seed,
      onIterationEnd: (it) => { live = it; atReturn = snapshot(it); }
    });
    const { pcs, mons } = live;
    const gob = mons[0];
    const [A, B] = pcs;
    assert.strictEqual(gob._lastPlan?.targetId, 'B', `seed ${seed}: goblin should target B`);
    // Moved: left col 0 (A's reach) to stand next to B.
    assert.notStrictEqual(gob.position.col, 0, `seed ${seed}: goblin never moved`);
    assert.ok(Math.abs(gob.position.col - B._position.col) <= 1, `seed ${seed}: goblin not adjacent to B`);
    // Triggerer's reaction spent by the OA.
    assert.strictEqual(A._reactionUsed, true, `seed ${seed}: A's reaction not spent`);
    // Attacked: B (3 HP, paralyzed → auto-crit in reach) went down.
    assert.ok(gob.damageDealt > 0, `seed ${seed}: goblin never attacked`);
    assert.strictEqual(B.hp, 0, `seed ${seed}: B should be down`);
    // ...and the SCORED stats saw all of it.
    const byId = Object.fromEntries(stats.entities.map(e => [e.id, e]));
    assert.strictEqual(byId.B.deathRate, 1, `seed ${seed}: scored B death missing`);
    assert.ok(byId.gob.avgDamageDealt > 0, `seed ${seed}: scored goblin damage missing`);
    // Nothing is still in flight: state is identical a macrotask later.
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(snapshot(live), atReturn, `seed ${seed}: state changed after return`);
  }
});

test('M64 T1: simulateEncounter returns a Promise', () => {
  const p = simulateEncounter({ iterations: 1 });
  assert.ok(p && typeof p.then === 'function');
  return p;
});

test('M64 T1: 200 iterations of a 4v4 fight stay fast (budget 100 ms; asserted < 1000 ms)', async () => {
  const mk = (id, col, cls) => ({
    id, name: id, _position: { col, row: 1 }, hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 16, WIS: 14, CHA: 14 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 3, WIS: 2, CHA: 2 },
    classes: [{ name: cls, level: 5 }], conditions: [],
    spells: [{ name: 'Shield' }, { name: 'Magic Missile' }, { name: 'Fireball' }, { name: 'Cure Wounds' }]
  });
  const party = [mk('f', 1, 'Fighter'), mk('w', 2, 'Wizard'), mk('c', 3, 'Cleric'), mk('r', 4, 'Rogue')];
  const monsters = ['goblin', 'bandit', 'kobold', 'orc'].map((slug, i) => ({
    id: 'm' + i, presetSlug: slug, name: slug, hp: { current: 20, max: 20 },
    position: { col: 1 + i, row: 4 }, conditions: []
  }));
  const args = { party, monsters, scene: { cols: 10, rows: 8 }, iterations: 200, maxRounds: 12, seed: 1 };
  await simulateEncounter({ ...args, iterations: 20 }); // warm the JIT
  const t0 = performance.now();
  const stats = await simulateEncounter(args);
  const ms = performance.now() - t0;
  assert.strictEqual(stats.iterations, 200);
  // The plan's budget is 100 ms on a dev laptop; the assertion is
  // generous so a loaded CI runner doesn't flake. A regression to
  // pathological (e.g. per-turn setTimeout) scheduling would blow it.
  // Measured 2026-10-16 (M64 round 4, idle M-series Mac, isolation):
  // ~32 ms (Wave 1: ~27 ms; round 3 before the hot-path fix: ~50 ms).
  // Readings of 700+ ms came from a throttled / heavily loaded machine,
  // not the code; m64-sim-hotpath.test.js pins the fix deterministically.
  assert.ok(ms < 1000, `200×4v4 took ${ms.toFixed(1)} ms`);
});
