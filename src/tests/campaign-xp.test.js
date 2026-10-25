// M65 R24 — XP thresholds, CR XP, encounter XP split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  XP_THRESHOLDS, MAX_LEVEL, CR_XP, PRESET_XP, XP_MODES, crKey, xpForCr, monsterXp,
  isDeadParticipant, encounterXp, levelForXp, xpForLevel, levelsCrossed
} from '../js/campaign/xp.js';
import { ratedDifficulty } from '../js/scene/calibrator.js';

test('XP_THRESHOLDS: SRD 5.1 p.56, 20 levels', () => {
  assert.equal(XP_THRESHOLDS.length, MAX_LEVEL);
  assert.deepEqual([...XP_THRESHOLDS], [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
    85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000]);
  assert.ok(Object.isFrozen(XP_THRESHOLDS));
  assert.deepEqual([...XP_MODES], ['xp', 'milestone']);
});

test('CR_XP covers CR 0–30 and the calibrator imports the same table', () => {
  assert.equal(CR_XP['1/4'], 50);
  assert.equal(CR_XP[20], 25000);
  assert.equal(CR_XP[30], 155000);
  assert.equal(Object.keys(CR_XP).length, 34);
  // calibrator.js reads CR_XP through the import (a CR 2 monster = 450 XP).
  const r = ratedDifficulty({ party: [{ classes: [{ level: 1 }] }], monsters: [{ cr: 2 }] });
  assert.equal(r.baseXp, 450);
});

test('crKey / xpForCr accept numbers, decimals and SRD fractions', () => {
  assert.equal(crKey(0.25), '1/4');
  assert.equal(crKey('1/8'), '1/8');
  assert.equal(crKey('0.5'), '1/2');
  assert.equal(crKey(5), '5');
  assert.equal(crKey(0), '0');
  assert.equal(crKey(1.5), null);
  assert.equal(crKey(null), null);
  assert.equal(xpForCr(0.25), 50);
  assert.equal(xpForCr('abc'), null);
});

test('monsterXp: statBlock xp, then CR, then preset table', () => {
  assert.equal(monsterXp({ statBlock: { xp: 50, cr: 0.25 } }), 50);
  assert.equal(monsterXp({ statBlock: { cr: 1 } }), 200);
  assert.equal(monsterXp({ xp: 0 }), 0);
  assert.equal(monsterXp({ statBlock: { slug: 'bandit' } }), PRESET_XP.bandit);
  assert.equal(monsterXp({ presetSlug: 'goblin' }), 50);
  assert.equal(monsterXp({ name: 'mystery' }), 0);
  assert.equal(monsterXp(null), 0);
});

test('encounterXp: 4 goblins / 4 PCs → 50 each', () => {
  const goblins = [1, 2, 3, 4].map(i => ({ id: `g${i}`, statBlock: { slug: 'goblin', xp: 50, cr: 0.25 } }));
  const pcs = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const r = encounterXp(goblins, pcs);
  assert.equal(r.total, 200);
  assert.equal(r.each, 50);
  assert.deepEqual(r.awards, { a: 50, b: 50, c: 50, d: 50 });
  assert.equal(r.remainder, 0);
});

test('encounterXp: dead PCs get nothing; uneven splits round down', () => {
  const ogre = [{ statBlock: { cr: 2 } }];
  const pcs = [{ id: 1 }, { id: 2, lifeStatus: 'dead' }, { id: 3, status: 'dead' }, { id: 4, deathSaves: { failures: 3 } }, { id: 5, status: 'downed' }];
  const r = encounterXp(ogre, pcs);
  assert.deepEqual(r.recipients, ['1', '5']);
  assert.equal(r.each, 225);
  const odd = encounterXp([{ xp: 100 }], [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.equal(odd.each, 33);
  assert.equal(odd.remainder, 1);
  assert.deepEqual(encounterXp([{ xp: 100 }], []).awards, {});
  assert.equal(isDeadParticipant({ id: 1 }), false);
});

test('encounterXp: milestone mode is a no-op; unknown modes throw', () => {
  assert.deepEqual(encounterXp([{ xp: 500 }], [{ id: 'a' }], { mode: 'milestone' }),
    { mode: 'milestone', total: 0, each: 0, remainder: 0, recipients: [], awards: {} });
  assert.throws(() => encounterXp([], [], { mode: 'bogus' }), RangeError);
});

test('levelForXp: 2,700 → L4, 2,699 → L3; caps at 20', () => {
  assert.equal(levelForXp(2700), 4);
  assert.equal(levelForXp(2699), 3);
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(-5), 1);
  assert.equal(levelForXp(355000), 20);
  assert.equal(levelForXp(9e9), 20);
});

test('xpForLevel and levelsCrossed', () => {
  assert.equal(xpForLevel(5), 6500);
  assert.equal(xpForLevel(99), 355000);
  assert.deepEqual(levelsCrossed(2600, 7000), [4, 5]);
  assert.deepEqual(levelsCrossed(2712, 2800), []);
  assert.deepEqual(levelsCrossed(2712, 6500, { currentLevel: 3 }), [4, 5], 'the sheet level wins');
  assert.deepEqual(levelsCrossed(0, 9e9, { mode: 'milestone' }), []);
});
