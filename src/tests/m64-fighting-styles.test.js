/**
 * M64 phase 1.5 — Fighting Styles from `sheet.fightingStyles` (E4) and
 * the two-weapon off-hand bonus attack.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { rollDamage } from '../js/scene/combat-roll.js';
import { deriveAC } from '../js/scene/pc-stats.js';
import {
  fightingStylesOf, acFor, swingStyleMods, offhandWeaponFor, offhandDice, isTwoHanded, isLight
} from '../js/scene/fighting-styles.js';
import { entityFromSheet } from '../js/scene/encounter-adapters.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene, parsedDdbFixture } from './helpers/entities.js';

const LONGSWORD = { name: 'Longsword', damage: '1d8', damageType: 'Slashing', properties: ['versatile'], versatileDamage: '1d10', attackType: 1 };
const GREATSWORD = { name: 'Greatsword', damage: '2d6', damageType: 'Slashing', properties: ['heavy', 'two-handed'], attackType: 1 };
const LONGBOW = { name: 'Longbow', damage: '1d8', damageType: 'Piercing', properties: ['ammunition', 'heavy', 'two-handed'], attackType: 2, range: 150, longRange: 600 };
const SHORTSWORD = { name: 'Shortsword', damage: '1d6', damageType: 'Piercing', properties: ['finesse', 'light'], attackType: 1 };
const SHIELD = { name: 'Shield', armorTypeId: 4, armorClass: 2 };

function hero(styles, equipment, level = 4) {
  const ref = {
    name: 'Hero', classes: [{ name: 'Fighter', level }], fightingStyles: styles,
    equipment, abilityModifiers: { STR: 3, DEX: 3, CON: 2, INT: 0, WIS: 1, CHA: 0 }
  };
  return buildPc({ id: 'h', ref, weapon: equipment.mainhand, _chosenWeapon: equipment.mainhand, _position: { col: 1, row: 1 } });
}

async function swing(pc, seed = 6, targetPos = { col: 2, row: 1 }) {
  const m = buildMonster({ id: 'm', hp: 999, hpMax: 999, ac: 1, position: targetPos });
  const events = [];
  await runOneAttack(pc, [m], [pc], buildScene({ cols: 12 }), createRng({ s: seed }), {
    forcePlan: { kind: pc.weapon?.attackType === 2 ? 'ranged' : 'melee', targetId: 'm', weapon: pc.weapon, featuresFired: [] }
  }, { emit: (e) => events.push(e), turnId: 't' });
  return events;
}

test('styles: names normalise from strings or {name}; unknown styles pass through', () => {
  assert.deepEqual(fightingStylesOf({ fightingStyles: ['Defense', { name: 'Great Weapon Fighting' }, 'Two-Weapon Fighting', 'Protection'] }),
    ['defense', 'great-weapon-fighting', 'two-weapon-fighting', 'protection']);
  assert.deepEqual(fightingStylesOf({}), []);
  assert.equal(isTwoHanded(GREATSWORD), true);
  assert.equal(isTwoHanded(LONGSWORD), false);
  assert.equal(isTwoHanded({ name: 'Maul' }), true, 'name fallback');
  assert.equal(isLight(SHORTSWORD), true);
  assert.equal(isLight({ name: 'Dagger' }), true);
});

test('Defense: +1 AC in armor only, also on the encounter entity', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  assert.equal(acFor(sheet), deriveAC(sheet), 'no style, no change');
  const withStyle = { ...sheet, fightingStyles: ['Defense'] };
  assert.equal(acFor(withStyle), deriveAC(sheet) + 1);
  assert.equal(entityFromSheet(withStyle, { id: 'f', pos: { col: 0, row: 0 } }).ac, deriveAC(sheet) + 1);
  const naked = { ...withStyle, equipment: { ...sheet.equipment, armor: null } };
  assert.equal(acFor(naked), deriveAC(naked));
});

test('Dueling: +2 damage with a one-handed melee weapon (a shield is fine), not with two weapons or two hands', async () => {
  const plain = await swing(hero([], { mainhand: LONGSWORD, offhand: SHIELD }));
  const duel = await swing(hero(['Dueling'], { mainhand: LONGSWORD, offhand: SHIELD }));
  const rolled = (evs) => evs.filter(e => e.type === 'damage').map(e => e.payload.rolled);
  assert.ok(rolled(plain).length > 0);
  rolled(duel).forEach((d, i) => assert.equal(d, rolled(plain)[i] + 2));
  const a = { ranged: false, versatile: false };
  assert.equal(swingStyleMods({ fightingStyles: ['Dueling'], equipment: { mainhand: SHORTSWORD, offhand: SHORTSWORD } }, SHORTSWORD, a).damageBonus, 0, 'two weapons');
  assert.equal(swingStyleMods({ fightingStyles: ['Dueling'], equipment: { mainhand: LONGSWORD } }, LONGSWORD, { ranged: false, versatile: true }).damageBonus, 0, 'versatile in two hands');
});

test('Great Weapon Fighting: rerolls 1s and 2s on the weapon dice of a two-handed attack', () => {
  assert.equal(swingStyleMods({ fightingStyles: ['Great Weapon Fighting'], equipment: { mainhand: GREATSWORD } }, GREATSWORD, { ranged: false, versatile: false }).rerollBelow, 2);
  assert.equal(swingStyleMods({ fightingStyles: ['Great Weapon Fighting'], equipment: { mainhand: LONGSWORD, offhand: SHIELD } }, LONGSWORD, { ranged: false, versatile: false }).rerollBelow, 0, 'one-handed');
  // Faces in order: 1 (rerolled → 5), 6, then a d6 sneak term 1 (not rerolled).
  const faces = [1, 5, 6, 1];
  const rng = () => (faces.shift() - 1) / 6 + 0.01;
  const r = rollDamage('2d6+3+1d6', { rerollBelow: 2 }, rng);
  assert.deepEqual(r.rolls, [5, 6, 1]);
  assert.equal(r.total, 15);
  // No option: identical draws to before.
  assert.deepEqual(rollDamage('2d6+3', {}, createRng({ s: 4 })), rollDamage('2d6+3', { crit: false }, createRng({ s: 4 })));
});

test('GWF in the engine: same seed, never less weapon damage than without the style', async () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const base = (await swing(hero([], { mainhand: GREATSWORD }), seed)).filter(e => e.type === 'damage');
    const gwf = (await swing(hero(['Great Weapon Fighting'], { mainhand: GREATSWORD }), seed)).filter(e => e.type === 'damage');
    if (base.length && gwf.length) assert.ok(gwf[0].payload.rolled >= base[0].payload.rolled, `seed ${seed}`);
  }
});

test('Archery: +2 to hit with a ranged weapon, nothing in melee', async () => {
  const plain = (await swing(hero([], { mainhand: LONGBOW }), 6, { col: 6, row: 1 })).find(e => e.type === 'attack.rolled');
  const arch = (await swing(hero(['Archery'], { mainhand: LONGBOW }), 6, { col: 6, row: 1 })).find(e => e.type === 'attack.rolled');
  assert.equal(arch.payload.bonus, plain.payload.bonus + 2);
  const melee = swingStyleMods({ fightingStyles: ['Archery'], equipment: { mainhand: LONGSWORD } }, LONGSWORD, { ranged: false });
  assert.equal(melee.attackBonus, 0);
});

test('Two-weapon fighting: a light weapon in each hand adds one off-hand attack; TWF adds the modifier', async () => {
  const dual = { mainhand: SHORTSWORD, offhand: { ...SHORTSWORD, name: 'Shortsword' } };
  assert.ok(offhandWeaponFor({ equipment: dual }, SHORTSWORD));
  assert.equal(offhandWeaponFor({ equipment: { mainhand: LONGSWORD, offhand: SHORTSWORD } }, LONGSWORD), null, 'main hand not light');
  assert.equal(offhandWeaponFor({ equipment: { mainhand: SHORTSWORD, offhand: SHIELD } }, SHORTSWORD), null);
  assert.equal(offhandDice('1d6+3', 3, { fightingStyles: [] }), '1d6');
  assert.equal(offhandDice('1d6+4', 3, { fightingStyles: [] }), '1d6+1', 'a +1 weapon keeps its +1');
  assert.equal(offhandDice('1d6+3', 3, { fightingStyles: ['Two-Weapon Fighting'] }), '1d6+3');
  assert.equal(offhandDice('1d6-1', -1, { fightingStyles: [] }), '1d6-1', 'a negative modifier stays');
  const evs = await swing(hero([], dual));
  const rolls = evs.filter(e => e.type === 'attack.rolled');
  assert.equal(rolls.length, 2, 'Fighter 4: one swing + the off-hand attack');
  const ex = evs.filter(e => e.type === 'exchange');
  assert.equal(new Set(ex.map(e => e.cinemaGroup)).size, 1);
  assert.equal(ex.length, 2);
  // Rage / Second Wind spend the bonus action: no off-hand attack.
  const pc = hero([], dual);
  pc.hp = 5; pc.hpMax = 40; pc._secondWindUsed = false;
  const m = buildMonster({ id: 'm', hp: 999, hpMax: 999, ac: 1, position: { col: 2, row: 1 } });
  const ev2 = [];
  await runOneAttack(pc, [m], [pc], buildScene(), createRng({ s: 6 }), {
    forcePlan: { kind: 'melee', targetId: 'm', weapon: SHORTSWORD, featuresFired: ['second-wind'] }
  }, { emit: (e) => ev2.push(e), turnId: 't' });
  assert.equal(ev2.filter(e => e.type === 'attack.rolled').length, 1);
});
