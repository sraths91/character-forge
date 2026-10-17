/**
 * M64 phase 1.5 — feat / race granted spells spend their own uses
 * (`resources.features['spell:<id>']`), never a spell slot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneAttack } from '../js/scene/combat-engine.js';
import {
  featureLedgerFor, grantedSpellEntry, spellUseKey, usesLeft, spendUse, spellSlug
} from '../js/scene/feature-uses.js';
import { entityFromSheet, entityFromPreset, wrapperFromEntity, applyWrapperToEntity } from '../js/scene/encounter-adapters.js';
import { validateIntent } from '../js/scene/intent-validation.js';
import { emptyEncounterState, validateEncounterState } from '../js/shared/encounter-state.js';
import { createRng } from '../js/scene/rng.js';
import { parsedDdbFixture, buildScene } from './helpers/entities.js';

/** The cleric fixture (Fey Touched Misty Step) plus a Magic Initiate Magic Missile (1 / long rest). */
function cleric() {
  const sheet = parsedDdbFixture('cleric-l5');
  sheet.spells = [...sheet.spells, {
    name: 'Magic Missile', level: 1, kind: 'utility', source: 'feat', sourceName: 'Magic Initiate',
    uses: { max: 1, used: 0, reset: 'long rest' }
  }];
  return sheet;
}

function table(sheet) {
  const state = emptyEncounterState({ encounterId: 'e', cols: 8, rows: 6, seed: 3 });
  state.entities.cl = entityFromSheet(sheet, { id: 'cl', pos: { col: 1, row: 1 } });
  state.entities.gob = entityFromPreset('goblin', { id: 'gob', pos: { col: 4, row: 1 }, statBlock: { hpMax: 100 } });
  state.initiative = [{ entityId: 'cl', score: 20 }, { entityId: 'gob', score: 1 }];
  state.phase = 'running';
  return state;
}

test('granted spells: the cleric fixture\'s Fey Touched Misty Step is a uses ledger, not a slot', () => {
  const sheet = parsedDdbFixture('cleric-l5');
  const misty = grantedSpellEntry(sheet, 'misty-step');
  assert.equal(misty.source, 'feat');
  assert.deepEqual(misty.uses, { max: 1, used: 0, reset: 'long rest' });
  assert.equal(grantedSpellEntry(sheet, 'healing-word'), null, 'class spells use slots');
  assert.deepEqual(featureLedgerFor(sheet), { 'spell:misty-step': { max: 1, spent: 0 } });
  const e = entityFromSheet(sheet, { id: 'cl', pos: { col: 0, row: 0 } });
  assert.deepEqual(e.resources.features['spell:misty-step'], { max: 1, spent: 0 });
  const w = wrapperFromEntity(e, sheet);
  assert.equal(usesLeft(w, spellUseKey('misty-step')), 1);
  assert.equal(spendUse(w, 'spell:misty-step'), true);
  assert.equal(spendUse(w, 'spell:misty-step'), false, 'no second use');
  const back = applyWrapperToEntity(e, w);
  assert.deepEqual(back.resources.features['spell:misty-step'], { max: 1, spent: 1 });
  assert.deepEqual(back.resources.slots, e.resources.slots, 'no slot touched');
  assert.equal(spellSlug("Hunter's Mark"), 'hunters-mark');
});

test('granted spells: the engine spends the feat use, not a slot, at the spell\'s own level; then refuses', async () => {
  const sheet = cleric();
  const state = table(sheet);
  const w = wrapperFromEntity(state.entities.cl, sheet);
  const gob = wrapperFromEntity(state.entities.gob);
  const slotsBefore = { ...w._slots };
  const events = [];
  const ctx = { emit: (ev) => events.push(ev), turnId: 't' };
  const plan = { kind: 'cast', spellId: 'magic-missile', castAtLevel: 3, targetId: 'gob', targetSide: 'enemy', featuresFired: [] };
  await runOneAttack(w, [gob], [w], buildScene({ cols: 8, rows: 6 }), createRng({ s: 1 }), { forcePlan: plan }, ctx);
  assert.deepEqual(w._slots, slotsBefore, 'no slot spent');
  assert.deepEqual(w._features['spell:magic-missile'], { max: 1, spent: 1 });
  const cast = events.find(e => e.type === 'spell.cast');
  assert.equal(cast.payload.slotSpent, null);
  assert.equal(cast.payload.castAtLevel, 1, 'not upcast from a feat use');
  assert.ok(events.some(e => e.type === 'resource.spent' && e.payload.resource === 'feature:spell:magic-missile'));
  assert.ok(!events.some(e => e.type === 'resource.spent' && e.payload.resource === 'spell-slot'));
  // Persisted, valid.
  const next = applyWrapperToEntity(state.entities.cl, w);
  assert.deepEqual(next.resources.features['spell:magic-missile'], { max: 1, spent: 1 });
  assert.deepEqual(validateEncounterState({ ...state, entities: { ...state.entities, cl: next } }).errors, []);
  // A second cast is refused before anything resolves.
  const again = [];
  await runOneAttack(w, [gob], [w], buildScene({ cols: 8, rows: 6 }), createRng({ s: 2 }), { forcePlan: plan }, { emit: (ev) => again.push(ev), turnId: 't2' });
  assert.ok(again.some(e => e.type === 'turn.rejected' && e.payload.code === 'no-uses'));
  assert.ok(!again.some(e => e.type === 'spell.cast'));
  assert.deepEqual(w._slots, slotsBefore);
});

test('granted spells: validateIntent reads the encounter ledger before the sheet', () => {
  const sheet = cleric();
  const sheets = { [String(sheet.id)]: sheet };
  const state = table(sheet);
  const intent = { actorId: 'cl', plan: { kind: 'cast', spellId: 'magic-missile', targetId: 'gob' } };
  assert.deepEqual(validateIntent(state, intent, { sheets }), { ok: true });
  state.entities.cl.resources.features['spell:magic-missile'].spent = 1;
  const v = validateIntent(state, intent, { sheets });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'no-slot');
  assert.match(v.reason, /no uses left/);
  assert.ok(Object.values(state.entities.cl.resources.slots).some(l => l.max - l.spent > 0), 'slots were still free');
});

test('granted spells: the AI casts a granted spell at its own level from its uses, and stops when they are gone', async () => {
  const { choosePcAction } = await import('../js/scene/ai/pc-action.js');
  const { PC_PROFILES } = await import('../js/scene/ai/pc-profiles.js');
  const sheet = cleric();
  sheet._aiProfile = PC_PROFILES.wizard;
  sheet.spells = sheet.spells.filter(s => s.name !== 'Sacred Flame');
  const state = table(sheet);
  const w = wrapperFromEntity(state.entities.cl, sheet);
  w._slots = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const gob = wrapperFromEntity(state.entities.gob);
  const plan = choosePcAction({ self: w, enemies: [gob], allies: [w], rng: createRng({ s: 4 }) });
  assert.equal(plan.spellId, 'magic-missile', 'no slots, but the feat use is there');
  assert.equal(plan.castAtLevel, 1);
  w._features['spell:magic-missile'].spent = 1;
  const after = choosePcAction({ self: w, enemies: [gob], allies: [w], rng: createRng({ s: 4 }) });
  assert.notEqual(after.spellId, 'magic-missile');
});
