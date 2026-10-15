/**
 * M64 C1 — Live runner ↔ combat-engine bridge (pure, Node-safe).
 *
 * Extracted from main.js (M45 Phase 2 / 4b.2). The combat engine works
 * on per-turn "wrappers": flat objects with `hp: number`, `hpMax`, `ac`,
 * `weapon`, `_position`, `_slots`, per-turn flags, etc. Live records
 * have a different shape: PCs carry `hp: { current, max }` and keep
 * their grid cell in `scene.positions`; monsters carry
 * `hp: { current, max }` and `position`. This module:
 *
 *   1. wrapPcForEngine / wrapMonsterForEngine build engine wrappers
 *      from the live records. Mutable runtime pools (`_slots`,
 *      `conditions[]`) are SHARED by reference so engine mutations
 *      persist to the live entity automatically. Scalar state (hp,
 *      position, per-turn flags) is copied and written back after.
 *   2. runTurn wraps the active entity plus every live enemy and ally,
 *      calls the engine with the injected `rng` and `prompts`, then
 *      writes every wrapper back.
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

import { positionOf } from './scene-state.js';
import { MONSTER_PRESETS } from './monster-presets.js';
import { deriveAC } from './pc-stats.js';
import { lvl1SlotsForPc, lvl3SlotsForPc, slotsForPc } from './reactions.js';
import { choosePcAction } from './ai/pc-action.js';
import { resetPerTurnFlags } from './ai/pc-features.js';
import { runOneAttack } from './combat-engine.js';

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
  return choosePcAction({ self: pc, enemies, allies, rng });
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

/**
 * Build an engine wrapper from a live PC record. `conditions` and
 * `_slots` are shared by reference with the live record.
 * @param {object} pc
 * @param {number} idx  the PC's index in the party (position fallback)
 * @param {object} scene
 * @returns {object|null}
 */
export function wrapPcForEngine(pc, idx, scene) {
  if (!pc) return null;
  if (!Array.isArray(pc.conditions)) pc.conditions = [];
  if (!pc._slots) pc._slots = slotsForPc(pc);
  return {
    ref: pc,
    id: pc.id,
    name: pc.name || 'PC',
    kind: 'pc',
    hp: pc.hp?.current ?? pc.hp?.max ?? 1,
    hpMax: pc.hp?.max ?? 1,
    ac: deriveAC(pc),
    weapon: pc._chosenWeapon || pc.equipment?.mainhand || null,
    _chosenWeapon: pc._chosenWeapon || null,
    // SHARED — engine push/pop persists to the live record.
    conditions: pc.conditions,
    _position: positionOf(scene, pc.id, idx),
    damageDealt: 0,
    combatMods: pc.combatMods || [],
    _reactionUsed: !!pc._reactionUsed,
    _lvl1Slots: pc._lvl1Slots ?? lvl1SlotsForPc(pc),
    _lvl3Slots: pc._lvl3Slots ?? lvl3SlotsForPc(pc),
    // SHARED — slot decrements persist directly.
    _slots: pc._slots,
    _shieldActive: !!pc._shieldActive,
    _actionSurgeUsed: pc._actionSurgeUsed ?? 0,
    _secondWindUsed: !!pc._secondWindUsed,
    _sneakAttackUsedThisTurn: !!pc._sneakAttackUsedThisTurn,
    _cunningActionUsedThisTurn: !!pc._cunningActionUsedThisTurn,
    _recklessUsedThisTurn: !!pc._recklessUsedThisTurn,
    _recklessUntilNextTurn: !!pc._recklessUntilNextTurn,
    _smiteSlotUsed: pc._smiteSlotUsed || null
  };
}

/**
 * Build an engine wrapper from a live monster record. `conditions` is
 * shared by reference; `_slots` / `_innate` pools are shared when set.
 * @param {object} m
 * @returns {object|null}
 */
export function wrapMonsterForEngine(m) {
  if (!m) return null;
  if (!Array.isArray(m.conditions)) m.conditions = [];
  const preset = MONSTER_PRESETS[m.presetSlug] || {};
  return {
    ref: m,
    id: m.id,
    name: m.name || preset.name || 'Monster',
    kind: 'monster',
    presetSlug: m.presetSlug,
    hp: m.hp?.current ?? m.hp?.max ?? 1,
    hpMax: m.hp?.max ?? 1,
    ac: preset.ac ?? 12,
    attack: preset.attack || { name: 'Strike', bonus: 2, dice: '1d6' },
    secondary: preset.secondary || null,
    conditions: m.conditions,
    position: m.position,
    damageDealt: 0,
    _innate: m._innate || null,
    _slots: m._slots || null,
    _reactionUsed: !!m._reactionUsed,
    _legendaryBudget: m._legendaryBudget ?? 0,
    _recklessUntilNextTurn: !!m._recklessUntilNextTurn
  };
}

/**
 * Copy mutated state from an engine wrapper back to its live PC: HP
 * (clamped to [0, max]), grid position (into `scene.positions`), and
 * per-turn flags. Shared refs (conditions, _slots) need no copy.
 * @param {object} pc
 * @param {object} wrapper
 * @param {object} scene
 * @returns {void}
 */
export function writeBackPc(pc, wrapper, scene) {
  if (!pc || !wrapper) return;
  if (pc.hp && Number.isFinite(wrapper.hp)) {
    pc.hp = { ...pc.hp, current: Math.max(0, Math.min(pc.hp.max, wrapper.hp | 0)) };
  }
  if (wrapper._position && scene) {
    scene.positions = {
      ...(scene.positions || {}),
      [String(pc.id)]: wrapper._position
    };
  }
  pc._reactionUsed = !!wrapper._reactionUsed;
  pc._shieldActive = !!wrapper._shieldActive;
  pc._actionSurgeUsed = wrapper._actionSurgeUsed ?? 0;
  pc._secondWindUsed = !!wrapper._secondWindUsed;
  pc._sneakAttackUsedThisTurn = !!wrapper._sneakAttackUsedThisTurn;
  pc._cunningActionUsedThisTurn = !!wrapper._cunningActionUsedThisTurn;
  pc._recklessUsedThisTurn = !!wrapper._recklessUsedThisTurn;
  pc._recklessUntilNextTurn = !!wrapper._recklessUntilNextTurn;
  pc._smiteSlotUsed = wrapper._smiteSlotUsed || null;
  pc._lastPlan = wrapper._lastPlan || null;
  pc._chosenWeapon = wrapper._chosenWeapon || null;
}

/**
 * Copy mutated state from an engine wrapper back to its live monster:
 * HP (clamped), position, reaction / legendary / reckless state, plan.
 * @param {object} m
 * @param {object} wrapper
 * @returns {void}
 */
export function writeBackMonster(m, wrapper) {
  if (!m || !wrapper) return;
  if (m.hp && Number.isFinite(wrapper.hp)) {
    m.hp = { ...m.hp, current: Math.max(0, Math.min(m.hp.max, wrapper.hp | 0)) };
  }
  if (wrapper.position) m.position = wrapper.position;
  m._reactionUsed = !!wrapper._reactionUsed;
  m._legendaryBudget = wrapper._legendaryBudget ?? 0;
  m._lastPlan = wrapper._lastPlan || null;
  m._recklessUntilNextTurn = !!wrapper._recklessUntilNextTurn;
}

/**
 * Wrap every living combatant (plus the active entity even if it is at
 * 0 HP) and split them into the active entity's enemies and allies.
 * @param {{party: object[], scene: object, active: object, kind: 'pc'|'monster'}} args
 * @returns {{active: object|null, enemies: object[], allies: object[],
 *            pcWrappers: object[], monWrappers: object[]}}
 */
export function buildEngineSides({ party, scene, active, kind }) {
  const pcs = party || [];
  const pcWrappers = pcs
    .filter(p => (p.hp?.current ?? 0) > 0 || p === active)
    .map(p => wrapPcForEngine(p, pcs.indexOf(p), scene));
  const monWrappers = (scene?.monsters || [])
    .filter(m => (m.hp?.current ?? 0) > 0 || m === active)
    .map(m => wrapMonsterForEngine(m));
  const enemies = kind === 'pc' ? monWrappers : pcWrappers;
  const allies  = kind === 'pc' ? pcWrappers : monWrappers;
  const activeWrapper = (kind === 'pc' ? pcWrappers : monWrappers)
    .find(w => w.id === active?.id) || null;
  return { active: activeWrapper, enemies, allies, pcWrappers, monWrappers };
}

/**
 * Run one entity's turn through the unified combat engine, then write
 * every wrapper back to its live record.
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
  const { active, enemies, allies, pcWrappers, monWrappers } =
    buildEngineSides({ party, scene, active: entity, kind });
  if (!active) return null;

  await runOneAttack(active, enemies, allies, scene, rng, prompts);

  // Write back every wrapper. Order only matters for the active entity
  // (an OA may have damaged it before its own attack); walk them all.
  const pcs = party || [];
  for (const w of pcWrappers) {
    const live = pcs.find(p => p.id === w.id);
    if (live) writeBackPc(live, w, scene);
  }
  for (const w of monWrappers) {
    const live = (scene?.monsters || []).find(m => m.id === w.id);
    if (live) writeBackMonster(live, w);
  }
  return active;
}
