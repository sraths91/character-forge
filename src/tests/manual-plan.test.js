import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRangedWeapon, buildWeaponPlan, buildCastPlan } from '../js/client/legacy/manual-plan.js';

test('manual-plan: isRangedWeapon matches bows, slings, crossbows, darts, javelins, throwing', () => {
  for (const name of ['Longbow', 'Light Crossbow', 'Sling', 'Dart', 'Javelin', 'Throwing Axe', 'Shortbow']) {
    assert.equal(isRangedWeapon({ name }), true, name);
  }
  for (const name of ['Longsword', 'Mace', 'Greataxe', 'Dagger']) {
    assert.equal(isRangedWeapon({ name }), false, name);
  }
  assert.equal(isRangedWeapon(null), false);
});

test('manual-plan: buildWeaponPlan — ranged weapon yields kind ranged, melee otherwise', () => {
  const bow = { name: 'Longbow' };
  const ranged = buildWeaponPlan({ weapon: bow, targetId: 'g1' });
  assert.equal(ranged.kind, 'ranged');
  assert.equal(ranged.weapon, bow);
  assert.equal(ranged.targetId, 'g1');
  assert.equal(ranged.targetSide, 'enemy');
  assert.equal(ranged.archetype, 'manual');
  assert.deepEqual(ranged.featuresFired, []);
  assert.equal(buildWeaponPlan({ weapon: { name: 'Longsword' }, targetId: 'g1' }).kind, 'melee');
  assert.equal(buildWeaponPlan({ weapon: null, targetId: 'g1' }).kind, 'melee');
});

test('manual-plan: buildCastPlan — heal targets an ally', () => {
  const plan = buildCastPlan({ spell: { name: 'Cure Wounds' }, targetId: 'p2' });
  assert.equal(plan.kind, 'cast');
  assert.equal(plan.spellId, 'cure-wounds');
  assert.equal(plan.targetSide, 'ally');
  assert.equal(plan.targetId, 'p2');
  assert.equal(plan.weapon, null);
  assert.ok(plan.castAtLevel >= 1);
});

test('manual-plan: buildCastPlan — damage spell targets an enemy; id and castAtLevel honoured', () => {
  const plan = buildCastPlan({ spell: { id: 'magic-missile', castAtLevel: 3 }, targetId: 'g1' });
  assert.equal(plan.spellId, 'magic-missile');
  assert.equal(plan.targetSide, 'enemy');
  assert.equal(plan.castAtLevel, 3);
});

test('manual-plan: buildCastPlan — unregistered spell returns null', () => {
  assert.equal(buildCastPlan({ spell: { name: 'Homebrew Doom Ray' }, targetId: 'g1' }), null);
  assert.equal(buildCastPlan({ spell: { name: '' }, targetId: 'g1' }), null);
  assert.equal(buildCastPlan({ spell: null, targetId: 'g1' }), null);
});
