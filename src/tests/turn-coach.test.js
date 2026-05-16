import { test } from 'node:test';
import assert from 'node:assert';
import { buildTurnTips } from '../js/scene/turn-coach.js';

function rogueAt({ pos = { col: 5, row: 5 }, conditions = [] } = {}) {
  return {
    id: 'r1', name: 'Lyra',
    abilityModifiers: { STR: 0, DEX: 4 },
    classes: [{ level: 5 }],
    classFeatures: [{ name: 'Sneak Attack', source: 'Rogue', dice: '3d6' }],
    equipment: { mainhand: { name: 'Shortsword', damage: '1d6' } },
    conditions, _position: pos
  };
}

function clericAt({ pos = { col: 5, row: 5 }, conditions = [] } = {}) {
  return {
    id: 'c1', name: 'Saris',
    abilityModifiers: { STR: 1, WIS: 3 },
    classes: [{ level: 3 }],
    classFeatures: [
      { name: 'Eyes of Night', source: 'Twilight Domain', uses: { max: 1, reset: 'long rest' } },
      { name: 'Channel Divinity', source: 'Cleric', uses: { max: 1, reset: 'short rest' } }
    ],
    equipment: { mainhand: { name: 'Mace', damage: '1d6' } },
    conditions, _position: pos
  };
}

function monsterAt({ id = 'm1', name = 'Goblin', pos = { col: 7, row: 5 }, conditions = [] } = {}) {
  return { id, name, position: pos, conditions };
}

const SCENE_FLANK = { positions: {}, flankingEnabled: true };
const SCENE_NOFLANK = { positions: {}, flankingEnabled: false };

// ---------- Warning tips for adverse conditions ----------

test('M22: poisoned attacker → warning tip', () => {
  const tips = buildTurnTips({
    entity: rogueAt({ conditions: ['poisoned'] }), kind: 'pc',
    scene: SCENE_NOFLANK, party: [], monsters: []
  });
  const w = tips.find(t => /poisoned/i.test(t.text));
  assert.ok(w);
  assert.strictEqual(w.kind, 'warning');
  assert.ok(w.priority >= 90);
});

test('M22: invisible attacker → boon tip', () => {
  const tips = buildTurnTips({
    entity: rogueAt({ conditions: ['invisible'] }), kind: 'pc',
    scene: SCENE_NOFLANK, party: [], monsters: []
  });
  assert.ok(tips.some(t => /invisible/i.test(t.text) && t.kind === 'boon'));
});

// ---------- Sneak Attack opportunity ----------

test('M22: Sneak Attack opportunity surfaces when an ally is adjacent to target', () => {
  const rogue = rogueAt({ pos: { col: 5, row: 5 } });
  const ally  = clericAt({ pos: { col: 6, row: 5 } });
  const target = monsterAt({ pos: { col: 7, row: 5 } });   // 5ft from ally
  const tips = buildTurnTips({
    entity: rogue, kind: 'pc',
    scene: SCENE_NOFLANK,
    party: [rogue, ally], monsters: [target]
  });
  const sa = tips.find(t => /Sneak Attack/.test(t.text));
  assert.ok(sa);
  assert.match(sa.text, /Goblin/);
  assert.match(sa.text, /Shortsword/);
  assert.strictEqual(sa.kind, 'feature');
});

test('M22: no Sneak Attack opportunity when no ally adjacent and no advantage', () => {
  const rogue = rogueAt({ pos: { col: 5, row: 5 } });
  const target = monsterAt({ pos: { col: 7, row: 5 } });
  const tips = buildTurnTips({
    entity: rogue, kind: 'pc',
    scene: SCENE_NOFLANK,
    party: [rogue], monsters: [target]
  });
  assert.ok(!tips.some(t => /Sneak Attack/.test(t.text)));
});

// ---------- Flanking opportunity ----------

test('M22: Flanking opportunity (scene toggle on)', () => {
  const rogue = rogueAt({ pos: { col: 6, row: 5 } });
  const ally  = clericAt({ pos: { col: 8, row: 5 } });
  const target = monsterAt({ pos: { col: 7, row: 5 } });
  const tips = buildTurnTips({
    entity: rogue, kind: 'pc',
    scene: SCENE_FLANK,
    party: [rogue, ally], monsters: [target]
  });
  const f = tips.find(t => /Flanking/.test(t.text));
  assert.ok(f);
  assert.match(f.text, /Saris/);   // ally name
});

test('M22: Flanking opportunity hidden when toggle off', () => {
  const rogue = rogueAt({ pos: { col: 6, row: 5 } });
  const ally  = clericAt({ pos: { col: 8, row: 5 } });
  const target = monsterAt({ pos: { col: 7, row: 5 } });
  const tips = buildTurnTips({
    entity: rogue, kind: 'pc',
    scene: SCENE_NOFLANK,
    party: [rogue, ally], monsters: [target]
  });
  assert.ok(!tips.some(t => /Flanking/.test(t.text)));
});

// ---------- Help action ----------

test('M22: Help action tip when ally is adjacent', () => {
  const cleric = clericAt({ pos: { col: 5, row: 5 } });
  const ally  = rogueAt({ pos: { col: 6, row: 5 } });
  const tips = buildTurnTips({
    entity: cleric, kind: 'pc',
    scene: SCENE_NOFLANK,
    party: [cleric, ally], monsters: []
  });
  assert.ok(tips.some(t => /Help/.test(t.text) && /Lyra/.test(t.text)));
});

test('M22: Help action tip absent when no ally nearby', () => {
  const cleric = clericAt({ pos: { col: 5, row: 5 } });
  const far    = rogueAt({ pos: { col: 0, row: 0 } });
  const tips = buildTurnTips({
    entity: cleric, kind: 'pc',
    scene: SCENE_NOFLANK,
    party: [cleric, far], monsters: []
  });
  assert.ok(!tips.some(t => /Help/.test(t.text)));
});

// ---------- Limited-use reminders ----------

test('M22: limited-use features surface as reminder tips', () => {
  const tips = buildTurnTips({
    entity: clericAt(), kind: 'pc',
    scene: SCENE_NOFLANK,
    party: [], monsters: []
  });
  assert.ok(tips.some(t => /Eyes of Night/.test(t.text) && t.kind === 'limited-use'));
  assert.ok(tips.some(t => /Channel Divinity/.test(t.text) && t.kind === 'limited-use'));
});

// ---------- Capping + dedup ----------

test('M22: dedup identical tips and cap at max', () => {
  // Two goblins both eligible for Sneak Attack with the same weapon
  // should produce per-target tips (we DO want one per target),
  // but identical "Help" tips for multiple adjacent allies dedup to one.
  const cleric = clericAt({ pos: { col: 5, row: 5 } });
  const ally1  = rogueAt({ id: 'r1', pos: { col: 6, row: 5 } });
  const ally2  = rogueAt({ id: 'r2', pos: { col: 4, row: 5 } });
  const tips = buildTurnTips({
    entity: cleric, kind: 'pc',
    scene: SCENE_NOFLANK,
    party: [cleric, ally1, ally2], monsters: [],
    max: 3
  });
  const helpTips = tips.filter(t => /Help/.test(t.text));
  assert.strictEqual(helpTips.length, 1);   // dedup
  assert.ok(tips.length <= 3);
});

test('M22: no tips for solo entity with no conditions and no allies', () => {
  const tips = buildTurnTips({
    entity: rogueAt(), kind: 'pc',
    scene: SCENE_NOFLANK,
    party: [], monsters: []
  });
  assert.deepStrictEqual(tips, []);
});
