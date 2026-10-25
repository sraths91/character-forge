// M65 R26 — level-up: plan, apply, revert, reconcile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HP_ON_LEVEL_MODES, ASI_CAP, averageHitDieGain, classLevelOf, planLevelUp, applyLevelUp,
  revertLevelUp, reconcileDiff, applyReconcile
} from '../js/campaign/level-up.js';
import { CampaignRuleError } from '../js/campaign/errors.js';
import { parseCharacter } from '../../api/lib/ddb-parser.js';
import { proficiencyBonus } from '../js/scene/pc-stats.js';
import { loadDdbFixture, parsedDdbFixture } from './helpers/entities.js';
import { restedState, faceFloat } from './helpers/campaign-state.js';
import { validateRunState } from '../js/shared/run-state.js';

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof CampaignRuleError && e.code === code);

/** A Saris-like Life cleric at level 4 (the synthetic cleric fixture, one level down). */
function cleric4() {
  const raw = loadDdbFixture('cleric-l5');
  raw.classes[0].level = 4;
  raw.classes[0].hitDiceUsed = 3;
  raw.baseHitPoints -= 5;   // DDB's base HP is the dice part: one d8 average less
  return parseCharacter(raw);
}

test('HP_ON_LEVEL_MODES / ASI_CAP / averageHitDieGain / classLevelOf', () => {
  assert.deepEqual([...HP_ON_LEVEL_MODES], ['average', 'roll']);
  assert.equal(ASI_CAP, 20);
  assert.deepEqual([6, 8, 10, 12].map(averageHitDieGain), [4, 5, 6, 7]);
  assert.equal(classLevelOf(cleric4(), 'Cleric'), 4);
  assert.equal(classLevelOf(cleric4(), 'Wizard'), 0);
});

test('Saris-like cleric 4→5: slots {1:4, 2:3, 3:2}, HP +5 + CON, Destroy Undead, PB 2→3', () => {
  const sheet = cleric4();
  assert.deepEqual(sheet.spellSlotTable.spell, { 1: 4, 2: 3 });
  const state = restedState(sheet);
  const plan = planLevelUp(sheet, state, { toLevel: 5 });
  assert.equal(plan.className, 'Cleric');
  assert.deepEqual(plan.auto.hp, { mode: 'average', die: 8, fixed: 5, con: 2, gain: 7 });
  assert.deepEqual(plan.auto.hitDice, { className: 'Cleric', die: 8, maxFrom: 4, maxTo: 5 });
  assert.deepEqual(plan.auto.proficiencyBonus, { from: 2, to: 3 });
  assert.deepEqual(plan.auto.spellSlots.to.spell, { 1: 4, 2: 3, 3: 2 });
  assert.deepEqual(plan.auto.features.map(f => f.name), ['Destroy Undead']);
  assert.equal(plan.choices.asi, null);
  assert.equal(plan.choices.spells.cantrips, 0);
  assert.equal(plan.choices.spells.prepared, 1, 'WIS 3 + level: 7 → 8');
  assert.equal(plan.choices.spells.maxSpellLevel, 3);
  assert.deepEqual(plan.missing, []);

  const { sheet: s5, state: st5, granted } = applyLevelUp(sheet, state, plan, {});
  assert.equal(s5.level, 5);
  assert.deepEqual(s5.classes, [{ name: 'Cleric', level: 5, subclass: 'Life Domain' }]);
  assert.deepEqual(s5.spellSlotTable.spell, { 1: 4, 2: 3, 3: 2 });
  assert.equal(s5.hp.max, sheet.hp.max + 5 + 2);
  assert.equal(st5.hp.current, state.hp.current + 7);
  assert.deepEqual(st5.slots.spell[3], { spent: 0 });
  assert.equal(proficiencyBonus(s5.level), 3);
  assert.ok(s5.classFeatures.some(f => f.name === 'Destroy Undead' && f.level === 5));
  assert.equal(s5.progression.Cleric.level, 5);
  assert.equal(granted.hp.gain, 7);
  assert.deepEqual(validateRunState(st5, { sheet: s5 }).errors, [], 'state_json v1 against the leveled sheet');
  assert.deepEqual(granted.features, ['Destroy Undead']);
  // The leveled sheet matches a fresh parse of the level-5 fixture where it matters.
  const fresh = parsedDdbFixture('cleric-l5');
  assert.deepEqual(s5.spellSlotTable, fresh.spellSlotTable);
  assert.deepEqual(s5.classFeatures.map(f => f.name), fresh.classFeatures.map(f => f.name));
  assert.equal(s5.hp.max, fresh.hp.max);
  // Inputs untouched.
  assert.equal(sheet.level, 4);
});

test('revertLevelUp restores a byte-identical sheet and removes the gains from the state', () => {
  const sheet = cleric4();
  const state = restedState(sheet);
  const before = JSON.stringify(sheet);
  const beforeState = JSON.stringify(state);
  const plan = planLevelUp(sheet, state, {});
  const up = applyLevelUp(sheet, state, plan, {});
  const back = revertLevelUp(up.sheet, up.state, up.granted);
  assert.equal(JSON.stringify(back.sheet), before);
  assert.equal(JSON.stringify(back.state), beforeState);
  // Damage taken after the level: the gain comes off what is left, floored at 1.
  const hurt = { ...up.state, hp: { current: 3, temp: 0 } };
  assert.equal(revertLevelUp(up.sheet, hurt, up.granted).state.hp.current, 1);
  // Only the latest level can be reverted.
  throwsCode(() => revertLevelUp(sheet, state, up.granted), 'revert-order');
  throwsCode(() => revertLevelUp(sheet, state, {}), 'bad-granted');
});

test('fighter 5→6: ASI choice (+2 or +1/+1, cap 20), PB unchanged; revert after an ASI', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const state = restedState(sheet);
  const plan = planLevelUp(sheet, state, {});
  assert.deepEqual(plan.choices.asi, { count: 1, points: 2, cap: 20, perStatMax: 2 });
  assert.equal(plan.auto.spellSlots, null);
  assert.equal(plan.choices.spells, null);
  assert.equal(plan.requiresDm, true);
  throwsCode(() => applyLevelUp(sheet, state, plan, {}), 'asi-required');
  throwsCode(() => applyLevelUp(sheet, state, plan, { asi: { STR: 1 } }), 'asi-points');
  throwsCode(() => applyLevelUp(sheet, state, plan, { asi: { STR: 3 } }), 'asi-bad-amount');
  throwsCode(() => applyLevelUp(sheet, state, plan, { asi: { LUCK: 2 } }), 'asi-bad-stat');
  const capped = { ...sheet, abilityScores: { ...sheet.abilityScores, STR: 19 } };
  throwsCode(() => applyLevelUp(capped, state, plan, { asi: { STR: 2 } }), 'asi-cap');
  // +1 STR / +1 CON: CON 14 → 15 keeps the +2 modifier (no retroactive HP).
  const up = applyLevelUp(sheet, state, plan, { asi: { STR: 1, CON: 1 } });
  assert.equal(up.sheet.abilityScores.STR, sheet.abilityScores.STR + 1);
  assert.equal(up.sheet.hp.max, 44 + 6 + 2);
  const before = JSON.stringify(sheet);
  assert.equal(JSON.stringify(revertLevelUp(up.sheet, up.state, up.granted).sheet), before);
  // A feat instead of the ASI is deferred to reconcile.
  const deferred = applyLevelUp(sheet, state, plan, { asi: 'reconcile' });
  assert.equal(deferred.granted.asiDeferred, true);
  assert.ok(plan.reconcile.some(r => r.kind === 'feat'));
});

test('a CON increase raises HP retroactively for every earlier level', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const odd = { ...sheet, abilityScores: { ...sheet.abilityScores, CON: 15 } };
  const plan = planLevelUp(odd, restedState(odd), {});
  const up = applyLevelUp(odd, restedState(odd), plan, { asi: { CON: 1, STR: 1 } });
  // CON 15 → 16: +3 on this level, +1 × 5 earlier levels.
  assert.equal(up.granted.hp.gain, 6 + 3 + 5);
  assert.equal(up.sheet.abilityModifiers.CON, 3);
});

test('hpOnLevel roll: rolls the hit die through the run rng (min 1 per level)', () => {
  const sheet = cleric4();
  const state = restedState(sheet);
  const plan = planLevelUp(sheet, state, { settings: { hpOnLevel: 'roll' } });
  assert.equal(plan.auto.hp.gain, null);
  assert.throws(() => applyLevelUp(sheet, state, plan, {}), TypeError);
  const up = applyLevelUp(sheet, state, plan, {}, { rng: () => faceFloat(8, 8) });
  assert.equal(up.granted.hp.roll, 8);
  assert.equal(up.granted.hp.gain, 10);
  const weak = { ...sheet, abilityScores: { ...sheet.abilityScores, CON: 3 }, abilityModifiers: { ...sheet.abilityModifiers, CON: -4 } };
  const low = applyLevelUp(weak, state, planLevelUp(weak, state, { settings: { hpOnLevel: 'roll' } }), {}, { rng: () => 0 });
  assert.equal(low.granted.hp.gain, 1);
});

test('wizard 5→6: +2 spellbook spells, max spell level 3, levelScales-free; Potent Cantrip at 6', () => {
  const sheet = parsedDdbFixture('wizard-l5');
  const state = restedState(sheet);
  const plan = planLevelUp(sheet, state, {});
  assert.deepEqual(plan.choices.spells, { className: 'Wizard', cantrips: 0, known: 2, prepared: 0, maxSpellLevel: 3 });
  assert.deepEqual(plan.auto.features.map(f => f.name), ['Potent Cantrip']);
  throwsCode(() => applyLevelUp(sheet, state, plan, { spells: [{ name: 'Fly', level: 3 }, { name: 'Haste', level: 3 }, { name: 'Slow', level: 3 }] }), 'spells-over-max');
  throwsCode(() => applyLevelUp(sheet, state, plan, { spells: [{ name: 'Wall of Fire', level: 4 }] }), 'spell-too-high');
  throwsCode(() => applyLevelUp(sheet, state, plan, { spells: [{ name: 'Fireball', level: 3 }] }), 'spell-duplicate');
  throwsCode(() => applyLevelUp(sheet, state, plan, { spells: [{ name: 'Light', level: 0 }] }), 'spells-over-max');
  const up = applyLevelUp(sheet, state, plan, { spells: [{ name: 'Fly', level: 3 }, { name: 'Haste', level: 3, kind: 'utility' }] });
  const fly = up.sheet.spells.find(s => s.name === 'Fly');
  assert.equal(fly.source, 'class');
  assert.equal(fly.spellCastingAbility, 'INT');
  assert.equal(fly.usesSpellSlot, true);
  assert.deepEqual(up.granted.spells, ['Fly', 'Haste']);
  assert.equal(JSON.stringify(revertLevelUp(up.sheet, up.state, up.granted).sheet), JSON.stringify(sheet));
});

test('levelScales: Destroy Undead steps at cleric 8; Divine Strike arrives with its die', () => {
  let sheet = parsedDdbFixture('cleric-l5');
  let state = restedState(sheet);
  for (const asi of [null, null, { WIS: 2 }]) {
    const plan = planLevelUp(sheet, state, {});
    ({ sheet, state } = applyLevelUp(sheet, state, plan, asi ? { asi } : {}));
  }
  assert.equal(sheet.level, 8);
  const plan = planLevelUp(cleric4(), restedState(cleric4()), {});
  assert.equal(plan.auto.levelScales.length, 1, 'Destroy Undead starts at 5');
  const strike = sheet.classFeatures.find(f => f.name === 'Divine Strike');
  assert.equal(strike.dice, '1d8');
  assert.equal(strike.source, 'Life Domain');
  assert.deepEqual(sheet.spellSlotTable.spell, { 1: 4, 2: 3, 3: 3, 4: 2 });
});

test('fighter 16→17: Action Surge uses go to 2 (SRD table) on sheet and state', () => {
  const raw = loadDdbFixture('fighter-l5');
  raw.classes[0].level = 16;
  const sheet = parseCharacter(raw);
  const state = restedState(sheet);
  const plan = planLevelUp(sheet, state, {});
  assert.ok(plan.auto.usesChanged.some(u => u.slug === 'action-surge' && u.from === 1 && u.to === 2));
  const up = applyLevelUp(sheet, state, plan, {});
  assert.equal(up.sheet.featureUses['action-surge'].max, 2);
  assert.equal(up.sheet.resources['feat:action-surge'].max, 2);
  assert.equal(up.state.resources['feat:action-surge'].max, 2);
  assert.deepEqual(validateRunState(up.state, { sheet: up.sheet }).errors, []);
  const back = revertLevelUp(up.sheet, up.state, up.granted);
  assert.equal(back.state.resources['feat:action-surge'].max, 1);
  assert.equal(JSON.stringify(back.sheet), JSON.stringify(sheet));
});

test('multiclass: the class choice, then the divisor; a new class is reconcile-only', () => {
  const raw = loadDdbFixture('cleric-l5');
  const wiz = loadDdbFixture('wizard-l5').classes[0];
  raw.classes = [{ ...raw.classes[0], level: 3 }, { ...wiz, level: 2 }];
  const sheet = parseCharacter(raw);
  const state = restedState(sheet);
  const plan = planLevelUp(sheet, state, {});
  assert.equal(plan.className, null);
  assert.deepEqual(plan.choices.className, { options: ['Cleric', 'Wizard'] });
  throwsCode(() => applyLevelUp(sheet, state, plan, {}), 'class-required');
  const up = applyLevelUp(sheet, state, plan, { className: 'Wizard', spells: [{ name: 'Shatter', level: 2 }] });
  assert.equal(classLevelOf(up.sheet, 'Wizard'), 3);
  // Caster level 6 → 4/3/3 through the PHB multiclass table.
  assert.deepEqual(up.sheet.spellSlotTable.spell, { 1: 4, 2: 3, 3: 3 });
  assert.equal(up.granted.hp.dieGain, 4, 'd6 average');
  throwsCode(() => planLevelUp(sheet, state, { className: 'Bard' }), 'unknown-class');
});

test('guards: one level at a time, level 20 cap, stale plans, missing progression → DM confirm', () => {
  const sheet = cleric4();
  const state = restedState(sheet);
  throwsCode(() => planLevelUp(sheet, state, { toLevel: 7 }), 'bad-level');
  throwsCode(() => planLevelUp({ ...sheet, level: 20 }, state, {}), 'max-level');
  const plan = planLevelUp(sheet, state, {});
  const up = applyLevelUp(sheet, state, plan, {});
  throwsCode(() => applyLevelUp(up.sheet, up.state, plan, {}), 'stale-plan');
  // A sheet parsed before R23 (no progression / hitDice): HP from the class name is unknown.
  const old = { ...sheet };
  delete old.progression;
  delete old.hitDice;
  const p2 = planLevelUp(old, { hp: { current: 30, temp: 0 } }, {});
  assert.deepEqual(p2.missing.sort(), ['hitDie', 'levelSpellSlots', 'progression']);
  assert.equal(p2.requiresDm, true);
  assert.equal(p2.auto.spellSlots, null);
  throwsCode(() => applyLevelUp(old, {}, p2, {}), 'missing-data');
});

test('subclass level with no subclass → a reconcile item', () => {
  const sheet = {
    level: 2, classes: [{ name: 'Fighter', level: 2, subclass: null }], abilityScores: { CON: 12 }, hp: { max: 20 },
    progression: { Fighter: { level: 2, hitDie: 10, features: [{ name: 'Martial Archetype', requiredLevel: 3, source: 'Fighter', asi: false, limitedUse: null, levelScales: null }], levelScales: {}, levelSpellSlots: null } }
  };
  const plan = planLevelUp(sheet, { hp: { current: 20, temp: 0 } }, {});
  assert.ok(plan.reconcile.some(r => r.kind === 'subclass'));
});

test('reconcileDiff: DDB level 6 vs granted 5 refused; structural changes proposed', () => {
  const runSheet = parsedDdbFixture('cleric-l5');
  const raw6 = loadDdbFixture('cleric-l5');
  raw6.classes[0].level = 6;
  const r = reconcileDiff(runSheet, parseCharacter(raw6), 5);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ddb-level-ahead');
  assert.deepEqual(r.proposals, []);
  throwsCode(() => applyReconcile(runSheet, parseCharacter(raw6), r, []), 'reconcile-refused');

  // Same level: a new feat (+1 CON) and a new spell on DDB; XP / HP / inventory are never proposed.
  const raw5 = loadDdbFixture('cleric-l5');
  raw5.feats = [...(raw5.feats || []), { definition: { id: 1, name: 'Resilient' } }];
  raw5.stats = raw5.stats.map(s => (s.id === 3 ? { ...s, value: 15 } : s));
  raw5.currentXp = 99999;
  raw5.baseHitPoints = 99;
  raw5.inventory = [];
  raw5.classSpells[0].spells.push({ prepared: true, definition: { id: 77, name: 'Revivify', level: 3, school: 'Necromancy', range: { origin: 'Touch' }, modifiers: [] } });
  const fresh = parseCharacter(raw5);
  const d = reconcileDiff(runSheet, fresh, 5);
  assert.equal(d.ok, true);
  const kinds = d.proposals.map(p => p.kind).sort();
  assert.deepEqual(kinds, ['ability', 'feat-added', 'spell-added']);
  const applied = applyReconcile(runSheet, fresh, d, d.proposals.map(p => p.id));
  assert.deepEqual(applied.sheet.feats, [...runSheet.feats, 'Resilient']);
  assert.equal(applied.sheet.abilityScores.CON, 15);
  assert.ok(applied.sheet.spells.some(s => s.name === 'Revivify'));
  assert.equal(applied.sheet.hp.max, runSheet.hp.max, 'HP is game-owned');
  assert.equal(applied.sheet.currentXp, runSheet.currentXp);
  assert.deepEqual(applied.sheet.inventory, runSheet.inventory);
  // Reconcile patches revert like a level-up.
  assert.equal(JSON.stringify(revertLevelUp(applied.sheet, {}, applied.granted).sheet), JSON.stringify(runSheet));
  throwsCode(() => applyReconcile(runSheet, fresh, d, ['nope']), 'unknown-proposal');
});

test('reconcile: a new multiclass is proposed and adds the class, its ladder and slots', () => {
  const raw = loadDdbFixture('cleric-l5');
  raw.classes[0].level = 4;
  const runSheet = parseCharacter(raw);
  // Game granted level 5 in reconcile mode; the player took Wizard 1 on DDB.
  const ddb = loadDdbFixture('cleric-l5');
  ddb.classes = [{ ...ddb.classes[0], level: 4 }, { ...loadDdbFixture('wizard-l5').classes[0], level: 1 }];
  const fresh = parseCharacter(ddb);
  const d = reconcileDiff(runSheet, fresh, 5);
  const mc = d.proposals.find(p => p.kind === 'class-level');
  assert.deepEqual([mc.class, mc.from, mc.to], ['Wizard', 0, 1]);
  const applied = applyReconcile(runSheet, fresh, d, [mc.id]);
  assert.equal(applied.sheet.level, 5);
  assert.ok(applied.sheet.progression.Wizard);
  assert.deepEqual(applied.sheet.spellSlotTable.spell, { 1: 4, 2: 3, 3: 2 }, 'caster level 5');
});
