import { test } from 'node:test';
import assert from 'node:assert';
import { resolveAttack, chebyshevFeet, isRangedWeapon } from '../js/scene/combat-resolver.js';

// Minimal entities for resolver tests. PCs use the abilityModifiers shape
// deriveWeaponAttack expects; monster instances use the simpler shape with
// position. The resolver pulls attackStats from ctx when supplied, so we
// pre-bake them rather than rely on the PC pipeline for every test.

function pcAt({ id = 'pc1', conditions = [], pos = null }) {
  return {
    id, name: 'Hero',
    abilityModifiers: { STR: 3, DEX: 2 },
    classes: [{ level: 5 }],
    equipment: { mainhand: { name: 'Longsword', damage: '1d8' } },
    conditions,
    _position: pos
  };
}

function monsterAt({ id = 'm1', conditions = [], pos = { col: 5, row: 5 } }) {
  return { id, name: 'Goblin', position: pos, conditions };
}

const ATTACK_STATS = {
  bonus: 6, dice: '1d8+3', damageType: 'Slashing',
  parts: [{ source: 'Longsword', value: 6 }],
  damageParts: []
};

const SCENE = { positions: {}, cols: 10, rows: 7, cellSize: 64, scale: 3 };

function baseCtx(over = {}) {
  return {
    attacker: pcAt({ pos: { col: 5, row: 5 } }),
    target: monsterAt({ pos: { col: 5, row: 5 } }),
    weapon: { name: 'Longsword', damage: '1d8' },
    scene: SCENE,
    attackerKind: 'pc',
    targetKind: 'monster',
    targetAC: 15,
    advantageOverride: 'auto',
    attackStats: ATTACK_STATS,
    ...over
  };
}

// ---------- chebyshevFeet ----------

test('M11: chebyshevFeet — adjacent cells = 5ft', () => {
  assert.strictEqual(chebyshevFeet({ col: 0, row: 0 }, { col: 1, row: 0 }), 5);
  assert.strictEqual(chebyshevFeet({ col: 0, row: 0 }, { col: 1, row: 1 }), 5);
  assert.strictEqual(chebyshevFeet({ col: 0, row: 0 }, { col: 0, row: 0 }), 0);
  assert.strictEqual(chebyshevFeet({ col: 0, row: 0 }, { col: 3, row: 1 }), 15);
});

// ---------- isRangedWeapon ----------

test('M11: isRangedWeapon — names like "longbow" / "crossbow" detect as ranged', () => {
  assert.strictEqual(isRangedWeapon({ name: 'Longbow' }), true);
  assert.strictEqual(isRangedWeapon({ name: 'Heavy Crossbow' }), true);
  assert.strictEqual(isRangedWeapon({ name: 'Longsword' }), false);
});

test('M11: isRangedWeapon — explicit ranged property wins over name', () => {
  assert.strictEqual(
    isRangedWeapon({ name: 'Mystery', properties: [{ name: 'Ranged' }] }),
    true);
});

// ---------- Baseline: no conditions ----------

test('M13: baseline (no conditions) → normal d20, no blockers, no autoCrit', () => {
  const r = resolveAttack(baseCtx());
  assert.strictEqual(r.d20.mode, 'normal');
  assert.deepStrictEqual(r.d20.advantage, []);
  assert.deepStrictEqual(r.d20.disadvantage, []);
  assert.strictEqual(r.autoCrit, false);
  assert.strictEqual(r.autoMiss, false);
  assert.deepStrictEqual(r.blockers, []);
  assert.strictEqual(r.attackBonus.total, 6);
  assert.strictEqual(r.damage.dice, '1d8+3');
});

// ---------- Single-condition rules ----------

test('M13: poisoned attacker → disadvantage', () => {
  const r = resolveAttack(baseCtx({ attacker: pcAt({ conditions: ['poisoned'], pos: { col: 5, row: 5 } }) }));
  assert.strictEqual(r.d20.mode, 'disadvantage');
  assert.ok(r.d20.disadvantage.some(s => /poisoned/i.test(s)));
});

test('M13: blinded attacker → disadvantage', () => {
  const r = resolveAttack(baseCtx({ attacker: pcAt({ conditions: ['blinded'], pos: { col: 5, row: 5 } }) }));
  assert.strictEqual(r.d20.mode, 'disadvantage');
});

test('M13: invisible attacker → advantage', () => {
  const r = resolveAttack(baseCtx({ attacker: pcAt({ conditions: ['invisible'], pos: { col: 5, row: 5 } }) }));
  assert.strictEqual(r.d20.mode, 'advantage');
});

test('M13: blinded target → advantage on attacks against', () => {
  const r = resolveAttack(baseCtx({ target: monsterAt({ conditions: ['blinded'] }) }));
  assert.strictEqual(r.d20.mode, 'advantage');
});

test('M13: invisible target → disadvantage on attacks against', () => {
  const r = resolveAttack(baseCtx({ target: monsterAt({ conditions: ['invisible'] }) }));
  assert.strictEqual(r.d20.mode, 'disadvantage');
});

test('M13: prone target with melee weapon → advantage', () => {
  const r = resolveAttack(baseCtx({ target: monsterAt({ conditions: ['prone'] }) }));
  assert.strictEqual(r.d20.mode, 'advantage');
  assert.ok(r.d20.advantage.some(s => /melee/i.test(s)));
});

test('M13: prone target with ranged weapon → disadvantage', () => {
  const r = resolveAttack(baseCtx({
    target: monsterAt({ conditions: ['prone'] }),
    weapon: { name: 'Longbow' },
    attackStats: { ...ATTACK_STATS, parts: [{ source: 'Longbow', value: 6 }] }
  }));
  assert.strictEqual(r.d20.mode, 'disadvantage');
  assert.ok(r.d20.disadvantage.some(s => /ranged/i.test(s)));
});

test('M13: restrained attacker → disadvantage; restrained target → advantage', () => {
  const r1 = resolveAttack(baseCtx({ attacker: pcAt({ conditions: ['restrained'], pos: { col: 5, row: 5 } }) }));
  assert.strictEqual(r1.d20.mode, 'disadvantage');
  const r2 = resolveAttack(baseCtx({ target: monsterAt({ conditions: ['restrained'] }) }));
  assert.strictEqual(r2.d20.mode, 'advantage');
});

// ---------- Canceling rule ----------

test('M13: advantage + disadvantage → normal (5e canceling rule)', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ conditions: ['poisoned'], pos: { col: 5, row: 5 } }),    // disadv
    target:   monsterAt({ conditions: ['blinded'] })                          // adv
  }));
  assert.strictEqual(r.d20.mode, 'normal');
  // But the reasons are still listed so the UI can show them
  assert.strictEqual(r.d20.advantage.length, 1);
  assert.strictEqual(r.d20.disadvantage.length, 1);
});

test('M13: two advantages still = advantage (no double-count)', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ conditions: ['invisible'], pos: { col: 5, row: 5 } }),
    target:   monsterAt({ conditions: ['blinded'] })
  }));
  assert.strictEqual(r.d20.mode, 'advantage');
});

// ---------- Auto-crit ----------

test('M13: paralyzed target + melee within 5ft → autoCrit', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 5, row: 5 } }),
    target:   monsterAt({ conditions: ['paralyzed'], pos: { col: 5, row: 5 } })  // same cell ⇒ 0ft
  }));
  assert.strictEqual(r.autoCrit, true);
  assert.ok(/paralyzed/.test(r.autoCritReason));
});

test('M13: unconscious target + melee adjacent → autoCrit', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 5, row: 5 } }),
    target:   monsterAt({ conditions: ['unconscious'], pos: { col: 6, row: 5 } })   // 5ft
  }));
  assert.strictEqual(r.autoCrit, true);
});

test('M13: paralyzed target at 10ft → no autoCrit (only adv)', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 5, row: 5 } }),
    target:   monsterAt({ conditions: ['paralyzed'], pos: { col: 7, row: 5 } })
  }));
  assert.strictEqual(r.autoCrit, false);
  assert.strictEqual(r.d20.mode, 'advantage');   // target still grants adv
});

test('M13: paralyzed target attacked by ranged within 5ft → no autoCrit', () => {
  const r = resolveAttack(baseCtx({
    weapon: { name: 'Longbow' },
    attackStats: { ...ATTACK_STATS, parts: [{ source: 'Longbow', value: 6 }] },
    target: monsterAt({ conditions: ['paralyzed'], pos: { col: 5, row: 5 } })
  }));
  assert.strictEqual(r.autoCrit, false);
});

// ---------- Blockers ----------

test('M13: paralyzed attacker → autoMiss + blocker reason', () => {
  const r = resolveAttack(baseCtx({ attacker: pcAt({ conditions: ['paralyzed'], pos: { col: 5, row: 5 } }) }));
  assert.strictEqual(r.autoMiss, true);
  assert.ok(r.blockers.some(s => /paralyzed/i.test(s)));
});

test('M13: stunned attacker → autoMiss', () => {
  const r = resolveAttack(baseCtx({ attacker: pcAt({ conditions: ['stunned'], pos: { col: 5, row: 5 } }) }));
  assert.strictEqual(r.autoMiss, true);
});

test('M13: charmed attacker → autoMiss (conservative — refuses all attacks)', () => {
  const r = resolveAttack(baseCtx({ attacker: pcAt({ conditions: ['charmed'], pos: { col: 5, row: 5 } }) }));
  assert.strictEqual(r.autoMiss, true);
  assert.ok(r.blockers.some(s => /charmed/i.test(s)));
});

// ---------- Override path ----------

test('M16: override "advantage" wins over resolver verdict', () => {
  const r = resolveAttack(baseCtx({
    advantageOverride: 'advantage',
    attacker: pcAt({ conditions: ['poisoned'], pos: { col: 5, row: 5 } })   // resolver would say disadv
  }));
  assert.strictEqual(r.d20.mode, 'advantage');
  assert.strictEqual(r.d20.overrideApplied, true);
  assert.strictEqual(r.d20.resolvedMode, 'disadvantage');   // history preserved
});

test('M16: override "normal" wins over a single source of advantage', () => {
  const r = resolveAttack(baseCtx({
    advantageOverride: 'normal',
    target: monsterAt({ conditions: ['prone'] })   // resolver would say adv (melee)
  }));
  assert.strictEqual(r.d20.mode, 'normal');
  assert.strictEqual(r.d20.overrideApplied, true);
});

test('M16: override "auto" passes through resolver decision (default behavior)', () => {
  const r = resolveAttack(baseCtx({
    advantageOverride: 'auto',
    target: monsterAt({ conditions: ['prone'] })
  }));
  assert.strictEqual(r.d20.mode, 'advantage');
  assert.strictEqual(r.d20.overrideApplied, false);
});
