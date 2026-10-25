// M65 R23 — shared spell-slot maths (parser + level-up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MULTICLASS_SLOTS, slotRowToObject, hasSlotRows, casterClassEntry, combineSpellSlots } from '../js/campaign/spell-slots.js';

const FULL = MULTICLASS_SLOTS;

test('slotRowToObject drops zero levels', () => {
  assert.deepEqual(slotRowToObject([4, 3, 2, 0, 0, 0, 0, 0, 0]), { 1: 4, 2: 3, 3: 2 });
  assert.deepEqual(slotRowToObject(null), {});
});

test('hasSlotRows is false for an all-zero table', () => {
  assert.equal(hasSlotRows([[0, 0], [0, 0]]), false);
  assert.equal(hasSlotRows(FULL), true);
  assert.equal(hasSlotRows(undefined), false);
});

test('casterClassEntry reads the row at the class level (clamped to the table)', () => {
  const e = casterClassEntry({ name: 'Cleric', level: 5, rows: FULL });
  assert.deepEqual(e, { name: 'Cleric', level: 5, divisor: 1, rounding: 1, pact: false, slots: { 1: 4, 2: 3, 3: 2 } });
  assert.deepEqual(casterClassEntry({ name: 'Wizard', level: 30, rows: FULL }).slots, slotRowToObject(FULL[20]));
  assert.equal(casterClassEntry({ name: 'Warlock', level: 1, rows: FULL }).pact, true);
});

test('combineSpellSlots: single class, multiclass table, pact apart', () => {
  const cleric5 = casterClassEntry({ name: 'Cleric', level: 5, rows: FULL });
  assert.deepEqual(combineSpellSlots([cleric5]), { spell: { 1: 4, 2: 3, 3: 2 }, pact: null });
  const paladin4 = { ...casterClassEntry({ name: 'Paladin', level: 4, rows: FULL }), divisor: 2 };
  assert.deepEqual(combineSpellSlots([cleric5, paladin4]).spell, slotRowToObject(FULL[7]));
  const lock = { name: 'Warlock', level: 3, divisor: 1, rounding: 1, pact: true, slots: { 2: 2 } };
  assert.deepEqual(combineSpellSlots([lock]), { spell: {}, pact: { level: 2, max: 2 } });
  assert.deepEqual(combineSpellSlots([]), { spell: {}, pact: null });
});
