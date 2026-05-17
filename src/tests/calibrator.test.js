import { test } from 'node:test';
import assert from 'node:assert';
import { calibrateEncounter, ratedDifficulty } from '../js/scene/calibrator.js';

// ---------- ratedDifficulty (pure, no simulation) ----------

const pc = (level, id = `p${level}`) => ({
  id, name: id, classes: [{ name: 'Fighter', level }],
  hp: { current: 10 * level, max: 10 * level },
  _position: { col: 1, row: 1 },
  abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
  equipment: { mainhand: { name: 'Longsword' } },
  conditions: []
});
const monster = (slug, id, pos = { col: 5, row: 1 }) => ({
  id, presetSlug: slug, name: id,
  hp: { current: 7, max: 7 }, position: pos, conditions: []
});

test('M35.1: ratedDifficulty — single goblin vs lvl-5 party = easy', () => {
  const out = ratedDifficulty({
    party: [pc(5, 'p1'), pc(5, 'p2'), pc(5, 'p3'), pc(5, 'p4')],
    monsters: [monster('goblin', 'g1')]
  });
  // Goblin XP=50, mult=1 (single monster, 4 PCs) → encounter XP 50.
  // Party (4 × lvl 5): easy threshold = 4*250 = 1000. 50 < 1000.
  assert.strictEqual(out.label, 'trivial');
  assert.strictEqual(out.encounterXp, 50);
});

test('M35.1: ratedDifficulty — 4 hobgoblins vs lvl-3 party = medium-ish', () => {
  const out = ratedDifficulty({
    party: [pc(3, 'p1'), pc(3, 'p2'), pc(3, 'p3'), pc(3, 'p4')],
    monsters: [
      monster('hobgoblin', 'h1'), monster('hobgoblin', 'h2'),
      monster('hobgoblin', 'h3'), monster('hobgoblin', 'h4')
    ]
  });
  // Hobgoblin XP=100, 4 monsters → mult=2, encounter = 800.
  // Party (4 × lvl 3): easy=300, medium=600, hard=900, deadly=1600.
  // 800 falls between medium (600) and hard (900) → label = medium.
  assert.strictEqual(out.label, 'medium');
  assert.strictEqual(out.encounterXp, 800);
});

test('M35.1: ratedDifficulty — vampire spawn vs 2 lvl-3 PCs = deadly', () => {
  const out = ratedDifficulty({
    party: [pc(3, 'p1'), pc(3, 'p2')],
    monsters: [monster('vampire-spawn', 'v1')]
  });
  // Vampire spawn XP=1800. 2 PCs → small-party adjustment: 1 monster
  // base mult = 1, bumped UP one row to 1.5 → encounter XP = 2700.
  // Party (2 × lvl 3): deadly = 2*400 = 800. 2700 > 800 → deadly.
  assert.strictEqual(out.label, 'deadly');
});

test('M35.1: ratedDifficulty — empty inputs return trivial', () => {
  assert.strictEqual(ratedDifficulty({}).label, 'trivial');
  assert.strictEqual(ratedDifficulty({ party: [pc(1)], monsters: [] }).label, 'trivial');
});

test('M35.1: encounter multiplier scales with monster count', () => {
  const party = [pc(5, 'p1'), pc(5, 'p2'), pc(5, 'p3'), pc(5, 'p4')];
  // 1 monster: mult=1; 3 monsters: mult=2; 7 monsters: mult=2.5.
  // Each goblin = 50 XP.
  assert.strictEqual(ratedDifficulty({ party, monsters: [monster('goblin', 'g1')] }).encounterXp, 50);
  assert.strictEqual(ratedDifficulty({ party, monsters: [
    monster('goblin', 'g1'), monster('goblin', 'g2'), monster('goblin', 'g3')
  ] }).encounterXp, 300);
  assert.strictEqual(ratedDifficulty({ party, monsters: Array.from({length: 7},
    (_, i) => monster('goblin', `g${i}`)) }).encounterXp, 875);
});

// ---------- calibrateEncounter (composes simulator) ----------

test('M35.0: calibrateEncounter — runs the simulator and aggregates a report', () => {
  const report = calibrateEncounter({
    party: [pc(5, 'fighter')],
    monsters: [monster('goblin', 'g1')],
    scene: { cols: 10, rows: 7 },
    iterations: 40, seed: 1
  });
  assert.strictEqual(report.iterations, 40);
  // Win rate should be very high for lvl-5 vs single goblin
  assert.ok(report.winRate > 0.8, `expected > 80% win, got ${report.winRate}`);
  assert.strictEqual(typeof report.avgRounds, 'number');
  assert.ok(report.lethality >= 0 && report.lethality <= 1);
  assert.strictEqual(report.partySize, 1);
  assert.strictEqual(report.monsterCount, 1);
});

test('M35.0: calibrateEncounter — exposes MVP based on avg damage dealt', () => {
  const report = calibrateEncounter({
    party: [pc(5, 'fighter')],
    monsters: [monster('goblin', 'g1')],
    iterations: 30, seed: 2
  });
  assert.ok(report.mvp);
  assert.ok(report.mvp.avgDamageDealt >= 0);
});

test('M35.0: calibrateEncounter — bestKilled flags the most-downed PC', () => {
  const report = calibrateEncounter({
    party: [pc(1, 'squishy')],
    monsters: [
      monster('troll', 't1'),
      monster('troll', 't2'),
      monster('troll', 't3')
    ],
    iterations: 30, seed: 3
  });
  assert.ok(report.bestKilled);
  assert.strictEqual(report.bestKilled.id, 'squishy');
  assert.ok(report.bestKilled.deathRate > 0.5,
    `expected lvl-1 vs 3 trolls to die often, got ${report.bestKilled.deathRate}`);
});

test('M35.0: calibrateEncounter — empty monsters list gives 100% win rate', () => {
  const report = calibrateEncounter({
    party: [pc(3, 'p1')], monsters: [],
    iterations: 10, seed: 4
  });
  assert.strictEqual(report.winRate, 1);
  assert.strictEqual(report.deathToll, 0);
});

test('M35.0: calibrateEncounter — empty party gives 0% win rate', () => {
  const report = calibrateEncounter({
    party: [], monsters: [monster('goblin', 'g1')],
    iterations: 10, seed: 5
  });
  assert.strictEqual(report.winRate, 0);
});

test('M35.0: calibrateEncounter — report includes the DMG difficulty label', () => {
  const report = calibrateEncounter({
    party: [pc(3, 'p1'), pc(3, 'p2')],
    monsters: [monster('vampire-spawn', 'v1')],
    iterations: 20, seed: 6
  });
  assert.strictEqual(report.difficulty.label, 'deadly');
  assert.ok(report.difficulty.encounterXp > 0);
});

test('M35.0: calibrateEncounter — lethality is 0 for a one-sided win', () => {
  // Lvl-10 fighter vs single goblin: should rarely take meaningful dmg.
  const report = calibrateEncounter({
    party: [pc(10, 'tank')],
    monsters: [monster('goblin', 'g1')],
    iterations: 30, seed: 7
  });
  assert.ok(report.lethality < 0.2,
    `expected near-zero lethality, got ${report.lethality}`);
});
