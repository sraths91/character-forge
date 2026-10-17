/**
 * M64 H3 — shared test builders + synthetic D&D Beyond fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DDB_FIXTURES, buildPc, buildMonster, buildScene, pcFromSheet, monsterFromPreset,
  loadDdbFixture, parsedDdbFixture
} from './helpers/entities.js';
import { hasShieldSpell, hasCounterspell } from '../js/scene/reactions.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { seedRng } from '../js/scene/simulator.js';

test('DDB fixtures: all three are marked synthetic with fake ids and names', () => {
  assert.deepEqual([...DDB_FIXTURES], ['fighter-l5', 'wizard-l5', 'cleric-l5']);
  for (const name of DDB_FIXTURES) {
    const raw = loadDdbFixture(name);
    assert.match(raw.fixtureNote, /^SYNTHETIC/);
    assert.ok(raw.id >= 900000000 && raw.id < 900001000, `${name} uses a fake id`);
    assert.match(raw.name, /^Fixture /);
  }
  assert.throws(() => loadDdbFixture('saris'), /unknown fixture/);
});

test('DDB fixtures: fighter-l5 parses as a sword-and-board Champion', () => {
  const p = parsedDdbFixture('fighter-l5');
  assert.deepEqual(p.classes, [{ name: 'Fighter', level: 5, subclass: 'Champion' }]);
  assert.equal(p.level, 5);
  assert.equal(p.hp.max, 44);
  assert.deepEqual(p.abilityModifiers, { STR: 3, DEX: 2, CON: 2, INT: 0, WIS: 1, CHA: -1 });
  assert.equal(p.equipment.mainhand.name, 'Longsword');
  assert.equal(p.equipment.offhand.name, 'Shield');
  assert.equal(p.equipment.armor.name, 'Chain Mail');
  assert.deepEqual(p.savingThrowProficiencies.sort(), ['CON', 'STR']);
  assert.deepEqual(p.spells, []);
  const surge = p.classFeatures.find(f => f.name === 'Action Surge');
  assert.deepEqual(surge.uses, { max: 1, used: 0, reset: 'short rest' });
});

test('DDB fixtures: wizard-l5 parses with Shield, Counterspell and a crossbow', () => {
  const p = parsedDdbFixture('wizard-l5');
  assert.equal(p.hp.max, 32);
  assert.equal(p.abilityModifiers.INT, 3);
  assert.equal(p.equipment.mainhand.name, 'Light Crossbow');
  const names = p.spells.map(s => s.name);
  for (const s of ['Fire Bolt', 'Shield', 'Magic Missile', 'Hold Person', 'Counterspell', 'Fireball']) {
    assert.ok(names.includes(s), `${s} parsed`);
  }
  const fireball = p.spells.find(s => s.name === 'Fireball');
  assert.equal(fireball.kind, 'spell-save');
  assert.equal(fireball.saveStat, 'DEX');
  assert.equal(fireball.saveOnHalf, true);
  assert.equal(fireball.spellCastingAbility, 'INT');
  assert.equal(p.spells.find(s => s.name === 'Hold Person').concentration, true);
});

test('DDB fixtures: cleric-l5 parses with heals, concentration and Channel Divinity', () => {
  const p = parsedDdbFixture('cleric-l5');
  assert.equal(p.hp.max, 38);
  assert.equal(p.abilityModifiers.WIS, 3);
  assert.equal(p.equipment.offhand.name, 'Shield');
  const kinds = Object.fromEntries(p.spells.map(s => [s.name, s.kind]));
  assert.equal(kinds['Cure Wounds'], 'heal');
  assert.equal(kinds['Healing Word'], 'heal');
  assert.equal(kinds['Spiritual Weapon'], 'spell-attack');
  assert.equal(kinds['Spirit Guardians'], 'spell-save');
  assert.equal(p.spells.find(s => s.name === 'Spirit Guardians').spellCastingAbility, 'WIS');
  assert.deepEqual(p.classFeatures.find(f => f.name === 'Channel Divinity').uses, { max: 1, used: 0, reset: 'short rest' });
});

test('buildPc / buildMonster / buildScene: defaults and overrides', () => {
  const pc = buildPc({ id: 'pc9', hp: 5 });
  assert.equal(pc.id, 'pc9');
  assert.equal(pc.hp, 5);
  assert.equal(pc.kind, 'pc');
  assert.deepEqual(pc._position, { col: 1, row: 1 });
  const m = buildMonster({ position: { col: 4, row: 2 } });
  assert.equal(m.presetSlug, 'goblin');
  assert.deepEqual(m.position, { col: 4, row: 2 });
  assert.deepEqual(buildScene(), { cols: 10, rows: 7, flankingEnabled: false });
  assert.equal(buildScene({ flankingEnabled: true }).flankingEnabled, true);
  assert.notEqual(buildPc().ref, buildPc().ref, 'fresh objects per call');
});

test('pcFromSheet: simulator-shaped wrappers with derived AC and slot pools', () => {
  const fighter = pcFromSheet(parsedDdbFixture('fighter-l5'), { id: 'pc-fighter' });
  assert.equal(fighter.id, 'pc-fighter');
  assert.equal(fighter.ac, 18);
  assert.equal(fighter.hp, 44);
  assert.equal(fighter._slots[1], 0);
  assert.equal(fighter.weapon.name, 'Longsword');
  const wizard = pcFromSheet(parsedDdbFixture('wizard-l5'));
  assert.deepEqual(wizard._slots, { 1: 4, 2: 3, 3: 2, 4: 0, 5: 0 });
  assert.ok(hasShieldSpell(wizard));
  assert.ok(hasCounterspell(wizard));
});

test('monsterFromPreset: preset stats, spell slots, innate and legendary state', () => {
  const g = monsterFromPreset('goblin', { id: 'm-g', position: { col: 3, row: 3 } });
  assert.equal(g.id, 'm-g');
  assert.equal(g.ac, 15);
  assert.equal(g.hp, 7);
  assert.equal(g._slots, null);
  const f = monsterFromPreset('cult-fanatic');
  assert.deepEqual(f._slots, { 1: 4, 2: 3 });
  const d = monsterFromPreset('young-dragon');
  assert.deepEqual(d._innate.recharges, { 'fire-breath': true });
  assert.equal(d._legendaryBudget, 3);
  assert.throws(() => monsterFromPreset('tarrasque'), /unknown preset/);
});

test('builders drive the engine: a seeded turn resolves and the wrappers stay pure JSON', async () => {
  const pc = pcFromSheet(parsedDdbFixture('fighter-l5'), { id: 'pc-fighter', _position: { col: 1, row: 1 } });
  const gob = monsterFromPreset('goblin', { id: 'm-g', position: { col: 2, row: 1 } });
  await runOneAttack(pc, [gob], [pc], buildScene(), seedRng(7), {
    forcePlan: { kind: 'melee', targetId: 'm-g', targetSide: 'enemy', weapon: pc.weapon, featuresFired: [] }
  });
  assert.ok(gob.hp <= 7);
  const both = { pc, gob };
  assert.deepEqual(JSON.parse(JSON.stringify(both)), both);
});
