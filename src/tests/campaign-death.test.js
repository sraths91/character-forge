// M65 R28 — life status, death modes, revival, between-node healing spells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIFE_STATUSES, DEATH_MODES, REVIVE_METHODS, REVIVE_RULES, LIFE_TRANSITIONS, lifeStatusOf, transitionLifeStatus,
  settleAfterEncounter, onNodeEntry, diamondValueGp, revive, canAttemptRevive
} from '../js/campaign/death.js';
import { DOWNTIME_HEALS, downtimeHealDice, castDowntimeHeal } from '../js/campaign/downtime-spells.js';
import { makeItem } from '../js/campaign/items.js';
import { CampaignRuleError } from '../js/campaign/errors.js';
import { parsedDdbFixture } from './helpers/entities.js';
import { restedState, faceFloat, scriptedRng } from './helpers/campaign-state.js';

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof CampaignRuleError && e.code === code);
const deadState = (sheet) => restedState(sheet, { hp: { current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 3, stable: false } });

/** A cleric 5 caster who knows Revivify and Raise Dead (slots of 3rd level; 5th only when given). */
function caster({ fifth = false } = {}) {
  const sheet = parsedDdbFixture('cleric-l5');
  sheet.spells = [...sheet.spells, { name: 'Prayer of Healing', level: 2, source: 'class', spellCastingAbility: 'WIS' },
    { name: 'Revivify', level: 3, source: 'class', spellCastingAbility: 'WIS' }, { name: 'Raise Dead', level: 5, source: 'class', spellCastingAbility: 'WIS' }];
  if (fifth) sheet.spellSlotTable = { ...sheet.spellSlotTable, spell: { ...sheet.spellSlotTable.spell, 4: 3, 5: 1 } };
  const state = restedState(sheet);
  return { id: 'cleric', sheet, state };
}
const diamond = (id, gp, qty = 1) => makeItem({ id, origin: 'dm', name: `Diamond (${gp} gp)`, qty, data: { valueGp: gp } });

test('constants', () => {
  assert.deepEqual([...LIFE_STATUSES], ['active', 'dying', 'stable', 'dead']);
  assert.deepEqual([...DEATH_MODES], ['standard', 'permadeath', 'lenient']);
  assert.deepEqual([...REVIVE_METHODS], ['revivify', 'raise-dead', 'dm']);
  assert.deepEqual([REVIVE_RULES.revivify.slotLevel, REVIVE_RULES.revivify.diamondGp], [3, 300]);
  assert.deepEqual([REVIVE_RULES['raise-dead'].slotLevel, REVIVE_RULES['raise-dead'].diamondGp], [5, 500]);
  assert.deepEqual([...LIFE_TRANSITIONS.dead], []);
});

test('lifeStatusOf: state_json and engine entities', () => {
  assert.equal(lifeStatusOf({ hp: { current: 5 } }), 'active');
  assert.equal(lifeStatusOf({ hp: { current: 0 }, deathSaves: { successes: 1, failures: 1 } }), 'dying');
  assert.equal(lifeStatusOf({ hp: { current: 0 }, deathSaves: { stable: true } }), 'stable');
  assert.equal(lifeStatusOf({ hp: { current: 0 }, deathSaves: { failures: 3 } }), 'dead');
  assert.equal(lifeStatusOf({ hp: 0, status: 'downed' }), 'dying');
  assert.equal(lifeStatusOf({ hp: 0, status: 'dead' }), 'dead');
  assert.equal(lifeStatusOf({ hp: 7 }), 'active');
  assert.equal(lifeStatusOf(null), 'dead');
});

test('transitionLifeStatus: dead → active only through revive', () => {
  assert.equal(transitionLifeStatus('active', 'dying'), 'dying');
  assert.equal(transitionLifeStatus('dying', 'stable'), 'stable');
  assert.equal(transitionLifeStatus('stable', 'stable'), 'stable');
  throwsCode(() => transitionLifeStatus('dead', 'active'), 'bad-transition');
  assert.equal(transitionLifeStatus('dead', 'active', { via: 'revive' }), 'active');
  throwsCode(() => transitionLifeStatus('dead', 'stable', { via: 'revive' }), 'bad-transition');
  throwsCode(() => transitionLifeStatus('zombie', 'active'), 'bad-life-status');
});

test('settleAfterEncounter: victory stabilises (standard) or stands up at 1 HP (lenient); dead stays dead', () => {
  const dying = { hp: { current: 0, temp: 0 }, deathSaves: { successes: 1, failures: 2, stable: false } };
  const std = settleAfterEncounter(dying, { outcome: 'victory', deathMode: 'standard' });
  assert.equal(std.lifeStatus, 'stable');
  assert.equal(std.state.deathSaves.stable, true);
  const len = settleAfterEncounter(dying, { outcome: 'victory', deathMode: 'lenient' });
  assert.equal(len.lifeStatus, 'active');
  assert.equal(len.state.hp.current, 1);
  assert.equal(settleAfterEncounter(dying, { outcome: 'defeat', deathMode: 'lenient' }).lifeStatus, 'dying');
  const dead = { hp: { current: 0 }, deathSaves: { failures: 3 } };
  assert.equal(settleAfterEncounter(dead, { outcome: 'victory', deathMode: 'lenient' }).lifeStatus, 'dead');
  assert.equal(settleAfterEncounter({ hp: { current: 9 } }, { outcome: 'victory' }).lifeStatus, 'active');
  throwsCode(() => settleAfterEncounter(dying, { outcome: 'victory', deathMode: 'hardcore' }), 'bad-death-mode');
});

test('onNodeEntry: a stable PC regains 1 HP', () => {
  const r = onNodeEntry({ hp: { current: 0, temp: 0 }, deathSaves: { successes: 3, failures: 0, stable: true } });
  assert.equal(r.lifeStatus, 'active');
  assert.equal(r.state.hp.current, 1);
  assert.deepEqual(r.state.deathSaves, { successes: 0, failures: 0, stable: false });
  assert.equal(onNodeEntry({ hp: { current: 0 }, deathSaves: { failures: 3 } }).lifeStatus, 'dead');
  assert.deepEqual(onNodeEntry({ hp: { current: 4 } }).deltas, []);
});

test('standard Revivify → 1 HP; a 3rd-level slot and a 300 gp diamond spent', () => {
  const target = parsedDdbFixture('fighter-l5');
  const c = caster();
  const items = [diamond('d1', 300), makeItem({ id: 'rope', origin: 'dm', name: 'Rope' })];
  const r = revive(deadState(target), { method: 'revivify', caster: c, items, deathMode: 'standard', betweensSinceDeath: 0 });
  assert.equal(r.lifeStatus, 'active');
  assert.equal(r.state.hp.current, 1);
  assert.deepEqual(r.state.deathSaves, { successes: 0, failures: 0, stable: false });
  assert.deepEqual(r.spent.slot, { level: 3, kind: 'spell' });
  assert.equal(r.casterState.slots.spell[3].spent, 1);
  assert.deepEqual(r.spent.items, [{ id: 'd1', qty: 1 }]);
  assert.equal(r.items.find(i => i.id === 'd1').qty, 0);
  assert.equal(r.override, false);
  assert.equal(items[0].qty, 1, 'input items not mutated');
});

test('permadeath refuses Revivify; the DM override still works (logged)', () => {
  const target = parsedDdbFixture('fighter-l5');
  throwsCode(() => revive(deadState(target), { method: 'revivify', caster: caster(), items: [diamond('d', 300)], deathMode: 'permadeath' }), 'permadeath');
  const dm = revive(deadState(target), { method: 'dm', deathMode: 'permadeath', hp: 10 });
  assert.equal(dm.state.hp.current, 10);
  assert.equal(dm.override, true);
  assert.equal(dm.casterState, null);
});

test('Revivify guards: too late, no caster / spell / slot / diamond, caster down, not dead', () => {
  const t = deadState(parsedDdbFixture('fighter-l5'));
  const c = caster();
  throwsCode(() => revive(t, { method: 'revivify', caster: c, items: [diamond('d', 300)], betweensSinceDeath: 1 }), 'too-late');
  throwsCode(() => revive(t, { method: 'revivify', items: [diamond('d', 300)] }), 'no-caster');
  const noSpell = { ...c, sheet: parsedDdbFixture('cleric-l5') };
  throwsCode(() => revive(t, { method: 'revivify', caster: noSpell, items: [diamond('d', 300)] }), 'no-spell');
  const spentOut = { ...c, state: { ...c.state, slots: { spell: { 1: { spent: 0 }, 2: { spent: 0 }, 3: { spent: 2 } }, pact: {} } } };
  throwsCode(() => revive(t, { method: 'revivify', caster: spentOut, items: [diamond('d', 300)] }), 'no-slot');
  throwsCode(() => revive(t, { method: 'revivify', caster: c, items: [diamond('d', 100), diamond('e', 300, 0)] }), 'no-diamond');
  throwsCode(() => revive(t, { method: 'revivify', caster: { ...c, state: { ...c.state, hp: { current: 0 } } }, items: [diamond('d', 300)] }), 'caster-down');
  throwsCode(() => revive({ hp: { current: 5 } }, { method: 'dm' }), 'not-dead');
  throwsCode(() => revive(t, { method: 'wish' }), 'bad-method');
});

test('Raise Dead at a later between: 5th-level slot and a 500 gp diamond (the cheapest that qualifies)', () => {
  const t = deadState(parsedDdbFixture('fighter-l5'));
  throwsCode(() => revive(t, { method: 'raise-dead', caster: caster(), items: [diamond('d', 500)], betweensSinceDeath: 3 }), 'no-slot');
  const r = revive(t, { method: 'raise-dead', caster: caster({ fifth: true }), items: [diamond('big', 1000), diamond('d', 500), diamond('small', 300)], betweensSinceDeath: 3 });
  assert.deepEqual(r.spent.slot, { level: 5, kind: 'spell' });
  assert.deepEqual(r.spent.items, [{ id: 'd', qty: 1 }]);
  assert.equal(r.state.hp.current, 1);
});

test('canAttemptRevive and diamondValueGp', () => {
  assert.equal(canAttemptRevive({ method: 'revivify', betweensSinceDeath: 0 }), true);
  assert.equal(canAttemptRevive({ method: 'revivify', betweensSinceDeath: 1 }), false);
  assert.equal(canAttemptRevive({ method: 'raise-dead', betweensSinceDeath: 4 }), true);
  assert.equal(canAttemptRevive({ method: 'raise-dead', deathMode: 'permadeath' }), false);
  assert.equal(canAttemptRevive({ method: 'dm', deathMode: 'permadeath' }), true);
  assert.equal(diamondValueGp(diamond('x', 300)), 300);
  assert.equal(diamondValueGp(makeItem({ origin: 'open5e', name: 'Diamond', data: { cost: 500 } })), 500);
  assert.equal(diamondValueGp({ name: 'Ruby', data: { valueGp: 900 } }), null);
});

test('downtime Cure Wounds: slot spent, 1d8 + WIS + Disciple of Life, capped at max', () => {
  const c = caster();
  const fighter = parsedDdbFixture('fighter-l5');
  const target = { id: 'f', sheet: fighter, state: restedState(fighter, { hp: { current: 10, temp: 0 } }) };
  const r = castDowntimeHeal({ caster: c, spell: 'Cure Wounds', targets: [target], rng: () => faceFloat(6, 8) });
  // 6 + WIS 3 + Disciple of Life (2 + 1) = 12.
  assert.deepEqual(r.roll, { dice: '1d8', rolls: [6], total: 6, mod: 3, bonus: 3 });
  assert.equal(r.targets[0].state.hp.current, 22);
  assert.equal(r.casterState.slots.spell[1].spent, 1);
  // Upcast at 3rd: 3d8.
  assert.equal(downtimeHealDice('cure-wounds', 3), '3d8');
  const up = castDowntimeHeal({ caster: c, spell: 'cure-wounds', slotLevel: 3, targets: [{ ...target, state: { ...target.state, hp: { current: 20, temp: 0 } } }], rng: () => 0.99 });
  assert.equal(up.targets[0].state.hp.current, 44, 'capped at the fighter max');
  assert.equal(up.casterState.slots.spell[3].spent, 1);
});

test('downtime Healing Word on a dying ally stands them up; the caster can heal themself', () => {
  const c = caster();
  c.state = { ...c.state, hp: { current: 20, temp: 0 } };
  const fighter = parsedDdbFixture('fighter-l5');
  const down = { id: 'f', sheet: fighter, state: restedState(fighter, { hp: { current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 2, stable: false } }) };
  const r = castDowntimeHeal({ caster: c, spell: 'Healing Word', targets: [down], rng: () => 0 });
  assert.equal(r.targets[0].state.hp.current, 1 + 3 + 3);
  assert.deepEqual(r.targets[0].state.deathSaves, { successes: 0, failures: 0, stable: false });
  const self = castDowntimeHeal({ caster: c, spell: 'Healing Word', targets: [{ id: 'cleric', sheet: c.sheet, state: c.state }], rng: () => 0 });
  assert.equal(self.casterState.hp.current, 27);
  assert.equal(self.casterState.slots.spell[1].spent, 1, 'slot and healing on one state');
});

test('downtime Prayer of Healing: one roll, up to six targets; guards', () => {
  const c = caster();
  const fighter = parsedDdbFixture('fighter-l5');
  const t = (id, hp) => ({ id, sheet: fighter, state: restedState(fighter, { hp: { current: hp, temp: 0 } }) });
  const r = castDowntimeHeal({ caster: c, spell: 'Prayer of Healing', targets: [t('a', 5), t('b', 30)], rng: scriptedRng([faceFloat(4, 8), faceFloat(5, 8)]) });
  // 2d8 (4 + 5) + WIS 3 + Disciple (2 + 2) = 16 each.
  assert.deepEqual(r.targets.map(x => x.healed), [16, 14]);
  assert.equal(r.casterState.slots.spell[2].spent, 1);
  throwsCode(() => castDowntimeHeal({ caster: c, spell: 'Prayer of Healing', targets: [1, 2, 3, 4, 5, 6, 7].map(i => t(`x${i}`, 1)), rng: () => 0 }), 'too-many-targets');
  throwsCode(() => castDowntimeHeal({ caster: c, spell: 'Prayer of Healing', slotLevel: 1, targets: [t('a', 1)], rng: () => 0 }), 'slot-too-low');
  throwsCode(() => castDowntimeHeal({ caster: c, spell: 'Mass Cure Wounds', targets: [t('a', 1)], rng: () => 0 }), 'not-downtime-spell');
  throwsCode(() => castDowntimeHeal({ caster: c, spell: 'Cure Wounds', targets: [], rng: () => 0 }), 'no-targets');
  throwsCode(() => castDowntimeHeal({ caster: c, spell: 'Cure Wounds', targets: [{ ...t('d', 0), state: deadState(fighter) }], rng: () => 0 }), 'target-dead');
  const empty = { ...c, state: { ...c.state, slots: { spell: { 1: { spent: 4 }, 2: { spent: 3 }, 3: { spent: 2 } }, pact: {} } } };
  throwsCode(() => castDowntimeHeal({ caster: empty, spell: 'Cure Wounds', targets: [t('a', 1)], rng: () => 0 }), 'no-slot');
  const wizard = parsedDdbFixture('wizard-l5');
  throwsCode(() => castDowntimeHeal({ caster: { id: 'w', sheet: wizard, state: restedState(wizard) }, spell: 'Cure Wounds', targets: [t('a', 1)], rng: () => 0 }), 'no-spell');
  assert.ok(Object.isFrozen(DOWNTIME_HEALS['cure-wounds']));
  assert.throws(() => castDowntimeHeal({ caster: c, spell: 'Cure Wounds', targets: [t('a', 1)] }), TypeError);
});
