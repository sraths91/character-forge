/**
 * M64 C1 — Live runner ↔ combat-engine bridge (pure, Node-safe).
 *
 * Extracted from main.js (M45 Phase 2 / 4b.2). Live records have the
 * browser's shape: PCs carry `hp: { current, max }` and keep their grid
 * cell in `scene.positions`; monsters carry `hp: { current, max }` and
 * `position`. Since M64 T5 this module no longer builds engine wrappers
 * itself — there is ONE bridge, shared with the server:
 *
 *   live records ──liveEncounterState──▶ EncounterState v1
 *     ──toEngineSides──▶ wrappers ──runOneAttack──▶ wrappers
 *     ──applyEngineSides──▶ EncounterState ──copy──▶ live records
 *
 * (encounter-adapters.js). Wrappers are fresh copies; nothing is shared
 * by reference with the live records, and everything the engine changes
 * (HP, position, conditions, the one slot ledger, concentration, flags)
 * is written back after the turn.
 *
 * Everything that used to close over main.js's `currentScene` and
 * `partyComposedCharacters` now takes them as explicit `scene` and
 * `party` parameters. No DOM, no localStorage, no timers: the browser
 * (main.js) and the Node server both import this file. UI prompt
 * wiring (cinema, logs, the Shield dialog) stays with the caller and
 * arrives here as the `prompts` object.
 *
 * OWNERSHIP: E1 (engine) takes this file over in M64 Wave 2 — T5
 * replaces the internals with EncounterState adapters while keeping
 * every exported name and signature below.
 */

import { positionOf } from './scene-model.js';
import { MONSTER_PRESETS } from './monster-presets.js';
import { deriveAC } from './pc-stats.js';
import { slotsForPc, pactForPc } from './reactions.js';
import { freshSlots } from './monster-spells.js';
import { choosePcAction } from './ai/pc-action.js';
import { resetPerTurnFlags } from './ai/pc-features.js';
import { runOneAttack } from './combat-engine.js';
import { createTurnState } from './turn-manager.js';
import {
  toEngineSides, applyEngineSides, wrapperFromEntity, applyWrapperToEntity, ledgerFromPool
} from './encounter-adapters.js';
import { ENCOUNTER_STATE_VERSION } from '../shared/encounter-state.js';

/**
 * Find a live entity by id on the given side.
 * @param {string|number} id
 * @param {'pc'|'monster'} kind
 * @param {{party: object[], scene: object}} ctx
 * @returns {object|undefined}
 */
export function resolveEntityById(id, kind, { party, scene }) {
  if (kind === 'pc') return (party || []).find(p => String(p.id) === String(id));
  return (scene?.monsters || []).find(m => String(m.id) === String(id));
}

/**
 * Prepare a live PC entity for the AI planner. choosePcAction reads the
 * same fields the simulator wraps onto its per-iteration PC copy
 * (`_position`, `_slots`, per-turn feature flags); lazy-init them here.
 * Mutates the entity — these are session-scoped runtime flags.
 * @param {object} pc
 * @param {number} index  the PC's index in the party (position fallback)
 * @param {object} scene
 * @returns {object} the same pc
 */
export function prepareLivePcForPlanning(pc, index, scene) {
  if (!pc) return pc;
  pc._position = positionOf(scene, pc.id, index);
  if (!pc._slots) pc._slots = slotsForPc(pc);
  resetPerTurnFlags(pc);
  return pc;
}

/**
 * Build the PC AI plan for a live PC turn: gather live enemies and
 * allies with snapshotted positions, then invoke the planner with the
 * injected rng (the planner's MCTS rollouts consume it).
 * @param {object} pc
 * @param {{party: object[], scene: object, rng: () => number}} ctx
 * @returns {object|null} the plan, or null when there is no pc
 */
export function planForLivePc(pc, { party, scene, rng }) {
  if (!pc) return null;
  if (typeof rng !== 'function') {
    throw new TypeError('live-bridge.planForLivePc: rng must be a function');
  }
  const enemies = (scene?.monsters || [])
    .filter(m => (m.hp?.current ?? 0) > 0)
    .map(m => ({ ...m, _position: m.position }));
  const allies = (party || [])
    .map((p, i) => ({ ...p, _position: positionOf(scene, p.id, i) }))
    .filter(p => (p.hp?.current ?? 0) > 0);
  const plan = choosePcAction({ self: pc, enemies, allies, rng });
  // M64 T5 — the planner's MCTS context holds an entity copy; never let
  // it linger on the live record.
  delete pc._mctsTargetCtx;
  return plan;
}

/**
 * Resolve the live target entity named by a plan's `targetId` +
 * `targetSide` (enemy → monster; ally → pc).
 * @param {object} plan
 * @param {{party: object[], scene: object}} ctx
 * @returns {{kind: 'pc'|'monster', entity: object}|null}
 */
export function resolvePlanTarget(plan, { party, scene }) {
  if (!plan?.targetId) return null;
  if (plan.targetSide === 'ally') {
    const pc = (party || []).find(p => String(p.id) === String(plan.targetId));
    return pc ? { kind: 'pc', entity: pc } : null;
  }
  const monster = (scene?.monsters || []).find(m => String(m.id) === String(plan.targetId));
  return monster ? { kind: 'monster', entity: monster } : null;
}

// ---------------------------------------------------------------------
// Live record ↔ EncounterState entity
// ---------------------------------------------------------------------

/** Live-record fields that share their name with an engine wrapper field. */
const LIVE_PC_FIELDS = [
  '_reactionUsed', '_shieldActive', '_actionSurgeUsed', '_secondWindUsed',
  '_sneakAttackUsedThisTurn', '_cunningActionUsedThisTurn', '_recklessUsedThisTurn',
  '_recklessUntilNextTurn', '_smiteSlotUsed', '_surgeFiredThisTurn', '_extraActionThisTurn',
  '_concentrating', '_conditionMeta', 'status', 'deathSaves', '_features'
];
const LIVE_MONSTER_FIELDS = [
  '_reactionUsed', '_legendaryBudget', '_recklessUntilNextTurn', '_innate', '_concentrating',
  '_conditionMeta', 'status'
];

const intOr = (v, d) => (Number.isFinite(v) ? Math.trunc(v) : d);

function fullLedger(pool) {
  const out = {};
  for (const [lvl, n] of Object.entries(pool || {})) {
    if (/^[1-9]$/.test(lvl) && n > 0) out[lvl] = { max: n, spent: 0 };
  }
  return out;
}

function pick(record, fields) {
  const out = {};
  for (const f of fields) if (record[f] !== undefined) out[f] = record[f];
  return out;
}

function baseEntity({ id, kind, side, name, pos, hpCur, hpMax, hpTemp, ac }) {
  const max = Math.max(1, intOr(hpMax, 1));
  return {
    id: String(id), kind, side, name: String(name || (kind === 'pc' ? 'PC' : 'Monster')),
    controller: { type: 'ai', seatId: null },
    pos: { col: Math.max(0, intOr(pos?.col, 0)), row: Math.max(0, intOr(pos?.row, 0)) },
    hp: Math.max(0, Math.min(max, intOr(hpCur, max))),
    hpMax: max,
    hpTemp: Math.max(0, intOr(hpTemp, 0)),
    ac: intOr(ac, 10),
    speedFt: 30,
    conditions: [],
    concentration: null,
    resources: { reactionUsed: false, slots: {}, pact: {}, innate: null, legendaryBudget: 0, features: {} },
    turnFlags: {}
  };
}

/**
 * EncounterState entity for a live PC record. The slot ledger's max is
 * the sheet's full pool (slotsForPc); the live `_slots` are what remain.
 * @param {object} pc — live PC record
 * @param {number} idx — party index (position fallback)
 * @param {object} scene — live scene
 * @returns {object} EncounterState entity (sheetRef.characterId = String(pc.id))
 */
export function entityFromLivePc(pc, idx, scene) {
  const e = baseEntity({
    id: pc.id, kind: 'pc', side: 'party', name: pc.name,
    pos: positionOf(scene, pc.id, idx),
    hpCur: pc.hp?.current ?? pc.hp?.max ?? 1, hpMax: pc.hp?.max ?? 1, hpTemp: pc.hp?.temp,
    ac: deriveAC(pc)
  });
  const fresh = slotsForPc(pc);
  e.resources.slots = ledgerFromPool(fullLedger(fresh), pc._slots || fresh);
  const pact = pc._pact && Number.isInteger(pc._pact.level) ? pc._pact : pactForPc(pc);
  if (pact) e.resources.pact = { level: pact.level, max: pact.max, spent: Math.min(pact.max, pact.spent ?? 0) };
  e.sheetRef = { characterId: String(pc.id), rev: 0 };
  return applyWrapperToEntity(e, {
    ...pick(pc, LIVE_PC_FIELDS),
    conditions: Array.isArray(pc.conditions) ? pc.conditions : []
  });
}

/**
 * EncounterState entity for a live monster record. AC and attacks come
 * from the visual preset unless the record carries a `statBlock`;
 * `_aiProfile` (Open5e inference / the DM AI editor) rides
 * `statBlock.profile`.
 * @param {object} m — live monster instance
 * @returns {object} EncounterState entity
 */
export function entityFromLiveMonster(m) {
  const preset = MONSTER_PRESETS[m.presetSlug] || {};
  const sb = m.statBlock && typeof m.statBlock === 'object' ? m.statBlock : {};
  const e = baseEntity({
    id: m.id, kind: 'monster', side: 'hostile', name: m.name || preset.name,
    pos: m.position,
    hpCur: m.hp?.current ?? m.hp?.max ?? 1, hpMax: m.hp?.max ?? 1, hpTemp: m.hp?.temp,
    ac: sb.ac ?? preset.ac ?? 12
  });
  e.resources.slots = m._slots ? ledgerFromPool(fullLedger(freshSlots(m.presetSlug)), m._slots) : {};
  e.statBlock = { ...JSON.parse(JSON.stringify(sb)), slug: m.presetSlug };
  if (m._aiProfile) e.statBlock.profile = JSON.parse(JSON.stringify(m._aiProfile));
  return applyWrapperToEntity(e, {
    ...pick(m, LIVE_MONSTER_FIELDS),
    conditions: Array.isArray(m.conditions) ? m.conditions : []
  });
}

/**
 * Copy an EncounterState entity's dynamic state onto its live record.
 * @param {object} live — live PC / monster record (mutated)
 * @param {object} entity — EncounterState entity
 * @param {object} scene — live scene (PC positions live in scene.positions)
 * @param {{position?: boolean}} [opts] — write the position (default true)
 */
function copyEntityToLive(live, entity, scene, { position = true } = {}) {
  const w = wrapperFromEntity(entity, live);
  // HP is projected, not changed, here (applyDamage / applyHealing own
  // every change); temp HP rides along once it exists.
  if (live.hp) live.hp = { ...live.hp, current: entity.hp, ...(entity.hpTemp || live.hp.temp ? { temp: entity.hpTemp } : {}) };
  live.conditions = [...w.conditions];
  if (entity.kind === 'pc') {
    if (position && scene) {
      scene.positions = { ...(scene.positions || {}), [String(live.id)]: { ...entity.pos } };
    }
    for (const f of LIVE_PC_FIELDS) live[f] = w[f];
    live._slots = { ...w._slots };
    if (w._pact) live._pact = { ...w._pact };
  } else {
    if (position) live.position = { ...entity.pos };
    for (const f of LIVE_MONSTER_FIELDS) live[f] = w[f];
    if (w._slots) live._slots = { ...w._slots };
    if (entity.statBlock?.profile) live._aiProfile = entity.statBlock.profile;
  }
}

/**
 * Project the live versus roster into an EncounterState: every living
 * PC and monster, plus the active entity even at 0 HP (or everyone with
 * `includeDown`).
 * @param {{party: object[], scene: object, active?: object|null, includeDown?: boolean}} args
 * @returns {{state: object, sheets: Record<string, object>,
 *            live: Map<string, {record: object, kind: 'pc'|'monster'}>}}
 *   `sheets` maps each id to its live record (PC sheet / monster ref).
 */
export function liveEncounterState({ party, scene, active = null, includeDown = false }) {
  const pcs = party || [];
  const entities = {};
  const sheets = {};
  const live = new Map();
  pcs.forEach((p, i) => {
    if (!p || (!includeDown && (p.hp?.current ?? 0) <= 0 && p !== active)) return;
    const e = entityFromLivePc(p, i, scene);
    entities[e.id] = e; sheets[e.id] = p; live.set(e.id, { record: p, kind: 'pc' });
  });
  for (const m of scene?.monsters || []) {
    if (!m || (!includeDown && (m.hp?.current ?? 0) <= 0 && m !== active)) continue;
    const e = entityFromLiveMonster(m);
    entities[e.id] = e; sheets[e.id] = m; live.set(e.id, { record: m, kind: 'monster' });
  }
  const state = {
    v: ENCOUNTER_STATE_VERSION, encounterId: 'live', round: 0, turnIndex: 0, phase: 'running',
    rng: { algo: 'mulberry32', s: 0 },
    grid: {
      cols: Math.max(1, intOr(scene?.cols, 10)), rows: Math.max(1, intOr(scene?.rows, 7)),
      cellFt: 5, flankingEnabled: !!scene?.flankingEnabled
    },
    map: null, initiative: [], entities, lastEventSeq: 0
  };
  return { state, sheets, live };
}

function applyLiveTransient(wrapper, record) {
  if (wrapper?.kind === 'pc' && record?._chosenWeapon) {
    wrapper.weapon = record._chosenWeapon;
    wrapper._chosenWeapon = record._chosenWeapon;
  }
  return wrapper;
}

// ---------------------------------------------------------------------
// Legacy wrap / write-back API (names and signatures kept; internals go
// through the EncounterState adapters)
// ---------------------------------------------------------------------

/**
 * Build an engine wrapper from a live PC record (a fresh copy — write
 * changes back with writeBackPc). Lazy-inits `conditions[]` and `_slots`
 * on the live record as before.
 * @param {object} pc
 * @param {number} idx  the PC's index in the party (position fallback)
 * @param {object} scene
 * @returns {object|null}
 */
export function wrapPcForEngine(pc, idx, scene) {
  if (!pc) return null;
  if (!Array.isArray(pc.conditions)) pc.conditions = [];
  if (!pc._slots) pc._slots = slotsForPc(pc);
  return applyLiveTransient(wrapperFromEntity(entityFromLivePc(pc, idx, scene), pc), pc);
}

/**
 * Build an engine wrapper from a live monster record (a fresh copy).
 * @param {object} m
 * @returns {object|null}
 */
export function wrapMonsterForEngine(m) {
  if (!m) return null;
  if (!Array.isArray(m.conditions)) m.conditions = [];
  return wrapperFromEntity(entityFromLiveMonster(m), m);
}

/**
 * Copy mutated state from an engine wrapper back to its live PC: HP
 * (clamped to [0, max]), grid position (into `scene.positions`),
 * conditions, the slot ledger, concentration and per-turn flags.
 * Fields the wrapper lacks keep their live value.
 * @param {object} pc
 * @param {object} wrapper
 * @param {object} scene
 * @returns {void}
 */
export function writeBackPc(pc, wrapper, scene) {
  if (!pc || !wrapper) return;
  const before = entityFromLivePc(pc, 0, scene || { cols: 10, rows: 7 });
  const after = applyWrapperToEntity(before, wrapper);
  copyEntityToLive(pc, after, scene, { position: !!wrapper._position });
  pc._lastPlan = wrapper._lastPlan || null;
  pc._chosenWeapon = wrapper._chosenWeapon || null;
}

/**
 * Copy mutated state from an engine wrapper back to its live monster:
 * HP (clamped), position, conditions, reaction / legendary / reckless
 * state, slots, innate state, concentration, plan.
 * @param {object} m
 * @param {object} wrapper
 * @returns {void}
 */
export function writeBackMonster(m, wrapper) {
  if (!m || !wrapper) return;
  const after = applyWrapperToEntity(entityFromLiveMonster(m), wrapper);
  copyEntityToLive(m, after, null, { position: !!wrapper.position });
  m._lastPlan = wrapper._lastPlan || null;
}

/**
 * Wrap every living combatant (plus the active entity even if it is at
 * 0 HP) and split them into the active entity's enemies and allies.
 * @param {{party: object[], scene: object, active: object, kind: 'pc'|'monster'}} args
 * @returns {{active: object|null, enemies: object[], allies: object[],
 *            pcWrappers: object[], monWrappers: object[]}}
 */
export function buildEngineSides({ party, scene, active, kind }) {
  const { state, sheets, live } = liveEncounterState({ party, scene, active });
  const activeId = active ? String(active.id) : null;
  const isActive = activeId && live.get(activeId)?.record === active && live.get(activeId)?.kind === kind;
  const sides = toEngineSides(state, sheets, isActive ? activeId : null);
  for (const w of sides.wrappers) applyLiveTransient(w, live.get(w.id)?.record);
  const pcWrappers = sides.wrappers.filter(w => w.kind === 'pc');
  const monWrappers = sides.wrappers.filter(w => w.kind === 'monster');
  return {
    active: sides.active,
    enemies: kind === 'pc' ? monWrappers : pcWrappers,
    allies: kind === 'pc' ? pcWrappers : monWrappers,
    pcWrappers, monWrappers
  };
}

/**
 * Run one entity's turn through the unified combat engine, then write
 * every wrapper back to its live record (through the EncounterState
 * adapters — the same path the server takes).
 *
 * @param {object} args
 * @param {object[]} args.party   live PC records (mutated by write-back)
 * @param {object} args.scene     live scene (`monsters`, `positions`, grid)
 * @param {object} args.entity    the live entity taking the turn
 * @param {'pc'|'monster'} args.kind
 * @param {() => number} args.rng  required; the engine never falls back
 * @param {object} [args.prompts] engine prompt callbacks (`{}` = all auto)
 * @returns {Promise<object|null>} the active wrapper after the turn
 *   (for `_lastPlan`, `damageDealt`, …), or null if the entity is not
 *   in the scene.
 */
export async function runTurn({ party, scene, entity, kind, rng, prompts = {} }) {
  if (typeof rng !== 'function') {
    throw new TypeError('live-bridge.runTurn: rng must be a function');
  }
  const { state, sheets, live } = liveEncounterState({ party, scene, active: entity });
  const activeId = entity ? String(entity.id) : null;
  const slot = activeId ? live.get(activeId) : null;
  if (!slot || slot.record !== entity || slot.kind !== kind) return null;
  const sides = toEngineSides(state, sheets, activeId);
  for (const w of sides.wrappers) applyLiveTransient(w, live.get(w.id)?.record);

  await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, rng, prompts);

  const next = applyEngineSides(state, sides.wrappers);
  for (const [id, e] of Object.entries(next.entities)) {
    const rec = live.get(id);
    if (rec) copyEntityToLive(rec.record, e, scene);
  }
  entity._lastPlan = sides.active._lastPlan || null;
  if (kind === 'pc') entity._chosenWeapon = sides.active._chosenWeapon || null;
  return sides.active;
}

// ---------------------------------------------------------------------
// M64 T7 — the browser auto-fight runs on the engine turn manager
// ---------------------------------------------------------------------

const LIVE_TURN_STATES = new WeakMap();

/**
 * A turn-manager TurnState over the live versus roster (every PC and
 * monster, downed ones included so the initiative stays intact).
 * @param {{party: object[], scene: object,
 *          initiative: {entityId: string|number, score?: number}[]}} args
 * @returns {object} TurnState (phase 'setup'; call startEncounter)
 */
export function liveTurnState({ party, scene, initiative = [] }) {
  const { state, sheets, live } = liveEncounterState({ party, scene, includeDown: true });
  const sides = toEngineSides(state, sheets);
  for (const w of sides.wrappers) applyLiveTransient(w, live.get(w.id)?.record);
  const ts = createTurnState({
    wrappers: sides.wrappers,
    sides: Object.fromEntries(Object.values(state.entities).map(e => [e.id, e.side])),
    scene: sides.scene,
    initiative: (initiative || [])
      .filter(r => state.entities[String(r.entityId)])
      .map(r => ({ entityId: String(r.entityId), score: r.score ?? 0 }))
  });
  LIVE_TURN_STATES.set(ts, { state, live });
  return ts;
}

/**
 * Copy every TurnState wrapper onto its live record (start-of-turn resets,
 * legendary actions — whatever the turn manager changed).
 * @param {object} ts — from liveTurnState
 * @param {{scene: object}} ctx — the live scene (PC positions)
 */
export function syncLiveFromTurnState(ts, { scene }) {
  const held = LIVE_TURN_STATES.get(ts);
  if (!held) throw new Error('live-bridge.syncLiveFromTurnState: not a liveTurnState');
  const next = applyEngineSides(held.state, Object.values(ts.entities));
  for (const [id, e] of Object.entries(next.entities)) {
    const rec = held.live.get(id);
    if (rec) copyEntityToLive(rec.record, e, scene);
  }
  held.state = next;
}

/**
 * Rebuild the TurnState's wrappers from the live records (after a turn
 * the browser ran through its own UI path), keeping ids, sides and the
 * initiative.
 * @param {object} ts — from liveTurnState
 * @param {{party: object[], scene: object}} ctx
 */
export function refreshTurnStateFromLive(ts, { party, scene }) {
  const held = LIVE_TURN_STATES.get(ts);
  if (!held) throw new Error('live-bridge.refreshTurnStateFromLive: not a liveTurnState');
  const { state, sheets, live } = liveEncounterState({ party, scene, includeDown: true });
  const sides = toEngineSides(state, sheets);
  for (const w of sides.wrappers) {
    if (!ts.entities[w.id]) continue;
    applyLiveTransient(w, live.get(w.id)?.record);
    ts.entities[w.id] = w;
  }
  LIVE_TURN_STATES.set(ts, { state, live });
}
