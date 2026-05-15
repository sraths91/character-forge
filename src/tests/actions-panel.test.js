import { test } from 'node:test';
import assert from 'node:assert';
import { buildActionsFor, rangedNormalFt } from '../js/scene/actions-panel.js';

function pcAt({
  id = 'p1', name = 'Saris',
  pos = { col: 5, row: 5 }, conditions = [],
  equipment = { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
  carried = [],
  classFeatures = []
} = {}) {
  return {
    id, name,
    abilityModifiers: { STR: 3, DEX: 1 },
    classes: [{ level: 3 }],
    equipment, carried, classFeatures, conditions,
    _position: pos
  };
}

function monsterAt({ id = 'm1', name = 'Goblin', pos = { col: 6, row: 5 }, conditions = [] } = {}) {
  return { id, name, position: pos, conditions };
}

const SCENE = { positions: {} };

// ---------- rangedNormalFt ----------

test('M17: rangedNormalFt — Longbow = 150 ft', () => {
  assert.strictEqual(rangedNormalFt({ name: 'Longbow' }), 150);
});

test('M17: rangedNormalFt — Shortbow = 80 ft', () => {
  assert.strictEqual(rangedNormalFt({ name: 'Shortbow' }), 80);
});

test('M17: rangedNormalFt — explicit weapon.range.normal wins', () => {
  assert.strictEqual(rangedNormalFt({ name: 'Mystery', range: { normal: 220 } }), 220);
});

test('M17: rangedNormalFt — unknown weapon falls back to 80', () => {
  assert.strictEqual(rangedNormalFt({ name: 'Custom Ranged Thing' }), 80);
});

// ---------- buildActionsFor: attacks ----------

test('M17: attacks list — melee weapon with adjacent target is available', () => {
  const r = buildActionsFor({
    entity: pcAt(), kind: 'pc',
    scene: SCENE,
    party: [],
    monsters: [monsterAt({ pos: { col: 6, row: 5 } })]
  });
  const sword = r.attacks.find(a => /longsword/i.test(a.name));
  assert.ok(sword);
  assert.strictEqual(sword.available, true);
  assert.strictEqual(sword.targetsInRange.length, 1);
});

test('M17: attacks list — melee weapon with no targets in reach is unavailable', () => {
  const r = buildActionsFor({
    entity: pcAt(), kind: 'pc',
    scene: SCENE,
    party: [],
    monsters: [monsterAt({ pos: { col: 9, row: 9 } })]   // far away
  });
  const sword = r.attacks.find(a => /longsword/i.test(a.name));
  assert.strictEqual(sword.available, false);
  assert.match(sword.blockReason, /No targets in reach/);
});

test('M17: attacks list — ranged weapon shows targets within normal range', () => {
  const ranged = pcAt({
    equipment: { mainhand: { name: 'Shortbow', damage: '1d6', damageType: 'Piercing' } }
  });
  const r = buildActionsFor({
    entity: ranged, kind: 'pc',
    scene: SCENE,
    party: [],
    monsters: [
      monsterAt({ pos: { col: 9, row: 9 } }),   // ~28 ft — within 80 ft
      monsterAt({ id: 'm2', name: 'Far Orc', pos: { col: 9, row: 5 } })
    ]
  });
  const bow = r.attacks.find(a => /shortbow/i.test(a.name));
  assert.strictEqual(bow.available, true);
  assert.strictEqual(bow.targetsInRange.length, 2);
  assert.strictEqual(bow.isRanged, true);
});

test('M17: attacks list — Sneak Attack hint surfaces in attack row when a rogue', () => {
  const rogue = pcAt({
    name: 'Lyra',
    equipment: { mainhand: { name: 'Shortsword', damage: '1d6', damageType: 'Piercing' } },
    classFeatures: [{ name: 'Sneak Attack', source: 'Rogue', dice: '2d6' }]
  });
  const ally = pcAt({ id: 'p2', name: 'Adrin', pos: { col: 7, row: 5 } });
  const r = buildActionsFor({
    entity: rogue, kind: 'pc',
    scene: SCENE,
    party: [rogue, ally],
    monsters: [monsterAt({ pos: { col: 6, row: 5 } })]
  });
  const ss = r.attacks.find(a => /shortsword/i.test(a.name));
  assert.ok(ss.hints.some(h => /Sneak Attack: 2d6/.test(h)),
    `hints did not include Sneak Attack: ${JSON.stringify(ss.hints)}`);
});

// ---------- buildActionsFor: features ----------

test('M17: features list — surfaces dice-bearing class features only', () => {
  const ch = pcAt({
    classFeatures: [
      { name: 'Channel Divinity', source: 'Cleric', uses: { max: 1, reset: 'short rest' } },
      { name: 'Spellcasting',     source: 'Cleric' },     // passive, no dice/uses
      { name: 'Sneak Attack',     source: 'Rogue', dice: '2d6' }
    ]
  });
  const r = buildActionsFor({
    entity: ch, kind: 'pc',
    scene: SCENE, party: [], monsters: []
  });
  const names = r.features.map(f => f.name).sort();
  assert.deepStrictEqual(names, ['Channel Divinity', 'Sneak Attack']);
});

test('M17: features list — empty when entity has no class features', () => {
  const r = buildActionsFor({
    entity: pcAt(), kind: 'pc', scene: SCENE, party: [], monsters: []
  });
  assert.deepStrictEqual(r.features, []);
});

// ---------- buildActionsFor: common actions ----------

test('M17: common actions — Dash unavailable when grappled (speed 0)', () => {
  const r = buildActionsFor({
    entity: pcAt({ conditions: ['grappled'] }), kind: 'pc',
    scene: SCENE, party: [], monsters: []
  });
  const dash = r.common.find(c => c.name === 'Dash');
  assert.strictEqual(dash.available, false);
  assert.match(dash.blockReason, /Speed 0/);
});

test('M17: common actions — Hide unavailable when blinded', () => {
  const r = buildActionsFor({
    entity: pcAt({ conditions: ['blinded'] }), kind: 'pc',
    scene: SCENE, party: [], monsters: []
  });
  assert.strictEqual(r.common.find(c => c.name === 'Hide').available, false);
  assert.strictEqual(r.common.find(c => c.name === 'Search').available, false);
});

test('M17: common actions — Help unavailable with no ally within 5ft', () => {
  const ally = pcAt({ id: 'p2', name: 'Adrin', pos: { col: 0, row: 0 } });   // far
  const r = buildActionsFor({
    entity: pcAt(), kind: 'pc',
    scene: SCENE, party: [pcAt(), ally], monsters: []
  });
  const help = r.common.find(c => c.name === 'Help');
  assert.strictEqual(help.available, false);
});

test('M17: common actions — Help available when ally is adjacent', () => {
  const ally = pcAt({ id: 'p2', name: 'Adrin', pos: { col: 6, row: 5 } });
  const r = buildActionsFor({
    entity: pcAt(), kind: 'pc',
    scene: SCENE, party: [pcAt(), ally], monsters: []
  });
  assert.strictEqual(r.common.find(c => c.name === 'Help').available, true);
});

test('M17: common actions — Prone notes half movement but Dash stays available', () => {
  const r = buildActionsFor({
    entity: pcAt({ conditions: ['prone'] }), kind: 'pc',
    scene: SCENE, party: [], monsters: []
  });
  const dash = r.common.find(c => c.name === 'Dash');
  assert.strictEqual(dash.available, true);
  assert.match(dash.blockReason, /half movement/i);
});

// ---------- buildActionsFor: entity-wide blockers ----------

test('M17: blockers — incapacitated entity blocks everything', () => {
  const r = buildActionsFor({
    entity: pcAt({ conditions: ['stunned'] }), kind: 'pc',
    scene: SCENE, party: [],
    monsters: [monsterAt({ pos: { col: 6, row: 5 } })]
  });
  assert.ok(r.blockers.some(b => /stunned/i.test(b)));
  // All attacks + common actions get marked unavailable
  assert.ok(r.attacks.every(a => !a.available));
  assert.ok(r.common.every(c => !c.available));
});
