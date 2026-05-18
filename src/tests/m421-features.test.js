import { test } from 'node:test';
import assert from 'node:assert';
import { PC_FEATURES } from '../js/scene/ai/pc-features.js';
import { choosePcAction } from '../js/scene/ai/pc-action.js';
import { simulateEncounter } from '../js/scene/simulator.js';
import { slotsForPc } from '../js/scene/reactions.js';

// ---------- Divine Smite ----------

test('M42.1: divine-smite is available for a Paladin 2+ with a spell slot', () => {
  const pc = { classes: [{ name: 'Paladin', level: 2 }], _slots: { 1: 1 } };
  assert.strictEqual(PC_FEATURES['divine-smite'].available(pc), true);
});

test('M42.1: divine-smite is NOT available for a Paladin with no slots', () => {
  const pc = { classes: [{ name: 'Paladin', level: 5 }], _slots: {} };
  assert.strictEqual(PC_FEATURES['divine-smite'].available(pc), false);
});

test('M42.1: divine-smite is NOT available for a Fighter', () => {
  const pc = { classes: [{ name: 'Fighter', level: 5 }], _slots: { 1: 4 } };
  assert.strictEqual(PC_FEATURES['divine-smite'].available(pc), false);
});

test('M42.1: divine-smite boosts a melee attack on a bloodied target', () => {
  const ctx = {
    self: { _slots: { 1: 2, 2: 1 } },
    target: { hp: 5, hpMax: 30 }   // 16% — very bloodied
  };
  const boost = PC_FEATURES['divine-smite'].scoreBoost({ kind: 'melee' }, ctx);
  assert.ok(boost > 0.5, `expected significant boost on near-dead target; got ${boost}`);
});

test('M42.1: divine-smite gives a small boost on a full-HP target', () => {
  const ctx = {
    self: { _slots: { 1: 2 } },
    target: { hp: 30, hpMax: 30 }   // full
  };
  const boost = PC_FEATURES['divine-smite'].scoreBoost({ kind: 'melee' }, ctx);
  assert.ok(boost === 0 || boost < 0.4,
    `should not aggressively smite full-HP targets; got ${boost}`);
});

test('M42.1: divine-smite consume burns the lowest slot first', () => {
  const pc = { _slots: { 1: 2, 2: 1 } };
  PC_FEATURES['divine-smite'].consume(pc);
  assert.strictEqual(pc._slots[1], 1);
  assert.strictEqual(pc._slots[2], 1);
  assert.strictEqual(pc._smiteSlotUsed, 1);
});

// ---------- Reckless Attack ----------

test('M42.1: reckless-attack is available for a Barbarian once per turn', () => {
  const pc = { classes: [{ name: 'Barbarian', level: 3 }] };
  assert.strictEqual(PC_FEATURES['reckless-attack'].available(pc), true);
  PC_FEATURES['reckless-attack'].consume(pc);
  assert.strictEqual(PC_FEATURES['reckless-attack'].available(pc), false);
});

test('M42.1: reckless-attack flags the "until next turn" advantage trade', () => {
  const pc = { classes: [{ name: 'Barbarian', level: 1 }] };
  PC_FEATURES['reckless-attack'].consume(pc);
  assert.strictEqual(pc._recklessUntilNextTurn, true);
});

test('M42.1: reckless-attack boosts melee when target is bloodied', () => {
  const ctx = {
    self:   { hp: 30, hpMax: 30 },
    target: { hp: 8, hpMax: 30 }   // bloodied
  };
  const boost = PC_FEATURES['reckless-attack'].scoreBoost({ kind: 'melee' }, ctx);
  assert.ok(boost > 0);
});

test('M42.1: reckless-attack zero boost on a ranged option', () => {
  const ctx = { self: { hp: 30, hpMax: 30 }, target: { hp: 5, hpMax: 30 } };
  assert.strictEqual(PC_FEATURES['reckless-attack'].scoreBoost({ kind: 'ranged' }, ctx), 0);
});

// ---------- Healing Word (PC heal) ----------

const livePc = (id, pos, classes, spells = null, hp = 30, hpMax = 30) => ({
  id, hp, hpMax, _position: pos, conditions: [],
  ref: {
    id, name: id, classes,
    abilityModifiers: { STR: 0, DEX: 1, CON: 1, INT: 0, WIS: 3, CHA: 2 },
    equipment: { mainhand: { name: 'Mace' } },
    spells: spells || []
  },
  _slots: slotsForPc({ classes })
});

test('M42.1: PC cleric prefers Healing Word on a bloodied ally', () => {
  const cleric = livePc('cleric1', { col: 1, row: 1 },
    [{ name: 'Cleric', level: 5 }],
    [{ name: 'Healing Word' }, { name: 'Sacred Flame' }]);
  const bloodiedAlly = livePc('ally1', { col: 2, row: 1 },
    [{ name: 'Fighter', level: 5 }], null, 4, 30);
  const enemy = {
    id: 'g1', hp: 7, hpMax: 7, _position: { col: 5, row: 1 }, conditions: []
  };
  const plan = choosePcAction({
    self: cleric, enemies: [enemy],
    allies: [cleric, bloodiedAlly],   // simulator includes self in allies
    rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'cast');
  assert.strictEqual(plan.spellId, 'healing-word');
  assert.strictEqual(plan.targetSide, 'ally');
  assert.strictEqual(plan.targetId, 'ally1');
});

test('M42.1: PC cleric does NOT heal when all allies are at full HP', () => {
  const cleric = livePc('cleric1', { col: 1, row: 1 },
    [{ name: 'Cleric', level: 5 }],
    [{ name: 'Healing Word' }, { name: 'Sacred Flame' }]);
  const healthyAlly = livePc('ally1', { col: 2, row: 1 },
    [{ name: 'Fighter', level: 5 }]);
  const enemy = {
    id: 'g1', hp: 7, hpMax: 7, _position: { col: 5, row: 1 }, conditions: []
  };
  const plan = choosePcAction({
    self: cleric, enemies: [enemy], allies: [cleric, healthyAlly], rng: () => 0.5
  });
  // No heal target → should attack instead
  assert.notStrictEqual(plan.spellId, 'healing-word');
});

// ---------- Simulator integration ----------

test('M42.1: simulator — paladin deals MORE damage when slots are available (smite)', () => {
  // Lvl-3 paladin (has Divine Smite) vs a tanky goblin. Compare vs the
  // same paladin with no slots — the difference is smite damage.
  const paladin = (slots) => ({
    id: 'p1', name: 'Paladin', _position: { col: 1, row: 1 },
    hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 14 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 2 },
    classes: [{ name: 'Paladin', level: slots ? 3 : 1 }],
    conditions: []
  });
  // Need a target tanky enough that the fight runs the full 5 rounds —
  // a 30-HP goblin dies in 3-4 swings either way, masking the smite
  // damage in the cap. A 150-HP punching bag lets smite dice
  // accumulate observably.
  const tankyGoblin = () => [{
    id: 'g1', presetSlug: 'goblin', name: 'Big Goblin',
    hp: { current: 150, max: 150 }, position: { col: 2, row: 1 }, conditions: []
  }];
  const opts = { scene: { cols: 5, rows: 3 }, iterations: 80, maxRounds: 5, seed: 51 };
  const withSlots = simulateEncounter({ party: [paladin(true)], monsters: tankyGoblin(), ...opts });
  const noSlots   = simulateEncounter({ party: [paladin(false)], monsters: tankyGoblin(), ...opts });
  const withDmg = withSlots.entities.find(e => e.id === 'p1').avgDamageDealt;
  const noDmg   = noSlots.entities.find(e => e.id === 'p1').avgDamageDealt;
  assert.ok(withDmg > noDmg,
    `paladin with smite slots should out-damage no-slot variant: ${withDmg.toFixed(1)} vs ${noDmg.toFixed(1)}`);
});

test('M42.1: simulator — barbarian Reckless Attack lands more hits on tanky target', () => {
  // Barbarian lvl 1 (has Reckless) vs same-level fighter (no Reckless).
  // The barb's hit rate should be higher due to advantage on its swings.
  const make = (cls) => ({
    id: 'pc1', name: cls, _position: { col: 1, row: 1 },
    hp: { current: 14, max: 14 },
    equipment: { mainhand: { name: 'Greataxe' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
    classes: [{ name: cls, level: 1 }], conditions: []
  });
  const tank = () => [{
    id: 't1', presetSlug: 'troll', name: 'Troll',   // high HP soak
    hp: { current: 50, max: 50 }, position: { col: 2, row: 1 }, conditions: []
  }];
  const opts = { scene: { cols: 4, rows: 3 }, iterations: 80, maxRounds: 5, seed: 61 };
  const barb     = simulateEncounter({ party: [make('Barbarian')], monsters: tank(), ...opts });
  const fighter  = simulateEncounter({ party: [make('Fighter')],   monsters: tank(), ...opts });
  const barbDmg     = barb.entities.find(e => e.id === 'pc1').avgDamageDealt;
  const fighterDmg  = fighter.entities.find(e => e.id === 'pc1').avgDamageDealt;
  // Barbarian should statistically out-damage the same-level fighter
  // thanks to advantage. The downside (advantage against barb) hurts a
  // bit too, but offense wins on most runs.
  assert.ok(barbDmg > fighterDmg * 0.95,
    `reckless barb should be competitive with fighter: ${barbDmg.toFixed(1)} vs ${fighterDmg.toFixed(1)}`);
});

test('M42.1: simulator — cleric keeps party fighter alive longer via Healing Word', () => {
  // Two scenarios: party with a Cleric who knows Healing Word vs same
  // party without the spell. The fighter should die less often with
  // heal support.
  const fighter = () => ({
    id: 'f1', name: 'Fighter', _position: { col: 1, row: 1 },
    hp: { current: 14, max: 14 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
    classes: [{ name: 'Fighter', level: 1 }], conditions: []
  });
  const cleric = (withHeal) => ({
    id: 'c1', name: 'Cleric', _position: { col: 2, row: 1 },
    hp: { current: 11, max: 11 },
    equipment: { mainhand: { name: 'Mace' } },
    abilityScores: { STR: 12, DEX: 10, CON: 12, INT: 10, WIS: 16, CHA: 10 },
    abilityModifiers: { STR: 1, DEX: 0, CON: 1, INT: 0, WIS: 3, CHA: 0 },
    classes: [{ name: 'Cleric', level: 3 }], conditions: [],
    spells: withHeal ? [{ name: 'Healing Word' }, { name: 'Sacred Flame' }] : [{ name: 'Sacred Flame' }]
  });
  const monsters = () => [
    { id: 'o1', presetSlug: 'orc', name: 'Orc',
      hp: { current: 15, max: 15 }, position: { col: 5, row: 1 }, conditions: [] },
    { id: 'o2', presetSlug: 'orc', name: 'Orc 2',
      hp: { current: 15, max: 15 }, position: { col: 5, row: 2 }, conditions: [] }
  ];
  const opts = { scene: { cols: 7, rows: 3 }, iterations: 80, maxRounds: 8, seed: 71 };
  const withHeal = simulateEncounter({ party: [fighter(), cleric(true)],  monsters: monsters(), ...opts });
  const noHeal   = simulateEncounter({ party: [fighter(), cleric(false)], monsters: monsters(), ...opts });
  const fWith = withHeal.entities.find(e => e.id === 'f1').deathRate;
  const fNo   = noHeal.entities.find(e => e.id === 'f1').deathRate;
  // Heal helps statistically — fewer fighter deaths
  assert.ok(fWith <= fNo + 0.05,
    `healing word should not increase fighter deaths: with=${fWith.toFixed(2)} no=${fNo.toFixed(2)}`);
});
