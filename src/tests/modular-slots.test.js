import { test } from 'node:test';
import assert from 'node:assert';
import { loadoutForCharacter, canComposeModular, nodeFor } from '../js/anim/modular-loadout.js';
import { sanitizeName, matchesNode } from '../js/anim/modular-viewer.js';

const char = ({ armor, mainhand, offhand, helm, cls, level = 5 } = {}) => ({
  classes: [{ name: cls, level }],
  equipment: {
    armor: armor ? { name: armor } : null,
    mainhand: mainhand || null,
    offhand: offhand ? { name: offhand } : null,
    helm: helm ? { name: helm } : null
  }
});
const slotOf = (lo, which) => lo.slots.find(s => s.which === which);

// ---------- nodeFor (exact node names, incl. Farmer exception) ----------

test('nodeFor: reconstructs prefix_Cap, with Farmer legs = Farmer_Pants', () => {
  assert.strictEqual(nodeFor('King', 'head'), 'King_Head');
  assert.strictEqual(nodeFor('Adventurer', 'body'), 'Adventurer_Body');
  assert.strictEqual(nodeFor('Farmer', 'legs'), 'Farmer_Pants');   // the exception
  assert.strictEqual(nodeFor('Farmer', 'feet'), 'Farmer_Feet');
});

// ---------- the per-slot array ----------

test('no helm: all 4 slots come from the body → nothing to graft (true no-op)', () => {
  const lo = loadoutForCharacter(char({ armor: 'Chain Mail', cls: 'Cleric', mainhand: { name: 'Warhammer' } }));
  assert.strictEqual(lo.slots.length, 4);
  for (const w of ['body', 'legs', 'feet', 'head']) {
    assert.strictEqual(slotOf(lo, w).file, lo.base, `${w} slot is the base body`);
  }
  assert.strictEqual(slotOf(lo, 'head').tint, null, 'head is never tinted');
  assert.strictEqual(slotOf(lo, 'body').node, 'Adventurer_Body');
});

test('crown helm: only the HEAD slot cross-donors to King (the graftable case)', () => {
  const lo = loadoutForCharacter(char({ armor: 'Plate', cls: 'Paladin', helm: 'Crown of Command', mainhand: { name: 'Longsword' } }));
  assert.match(slotOf(lo, 'body').file, /SpaceSuit\.glb$/);        // plate proxy body
  const head = slotOf(lo, 'head');
  assert.match(head.file, /King\.glb$/, 'crown → King head donor');
  assert.strictEqual(head.node, 'King_Head');
  assert.notStrictEqual(head.file, lo.base, 'head differs from base → engine grafts it');
});

test('great-helm: head → SpaceSuit proxy, flagged helm-approx', () => {
  const lo = loadoutForCharacter(char({ armor: 'Leather Armor', cls: 'Fighter', helm: 'Steel Helmet', mainhand: { name: 'Longsword' } }));
  assert.match(slotOf(lo, 'head').file, /SpaceSuit\.glb$/);
  assert.ok(lo.gaps.includes('helm-approx'));
  assert.strictEqual(lo.placeholder, true);
});

test('wizard hat: no mesh yet → keeps body head + wizard-hat gap', () => {
  const lo = loadoutForCharacter(char({ cls: 'Wizard', helm: 'Wizard Hat', mainhand: { name: 'Quarterstaff' } }));
  assert.strictEqual(slotOf(lo, 'head').file, lo.base, 'no wizard-hat mesh → body head');
  assert.ok(lo.gaps.includes('wizard-hat'));
});

test('gaps aggregate across body + head; canComposeModular holds', () => {
  const lo = loadoutForCharacter(char({ armor: 'Plate', cls: 'Fighter', helm: 'Great Helm' }));
  // plate body (plate-approx) + great-helm (helm-approx), deduped
  assert.ok(lo.gaps.includes('plate-approx'));
  assert.ok(lo.gaps.includes('helm-approx'));
  assert.strictEqual(lo.gaps.length, new Set(lo.gaps).size, 'no duplicate gaps');
  assert.strictEqual(canComposeModular(char({ armor: 'Plate', cls: 'Fighter' })), true);
});

// ---------- viewer pure helpers (node matching, no WebGL) ----------

test('sanitizeName strips dots/underscores, lowercases', () => {
  assert.strictEqual(sanitizeName('Wrist.R'), 'wristr');
  assert.strictEqual(sanitizeName('King_Body_1'), 'kingbody1');
});

test('matchesNode: exact + multi-primitive startsWith, but not a sibling slot', () => {
  assert.strictEqual(matchesNode('King_Body', 'King_Body'), true);      // Group exact
  assert.strictEqual(matchesNode('King_Body_3', 'King_Body'), true);    // multi-primitive child
  assert.strictEqual(matchesNode('SpaceSuit_Head_2', 'SpaceSuit_Head'), true);
  assert.strictEqual(matchesNode('King_Legs_1', 'King_Body'), false);   // sibling slot
  assert.strictEqual(matchesNode('Backpack', 'Adventurer_Body'), false);// stray never matches a slot
});
