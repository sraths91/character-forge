/**
 * M64 T7 — the engine turn manager: ONE round loop for the simulator,
 * the browser auto-fight and the server.
 *
 * It owns everything around a single `runOneAttack`: initiative order,
 * per-creature start-of-turn resets (reaction, Shield, Reckless, per-turn
 * feature flags, the legendary budget), death saves for downed PCs (M64
 * R9: at the start of their turn), skipping downed and incapacitated
 * creatures, legendary actions after each opposing turn, the victory
 * check, the round cap, `skipTurn`, and a pause flag checked at safe
 * points (between turns only — never mid-resolution). Innate recharge is
 * rolled by the engine at the start of each monster turn.
 *
 * It works on a TurnState — engine wrappers plus turn bookkeeping — so
 * the simulator's hot loop never round-trips through JSON:
 *
 *   {
 *     round, turnIndex, phase: 'setup'|'running'|'ended', outcome,
 *     paused, maxRounds,
 *     initiative: [{ entityId, score }],
 *     entities: { [id]: wrapper },
 *     sides: { [id]: 'party'|'hostile' },
 *     scene: { cols, rows, flankingEnabled, … },
 *     baseState?: EncounterState   // set by turnStateFromEncounter
 *   }
 *
 * The server converts at turn boundaries:
 *   const ts = turnStateFromEncounter(state, sheets);
 *   const rng = createRng(state.rng);
 *   await runTurn(ts, { rng, prompts, emit, … });
 *   state = encounterFromTurnState(ts, rng);
 *
 * runTurn ctx:
 *   rng            — required
 *   prompts        — engine prompts for the actor's turn (forcePlan, …)
 *   emit           — sync event sink; events arrive as {type, payload,
 *                    cinemaGroup, round, turnId} (the caller adds seq)
 *   isPaused       — () → boolean, checked before the turn starts
 *   victoryRule    — 'hp' (default: a side is out when every member is at
 *                    0 HP) | 'standing' (also counts incapacitated as out;
 *                    the simulator's rule)
 *   runActorTurn   — optional custom executor (actor, {enemies, allies,
 *                    ctx}) → Promise; the browser uses it to route the
 *                    actor's turn through its own UI prompts
 *   planSource, reactionDeadlineMs, cinemaInputs — passed to the engine
 */

import {
  runOneAttack, runLegendaryActions, isAlive, isIncapacitated, sameId, setHpRaw,
  startOfTurnConditions, endOfTurnConditions, sweepConcentrationConditions,
  rollDeathSave
} from './combat-engine.js';
import { wrapperConditions } from './conditions.js';
import { resetReaction } from './reactions.js';
import { isLegendary, resetLegendaryBudget } from './monster-legendary.js';
import { resetPerTurnFlags } from './ai/pc-features.js';
import { requireRng } from './rng.js';
import { toEngineSides, applyEngineSides } from './encounter-adapters.js';
import { canEmit } from './engine-events.js';
import { stateHash } from '../shared/state-hash.js';

/** Encounter outcomes (events.js ENCOUNTER_OUTCOMES). */
export const OUTCOMES = Object.freeze(['party-victory', 'hostile-victory', 'draw', 'dm-ended']);

/**
 * Build a TurnState from engine wrappers.
 * @param {object} args
 * @param {object[]} args.wrappers
 * @param {Record<string, 'party'|'hostile'>|((w: object) => 'party'|'hostile')} args.sides
 *   side per entity id (or a function of the wrapper)
 * @param {object} args.scene
 * @param {{entityId: string, score: number}[]|null} [args.initiative]
 * @param {number} [args.round=0]
 * @param {number} [args.turnIndex=0]
 * @param {'setup'|'running'|'ended'} [args.phase='setup']
 * @param {number|null} [args.maxRounds=null]
 * @returns {object} TurnState
 */
export function createTurnState({ wrappers, sides, scene, initiative = null, round = 0, turnIndex = 0, phase = 'setup', maxRounds = null }) {
  const entities = {};
  const sideMap = {};
  for (const w of wrappers || []) {
    const id = String(w.id);
    entities[id] = w;
    sideMap[id] = typeof sides === 'function' ? sides(w) : sides[id];
    if (sideMap[id] !== 'party' && sideMap[id] !== 'hostile') {
      throw new Error(`turn-manager: entity "${id}" has no side`);
    }
  }
  return {
    round, turnIndex, phase, outcome: null, paused: false, maxRounds,
    initiative: initiative ? initiative.map(r => ({ entityId: String(r.entityId), score: r.score ?? 0 })) : [],
    entities, sides: sideMap, scene: scene || {}
  };
}

/**
 * TurnState from an EncounterState (server / harness). Keeps the state as
 * `baseState` so encounterFromTurnState can write it back.
 * @param {object} state — EncounterState v1
 * @param {Record<string, object>} sheets — see toEngineSides
 * @returns {object} TurnState
 */
export function turnStateFromEncounter(state, sheets = {}) {
  const sides = toEngineSides(state, sheets);
  const ts = createTurnState({
    wrappers: sides.wrappers,
    sides: Object.fromEntries(Object.values(state.entities).map(e => [e.id, e.side])),
    scene: sides.scene,
    initiative: state.initiative,
    round: state.round,
    turnIndex: state.turnIndex,
    phase: state.phase === 'awaiting-prompt' ? 'running' : state.phase
  });
  ts.baseState = state;
  return ts;
}

/**
 * Write a TurnState back into a NEW EncounterState (its baseState, or the
 * given one). Pass the encounter's serializable rng to persist its state.
 * @param {object} ts — TurnState
 * @param {(function & {state?: function})|null} [rng]
 * @param {object} [baseState]
 * @returns {object} EncounterState
 */
export function encounterFromTurnState(ts, rng = null, baseState = ts.baseState) {
  if (!baseState) throw new Error('turn-manager: encounterFromTurnState needs a base EncounterState');
  const next = applyEngineSides(baseState, Object.values(ts.entities));
  next.round = ts.round;
  next.turnIndex = ts.turnIndex;
  next.phase = ts.phase;
  next.initiative = ts.initiative.map(r => ({ ...r }));
  if (rng && typeof rng.state === 'function') next.rng = rng.state();
  return next;
}

/**
 * Roll initiative: d20 + DEX modifier (PCs: sheet DEX; monsters: a stat
 * block DEX save or 0), highest first, ties keep roster order.
 * @param {object} ts
 * @param {function} rng
 * @returns {{entityId: string, score: number}[]}
 */
export function rollInitiative(ts, rng) {
  requireRng(rng, 'rollInitiative');
  const rows = Object.values(ts.entities).map((w, i) => {
    const dex = w.kind === 'pc'
      ? (w.ref?.abilityModifiers?.DEX ?? 0)
      : (Number(w.saves?.DEX) || 0);
    return { entityId: String(w.id), score: 1 + Math.floor(rng() * 20) + dex, i };
  });
  rows.sort((a, b) => b.score - a.score || a.i - b.i);
  return rows.map(({ entityId, score }) => ({ entityId, score }));
}

/**
 * Start the encounter: set the initiative ('roll' with rng, or 'given' —
 * keep ts.initiative, or roster order when empty), round 1, first turn.
 * @param {object} ts
 * @param {{rng?: function, initiative?: 'roll'|'given', maxRounds?: number|null}} [opts]
 * @returns {object} ts
 */
export function startEncounter(ts, { rng = null, initiative = 'roll', maxRounds = ts.maxRounds ?? null } = {}) {
  if (initiative === 'roll') ts.initiative = rollInitiative(ts, rng);
  else if (!ts.initiative.length) ts.initiative = Object.keys(ts.entities).map(id => ({ entityId: id, score: 0 }));
  ts.round = 1;
  ts.turnIndex = 0;
  ts.phase = 'running';
  ts.outcome = null;
  ts.maxRounds = maxRounds;
  return ts;
}

/**
 * The wrapper whose turn it is (null between encounters).
 * @param {object} ts
 * @returns {object|null}
 */
export function currentActor(ts) {
  const row = ts.initiative[ts.turnIndex];
  return row ? (ts.entities[row.entityId] || null) : null;
}

/**
 * Start-of-turn resets for one creature (PHB p190/p192: the reaction and
 * "until the start of your next turn" effects; MM: the legendary budget).
 * @param {object} actor — wrapper
 */
export function beginTurnResets(actor) {
  if (!actor) return;
  resetReaction(actor);
  if (actor._shieldActive) actor._shieldActive = false;
  if (actor._dodging) actor._dodging = false;
  if (actor._disengaged) actor._disengaged = false;
  if (actor.kind === 'pc') {
    actor._recklessUsedThisTurn = false;
    actor._recklessUntilNextTurn = false;
    resetPerTurnFlags(actor);
  }
  if (actor.kind === 'monster' && isLegendary(actor.presetSlug)) resetLegendaryBudget(actor);
}

/**
 * Who has won, if anyone.
 * @param {object} ts
 * @param {'hp'|'standing'} [rule='hp']
 * @returns {'party-victory'|'hostile-victory'|'draw'|null}
 */
export function victoryCheck(ts, rule = 'hp') {
  const up = (w) => isAlive(w) && (rule !== 'standing' || !isIncapacitated(w));
  let party = 0;
  let hostile = 0;
  for (const [id, w] of Object.entries(ts.entities)) {
    if (!up(w)) continue;
    if (ts.sides[id] === 'party') party++;
    else hostile++;
  }
  if (party === 0 && hostile === 0) return 'draw';
  if (hostile === 0) return 'party-victory';
  if (party === 0) return 'hostile-victory';
  return null;
}

function sidesFor(ts, actor) {
  const side = ts.sides[String(actor.id)];
  const allies = [];
  const enemies = [];
  for (const [id, w] of Object.entries(ts.entities)) (ts.sides[id] === side ? allies : enemies).push(w);
  return { allies, enemies };
}

function turnIdOf(ts) {
  return `r${ts.round}t${ts.turnIndex}`;
}

function makeEmitter(ts, ctx, turnId) {
  if (!canEmit(ctx)) return null;
  return (ev) => ctx.emit({ ...ev, round: ts.round, turnId });
}

function engineCtxFor(ts, ctx, turnId) {
  const emit = makeEmitter(ts, ctx, turnId);
  // M64 R7 — the round stamps conditions' appliedRound.
  if (!emit) return { round: ts.round };
  return {
    emit, turnId, round: ts.round,
    ...(ctx.planSource ? { planSource: ctx.planSource } : {}),
    ...(Number.isInteger(ctx.reactionDeadlineMs) ? { reactionDeadlineMs: ctx.reactionDeadlineMs } : {}),
    ...(typeof ctx.cinemaInputs === 'function' ? { cinemaInputs: ctx.cinemaInputs } : {})
  };
}

function hashOf(ts) {
  return ts.baseState ? stateHash(encounterFromTurnState(ts)) : undefined;
}

function finish(ts, outcome, emit) {
  ts.phase = 'ended';
  ts.outcome = outcome;
  if (emit) emit({ type: 'encounter.ended', payload: { outcome, round: ts.round }, cinemaGroup: null });
}

/** Advance to the next initiative slot; wraps rounds and applies the cap. */
function advance(ts, emit) {
  ts.turnIndex++;
  if (ts.turnIndex < ts.initiative.length) return false;
  if (ts.maxRounds && ts.round >= ts.maxRounds) {
    ts.turnIndex = 0;
    finish(ts, 'draw', emit);
    return true;
  }
  ts.turnIndex = 0;
  ts.round++;
  return true;
}

function reactionPrompts(prompts) {
  if (!prompts) return {};
  const { forcePlan: _f, ...rest } = prompts;
  return rest;
}

/**
 * Run the current initiative slot: resets, skip checks, the actor's
 * engine turn, legendary actions, victory check, advance.
 *
 * @param {object} ts — TurnState (mutated)
 * @param {object} ctx — see the module header
 * @returns {Promise<{actorId: string|null, round: number, turnIndex: number,
 *   ran: boolean, skipped?: string, paused?: boolean, roundEnded?: boolean,
 *   ended?: boolean, outcome?: string}>}
 */
export async function runTurn(ts, ctx = {}) {
  if (ts.phase === 'ended') return { actorId: null, round: ts.round, turnIndex: ts.turnIndex, ran: false, ended: true, outcome: ts.outcome };
  if (ts.phase !== 'running') throw new Error('turn-manager: call startEncounter before runTurn');
  if (ts.paused || (typeof ctx.isPaused === 'function' && ctx.isPaused())) {
    return { actorId: null, round: ts.round, turnIndex: ts.turnIndex, ran: false, paused: true };
  }
  const rng = requireRng(ctx.rng, 'turn-manager.runTurn');
  const turnId = turnIdOf(ts);
  const emit = makeEmitter(ts, ctx, turnId);
  // Safe point: DM edits queued since the last turn land before it starts.
  if (ts.dmQueue?.length) applyDmCommands(ts, ctx);
  const actor = currentActor(ts);
  const actorId = actor ? String(actor.id) : (ts.initiative[ts.turnIndex]?.entityId ?? null);
  const result = { actorId, round: ts.round, turnIndex: ts.turnIndex, ran: false };

  const engineCtx = engineCtxFor(ts, ctx, turnId);
  const roster = Object.values(ts.entities);
  // M64 R9 — a downed PC makes its death save at the start of its turn; a
  // natural 20 brings it back with 1 HP and it takes the turn.
  if (actor && !isAlive(actor) && actor.status === 'downed') rollDeathSave(actor, rng, engineCtx);
  if (!actor || !isAlive(actor)) {
    result.skipped = 'down';
    if (emit && actorId) emit({ type: 'turn.skipped', payload: { actorId, reason: 'down' }, cinemaGroup: null });
  } else {
    beginTurnResets(actor);
    // M64 R7 — condition lifecycle at the start of the turn (before the
    // incapacitated check: a stun that ends now lets the creature act).
    startOfTurnConditions(actor, engineCtx);
    if (isIncapacitated(actor)) {
      // Incapacitated creatures take no actions or movement, in every
      // caller (simulator, browser, server) — but still make their
      // end-of-turn repeat saves (Hold Person).
      result.skipped = 'incapacitated';
      if (emit) emit({ type: 'turn.skipped', payload: { actorId, reason: 'incapacitated' }, cinemaGroup: null });
      endOfTurnConditions(actor, roster, rng, engineCtx);
    } else {
      if (emit) emit({ type: 'turn.started', payload: { actorId }, cinemaGroup: null });
      const { enemies, allies } = sidesFor(ts, actor);
      if (typeof ctx.runActorTurn === 'function') {
        await ctx.runActorTurn(actor, { enemies, allies, ctx: engineCtx, ts });
      } else {
        await runOneAttack(actor, enemies, allies, ts.scene, rng, ctx.prompts || {}, engineCtx);
      }
      result.ran = true;
      // M64 R7 — end-of-turn lifecycle (repeat saves, turn-end and
      // source-turn-end conditions). runActorTurn may have replaced the
      // wrappers (browser), so look the actor up again.
      const live = ts.entities[actorId] || actor;
      endOfTurnConditions(live, Object.values(ts.entities), rng, engineCtx);
      // MM legendary actions: at the end of an opposing creature's turn.
      const actorSide = ts.sides[actorId];
      for (const [id, w] of Object.entries(ts.entities)) {
        if (ts.sides[id] === actorSide || w.kind !== 'monster' || !isLegendary(w.presetSlug)) continue;
        if (!isAlive(w) || isIncapacitated(w)) continue;
        const foes = Object.entries(ts.entities).filter(([oid]) => ts.sides[oid] !== ts.sides[id]).map(([, o]) => o);
        await runLegendaryActions(w, foes, ts.scene, rng, reactionPrompts(ctx.prompts), engineCtx);
      }
    }
  }

  // M64 R7 — conditions held by a concentration that dropped where the
  // engine could not see the whole roster (legendary actions) end now.
  sweepConcentrationConditions(Object.values(ts.entities), engineCtx);
  // Safe point: edits queued during the turn (outside a prompt) land now.
  if (ts.dmQueue?.length) applyDmCommands(ts, ctx);
  const outcome = victoryCheck(ts, ctx.victoryRule || 'hp');
  if (outcome) finish(ts, outcome, null);
  else result.roundEnded = advance(ts, null);
  // turn.ended carries the hash of the state as persisted after the turn
  // (turn index already advanced), so a client's mirror can compare.
  if (emit && result.ran) {
    const h = hashOf(ts);
    emit({ type: 'turn.ended', payload: { actorId, ...(h ? { stateHash: h } : {}) }, cinemaGroup: null });
  }
  if (ts.phase === 'ended') {
    result.ended = true;
    result.outcome = ts.outcome;
    if (emit) emit({ type: 'encounter.ended', payload: { outcome: ts.outcome, round: ts.round }, cinemaGroup: null });
  }
  return result;
}

/**
 * Run turns until the round wraps, the encounter ends, or it pauses.
 * @param {object} ts
 * @param {object} ctx
 * @returns {Promise<object[]>} the runTurn results
 */
export async function runRound(ts, ctx = {}) {
  const out = [];
  const round = ts.round;
  while (ts.phase === 'running' && ts.round === round) {
    const r = await runTurn(ts, ctx);
    out.push(r);
    if (r.paused || r.ended) break;
  }
  return out;
}

/**
 * Run until the encounter ends (or pauses). The simulator's loop.
 * @param {object} ts
 * @param {object} ctx
 * @returns {Promise<string|null>} the outcome, or null when paused
 */
export async function runEncounter(ts, ctx = {}) {
  while (ts.phase === 'running') {
    const r = await runTurn(ts, ctx);
    if (r.paused) return null;
  }
  return ts.outcome;
}

/**
 * Skip the current creature's turn (DM action), then advance.
 * @param {object} ts
 * @param {{emit?: function}} [ctx]
 * @param {string} [reason='dm']
 * @returns {{actorId: string|null, roundEnded: boolean}}
 */
export function skipTurn(ts, ctx = {}, reason = 'dm') {
  if (ts.phase !== 'running') return { actorId: null, roundEnded: false };
  const emit = makeEmitter(ts, ctx, turnIdOf(ts));
  const actorId = ts.initiative[ts.turnIndex]?.entityId ?? null;
  if (emit && actorId) emit({ type: 'turn.skipped', payload: { actorId, reason }, cinemaGroup: null });
  return { actorId, roundEnded: advance(ts, emit) };
}

/**
 * End the encounter now (DM).
 * @param {object} ts
 * @param {{emit?: function}} [ctx]
 * @param {'party-victory'|'hostile-victory'|'draw'|'dm-ended'} [outcome='dm-ended']
 */
export function endEncounter(ts, ctx = {}, outcome = 'dm-ended') {
  if (ts.phase === 'ended') return;
  finish(ts, outcome, makeEmitter(ts, ctx, turnIdOf(ts)));
}

/**
 * Set or clear the pause flag (checked before each turn).
 * @param {object} ts
 * @param {boolean} paused
 */
export function setPaused(ts, paused) {
  ts.paused = !!paused;
}

/**
 * Find a creature's initiative slot.
 * @param {object} ts
 * @param {string} entityId
 * @returns {number} index or -1
 */
export function initiativeIndexOf(ts, entityId) {
  return ts.initiative.findIndex(r => sameId(r.entityId, entityId));
}

// ---------------------------------------------------------------------
// M64 T8 — DM commands: checkpointed HP / condition edits and initiative
// ---------------------------------------------------------------------

/**
 * Queue a DM edit. It is applied only at a safe point — the start and end
 * of every runTurn, or whenever the server calls applyDmCommands while the
 * engine is suspended on a prompt (the engine re-checks HP after every
 * await) — never in the middle of a resolution step.
 * @param {object} ts
 * @param {{kind: 'hp'|'conditions', entityId: string, value: number|Array}} cmd
 */
export function queueDmCommand(ts, cmd) {
  if (!cmd || (cmd.kind !== 'hp' && cmd.kind !== 'conditions')) {
    throw new Error('turn-manager: DM command kind must be hp or conditions');
  }
  (ts.dmQueue || (ts.dmQueue = [])).push({ ...cmd, entityId: String(cmd.entityId) });
}

/**
 * Apply every queued DM edit to the live wrappers, emitting one
 * dm.override {kind, entityId, before, after} per edit.
 * @param {object} ts
 * @param {{emit?: function}} [ctx]
 * @returns {object[]} the applied overrides
 */
export function applyDmCommands(ts, ctx = {}) {
  const queue = ts.dmQueue || [];
  ts.dmQueue = [];
  const emit = makeEmitter(ts, ctx, turnIdOf(ts));
  const applied = [];
  for (const cmd of queue) {
    const w = ts.entities[cmd.entityId];
    if (!w) continue;
    let before;
    let after;
    if (cmd.kind === 'hp') {
      before = w.hp;
      // M64 R8 — HP changes only through applyDamage / applyHealing (raw).
      after = setHpRaw(w, cmd.value);
    } else {
      before = [...(w.conditions || [])];
      // Strings or R7 lifecycle objects; a string keeps the lifecycle the
      // creature already had for that id.
      const next = wrapperConditions(cmd.value || [], w._conditionMeta || {});
      after = next.conditions;
      w.conditions = after;
      if (Object.keys(next.meta).length || w._conditionMeta) w._conditionMeta = next.meta;
    }
    const ov = { kind: cmd.kind, entityId: cmd.entityId, before, after };
    applied.push(ov);
    if (emit) emit({ type: 'dm.override', payload: ov, cinemaGroup: null });
  }
  return applied;
}

/**
 * Add a creature to the encounter mid-fight and slot it into the
 * initiative by score (ties go after existing rows). The current actor
 * keeps its turn.
 * @param {object} ts
 * @param {{wrapper: object, side: 'party'|'hostile', score: number}} entry
 * @param {{emit?: function}} [ctx]
 * @returns {number} the new row's index
 */
export function insertInitiative(ts, { wrapper, side, score = 0 }, ctx = {}) {
  const id = String(wrapper.id);
  if (ts.entities[id]) throw new Error(`turn-manager: entity "${id}" is already in the encounter`);
  if (side !== 'party' && side !== 'hostile') throw new Error('turn-manager: side must be party or hostile');
  ts.entities[id] = wrapper;
  ts.sides[id] = side;
  let index = ts.initiative.findIndex(r => r.score < score);
  if (index < 0) index = ts.initiative.length;
  const row = { entityId: id, score };
  ts.initiative.splice(index, 0, row);
  if (ts.phase === 'running' && index <= ts.turnIndex && ts.initiative.length > 1) ts.turnIndex++;
  const emit = makeEmitter(ts, ctx, turnIdOf(ts));
  if (emit) emit({ type: 'dm.override', payload: { kind: 'initiative.insert', entityId: id, before: null, after: { ...row, index } }, cinemaGroup: null });
  return index;
}

/**
 * Remove a creature from the initiative (and, by default, the encounter).
 * Removing the current actor moves the turn to the next row.
 * @param {object} ts
 * @param {string} entityId
 * @param {{emit?: function}} [ctx]
 * @param {{removeEntity?: boolean}} [opts]
 * @returns {boolean} whether a row was removed
 */
export function removeInitiative(ts, entityId, ctx = {}, { removeEntity = true } = {}) {
  const index = initiativeIndexOf(ts, entityId);
  if (index < 0) return false;
  const [row] = ts.initiative.splice(index, 1);
  if (index < ts.turnIndex) ts.turnIndex--;
  if (ts.turnIndex >= ts.initiative.length) {
    ts.turnIndex = 0;
    if (ts.phase === 'running') ts.round++;
  }
  if (removeEntity) {
    delete ts.entities[row.entityId];
    delete ts.sides[row.entityId];
  }
  const emit = makeEmitter(ts, ctx, turnIdOf(ts));
  if (emit) emit({ type: 'dm.override', payload: { kind: 'initiative.remove', entityId: row.entityId, before: { ...row, index }, after: null }, cinemaGroup: null });
  return true;
}
