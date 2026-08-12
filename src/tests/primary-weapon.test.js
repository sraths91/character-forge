import { test } from 'node:test';
import assert from 'node:assert';
import { primaryWeaponForCharacter } from '../js/anim/primary-weapon.js';

// Fixtures shaped like ddb-parser carried[] records:
//   { name, damage, damageType, twoHanded, slot, inferredSlot, magical }
const w = (name, damage, opts = {}) => ({
  name, damage, damageType: opts.damageType || null,
  twoHanded: !!opts.twoHanded,
  slot: opts.slot || 'overflow',
  inferredSlot: opts.twoHanded ? 'mainhand-twohanded' : 'mainhand',
  magical: !!opts.magical
});
const char = (carried, classes) => ({ carried, classes, equipment: { mainhand: carried.find(c => c.slot === 'mainhand') || null } });

test('Saris: warhammer wins over the shortsword sidearm + hand crossbow (damage-die rung)', () => {
  const saris = char([
    w('Shortsword', '1d6', { slot: 'mainhand' }),
    w('Warhammer', '1d8'),
    w('Hand Crossbow', '1d6')
  ], [{ name: 'Cleric', level: 5 }]);
  assert.strictEqual(primaryWeaponForCharacter(saris)?.name, 'Warhammer');
});

test('greatsword fighter: the 2H hero weapon wins over a handaxe (rung 1)', () => {
  const c = char([
    w('Handaxe', '1d6', { slot: 'mainhand' }),
    w('Greatsword', '2d6', { twoHanded: true })
  ], [{ name: 'Fighter', level: 6 }]);
  assert.strictEqual(primaryWeaponForCharacter(c)?.name, 'Greatsword');
});

test('longbow ranger: the 2H longbow wins; ranged is not demoted for a ranger', () => {
  const c = char([
    w('Shortsword', '1d6', { slot: 'mainhand' }),
    w('Longbow', '1d8', { twoHanded: true })
  ], [{ name: 'Ranger', level: 5 }]);
  assert.strictEqual(primaryWeaponForCharacter(c)?.name, 'Longbow');
});

test('staff wizard: quarterstaff (not the dagger) — caster guard spares a real weapon', () => {
  const c = char([
    w('Quarterstaff', '1d6', { slot: 'mainhand' }),
    w('Dagger', '1d4')
  ], [{ name: 'Wizard', level: 5 }]);
  assert.strictEqual(primaryWeaponForCharacter(c)?.name, 'Quarterstaff');
});

test('focus-only wizard: no weapons → null (shows a focus / empty hands)', () => {
  assert.strictEqual(primaryWeaponForCharacter(char([], [{ name: 'Wizard', level: 5 }])), null);
});

test('caster guard fires: a wizard whose only weapons are light sidearms → null', () => {
  const c = char([
    w('Dagger', '1d4', { slot: 'mainhand' }),
    w('Hand Crossbow', '1d6')
  ], [{ name: 'Wizard', level: 5 }]);
  assert.strictEqual(primaryWeaponForCharacter(c), null, 'pure caster shows a focus, not a brandished dagger');
});

test('unarmed monk: no weapons → null (empty hands)', () => {
  assert.strictEqual(primaryWeaponForCharacter(char([], [{ name: 'Monk', level: 5 }])), null);
});

// ---- regression guards: light-mainers must NOT be forced onto a heavy weapon ----

test('rapier rogue: keeps the rapier (single melee), not suppressed (rogue ≠ mage)', () => {
  const c = char([
    w('Rapier', '1d8', { slot: 'mainhand', damageType: 'Piercing' }),
    w('Dagger', '1d4')
  ], [{ name: 'Rogue', level: 5 }]);
  assert.strictEqual(primaryWeaponForCharacter(c)?.name, 'Rapier');
});

test('lone dagger rogue: a single weapon is always theirs (short-circuit before the caster guard)', () => {
  const c = char([w('Dagger', '1d4', { slot: 'mainhand' })], [{ name: 'Rogue', level: 3 }]);
  assert.strictEqual(primaryWeaponForCharacter(c)?.name, 'Dagger');
});

test('dual-wield: two identical shortswords → deterministic first-by-order (stable tiebreak)', () => {
  const a = w('Shortsword', '1d6', { slot: 'mainhand' });
  const b = w('Shortsword', '1d6');
  assert.strictEqual(primaryWeaponForCharacter(char([a, b], [{ name: 'Ranger', level: 5 }])), a);
});

test('deterministic + no throw on absent damage strings', () => {
  const c = char([
    w('Club', null, { slot: 'mainhand' }),
    w('Mace', null)
  ], [{ name: 'Cleric', level: 3 }]);
  const r = primaryWeaponForCharacter(c);
  assert.ok(r && (r.name === 'Club' || r.name === 'Mace'));
  assert.strictEqual(primaryWeaponForCharacter(c), r, 'deterministic');
});

test('magical tiebreak: among equal-damage melee, the magic weapon wins (rung 5)', () => {
  const c = char([
    w('Longsword', '1d8', { slot: 'mainhand' }),
    w('Longsword +1', '1d8', { magical: true })
  ], [{ name: 'Paladin', level: 5 }]);
  assert.strictEqual(primaryWeaponForCharacter(c)?.name, 'Longsword +1');
});
