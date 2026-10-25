// M65 R27 — items, equipment, attunement, pricing, potions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ITEM_ORIGINS, MAX_ATTUNED, MAX_RINGS, EQUIPMENT_SLOTS, itemToEquipment, priceOf, makeItem,
  itemsFromInventory, itemFromOpen5e, equipItem, unequipItem, attuneItem, purseToCp, addCurrency, payFromPurse
} from '../js/campaign/items.js';
import { POTIONS, potionFor, itemEffectOf, itemsLedgerFor, rollPotion, drinkPotion } from '../js/campaign/consumables.js';
import { CampaignRuleError } from '../js/campaign/errors.js';
import { deriveAC, deriveWeaponAttack } from '../js/scene/pc-stats.js';
import { createRng } from '../js/scene/rng.js';
import { parsedDdbFixture } from './helpers/entities.js';
import { restedState } from './helpers/campaign-state.js';

const item = (key) => JSON.parse(readFileSync(new URL(`./fixtures/open5e-items/${key}.json`, import.meta.url), 'utf8'));
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof CampaignRuleError && e.code === code);

/** The fixture fighter with DEX 16 (+3) and its DDB inventory as run items. */
function dexFighter() {
  const sheet = parsedDdbFixture('fighter-l5');
  sheet.abilityScores = { ...sheet.abilityScores, DEX: 16 };
  sheet.abilityModifiers = { ...sheet.abilityModifiers, DEX: 3 };
  return { sheet, items: itemsFromInventory(sheet, { ownerSlotId: 'slot-1' }) };
}

test('constants', () => {
  assert.deepEqual([...ITEM_ORIGINS], ['ddb', 'open5e', 'dm']);
  assert.equal(MAX_ATTUNED, 3);
  assert.equal(MAX_RINGS, 2);
  assert.ok(EQUIPMENT_SLOTS.includes('armor'));
});

test('itemToEquipment: Open5e armour, shield and weapons → the parser shape', () => {
  assert.deepEqual(itemToEquipment(item('srd_breastplate')), {
    name: 'Breastplate', rarity: 'Common', magical: false, attuned: false,
    armorClass: 14, damage: null, damageType: null, armorTypeId: 2
  });
  assert.equal(itemToEquipment(item('srd_chain-mail')).armorTypeId, 3);
  assert.deepEqual(itemToEquipment(item('srd_shield')), {
    name: 'Shield', rarity: 'Common', magical: false, attuned: false, armorClass: 2, damage: null, damageType: null, armorTypeId: 4
  });
  const ls = itemToEquipment(item('srd_longsword'));
  assert.equal(ls.damage, '1d8');
  assert.equal(ls.damageType, 'Slashing');
  assert.deepEqual(ls.properties, ['versatile']);
  assert.equal(ls.versatileDamage, '1d10');
  assert.equal(ls.attackType, 1);
  assert.equal(ls.weaponCategory, 'martial');
  assert.equal(ls.weaponType, 'longsword');
  const dagger = itemToEquipment(item('srd_dagger'));
  assert.deepEqual(dagger.properties, ['finesse', 'light', 'thrown']);
  assert.deepEqual([dagger.range, dagger.longRange], [20, 60]);
  assert.equal(dagger.isMonkWeapon, true);
  const bow = itemToEquipment(item('srd_longbow'));
  assert.equal(bow.attackType, 2);
  assert.deepEqual([bow.range, bow.longRange], [150, 600]);
  assert.equal(bow.twoHanded, true);
  assert.equal(itemToEquipment(item('srd_potion-of-healing')), null);
  assert.equal(itemToEquipment(null), null);
});

test('equipping an Open5e Breastplate at DEX +3 → deriveAC 16 (medium caps DEX at +2)', () => {
  const { sheet, items } = dexFighter();
  const plate = itemFromOpen5e(item('srd_breastplate'), { id: 'bp', ownerSlotId: 'slot-1' });
  assert.equal(plate.data.slot, 'armor');
  const before = deriveAC(sheet);
  assert.equal(before, 18, 'chain mail 16 + shield 2');
  const r = equipItem(sheet, [...items, plate], 'bp');
  assert.equal(r.sheet.equipment.armor.name, 'Breastplate');
  assert.equal(deriveAC(r.sheet), 14 + 2 + 2, 'breastplate 14 + DEX (max 2) + shield');
  const noShield = unequipItem(r.sheet, r.items, items.find(i => i.name === 'Shield').id);
  assert.equal(deriveAC(noShield.sheet), 16);
  // The chain mail came off; the sprite view follows.
  assert.equal(r.items.find(i => i.name === 'Chain Mail').equipped, false);
  assert.deepEqual(r.unequipped, [items.find(i => i.name === 'Chain Mail').id]);
  assert.ok(r.sheet.carried.some(c => c.name === 'Breastplate' && c.slot === 'armor'));
  assert.ok(!r.sheet.carried.some(c => c.name === 'Chain Mail'));
  assert.equal(sheet.equipment.armor.name, 'Chain Mail', 'input sheet not mutated');
});

test('an unequipped DDB item is equippable later and re-derived by pc-stats (two-handed frees the off hand)', () => {
  const { sheet, items } = dexFighter();
  const bow = items.find(i => i.name === 'Longbow');
  assert.equal(bow.equipped, false);
  assert.equal(bow.refKey, 'ddb:7004');
  const r = equipItem(sheet, items, bow.id);
  assert.equal(r.sheet.equipment.mainhand.name, 'Longbow');
  assert.equal(r.sheet.equipment.offhand, null, 'two-handed bow takes both hands');
  assert.equal(r.items.find(i => i.name === 'Shield').equipped, false);
  assert.equal(r.items.find(i => i.name === 'Longsword').equipped, false);
  const atk = deriveWeaponAttack(r.sheet, r.sheet.equipment.mainhand);
  assert.equal(atk.ranged, true);
  assert.equal(atk.ability, 'DEX');
  assert.deepEqual(atk.range, { normal: 150, long: 600 });
  // Shield back on: the two-handed bow comes off.
  const back = equipItem(r.sheet, r.items, items.find(i => i.name === 'Shield').id);
  assert.equal(back.sheet.equipment.mainhand, null);
  assert.equal(back.items.find(i => i.name === 'Longbow').equipped, false);
});

test('equip rules: off-hand light weapon, rings max 2, non-equippables, quantity 0', () => {
  const { sheet } = dexFighter();
  const dagger = itemFromOpen5e(item('srd_dagger'), { id: 'dg' });
  throwsCode(() => equipItem(sheet, [dagger], 'dg', { slot: 'armor' }), 'not-equippable');
  const bow = itemFromOpen5e(item('srd_longbow'), { id: 'lb' });
  throwsCode(() => equipItem(sheet, [bow], 'lb', { slot: 'offhand' }), 'not-equippable');
  const off = equipItem({ ...sheet, equipment: { ...sheet.equipment, offhand: null } }, [dagger], 'dg', { slot: 'offhand' });
  assert.equal(off.sheet.equipment.offhand.name, 'Dagger');
  const rings = [1, 2, 3].map(n => makeItem({ id: `r${n}`, origin: 'dm', name: `Ring of Test ${n}`, data: { slot: 'ring' } }));
  let s = { sheet, items: rings };
  s = equipItem(s.sheet, s.items, 'r1');
  s = equipItem(s.sheet, s.items, 'r2');
  throwsCode(() => equipItem(s.sheet, s.items, 'r3'), 'rings-full');
  const un = unequipItem(s.sheet, s.items, 'r1');
  assert.deepEqual(un.sheet.equipment.rings.map(r => r.name), ['Ring of Test 2']);
  const potion = itemFromOpen5e(item('srd_potion-of-healing'), { id: 'p' });
  throwsCode(() => equipItem(sheet, [potion], 'p'), 'not-equippable');
  throwsCode(() => equipItem(sheet, [], 'x'), 'no-item');
  throwsCode(() => equipItem(sheet, [{ ...dagger, qty: 0 }], 'dg'), 'no-quantity');
  // Unequipping something not equipped is a no-op.
  assert.deepEqual(unequipItem(sheet, [dagger], 'dg').sheet, sheet);
});

test('attunement: at most 3 per owner; flips combatMods and the equipment entry', () => {
  const sheet = parsedDdbFixture('cleric-l5');
  sheet.equipment = { ...sheet.equipment, amulet: { name: 'Amulet of the Devout, +1', attuned: false } };
  sheet.combatMods = [{ bucket: 'item', source: 'Amulet of the Devout, +1', kind: 'attack', scope: 'spell', value: 1, inactive: true, requiresAttunement: true, attuned: false }];
  const mk = (id, name, owner = 'a') => makeItem({ id, origin: 'dm', name, ownerSlotId: owner, data: { canAttune: true } });
  const items = [mk('1', 'Amulet of the Devout, +1'), mk('2', 'Cloak'), mk('3', 'Ring'), mk('4', 'Wand'), mk('5', 'Other', 'b'),
    makeItem({ id: '6', origin: 'dm', name: 'Rope', ownerSlotId: 'a' })];
  let s = attuneItem(sheet, items, '1');
  assert.equal(s.sheet.combatMods[0].inactive, false);
  assert.equal(s.sheet.equipment.amulet.attuned, true);
  s = attuneItem(s.sheet, s.items, '2');
  s = attuneItem(s.sheet, s.items, '3');
  throwsCode(() => attuneItem(s.sheet, s.items, '4'), 'attunement-full');
  assert.equal(attuneItem(s.sheet, s.items, '5').items.find(i => i.id === '5').attuned, true, 'another owner');
  throwsCode(() => attuneItem(s.sheet, s.items, '6'), 'no-attunement');
  const off = attuneItem(s.sheet, s.items, '1', false);
  assert.equal(off.sheet.combatMods[0].inactive, true);
  assert.equal(attuneItem(off.sheet, off.items, '4').items.filter(i => i.attuned).length, 3);
});

test('priceOf: Open5e cost, "0.00"/null unpriced, sell at half', () => {
  assert.deepEqual(priceOf(item('srd_potion-of-healing')), { priced: true, buyCp: 5000, sellCp: 2500, buyGp: 50, sellGp: 25 });
  assert.deepEqual(priceOf({ cost: '0.00', name: 'Acid (vial)' }), { priced: false, buyCp: null, sellCp: null, buyGp: null, sellGp: null });
  assert.equal(priceOf({ cost: null }).priced, false);
  assert.equal(priceOf('junk').priced, false);
  assert.equal(priceOf('0.01').sellCp, 0, 'a torch sells for nothing');
  assert.equal(priceOf(itemFromOpen5e(item('srd_breastplate'))).buyGp, 400);
});

test('makeItem / itemsFromInventory / itemFromOpen5e', () => {
  throwsCode(() => makeItem({ origin: 'shop', name: 'X' }), 'bad-item');
  throwsCode(() => makeItem({ origin: 'dm', name: '' }), 'bad-item');
  throwsCode(() => makeItem({ origin: 'dm', name: 'X', qty: -1 }), 'bad-item');
  const fighter = parsedDdbFixture('fighter-l5');
  const items = itemsFromInventory(fighter, { ownerSlotId: 's1' });
  assert.equal(items.length, fighter.inventory.length);
  const potion = items.find(i => i.name === 'Potion of Healing');
  assert.equal(potion.qty, 2);
  assert.equal(potion.data.potionId, 'potion-of-healing');
  assert.equal(potion.ownerSlotId, 's1');
  assert.equal(items.find(i => i.name === 'Chain Mail').equipped, true);
  const p = itemFromOpen5e(item('srd_potion-of-healing'), { qty: 3 });
  assert.equal(p.origin, 'open5e');
  assert.equal(p.refKey, 'srd_potion-of-healing');
  assert.equal(p.data.consumable, true);
  assert.equal(p.data.cost, 50);
});

test('POTIONS registry and potionFor', () => {
  assert.deepEqual(Object.values(POTIONS).map(p => p.dice), ['2d4+2', '4d4+4', '8d4+8', '10d4+20']);
  assert.equal(potionFor('Potion of Healing').id, 'potion-of-healing');
  assert.equal(potionFor({ refKey: 'srd_potion-of-greater-healing' }).dice, '4d4+4');
  assert.equal(potionFor({ key: 'srd_potion-of-healing' }).id, 'potion-of-healing');
  assert.equal(potionFor('Rope'), null);
  assert.deepEqual(itemEffectOf('Potion of Supreme Healing'), { kind: 'heal', dice: '10d4+20' });
  assert.equal(itemEffectOf({ name: 'Rope' }), null);
});

test('Potion of Healing heals 4–10 (seeded sweep); Supreme 30–60', () => {
  const rng = createRng({ s: 7 });
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const r = rollPotion(POTIONS['potion-of-healing'], rng);
    assert.ok(r.healed >= 4 && r.healed <= 10, `got ${r.healed}`);
    seen.add(r.healed);
  }
  assert.equal(seen.size, 7, 'every total 4..10 occurs');
  for (let i = 0; i < 100; i++) {
    const r = rollPotion('Potion of Supreme Healing', rng);
    assert.ok(r.healed >= 30 && r.healed <= 60);
  }
  throwsCode(() => rollPotion('Rope', rng), 'not-a-potion');
  assert.throws(() => rollPotion('Potion of Healing'), TypeError);
});

test('drinkPotion between nodes: capped at max, a downed PC stands up, the dead cannot drink', () => {
  const sheet = parsedDdbFixture('cleric-l5');
  const hurt = restedState(sheet, { hp: { current: 36, temp: 0 } });
  const r = drinkPotion(sheet, hurt, 'Potion of Healing', () => 0.99);
  assert.equal(r.state.hp.current, 38);
  assert.equal(r.healed, 2);
  assert.equal(r.rolled, 10);
  const down = restedState(sheet, { hp: { current: 0, temp: 0 }, deathSaves: { successes: 1, failures: 2, stable: false } });
  const up = drinkPotion(sheet, down, 'Potion of Healing', () => 0);
  assert.equal(up.state.hp.current, 4);
  assert.deepEqual(up.state.deathSaves, { successes: 0, failures: 0, stable: false });
  throwsCode(() => drinkPotion(sheet, down, 'Potion of Healing', () => 0, { lifeStatus: 'dead' }), 'dead');
});

test('itemsLedgerFor: the entity resources.items ledger for usable items', () => {
  const items = [
    makeItem({ id: 'p1', origin: 'ddb', name: 'Potion of Healing', qty: 2 }),
    makeItem({ id: 'p2', origin: 'dm', name: 'Potion of Greater Healing', qty: 0 }),
    makeItem({ id: 'r', origin: 'dm', name: 'Rope' })
  ];
  assert.deepEqual(itemsLedgerFor(items), { p1: { name: 'Potion of Healing', effect: { kind: 'heal', dice: '2d4+2' }, max: 2, spent: 0 } });
});

test('coin purse: total, add, pay with change', () => {
  assert.equal(purseToCp({ cp: 5, sp: 2, ep: 1, gp: 3, pp: 1 }), 5 + 20 + 50 + 300 + 1000);
  assert.deepEqual(addCurrency({ gp: 1 }, { gp: 2, sp: 5 }), { cp: 0, sp: 5, ep: 0, gp: 3, pp: 0 });
  throwsCode(() => addCurrency({ gp: 1 }, { gp: -2 }), 'insufficient-funds');
  assert.deepEqual(payFromPurse({ gp: 165 }, 5000), { cp: 0, sp: 0, ep: 0, gp: 115, pp: 0 });
  // 15 cp from 2 sp: break one silver, 5 cp change.
  assert.deepEqual(payFromPurse({ sp: 2 }, 15), { cp: 5, sp: 0, ep: 0, gp: 0, pp: 0 });
  // 1.5 gp from 1 gp + 1 pp: the platinum is broken, change in gold and silver.
  const r = payFromPurse({ gp: 1, pp: 1 }, 150);
  assert.equal(purseToCp(r), 1100 - 150);
  throwsCode(() => payFromPurse({ gp: 1 }, 101), 'insufficient-funds');
});
