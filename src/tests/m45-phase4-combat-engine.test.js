import { test } from 'node:test';
import assert from 'node:assert';
import {
  runOneAttack, runMonsterSpell, runReactionAttack,
  applyDamageToEntity, saveBonusFor, pcSpellBook, abilityForCounterer,
  pickTarget, isAlive, isIncapacitated, sideAlive
} from '../js/scene/combat-engine.js';

// ---------- Module surface ----------

test('M45 Phase 4: combat-engine exports the spine entrypoints', () => {
  assert.strictEqual(typeof runOneAttack, 'function');
  assert.strictEqual(typeof runMonsterSpell, 'function');
  assert.strictEqual(typeof runReactionAttack, 'function');
});

test('M45 Phase 4: combat-engine exports the shared helpers', () => {
  for (const f of [applyDamageToEntity, saveBonusFor, pcSpellBook,
                   abilityForCounterer, pickTarget, isAlive,
                   isIncapacitated, sideAlive]) {
    assert.strictEqual(typeof f, 'function');
  }
});

// ---------- isAlive / isIncapacitated / sideAlive ----------

test('M45 Phase 4: isAlive — hp > 0 → true', () => {
  assert.strictEqual(isAlive({ hp: 1 }), true);
  assert.strictEqual(isAlive({ hp: 0 }), false);
  assert.strictEqual(isAlive({ hp: -3 }), false);
});

test('M45 Phase 4: isIncapacitated — recognises blocking conditions', () => {
  assert.strictEqual(isIncapacitated({ conditions: ['paralyzed'] }), true);
  assert.strictEqual(isIncapacitated({ conditions: ['stunned'] }), true);
  assert.strictEqual(isIncapacitated({ conditions: ['unconscious'] }), true);
  assert.strictEqual(isIncapacitated({ conditions: ['petrified'] }), true);
  assert.strictEqual(isIncapacitated({ conditions: ['frightened'] }), false);
  assert.strictEqual(isIncapacitated({ conditions: [] }), false);
  assert.strictEqual(isIncapacitated({}), false);
});

test('M45 Phase 4: sideAlive — counts only alive + non-incapacitated', () => {
  const side = [
    { hp: 5, conditions: [] },
    { hp: 0, conditions: [] },                // dead
    { hp: 8, conditions: ['paralyzed'] },     // out
    { hp: 8, conditions: [] },
    { hp: 5, conditions: ['frightened'] }     // frightened doesn't disable
  ];
  assert.strictEqual(sideAlive(side), 3);
});

// ---------- pickTarget ----------

test('M45 Phase 4: pickTarget — picks lowest-HP live enemy', () => {
  const enemies = [
    { id: 'a', hp: 10 },
    { id: 'b', hp: 3 },
    { id: 'c', hp: 0 },     // dead — skipped
    { id: 'd', hp: 7 }
  ];
  assert.strictEqual(pickTarget(enemies)?.id, 'b');
});

test('M45 Phase 4: pickTarget — empty / all-dead pool returns null', () => {
  assert.strictEqual(pickTarget([]), null);
  assert.strictEqual(pickTarget([{ hp: 0 }, { hp: 0 }]), null);
});

// ---------- saveBonusFor ----------

test('M45 Phase 4: saveBonusFor — PC reads abilityModifiers', () => {
  const pc = { kind: 'pc', ref: { abilityModifiers: { DEX: 3, WIS: 1 } } };
  assert.strictEqual(saveBonusFor(pc, 'DEX'), 3);
  assert.strictEqual(saveBonusFor(pc, 'WIS'), 1);
  assert.strictEqual(saveBonusFor(pc, 'CHA'), 0);
});

test('M45 Phase 4: saveBonusFor — null / unknown inputs → 0', () => {
  assert.strictEqual(saveBonusFor(null, 'DEX'), 0);
  assert.strictEqual(saveBonusFor({ kind: 'pc' }, null), 0);
});

// ---------- pcSpellBook + abilityForCounterer ----------

test('M45 Phase 4: pcSpellBook — wizard uses INT', () => {
  const wiz = { ref: {
    classes: [{ name: 'Wizard', level: 5 }],
    abilityModifiers: { INT: 4, DEX: 2 }
  } };
  const book = pcSpellBook(wiz);
  assert.strictEqual(book.abilityMod, 4);
  // prof at lvl 5 = 3; DC = 8 + 3 + 4 = 15
  assert.strictEqual(book.dc, 15);
  assert.strictEqual(book.attackBonus, 7);
});

test('M45 Phase 4: pcSpellBook — cleric uses WIS', () => {
  const cler = { ref: {
    classes: [{ name: 'Cleric', level: 3 }],
    abilityModifiers: { WIS: 3, INT: 0 }
  } };
  const book = pcSpellBook(cler);
  assert.strictEqual(book.abilityMod, 3);
});

test('M45 Phase 4: pcSpellBook — paladin uses CHA', () => {
  const pal = { ref: {
    classes: [{ name: 'Paladin', level: 5 }],
    abilityModifiers: { CHA: 3, STR: 2 }
  } };
  const book = pcSpellBook(pal);
  assert.strictEqual(book.abilityMod, 3);
});

test('M45 Phase 4: abilityForCounterer — class drives the stat', () => {
  assert.strictEqual(abilityForCounterer({ ref: { classes: [{ name: 'Wizard' }] } }), 'INT');
  assert.strictEqual(abilityForCounterer({ ref: { classes: [{ name: 'Cleric' }] } }), 'WIS');
  assert.strictEqual(abilityForCounterer({ ref: { classes: [{ name: 'Bard' }] } }), 'CHA');
  // Unknown class defaults to INT
  assert.strictEqual(abilityForCounterer({ ref: { classes: [{ name: 'Barbarian' }] } }), 'INT');
});

// ---------- applyDamageToEntity ----------

test('M45 Phase 4: applyDamageToEntity — reduces hp + clamps to zero', () => {
  const target = { hp: 5 };
  applyDamageToEntity(target, 3);
  assert.strictEqual(target.hp, 2);
  applyDamageToEntity(target, 10);
  assert.strictEqual(target.hp, 0);
});

test('M45 Phase 4: applyDamageToEntity — non-positive damage is a no-op', () => {
  const target = { hp: 8 };
  applyDamageToEntity(target, 0);
  assert.strictEqual(target.hp, 8);
  applyDamageToEntity(target, -5);
  assert.strictEqual(target.hp, 8);
});

test('M45 Phase 4: applyDamageToEntity — null target is safe', () => {
  assert.doesNotThrow(() => applyDamageToEntity(null, 5));
});
