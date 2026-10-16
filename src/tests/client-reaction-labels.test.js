// M64 — Shield / Counterspell cost labels read the one slot ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotPoolOf, reactionSlotOf, reactionCostLabel } from '../js/client/reaction-labels.js';

test('labels: engine wrapper pool (_slots) — the lowest available slot is named', () => {
  const w = { _slots: { 1: 0, 2: 2, 3: 1 } };
  assert.deepEqual(reactionSlotOf(w), { level: 2, remaining: 2, pact: false });
  assert.equal(reactionCostLabel(w), '1 reaction · 1 of 2 2nd-level slots');
  assert.equal(reactionCostLabel(w, 3), '1 reaction · 1 of 1 3rd-level slot');
});

test('labels: retired _lvl1Slots is ignored', () => {
  assert.equal(reactionCostLabel({ _lvl1Slots: 4 }), '1 reaction · no slot of level 1+ left');
});

test('labels: EncounterState ledger {max, spent} and pact magic', () => {
  const e = { resources: { slots: { 1: { max: 4, spent: 1 } }, pact: {} } };
  assert.deepEqual(slotPoolOf(e).pool, { 1: 3 });
  assert.equal(reactionCostLabel(e), '1 reaction · 1 of 3 1st-level slots');
  const warlock = { resources: { slots: {}, pact: { level: 3, max: 2, spent: 1 } } };
  assert.equal(reactionCostLabel(warlock, 3), '1 reaction · 1 of 1 pact slot');
  assert.equal(reactionCostLabel({ _slots: {}, _pact: { level: 2, max: 2, spent: 2 } }), '1 reaction · no slot of level 1+ left');
  assert.deepEqual(slotPoolOf(null), { pool: {}, pact: null });
});
