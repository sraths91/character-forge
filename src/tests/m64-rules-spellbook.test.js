/**
 * M64 R3 — pcSpellBook: total level, per-spell ability, combatMods.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { pcSpellBook } from '../js/scene/combat-engine.js';
import { spellById } from '../js/scene/monster-spells.js';
import { parsedDdbFixture, pcFromSheet } from './helpers/entities.js';

// Synthetic stand-in for the Saris probe: Cleric 4, WIS +4, wearing an
// attuned Amulet of the Devout +1 (spell attacks +1, spell save DC +1).
function sarisLike() {
  const sheet = parsedDdbFixture('cleric-l5');
  sheet.classes = [{ name: 'Cleric', level: 4 }];
  sheet.level = 4;
  sheet.abilityModifiers = { ...sheet.abilityModifiers, WIS: 4 };
  sheet.combatMods = [
    { kind: 'attack', scope: 'spell', value: 1, source: 'Amulet of the Devout', inactive: false },
    { kind: 'save-dc', scope: 'spell', value: 1, source: 'Amulet of the Devout', inactive: false }
  ];
  return pcFromSheet(sheet);
}

test('R3: Saris-like Cleric 4 + Amulet of the Devout → DC 15 / +7', () => {
  const book = pcSpellBook(sarisLike(), spellById('sacred-flame'));
  assert.strictEqual(book.dc, 15);
  assert.strictEqual(book.attackBonus, 7);
  assert.strictEqual(book.ability, 'WIS');
});

test('R3: Fighter 2 / Sorcerer 7 with CHA +4 → DC 16 / +8 (PB from total level)', () => {
  const pc = { kind: 'pc', ref: {
    classes: [{ name: 'Fighter', level: 2 }, { name: 'Sorcerer', level: 7 }],
    abilityModifiers: { STR: 1, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 4 }
  } };
  const book = pcSpellBook(pc);
  assert.strictEqual(book.dc, 16);
  assert.strictEqual(book.attackBonus, 8);
});

test('R3: per-spell ability — a WIS spell on an INT caster uses WIS', () => {
  const pc = { kind: 'pc', ref: {
    classes: [{ name: 'Wizard', level: 5 }],
    abilityModifiers: { INT: 3, WIS: 1 },
    spells: [{ name: 'Sacred Flame', spellCastingAbility: 'WIS' }]
  } };
  assert.strictEqual(pcSpellBook(pc, spellById('sacred-flame')).abilityMod, 1);
  assert.strictEqual(pcSpellBook(pc, spellById('magic-missile')).abilityMod, 3);
});

test('R3: inactive (unattuned) combatMods do not apply', () => {
  const pc = sarisLike();
  pc.combatMods = pc.combatMods.map(m => ({ ...m, inactive: true }));
  const book = pcSpellBook(pc);
  assert.strictEqual(book.dc, 14);
  assert.strictEqual(book.attackBonus, 6);
});
