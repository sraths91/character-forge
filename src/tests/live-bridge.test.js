import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEntityById, prepareLivePcForPlanning, planForLivePc, resolvePlanTarget,
  wrapPcForEngine, wrapMonsterForEngine, writeBackPc, writeBackMonster,
  buildEngineSides, runTurn
} from '../js/scene/live-bridge.js';
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

// ---------- wrap: shared refs ----------

test('live-bridge: wrapPcForEngine shares conditions and _slots by reference', () => {
  const pc = livePc({ classes: [{ name: 'Wizard', level: 5 }] });
  const w = wrapPcForEngine(pc, 0, scene());
  assert.equal(w.conditions, pc.conditions);
  assert.equal(w._slots, pc._slots);
  w.conditions.push('prone');
  w._slots[1] = 0;
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
  assert.equal(w.conditions, pc.conditions);
});

test('live-bridge: wrapMonsterForEngine reads preset AC/attack and shares conditions', () => {
  const m = liveMonster();
  m._slots = { 1: 2 };
  const w = wrapMonsterForEngine(m);
  assert.equal(w.ac, 15);
  assert.equal(w.attack.name, 'Scimitar');
  assert.equal(w.conditions, m.conditions);
  assert.equal(w._slots, m._slots);
  assert.equal(w.position, m.position);
  assert.equal(wrapMonsterForEngine(null), null);
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
