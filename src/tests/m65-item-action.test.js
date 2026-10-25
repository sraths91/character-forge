/**
 * M65 T23 — the item action: plan kind `item` (drink / administer a
 * potion), validated against `resources.items`, resolved through
 * applyHealing, reported as `item.used`; an AI consideration drinks below
 * the heal threshold when no heal spell answers — since M65 phase 2 only
 * when drinking outlasts the action it costs (pc-action considerPotion).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEM_EFFECTS, itemEffectOf, itemUsesLeft } from '../js/scene/item-effects.js';
import { entityFromSheet, entityFromPreset, wrapperFromEntity } from '../js/scene/encounter-adapters.js';
import { validateIntent, planFromIntent } from '../js/scene/intent-validation.js';
import { turnStateFromEncounter, runTurn, encounterFromTurnState } from '../js/scene/turn-manager.js';
import { runOneAttack, useItem } from '../js/scene/combat-engine.js';
import { choosePcAction, incomingDownRisk, POTION_HEAL_THRESHOLD, POTION_DOWN_RISK } from '../js/scene/ai/pc-action.js';
import { PC_PROFILES } from '../js/scene/ai/pc-profiles.js';
import { emptyEncounterState, validateEncounterState } from '../js/shared/encounter-state.js';
import { validateEvent } from '../js/shared/events.js';
import { validateClientMessage, INTENT_PLAN_KINDS } from '../js/shared/protocol.js';
import { createRng } from '../js/scene/rng.js';
import { parsedDdbFixture, buildScene } from './helpers/entities.js';
import { POTIONS as CAMPAIGN_POTIONS, drinkPotion } from '../js/campaign/consumables.js';
import { readFileSync } from 'node:fs';

const fighter = parsedDdbFixture('fighter-l5');
const cleric = parsedDdbFixture('cleric-l5');
const POTIONS = { 'ri-1': { name: 'Potion of Healing', effect: 'potion-of-healing', max: 2, spent: 0 } };

test('T23: protocol — turn.act accepts {kind: item, itemId, targetId?}', () => {
  assert.ok(INTENT_PLAN_KINDS.includes('item'));
  const msg = { v: 1, t: 'turn.act', cid: 'c1', p: { turnId: 't1', plan: { kind: 'item', itemId: 'ri-1', targetId: 'pc-2' } } };
  assert.deepEqual(validateClientMessage(msg).errors, []);
  msg.p.plan.itemId = 7;
  assert.equal(validateClientMessage(msg).ok, false);
});

test('T23: SRD potion registry and effect resolution', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(ITEM_EFFECTS).map(([k, v]) => [k, v.dice])), {
    'potion-of-healing': '2d4+2', 'potion-of-greater-healing': '4d4+4',
    'potion-of-superior-healing': '8d4+8', 'potion-of-supreme-healing': '10d4+20'
  });
  assert.deepEqual(itemEffectOf({ name: 'x', effect: 'potion-of-greater-healing' }), { kind: 'heal', dice: '4d4+4' });
  assert.deepEqual(itemEffectOf({ name: 'Potion of Healing' }), { kind: 'heal', dice: '2d4+2' }, 'name fallback');
  assert.deepEqual(itemEffectOf({ name: 'Elixir', effect: { kind: 'heal', dice: '3d4 + 3' } }), { kind: 'heal', dice: '3d4+3' });
  assert.equal(itemEffectOf({ name: 'Rope', effect: null }), null);
  assert.equal(itemEffectOf({ name: 'x', effect: { kind: 'fly', dice: '1d4' } }), null);
  assert.equal(itemEffectOf({ name: 'x', effect: { kind: 'heal', dice: 'lots' } }), null);
  assert.deepEqual([itemUsesLeft({ max: 2, spent: 0 }), itemUsesLeft({ max: 1, spent: 3 })], [2, 0]);
});

/** Fighter (with potions) next to a dying cleric, a goblin across the room. */
function table({ items = POTIONS, clericPos = { col: 2, row: 1 }, clericState = 'downed' } = {}) {
  const state = emptyEncounterState({ encounterId: 'e-item', cols: 10, rows: 6, seed: 4 });
  const f = entityFromSheet(fighter, { id: 'f', pos: { col: 1, row: 1 }, controller: { type: 'player', seatId: 's1' }, items });
  const runState = clericState === 'downed'
    ? { hp: { current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 1, stable: false } }
    : clericState === 'dead' ? { hp: { current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 3, stable: false } }
      : { hp: { current: 20, temp: 0 } };
  const c = entityFromSheet(cleric, { id: 'c', pos: clericPos, runState });
  const gob = entityFromPreset('goblin', { id: 'gob', pos: { col: 8, row: 4 } });
  state.entities = { f, c, gob };
  state.initiative = [{ entityId: 'f', score: 18 }, { entityId: 'c', score: 12 }, { entityId: 'gob', score: 5 }];
  state.phase = 'running';
  state.round = 1;
  const sheets = { [f.sheetRef.characterId]: fighter, [c.sheetRef.characterId]: cleric };
  assert.deepEqual(validateEncounterState(state).errors, []);
  return { state, sheets };
}

const act = (plan) => ({ actorId: 'f', plan: { kind: 'item', itemId: 'ri-1', ...plan } });

test('T23: validateIntent — quantity, item, effect, target side, adjacency and the action economy', () => {
  const { state, sheets } = table();
  const v = (plan, s = state) => validateIntent(s, act(plan), { sheets });
  assert.deepEqual(v({}), { ok: true }, 'drink it yourself');
  assert.deepEqual(v({ targetId: 'c' }), { ok: true }, 'feed the dying ally next to you');
  assert.deepEqual(v({ targetId: 'f' }), { ok: true });

  const empty = table({ items: { 'ri-1': { ...POTIONS['ri-1'], spent: 2 } } });
  const zero = validateIntent(empty.state, act({}), { sheets: empty.sheets });
  assert.deepEqual([zero.ok, zero.code], [false, 'no-item']);
  assert.match(zero.reason, /quantity 0/);

  assert.equal(v({ itemId: 'ri-9' }).code, 'no-item');
  assert.equal(v({ itemId: undefined }).code, 'no-item');
  const rope = table({ items: { 'ri-1': { name: 'Rope', effect: null, max: 1, spent: 0 } } });
  assert.equal(validateIntent(rope.state, act({}), { sheets: rope.sheets }).code, 'bad-item');
  assert.equal(v({ targetId: 'gob' }).code, 'wrong-side');
  assert.equal(v({ targetId: 'nobody' }).code, 'no-target');
  const far = table({ clericPos: { col: 4, row: 1 } });
  assert.equal(validateIntent(far.state, act({ targetId: 'c' }), { sheets: far.sheets }).code, 'out-of-range');
  assert.deepEqual(validateIntent(far.state, act({ targetId: 'c', moveTo: { col: 3, row: 1 } }), { sheets: far.sheets }), { ok: true }, 'move, then administer');
  const dead = table({ clericState: 'dead' });
  assert.equal(validateIntent(dead.state, act({ targetId: 'c' }), { sheets: dead.sheets }).code, 'target-down');
  assert.equal(v({ features: ['action-surge'] }).code, 'bad-plan', 'the item is the action');
  assert.equal(v({ weaponName: 'Longsword' }).code, 'bad-plan');
  const cleric0 = validateIntent(state, { actorId: 'c', plan: { kind: 'item', itemId: 'ri-1' } }, { sheets, checkTurn: false });
  assert.equal(cleric0.code, 'actor-down', 'a dying creature cannot drink');
});

test('T23: a dying ally fed a potion stands up (item.used → heal → entity.revived)', async () => {
  const { state, sheets } = table();
  const intent = act({ targetId: 'c' });
  assert.deepEqual(validateIntent(state, intent, { sheets }), { ok: true });
  const ts = turnStateFromEncounter(state, sheets);
  const events = [];
  let seq = 0;
  await runTurn(ts, {
    rng: createRng({ s: 11 }),
    prompts: { forcePlan: planFromIntent(state, intent, { sheets }) },
    emit: (ev) => events.push({ seq: ++seq, cinemaGroup: null, ...ev })
  });
  for (const ev of events) assert.deepEqual(validateEvent(ev).errors, [], ev.type);
  const types = events.map(e => e.type);
  assert.deepEqual(types.slice(0, 7), ['turn.started', 'plan.chosen', 'item.used', 'heal', 'condition.removed', 'entity.revived', 'turn.ended']);
  const used = events.find(e => e.type === 'item.used').payload;
  assert.deepEqual([used.entityId, used.targetId, used.itemId, used.name, used.effect, used.remaining], ['f', 'c', 'ri-1', 'Potion of Healing', 'heal', 1]);
  assert.ok(used.rolled >= 4 && used.rolled <= 10, `2d4+2 rolled ${used.rolled}`);
  assert.equal(events.find(e => e.type === 'plan.chosen').payload.itemId, 'ri-1');
  const after = encounterFromTurnState(ts);
  assert.deepEqual(validateEncounterState(after).errors, []);
  assert.equal(after.entities.c.hp, used.rolled);
  assert.equal(after.entities.c.status, undefined, 'active again');
  assert.deepEqual(after.entities.c.conditions, []);
  assert.deepEqual(after.entities.f.resources.items['ri-1'], { ...POTIONS['ri-1'], spent: 1 });
  assert.deepEqual(after.entities.f.pos, { col: 1, row: 1 }, 'no move without moveTo');
});

test('T23: the engine re-checks — a used-up potion is rejected and nothing changes', async () => {
  const { state } = table({ items: { 'ri-1': { ...POTIONS['ri-1'], spent: 2 } } });
  const f = wrapperFromEntity(state.entities.f, fighter);
  const c = wrapperFromEntity(state.entities.c, cleric);
  const events = [];
  await runOneAttack(f, [], [f, c], buildScene({ cols: 10, rows: 6 }), createRng({ s: 1 }), {
    forcePlan: { kind: 'item', itemId: 'ri-1', targetId: 'c', targetSide: 'ally', featuresFired: [] }
  }, { emit: (ev) => events.push(ev) });
  assert.deepEqual(events.map(e => e.type), ['plan.chosen', 'turn.rejected']);
  assert.equal(events[1].payload.code, 'no-item');
  assert.deepEqual([c.hp, f._items['ri-1'].spent], [0, 2]);
  const r = useItem(f, c, 'ri-1', { rng: createRng({ s: 1 }) });
  assert.equal(r.ok, false);
});

test('T23: a potion moves first when the plan says so, then heals within 5 ft', async () => {
  const { state, sheets } = table({ clericPos: { col: 4, row: 1 } });
  const intent = act({ targetId: 'c', moveTo: { col: 3, row: 1 } });
  assert.deepEqual(validateIntent(state, intent, { sheets }), { ok: true });
  const ts = turnStateFromEncounter(state, sheets);
  const events = [];
  await runTurn(ts, { rng: createRng({ s: 2 }), prompts: { forcePlan: planFromIntent(state, intent, { sheets }) }, emit: (ev) => events.push(ev) });
  assert.deepEqual(events.map(e => e.type).slice(0, 4), ['turn.started', 'plan.chosen', 'move', 'item.used']);
  assert.ok(ts.entities.c.hp > 0);
});

// ---------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------

function aiFighter(hp, items = POTIONS) {
  const e = entityFromSheet(fighter, { id: 'f', pos: { col: 1, row: 1 }, items, runState: { hp: { current: hp, temp: 0 } } });
  return wrapperFromEntity(e, fighter);
}
const goblin = () => wrapperFromEntity(entityFromPreset('goblin', { id: 'gob', pos: { col: 2, row: 1 } }));

/** An orc wrapper (optionally with more HP) at `pos`. */
function orc(pos = { col: 2, row: 1 }, hp = null, id = 'orc') {
  const w = wrapperFromEntity(entityFromPreset('orc', { id, pos }));
  if (hp != null) Object.assign(w, { hp, hpMax: Math.max(hp, w.hpMax) });
  return w;
}
/** A fighter wrapper with Second Wind already spent (so the potion is its only heal). */
function spentFighter(hp, items = POTIONS) {
  const w = aiFighter(hp, items);
  w._secondWindUsed = true;
  return w;
}
const rng1 = () => createRng({ s: 1 });
const reasonOf = (plan) => plan.breakdown.find(b => /^(critical_down_risk|drinking_outlasts|no_hostile_reachable|ally_dying)$/.test(b.name))?.name;

test('M65 phase 2: AI — a near-death fighter that would otherwise go down drinks', () => {
  assert.equal(POTION_HEAL_THRESHOLD, 0.5);
  const low = choosePcAction({ self: spentFighter(3), enemies: [orc(undefined, 30)], allies: [], rng: rng1() });
  assert.deepEqual([low.kind, low.itemId, low.targetId, low.targetSide], ['item', 'ri-1', 'f', 'ally']);
  assert.equal(reasonOf(low), 'critical_down_risk');
  const sig = Object.fromEntries(low.breakdown.filter(b => b.name.startsWith('potion:')).map(b => [b.name, b.raw]));
  assert.ok(sig['potion:p_down'] >= POTION_DOWN_RISK, 'at risk of being downed before its next turn');
  assert.ok(sig['potion:survive_drink'] > sig['potion:survive_attack'], 'drinking outlasts swinging');
  // Used up → swings.
  const none = choosePcAction({ self: spentFighter(3, { 'ri-1': { ...POTIONS['ri-1'], spent: 2 } }), enemies: [orc(undefined, 30)], allies: [], rng: rng1() });
  assert.notEqual(none.kind, 'item', 'used up');
});

test('M65 phase 2: AI — below half HP is no longer a reflex: healthy enough, Second Wind up, or a weak foe → swing', () => {
  // Below the 50% gate but the goblin barely threatens a 10 HP AC 18 fighter (and dies to one turn).
  assert.notEqual(choosePcAction({ self: aiFighter(10), enemies: [goblin()], allies: [], rng: rng1() }).kind, 'item');
  // Above the gate: never.
  assert.notEqual(choosePcAction({ self: aiFighter(40), enemies: [orc(undefined, 30)], allies: [], rng: rng1() }).kind, 'item');
  // Second Wind rides the swing and heals more than the potion: swing + Second Wind.
  const sw = choosePcAction({ self: aiFighter(3), enemies: [orc(undefined, 30)], allies: [], rng: rng1() });
  assert.equal(sw.kind, 'melee');
  assert.ok(sw.featuresFired.includes('second-wind'));
});

test('M65 phase 2: AI — never drinks when the fight is nearly won (last hostile at low HP)', () => {
  const plan = choosePcAction({ self: spentFighter(3), enemies: [orc(undefined, 2)], allies: [], rng: rng1() });
  assert.equal(plan.kind, 'melee');
  assert.equal(plan.targetId, 'orc');
  // Two hostiles left: the low one is not "the last", the risk rule decides again.
  const two = choosePcAction({ self: spentFighter(3), enemies: [orc(undefined, 2), orc({ col: 1, row: 2 }, 30, 'orc2')], allies: [], rng: rng1() });
  assert.ok(two.kind === 'item' || two.kind === 'melee');
});

test('M65 phase 2: AI — drinks when no hostile is reachable this turn', () => {
  const plan = choosePcAction({ self: spentFighter(8), enemies: [orc({ col: 9, row: 5 })], allies: [], rng: rng1() });
  assert.deepEqual([plan.kind, reasonOf(plan)], ['item', 'no_hostile_reachable']);
});

test('M65 phase 2: AI — actionWeights.potion 0 never self-drinks; dying allies are still fed', () => {
  const self = spentFighter(3);
  self._aiProfile = { ...PC_PROFILES.fighter, actionWeights: { ...PC_PROFILES.fighter.actionWeights, potion: 0 } };
  assert.notEqual(choosePcAction({ self, enemies: [orc(undefined, 30)], allies: [], rng: rng1() }).kind, 'item');
  assert.notEqual(choosePcAction({ self, enemies: [orc({ col: 9, row: 5 })], allies: [], rng: rng1() }).kind, 'item');
  const { state } = table();
  const c = wrapperFromEntity(state.entities.c, cleric);
  const fed = choosePcAction({ self, enemies: [goblin()], allies: [self], downedAllies: [c], rng: rng1() });
  assert.deepEqual([fed.kind, fed.targetId], ['item', 'c']);
});

test('M65 phase 2: incomingDownRisk — exact P(the hostiles in reach deal ≥ HP before the next turn)', () => {
  const f = aiFighter(10);                                   // AC 18
  const o = orc();                                           // +5, 1d12+3: hits on 13+ → 0.4
  assert.ok(Math.abs(incomingDownRisk(f, [o], 1) - 0.4) < 1e-9);
  assert.equal(incomingDownRisk(f, [o], 0), 1);
  assert.equal(incomingDownRisk(f, [o], 100), 0);
  // 1d12+3 ≥ 10 on 7..12 (6/12) on a plain hit (0.35), crit 2d12+3 ≥ 10 on 129/144 (0.05).
  assert.ok(Math.abs(incomingDownRisk(f, [o], 10) - (0.35 * 0.5 + 0.05 * 129 / 144)) < 1e-9);
  assert.equal(incomingDownRisk(f, [orc({ col: 9, row: 5 })], 1), 0, 'out of reach this round');
  assert.equal(incomingDownRisk(f, [orc(undefined, 0)], 1), 0, 'a downed foe does not attack');
  const two = incomingDownRisk(f, [o, orc({ col: 1, row: 2 }, null, 'o2')], 10);
  assert.ok(two > incomingDownRisk(f, [o], 10), 'two attackers are riskier than one');
});

test('T23: AI — a cleric with a heal spell castable never reaches for the potion', () => {
  const e = entityFromSheet(cleric, { id: 'c', pos: { col: 1, row: 1 }, items: POTIONS, runState: { hp: { current: 5, temp: 0 } } });
  const plan = choosePcAction({ self: wrapperFromEntity(e, cleric), enemies: [goblin()], allies: [], rng: createRng({ s: 1 }) });
  assert.notEqual(plan.kind, 'item');
  // No slots left and no cantrip heal: now it drinks.
  const spent = entityFromSheet(cleric, {
    id: 'c', pos: { col: 1, row: 1 }, items: POTIONS,
    runState: { hp: { current: 5, temp: 0 }, slots: { spell: { 1: { spent: 4 }, 2: { spent: 3 }, 3: { spent: 2 } } } }
  });
  const dry = choosePcAction({ self: wrapperFromEntity(spent, cleric), enemies: [goblin()], allies: [], rng: createRng({ s: 1 }) });
  assert.deepEqual([dry.kind, dry.targetId], ['item', 'c']);
});

test('T23: AI — an adjacent dying ally gets the potion first', () => {
  const { state } = table();
  const f = aiFighter(10);
  const c = wrapperFromEntity(state.entities.c, cleric);
  const plan = choosePcAction({ self: f, enemies: [goblin()], allies: [f], downedAllies: [c], rng: createRng({ s: 1 }) });
  assert.deepEqual([plan.kind, plan.targetId], ['item', 'c']);
});

test('T23: AI end to end — a delegated turn drinks the potion through the engine', async () => {
  const { state, sheets } = table({ clericState: 'up' });
  // M65 phase 2 — drinking is now worth it only out of reach (or near death):
  // the goblin stands 50 ft away, beyond the fighter's move + reach.
  state.entities.gob.pos = { col: 9, row: 5 };
  state.entities.f = entityFromSheet(fighter, { id: 'f', pos: { col: 1, row: 1 }, items: POTIONS, runState: { hp: { current: 9, temp: 0 } } });
  const ts = turnStateFromEncounter(state, sheets);
  const events = [];
  await runTurn(ts, { rng: createRng({ s: 5 }), emit: (ev) => events.push(ev) });
  const used = events.find(e => e.type === 'item.used');
  assert.ok(used, events.map(e => e.type).join(','));
  assert.equal(ts.entities.f.hp, 9 + used.payload.rolled);
  assert.equal(events.find(e => e.type === 'plan.chosen').payload.source, 'ai');
});

test('one potion registry: ITEM_EFFECTS is derived from campaign POTIONS; drinkPotion rolls are unchanged', () => {
  assert.deepEqual(Object.keys(ITEM_EFFECTS), Object.keys(CAMPAIGN_POTIONS));
  for (const p of Object.values(CAMPAIGN_POTIONS)) {
    assert.deepEqual(ITEM_EFFECTS[p.id], { kind: 'heal', dice: p.dice });
    assert.ok(Object.isFrozen(ITEM_EFFECTS[p.id]));
  }
  const src = readFileSync(new URL('../js/campaign/consumables.js', import.meta.url), 'utf8');
  assert.ok(!/item-effects/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'consumables.js owns the dice (no import of scene/item-effects.js)');
  // Seeded rolls pinned from before the move (main c162fec).
  const rolls = Object.values(CAMPAIGN_POTIONS).map(p => {
    const r = drinkPotion({ hp: { max: 100 } }, { hp: { current: 1, temp: 0 } }, p.id, createRng({ s: 7 }));
    return [p.id, r.rolled, r.rolls.join(',')];
  });
  assert.deepEqual(rolls, [
    ['potion-of-healing', 4, '1,1'],
    ['potion-of-greater-healing', 13, '1,1,4,3'],
    ['potion-of-superior-healing', 25, '1,1,4,3,3,2,2,1'],
    ['potion-of-supreme-healing', 43, '1,1,4,3,3,2,2,1,3,3']
  ]);
});
