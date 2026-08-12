import { test } from 'node:test';
import assert from 'node:assert';
import { loadoutForCharacter, canComposeModular } from '../js/anim/modular-loadout.js';

const char = ({ armor, mainhand, offhand, cls, level = 5 } = {}) => ({
  classes: [{ name: cls, level }],
  equipment: {
    armor: armor ? { name: armor } : null,
    mainhand: mainhand || null,
    offhand: offhand ? { name: offhand } : null
  }
});

test('Saris: chain-mail cleric with a promoted warhammer + shield → armoured body, hammer, shield', () => {
  const lo = loadoutForCharacter(char({
    armor: 'Chain Mail', cls: 'Cleric',
    mainhand: { name: 'Warhammer', twoHanded: false }, offhand: 'Shield'
  }));
  assert.match(lo.body.file, /Adventurer\.glb$/);      // heavy non-plate proxy
  assert.strictEqual(lo.body.prefix, 'Adventurer');
  assert.match(lo.weapon.url, /hammer_q\.glb$/, 'warhammer → hammer mesh');
  assert.strictEqual(lo.weapon.bone, 'WristR');
  assert.match(lo.shield.url, /shield\.glb$/);
  assert.strictEqual(lo.shield.bone, 'WristL');
  assert.strictEqual(lo.placeholder, true);            // metal armour is approximate
  assert.deepStrictEqual(lo.gaps, ['heavy-approx']);
});

test('plate paladin → SpaceSuit proxy (steel), flagged plate-approx', () => {
  const lo = loadoutForCharacter(char({
    armor: 'Plate', cls: 'Paladin', mainhand: { name: 'Longsword' }, offhand: 'Shield'
  }));
  assert.match(lo.body.file, /SpaceSuit\.glb$/);
  assert.strictEqual(lo.body.prefix, 'SpaceSuit', 'runtime-confirmed prefix, not Astronaut');
  assert.strictEqual(lo.tint, '#b9c2cc');
  assert.deepStrictEqual(lo.gaps, ['plate-approx']);
  assert.match(lo.weapon.url, /sword\.glb$/);
});

test('robed wizard with a quarterstaff → King body, staff, no shield', () => {
  const lo = loadoutForCharacter(char({
    cls: 'Wizard', mainhand: { name: 'Quarterstaff' }
  }));
  assert.match(lo.body.file, /King\.glb$/);
  assert.strictEqual(lo.tint, '#3a2f6b');              // wizard indigo
  assert.match(lo.weapon.url, /staff\.glb$/);
  assert.strictEqual(lo.shield, null);
  assert.strictEqual(lo.placeholder, false);           // robe is faithful
});

test('leather rogue with a dagger → Adventurer, dagger, faithful (no placeholder)', () => {
  const lo = loadoutForCharacter(char({
    armor: 'Leather Armor', cls: 'Rogue', mainhand: { name: 'Dagger' }
  }));
  assert.match(lo.body.file, /Adventurer\.glb$/);
  assert.strictEqual(lo.tint, '#6b4a2b');
  assert.match(lo.weapon.url, /dagger\.glb$/);
  assert.strictEqual(lo.placeholder, false);
});

test('two-handed weapon suppresses the shield', () => {
  const lo = loadoutForCharacter(char({
    armor: 'Plate', cls: 'Fighter', mainhand: { name: 'Greatsword', twoHanded: true }, offhand: 'Shield'
  }));
  assert.strictEqual(lo.shield, null, '2H → no shield even if one is carried');
});

test('unarmed / no weapon → weapon null (empty hands)', () => {
  const lo = loadoutForCharacter(char({ cls: 'Monk' }));
  assert.strictEqual(lo.weapon, null);
});

test('clips are the shared Quaternius names; canComposeModular holds for the 8-body set', () => {
  const c = char({ armor: 'Leather Armor', cls: 'Ranger', mainhand: { name: 'Shortbow' } });
  const lo = loadoutForCharacter(c);
  assert.strictEqual(lo.clips.idle, 'Idle');
  assert.strictEqual(lo.clips.attack, 'Sword_Slash');
  assert.match(lo.weapon.url, /bow_q\.glb$/);
  assert.strictEqual(canComposeModular(c), true);
});
