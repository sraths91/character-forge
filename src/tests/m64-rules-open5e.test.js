/**
 * M64 R11 — Open5e stat-block normaliser against 21 stored SRD payloads.
 * Expected numbers are the SRD 5.1 stat blocks, not Open5e's structured
 * attack fields (which are wrong; see fixtures/open5e/README.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  normalizeCreature, engineAttacksFrom, withEngineFields, isNormalizedStatBlock,
  parseMultiattack, proficiencyForCr, OPEN5E_SOURCE, DAMAGE_TYPES, CONDITION_NAMES
} from '../js/scene/open5e-normalize.js';
import * as apiOpen5e from '../../api/lib/open5e.js';
import { entityFromPreset, entityFromSheet, toEngineSides, applyEngineSides } from '../js/scene/encounter-adapters.js';
import { emptyEncounterState, validateEncounterState } from '../js/shared/encounter-state.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { parsedDdbFixture } from './helpers/entities.js';

const DIR = new URL('./fixtures/open5e/', import.meta.url);
const raw = (slug) => JSON.parse(readFileSync(new URL(`srd_${slug}.json`, DIR), 'utf8'));
const sb = (slug) => normalizeCreature(raw(slug));
const action = (block, name) => block.actions.find(a => a.name === name);

// SRD 5.1: [slug, AC, HP, hit dice, CR, XP, first weapon action, to-hit, damage dice+bonus, damage type]
const SRD = [
  ['goblin', 15, 7, '2d6', 0.25, 50, 'Scimitar', 4, '1d6', 2, 'slashing'],
  ['orc', 13, 15, '2d8+6', 0.5, 100, 'Greataxe', 5, '1d12', 3, 'slashing'],
  ['hobgoblin', 18, 11, '2d8+2', 0.5, 100, 'Longsword', 3, '1d8', 1, 'slashing'],
  ['bugbear', 16, 27, '5d8+5', 1, 200, 'Morningstar', 4, '2d8', 2, 'piercing'],
  ['kobold', 12, 5, '2d6-2', 0.125, 25, 'Dagger', 4, '1d4', 2, 'piercing'],
  ['skeleton', 13, 13, '2d8+4', 0.25, 50, 'Shortsword', 4, '1d6', 2, 'piercing'],
  ['zombie', 8, 22, '3d8+9', 0.25, 50, 'Slam', 3, '1d6', 1, 'bludgeoning'],
  ['vampire-spawn', 15, 82, '11d8+33', 5, 1800, 'Bite', 6, '1d6', 3, 'piercing'],
  ['troll', 15, 84, '8d10+40', 5, 1800, 'Bite', 7, '1d6', 4, 'piercing'],
  ['minotaur', 14, 76, '9d10+27', 3, 700, 'Greataxe', 6, '2d12', 4, 'slashing'],
  ['bandit', 12, 11, '2d8+2', 0.125, 25, 'Scimitar', 3, '1d6', 1, 'slashing'],
  ['cultist', 12, 9, '2d8', 0.125, 25, 'Scimitar', 3, '1d6', 1, 'slashing'],
  ['gnoll', 15, 22, '5d8', 0.5, 100, 'Bite', 4, '1d4', 2, 'piercing'],
  ['cult-fanatic', 13, 22, '6d8+6', 2, 450, 'Dagger', 4, '1d4', 2, 'piercing'],
  ['owlbear', 13, 59, '7d10+21', 3, 700, 'Beak', 7, '1d10', 5, 'piercing'],
  ['young-red-dragon', 18, 178, '17d10+85', 10, 5900, 'Bite', 10, '2d10', 6, 'piercing'],
  ['ogre', 11, 59, '7d10+21', 2, 450, 'Greatclub', 6, '2d8', 4, 'bludgeoning'],
  ['dire-wolf', 14, 37, '5d10+10', 1, 200, 'Bite', 5, '2d6', 3, 'piercing'],
  ['giant-spider', 14, 26, '4d10+4', 1, 200, 'Bite', 5, '1d8', 3, 'piercing'],
  ['ghoul', 12, 22, '5d8', 1, 200, 'Bite', 2, '2d6', 2, 'piercing']
];

test('R11 fixtures: 21 SRD-2014 payloads with a CC-BY attribution README', () => {
  const files = readdirSync(DIR).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 21);
  for (const f of files) {
    assert.equal(JSON.parse(readFileSync(new URL(f, DIR), 'utf8')).document.key, 'srd-2014', f);
  }
  assert.match(readFileSync(new URL('README.md', DIR), 'utf8'), /Creative Commons Attribution 4\.0/);
});

test('R11: the 20 task creatures normalise to their SRD 5.1 numbers', () => {
  for (const [slug, ac, hp, formula, cr, xp, first, toHit, dice, bonus, type] of SRD) {
    const b = sb(slug);
    assert.equal(b.source, OPEN5E_SOURCE, slug);
    assert.equal(b.slug, slug);
    assert.equal(b.open5eSlug, `srd_${slug}`);
    assert.deepEqual([b.ac, b.hp.average, b.hp.formula, b.cr, b.xp], [ac, hp, formula, cr, xp], slug);
    const a = action(b, first);
    assert.ok(a, `${slug}: ${first}`);
    assert.deepEqual([a.toHit, a.damage[0].dice, a.damage[0].bonus, a.damage[0].type], [toHit, dice, bonus, type], slug);
    for (const k of ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']) {
      assert.ok(Number.isInteger(b.saves[k]) && Number.isInteger(b.abilities[k]), `${slug} ${k}`);
    }
  }
});

test('R11: Young Red Dragon — bite +10 2d10+6 piercing + 1d6 fire reach 10, fire immunity, breath recharge 5–6', () => {
  const b = sb('young-red-dragon');
  const bite = action(b, 'Bite');
  assert.deepEqual(
    { kind: bite.kind, toHit: bite.toHit, reachFt: bite.reachFt, damage: bite.damage },
    { kind: 'melee', toHit: 10, reachFt: 10, damage: [
      { dice: '2d10', bonus: 6, type: 'piercing', avg: 17 },
      { dice: '1d6', bonus: 0, type: 'fire', avg: 3 }
    ] }
  );
  assert.equal(bite.legendaryCost, null, 'Open5e\'s legendary_action_cost: 1 on a plain action is ignored');
  assert.deepEqual(b.immunities, ['fire']);
  assert.deepEqual([b.resistances, b.vulnerabilities, b.conditionImmunities], [[], [], []]);
  const breath = action(b, 'Fire Breath');
  assert.deepEqual(breath.recharge, { min: 5 });
  assert.equal(breath.kind, 'save');
  assert.deepEqual(breath.area, { shape: 'cone', sizeFt: 30 });
  assert.deepEqual([breath.save.stat, breath.save.dc, breath.save.half], ['DEX', 17, true]);
  assert.deepEqual(breath.damage, [{ dice: '16d6', bonus: 0, type: 'fire', avg: 56 }]);
  assert.deepEqual(b.saves, { STR: 6, DEX: 4, CON: 9, INT: 2, WIS: 4, CHA: 8 });
  assert.deepEqual([b.speedFt, b.speeds.fly, b.speeds.climb], [40, 80, 40]);
  assert.equal(b.pb, 4, 'proficiency_bonus is null in the payload; derived from CR 10');
  assert.equal(b.senses.blindsightFt, 30);
  assert.equal(b.skills.perception, 8);
  assert.equal(b.legendary, null);
  assert.deepEqual(b.multiattack, [{ action: 'Bite', count: 1 }, { action: 'Claw', count: 2 }]);
});

test('R11: structured attack fields are a cross-check only (the Bite\'s thunder is flagged)', () => {
  const b = sb('young-red-dragon');
  assert.equal(raw('young-red-dragon').actions.find(a => a.name === 'Bite').attacks[0].damage_type.key, 'thunder');
  assert.ok(b.crossCheck.some(x => x.action === 'Bite' && x.field === 'damage[0].type' && x.text === 'piercing' && x.structured === 'thunder'));
  assert.ok(b.crossCheck.some(x => x.action === 'Bite' && x.field === 'damage.length' && x.text === 2 && x.structured === 1));
  // The text wins when they disagree: Hobgoblin's structured longsword is the two-handed 1d10.
  assert.equal(action(sb('hobgoblin'), 'Longsword').damage[0].dice, '1d8');
});

test('R11: multiattack sentences', () => {
  assert.deepEqual(sb('owlbear').multiattack, [{ action: 'Beak', count: 1 }, { action: 'Claws', count: 1 }]);
  assert.deepEqual(sb('troll').multiattack, [{ action: 'Bite', count: 1 }, { action: 'Claw', count: 2 }]);
  assert.deepEqual(sb('cult-fanatic').multiattack, [{ action: null, count: 2, kind: 'melee' }]);
  assert.deepEqual(sb('vampire-spawn').multiattack, [{ action: null, count: 2, limits: { Bite: 1 } }]);
  assert.deepEqual(sb('adult-red-dragon').multiattack,
    [{ action: 'Frightful Presence', count: 1 }, { action: 'Bite', count: 1 }, { action: 'Claw', count: 2 }]);
  assert.equal(sb('goblin').multiattack, null);
  assert.ok(!sb('owlbear').actions.some(a => /multiattack/i.test(a.name)), 'Multiattack is not an action entry');
  assert.match(sb('owlbear').multiattackText, /one with its beak/);
});

test('R11: parseMultiattack direct forms', () => {
  const acts = [{ name: 'Longsword' }, { name: 'Dagger' }, { name: 'Claws' }];
  assert.deepEqual(parseMultiattack('The knight makes two longsword attacks.', acts), [{ action: 'Longsword', count: 2 }]);
  assert.deepEqual(parseMultiattack('The beast makes two attacks with its claws.', acts), [{ action: 'Claws', count: 2 }]);
  assert.deepEqual(parseMultiattack('The captain makes three melee attacks: two with its longsword and one with its dagger.', acts),
    [{ action: 'Longsword', count: 2 }, { action: 'Dagger', count: 1 }]);
  assert.deepEqual(parseMultiattack('The thing makes three attacks.', acts), [{ action: null, count: 3 }]);
  assert.equal(parseMultiattack('It roars.', acts), null);
});

test('R11: on-hit riders — save damage, save conditions, unsaved conditions', () => {
  const spider = sb('giant-spider');
  assert.deepEqual(action(spider, 'Bite').save,
    { stat: 'CON', dc: 11, half: true, damage: [{ dice: '2d8', bonus: 0, type: 'poison', avg: 9 }], condition: null });
  assert.deepEqual([action(spider, 'Web').kind, action(spider, 'Web').condition, action(spider, 'Web').damage], ['ranged', 'restrained', []]);
  assert.deepEqual(action(sb('dire-wolf'), 'Bite').save, { stat: 'STR', dc: 13, half: false, damage: [], condition: 'prone' });
  assert.equal(action(sb('ghoul'), 'Claws').save.condition, 'paralyzed');
  assert.equal(action(sb('ghoul'), 'Bite').save, null);
});

test('R11: reach / range — melee-or-ranged keeps both, versatile and at-range alternatives keep the first damage', () => {
  const jav = action(sb('ogre'), 'Javelin');
  assert.deepEqual([jav.kind, jav.reachFt, jav.rangeFt, jav.longRangeFt], ['melee', 5, 30, 120]);
  const bow = action(sb('goblin'), 'Shortbow');
  assert.deepEqual([bow.kind, bow.reachFt, bow.rangeFt, bow.longRangeFt], ['ranged', null, 80, 320]);
  assert.deepEqual(action(sb('bugbear'), 'Javelin').damage.map(d => d.dice), ['2d6'], 'melee damage, not "5 (1d6 + 2) at range"');
  assert.deepEqual(action(sb('gnoll'), 'Spear').damage.map(d => d.dice), ['1d6'], 'one-handed, not the two-handed 1d8');
});

test('R11: damage and condition defenses, including nonmagical BPS', () => {
  const skel = sb('skeleton');
  assert.deepEqual([skel.immunities, skel.vulnerabilities, skel.conditionImmunities], [['poison'], ['bludgeoning'], ['exhaustion', 'poisoned']]);
  const vamp = sb('vampire-spawn');
  assert.deepEqual(vamp.resistances, ['bludgeoning', 'necrotic', 'piercing', 'slashing']);
  assert.deepEqual(vamp.nonmagicalOnly, { resistances: ['bludgeoning', 'piercing', 'slashing'], immunities: [] });
  assert.deepEqual(sb('ghoul').conditionImmunities, ['charmed', 'exhaustion', 'poisoned']);
  for (const b of SRD.map(r => sb(r[0]))) {
    for (const t of [...b.resistances, ...b.immunities, ...b.vulnerabilities]) assert.ok(DAMAGE_TYPES.includes(t), t);
    for (const c of b.conditionImmunities) assert.ok(CONDITION_NAMES.includes(c), c);
  }
});

test('R11: spellcasting trait (Cult Fanatic)', () => {
  const sc = sb('cult-fanatic').spellcasting;
  assert.deepEqual([sc.dc, sc.toHit, sc.ability, sc.casterLevel, sc.innate], [11, 3, 'WIS', 4, false]);
  assert.deepEqual(sc.slots, { 1: 4, 2: 3 });
  assert.deepEqual(sc.spells.filter(s => s.level === 0).map(s => s.name), ['light', 'sacred flame', 'thaumaturgy']);
  assert.deepEqual(sc.spells.filter(s => s.level === 2).map(s => s.name), ['hold person', 'spiritual weapon']);
  assert.equal(sb('goblin').spellcasting, null);
});

test('R11: legendary actions (Adult Red Dragon)', () => {
  const b = sb('adult-red-dragon');
  assert.equal(b.legendary.perRound, 3);
  assert.deepEqual(b.legendary.actions.map(a => [a.name, a.legendaryCost]), [['Detect', 1], ['Tail Attack', 1], ['Wing Attack', 2]]);
  const tail = b.legendary.actions.find(a => a.name === 'Tail Attack');
  assert.equal(tail.invokes, 'Tail');
  const wing = b.legendary.actions.find(a => a.name === 'Wing Attack');
  assert.deepEqual([wing.kind, wing.save.stat, wing.save.dc, wing.save.half, wing.save.condition], ['save', 'DEX', 22, false, 'prone']);
  assert.deepEqual(wing.area, { shape: 'radius', sizeFt: 10 });
  assert.equal(b.legendaryResistance, 3);
  assert.ok(!b.actions.some(a => a.actionType === 'legendary'));
});

test('R11: falls back to the structured attack when the desc text does not parse', () => {
  const p = raw('goblin');
  p.actions = [{ name: 'Odd', desc: 'Something strange.', action_type: 'ACTION',
    attacks: [{ attack_type: 'WEAPON', to_hit_mod: 3, reach: 5, damage_die_count: 1, damage_die_type: 'D8', damage_bonus: 1, damage_type: { key: 'slashing' } }] }];
  const a = normalizeCreature(p).actions[0];
  assert.deepEqual([a.kind, a.toHit, a.reachFt, a.damage[0].dice, a.damage[0].bonus, a.damage[0].type], ['melee', 3, 5, '1d8', 1, 'slashing']);
  assert.equal(normalizeCreature(null), null);
  assert.equal(normalizeCreature('x'), null);
});

test('R11: engineAttacksFrom — preset attack shape, melee first, multi-term dice', () => {
  assert.deepEqual(engineAttacksFrom(sb('young-red-dragon')).map(a => [a.name, a.bonus, a.dice, a.damageType, a.reachFt]),
    [['Bite', 10, '2d10+1d6+6', 'piercing', 10], ['Claw', 10, '2d6+6', 'slashing', 5]]);
  assert.deepEqual(engineAttacksFrom(sb('gnoll')).map(a => a.name), ['Bite', 'Spear', 'Longbow']);
  assert.deepEqual(engineAttacksFrom(sb('kobold')).map(a => a.dice), ['1d4+2', '1d4+2']);
  assert.deepEqual(engineAttacksFrom(sb('giant-spider')).map(a => a.name), ['Bite'], 'Web (no damage) is not an engine attack');
  assert.deepEqual(engineAttacksFrom(sb('vampire-spawn'))[0].damageParts,
    [{ dice: '1d6', bonus: 3, type: 'piercing' }, { dice: '2d6', bonus: 0, type: 'necrotic' }]);
  assert.deepEqual(engineAttacksFrom(null), []);
});

test('R11: withEngineFields / isNormalizedStatBlock / proficiencyForCr', () => {
  const b = sb('owlbear');
  assert.ok(isNormalizedStatBlock(b));
  assert.ok(!isNormalizedStatBlock({ slug: 'goblin' }));
  const e = withEngineFields(b);
  assert.equal(e.hpMax, 59);
  assert.equal(e.attacks[0].name, 'Beak');
  assert.equal(b.hpMax, undefined, 'pure: input not mutated');
  assert.equal(withEngineFields({ ...b, hpMax: 70 }).hpMax, 70, 'a caller override wins');
  const plain = { slug: 'goblin', ac: 9 };
  assert.equal(withEngineFields(plain), plain);
  assert.deepEqual([0, 4, 5, 8, 9, 13, 17, 21, 30].map(proficiencyForCr), [2, 2, 3, 3, 4, 5, 6, 7, 9]);
});

test('R11: api/lib/open5e.js re-exports the shared normaliser', () => {
  assert.equal(apiOpen5e.normalizeCreature, normalizeCreature);
  assert.equal(apiOpen5e.engineAttacksFrom, engineAttacksFrom);
});

function dragonVsFighter() {
  const fighter = parsedDdbFixture('fighter-l5');
  const state = emptyEncounterState({ encounterId: 'e-r11', cols: 10, rows: 6, seed: 7 });
  const pc = entityFromSheet(fighter, { pos: { col: 2, row: 2 } });
  const dragon = entityFromPreset('troll', { id: 'm-dragon', pos: { col: 3, row: 2 }, statBlock: sb('young-red-dragon') });
  state.entities[pc.id] = pc;
  state.entities[dragon.id] = dragon;
  return { state, fighter, pc, dragon };
}

test('R11: entityFromPreset takes a normalised stat block — real AC / HP / saves / R-I-V, the preset stays the sprite', () => {
  const { state, fighter, pc, dragon } = dragonVsFighter();
  const v = validateEncounterState(state);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual([dragon.name, dragon.ac, dragon.hp, dragon.hpMax, dragon.speedFt], ['Young Red Dragon', 18, 178, 178, 40]);
  assert.equal(dragon.statBlock.slug, 'troll', 'preset slug (sprite)');
  assert.equal(dragon.statBlock.open5eSlug, 'srd_young-red-dragon');
  assert.ok(Array.isArray(dragon.statBlock.multiattack) && Array.isArray(dragon.statBlock.actions), 'actions + multiattack ride through');
  const sides = toEngineSides(state, { [fighter.id]: fighter }, 'm-dragon');
  const w = sides.active;
  assert.deepEqual([w.attack.name, w.attack.bonus, w.attack.dice], ['Bite', 10, '2d10+1d6+6']);
  assert.equal(w.secondary.name, 'Claw');
  assert.deepEqual(w.immunities, ['fire']);
  assert.equal(w.saves.CON, 9);
  assert.ok(pc.hp > 0);
});

test('R11: the engine swings the parsed Bite (+10, 2d10+1d6+6)', async () => {
  const { state, fighter, pc } = dragonVsFighter();
  const sides = toEngineSides(state, { [fighter.id]: fighter }, 'm-dragon');
  const plan = { kind: 'attack', targetId: pc.id, targetSide: 'enemy', featuresFired: [] };
  // rng 0.5: d20 = 11 (+10 = 21, a hit); each die rolls floor(0.5 * sides) + 1 → 6 + 6 + 4 + 6 = 22.
  await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, () => 0.5, { forcePlan: plan });
  const after = applyEngineSides(state, sides.wrappers);
  assert.equal(pc.hp - after.entities[pc.id].hp, 22);
});
