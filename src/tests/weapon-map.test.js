/**
 * Roster upgrade — weapon→mesh + smarter archetype selection.
 *
 * Fixtures are shaped like real ddb-parser output (see api/lib/ddb-parser.js
 * parseClasses / parseEquipment): `classes:[{name,level,subclass}]`,
 * `equipment.{mainhand,offhand,armor}` where each item is `{name, twoHanded?}`.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { weaponMeshForCharacter, MESH_GAPS } from '../js/anim/weapon-map.js';
import { archetypeForCharacter, archetypePreferences, BASE_ARCHETYPES } from '../js/anim/archetype-select.js';

// ---------------------------------------------------------------------------
// Realistic fixtures
// ---------------------------------------------------------------------------

const warhammerCleric = {
  name: 'Brother Doran',
  race: { name: 'Mountain Dwarf' },
  classes: [{ name: 'Cleric', level: 6, subclass: 'War Domain' }],
  equipment: { armor: { name: 'Chain Mail' }, mainhand: { name: 'Warhammer' }, offhand: { name: 'Shield' } }
};

const greataxeBarbarian = {
  name: 'Grosh',
  race: { name: 'Half-Orc' },
  classes: [{ name: 'Barbarian', level: 5, subclass: 'Path of the Berserker' }],
  equipment: { armor: null, mainhand: { name: 'Greataxe', twoHanded: true }, offhand: null }
};

const rapierRogue = {
  name: 'Vex',
  race: { name: 'Wood Elf' },
  classes: [{ name: 'Rogue', level: 4, subclass: 'Assassin' }],
  equipment: { armor: { name: 'Studded Leather' }, mainhand: { name: 'Rapier' }, offhand: null }
};

const longbowRanger = {
  name: 'Kael',
  race: { name: 'Human' },
  classes: [{ name: 'Ranger', level: 5, subclass: 'Hunter' }],
  equipment: { armor: { name: 'Leather Armor' }, mainhand: { name: 'Longbow', twoHanded: true }, offhand: null }
};

const staffWizard = {
  name: 'Alaric',
  race: { name: 'High Elf' },
  classes: [{ name: 'Wizard', level: 7, subclass: 'School of Evocation' }],
  equipment: { armor: null, mainhand: { name: 'Quarterstaff' }, offhand: null }
};

const unarmedMonk = {
  name: 'Li',
  race: { name: 'Human' },
  classes: [{ name: 'Monk', level: 5, subclass: 'Way of the Open Hand' }],
  equipment: { armor: null, mainhand: null, offhand: null }
};

// ---------------------------------------------------------------------------
// weaponMeshForCharacter — the ACTUAL equipped weapon drives the mesh
// ---------------------------------------------------------------------------

test('warhammer cleric: knight-ish archetype, faithful hammer mesh, shield in off hand', () => {
  const sel = weaponMeshForCharacter(warhammerCleric);
  assert.strictEqual(sel.archetype, 'knight', 'armoured cleric → knight');
  assert.strictEqual(sel.meshKey, 'hammer', 'warhammer → faithful hammer mesh (blunt gap closed)');
  assert.strictEqual(sel.placeholder, false);
  assert.strictEqual(sel.gap, null);
  assert.strictEqual(sel.source, 'weapon');
  assert.ok(sel.offhand && /shield_round/.test(sel.offhand.url), 'shield attaches to the off hand');
});

test('greataxe barbarian: barbarian archetype holds a real axe (2H, no shield)', () => {
  const sel = weaponMeshForCharacter(greataxeBarbarian);
  assert.strictEqual(sel.archetype, 'barbarian');
  assert.strictEqual(sel.meshKey, 'axe_2handed', 'greataxe → faithful axe mesh');
  assert.strictEqual(sel.placeholder, false, 'axe is a true match, not a placeholder');
  assert.strictEqual(sel.gap, null);
  assert.strictEqual(sel.mesh.twoHanded, true);
  assert.strictEqual(sel.offhand, null, 'two-handed weapon → no shield');
  assert.match(sel.attack, /Chop/);
});

test('rapier rogue: rogue archetype but holds a BLADE (not the default dagger)', () => {
  const sel = weaponMeshForCharacter(rapierRogue);
  assert.strictEqual(sel.archetype, 'rogue');
  assert.strictEqual(sel.motion, 'sword-thrust', 'rapier → thrust motion (app taxonomy)');
  assert.strictEqual(sel.meshKey, 'sword_1handed', 'weapon wins over the archetype default dagger');
  assert.strictEqual(sel.placeholder, false);
  assert.strictEqual(sel.source, 'weapon');
  assert.match(sel.attack, /Stab/);
});

test('longbow ranger: rogue-collapsed archetype, faithful bow mesh (ranged gap closed)', () => {
  const sel = weaponMeshForCharacter(longbowRanger);
  assert.strictEqual(sel.archetype, 'rogue', 'ranger collapses to rogue in the base roster');
  assert.strictEqual(sel.motion, 'bow-draw');
  assert.strictEqual(sel.gap, null, 'bow mesh now exists');
  assert.strictEqual(sel.source, 'weapon');
  assert.strictEqual(sel.placeholder, false);
  assert.strictEqual(sel.meshKey, 'bow', 'longbow → faithful bow mesh');
});

test('staff wizard: mage archetype holds a real staff, no placeholder', () => {
  const sel = weaponMeshForCharacter(staffWizard);
  assert.strictEqual(sel.archetype, 'mage');
  assert.strictEqual(sel.meshKey, 'staff', 'quarterstaff → true staff mesh');
  assert.strictEqual(sel.placeholder, false, 'a quarterstaff genuinely IS a staff — not a gap');
  assert.strictEqual(sel.gap, null);
});

test('unarmed monk: rogue-collapsed archetype, empty hands (no mesh)', () => {
  const sel = weaponMeshForCharacter(unarmedMonk);
  assert.strictEqual(sel.archetype, 'rogue', 'monk collapses to rogue in the base roster');
  assert.strictEqual(sel.meshKey, null, 'no weapon → empty hands');
  assert.strictEqual(sel.mesh, null);
  assert.strictEqual(sel.source, 'empty');
  assert.strictEqual(sel.offhand, null);
});

// ---------------------------------------------------------------------------
// archetypeForCharacter — smarter than primary-class-only
// ---------------------------------------------------------------------------

test('armour disambiguates two clerics: chain-mail → knight, robed → mage', () => {
  const armoredCleric = warhammerCleric;
  const robedCleric = {
    classes: [{ name: 'Cleric', level: 6, subclass: 'Arcana Domain' }],
    equipment: { armor: null, mainhand: { name: 'Quarterstaff' } }
  };
  assert.strictEqual(archetypeForCharacter(armoredCleric), 'knight');
  assert.strictEqual(archetypeForCharacter(robedCleric), 'mage');
});

test('multiclass uses the highest-level class, not classes[0]', () => {
  const gishBladeMostlyWizard = {
    classes: [
      { name: 'Fighter', level: 1, subclass: null },
      { name: 'Wizard', level: 9, subclass: 'School of Evocation' }
    ],
    equipment: { armor: null, mainhand: { name: 'Dagger' } }
  };
  assert.strictEqual(archetypeForCharacter(gishBladeMostlyWizard), 'mage');
});

test('forward compat: a richer roster is used when present, else it degrades', () => {
  // Only the base four loaded → armoured cleric collapses to knight.
  assert.strictEqual(archetypeForCharacter(warhammerCleric), 'knight');
  // A `cleric` model has landed → the same character now maps to it.
  const withCleric = new Set([...BASE_ARCHETYPES, 'cleric', 'paladin', 'ranger']);
  assert.strictEqual(archetypeForCharacter(warhammerCleric, { available: withCleric }), 'cleric');
  assert.strictEqual(archetypeForCharacter(longbowRanger, { available: withCleric }), 'ranger');
});

test('archetypePreferences always terminates in a base-four key', () => {
  for (const fx of [warhammerCleric, greataxeBarbarian, rapierRogue, longbowRanger, staffWizard, unarmedMonk]) {
    const prefs = archetypePreferences(fx);
    assert.ok(prefs.some(k => BASE_ARCHETYPES.has(k)), `no base fallback for ${fx.classes[0].name}`);
  }
});

test('weaponMeshForCharacter never throws on empty / malformed input', () => {
  for (const c of [{}, { equipment: {} }, { classes: [] }, { equipment: { mainhand: {} } }]) {
    const sel = weaponMeshForCharacter(c);
    assert.ok(sel && typeof sel.archetype === 'string');
  }
});

test('MESH_GAPS documents the remaining missing weapon-type family (polearm)', () => {
  assert.ok(MESH_GAPS.polearm, 'polearm still has no faithful mesh');
  // blunt + ranged are now filled by the hammer + bow meshes
  assert.strictEqual(MESH_GAPS.blunt, undefined);
  assert.strictEqual(MESH_GAPS.ranged, undefined);
});
