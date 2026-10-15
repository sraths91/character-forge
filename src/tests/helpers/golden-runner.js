/**
 * M64 H2 — golden scenario runner for the CURRENT combat engine.
 *
 * A scenario is a pair of fixtures in src/tests/fixtures/encounters/:
 *   <name>.state.json    — an EncounterState v1 (validated on load). PC
 *                          sheetRef.characterId names a synthetic DDB
 *                          fixture; monster statBlock.slug a preset.
 *   <name>.intents.json  — an ordered script of steps (below).
 * and an expected log in src/tests/golden/<name>.events.json.
 *
 * Steps:
 *   { t: 'round.start' }                              reactions refresh, round++
 *   { t: 'turn.delegate', actorId }                   AI plans the turn (choosePcAction / chooseAction)
 *   { t: 'turn.act', actorId, plan }                  forcePlan; plan uses the protocol.js turn.act
 *                                                     shape (+ harness-only `innate: true`)
 *   { t: 'dm.entity.patch', p: { entityId, hp?, addConditions?, removeConditions? } }
 *   { t: 'legendary', entityId }                      blocked on E1 T7 (throws)
 *   { t: 'dm.roll.arm', p }                           blocked on E1 T8 (throws)
 *
 * Since M64 T4 the engine emits its own catalogue-v1 events through
 * `ctx.emit`; the runner stamps seq/round/turnId and checks every event
 * with validateEvent. Only the harness-level steps (turn.started/ended,
 * the DM patch) are still produced here. Since T5 the wrappers come from the real
 * encounter-adapters (toEngineSides) and every step's state is projected
 * back through applyEngineSides, validated and hashed.
 *
 * Every step is checked for: JSON round-trip of the full wrapper state,
 * and nothing changing on the next setImmediate after the step resolves
 * (the M64 P0-1 "un-awaited engine" regression).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateEncounterState } from '../../js/shared/encounter-state.js';
import { validateEvent, validateEventLog } from '../../js/shared/events.js';
import { runOneAttack } from '../../js/scene/combat-engine.js';
import { seedRng } from '../../js/scene/simulator.js';
import { resetReactionsForAll } from '../../js/scene/reactions.js';
import { spellById } from '../../js/scene/monster-spells.js';
import { parsedDdbFixture } from './entities.js';
import { toEngineSides, applyEngineSides, dynamicStateOf } from '../../js/scene/encounter-adapters.js';

const FIXTURE_DIR = new URL('../fixtures/encounters/', import.meta.url);

/**
 * Deterministic JSON with sorted object keys.
 * @param {unknown} v
 * @returns {string}
 */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * 32-bit FNV-1a of a string, as 8 hex chars.
 * @param {string} s
 * @returns {string}
 */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Load and validate a scenario's fixtures.
 * @param {string} name
 * @returns {{name: string, state: object, intents: object[]}}
 */
export function loadScenario(name) {
  const state = JSON.parse(readFileSync(new URL(`${name}.state.json`, FIXTURE_DIR), 'utf8'));
  const intents = JSON.parse(readFileSync(new URL(`${name}.intents.json`, FIXTURE_DIR), 'utf8'));
  const v = validateEncounterState(state);
  if (!v.ok) throw new Error(`${name}.state.json is not a valid EncounterState: ${JSON.stringify(v.errors)}`);
  if (!Array.isArray(intents)) throw new Error(`${name}.intents.json must be an array`);
  return { name, state, intents };
}

/**
 * EncounterState v1 → engine wrappers through the real M64 T5 adapters
 * (encounter-adapters.toEngineSides). PC sheets come from the synthetic
 * DDB fixtures named by `sheetRef.characterId`.
 * @param {object} state — a valid EncounterState
 * @returns {{wrappers: object[], scene: object}}
 */
export function wrappersFromState(state) {
  const sheets = {};
  for (const e of Object.values(state.entities)) {
    if (e.kind === 'pc') sheets[e.sheetRef.characterId] = parsedDdbFixture(e.sheetRef.characterId);
  }
  const { wrappers, scene } = toEngineSides(state, sheets);
  return { wrappers, scene };
}

/**
 * Projection of one wrapper used for diffing and the golden's final state.
 * @param {object} w
 * @returns {object}
 */
export function projectWrapper(w) {
  const pos = w._position || w.position;
  return {
    hp: w.hp,
    pos: pos ? { col: pos.col, row: pos.row } : null,
    conditions: [...(w.conditions || [])],
    reactionUsed: !!w._reactionUsed,
    slots: w._slots ? { ...w._slots } : null,
    innate: w._innate ? { ...(w._innate.recharges || {}) } : null,
    legendaryBudget: w._legendaryBudget ?? 0,
    concentration: w._concentrating ? w._concentrating.spellId : null,
    actionSurgeUsed: w._actionSurgeUsed ?? 0,
    secondWindUsed: !!w._secondWindUsed,
    shieldActive: !!w._shieldActive,
    damageDealt: w.damageDealt ?? 0
  };
}

function projectAll(wrappers) {
  const out = {};
  for (const w of [...wrappers].sort((a, b) => (a.id < b.id ? -1 : 1))) out[w.id] = projectWrapper(w);
  return out;
}

function diffEvents(before, after, actorId) {
  const evs = [];
  const ids = Object.keys(after).sort();
  const actor = actorId ?? null;
  const a0 = actor && before[actor];
  const a1 = actor && after[actor];
  if (a0 && a1 && a0.pos && a1.pos && (a0.pos.col !== a1.pos.col || a0.pos.row !== a1.pos.row)) {
    evs.push(['move', { actorId: actor, from: a0.pos, to: a1.pos }]);
  }
  for (const id of ids) {
    const b = before[id];
    const n = after[id];
    const src = id === actor ? null : actor;
    if (n.hp < b.hp) evs.push(['damage', { sourceId: src, targetId: id, amount: b.hp - n.hp, type: null, hpBefore: b.hp, hpAfter: n.hp }]);
    if (n.hp > b.hp) evs.push(['heal', { sourceId: actor, targetId: id, amount: n.hp - b.hp, hpBefore: b.hp, hpAfter: n.hp }]);
    for (const c of n.conditions) if (!b.conditions.includes(c)) evs.push(['condition.applied', { entityId: id, condition: c, sourceId: src }]);
    for (const c of b.conditions) if (!n.conditions.includes(c)) evs.push(['condition.removed', { entityId: id, condition: c, sourceId: src }]);
    if (b.concentration && b.concentration !== n.concentration) evs.push(['concentration.broken', { casterId: id, spellId: b.concentration }]);
    if (n.concentration && b.concentration !== n.concentration) evs.push(['concentration.started', { casterId: id, spellId: n.concentration }]);
    if (!b.reactionUsed && n.reactionUsed) evs.push(['resource.spent', { entityId: id, resource: 'reaction', level: null }]);
    for (const lvl of Object.keys(n.slots || {}).sort()) {
      const d = (b.slots?.[lvl] ?? 0) - (n.slots[lvl] ?? 0);
      for (let i = 0; i < d; i++) evs.push(['resource.spent', { entityId: id, resource: 'spell-slot', level: Number(lvl) }]);
    }
    for (const sp of Object.keys(n.innate || {}).sort()) {
      if (b.innate?.[sp] === true && n.innate[sp] === false) evs.push(['resource.spent', { entityId: id, resource: `innate:${sp}`, level: null }]);
    }
    if (n.legendaryBudget < b.legendaryBudget) evs.push(['resource.spent', { entityId: id, resource: 'legendary', level: null }]);
    if (n.actionSurgeUsed > b.actionSurgeUsed) evs.push(['feature.used', { entityId: id, featureId: 'action-surge' }]);
    if (n.secondWindUsed && !b.secondWindUsed) evs.push(['feature.used', { entityId: id, featureId: 'second-wind' }]);
    if (b.hp > 0 && n.hp === 0) evs.push(['entity.downed', { entityId: id }]);
  }
  return evs;
}

function resolveWeapon(actor, name) {
  if (!name) return undefined;
  const pool = [actor.ref?.equipment?.mainhand, ...(actor.ref?.carried || [])].filter(Boolean);
  const hit = pool.find(w => w.name === name);
  if (!hit) throw new Error(`turn.act: ${actor.id} has no weapon "${name}"`);
  const { slot: _s, inferredSlot: _i, ...weapon } = hit;
  return weapon;
}

function toForcePlan(actor, plan) {
  return {
    kind: plan.kind,
    targetId: plan.targetId ?? null,
    targetSide: plan.targetSide || 'enemy',
    ...(plan.weaponName ? { weapon: resolveWeapon(actor, plan.weaponName) } : {}),
    ...(plan.spellId ? { spellId: plan.spellId, castAtLevel: plan.castAtLevel ?? spellById(plan.spellId)?.level ?? 0 } : {}),
    ...(plan.innate ? { isInnate: true } : {}),
    featuresFired: [...(plan.features || [])],
    archetype: 'manual',
    score: 0,
    breakdown: []
  };
}

/**
 * Run a scenario against the engine and return its derived event log.
 * Throws (with a descriptive message) on any tripwire, round-trip or
 * state-at-return violation.
 * @param {{name: string, state: object, intents: object[]}} scenario
 * @returns {Promise<{scenario: string, seed: number, events: object[], final: object}>}
 */
export async function runScenario({ name, state, intents }) {
  const { wrappers, scene } = wrappersFromState(state);
  const byId = new Map(wrappers.map(w => [w.id, w]));
  const sideOf = (id) => state.entities[id].side;
  const base = seedRng(state.rng.s);
  let draws = 0;
  const rng = () => { draws++; return base(); };
  const events = [];
  let seq = state.lastEventSeq;
  let round = state.round;
  let turnNo = 0;
  const emit = (type, payload, turnId, cinemaGroup = null) => {
    const ev = { seq: ++seq, type, round, turnId, cinemaGroup, payload };
    const v = validateEvent(ev);
    if (!v.ok) throw new Error(`${name}: derived ${type} event is invalid: ${JSON.stringify(v.errors)}`);
    events.push(ev);
  };
  // The hash covers the DYNAMIC EncounterState only (never the static
  // sheetRef / statBlock contents), so additive sheet-parser fields do
  // not flip every golden.
  const stateNow = () => applyEngineSides(state, wrappers);
  const stateHash = () => fnv1a(canonicalJson(dynamicStateOf(stateNow())));

  for (const [i, step] of intents.entries()) {
    const where = `${name} step ${i} (${step.t})`;
    const before = projectAll(wrappers);
    if (step.t === 'round.start') {
      round++;
      resetReactionsForAll(wrappers);
    } else if (step.t === 'turn.delegate' || step.t === 'turn.act') {
      const actor = byId.get(step.actorId);
      if (!actor) throw new Error(`${where}: unknown actor ${step.actorId}`);
      const turnId = `t${++turnNo}`;
      const drawsBefore = draws;
      emit('turn.started', { actorId: actor.id }, turnId);
      const allies = wrappers.filter(w => sideOf(w.id) === sideOf(actor.id));
      const enemies = wrappers.filter(w => sideOf(w.id) !== sideOf(actor.id));
      const prompts = step.t === 'turn.act' ? { forcePlan: toForcePlan(actor, step.plan) } : {};
      // M64 T4 — the engine's own events, captured through ctx.emit.
      const ctx = {
        turnId,
        ...(step.t === 'turn.act' ? { planSource: actor.kind === 'pc' ? 'player' : 'dm' } : {}),
        emit: (ev) => emit(ev.type, ev.payload, turnId, ev.cinemaGroup)
      };
      await runOneAttack(actor, enemies, allies, scene, rng, prompts, ctx);
      emit('turn.ended', { actorId: actor.id, stateHash: stateHash(), rngDraws: draws - drawsBefore }, turnId);
    } else if (step.t === 'dm.entity.patch') {
      const p = step.p;
      const target = byId.get(p.entityId);
      if (!target) throw new Error(`${where}: unknown entity ${p.entityId}`);
      if (p.hp !== undefined) {
        emit('dm.override', { kind: 'hp', entityId: target.id, before: target.hp, after: p.hp }, null);
        target.hp = Math.min(target.hpMax, p.hp);
      }
      for (const c of p.addConditions || []) if (!target.conditions.includes(c)) target.conditions.push(c);
      for (const c of p.removeConditions || []) target.conditions = target.conditions.filter(x => x !== c);
      for (const [type, payload] of diffEvents(before, projectAll(wrappers), null)) {
        if (type !== 'damage' && type !== 'heal') emit(type, payload, null);
      }
    } else if (step.t === 'legendary') {
      throw new Error(`${where}: blocked on E1 T7 (M64 plan) — legendary actions run only inside simulator.js`);
    } else if (step.t === 'dm.roll.arm') {
      throw new Error(`${where}: blocked on E1 T8 (M64 plan) — the engine has no onRoll hook`);
    } else {
      throw new Error(`${where}: unknown step type`);
    }

    // Tripwire: the whole live state is pure JSON after every step, and
    // the adapters project it to a valid EncounterState that round-trips.
    const snapshot = JSON.parse(JSON.stringify(wrappers));
    assert.deepStrictEqual(snapshot, wrappers, `${where}: wrapper state does not survive a JSON round-trip`);
    const applied = stateNow();
    const sv = validateEncounterState(applied);
    assert.ok(sv.ok, `${where}: applyEngineSides produced an invalid EncounterState: ${JSON.stringify(sv.errors)}`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(applied)), applied, `${where}: EncounterState does not survive a JSON round-trip`);
    // Tripwire: nothing resolves after the step returns (P0-1).
    const atReturn = canonicalJson(wrappers);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(canonicalJson(wrappers), atReturn, `${where}: state changed after the step resolved (un-awaited engine work)`);
  }

  const log = validateEventLog(events);
  if (!log.ok) throw new Error(`${name}: event log invalid: ${JSON.stringify(log.errors)}`);
  return { scenario: name, seed: state.rng.s, events, final: projectAll(wrappers) };
}
