import { test } from 'node:test';
import assert from 'node:assert';
import { assignCarriedSlots } from '../js/sprite/slot-overrides.js';

const baseChar = () => ({
  id: '999',
  name: 'Test',
  equipment: {
    mainhand: { name: 'Longsword', rarity: 'Common', magical: false },
    offhand:  { name: 'Shield',    rarity: 'Common', magical: false },
    armor: null
  },
  carried: [
    { name: 'Longsword',  slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common', magical: false },
    { name: 'Shield',     slot: 'offhand',  inferredSlot: 'offhand',  twoHanded: false, rarity: 'Common', magical: false },
    { name: 'Shortsword', slot: 'overflow', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common', magical: false },
    { name: 'Greatsword', slot: 'overflow', inferredSlot: 'mainhand-twohanded', twoHanded: true,  rarity: 'Common', magical: false }
  ]
});

test('empty overrides triggers auto-fill into back/waist', () => {
  const out = assignCarriedSlots(baseChar(), {});
  // First overflow weapon (in carried order) → back. Shortsword is first overflow.
  assert.strictEqual(out.carried.find(c => c.name === 'Shortsword').slot, 'back');
  // Greatsword stays overflow because waist requires non-two-handed
  assert.strictEqual(out.carried.find(c => c.name === 'Greatsword').slot, 'overflow');
});

test('explicit null clears mainhand and demotes occupant (may auto-fill onto back)', () => {
  const out = assignCarriedSlots(baseChar(), { mainhand: null });
  assert.strictEqual(out.equipment.mainhand, null);
  // Longsword is no longer in mainhand. Back auto-fill (back not overridden)
  // picks the first overflow weapon, which is Longsword.
  assert.notStrictEqual(out.carried.find(c => c.name === 'Longsword').slot, 'mainhand');
});

test('reassign Shortsword to mainhand demotes Longsword', () => {
  const out = assignCarriedSlots(baseChar(), { mainhand: 'Shortsword' });
  assert.strictEqual(out.equipment.mainhand.name, 'Shortsword');
  assert.strictEqual(out.carried.find(c => c.name === 'Shortsword').slot, 'mainhand');
  // Longsword is no longer in mainhand (back auto-fill may pick it up)
  assert.notStrictEqual(out.carried.find(c => c.name === 'Longsword').slot, 'mainhand');
});

test('assign two-handed Greatsword to mainhand clears offhand and demotes shield', () => {
  const out = assignCarriedSlots(baseChar(), { mainhand: 'Greatsword' });
  assert.strictEqual(out.equipment.mainhand.name, 'Greatsword');
  assert.strictEqual(out.equipment.mainhand.twoHanded, true);
  assert.strictEqual(out.equipment.offhand, null);
  assert.strictEqual(out.carried.find(c => c.name === 'Shield').slot, 'overflow');
});

test('explicit back override beats auto-fill for that slot', () => {
  // Override back=Longsword: Longsword moves from mainhand to back.
  // mainhand becomes empty (rev-3 prevSlot fix).
  // Auto-fill back is suppressed (back is touched).
  // Auto-fill into waist still runs since waist is untouched.
  const out = assignCarriedSlots(baseChar(), { back: 'Longsword' });
  assert.strictEqual(out.carried.find(c => c.name === 'Longsword').slot, 'back');
  assert.strictEqual(out.equipment.mainhand, null);
  // First non-two-handed overflow = Shortsword → waist
  assert.strictEqual(out.carried.find(c => c.name === 'Shortsword').slot, 'waist');
});

test('override naming a no-longer-carried item: slot is cleared, no replacement', () => {
  const out = assignCarriedSlots(baseChar(), { mainhand: 'NonexistentSword' });
  // Mainhand cleared
  assert.strictEqual(out.equipment.mainhand, null);
  // NonexistentSword wasn't materialised into carried[]
  assert.ok(!out.carried.some(c => c.name === 'NonexistentSword'));
  // The demoted Longsword is NOT still in mainhand. It may end up on
  // back via auto-fill (since back wasn't overridden) — that's expected.
  const longsword = out.carried.find(c => c.name === 'Longsword');
  assert.notStrictEqual(longsword.slot, 'mainhand');
});

test('does not mutate the input character', () => {
  const c = baseChar();
  const before = JSON.stringify(c);
  assignCarriedSlots(c, { mainhand: 'Shortsword' });
  assert.strictEqual(JSON.stringify(c), before);
});

test('moving item from mainhand to back clears equipment.mainhand (rev-3 critical fix)', () => {
  const out = assignCarriedSlots(baseChar(), { back: 'Longsword' });
  assert.strictEqual(out.equipment.mainhand, null,
    'equipment.mainhand must be cleared when its occupant is moved to back');
  assert.strictEqual(out.carried.find(c => c.name === 'Longsword').slot, 'back');
});

test('moving item from offhand to back clears equipment.offhand', () => {
  const out = assignCarriedSlots(baseChar(), { back: 'Shield' });
  assert.strictEqual(out.equipment.offhand, null,
    'equipment.offhand must be cleared when its occupant is moved to back');
  assert.strictEqual(out.carried.find(c => c.name === 'Shield').slot, 'back');
});
