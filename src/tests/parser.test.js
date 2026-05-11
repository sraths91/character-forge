import { test } from 'node:test';
import assert from 'node:assert';
import { parseCharacter } from '../../api/lib/ddb-parser.js';

const itemDef = (name, extra = {}) => ({
  definition: {
    name, type: 'Weapon', filterType: 'Weapon',
    properties: [], ...extra
  },
  equipped: true
});

test('captures three weapons; first goes to mainhand, others to overflow', () => {
  const raw = {
    id: 1, name: 'Test',
    classes: [{ level: 1, definition: { name: 'Fighter' } }],
    stats: [], inventory: [
      itemDef('Warhammer'),
      itemDef('Shortsword'),
      itemDef('Hand Crossbow', { properties: [{ name: 'Loading' }] })
    ]
  };
  const c = parseCharacter(raw);
  assert.strictEqual(c.equipment.mainhand.name, 'Warhammer');
  assert.strictEqual(c.carried.length, 3);
  const overflow = c.carried.filter(x => x.slot === 'overflow');
  assert.strictEqual(overflow.length, 2);
  assert.deepStrictEqual(overflow.map(o => o.name).sort(), ['Hand Crossbow', 'Shortsword']);
});

test('shield in offhand still works alongside mainhand weapon', () => {
  const raw = {
    id: 1, name: 'Test', classes: [], stats: [], inventory: [
      itemDef('Longsword'),
      { equipped: true, definition: { name: 'Shield', type: 'Armor', filterType: 'Armor', subType: 'Shield' } }
    ]
  };
  const c = parseCharacter(raw);
  assert.strictEqual(c.equipment.mainhand.name, 'Longsword');
  assert.strictEqual(c.equipment.offhand.name, 'Shield');
  assert.ok(c.carried.every(x => x.slot !== 'overflow'));
});

test('two-handed mainhand records overwrite-overflow correctly', () => {
  const raw = {
    id: 1, name: 'Test', classes: [], stats: [], inventory: [
      itemDef('Greatsword', { properties: [{ name: 'Two-Handed' }] }),
      itemDef('Shortsword')
    ]
  };
  const c = parseCharacter(raw);
  assert.strictEqual(c.equipment.mainhand.name, 'Greatsword');
  assert.strictEqual(c.equipment.mainhand.twoHanded, true);
  assert.strictEqual(c.equipment.offhand, null);
  const ss = c.carried.find(x => x.name === 'Shortsword');
  assert.strictEqual(ss.slot, 'overflow');
});
