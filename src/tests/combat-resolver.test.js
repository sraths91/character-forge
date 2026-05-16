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

// ---- M12: combatMods consumption ----

test('M12: weapon-melee attack picks up melee-scoped attack mods', () => {
  const attacker = pcAt({ pos: { col: 5, row: 5 } });
  attacker.combatMods = [
    { source: 'Belt of Battle',  kind: 'attack', scope: 'weapon-melee', value: 2, inactive: false }
  ];
  const r = resolveAttack(baseCtx({ attacker }));
  assert.strictEqual(r.attackBonus.total, 6 + 2);
  assert.ok(r.attackBonus.parts.some(p => p.source === 'Belt of Battle' && p.value === 2));
});

test('M12: weapon-ranged attack does NOT pick up melee-scoped mods', () => {
  const attacker = pcAt({ pos: { col: 5, row: 5 } });
  attacker.combatMods = [
    { source: 'Brutal Critical', kind: 'attack', scope: 'weapon-melee', value: 2, inactive: false }
  ];
  const r = resolveAttack(baseCtx({
    attacker,
    weapon: { name: 'Longbow' },
    attackStats: { bonus: 6, dice: '1d8+3', damageType: 'Piercing',
      parts: [{ source: 'Longbow', value: 6 }], damageParts: [] }
  }));
  assert.strictEqual(r.attackBonus.total, 6, 'melee-scoped mod must not apply to ranged attack');
});

test('M12: weapon-all scope applies to BOTH melee and ranged', () => {
  const attackerMelee  = pcAt({ pos: { col: 5, row: 5 } });
  const attackerRanged = pcAt({ pos: { col: 5, row: 5 } });
  const universalMod = { source: 'Bardic Inspiration', kind: 'attack', scope: 'weapon-all', value: 1, inactive: false };
  attackerMelee.combatMods  = [universalMod];
  attackerRanged.combatMods = [universalMod];
  const rMelee = resolveAttack(baseCtx({ attacker: attackerMelee }));
  const rRanged = resolveAttack(baseCtx({
    attacker: attackerRanged,
    weapon: { name: 'Longbow' },
    attackStats: { bonus: 6, dice: '1d8+3', damageType: 'Piercing',
      parts: [{ source: 'Longbow', value: 6 }], damageParts: [] }
  }));
  assert.strictEqual(rMelee.attackBonus.total, 7);
  assert.strictEqual(rRanged.attackBonus.total, 7);
});

test('M12: spell-scoped attack mod does NOT apply to weapon attacks', () => {
  // Saris's case: Amulet of the Devout +1 grants spell-attacks, not weapon
  const attacker = pcAt({ pos: { col: 5, row: 5 } });
  attacker.combatMods = [
    { source: 'Amulet of the Devout, +1', kind: 'attack', scope: 'spell', value: 1, inactive: false }
  ];
  const r = resolveAttack(baseCtx({ attacker }));
  assert.strictEqual(r.attackBonus.total, 6,
    "spell-scoped mod must NOT apply to weapon attack (Amulet doesn't help your Longsword)");
});

test('M12: inactive mods (unattuned items) are skipped entirely', () => {
  const attacker = pcAt({ pos: { col: 5, row: 5 } });
  attacker.combatMods = [
    { source: 'Sword of Sharpness', kind: 'attack', scope: 'weapon-all', value: 3, inactive: true }
  ];
  const r = resolveAttack(baseCtx({ attacker }));
  assert.strictEqual(r.attackBonus.total, 6, 'inactive mod must not contribute');
  assert.ok(!r.attackBonus.parts.some(p => p.source === 'Sword of Sharpness'),
    'inactive mod must not appear in parts');
});

test('M12: damage mods extend the dice string with the new flat modifier', () => {
  // Base damage 1d8+3. +2 from a hex/curse should produce 1d8+5.
  const attacker = pcAt({ pos: { col: 5, row: 5 } });
  attacker.combatMods = [
    { source: 'Hunter\'s Mark', kind: 'damage', scope: 'all', value: 2, inactive: false }
  ];
  const r = resolveAttack(baseCtx({ attacker }));
  assert.strictEqual(r.damage.dice, '1d8+5');
  assert.strictEqual(r.damage.flatBonus, 2);
  assert.ok(r.damage.parts.some(p => p.source === "Hunter's Mark" && p.value === 2));
});

test('M12: stacked attack + damage mods both surface in the breakdown', () => {
  const attacker = pcAt({ pos: { col: 5, row: 5 } });
  attacker.combatMods = [
    { source: '+1 Weapon',       kind: 'attack', scope: 'weapon-all', value: 1, inactive: false },
    { source: '+1 Weapon',       kind: 'damage', scope: 'weapon-all', value: 1, inactive: false },
    { source: 'Bless',           kind: 'attack', scope: 'all',        value: 4, inactive: false }
  ];
  const r = resolveAttack(baseCtx({ attacker }));
  assert.strictEqual(r.attackBonus.total, 6 + 1 + 4);
  assert.strictEqual(r.damage.flatBonus, 1);
  assert.strictEqual(r.damage.dice, '1d8+4');
});

// ---- M14: Positional rules in the resolver ----

test('M14: out-of-reach melee → blocker (autoMiss)', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 0, row: 0 } }),    // far away
    target:   monsterAt({ pos: { col: 5, row: 5 } })
  }));
  assert.strictEqual(r.autoMiss, true);
  assert.ok(r.blockers.some(b => /Out of reach/.test(b)));
});

test('M14: out-of-reach is OK for ranged weapons', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 0, row: 0 } }),
    target:   monsterAt({ pos: { col: 5, row: 5 } }),
    weapon: { name: 'Longbow' },
    attackStats: { ...ATTACK_STATS, parts: [{ source: 'Longbow', value: 6 }] }
  }));
  assert.strictEqual(r.autoMiss, false);
});

test('M14: reach weapon (Halberd) extends melee to 10ft', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 5, row: 5 } }),
    target:   monsterAt({ pos: { col: 7, row: 5 } }),   // 10ft
    weapon: { name: 'Halberd' },
    attackStats: { ...ATTACK_STATS, parts: [{ source: 'Halberd', value: 6 }] }
  }));
  assert.strictEqual(r.autoMiss, false);
});

test('M14: flanking grants advantage when toggle is enabled', () => {
  const ally = { id: 'ally', name: 'Adrin', _position: { col: 6, row: 5 } };
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 4, row: 5 } }),
    target:   monsterAt({ pos: { col: 5, row: 5 } }),
    scene: { ...SCENE, flankingEnabled: true },
    allies: [ally], hostiles: []
  }));
  assert.strictEqual(r.d20.mode, 'advantage');
  assert.ok(r.d20.advantage.some(s => /Flanking with Adrin/.test(s)));
});

test('M14: flanking does NOT trigger when scene.flankingEnabled = false', () => {
  const ally = { id: 'ally', name: 'Adrin', _position: { col: 6, row: 5 } };
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 4, row: 5 } }),
    target:   monsterAt({ pos: { col: 5, row: 5 } }),
    scene: { ...SCENE, flankingEnabled: false },
    allies: [ally], hostiles: []
  }));
  assert.strictEqual(r.d20.mode, 'normal');
});

test('M14: flanking does NOT trigger for ranged attacks', () => {
  const ally = { id: 'ally', name: 'Adrin', _position: { col: 6, row: 5 } };
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 4, row: 5 } }),
    target:   monsterAt({ pos: { col: 5, row: 5 } }),
    scene: { ...SCENE, flankingEnabled: true },
    weapon: { name: 'Longbow' },
    attackStats: { ...ATTACK_STATS, parts: [{ source: 'Longbow', value: 6 }] },
    allies: [ally], hostiles: []
  }));
  assert.strictEqual(r.d20.mode, 'normal');   // ranged attackers never flank
});

test('M14: ranged attacker adjacent to a hostile → disadvantage', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 5, row: 5 } }),
    target:   monsterAt({ pos: { col: 9, row: 5 } }),   // out of melee
    weapon: { name: 'Longbow' },
    attackStats: { ...ATTACK_STATS, parts: [{ source: 'Longbow', value: 6 }] },
    allies: [],
    hostiles: [{ id: 'h', name: 'Goblin 2', _position: { col: 5, row: 6 } }]
  }));
  assert.strictEqual(r.d20.mode, 'disadvantage');
  assert.ok(r.d20.disadvantage.some(s => /Ranged attacker adjacent/.test(s)));
});

test('M14: melee attacker adjacent to other hostiles → no disadvantage', () => {
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 5, row: 5 } }),
    target:   monsterAt({ pos: { col: 6, row: 5 } }),
    allies: [],
    hostiles: [{ id: 'h', name: 'Goblin 2', _position: { col: 5, row: 6 } }]
  }));
  // Melee attackers don't suffer the adjacent-hostile penalty
  assert.strictEqual(r.d20.mode, 'normal');
});

test('M14: flanking + target invisible → canceling rule (advantage + disadvantage = normal)', () => {
  const ally = { id: 'ally', name: 'Adrin', _position: { col: 6, row: 5 } };
  const r = resolveAttack(baseCtx({
    attacker: pcAt({ pos: { col: 4, row: 5 } }),
    target:   monsterAt({ pos: { col: 5, row: 5 }, conditions: ['invisible'] }),
    scene: { ...SCENE, flankingEnabled: true },
    allies: [ally], hostiles: []
  }));
  assert.strictEqual(r.d20.mode, 'normal');
  assert.strictEqual(r.d20.advantage.length, 1);
  assert.strictEqual(r.d20.disadvantage.length, 1);
});

// ---- M15: Class-feature availability via verdict.features ----

test('M15: verdict.features is empty when attacker has no class features', () => {
  // Default pcAt fixture has no classFeatures array
  const r = resolveAttack(baseCtx());
  assert.deepStrictEqual(r.features, []);
});

test('M15: verdict.features surfaces Sneak Attack as available for a rogue with advantage', () => {
  const rogue = pcAt({ pos: { col: 5, row: 5 } });
  rogue.classFeatures = [{ name: 'Sneak Attack', source: 'Rogue', dice: '3d6' }];
  rogue.equipment = { mainhand: { name: 'Rapier' } };
  const r = resolveAttack(baseCtx({
    attacker: rogue,
    weapon: { name: 'Rapier' },
    target: monsterAt({ conditions: ['blinded'] }),   // grants advantage
    attackStats: { bonus: 6, dice: '1d8+3', damageType: 'Piercing',
      parts: [{ source: 'Rapier', value: 6 }], damageParts: [] }
  }));
  const sa = r.features.find(f => f.name === 'Sneak Attack');
  assert.ok(sa, 'Sneak Attack should appear in verdict.features');
  assert.strictEqual(sa.available, true);
  assert.strictEqual(sa.dice, '3d6');
});

test('M15: verdict.features surfaces Sneak Attack BLOCKED when weapon is non-finesse melee', () => {
  const rogue = pcAt({ pos: { col: 5, row: 5 } });
  rogue.classFeatures = [{ name: 'Sneak Attack', source: 'Rogue', dice: '3d6' }];
  // baseCtx weapon is Longsword (not finesse, not ranged) — should block
  const r = resolveAttack(baseCtx({
    attacker: rogue,
    target: monsterAt({ conditions: ['blinded'] })
  }));
  const sa = r.features.find(f => f.name === 'Sneak Attack');
  assert.strictEqual(sa.available, false);
  assert.match(sa.blockReason, /finesse or ranged/i);
});

test('M15: verdict.features Sneak Attack Path B fires when ally adjacent to target (no advantage)', () => {
  const rogue = pcAt({ pos: { col: 8, row: 8 } });
  rogue.classFeatures = [{ name: 'Sneak Attack', source: 'Rogue', dice: '3d6' }];
  const ally = { id: 'ally', name: 'Adrin', _position: { col: 6, row: 5 } };
  const r = resolveAttack(baseCtx({
    attacker: rogue,
    weapon: { name: 'Shortbow' },
    target: monsterAt({ pos: { col: 5, row: 5 } }),
    attackStats: { bonus: 6, dice: '1d6+3', damageType: 'Piercing',
      parts: [{ source: 'Shortbow', value: 6 }], damageParts: [] },
    allies: [ally]
  }));
  const sa = r.features.find(f => f.name === 'Sneak Attack');
  assert.strictEqual(sa.available, true);
  assert.match(sa.reason, /Ally adjacent.*Adrin/);
});

test('M15: verdict.features Sneak Attack blocked when net disadvantage (poisoned rogue)', () => {
  const rogue = pcAt({ pos: { col: 5, row: 5 }, conditions: ['poisoned'] });
  rogue.classFeatures = [{ name: 'Sneak Attack', source: 'Rogue', dice: '3d6' }];
  const ally = { id: 'ally', name: 'Adrin', _position: { col: 6, row: 5 } };
  const r = resolveAttack(baseCtx({
    attacker: rogue,
    weapon: { name: 'Rapier' },
    target: monsterAt({ pos: { col: 5, row: 5 } }),
    attackStats: { bonus: 6, dice: '1d8+3', damageType: 'Piercing',
      parts: [{ source: 'Rapier', value: 6 }], damageParts: [] },
    allies: [ally]
  }));
  const sa = r.features.find(f => f.name === 'Sneak Attack');
  assert.strictEqual(sa.available, false);
  assert.match(sa.blockReason, /disadvantage/i);
});

// ---- M18: Spell attack scope ----

test('M18: ctx.spell switches scope to "spell"; spell-scope mods apply', () => {
  const cleric = pcAt({ pos: { col: 5, row: 5 } });
  cleric.combatMods = [
    { source: 'Amulet of the Devout, +1', kind: 'attack', scope: 'spell', value: 1, inactive: false }
  ];
  const goblin = monsterAt({ pos: { col: 7, row: 5 } });   // 10ft away
  const r = resolveAttack(baseCtx({
    attacker: cleric,
    target: goblin,
    weapon: null,
    spell: { name: 'Spiritual Weapon', dice: '1d8+3', requiresAttackRoll: true, range: { kind: 'ranged', feet: 60 } },
    attackStats: { bonus: 5, dice: '1d8+3', damageType: 'Force',
      parts: [{ source: 'WIS mod', value: 3 }, { source: 'Proficiency', value: 2 }],
      damageParts: [] }
  }));
  assert.strictEqual(r.attackBonus.total, 5 + 1, "Amulet's +1 must apply to spell attacks");
  assert.ok(r.attackBonus.parts.some(p => /Amulet of the Devout/.test(p.source)));
});

test('M18: spell attack does NOT pick up weapon-scope mods', () => {
  const cleric = pcAt({ pos: { col: 5, row: 5 } });
  cleric.combatMods = [
    { source: '+1 Longsword', kind: 'attack', scope: 'weapon-melee', value: 1, inactive: false }
  ];
  const goblin = monsterAt({ pos: { col: 7, row: 5 } });
  const r = resolveAttack(baseCtx({
    attacker: cleric, target: goblin,
    weapon: null,
    spell: { name: 'Sacred Flame', dice: '1d8', requiresSavingThrow: true, saveStat: 'DEX', range: { kind: 'ranged', feet: 60 } },
    attackStats: { bonus: 5, dice: '1d8', damageType: 'Radiant',
      parts: [{ source: 'WIS mod', value: 3 }, { source: 'Proficiency', value: 2 }], damageParts: [] }
  }));
  assert.strictEqual(r.attackBonus.total, 5, 'weapon-melee mod must not apply to spell');
});

test('M18: spell attacks skip the melee out-of-reach blocker', () => {
  const cleric = pcAt({ pos: { col: 0, row: 0 } });
  const goblin = monsterAt({ pos: { col: 9, row: 9 } });   // very far
  const r = resolveAttack(baseCtx({
    attacker: cleric, target: goblin,
    weapon: null,
    spell: { name: 'Guiding Bolt', dice: '4d6', requiresAttackRoll: true, range: { kind: 'ranged', feet: 120 } },
    attackStats: { bonus: 5, dice: '4d6', damageType: 'Radiant',
      parts: [{ source: 'WIS mod', value: 3 }, { source: 'Proficiency', value: 2 }], damageParts: [] }
  }));
  assert.strictEqual(r.autoMiss, false);
  assert.strictEqual(r.blockers.length, 0);
});

test('M18: spell attacks are treated as ranged for ranged-adjacent disadvantage', () => {
  const cleric = pcAt({ pos: { col: 5, row: 5 } });
  const goblin = monsterAt({ pos: { col: 9, row: 9 } });
  // A hostile right next to the caster
  const adjacent = { id: 'h2', name: 'Adjacent', _position: { col: 6, row: 5 } };
  const r = resolveAttack(baseCtx({
    attacker: cleric, target: goblin,
    weapon: null,
    spell: { name: 'Guiding Bolt', dice: '4d6', requiresAttackRoll: true, range: { kind: 'ranged', feet: 120 } },
    attackStats: { bonus: 5, dice: '4d6', damageType: 'Radiant',
      parts: [{ source: 'WIS mod', value: 3 }, { source: 'Proficiency', value: 2 }], damageParts: [] },
    allies: [], hostiles: [goblin, adjacent]
  }));
  assert.strictEqual(r.d20.mode, 'disadvantage');
  assert.ok(r.d20.disadvantage.some(s => /Ranged attacker adjacent/.test(s)));
});
