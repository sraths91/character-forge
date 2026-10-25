/**
 * M64 phase 1.5 leftovers (M65 Wave 1, E1):
 *   A — the simulator / calibrator fight a monster's `statBlock` (the DM's
 *       live difficulty card for Open5e monsters), not only its `hp`;
 *   B — a normalised block's `spellcasting` builds the monster's spellbook
 *       (registry spells by name; unknown ones skipped with a note).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCreature } from '../js/scene/open5e-normalize.js';
import { simulateEncounter } from '../js/scene/simulator.js';
import { calibrateEncounter } from '../js/scene/calibrator.js';
import { canonicalJson, fnv1a } from './helpers/golden-runner.js';
import { parsedDdbFixture, DDB_FIXTURES } from './helpers/entities.js';
import { buildStatBlockKit, BOOK_DEFAULT_WEIGHTS } from '../js/scene/stat-block-kit.js';
import { entityFromPreset, entityFromSheet, wrapperFromEntity, applyEngineSides } from '../js/scene/encounter-adapters.js';
import { spellbookForEntity, MONSTER_SPELLCASTING } from '../js/scene/monster-spells.js';
import { chooseAction } from '../js/scene/ai/profile.js';
import { validateIntent, planFromIntent } from '../js/scene/intent-validation.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { emptyEncounterState, validateEncounterState } from '../js/shared/encounter-state.js';
import { createRng } from '../js/scene/rng.js';

const DIR = new URL('./fixtures/open5e/', import.meta.url);
const block = (slug) => normalizeCreature(JSON.parse(readFileSync(new URL(`srd_${slug}.json`, DIR), 'utf8')));
const party = () => DDB_FIXTURES.map((n, i) => ({ ...parsedDdbFixture(n), _position: { col: 2, row: 2 + i } }));
const SCENE = { cols: 10, rows: 8 };

test('leftover A: preset-only simulations are byte-identical to phase 1.5', async () => {
  const monsters = [
    { id: 'm1', name: 'Fan', presetSlug: 'cult-fanatic', position: { col: 5, row: 3 } },
    { id: 'm2', name: 'Drg', presetSlug: 'young-dragon', position: { col: 6, row: 2 } }
  ];
  const stats = await simulateEncounter({ party: party(), monsters, scene: SCENE, iterations: 40, seed: 7 });
  // Hash of the same run at main bb0eb05 (before M65).
  assert.equal(fnv1a(canonicalJson(stats)), '188ede9b');
});

test('leftover A: a normalised Young Red Dragon changes the win rate vs the preset', async () => {
  const base = { id: 'drg', name: 'Dragon', presetSlug: 'young-dragon', position: { col: 4, row: 3 } };
  const preset = await calibrateEncounter({ party: party(), monsters: [base], scene: SCENE, iterations: 100, seed: 3 });
  const real = await calibrateEncounter({ party: party(), monsters: [{ ...base, statBlock: block('young-red-dragon') }], scene: SCENE, iterations: 100, seed: 3 });
  assert.ok(real.winRate < preset.winRate, `stat block ${real.winRate} vs preset ${preset.winRate}`);
  assert.ok(real.avgRounds < preset.avgRounds, 'Fire Breath ends it faster');
  const drg = real.perEntity.find(e => e.id === 'drg');
  assert.equal(drg.hpMax, 178, 'the block\'s HP');
  assert.equal(drg.name, 'Dragon');
  assert.deepEqual([real.difficulty.baseXp, real.difficulty.label], [5900, 'deadly'], 'XP from the block');
});

test('leftover A: the input `hp` still sets the stat-block monster\'s current HP; no block = preset path', async () => {
  const sb = block('young-red-dragon');
  const seen = [];
  await simulateEncounter({
    party: party(), scene: SCENE, iterations: 1, seed: 1,
    monsters: [{ id: 'drg', presetSlug: 'young-dragon', statBlock: sb, hp: { current: 50, max: 178 }, position: { col: 4, row: 3 } }],
    onIterationEnd: ({ mons }) => seen.push(mons[0])
  });
  assert.equal(seen[0].hpMax, 178);
  assert.equal(seen[0].ac, 18);
  assert.ok(seen[0]._statBlockKit, 'recharge abilities from the block');
  assert.equal(seen[0].id, 'drg');
  // A block on an unknown preset slug cannot be wrapped: the preset path runs.
  const r = await simulateEncounter({
    party: party(), scene: SCENE, iterations: 2, seed: 1,
    monsters: [{ id: 'x', presetSlug: 'not-a-preset', statBlock: sb, position: { col: 4, row: 3 } }]
  });
  assert.equal(r.iterations, 2);
});

test('leftover A: calibrator XP reads a block\'s xp, else its decimal CR', async () => {
  const { ratedDifficulty } = await import('../js/scene/calibrator.js');
  const pcs = party();
  const at = (statBlock) => ratedDifficulty({ party: pcs, monsters: [{ presetSlug: 'goblin', statBlock }] }).baseXp;
  assert.equal(at({ xp: 450 }), 450);
  assert.equal(at({ cr: 0.25 }), 50);
  assert.equal(at({ cr: 0.125 }), 25);
  assert.equal(at({ cr: 3 }), 700);
  assert.equal(at(undefined), 50, 'preset fallback unchanged');
});

// ---------------------------------------------------------------------
// Leftover B — spellbooks from statBlock.spellcasting
// ---------------------------------------------------------------------

test('leftover B: the Cult Fanatic block builds its own book; unknown spells are skipped', () => {
  const kit = buildStatBlockKit(block('cult-fanatic'));
  const book = kit.spellbook;
  assert.deepEqual(book.spells, ['sacred-flame', 'inflict-wounds', 'hold-person', 'spiritual-weapon']);
  assert.deepEqual(book.skipped, ['light', 'thaumaturgy', 'command', 'shield of faith']);
  assert.deepEqual([book.ability, book.dc, book.attackBonus, book.abilityMod, book.slots], ['WIS', 11, 3, 1, { 1: 4, 2: 3 }]);
  assert.deepEqual(book.weights, {
    'sacred-flame': BOOK_DEFAULT_WEIGHTS.cantrip, 'inflict-wounds': BOOK_DEFAULT_WEIGHTS.leveled,
    'hold-person': BOOK_DEFAULT_WEIGHTS.leveled, 'spiritual-weapon': BOOK_DEFAULT_WEIGHTS.leveled
  });
  assert.equal(kit.innate, null, 'slot caster, no innate');
  assert.equal(buildStatBlockKit(block('young-red-dragon')).spellbook, null, 'no spellcasting trait');
});

/** A PC next to a goblin-sprite monster fighting from the Cult Fanatic block. */
function fanaticTable(statBlock = block('cult-fanatic')) {
  const sheet = parsedDdbFixture('fighter-l5');
  const state = emptyEncounterState({ encounterId: 'e-book', cols: 10, rows: 6, seed: 2 });
  const pc = entityFromSheet(sheet, { id: 'pc', pos: { col: 3, row: 2 } });
  const m = entityFromPreset('goblin', { id: 'fan', pos: { col: 4, row: 2 }, statBlock });
  state.entities = { pc, fan: m };
  state.initiative = [{ entityId: 'fan', score: 15 }, { entityId: 'pc', score: 3 }];
  state.phase = 'running';
  state.round = 1;
  return { sheet, state, pc, m };
}

test('leftover B: a goblin sprite with the fanatic block has the block\'s slots and spells (the preset has none)', () => {
  assert.equal(MONSTER_SPELLCASTING.goblin, undefined);
  const { state, m, sheet } = fanaticTable();
  assert.deepEqual(m.resources.slots, { 1: { max: 4, spent: 0 }, 2: { max: 3, spent: 0 } });
  assert.deepEqual(validateEncounterState(state).errors, []);
  const w = wrapperFromEntity(m);
  assert.equal(spellbookForEntity(w).source, 'statBlock');
  assert.deepEqual(w._slots, { 1: 4, 2: 3 });
  const sheets = { [state.entities.pc.sheetRef.characterId]: sheet };
  assert.deepEqual(validateIntent(state, { actorId: 'fan', plan: { kind: 'cast', spellId: 'hold-person', targetId: 'pc' } }, { sheets }), { ok: true });
  const unknown = validateIntent(state, { actorId: 'fan', plan: { kind: 'cast', spellId: 'cure-wounds', targetId: 'fan', targetSide: 'ally' } }, { sheets });
  assert.equal(unknown.code, 'unknown-spell', 'the preset fanatic knows Cure Wounds; this block does not');
  // A plain goblin still knows nothing.
  const plain = fanaticTable(undefined);
  delete plain.state.entities.fan.statBlock.source;
  assert.equal(validateIntent(plain.state, { actorId: 'fan', plan: { kind: 'cast', spellId: 'hold-person', targetId: 'pc' } }, { sheets }).code, 'unknown-spell');
});

test('leftover B: the AI casts from the block book with default weights; skipped spells are noted in the breakdown', async () => {
  const { state, sheet } = fanaticTable();
  const pc = wrapperFromEntity(state.entities.pc, sheet);
  const fan = wrapperFromEntity(state.entities.fan);
  const plan = chooseAction({ self: fan, enemies: [pc], allies: [fan], rng: createRng({ s: 1 }) });
  assert.equal(plan.kind, 'cast', JSON.stringify(plan));
  assert.ok(['hold-person', 'inflict-wounds', 'spiritual-weapon', 'sacred-flame'].includes(plan.spellId));
  const note = plan.breakdown.find(b => b.name === 'spellbook:skipped');
  assert.deepEqual([note.raw, note.weighted], [4, 0]);
  assert.match(note.note, /light, thaumaturgy, command, shield of faith/);
  // The cast resolves with the block's DC (11) and spends the block's slot.
  const events = [];
  await runOneAttack(fan, [pc], [fan], { cols: 10, rows: 6 }, createRng({ s: 4 }), {
    forcePlan: planFromIntent(state, { actorId: 'fan', plan: { kind: 'cast', spellId: 'hold-person', targetId: 'pc' } }, {})
  }, { emit: (ev) => events.push(ev) });
  assert.equal(events.find(e => e.type === 'save.rolled').payload.dc, 11);
  assert.equal(fan._slots[2], 2);
  const back = applyEngineSides(state, [fan]).entities.fan;
  assert.deepEqual(back.resources.slots['2'], { max: 3, spent: 1 });
});

test('leftover B: innate spellcasting (at will / N per day) joins the kit\'s innate block and keeps its uses', async () => {
  const sb = { ...block('young-red-dragon') };
  sb.spellcasting = {
    dc: 15, toHit: 7, ability: 'CHA', casterLevel: null, innate: true, slots: {},
    spells: [{ name: 'fire bolt', level: null, perDay: null }, { name: 'hold person', level: null, perDay: 1 }, { name: 'wish', level: null, perDay: 1 }]
  };
  const kit = buildStatBlockKit(sb);
  assert.deepEqual(kit.innate, { recharge: { 'Fire Breath': 5 }, atWill: ['fire-bolt'], perDay: { 1: ['hold-person'] } });
  assert.deepEqual([kit.spellbook.spells, kit.spellbook.skipped, kit.spellbook.dc, kit.spellbook.abilityMod], [[], ['wish'], 15, 4]);
  const { state, sheet } = fanaticTable(sb);
  const ent = state.entities.fan;
  assert.deepEqual(ent.resources.innate.perDay, { 1: [{ id: 'hold-person', remaining: 1 }] });
  assert.deepEqual(ent.resources.slots, {});
  const sheets = { [state.entities.pc.sheetRef.characterId]: sheet };
  const intent = { actorId: 'fan', plan: { kind: 'cast', spellId: 'hold-person', targetId: 'pc' } };
  assert.deepEqual(validateIntent(state, intent, { sheets }), { ok: true });
  const forcePlan = planFromIntent(state, intent, { sheets });
  assert.equal(forcePlan.isInnate, true);
  const fan = wrapperFromEntity(ent);
  const pc = wrapperFromEntity(state.entities.pc, sheet);
  const events = [];
  await runOneAttack(fan, [pc], [fan], { cols: 10, rows: 6 }, createRng({ s: 4 }), { forcePlan }, { emit: (ev) => events.push(ev) });
  assert.equal(events.find(e => e.type === 'save.rolled').payload.dc, 15, 'the block DC, not the innate default 12');
  const after = applyEngineSides(state, [fan]);
  assert.deepEqual(after.entities.fan.resources.innate.perDay, { 1: [{ id: 'hold-person', remaining: 0 }] });
  assert.deepEqual(wrapperFromEntity(after.entities.fan)._innate.perDay, { 1: [{ id: 'hold-person', remaining: 0 }] }, 'the spent use survives a re-wrap');
  assert.equal(validateIntent({ ...after, turnIndex: 0 }, intent, { sheets }).code, 'no-slot', 'no second use');
});

test('leftover B: in the simulator the block caster spends the block\'s slots', async () => {
  const spent = [];
  // One PC, so the fanatic lives to act.
  await simulateEncounter({
    party: party().slice(0, 1), scene: SCENE, iterations: 10, seed: 2,
    monsters: [{ id: 'fan', name: 'Fanatic', presetSlug: 'goblin', statBlock: block('cult-fanatic'), position: { col: 6, row: 3 } }],
    onIterationEnd: ({ mons }) => spent.push((4 - mons[0]._slots[1]) + (3 - mons[0]._slots[2]))
  });
  assert.ok(spent.some(n => n > 0), `slots spent per run: ${spent}`);
});
