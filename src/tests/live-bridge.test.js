import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEntityById, prepareLivePcForPlanning, planForLivePc, resolvePlanTarget,
  wrapPcForEngine, wrapMonsterForEngine, writeBackPc, writeBackMonster,
  buildEngineSides, runTurn
} from '../js/client/legacy/live-bridge.js';
const runTurn_ = runTurn;
import { seedRng } from '../js/scene/simulator.js';

/** Live-shaped PC record (hp object, no _position — that lives in scene.positions). */
function livePc({ id = 'p1', name = 'Saris', hp = 27, max = 27, classes = [{ name: 'Fighter', level: 3 }] } = {}) {
  return {
    id, name,
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, WIS: 1 },
    classes,
    equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
    hp: { current: hp, max },
    conditions: []
  };
}

/** Live-shaped monster record (hp object + position). */
function liveMonster({ id = 'g1', slug = 'goblin', hp = 7, max = 7, pos = { col: 3, row: 2 } } = {}) {
  return { id, name: 'Goblin', presetSlug: slug, hp: { current: hp, max }, conditions: [], position: pos };
}

function scene(extra = {}) {
  return { cols: 8, rows: 5, positions: { p1: { col: 2, row: 2 } }, monsters: [], ...extra };
}

// ---------- lookup ----------

test('live-bridge: resolveEntityById finds PCs and monsters by stringified id', () => {
  const pc = livePc({ id: 7 });
  const m = liveMonster();
  const ctx = { party: [pc], scene: scene({ monsters: [m] }) };
  assert.equal(resolveEntityById('7', 'pc', ctx), pc);
  assert.equal(resolveEntityById('g1', 'monster', ctx), m);
  assert.equal(resolveEntityById('nope', 'monster', ctx), undefined);
});

test('live-bridge: resolvePlanTarget maps targetSide to the right roster', () => {
  const pc = livePc();
  const m = liveMonster();
  const ctx = { party: [pc], scene: scene({ monsters: [m] }) };
  assert.deepEqual(resolvePlanTarget({ targetId: 'p1', targetSide: 'ally' }, ctx), { kind: 'pc', entity: pc });
  assert.deepEqual(resolvePlanTarget({ targetId: 'g1', targetSide: 'enemy' }, ctx), { kind: 'monster', entity: m });
  assert.equal(resolvePlanTarget({ targetSide: 'enemy' }, ctx), null);
  assert.equal(resolvePlanTarget({ targetId: 'zz', targetSide: 'ally' }, ctx), null);
});

// ---------- planning ----------

test('live-bridge: prepareLivePcForPlanning sets _position from scene and lazy-inits _slots', () => {
  const pc = livePc();
  const sc = scene();
  prepareLivePcForPlanning(pc, 0, sc);
  assert.deepEqual(pc._position, { col: 2, row: 2 });
  assert.ok(pc._slots && typeof pc._slots === 'object');
  const slots = pc._slots;
  prepareLivePcForPlanning(pc, 0, sc);
  assert.equal(pc._slots, slots, 'existing slot pool is kept, not rebuilt');
});

test('live-bridge: planForLivePc targets a living monster and ignores dead ones', () => {
  const pc = livePc();
  const dead = liveMonster({ id: 'dead', hp: 0, pos: { col: 3, row: 2 } });
  const alive = liveMonster({ id: 'alive', pos: { col: 3, row: 3 } });
  const sc = scene({ monsters: [dead, alive] });
  prepareLivePcForPlanning(pc, 0, sc);
  const plan = planForLivePc(pc, { party: [pc], scene: sc, rng: seedRng(3) });
  assert.ok(plan, 'a plan is produced');
  if (plan.targetId != null) assert.equal(plan.targetId, 'alive');
  assert.equal(planForLivePc(null, { party: [pc], scene: sc, rng: seedRng(3) }), null);
});

test('live-bridge: planForLivePc requires an injected rng', () => {
  const pc = livePc();
  const sc = scene({ monsters: [liveMonster()] });
  prepareLivePcForPlanning(pc, 0, sc);
  assert.throws(() => planForLivePc(pc, { party: [pc], scene: sc }), TypeError);
});

// ---------- wrap: fresh copies (M64 T5) ----------

test('live-bridge: wrapPcForEngine returns a copy; writeBackPc carries conditions and slots back', () => {
  const pc = livePc({ classes: [{ name: 'Wizard', level: 5 }] });
  const sc = scene();
  const w = wrapPcForEngine(pc, 0, sc);
  assert.notEqual(w.conditions, pc.conditions, 'no shared references any more');
  assert.notEqual(w._slots, pc._slots);
  w.conditions.push('prone');
  w._slots[1] = 0;
  assert.deepEqual(pc.conditions, [], 'live record untouched until write-back');
  writeBackPc(pc, w, sc);
  assert.deepEqual(pc.conditions, ['prone']);
  assert.equal(pc._slots[1], 0);
  assert.equal(w.hp, 27);
  assert.equal(w.ref, pc);
  assert.deepEqual(w._position, { col: 2, row: 2 });
});

test('live-bridge: wrapPcForEngine creates a conditions array on records without one', () => {
  const pc = livePc();
  delete pc.conditions;
  const w = wrapPcForEngine(pc, 0, scene());
  assert.ok(Array.isArray(pc.conditions));
  assert.deepEqual(w.conditions, pc.conditions);
});

test('live-bridge: wrapMonsterForEngine reads preset AC/attack and copies conditions + slots', () => {
  const m = liveMonster();
  m._slots = { 1: 2 };
  m.conditions = ['prone'];
  const w = wrapMonsterForEngine(m);
  assert.equal(w.ac, 15);
  assert.equal(w.attack.name, 'Scimitar');
  assert.deepEqual(w.conditions, ['prone']);
  assert.deepEqual(w._slots, { 1: 2 });
  assert.deepEqual(w.position, m.position);
  assert.equal(w.ref, m);
  assert.equal(wrapMonsterForEngine(null), null);
});

test('live-bridge: liveEncounterState is a valid EncounterState v1', async () => {
  const { validateEncounterState } = await import('../js/shared/encounter-state.js');
  const { liveEncounterState } = await import('../js/client/legacy/live-bridge.js');
  const pc = livePc({ id: 7, classes: [{ name: 'Wizard', level: 5 }] });
  pc._slots = { 1: 1, 2: 3, 3: 2, 4: 0, 5: 0 };
  const m = liveMonster();
  m._aiProfile = { archetype: 'custom', considerations: {} };
  const { state, sheets } = liveEncounterState({ party: [pc], scene: scene({ monsters: [m], positions: { 7: { col: 1, row: 1 } } }) });
  const v = validateEncounterState(state);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(state.entities['7'].resources.slots['1'], { max: 4, spent: 3 });
  assert.equal(state.entities.g1.statBlock.profile.archetype, 'custom');
  assert.equal(sheets['7'], pc);
});

test('live-bridge: a live Shield spends the PC\'s slot and the spend survives to the next turn', async () => {
  const pc = livePc({ classes: [{ name: 'Wizard', level: 5 }] });
  pc.spells = ['Shield'];
  pc._slots = { 1: 2, 2: 0, 3: 0, 4: 0, 5: 0 };
  const m = liveMonster({ hp: 40, max: 40, pos: { col: 3, row: 2 } });
  const sc = scene({ monsters: [m] });
  const party = [pc];
  const forcePlan = { kind: 'attack', targetId: 'p1', targetSide: 'enemy', featuresFired: [] };
  // Every d20 = 11 → 15 vs the wizard's AC 11: a hit +5 AC turns into a miss.
  await runTurn({ party, scene: sc, entity: m, kind: 'monster', rng: () => 0.5, prompts: { forcePlan } });
  assert.equal(pc._slots[1], 1);
  assert.equal(pc._reactionUsed, true);
  pc._reactionUsed = false;
  await runTurn({ party, scene: sc, entity: m, kind: 'monster', rng: () => 0.5, prompts: { forcePlan } });
  assert.equal(pc._slots[1], 0, 'second Shield spent the last 1st-level slot');
});

// ---------- write-back ----------

test('live-bridge: writeBackPc clamps HP into [0, max] and writes position into scene.positions', () => {
  const pc = livePc();
  const sc = scene();
  const before = sc.positions;
  writeBackPc(pc, { hp: 999, _position: { col: 4, row: 1 } }, sc);
  assert.equal(pc.hp.current, 27);
  assert.deepEqual(sc.positions.p1, { col: 4, row: 1 });
  assert.notEqual(sc.positions, before, 'positions map is replaced, not mutated');
  writeBackPc(pc, { hp: -5 }, sc);
  assert.equal(pc.hp.current, 0);
  writeBackPc(pc, { hp: 12.9, _reactionUsed: true, _lastPlan: { kind: 'melee' } }, sc);
  assert.equal(pc.hp.current, 12);
  assert.equal(pc._reactionUsed, true);
  assert.deepEqual(pc._lastPlan, { kind: 'melee' });
});

test('live-bridge: writeBackMonster clamps HP and copies position + flags', () => {
  const m = liveMonster();
  writeBackMonster(m, { hp: -3, position: { col: 5, row: 4 }, _reactionUsed: true, _legendaryBudget: 2 });
  assert.equal(m.hp.current, 0);
  assert.deepEqual(m.position, { col: 5, row: 4 });
  assert.equal(m._reactionUsed, true);
  assert.equal(m._legendaryBudget, 2);
  writeBackMonster(m, { hp: 50 });
  assert.equal(m.hp.current, 7);
});

// ---------- sides ----------

test('live-bridge: buildEngineSides drops the dead but keeps a dead active entity', () => {
  const pc = livePc({ hp: 0 });
  const ally = livePc({ id: 'p2', name: 'Ally' });
  const deadAlly = livePc({ id: 'p3', name: 'Down', hp: 0 });
  const m = liveMonster();
  const sc = scene({ monsters: [m, liveMonster({ id: 'g2', hp: 0 })] });
  const sides = buildEngineSides({ party: [pc, ally, deadAlly], scene: sc, active: pc, kind: 'pc' });
  assert.ok(sides.active, 'dead-but-active PC is included');
  assert.equal(sides.active.id, 'p1');
  assert.deepEqual(sides.allies.map(w => w.id), ['p1', 'p2']);
  assert.deepEqual(sides.enemies.map(w => w.id), ['g1']);
  const monSides = buildEngineSides({ party: [pc, ally], scene: sc, active: m, kind: 'monster' });
  assert.equal(monSides.active.id, 'g1');
  assert.deepEqual(monSides.enemies.map(w => w.id), ['p2']);
});

// ---------- full turn, no DOM ----------

test('live-bridge: runTurn executes one full PC turn under node with no DOM', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const pc = livePc();
  const m = liveMonster({ hp: 40, max: 40, pos: { col: 3, row: 2 } });
  const sc = scene({ monsters: [m] });
  const party = [pc];
  const w = await runTurn({ party, scene: sc, entity: pc, kind: 'pc', rng: seedRng(42), prompts: {} });
  assert.ok(w, 'active wrapper returned');
  assert.equal(w.ref, pc);
  assert.ok(pc._lastPlan, 'plan written back to the live PC');
  assert.ok(m.hp.current <= 40 && m.hp.current >= 0);
  assert.ok(sc.positions.p1, 'PC position written back into scene.positions');
});

test('live-bridge: runTurn is deterministic for a fixed seed', async () => {
  async function once() {
    const pc = livePc();
    const m = liveMonster({ hp: 40, max: 40 });
    const sc = scene({ monsters: [m] });
    await runTurn({ party: [pc], scene: sc, entity: pc, kind: 'pc', rng: seedRng(7), prompts: {} });
    await runTurn({ party: [pc], scene: sc, entity: m, kind: 'monster', rng: seedRng(8), prompts: {} });
    return { pcHp: pc.hp.current, mHp: m.hp.current, pos: sc.positions.p1 };
  }
  assert.deepEqual(await once(), await once());
});

test('live-bridge: runTurn requires an rng and returns null for an entity not in the scene', async () => {
  const pc = livePc();
  const sc = scene({ monsters: [liveMonster()] });
  await assert.rejects(runTurn({ party: [pc], scene: sc, entity: pc, kind: 'pc' }), TypeError);
  const stranger = livePc({ id: 'x' });
  const res = await runTurn({ party: [pc], scene: sc, entity: stranger, kind: 'pc', rng: seedRng(1) });
  assert.equal(res, null);
});

test('live-bridge: the browser loop on the turn manager fires legendary actions in live play (T7)', async () => {
  const { liveTurnState, syncLiveFromTurnState, refreshTurnStateFromLive } = await import('../js/client/legacy/live-bridge.js');
  const { startEncounter, runTurn } = await import('../js/scene/turn-manager.js');
  const pc = livePc({ hp: 60, max: 60 });
  const dragon = { id: 'd1', name: 'Dragon', presetSlug: 'young-dragon', hp: { current: 120, max: 120 }, conditions: [], position: { col: 3, row: 2 }, _legendaryBudget: 3 };
  const sc = scene({ monsters: [dragon] });
  const party = [pc];
  const ts = liveTurnState({ party, scene: sc, initiative: [{ entityId: 'p1', score: 20 }, { entityId: 'd1', score: 5 }] });
  startEncounter(ts, { initiative: 'given', maxRounds: 3 });
  const rng = seedRng(21);
  let ran = 0;
  const res = await runTurn(ts, {
    rng,
    runActorTurn: async (actor) => {
      syncLiveFromTurnState(ts, { scene: sc });
      await runTurn_({ party, scene: sc, entity: pc, kind: actor.kind, rng });
      refreshTurnStateFromLive(ts, { party, scene: sc });
      ran++;
    }
  });
  syncLiveFromTurnState(ts, { scene: sc });
  assert.equal(ran, 1);
  assert.equal(res.actorId, 'p1');
  assert.ok(dragon._legendaryBudget < 3, 'the dragon spent legendary actions after the PC turn');
  assert.equal(ts.turnIndex, 1);
});
