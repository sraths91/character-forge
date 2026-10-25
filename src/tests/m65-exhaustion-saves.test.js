/**
 * M65 R29 / T21 — exhaustion 3+ gives disadvantage on saving throws (SRD),
 * wired through the engine's one save-mode function (saveModeFor): spell /
 * AoE / condition saves, the concentration save and death saves. A straight
 * roll draws exactly the same rng as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveModeFor, concentrationCheck, rollDeathSave } from '../js/scene/combat-engine.js';
import { rollConcentrationSave } from '../js/scene/concentration.js';
import { buildPc } from './helpers/entities.js';

/** rng that returns the given d20 faces in order (1 + floor(r * 20)). */
function d20s(...faces) {
  const q = faces.map(f => (f - 1) / 20 + 0.001);
  return () => (q.length ? q.shift() : 0.5);
}

test('saveModeFor: exhaustion 3+ → disadvantage on every save; below 3 → normal', () => {
  for (const lv of [0, 1, 2]) assert.equal(saveModeFor(buildPc({ exhaustion: lv }), 'DEX'), 'normal', `level ${lv}`);
  for (const lv of [3, 4, 5]) {
    for (const stat of ['STR', 'DEX', 'CON', 'WIS', null]) {
      assert.equal(saveModeFor(buildPc({ exhaustion: lv }), stat), 'disadvantage', `level ${lv} ${stat}`);
    }
  }
  assert.equal(saveModeFor(buildPc({ conditions: [{ id: 'exhaustion', level: 3 }] }), 'WIS'), 'disadvantage', 'condition object');
});

test('saveModeFor: Rage advantage on STR and exhaustion disadvantage cancel', () => {
  const raging = (o) => buildPc({ conditions: ['raging'], ...o });
  assert.equal(saveModeFor(raging({}), 'STR'), 'advantage');
  assert.equal(saveModeFor(raging({ exhaustion: 3 }), 'STR'), 'normal');
  assert.equal(saveModeFor(raging({ exhaustion: 3 }), 'DEX'), 'disadvantage');
});

test('rollConcentrationSave: a straight roll draws one d20 (unchanged); disadvantage keeps the lower of two', () => {
  const straight = rollConcentrationSave({ conMod: 2, dc: 10 }, d20s(15, 3));
  assert.deepEqual([straight.d20, straight.total, straight.success, straight.dice], [15, 17, true, undefined]);
  const dis = rollConcentrationSave({ conMod: 2, dc: 10, advantage: 'disadvantage' }, d20s(15, 3));
  assert.deepEqual([dis.d20, dis.dice, dis.total, dis.success], [3, [15, 3], 5, false]);
  const adv = rollConcentrationSave({ conMod: 2, dc: 10, advantage: 'advantage' }, d20s(3, 15));
  assert.equal(adv.d20, 15);
});

test('concentrationCheck: an exhausted (3) caster rolls the CON save with disadvantage', () => {
  const caster = (o) => buildPc({ _concentrating: { spellId: 'bless', targetIds: [] }, ...o });
  const fresh = caster({});
  assert.equal(concentrationCheck(fresh, 10, d20s(18, 2)).broke, false);
  const tired = caster({ exhaustion: 3 });
  const r = concentrationCheck(tired, 10, d20s(18, 2));
  assert.equal(r.broke, true);
  assert.deepEqual(r.save.dice, [18, 2]);
});

test('rollDeathSave: exhaustion 3+ keeps the lower d20; unexhausted draws one', () => {
  const downed = (o) => buildPc({ hp: 0, hpMax: 30, status: 'downed', conditions: ['unconscious'], deathSaves: { successes: 0, failures: 0, stable: false }, ...o });
  const a = downed({});
  assert.equal(rollDeathSave(a, d20s(15, 4)).d20, 15);
  assert.deepEqual(a.deathSaves, { successes: 1, failures: 0, stable: false });
  const b = downed({ exhaustion: 3 });
  assert.equal(rollDeathSave(b, d20s(15, 4)).d20, 4);
  assert.deepEqual(b.deathSaves, { successes: 0, failures: 1, stable: false });
});
