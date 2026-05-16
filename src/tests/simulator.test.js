import { test } from 'node:test';
import assert from 'node:assert';
import { simulateEncounter, seedRng } from '../js/scene/simulator.js';

// Fixtures
function pc({ id = 'p1', name = 'Saris', hpCurrent = 27, hpMax = 27, weapon = { name: 'Mace', damage: '1d6', damageType: 'Bludgeoning' }, pos = { col: 5, row: 5 } } = {}) {
  return {
    id, name,
    abilityModifiers: { STR: 3, DEX: 1, WIS: 3 },
    classes: [{ level: 3 }],
    equipment: { mainhand: weapon },
    hp: { current: hpCurrent, max: hpMax },
    conditions: [],
    savingThrowProficiencies: ['WIS'],
    _position: pos
  };
}

function monster({ id = 'g1', name = 'Goblin', slug = 'goblin', hpCurrent = 7, hpMax = 7, pos = { col: 6, row: 5 } } = {}) {
  return {
    id, name, presetSlug: slug,
    hp: { current: hpCurrent, max: hpMax },
    conditions: [],
    position: pos
  };
}

// ---------- seedRng ----------

test('M20: seedRng — same seed produces same sequence', () => {
  const a = seedRng(42);
  const b = seedRng(42);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(a(), b());
  }
});

test('M20: seedRng — values are in [0, 1)', () => {
  const r = seedRng(7);
  for (let i = 0; i < 50; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
  }
});

// ---------- Simulator: solo scenarios ----------

test('M20: simulateEncounter — 1 PC vs 1 weak goblin → PC wins almost all the time', () => {
  const stats = simulateEncounter({
    party: [pc()],
    monsters: [monster()],
    scene: { positions: {}, flankingEnabled: false, cols: 10, rows: 7 },
    iterations: 200,
    seed: 1
  });
  assert.strictEqual(stats.iterations, 200);
  assert.ok(stats.victoryRate > 0.85, `expected >85% wins, got ${stats.victoryRate}`);
  assert.ok(stats.avgRounds < 6, `should resolve fast; avg ${stats.avgRounds}`);
});

test('M20: simulateEncounter — overwhelming odds (1 PC vs 6 trolls) → PC loses', () => {
  const trolls = Array.from({ length: 6 }, (_, i) =>
    monster({ id: `t${i}`, name: `Troll ${i}`, slug: 'troll', hpCurrent: 84, hpMax: 84, pos: { col: 6 + i, row: 5 } })
  );
  const stats = simulateEncounter({
    party: [pc()],
    monsters: trolls,
    scene: { positions: {}, flankingEnabled: false, cols: 10, rows: 7 },
    iterations: 100,
    seed: 1
  });
  assert.ok(stats.victoryRate < 0.10, `expected <10% wins vs 6 trolls; got ${stats.victoryRate}`);
});

test('M20: simulateEncounter — deterministic with fixed seed', () => {
  const ctx = {
    party: [pc()],
    monsters: [monster()],
    scene: { positions: {}, flankingEnabled: false, cols: 10, rows: 7 },
    iterations: 50,
    seed: 99
  };
  const a = simulateEncounter(ctx);
  const b = simulateEncounter(ctx);
  assert.strictEqual(a.partyVictories, b.partyVictories);
  assert.strictEqual(a.monsterVictories, b.monsterVictories);
  assert.strictEqual(a.totalRounds, undefined);   // not in returned shape
  assert.strictEqual(a.avgRounds, b.avgRounds);
});

test('M20: simulateEncounter — entities array reports per-entity stats', () => {
  const stats = simulateEncounter({
    party: [pc(), pc({ id: 'p2', name: 'Adrin', pos: { col: 5, row: 6 } })],
    monsters: [monster(), monster({ id: 'g2', name: 'Goblin 2', pos: { col: 7, row: 5 } })],
    scene: { positions: {}, flankingEnabled: false, cols: 10, rows: 7 },
    iterations: 100,
    seed: 5
  });
  assert.strictEqual(stats.entities.length, 4);
  const saris = stats.entities.find(e => e.name === 'Saris');
  assert.ok(saris);
  assert.ok(saris.deathRate >= 0 && saris.deathRate <= 1);
  assert.ok(saris.avgDamageDealt > 0, 'Saris should deal SOME damage on average');
  assert.ok(saris.hpMax === 27);
});

test('M20: simulateEncounter — empty party → monster victory', () => {
  const stats = simulateEncounter({
    party: [],
    monsters: [monster()],
    scene: { positions: {}, cols: 10, rows: 7 },
    iterations: 10,
    seed: 1
  });
  assert.strictEqual(stats.partyVictories, 0);
});

test('M20: simulateEncounter — empty monsters → party victory at round 0', () => {
  const stats = simulateEncounter({
    party: [pc()],
    monsters: [],
    scene: { positions: {}, cols: 10, rows: 7 },
    iterations: 5,
    seed: 1
  });
  assert.strictEqual(stats.partyVictories, 5);
  assert.strictEqual(stats.avgRounds, 1);   // loop ticks one round but bails immediately
});

test('M20: simulateEncounter — round cap enforces a maximum', () => {
  // Two equally matched (both troll-sized) sides at far range — neither
  // can hit reliably; should hit the round cap.
  const stats = simulateEncounter({
    party: [pc({ hpCurrent: 200, hpMax: 200 })],
    monsters: [monster({ slug: 'troll', hpCurrent: 200, hpMax: 200, pos: { col: 9, row: 9 } })],
    scene: { positions: {}, cols: 10, rows: 10 },
    iterations: 20,
    maxRounds: 3,
    seed: 1
  });
  assert.ok(stats.avgRounds <= 3.01, `avgRounds should be capped at 3; got ${stats.avgRounds}`);
});
