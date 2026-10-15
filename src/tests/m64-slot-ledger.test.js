/**
 * M64 T5 — one slot ledger: Shield, Counterspell and leveled spells all
 * draw from `_slots` (then `_pact`); the old `_lvl1Slots` / `_lvl3Slots`
 * side pools are gone.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  availableSlotLevel, spendSlotAtLeast, canCastShield, consumeShield,
  canCastCounterspell, consumeCounterspell
} from '../js/scene/reactions.js';
import { runMonsterSpell } from '../js/scene/combat-engine.js';

const wiz = (over = {}) => ({
  id: 'w', kind: 'pc', ac: 12, hp: 30, hpMax: 30, conditions: [],
  ref: { classes: [{ name: 'Wizard', level: 5 }], abilityModifiers: { INT: 3 }, spells: ['Shield', 'Counterspell', 'Magic Missile'] },
  _reactionUsed: false, _slots: { 1: 1, 2: 0, 3: 1 }, ...over
});

test('T5: availableSlotLevel / spendSlotAtLeast pick the lowest qualifying slot', () => {
  const w = wiz();
  assert.equal(availableSlotLevel(w, 1), 1);
  assert.equal(availableSlotLevel(w, 2), 3);
  assert.equal(spendSlotAtLeast(w, 1), 1);
  assert.equal(spendSlotAtLeast(w, 1), 3, 'upcasts once the 1st-level slots are gone');
  assert.equal(spendSlotAtLeast(w, 1), null);
  assert.deepEqual(w._slots, { 1: 0, 2: 0, 3: 0 });
});

test('T5: pact slots are a separate pool used after regular slots', () => {
  const lock = wiz({ _slots: { 1: 0 }, _pact: { level: 3, max: 2, spent: 1 } });
  assert.equal(availableSlotLevel(lock, 1), 3);
  assert.equal(spendSlotAtLeast(lock, 3), 3);
  assert.deepEqual(lock._pact, { level: 3, max: 2, spent: 2 });
  assert.equal(availableSlotLevel(lock, 1), null);
});

test('T5: Shield spends from the same pool as Magic Missile', async () => {
  const w = wiz({ _slots: { 1: 1 } });
  assert.ok(canCastShield(w));
  // The wizard casts Magic Missile with its only slot: no Shield left.
  const target = { id: 'g', kind: 'monster', presetSlug: 'goblin', hp: 50, hpMax: 50, ac: 12, conditions: [] };
  await runMonsterSpell({ attacker: w, target, plan: { spellId: 'magic-missile', castAtLevel: 1 }, rng: () => 0.5 });
  assert.equal(w._slots[1], 0);
  assert.equal(canCastShield(w), false, 'no slot left for Shield');
});

test('T5: consumeShield / consumeCounterspell return the level spent', () => {
  const w = wiz();
  assert.equal(consumeShield(w), 1);
  w._reactionUsed = false;
  assert.ok(canCastCounterspell(w));
  assert.equal(consumeCounterspell(w), 3);
  w._reactionUsed = false;
  assert.equal(canCastCounterspell(w), false, 'no 3rd+ slot left');
});
