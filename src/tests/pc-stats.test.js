import { test } from 'node:test';
import assert from 'node:assert';
import { proficiencyBonus, totalLevel, deriveAC, deriveAttack, deriveWeaponAttack, spellcastingAbility, spellAttackBonus, spellSaveDC, saveBonus, classifyArmor, ARMOR_TYPE_BY_ID } from '../js/scene/pc-stats.js';
import { parsedDdbFixture } from './helpers/entities.js';

test('M6: proficiencyBonus follows the 5e ladder', () => {
  assert.strictEqual(proficiencyBonus(1),  2);
  assert.strictEqual(proficiencyBonus(4),  2);
  assert.strictEqual(proficiencyBonus(5),  3);
  assert.strictEqual(proficiencyBonus(8),  3);
  assert.strictEqual(proficiencyBonus(9),  4);
  assert.strictEqual(proficiencyBonus(12), 4);
  assert.strictEqual(proficiencyBonus(13), 5);
  assert.strictEqual(proficiencyBonus(17), 6);
  assert.strictEqual(proficiencyBonus(20), 6);
});

test('M6: totalLevel sums multi-class levels', () => {
  const ch = { classes: [{ level: 3 }, { level: 2 }] };
  assert.strictEqual(totalLevel(ch), 5);
});

test('M6: totalLevel prefers character.level if present', () => {
  const ch = { level: 7, classes: [{ level: 1 }] };
  assert.strictEqual(totalLevel(ch), 7);
});

test('M6: deriveAC — unarmored = 10 + DEX', () => {
  const ch = { abilityModifiers: { DEX: 3 }, equipment: {} };
  assert.strictEqual(deriveAC(ch), 13);
});

test('M6: deriveAC — unarmored + shield', () => {
  const ch = {
    abilityModifiers: { DEX: 2 },
    equipment: { offhand: { name: 'Shield' } }
  };
  assert.strictEqual(deriveAC(ch), 14);
});

test('M6: deriveAC — chain mail caps DEX at 0', () => {
  const ch = {
    abilityModifiers: { DEX: 4 },
    equipment: { armor: { name: 'Chain Mail', armorClass: 16 } }
  };
  assert.strictEqual(deriveAC(ch), 16);
});

test('M6: deriveAC — scale mail caps DEX at +2', () => {
  const ch = {
    abilityModifiers: { DEX: 4 },
    equipment: { armor: { name: 'Scale Mail', armorClass: 14 } }
  };
  assert.strictEqual(deriveAC(ch), 16);   // 14 + min(4, 2)
});

test('M6: deriveAC — leather (light) uses full DEX', () => {
  const ch = {
    abilityModifiers: { DEX: 4 },
    equipment: { armor: { name: 'Leather', armorClass: 11 } }
  };
  assert.strictEqual(deriveAC(ch), 15);   // 11 + 4
});

test('M6: deriveAttack — falls back to unarmed if no main hand', () => {
  const ch = { abilityModifiers: { STR: 2, DEX: 1 }, level: 1, equipment: {} };
  const a = deriveAttack(ch);
  assert.strictEqual(a.name, 'Unarmed Strike');
  assert.strictEqual(a.bonus, 2 + 2);   // STR mod + prof
});

test('M6: deriveAttack — longsword uses STR by default', () => {
  const ch = {
    abilityModifiers: { STR: 3, DEX: 0 },
    level: 5,
    equipment: { mainhand: { name: 'Longsword' } }
  };
  const a = deriveAttack(ch);
  assert.strictEqual(a.name, 'Longsword');
  assert.strictEqual(a.bonus, 3 + 3);   // STR mod + prof@L5
  assert.strictEqual(a.dice, '1d8+3');
});

test('M6: deriveAttack — rapier (finesse) prefers DEX when higher', () => {
  const ch = {
    abilityModifiers: { STR: 1, DEX: 4 },
    level: 1,
    equipment: { mainhand: { name: 'Rapier' } }
  };
  const a = deriveAttack(ch);
  assert.strictEqual(a.bonus, 4 + 2);   // DEX mod + prof@L1
  assert.strictEqual(a.dice, '1d8+4');
});

test('M6: deriveAttack — longbow uses DEX (ranged)', () => {
  const ch = {
    abilityModifiers: { STR: 5, DEX: 2 },
    level: 3,
    equipment: { mainhand: { name: 'Longbow' } }
  };
  const a = deriveAttack(ch);
  assert.strictEqual(a.bonus, 2 + 2);   // DEX mod + prof
  assert.strictEqual(a.dice, '1d8+2');
});

test('M6: deriveAttack — +1 weapon adds magic bonus', () => {
  const ch = {
    abilityModifiers: { STR: 3 },
    level: 1,
    equipment: { mainhand: { name: '+1 Longsword' } }
  };
  const a = deriveAttack(ch);
  assert.strictEqual(a.bonus, 3 + 2 + 1);   // STR + prof + magic
  assert.strictEqual(a.dice, '1d8+4');      // STR + magic
});

test('M9: deriveWeaponAttack — trusts parser damage field over WEAPON_DICE table', () => {
  // Hand Crossbow: parser reports 1d6 (SRD). Even though our keyword
  // table also has 'hand crossbow' → 1d6, this test pins behaviour when
  // a homebrew weapon supplies its own damage dice via the parser.
  const ch = {
    abilityModifiers: { STR: 1, DEX: -1 },
    level: 3,
    equipment: {}
  };
  const weapon = { name: 'Crossbow, Hand', damage: '1d6', damageType: 'Piercing' };
  const a = deriveWeaponAttack(ch, weapon);
  // Hand crossbow is ranged → uses DEX (-1) + prof (2) = +1
  assert.strictEqual(a.bonus, 1);
  assert.strictEqual(a.dice, '1d6-1');
  assert.strictEqual(a.damageType, 'Piercing');
});

test('M9: deriveWeaponAttack — finesse weapon prefers higher of STR/DEX', () => {
  const ch = { abilityModifiers: { STR: 0, DEX: 3 }, level: 1, equipment: {} };
  const a = deriveWeaponAttack(ch, { name: 'Shortsword', damage: '1d6', damageType: 'Piercing' });
  assert.strictEqual(a.bonus, 3 + 2);   // DEX + prof
  assert.strictEqual(a.dice, '1d6+3');
});

test('M9: deriveWeaponAttack — uses explicit properties array when present', () => {
  // Homebrew weapon with the finesse property set but a name our keyword
  // table doesn\'t know — properties should win.
  const ch = { abilityModifiers: { STR: 0, DEX: 4 }, level: 1, equipment: {} };
  const w = { name: 'Singing Blade', damage: '1d6', properties: [{ name: 'Finesse' }] };
  const a = deriveWeaponAttack(ch, w);
  assert.strictEqual(a.bonus, 4 + 2);
});

test('M9: deriveWeaponAttack — homebrew with no damage falls back to 1d4', () => {
  const ch = { abilityModifiers: { STR: 2 }, level: 1, equipment: {} };
  const a = deriveWeaponAttack(ch, { name: 'Mystery Weapon' });
  assert.strictEqual(a.dice, '1d4+2');
});

test('M9: deriveWeaponAttack — exposes damageType for the chip label', () => {
  const ch = { abilityModifiers: { STR: 1 }, level: 1, equipment: {} };
  const a = deriveWeaponAttack(ch, { name: 'Warhammer', damage: '1d8', damageType: 'Bludgeoning' });
  assert.strictEqual(a.damageType, 'Bludgeoning');
});

// ---- M18: spellcasting stats ----

test('M18: spellcastingAbility — uses per-spell override when present', () => {
  const character = { abilityModifiers: { WIS: 3, INT: 2 }, classes: [{ level: 3 }] };
  assert.strictEqual(spellcastingAbility(character, { spellCastingAbility: 'INT' }), 'INT');
});

test('M18: spellcastingAbility — falls back to character.spells[].spellCastingAbility', () => {
  const character = { spells: [{ spellCastingAbility: 'WIS' }] };
  assert.strictEqual(spellcastingAbility(character, { spellCastingAbility: null }), 'WIS');
});

test('M18: spellAttackBonus — Cleric L3 with WIS +3 → +5 (WIS +3, prof +2)', () => {
  const character = {
    abilityModifiers: { WIS: 3 },
    classes: [{ level: 3 }],
    spells: [{ spellCastingAbility: 'WIS' }]
  };
  const a = spellAttackBonus(character, { spellCastingAbility: 'WIS' });
  assert.strictEqual(a.total, 5);
  assert.strictEqual(a.ability, 'WIS');
  assert.ok(a.parts.find(p => /WIS mod/.test(p.source)));
  assert.ok(a.parts.find(p => /Proficiency/.test(p.source)));
});

test('M18: spellSaveDC — Cleric L3 with WIS +3 → 13 (8 + 3 + 2)', () => {
  const character = {
    abilityModifiers: { WIS: 3 },
    classes: [{ level: 3 }],
    spells: [{ spellCastingAbility: 'WIS' }]
  };
  assert.strictEqual(spellSaveDC(character, { spellCastingAbility: 'WIS' }), 13);
});

test('M18: spellAttackBonus — no spellcasting ability returns proficiency only', () => {
  const character = { abilityModifiers: {}, classes: [{ level: 1 }], spells: [] };
  const a = spellAttackBonus(character, {});
  assert.strictEqual(a.total, 2);   // prof only
});

// ---- M21: saveBonus ----

test('M21: saveBonus — proficient save = ability mod + proficiency', () => {
  const ch = {
    abilityModifiers: { WIS: 3, DEX: 1 },
    classes: [{ level: 5 }],
    savingThrowProficiencies: ['WIS', 'CHA']
  };
  assert.strictEqual(saveBonus(ch, 'WIS'), 3 + 3);   // WIS mod + prof@L5
  assert.strictEqual(saveBonus(ch, 'DEX'), 1);         // DEX mod, NOT proficient
});

test('M21: saveBonus — non-proficient is just the ability mod', () => {
  const ch = {
    abilityModifiers: { STR: -1 },
    classes: [{ level: 1 }],
    savingThrowProficiencies: []
  };
  assert.strictEqual(saveBonus(ch, 'STR'), -1);
});

test('M21: saveBonus — empty character returns 0 (no ability, no proficiency)', () => {
  assert.strictEqual(saveBonus({}, 'WIS'), 0);
});

// ── R5: AC from DDB armorTypeId + combatMods of kind `ac` ──────────────

test('R5: deriveAC — breastplate (armorTypeId 2) + DEX +3 → 16 (medium cap +2)', () => {
  const ch = { abilityModifiers: { DEX: 3 }, equipment: { armor: { name: 'Breastplate', armorClass: 14, armorTypeId: 2 } } };
  assert.strictEqual(deriveAC(ch), 16);
});

test('R5: deriveAC — breastplate by name only (older rows) is medium, not heavy', () => {
  const ch = { abilityModifiers: { DEX: 3 }, equipment: { armor: { name: 'Breastplate', armorClass: 14 } } };
  assert.strictEqual(deriveAC(ch), 16);
  // and without armorClass the name fallback base is 14, not plate's 18
  assert.strictEqual(deriveAC({ abilityModifiers: { DEX: 3 }, equipment: { armor: { name: 'Breastplate' } } }), 16);
});

test('R5: deriveAC — half plate + DEX +3 → 17 (by id and by name)', () => {
  assert.strictEqual(deriveAC({ abilityModifiers: { DEX: 3 }, equipment: { armor: { name: 'Half Plate', armorClass: 15, armorTypeId: 2 } } }), 17);
  assert.strictEqual(deriveAC({ abilityModifiers: { DEX: 3 }, equipment: { armor: { name: 'Half Plate', armorClass: 15 } } }), 17);
  assert.strictEqual(deriveAC({ abilityModifiers: { DEX: 3 }, equipment: { armor: { name: 'Half Plate' } } }), 17);
});

test('R5: deriveAC — plate → 18 regardless of DEX', () => {
  for (const dex of [-1, 0, 3, 5]) {
    assert.strictEqual(deriveAC({ abilityModifiers: { DEX: dex }, equipment: { armor: { name: 'Plate', armorClass: 18, armorTypeId: 3 } } }), 18, `DEX ${dex}`);
  }
  assert.strictEqual(deriveAC({ abilityModifiers: { DEX: 3 }, equipment: { armor: { name: 'Plate' } } }), 18);
});

test('R5: deriveAC — armorTypeId wins over a misleading name', () => {
  // A homebrew "Mithral Plate" flagged medium by DDB keeps DEX (capped).
  const ch = { abilityModifiers: { DEX: 4 }, equipment: { armor: { name: 'Mithral Plate', armorClass: 15, armorTypeId: 2 } } };
  assert.strictEqual(deriveAC(ch), 17);
  const light = { abilityModifiers: { DEX: 4 }, equipment: { armor: { name: 'Elven Plate', armorClass: 12, armorTypeId: 1 } } };
  assert.strictEqual(deriveAC(light), 16);
});

test('R5: deriveAC — shield detected by armorTypeId 4', () => {
  const ch = { abilityModifiers: { DEX: 1 }, equipment: { armor: null, offhand: { name: 'Sentinel Kite', armorTypeId: 4 } } };
  assert.strictEqual(deriveAC(ch), 13);
});

test('R5: deriveAC — Ring of Protection +1 (combatMods kind ac) applies', () => {
  const ring = { kind: 'ac', scope: 'all', value: 1, inactive: false, source: 'Ring of Protection' };
  const ch = {
    abilityModifiers: { DEX: 2 },
    equipment: { armor: { name: 'Chain Mail', armorClass: 16, armorTypeId: 3 }, offhand: { name: 'Shield', armorTypeId: 4 } },
    combatMods: [ring]
  };
  assert.strictEqual(deriveAC(ch), 19);
  // Cloak of Protection stacks with the ring.
  ch.combatMods = [ring, { ...ring, source: 'Cloak of Protection' }];
  assert.strictEqual(deriveAC(ch), 20);
});

test('R5: deriveAC — unattuned AC item is ignored; non-AC mods are ignored', () => {
  const ch = {
    abilityModifiers: { DEX: 2 },
    equipment: { armor: { name: 'Leather', armorClass: 11, armorTypeId: 1 } },
    combatMods: [
      { kind: 'ac', scope: 'all', value: 1, inactive: true },
      { kind: 'attack', scope: 'spell', value: 1, inactive: false },
      { kind: 'save', scope: 'all', value: 1, inactive: false }
    ]
  };
  assert.strictEqual(deriveAC(ch), 13);
});

test('R5: deriveAC — unarmored-scope AC bonus applies only without armor', () => {
  const bracers = { kind: 'ac', scope: 'unarmored', value: 2, inactive: false };
  assert.strictEqual(deriveAC({ abilityModifiers: { DEX: 2 }, equipment: {}, combatMods: [bracers] }), 14);
  assert.strictEqual(deriveAC({ abilityModifiers: { DEX: 2 }, equipment: { armor: { name: 'Leather', armorClass: 11 } }, combatMods: [bracers] }), 13);
});

test('R5: classifyArmor — medium names are not swallowed by /plate/; case-insensitive', () => {
  assert.strictEqual(classifyArmor('breastplate'), 'medium');
  assert.strictEqual(classifyArmor('Half Plate'), 'medium');
  assert.strictEqual(classifyArmor('plate'), 'heavy');
  assert.strictEqual(classifyArmor('chain mail'), 'heavy');
  assert.strictEqual(classifyArmor('studded leather'), 'light');
  assert.deepStrictEqual({ ...ARMOR_TYPE_BY_ID }, { 1: 'light', 2: 'medium', 3: 'heavy', 4: 'shield' });
});

test('R5: synthetic fixtures keep their AC (cleric 18, fighter 18, wizard 12)', () => {
  assert.strictEqual(deriveAC(parsedDdbFixture('cleric-l5')), 18);
  assert.strictEqual(deriveAC(parsedDdbFixture('fighter-l5')), 18);
  assert.strictEqual(deriveAC(parsedDdbFixture('wizard-l5')), 10 + parsedDdbFixture('wizard-l5').abilityModifiers.DEX);
});
