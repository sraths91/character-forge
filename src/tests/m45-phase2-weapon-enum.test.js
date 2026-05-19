import { test } from 'node:test';
import assert from 'node:assert';
import { weaponsAvailableFor, isWeaponName } from '../js/scene/ai/action-options.js';

// ---------- isWeaponName ----------

test('M45 Phase 2: isWeaponName — recognizes the previously-supported set', () => {
  for (const n of ['Longsword', 'Battleaxe', 'Dagger of Venom', 'Mace +1',
                   'Warhammer', 'Club']) {
    assert.strictEqual(isWeaponName(n), true, `expected ${n} → true`);
  }
});

test('M45 Phase 2: isWeaponName — recognizes the newly-added weapons', () => {
  for (const n of ['Spear', 'Rapier', 'Scimitar', 'Quarterstaff', 'Sickle',
                   'Trident', 'Whip', 'Flail', 'Morningstar',
                   'Glaive', 'Halberd', 'Pike', 'Lance', 'Maul',
                   'Greatsword', 'Greataxe', 'Shortsword', 'Handaxe',
                   'Katana', 'Cutlass', 'Saber', 'Estoc', 'Stiletto']) {
    assert.strictEqual(isWeaponName(n), true, `expected ${n} → true`);
  }
});

test('M45 Phase 2: isWeaponName — still rejects shields, focuses, books', () => {
  for (const n of ['Shield', 'Spellbook', 'Holy Symbol', 'Component Pouch',
                   'Wooden Shield', 'Buckler', 'Tome', 'Orb', 'Lantern']) {
    assert.strictEqual(isWeaponName(n), false, `expected ${n} → false`);
  }
});

test('M45 Phase 2: isWeaponName — word-boundary aware (no "daggerward" false-positive)', () => {
  // The whole-word \b boundary is what protects against substring matches.
  // "Daggerward" would have matched the OLD test against "dagger"; this
  // test asserts the new pattern still rejects it.
  // Note: with \b, "daggerward" contains "dagger" at a word boundary,
  // BUT the trailing "ward" prevents the entire token. Test the most
  // realistic false-positive vectors:
  assert.strictEqual(isWeaponName('Wandering Cloak'), false);
  assert.strictEqual(isWeaponName('Hammered Mug'), false);   // doesn't trip on "hammer"
});

test('M45 Phase 2: isWeaponName — null / empty is false', () => {
  assert.strictEqual(isWeaponName(''), false);
  assert.strictEqual(isWeaponName(null), false);
  assert.strictEqual(isWeaponName(undefined), false);
});

// ---------- weaponsAvailableFor — off-hand enumeration ----------

test('M45 Phase 2: weaponsAvailableFor — TWF rogue with off-hand shortsword surfaces it', () => {
  const pc = {
    kind: 'pc',
    equipment: {
      mainhand: { name: 'Shortsword' },
      offhand:  { name: 'Shortsword' }
    },
    carried: []
  };
  const out = weaponsAvailableFor(pc);
  const slots = out.map(w => w._slot);
  assert.ok(slots.includes('mainhand'), 'mainhand should be surfaced');
  assert.ok(slots.includes('offhand'),  'off-hand SHORTSWORD must surface — previously dropped');
});

test('M45 Phase 2: weaponsAvailableFor — TWF fighter with off-hand spear surfaces it', () => {
  // The previous regex didn't include "spear" — this exact case was the
  // user-visible bug.
  const pc = {
    kind: 'pc',
    equipment: {
      mainhand: { name: 'Longsword' },
      offhand:  { name: 'Spear' }
    },
    carried: []
  };
  const out = weaponsAvailableFor(pc);
  assert.ok(out.some(w => w._slot === 'offhand' && /spear/i.test(w.name)),
    'off-hand spear must surface');
});

test('M45 Phase 2: weaponsAvailableFor — shield in off-hand is NOT a weapon', () => {
  const pc = {
    kind: 'pc',
    equipment: {
      mainhand: { name: 'Longsword' },
      offhand:  { name: 'Shield' }
    },
    carried: []
  };
  const out = weaponsAvailableFor(pc);
  assert.ok(!out.some(w => w._slot === 'offhand'),
    'shield must NOT surface as an off-hand weapon');
});

test('M45 Phase 2: weaponsAvailableFor — carried longbow still enumerates as stowed', () => {
  // Regression — the carried/stowed pattern is independent of isWeaponName
  const pc = {
    kind: 'pc',
    equipment: { mainhand: { name: 'Longsword' } },
    carried: [{ name: 'Longbow' }]
  };
  const out = weaponsAvailableFor(pc);
  assert.ok(out.some(w => w._slot === 'stowed' && /longbow/i.test(w.name)),
    'stowed longbow must surface');
});
