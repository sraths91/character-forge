/**
 * M65 — simulator PCs can carry run items (potions): `simulateEncounter`
 * party entries accept `items`, so the calibrator reflects a party with
 * potions. Preset-only runs carry no `_items` (goldens unchanged).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateEncounter } from '../js/scene/simulator.js';
import { calibrateEncounter } from '../js/scene/calibrator.js';
import { runItemsLedger } from '../js/scene/encounter-adapters.js';

const pc = (items) => ({
  id: 'f', name: 'f', _position: { col: 1, row: 1 }, hp: { current: 30, max: 30 },
  equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
  abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 3, WIS: 2, CHA: 2 },
  classes: [{ name: 'Fighter', level: 5 }], conditions: [], spells: [],
  ...(items ? { items } : {})
});
const mon = (id, slug, col) => ({ id, name: slug, presetSlug: slug, hp: { current: 25, max: 25 }, conditions: [], position: { col, row: 2 } });
const encounter = (items) => ({
  party: [pc(items)], monsters: [mon('o', 'orc', 1), mon('g', 'goblin', 2)],
  scene: { cols: 10, rows: 8 }, iterations: 40, seed: 5
});
const POTIONS = { 'ri-1': { name: 'Potion of Healing', effect: 'potion-of-healing', max: 2 } };

test('runItemsLedger: a run-item map or a run-item list → fresh resources.items; empty → null', () => {
  assert.deepEqual(runItemsLedger(POTIONS), { 'ri-1': { name: 'Potion of Healing', effect: 'potion-of-healing', max: 2, spent: 0 } });
  assert.deepEqual(runItemsLedger([{ id: 7, name: 'Potion of Greater Healing', qty: 3 }, { id: 8, name: 'Rope', qty: 1 }]),
    { 7: { name: 'Potion of Greater Healing', effect: 'potion-of-greater-healing', max: 3, spent: 0 } });
  assert.equal(runItemsLedger(null), null);
  assert.equal(runItemsLedger({}), null);
  assert.notEqual(runItemsLedger(POTIONS)['ri-1'], runItemsLedger(POTIONS)['ri-1']);
});

test('simulateEncounter: a party entry with items drinks them, from a fresh ledger every iteration', async () => {
  const input = encounter(POTIONS);
  let used = 0;
  let iterations = 0;
  const stats = await simulateEncounter({
    ...input,
    onIterationEnd: ({ pcs }) => {
      iterations++;
      const spent = pcs[0]._items['ri-1'].spent;
      assert.ok(spent >= 0 && spent <= 2, 'never more than the two carried');
      used += spent;
    }
  });
  assert.equal(iterations, 40);
  assert.ok(used > 0, 'potions are drunk');
  assert.deepEqual(input.party[0].items, POTIONS, 'the input is not mutated');
  assert.equal(POTIONS['ri-1'].spent, undefined);
  // Deterministic for a seed; different from the potion-less party.
  assert.deepEqual(await simulateEncounter(encounter(POTIONS)), stats);
  assert.notDeepEqual(await simulateEncounter(encounter(null)), stats);
});

test('simulateEncounter: without items no PC wrapper carries _items; the calibrator sees the items', async () => {
  await simulateEncounter({ ...encounter(null), iterations: 3, onIterationEnd: ({ pcs }) => assert.equal('_items' in pcs[0], false) });
  const listForm = [{ id: 'ri-1', name: 'Potion of Healing', qty: 2 }];
  assert.deepEqual(await simulateEncounter(encounter(listForm)), await simulateEncounter(encounter(POTIONS)), 'list and map forms agree');
  const withPotions = await calibrateEncounter({ ...encounter(POTIONS), iterations: 20 });
  const without = await calibrateEncounter({ ...encounter(null), iterations: 20 });
  assert.notDeepEqual(withPotions, without);
});
