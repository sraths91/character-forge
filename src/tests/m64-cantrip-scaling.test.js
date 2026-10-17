/**
 * M64 phase 1.5 — cantrip scaling at character levels 5 / 11 / 17
 * (atHigherLevels first, SRD table fallback) and Eldritch Blast beams.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { cantripTier, scaleCantrip, SRD_CANTRIP_SCALING } from '../js/scene/cantrip-scaling.js';
import { MONSTER_SPELLS, spellById } from '../js/scene/monster-spells.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

test('cantripTier: 1 / 2 at 5 / 3 at 11 / 4 at 17', () => {
  assert.deepEqual([1, 4, 5, 10, 11, 16, 17, 20].map(cantripTier), [1, 1, 2, 2, 3, 3, 4, 4]);
});

test('scaleCantrip: SRD table for the registry cantrips; leveled spells and the input untouched', () => {
  const fb = spellById('fire-bolt');
  assert.equal(scaleCantrip(fb, 4), fb, 'tier 1 returns the same object');
  assert.deepEqual([5, 11, 17].map(l => scaleCantrip(fb, l).dice), ['2d10', '3d10', '4d10']);
  assert.equal(scaleCantrip(spellById('sacred-flame'), 5).dice, '2d8');
  assert.equal(fb.dice, '1d10', 'registry not mutated');
  const mm = spellById('magic-missile');
  assert.equal(scaleCantrip(mm, 17), mm);
  assert.equal(Object.keys(SRD_CANTRIP_SCALING).length, 11);
  assert.equal(scaleCantrip({ id: 'homebrew-zap', level: 0, dice: '1d6' }, 17).dice, '1d6', 'unknown cantrips do not scale');
});

test('scaleCantrip: a DDB atHigherLevels block wins over the table', () => {
  const ahl = {
    scaleType: 'characterlevel',
    higherLevelDefinitions: [
      { level: 5, dice: { diceCount: 2, diceValue: 12 } },
      { level: 11, dice: { diceCount: 3, diceValue: 12 } }
    ]
  };
  const fb = spellById('fire-bolt');
  assert.equal(scaleCantrip(fb, 6, { atHigherLevels: ahl }).dice, '2d12');
  assert.equal(scaleCantrip(fb, 12, { atHigherLevels: ahl }).dice, '3d12');
  // A spellscale block (leveled-spell upcasting) is not character scaling: table.
  assert.equal(scaleCantrip(fb, 5, { atHigherLevels: { scaleType: 'spellscale', higherLevelDefinitions: [] } }).dice, '2d10');
  const eb = { id: 'eldritch-blast', level: 0, kind: 'spell-attack', dice: '1d10' };
  assert.equal(scaleCantrip(eb, 5, { atHigherLevels: { additionalAttacks: [{ level: 5 }] } }).beams, 2);
  assert.deepEqual([4, 5, 11, 17].map(l => scaleCantrip(eb, l).beams ?? 1), [1, 2, 3, 4]);
  assert.equal(scaleCantrip(eb, 17).dice, '1d10', 'beams, not dice');
});

function wizard(level, spells = ['Fire Bolt']) {
  return buildPc({
    id: 'wiz', _position: { col: 1, row: 1 },
    ref: { name: 'Wiz', classes: [{ name: 'Wizard', level }], spells, abilityModifiers: { STR: 0, DEX: 2, CON: 1, INT: 4, WIS: 1, CHA: 0 }, equipment: {} }
  });
}

test('engine: a Wizard 5 Fire Bolt rolls 2d10, a Wizard 4 1d10 (every die max at rng 0.9)', async () => {
  const fire = async (level) => {
    const w = wizard(level);
    const m = buildMonster({ id: 'm', hp: 200, hpMax: 200, ac: 5, position: { col: 4, row: 1 } });
    const events = [];
    await runOneAttack(w, [m], [w], buildScene(), () => 0.9, {
      forcePlan: { kind: 'cast', spellId: 'fire-bolt', castAtLevel: 0, targetId: 'm', targetSide: 'enemy', featuresFired: [] }
    }, { emit: (e) => events.push(e), turnId: 't' });
    return events.find(e => e.type === 'damage').payload.rolled;
  };
  assert.equal(await fire(4), 10);
  assert.equal(await fire(5), 20);
  assert.equal(await fire(11), 30);
});

test('engine: Eldritch Blast fires one attack per beam, re-targeting when the first target drops', async () => {
  MONSTER_SPELLS['eldritch-blast'] = {
    id: 'eldritch-blast', name: 'Eldritch Blast', kind: 'spell-attack', level: 0, range: 120, dice: '1d10', damageType: 'Force'
  };
  try {
    const lock = buildPc({
      id: 'lock', _position: { col: 1, row: 1 },
      ref: { name: 'Lock', classes: [{ name: 'Warlock', level: 11 }], spells: ['Eldritch Blast'], abilityModifiers: { STR: 0, DEX: 1, CON: 1, INT: 0, WIS: 0, CHA: 4 }, equipment: {} }
    });
    const weak = buildMonster({ id: 'weak', hp: 1, hpMax: 7, ac: 1, position: { col: 5, row: 1 } });
    const other = buildMonster({ id: 'other', hp: 200, hpMax: 200, ac: 1, position: { col: 6, row: 3 } });
    const events = [];
    await runOneAttack(lock, [weak, other], [lock], buildScene(), () => 0.5, {
      forcePlan: { kind: 'cast', spellId: 'eldritch-blast', castAtLevel: 0, targetId: 'weak', targetSide: 'enemy', featuresFired: [] }
    }, { emit: (e) => events.push(e), turnId: 't' });
    const rolls = events.filter(e => e.type === 'attack.rolled');
    assert.equal(rolls.length, 3, 'three beams at level 11');
    assert.deepEqual(rolls.map(r => r.payload.targetId), ['weak', 'other', 'other']);
    assert.ok(rolls.every(r => r.payload.spellId === 'eldritch-blast'));
    const ex = events.filter(e => e.type === 'exchange').map(e => e.payload.exchangeId);
    assert.deepEqual(ex, [ex[0], `${ex[0]}.s2`, `${ex[0]}.s3`]);
    assert.equal(events.filter(e => e.type === 'spell.cast').length, 1, 'one cast');
  } finally {
    delete MONSTER_SPELLS['eldritch-blast'];
  }
});

test('engine: monster cantrips never scale', async () => {
  // A cultist (monster book) casting Sacred Flame keeps 1d8 whatever its CR.
  const cult = buildMonster({ id: 'c', presetSlug: 'cultist', name: 'Cultist', position: { col: 1, row: 1 } });
  const pc = buildPc({ id: 'p', hp: 50, hpMax: 50, _position: { col: 3, row: 1 }, ref: { ...buildPc().ref, abilityModifiers: { STR: 0, DEX: -10, CON: 0, INT: 0, WIS: 0, CHA: 0 } } });
  const events = [];
  await runOneAttack(cult, [pc], [cult], buildScene(), () => 0.9, {
    forcePlan: { kind: 'cast', spellId: 'sacred-flame', castAtLevel: 0, targetId: 'p', targetSide: 'enemy' }
  }, { emit: (e) => events.push(e), turnId: 't' });
  const save = events.find(e => e.type === 'save.rolled');
  const dmg = events.find(e => e.type === 'damage');
  assert.equal(save.payload.success, false);
  assert.equal(dmg.payload.rolled, 8, '1d8 at max, not 2d8');
});
