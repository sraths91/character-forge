/**
 * M64 phase 1.5 wave 6b — recharge abilities, legendary actions and
 * Legendary Resistance from a normalised SRD stat block (not the preset
 * slug).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCreature } from '../js/scene/open5e-normalize.js';
import {
  buildStatBlockKit, statBlockKitOf, freshKitInnate, kitInnateState, kitLegendaryResistance,
  LEGENDARY_RESISTANCE_KEY, RECHARGE_AI_WEIGHT
} from '../js/scene/stat-block-kit.js';
import {
  innateBlockForEntity, freshInnateStateForEntity, spellForEntity, freshInnateFromBlock,
  rollInnateRecharges, MONSTER_SPELLS
} from '../js/scene/monster-spells.js';
import {
  legendaryBlockForEntity, isLegendaryEntity, resetLegendaryBudget, chooseLegendaryAction, LEGENDARY_ACTIONS
} from '../js/scene/monster-legendary.js';
import { entityFromPreset, entityFromSheet, toEngineSides, applyEngineSides } from '../js/scene/encounter-adapters.js';
import { emptyEncounterState, validateEncounterState } from '../js/shared/encounter-state.js';
import { validateEvent } from '../js/shared/events.js';
import { runOneAttack, runLegendaryActions } from '../js/scene/combat-engine.js';
import { beginTurnResets, turnStateFromEncounter, startEncounter, runTurn, encounterFromTurnState } from '../js/scene/turn-manager.js';
import { validateIntent, planFromIntent } from '../js/scene/intent-validation.js';
import { createRng } from '../js/scene/rng.js';
import { parsedDdbFixture } from './helpers/entities.js';

const DIR = new URL('./fixtures/open5e/', import.meta.url);
const sb = (slug) => normalizeCreature(JSON.parse(readFileSync(new URL(`srd_${slug}.json`, DIR), 'utf8')));
const fighter = parsedDdbFixture('fighter-l5');

/** One PC next to one stat-block monster (preset `young-dragon` = sprite only). */
function arena(slug, { preset = 'young-dragon', pcPos = { col: 3, row: 2 } } = {}) {
  const state = emptyEncounterState({ encounterId: 'e-kit', cols: 12, rows: 8, seed: 3 });
  const pc = entityFromSheet(fighter, { pos: pcPos });
  const m = entityFromPreset(preset, { id: 'm-drg', pos: { col: 4, row: 2 }, statBlock: sb(slug) });
  state.entities[pc.id] = pc;
  state.entities[m.id] = m;
  return { state, pc, m };
}

const collect = () => {
  const events = [];
  return { events, ctx: { emit: (e) => events.push({ ...e, payload: { ...e.payload } }) } };
};

// ---------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------

test('kit: Young Red Dragon — Fire Breath is a DC 17 DEX 16d6 half save on recharge 5-6; no legendary actions', () => {
  const kit = buildStatBlockKit(sb('young-red-dragon'));
  const fb = kit.spells['Fire Breath'];
  assert.deepEqual(
    [fb.kind, fb.level, fb.saveStat, fb.dc, fb.dice, fb.saveOnHalf, fb.damageType, fb.aoe, fb.range, fb.notASpell],
    ['leveled-save', 0, 'DEX', 17, '16d6', true, 'fire', true, 30, true]);
  assert.equal(fb.aiWeight, RECHARGE_AI_WEIGHT);
  assert.deepEqual(kit.innate, { recharge: { 'Fire Breath': 5 }, atWill: [], perDay: {} });
  assert.equal(kit.legendary, null);
  assert.equal(kit.legendaryResistance, 0);
  assert.equal(Object.keys(kit.spells).length, 1, 'Bite / Claw are weapon attacks, not kit spells');
});

test('kit: Adult Red Dragon — three legendary actions (Detect, Tail Attack, Wing Attack) and 3 Legendary Resistances', () => {
  const kit = buildStatBlockKit(sb('adult-red-dragon'));
  assert.equal(kit.legendary.budget, 3);
  const [detect, tail, wing] = kit.legendary.actions;
  assert.deepEqual([detect.id, detect.kind, detect.cost], ['detect', 'special', 1]);
  assert.deepEqual([tail.id, tail.kind, tail.cost, tail.attackBonus, tail.dice, tail.range, tail.damageType],
    ['tail-attack', 'melee-attack', 1, 14, '2d8+8', 15, 'bludgeoning']);
  assert.deepEqual([wing.id, wing.kind, wing.cost, wing.saveStat, wing.dc, wing.dice, wing.range, wing.half, wing.condition],
    ['wing-attack', 'aoe-save', 2, 'DEX', 22, '2d6+8', 10, false, 'prone']);
  assert.equal(kit.legendaryResistance, 3);
  const fb = kit.spells['Fire Breath'];
  assert.deepEqual([fb.dc, fb.dice, fb.range], [21, '18d6', 60]);
});

test('kit: non-normalised blocks and PCs have none; the kit is memoised per block', () => {
  assert.equal(buildStatBlockKit(null), null);
  assert.equal(buildStatBlockKit({ slug: 'goblin', attacks: [] }), null);
  assert.equal(statBlockKitOf({ kind: 'pc', statBlock: sb('young-red-dragon') }), null);
  const block = sb('young-red-dragon');
  assert.equal(buildStatBlockKit(block), buildStatBlockKit(block));
  assert.equal(statBlockKitOf({ kind: 'monster', statBlock: block }), buildStatBlockKit(block));
  const w = { kind: 'monster', _statBlockKit: { spells: {} } };
  assert.equal(statBlockKitOf(w), w._statBlockKit);
});

test('kit: innate ledgers — fresh, reconciled with a stored one (preset keys dropped), and the LR ledger', () => {
  const kit = buildStatBlockKit(sb('young-red-dragon'));
  assert.deepEqual(freshKitInnate(kit), { atWill: [], recharges: { 'Fire Breath': true }, perDay: {} });
  assert.equal(freshKitInnate(null), null);
  assert.deepEqual(kitInnateState(kit, { atWill: [], recharges: { 'fire-breath': true, 'Fire Breath': false }, perDay: {} }).recharges,
    { 'Fire Breath': false });
  assert.deepEqual(kitInnateState(kit, null).recharges, { 'Fire Breath': true });
  assert.equal(kitInnateState(buildStatBlockKit(sb('goblin')), null), null);
  const adult = buildStatBlockKit(sb('adult-red-dragon'));
  assert.deepEqual(kitLegendaryResistance(adult, null), { max: 3, spent: 0 });
  assert.deepEqual(kitLegendaryResistance(adult, { max: 3, spent: 9 }), { max: 3, spent: 3 });
  assert.equal(kitLegendaryResistance(kit, null), null);
  assert.equal(LEGENDARY_RESISTANCE_KEY, 'legendary-resistance');
});

// ---------------------------------------------------------------------
// Entity-aware lookups (monster-spells / monster-legendary)
// ---------------------------------------------------------------------

test('entity lookups: a kit replaces the preset slug; without one the preset data is used', () => {
  const kit = buildStatBlockKit(sb('young-red-dragon'));
  const withKit = { kind: 'monster', presetSlug: 'young-dragon', _statBlockKit: kit };
  const preset = { kind: 'monster', presetSlug: 'young-dragon' };
  assert.deepEqual(innateBlockForEntity(withKit), kit.innate);
  assert.deepEqual(innateBlockForEntity(preset).recharge, { 'fire-breath': 5 });
  assert.deepEqual(freshInnateStateForEntity(withKit).recharges, { 'Fire Breath': true });
  assert.deepEqual(freshInnateStateForEntity(preset).recharges, { 'fire-breath': true });
  assert.equal(spellForEntity(withKit, 'Fire Breath'), kit.spells['Fire Breath']);
  assert.equal(spellForEntity(withKit, 'fire-bolt'), MONSTER_SPELLS['fire-bolt']);
  assert.equal(spellForEntity(preset, 'Fire Breath'), null);
  assert.equal(freshInnateFromBlock(null), null);
  assert.equal(legendaryBlockForEntity(withKit), null, 'the YRD block has no legendary actions');
  assert.equal(isLegendaryEntity(withKit), false);
  assert.equal(legendaryBlockForEntity(preset), LEGENDARY_ACTIONS['young-dragon']);
  assert.equal(isLegendaryEntity(preset), true);
  assert.equal(legendaryBlockForEntity(null), null);
  withKit._legendaryBudget = 3;
  resetLegendaryBudget(withKit);
  assert.equal(withKit._legendaryBudget, 0);
});

test('rollInnateRecharges rolls the kit ability: d6 >= 5 restores Fire Breath', () => {
  const w = { kind: 'monster', presetSlug: 'young-dragon', _statBlockKit: buildStatBlockKit(sb('young-red-dragon')),
    _innate: { atWill: [], recharges: { 'Fire Breath': false }, perDay: {} } };
  assert.deepEqual(rollInnateRecharges(w, () => 0.5), [], 'd6 = 4 does not recharge');
  assert.deepEqual(rollInnateRecharges(w, () => 0.7), ['Fire Breath'], 'd6 = 5 recharges');
  assert.equal(w._innate.recharges['Fire Breath'], true);
});

// ---------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------

test('entityFromPreset: a normalised block seeds its own innate / legendary / LR resources, not the preset\'s', () => {
  const young = entityFromPreset('young-dragon', { id: 'y', pos: { col: 0, row: 0 }, statBlock: sb('young-red-dragon') });
  assert.deepEqual(young.resources.innate, { atWill: [], recharges: { 'Fire Breath': true }, perDay: {} });
  assert.equal(young.resources.legendaryBudget, 0);
  assert.deepEqual(young.resources.features, {});
  const adult = entityFromPreset('young-dragon', { id: 'a', pos: { col: 0, row: 0 }, statBlock: sb('adult-red-dragon') });
  assert.equal(adult.resources.legendaryBudget, 3);
  assert.deepEqual(adult.resources.features, { [LEGENDARY_RESISTANCE_KEY]: { max: 3, spent: 0 } });
  const goblin = entityFromPreset('goblin', { id: 'g', pos: { col: 0, row: 0 }, statBlock: sb('goblin') });
  assert.equal(goblin.resources.innate, null);
  // No stat block: the preset's data, unchanged.
  const preset = entityFromPreset('young-dragon', { id: 'p', pos: { col: 0, row: 0 } });
  assert.deepEqual(preset.resources.innate.recharges, { 'fire-breath': true });
  assert.equal(preset.resources.legendaryBudget, 3);
  for (const e of [young, adult, goblin, preset]) {
    const s = emptyEncounterState({ encounterId: 'v', cols: 4, rows: 4, seed: 1 });
    s.entities[e.id] = e;
    assert.ok(validateEncounterState(s).ok, e.id);
  }
});

test('wrapperFromEntity: the kit rides the wrapper; a preset-keyed stored ledger is reconciled; nothing new persists', () => {
  const { state, m } = arena('adult-red-dragon');
  state.entities[m.id].resources.innate = { atWill: [], recharges: { 'fire-breath': true }, perDay: {} };
  const w = toEngineSides(state, { [fighter.id]: fighter }, m.id).active;
  assert.ok(w._statBlockKit);
  assert.deepEqual(w._innate.recharges, { 'Fire Breath': true });
  assert.deepEqual(w._features[LEGENDARY_RESISTANCE_KEY], { max: 3, spent: 0 });
  const back = applyEngineSides(state, [w]).entities[m.id];
  assert.ok(!('_statBlockKit' in back));
  assert.deepEqual(back.resources.innate.recharges, { 'Fire Breath': true });
  assert.ok(validateEncounterState(applyEngineSides(state, [w])).ok);
  // A preset-only monster gets no kit.
  const plain = entityFromPreset('goblin', { id: 'g', pos: { col: 0, row: 0 } });
  const s2 = emptyEncounterState({ encounterId: 'p', cols: 4, rows: 4, seed: 1 });
  s2.entities.g = plain;
  assert.ok(!('_statBlockKit' in toEngineSides(s2, {}, 'g').active));
});

// ---------------------------------------------------------------------
// Engine: the Young Red Dragon breathes fire
// ---------------------------------------------------------------------

test('engine: the AI Young Red Dragon breathes fire — DC 17 DEX, 16d6, half on a save, through the innate path', async () => {
  const { state, pc, m } = arena('young-red-dragon');
  const sides = toEngineSides(state, { [fighter.id]: fighter }, m.id);
  const { events, ctx } = collect();
  await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, createRng({ s: 5 }), {}, ctx);
  const plan = events.find(e => e.type === 'plan.chosen');
  assert.deepEqual([plan.payload.kind, plan.payload.spellId], ['cast', 'Fire Breath']);
  const cast = events.find(e => e.type === 'spell.cast');
  assert.deepEqual([cast.payload.spellId, cast.payload.innate], ['Fire Breath', true]);
  assert.ok(events.some(e => e.type === 'resource.spent' && e.payload.resource === 'innate:Fire Breath'));
  const save = events.find(e => e.type === 'save.rolled');
  assert.deepEqual([save.payload.entityId, save.payload.stat, save.payload.dc], [pc.id, 'DEX', 17]);
  const dmg = events.find(e => e.type === 'damage' && e.payload.targetId === pc.id);
  const [lo, hi] = save.payload.success ? [8, 48] : [16, 96];
  assert.ok(dmg.payload.amount >= lo && dmg.payload.amount <= hi, `breath damage ${dmg.payload.amount}`);
  assert.ok(!events.some(e => e.type === 'attack.rolled'), 'the breath is the whole action');
  for (const ev of events) assert.ok(validateEvent({ seq: 1, round: 1, turnId: null, cinemaGroup: null, ...ev }).ok, ev.type);
  const after = applyEngineSides(state, sides.wrappers);
  assert.deepEqual(after.entities[m.id].resources.innate.recharges, { 'Fire Breath': false });
});

test('engine: a spent breath recharges on a 5-6 at the top of the turn (resource.recharged) and is used again', async () => {
  const { state, m } = arena('young-red-dragon');
  state.entities[m.id].resources.innate.recharges['Fire Breath'] = false;
  const sides = toEngineSides(state, { [fighter.id]: fighter }, m.id);
  const base = createRng({ s: 9 });
  let first = true;
  const rng = () => (first ? ((first = false), 0.7) : base());       // first draw: the d6 → 5
  const { events, ctx } = collect();
  await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, rng, {}, ctx);
  assert.deepEqual(events[0].type, 'resource.recharged');
  assert.deepEqual([events[0].payload.resource, events[0].payload.spellId, events[0].payload.available], ['innate', 'Fire Breath', 1]);
  assert.equal(events.find(e => e.type === 'spell.cast')?.payload.spellId, 'Fire Breath');
});

test('engine: with the breath spent and no recharge the dragon Multiattacks instead', async () => {
  const { state, m } = arena('young-red-dragon');
  state.entities[m.id].resources.innate.recharges['Fire Breath'] = false;
  const sides = toEngineSides(state, { [fighter.id]: fighter }, m.id);
  const { events, ctx } = collect();
  await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, () => 0.1, {}, ctx);
  assert.ok(!events.some(e => e.type === 'resource.recharged'));
  assert.ok(!events.some(e => e.type === 'spell.cast'));
  assert.deepEqual(events.filter(e => e.type === 'attack.rolled').map(e => e.payload.weapon), ['Bite', 'Claw', 'Claw']);
});

test('engine: the Young Red Dragon on the young-dragon sprite has no legendary actions', async () => {
  const { state, pc, m } = arena('young-red-dragon');
  const sides = toEngineSides(state, { [fighter.id]: fighter }, m.id);
  const w = sides.active;
  beginTurnResets(w);
  assert.equal(w._legendaryBudget, 0);
  assert.equal(isLegendaryEntity(w), false);
  const { events, ctx } = collect();
  assert.equal(await runLegendaryActions(w, sides.enemies, sides.scene, createRng({ s: 1 }), {}, ctx), 0);
  assert.equal(events.length, 0);
  assert.equal(chooseLegendaryAction({ self: w, enemies: [sides.byId.get(pc.id)] }), null);
});

// ---------------------------------------------------------------------
// Engine: the Adult Red Dragon's legendary actions + Legendary Resistance
// ---------------------------------------------------------------------

test('engine: the Adult Red Dragon spends 3 legendary actions — Wing Attack (2, DEX 22, prone) then Tail Attack (1)', async () => {
  const { state, pc, m } = arena('adult-red-dragon');
  const sides = toEngineSides(state, { [fighter.id]: fighter }, m.id);
  const w = sides.active;
  beginTurnResets(w);
  assert.equal(w._legendaryBudget, 3);
  const { events, ctx } = collect();
  const spent = await runLegendaryActions(w, sides.enemies, sides.scene, () => 0.05, {}, ctx);
  assert.equal(spent, 2);
  assert.equal(w._legendaryBudget, 0);
  assert.deepEqual(events.filter(e => e.type === 'feature.used').map(e => e.payload.featureId), ['legendary:wing-attack', 'legendary:tail-attack']);
  assert.deepEqual(events.filter(e => e.type === 'resource.spent').map(e => e.payload.cost), [2, 1]);
  const save = events.find(e => e.type === 'save.rolled');
  assert.deepEqual([save.payload.entityId, save.payload.stat, save.payload.dc, save.payload.success], [pc.id, 'DEX', 22, false]);
  assert.ok(events.some(e => e.type === 'condition.applied' && e.payload.condition === 'prone' && e.payload.entityId === pc.id));
  const tail = events.find(e => e.type === 'attack.rolled');
  assert.deepEqual([tail.payload.weapon, tail.payload.bonus], ['Tail Attack', 14]);
  const after = applyEngineSides(state, sides.wrappers);
  const prone = after.entities[pc.id].conditions.find(c => (c.id || c) === 'prone');
  assert.equal(prone.endsOn, 'turn-start', 'the PC stands up at the start of its turn');
  for (const ev of events) assert.ok(validateEvent({ seq: 1, round: 1, turnId: null, cinemaGroup: null, ...ev }).ok, ev.type);
});

test('engine: a Wing Attack save takes no damage (half: false)', async () => {
  const { state, m } = arena('adult-red-dragon');
  const sides = toEngineSides(state, { [fighter.id]: fighter }, m.id);
  sides.active._legendaryBudget = 2;
  const { events, ctx } = collect();
  await runLegendaryActions(sides.active, sides.enemies, sides.scene, () => 0.99, {}, ctx);
  assert.equal(events.find(e => e.type === 'save.rolled').payload.success, true);
  assert.equal(events.find(e => e.type === 'damage')?.payload.amount ?? 0, 0);
  assert.ok(!events.some(e => e.type === 'condition.applied'));
});

test('engine: Legendary Resistance turns three failed saves into successes (resource.spent), the fourth lands', async () => {
  const state = emptyEncounterState({ encounterId: 'e-lr', cols: 12, rows: 8, seed: 3 });
  const fanatic = entityFromPreset('cult-fanatic', { id: 'm-fan', pos: { col: 2, row: 2 } });
  const adult = entityFromPreset('young-dragon', { id: 'm-adult', side: 'party', pos: { col: 6, row: 2 }, statBlock: sb('adult-red-dragon') });
  state.entities[fanatic.id] = fanatic;
  state.entities[adult.id] = adult;
  let s = state;
  const results = [];
  for (let i = 0; i < 4; i++) {
    s.entities['m-fan'].resources.slots = { 2: { max: 3, spent: 0 } };
    const sides = toEngineSides(s, {}, 'm-fan');
    const { events, ctx } = collect();
    const plan = { kind: 'cast', spellId: 'hold-person', castAtLevel: 2, targetId: 'm-adult', targetSide: 'enemy', featuresFired: [] };
    await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, () => 0, { forcePlan: plan }, ctx);
    s = applyEngineSides(s, sides.wrappers);
    results.push(events);
    // Drop the fanatic's concentration so the next cast is a fresh one.
    s.entities['m-fan'].concentration = null;
  }
  for (const events of results.slice(0, 3)) {
    const save = events.find(e => e.type === 'save.rolled');
    assert.deepEqual([save.payload.success, save.payload.legendaryResistance], [true, true]);
    assert.ok(events.some(e => e.type === 'feature.used' && e.payload.featureId === LEGENDARY_RESISTANCE_KEY));
    assert.ok(events.some(e => e.type === 'resource.spent' && e.payload.resource === `feature:${LEGENDARY_RESISTANCE_KEY}`));
    assert.ok(!events.some(e => e.type === 'condition.applied'));
  }
  const last = results[3];
  assert.equal(last.find(e => e.type === 'save.rolled').payload.success, false);
  assert.ok(!last.some(e => e.type === 'resource.spent' && e.payload.resource.startsWith('feature:')));
  assert.ok(last.some(e => e.type === 'condition.applied' && e.payload.condition === 'paralyzed'));
  assert.deepEqual(s.entities['m-adult'].resources.features[LEGENDARY_RESISTANCE_KEY], { max: 3, spent: 3 });
});

test('engine: a breath weapon is not a spell — no Counterspell window', async () => {
  const { state, m } = arena('young-red-dragon');
  const wizard = parsedDdbFixture('wizard-l5');
  const wiz = entityFromSheet(wizard, { pos: { col: 3, row: 3 } });
  state.entities[wiz.id] = wiz;
  const sides = toEngineSides(state, { [fighter.id]: fighter, [wizard.id]: wizard }, m.id);
  const { events, ctx } = collect();
  const plan = { kind: 'cast', spellId: 'Fire Breath', isInnate: true, targetId: wiz.id, targetSide: 'enemy', featuresFired: [] };
  await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, createRng({ s: 2 }), { forcePlan: plan }, ctx);
  assert.ok(events.some(e => e.type === 'spell.cast'));
  assert.ok(!events.some(e => e.type === 'reaction.offered' && e.payload.kind === 'counterspell'));
  assert.equal(events.filter(e => e.type === 'save.rolled').length, 2, 'both PCs in the cone save');
});

// ---------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------

test('intents: a DM / player plan may name the stat-block breath; a spent one is rejected', () => {
  const { state, pc, m } = arena('young-red-dragon');
  const opts = { sheets: { [fighter.id]: fighter }, checkTurn: false };
  const intent = { actorId: m.id, plan: { kind: 'cast', spellId: 'Fire Breath', targetId: pc.id } };
  assert.deepEqual(validateIntent(state, intent, opts), { ok: true });
  const plan = planFromIntent(state, intent, opts);
  assert.deepEqual([plan.spellId, plan.isInnate, plan.castAtLevel], ['Fire Breath', true, 0]);
  state.entities[m.id].resources.innate.recharges['Fire Breath'] = false;
  assert.equal(validateIntent(state, intent, opts).code, 'no-slot');
  // A preset key on a stat-block creature is unknown.
  const other = { actorId: m.id, plan: { kind: 'cast', spellId: 'fire-breath', targetId: pc.id } };
  assert.equal(validateIntent(state, other, opts).code, 'unknown-spell');
});

// ---------------------------------------------------------------------
// Turn manager: legendary actions after an opposing turn
// ---------------------------------------------------------------------

async function afterPcTurn(slug) {
  const { state, pc, m } = arena(slug);
  state.initiative = [{ entityId: pc.id, score: 20 }, { entityId: m.id, score: 1 }];
  const ts = turnStateFromEncounter(state, { [fighter.id]: fighter });
  startEncounter(ts, { initiative: 'given' });
  const events = [];
  await runTurn(ts, { rng: createRng({ s: 4 }), emit: (e) => events.push(e), prompts: { forcePlan: { kind: 'dodge', featuresFired: [] } } });
  return { events, after: encounterFromTurnState(ts), m };
}

test('turn manager: the Adult Red Dragon spends legendary actions after the PC\'s turn; the Young one does not', async () => {
  const adult = await afterPcTurn('adult-red-dragon');
  const used = adult.events.filter(e => e.type === 'feature.used').map(e => e.payload.featureId);
  assert.ok(used.length > 0 && used.every(f => f.startsWith('legendary:')), JSON.stringify(used));
  assert.ok(adult.after.entities[adult.m.id].resources.legendaryBudget < 3);
  const young = await afterPcTurn('young-red-dragon');
  assert.ok(!young.events.some(e => e.type === 'feature.used'));
  assert.equal(young.after.entities[young.m.id].resources.legendaryBudget, 0);
});

// ---------------------------------------------------------------------
// Browser bridge: a live monster record carrying the stat block
// ---------------------------------------------------------------------

test('live-bridge: a live record with the Adult block keeps its breath / Legendary Resistance spends across turns', async () => {
  const { wrapMonsterForEngine, writeBackMonster } = await import('../js/scene/live-bridge.js');
  const m = {
    id: 'live-adult', presetSlug: 'young-dragon', name: 'Adult Red Dragon',
    hp: { current: 256, max: 256 }, position: { col: 4, row: 2 }, conditions: [],
    statBlock: sb('adult-red-dragon')
  };
  const w = wrapMonsterForEngine(m);
  assert.deepEqual(w._innate.recharges, { 'Fire Breath': true }, 'a fresh record starts with the breath ready');
  assert.deepEqual(w._features[LEGENDARY_RESISTANCE_KEY], { max: 3, spent: 0 });
  w._innate.recharges['Fire Breath'] = false;
  w._features[LEGENDARY_RESISTANCE_KEY].spent = 1;
  writeBackMonster(m, w);
  const w2 = wrapMonsterForEngine(m);
  assert.equal(w2._innate.recharges['Fire Breath'], false);
  assert.equal(w2._features[LEGENDARY_RESISTANCE_KEY].spent, 1);
});
