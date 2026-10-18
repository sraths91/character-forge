/**
 * M45 Phase 4 — Unified combat engine.
 *
 * The "spine" of attack resolution. Owns the pure rules:
 *
 *   - Per-turn AI planning dispatch (delegates to chooseAction /
 *     choosePcAction; produces the plan that drives everything else)
 *   - Movement + opportunity-attack triggering
 *   - Weapon attack resolution: stats build → resolver call → roll →
 *     Shield reaction → damage application → feature triggers
 *     (Sneak Attack, Divine Smite, Reckless Attack, Action Surge)
 *   - Monster + PC spell casting (cast plan → book lookup →
 *     Counterspell window → spell-kind branch → damage / heal /
 *     conditions / concentration)
 *   - Opportunity / reaction attacks
 *
 * Why a separate module? The simulator (M20) used to own all of this
 * inline. Adding the live versus runner (M28+) created a second
 * implementation — different cinema callbacks, different prompt
 * sequencing, different reaction handling. The two paths drifted: by
 * M45 the live runner was missing PC AI entirely (Phases 2+3 fixed
 * that). To keep them from diverging again, both callers now route
 * through this engine.
 *
 *   - Simulator (headless): passes no `prompts` — every reaction
 *     auto-resolves the same way it always has.
 *   - Live runner: passes async prompt callbacks (Shield, Counterspell,
 *     cinema-round dispatch). The engine awaits them where relevant.
 *
 * Pure transforms over its inputs. RNG injectable. Tests against the
 * simulator path are the authoritative behavioural contract — if a
 * change here flips a simulator iteration's outcome, the refactor
 * went wrong.
 */

import { resolveAttack } from './combat-resolver.js';
import { rollAttack, rollDamage, withD20, withSaveD20 } from './combat-roll.js';
import {
  deriveWeaponAttack, saveBonus as pcSaveBonus, proficiencyBonus, totalLevel
} from './pc-stats.js';
import { factionLists, chebyshevFeet, isRangedWeapon, meleeReachFt } from './grid-rules.js';
import { planMovement, occupiedCellsOf } from './movement.js';
import { straightPath, terrainPath, terrainApproach } from './pathing.js';
import { coverBetween, lineOfSight } from './grid-legality.js';
import { asTerrain, TERRAIN_FLAGS } from '../map/terrain.js';
import { chooseAction, fleeTargetCell } from './ai/profile.js';
import { choosePcAction } from './ai/pc-action.js';
import {
  PC_FEATURES, resetPerTurnFlags, attacksPerAction, classLevel, isRaging, rageDamageBonus, ragesPerLongRest
} from './ai/pc-features.js';
import {
  consumeReaction, detectOpportunityAttacks, detectPolearmEntryOAs,
  shouldCastShield, canCastShield, consumeShield, hasReactionAvailable,
  slotsForPc, shouldCounterspell, canCastCounterspell, consumeCounterspell,
  resolveCounterspell
} from './reactions.js';
import {
  consumeSlot, spellById, spellbookFor, freshInnateState,
  rollInnateRecharges, consumeInnate, applyUpcast
} from './monster-spells.js';
import {
  startConcentration, isConcentrating, dropConcentration,
  handleDamageOnConcentration
} from './concentration.js';
import { rollSave } from './save-rolls.js';
import { swingStyleMods, offhandWeaponFor, offhandDice } from './fighting-styles.js';
import { grantedSpellEntry, spellUseKey, featureLedgerFor, usesLeft, spendUse, spellSlug } from './feature-uses.js';
import { scaleCantrip } from './cantrip-scaling.js';
import { MONSTER_DEFAULT_SAVES } from './monster-presets.js';
import { chooseLegendaryAction, spendLegendaryAction } from './monster-legendary.js';
import {
  NO_CTX, canEmit, emitEvent, nextCinemaGroup, fxSeedOf, idOf, normalizeAnswer
} from './engine-events.js';
import {
  INCAPACITATING, addConditionTo, removeConditionFrom, conditionIds, conditionMeta,
  charmerIds, hasCondition, isIncapacitatedBy
} from './conditions.js';

// =====================================================================
// runOneAttack — single-entity-turn entry point
// =====================================================================

/**
 * @typedef {object} EnginePrompts
 * @property {object} [forcePlan] — a pre-built plan (manual play / DM);
 *   skips AI planning.
 * @property {function} [onShieldReaction]  — async ({ defender, atk, weapon, spell?, autoAnswer }) → boolean|{answer, by}
 *   Offered only when the defender can actually cast Shield and +5 AC
 *   would turn the hit into a miss. Fires for weapon attacks, OAs,
 *   spell attacks (`spell` set) and Magic Missile (`spell` set; `atk` is
 *   `{ hit: true, crit: false, total: null, autoHit: true }`).
 * @property {function} [onCounterspell]    — async ({ witness, caster, spell, autoAnswer }) → boolean|{answer, by}
 *   Offered only to witnesses for whom canCastCounterspell() is true.
 * @property {function} [onReactionAttack]  — async ({ triggerer, mover, kind, autoAnswer }) → boolean|{answer, by}
 *
 * M64 N1 — reaction answers are GATED: a `true` answer is re-checked
 * against the reactor's eligibility (canCastShield / canCastCounterspell
 * / hasReactionAvailable) after the await resolves, so no caller — a
 * dialog, a socket, a bug — can grant a reaction the creature lacks.
 * M64 T4 — an answer may be `{ answer, by }` (the prompt adapter) so the
 * reaction.resolved event records who answered.
 * M64 phase 1.5 (agreed with E3) — the engine's `reaction.offered` /
 * `reaction.resolved` pair is authoritative: `used` is the re-checked
 * result, not the raw answer. Hosts (the room) forward the engine's
 * events and must not emit their own copies.
 * @property {function} [onCinemaRound]     — async ({ attacker, defender, plan, atk, dmg, crit, … }) → void
 * @property {function} [onCastBegin]       — async ({ attacker, target, plan, spell }) → void
 *
 * Every callback is optional. The simulator passes {} so existing tests
 * see identical behaviour. Each reaction callback receives `autoAnswer`
 * — the value the engine's heuristic would have chosen.
 */

/**
 * Resolve one entity's full turn: planner → movement → attack/cast.
 *
 * The simulator calls this for each entity in initiative order; the live
 * runner and the server go through the same call (with prompt callbacks
 * for player-facing reactions). All side-effects land on the wrappers
 * the caller passes in — no globals.
 *
 * @param {object} attacker — Entity wrapper { kind, ref, hp, ac, ... }
 * @param {object[]} enemies — opposing side's wrappers
 * @param {object[]} allies — same-side wrappers
 * @param {object} scene — { cols, rows, flankingEnabled, … }
 * @param {function} rng — () → [0, 1); required
 * @param {EnginePrompts} [prompts] — optional async callbacks
 * @param {object} [ctx] — M64 T4: optional `{ emit, turnId, planSource,
 *   reactionDeadlineMs }`; `ctx.emit(ev)` receives every catalogue-v1
 *   event `{type, payload, cinemaGroup}` synchronously (engine-events.js).
 * @returns {Promise<void>}
 */
export async function runOneAttack(attacker, enemies, allies, scene, rng, prompts = {}, ctx = NO_CTX) {
  try {
    return await resolveTurn(attacker, enemies, allies, scene, rng, prompts || {}, ctx || NO_CTX);
  } finally {
    // M64 T5 — the planner's MCTS context (`_mctsTargetCtx`, a copy of the
    // target entity) is transient: it never outlives the turn, so wrappers
    // stay pure JSON for snapshots. Cleared to null, never `delete`d:
    // deleting a property drops the wrapper into V8 dictionary mode and
    // slows every later property read on it (the M64 round-4 simulator
    // regression). null round-trips through JSON; the adapters never
    // persist the field.
    if (attacker && attacker._mctsTargetCtx != null) {
      attacker._mctsTargetCtx = null;
    }
  }
}

/** Plan kinds that move (or not) but never reach the attack resolver. */
const NON_ATTACK_KINDS = new Set(['dash', 'dodge', 'disengage', 'move']);

async function resolveTurn(attacker, enemies, allies, scene, rng, prompts, ctx) {
  const actorId = idOf(attacker);
  // M64 R7 — an incapacitated creature takes no actions or movement. The
  // turn manager already skips it; this guards direct callers (manual
  // play) too, before any rng draw.
  if (isIncapacitated(attacker)) {
    emitEvent(ctx, 'turn.skipped', { actorId, reason: 'incapacitated' });
    return;
  }
  // M64 R7 — a charmed creature can't attack (or target with harmful
  // effects) the creature that charmed it; the planner never sees it as
  // a target and an explicit plan against it is rejected.
  const charmers = charmerIds(attacker);
  const targetable = charmers.length ? enemies.filter(e => !charmers.some(c => sameId(c, e.id))) : enemies;
  // M64 R13 — Dodge lasts until the start of this creature's next turn.
  if (attacker._dodging) attacker._dodging = false;
  // M37 — At the start of each monster's turn, roll d6 for any innate
  // spells that are cooling down. M64 T2 — this is the single source of
  // the per-turn recharge roll; callers must not roll it again.
  // M64 phase 1.5 wave 6 — each restored use is reported (events v1.3
  // `resource.recharged`) so a client mirror sees a recharge the monster
  // does not spend this turn.
  if (attacker.kind === 'monster' && attacker._innate) {
    for (const spellId of rollInnateRecharges(attacker, rng)) {
      emitEvent(ctx, 'resource.recharged', { entityId: actorId, resource: 'innate', spellId, available: 1 });
    }
  }
  // M32 — Monsters consult their AI profile.
  // M42 — PCs do too. choosePcAction picks weapon/spell/feature and
  // returns the same plan shape so the dispatch below stays unified.
  // M45 Phase 4b.3 — Manual play bypasses AI planning via
  // `prompts.forcePlan` — the caller hands in a pre-built plan
  // (kind + targetId + weapon/spell) and the engine resolves it as-is.
  // ---- 1. plan --------------------------------------------------------
  let plan = null;
  let planSource = 'ai';
  if (prompts.forcePlan) {
    plan = prompts.forcePlan;
    planSource = ctx.planSource || (attacker.kind === 'pc' ? 'player' : 'dm');
  } else if (attacker.kind === 'monster') {
    plan = chooseAction({
      self: attacker,
      enemies: targetable.filter(isAlive),
      allies: allies.filter(isAlive),
      rng
    });
  } else {
    // M42 — Per-turn AI for PCs. Resets sneak-attack/cunning-action
    // flags first, then picks the best (weapon/spell/feature) action.
    resetPerTurnFlags(attacker);
    plan = choosePcAction({
      self: attacker,
      enemies: targetable.filter(isAlive),
      allies: allies.filter(isAlive),
      // M64 R8 — downed PCs (0 HP) can be healed back up.
      downedAllies: allies.filter(a => a.kind === 'pc' && !isAlive(a) && !isDead(a)),
      rng
    });
  }

  // ---- 2. gate: M64 T8 DM review (approve / replace / skip) ------------
  let explicit = !!prompts.forcePlan;
  if (plan && typeof prompts.onPlanReady === 'function') {
    const reviewed = await prompts.onPlanReady({ attacker, plan, source: planSource });
    if (reviewed === null) {
      attacker._lastPlan = plan;
      emitEvent(ctx, 'dm.override', { kind: 'plan.skip', entityId: actorId, before: planSummary(plan), after: null });
      emitEvent(ctx, 'turn.skipped', { actorId, reason: 'dm' });
      return;
    }
    if (reviewed && reviewed !== plan) {
      emitEvent(ctx, 'dm.override', { kind: 'plan', entityId: actorId, before: planSummary(plan), after: planSummary(reviewed) });
      plan = reviewed;
      planSource = 'dm';
      explicit = true;
    }
    // M64 T6 — re-check after the await.
    if (!isAlive(attacker)) return;
  }

  // ---- 3. bind the plan --------------------------------------------------
  attacker._lastPlan = plan;
  // M51.1 — Set BOTH the resolution weapon (_chosenWeapon) AND the
  // display/movement weapon (attacker.weapon) so a chosen weapon drives
  // reach, the to-hit/damage in the log, and the cinema.
  if (plan?.weapon) { attacker._chosenWeapon = plan.weapon; attacker.weapon = plan.weapon; }
  // Every plan (player, DM or AI) names its side: an ally-targeted plan
  // (Healing Word, Cure Wounds) resolves among the allies. M64 round 3 —
  // AI heal plans used to be looked up among the enemies and never landed.
  // M64 phase 1.5 wave 6 — a self-targeted spell (Misty Step) is decided
  // by the registry, not the plan: the turn.act plan has no 'self' side.
  const selfSpell = plan?.kind === 'cast' && spellById(plan.spellId)?.targetSide === 'self';
  let target;
  if (selfSpell) target = attacker;
  else if (plan?.targetSide === 'ally') target = allies.find(a => sameId(a.id, plan.targetId));
  else if (plan?.targetId != null) target = enemies.find(e => sameId(e.id, plan.targetId));
  else target = pickTarget(targetable);
  if (plan && canEmit(ctx)) {
    emitEvent(ctx, 'plan.chosen', {
      actorId, kind: String(plan.kind), targetId: plan.targetId != null ? String(plan.targetId) : null,
      source: planSource,
      weapon: plan.weapon?.name ?? null,
      spellId: plan.spellId ?? null,
      castAtLevel: Number.isInteger(plan.castAtLevel) ? plan.castAtLevel : null,
      featuresFired: [...(plan.featuresFired || [])],
      archetype: plan.archetype ?? null
    });
  }
  // M64 phase 1.5 — a 'feature' plan (Second Wind, Rage, …) is the whole
  // turn: no move, no attack.
  if (plan?.kind === 'feature') {
    const featureId = plan.featureId || plan.featuresFired?.[0] || null;
    const used = useFeature(attacker, featureId, { ctx, rng });
    if (!used) {
      emitEvent(ctx, explicit ? 'turn.rejected' : 'turn.skipped', explicit
        ? { actorId, code: 'bad-feature', reason: `${featureId ?? '(none)'} is not available now` }
        : { actorId, reason: 'no-feature' });
    }
    return;
  }
  if (!target) {
    if (explicit) {
      emitEvent(ctx, 'turn.rejected', {
        actorId, code: 'target-not-found',
        reason: `target ${plan?.targetId ?? '(none)'} is not a valid ${plan?.targetSide === 'ally' ? 'ally' : 'enemy'}`
      });
    } else {
      emitEvent(ctx, 'turn.skipped', { actorId, reason: 'no-target' });
    }
    return;
  }
  const healsAlly = plan?.kind === 'cast' && plan?.targetSide === 'ally';
  if (!healsAlly && plan?.targetSide !== 'ally' && charmers.some(c => sameId(c, target.id)) && !NON_ATTACK_KINDS.has(plan?.kind)) {
    emitEvent(ctx, explicit ? 'turn.rejected' : 'turn.skipped', explicit
      ? { actorId, code: 'charmed', reason: `${attacker.name || actorId} is charmed by ${target.name || idOf(target)}` }
      : { actorId, reason: 'charmed' });
    return;
  }
  // M64 R9 — a player / DM may attack a dying PC (each hit is a failed
  // death save); the dead and the fallen monsters are off the table.
  if (explicit && !isAlive(target) && !isDying(target) && !healsAlly && !NON_ATTACK_KINDS.has(plan.kind)) {
    emitEvent(ctx, 'turn.rejected', { actorId, code: 'target-down', reason: `${target.name || idOf(target)} is down` });
    return;
  }

  // M64 phase 1.5 wave 6 — a teleport cast replaces the move: no walk, no
  // opportunity attacks; runMonsterSpell places the caster.
  if (selfSpell) {
    if (attacker.kind === 'pc' && !attacker._slots) attacker._slots = slotsForPc(attacker.ref || attacker);
    await runMonsterSpell({
      attacker, target: attacker, plan, scene, rng,
      witnesses: enemies.filter(isAlive).filter(e => e.kind === 'pc'),
      allEnemies: enemies, allies, prompts, ctx
    });
    return;
  }

  // M31 — Movement step before the attack. M32: if the profile said
  // 'flee', the attacker moves AWAY from the nearest threat instead of
  // toward it, and skips the attack roll this turn.
  const attackerPos = attacker._position || attacker.position;
  const targetPos   = target._position   || target.position;
  // An AI ally-targeted cast does not walk toward the ally: the planner
  // only offers it in range. Player / DM plans move as before.
  const staysPut = healsAlly && !explicit;
  if (attackerPos && targetPos && !staysPut) {
    const weapon = attacker.kind === 'pc' ? attacker.weapon : { name: attacker.attack?.name };
    const occupied = occupiedCellsOf({
      party: allies, monsters: enemies,
      excludeId: attacker.id
    });
    const bounds = { cols: scene?.cols || 99, rows: scene?.rows || 99 };
    // M64 T9 — movement budget from the entity (sheet / preset), 30 ft default.
    // M64 R13 — Dash doubles the movement budget this turn; Disengage
    // stops this move provoking opportunity attacks (reactions.js reads
    // _disengaged).
    // M64 R7 — grappled / restrained: speed 0.
    const pinned = hasCondition(attacker, 'grappled') || hasCondition(attacker, 'restrained');
    const baseSpeed = pinned ? 0 : (Number.isFinite(attacker.speedFt) ? attacker.speedFt : 30);
    const speedFt = plan?.kind === 'dash' ? baseSpeed * 2 : baseSpeed;
    attacker._disengaged = plan?.kind === 'disengage';
    let next;
    let movePath = null;
    if (explicit && plan.moveTo) {
      // M64 T9 — a player-chosen destination is honoured as-is, within
      // the budget, on the grid and onto a free cell.
      const mv = plan.moveTo;
      const free = !occupied.has(`${mv.col},${mv.row}`) || (mv.col === attackerPos.col && mv.row === attackerPos.row);
      const inGrid = mv.col >= 0 && mv.row >= 0 && mv.col < bounds.cols && mv.row < bounds.rows;
      if (!inGrid || !free || chebyshevFeet(attackerPos, mv) > speedFt) {
        emitEvent(ctx, 'turn.rejected', {
          actorId, code: 'bad-move',
          reason: !inGrid ? 'destination is off the grid' : !free ? 'destination is occupied' : `destination is beyond ${speedFt} ft`
        });
        return;
      }
      next = { col: mv.col, row: mv.row };
      // With a terrain layer the destination must be reachable on a legal
      // path (blocked cells, difficult terrain, no corner squeeze).
      if (scene?.terrain && (mv.col !== attackerPos.col || mv.row !== attackerPos.row)) {
        const routed = terrainPath(scene.terrain, attacker, [...allies, ...enemies], attackerPos, next, speedFt);
        if (!routed || routed.to.col !== mv.col || routed.to.row !== mv.row) {
          emitEvent(ctx, 'turn.rejected', { actorId, code: 'bad-move', reason: `no legal path to the destination within ${speedFt} ft` });
          return;
        }
        movePath = routed.path;
      }
    } else {
      const fleeing = plan && plan.kind === 'flee';
      const moveTarget = fleeing ? fleeTargetCell(attacker, target, bounds, rng) : targetPos;
      // M64 T11 — with a terrain layer, route through grid-legality.
      let routed = null;
      if (scene?.terrain) {
        const creatures = [...allies, ...enemies];
        routed = fleeing
          ? terrainPath(scene.terrain, attacker, creatures, attackerPos, moveTarget, speedFt)
          : terrainApproach(scene.terrain, attacker, creatures, attackerPos, moveTarget,
            isRangedWeapon(weapon) ? 80 : meleeReachFt(weapon), speedFt);
      }
      if (routed) {
        next = routed.to;
        movePath = routed.path;
      } else {
        next = planMovement({
          from: attackerPos, to: moveTarget, weapon,
          speedFt, occupied, bounds
        });
      }
    }
    if (next && (next.col !== attackerPos.col || next.row !== attackerPos.row)) {
      // M33.0 — opportunity attacks fire BEFORE the move resolves.
      const leaveTriggers = detectOpportunityAttacks({
        mover: attacker, before: attackerPos, after: next, hostiles: enemies
      });
      const entryTriggers = detectPolearmEntryOAs({
        mover: attacker, before: attackerPos, after: next, hostiles: enemies
      });
      for (const { triggerer } of leaveTriggers) {
        if (!isAlive(attacker)) break;
        if (await askReactionAttack(triggerer, attacker, 'leave', prompts, ctx)) {
          await runReactionAttack(triggerer, attacker, attackerPos, scene, rng, prompts, ctx, { roster: [...allies, ...enemies] });
          consumeReaction(triggerer);
          emitEvent(ctx, 'resource.spent', { entityId: idOf(triggerer), resource: 'reaction', level: null });
        }
      }
      for (const { triggerer } of entryTriggers) {
        if (!isAlive(attacker)) break;
        if (await askReactionAttack(triggerer, attacker, 'entry', prompts, ctx)) {
          await runReactionAttack(triggerer, attacker, next, scene, rng, prompts, ctx, { roster: [...allies, ...enemies] });
          consumeReaction(triggerer);
          emitEvent(ctx, 'resource.spent', { entityId: idOf(triggerer), resource: 'reaction', level: null });
        }
      }
      // M64 T6 — re-check after the reaction awaits: a creature dropped
      // by an opportunity attack (or a DM edit during a prompt) stops
      // where it stood.
      if (!isAlive(attacker)) return;
      if (attacker.kind === 'pc') attacker._position = next;
      else attacker.position = next;
      // M64 T11 — the move event carries the path so clients can animate.
      const path = movePath || straightPath(attackerPos, next);
      emitEvent(ctx, 'move', {
        actorId, from: { col: attackerPos.col, row: attackerPos.row }, to: { col: next.col, row: next.row },
        path: path.map(c => ({ col: c.col, row: c.row }))
      });
      if (typeof prompts.onMove === 'function') {
        await prompts.onMove({ mover: attacker, from: attackerPos, to: next, path });
        if (!isAlive(attacker)) return;
      }
    }
  }

  // M64 R13 — Dodge: attacks against this creature have disadvantage
  // until its next turn (cleared at the top of resolveTurn).
  if (plan?.kind === 'dodge') attacker._dodging = true;
  // Fleeing creatures Dash instead of attacking
  if (plan && plan.kind === 'flee') return;
  // M64 T6 — the target may have dropped while we awaited reactions.
  if (!isAlive(target) && !(explicit && isDying(target)) && !healsAlly && !(plan && NON_ATTACK_KINDS.has(plan.kind))) {
    emitEvent(ctx, 'turn.skipped', { actorId, reason: 'target-down' });
    return;
  }
  // M42 — Non-attack PC actions skip the resolver entirely.
  // M64 T9 — so does a plain move.
  if (plan && NON_ATTACK_KINDS.has(plan.kind)) {
    return;
  }

  // M34 — Casting branch.
  if (plan && plan.kind === 'cast') {
    const castTarget = target;
    if (attacker.kind === 'pc' && !attacker._slots) {
      attacker._slots = slotsForPc(attacker.ref || attacker);
    }
    await runMonsterSpell({
      attacker, target: castTarget, plan, scene, rng,
      witnesses: enemies.filter(isAlive).filter(e => e.kind === 'pc'),
      allEnemies: enemies,
      allies,
      prompts, ctx
    });
    return;
  }

  // M64 phase 1.5 — bonus-action features riding the plan (Rage, Second
  // Wind) resolve before the swings.
  let bonusUsed = false;
  if (attacker.kind === 'pc' && plan?.featuresFired?.length) {
    for (const id of plan.featuresFired) {
      if (!bonusUsed && PC_FEATURES[id]?.action === 'bonus' && useFeature(attacker, id, { ctx, rng })) bonusUsed = true;
    }
    if (!isAlive(attacker)) return;
  }
  // ---- 4. the Attack action ---------------------------------------------
  // M64 R10 — one Attack action makes every swing Extra Attack /
  // Multiattack grants. Action Surge adds a second Attack action right
  // after it, WITHOUT re-running the planner or movement (it used to
  // recurse through runOneAttack, which moved the fighter again).
  const turn = {
    attacker, enemies, allies, targetable, scene, rng, prompts, ctx, plan, explicit,
    charmers, actorId, sneakDone: false, recklessDone: false, bonusUsed,
    // M64 R9 — an explicit plan against a dying PC keeps swinging at it;
    // otherwise later swings move on from a creature that drops.
    dyingTarget: explicit && isDying(target) ? target : null
  };
  const first = await runAttackAction(turn, target, true);
  if (first.status === 'rejected') return;
  // M64 phase 1.5 — two-weapon fighting (PHB p195): a light melee weapon
  // in each hand gives a bonus-action attack with the off hand, when the
  // bonus action is still free (no Rage / Second Wind this turn).
  if (attacker.kind === 'pc' && plan?.kind === 'melee' && !turn.bonusUsed && isAlive(attacker)) {
    const off = offhandWeaponFor(attacker.ref, first.weaponRef);
    const offTarget = off ? (keepsTarget(turn, first.target) ? first.target : retargetFor(turn, off)) : null;
    if (off && offTarget) {
      turn.bonusUsed = true;
      await runWeaponSwing(turn, offTarget, off, Math.max(1, first.swings), first.shared, false, { offhand: true });
    }
  }
  if (attacker.kind === 'pc' && plan?.featuresFired?.includes('action-surge') && !attacker._surgeFiredThisTurn) {
    attacker._surgeFiredThisTurn = true;
    PC_FEATURES['action-surge'].consume(attacker);
    emitEvent(ctx, 'feature.used', { entityId: actorId, featureId: 'action-surge' });
    if (isAlive(attacker) && sideAlive(enemies) > 0) {
      const next = keepsTarget(turn, first.target) ? first.target : retargetFor(turn, first.weaponRef);
      if (next) await runAttackAction(turn, next, false);
    }
    attacker._surgeFiredThisTurn = false;
  }
}

/**
 * M64 R10 — the attack records one Attack action uses, in order.
 *
 *   PCs: the plan's weapon, `attacksPerAction` times (pc-features: Extra
 *     Attack — Fighter 5: 2, 11: 3, 20: 4; Barbarian / Paladin / Ranger /
 *     Monk 5: 2).
 *   Monsters: the stat block's Multiattack when present —
 *     `multiattack: [{action, count}]` (E4's Open5e normaliser, R11:
 *     `action` names an `attacks[]` record; `action: null` means "any
 *     weapon attack", optionally `kind: 'melee'|'ranged'` and
 *     `limits: {Bite: 1}`) or the legacy `{attacks: [{name, count}]}`
 *     object — else the one primary attack.
 *
 * @param {object} attacker — wrapper
 * @returns {object[]} PCs: weapon records (null = unarmed); monsters:
 *   attack records `{name, bonus, dice, damageType?, reachFt?, rangeFt?}`
 */
export function attackSequenceFor(attacker) {
  if (attacker?.kind === 'pc') {
    const weapon = attacker._chosenWeapon || attacker.weapon || null;
    const n = Math.min(4, attacksPerAction(attacker));
    return n === 1 ? [weapon] : new Array(n).fill(weapon);
  }
  const primary = attacker?.attack || { name: 'Strike', bonus: 2, dice: '1d6' };
  const raw = attacker?.multiattack;
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.attacks) ? raw.attacks : null);
  if (!list || list.length === 0) return [primary];
  const pool = Array.isArray(attacker.attacks) && attacker.attacks.length
    ? attacker.attacks
    : [primary, attacker.secondary].filter(Boolean);
  const out = [];
  const used = new Map();
  for (const entry of list) {
    const count = Math.max(1, Math.min(10, Math.trunc(Number(entry?.count) || 1)));
    const name = entry?.action ?? entry?.name ?? null;
    for (let i = 0; i < count && out.length < 8; i++) {
      const rec = name != null
        ? (findAttack(pool, name) || primary)
        : anyAttack(pool, primary, entry?.kind, entry?.limits, used);
      used.set(lc(rec.name), (used.get(lc(rec.name)) || 0) + 1);
      out.push(rec);
    }
  }
  return out.length ? out : [primary];
}

function lc(s) { return String(s ?? '').toLowerCase(); }

function findAttack(pool, name) {
  const want = lc(name);
  return pool.find(a => lc(a?.name) === want) || null;
}

function isRangedRecord(rec) {
  if (Number.isFinite(rec?.rangeFt) && !Number.isFinite(rec?.reachFt)) return true;
  return isRangedWeapon({ name: rec?.name });
}

/** "Any weapon attack" multiattack entry: the first record of the kind whose limit is not reached. */
function anyAttack(pool, primary, kind, limits, used) {
  const ok = (a) => {
    if (!a) return false;
    if (kind === 'melee' && isRangedRecord(a)) return false;
    if (kind === 'ranged' && !isRangedRecord(a)) return false;
    const cap = limits ? Object.entries(limits).find(([n]) => lc(n) === lc(a.name)) : null;
    return !cap || (used.get(lc(a.name)) || 0) < Number(cap[1]);
  };
  return [primary, ...pool].find(ok) || primary;
}

/** Reach / range (ft) a swing can retarget within, without moving. */
function swingReachFt(attacker, weaponRef) {
  if (attacker.kind === 'pc') {
    if (isRangedWeapon(weaponRef)) {
      const r = Number(weaponRef?.range?.normal ?? weaponRef?.range);
      return Number.isFinite(r) && r > 0 ? r : 80;
    }
    return meleeReachFt(weaponRef);
  }
  if (Number.isFinite(weaponRef?.reachFt) && weaponRef.reachFt > 0) return weaponRef.reachFt;
  if (Number.isFinite(weaponRef?.rangeFt) && weaponRef.rangeFt > 0) return weaponRef.rangeFt;
  return isRangedWeapon({ name: weaponRef?.name }) ? 80 : meleeReachFt({ name: weaponRef?.name });
}

/** Does the swing stay on `target`? Standing creatures always; a dying PC
 *  only when an explicit plan chose it while it was already down (R9). */
function keepsTarget(turn, target) {
  if (!target) return false;
  if (isAlive(target)) return true;
  return target === turn.dyingTarget && isDying(target);
}

/** M64 R9 — can an attack or spell still land on `t`? Standing creatures,
 *  or a PC that was already dying when the attack began (`wasDying`): a
 *  creature that drops mid-resolution (an earlier hit, a DM edit during a
 *  prompt) is not hit again by the same attack. */
function canHit(t, wasDying = true) {
  return isAlive(t) || (wasDying && isDying(t));
}

/**
 * The nearest standing hostile the attacker can reach with `weaponRef`
 * from where it stands (Extra Attack / Multiattack re-target, PHB p192:
 * the attacks may go to different targets). Null when none is in reach.
 */
function retargetFor(turn, weaponRef) {
  const { attacker, targetable } = turn;
  const from = attacker._position || attacker.position;
  if (!from) return null;
  const reach = swingReachFt(attacker, weaponRef);
  let best = null;
  let bestD = Infinity;
  for (const e of targetable) {
    if (!isAlive(e)) continue;
    const p = e._position || e.position;
    if (!p) continue;
    const d = chebyshevFeet(from, p);
    if (d <= reach && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

/**
 * One Attack action: every swing of attackSequenceFor, re-targeting the
 * nearest standing hostile in reach when the current target drops. All
 * swings share one cinema group; swing k ≥ 2 gets exchangeId
 * `<group>.s<k>` (swing 1 keeps the group id, as before R10).
 * @returns {Promise<{status: 'rejected'|'done', target: object|null, weaponRef: object|null}>}
 */
async function runAttackAction(turn, firstTarget, firstAction) {
  const { attacker } = turn;
  const sequence = attackSequenceFor(attacker);
  const shared = { group: null, smiteDone: false };
  let target = firstTarget;
  let weaponRef = sequence[0] ?? null;
  for (let i = 0; i < sequence.length; i++) {
    weaponRef = sequence[i];
    if (!isAlive(attacker)) break;
    if (i > 0 && !keepsTarget(turn, target)) {
      target = retargetFor(turn, weaponRef);
      if (!target) break;
    }
    const status = await runWeaponSwing(turn, target, weaponRef, i, shared, firstAction);
    if (status === 'rejected') return { status, target, weaponRef, shared, swings: i };
    if (status === 'blocked') break;
  }
  return { status: 'done', target, weaponRef, shared, swings: sequence.length };
}

/**
 * One weapon swing (resolver → roll → Shield → damage → riders → cinema).
 * @returns {Promise<'rejected'|'blocked'|'done'>}
 */
async function runWeaponSwing(turn, target, weaponRef, index, shared, firstAction, opts = {}) {
  const { attacker, enemies, allies, scene, rng, prompts, ctx, plan, explicit, charmers, actorId } = turn;
  const wasDying = isDying(target);
  // Build the resolver context. PCs use deriveWeaponAttack; monsters
  // use the swing's attack record. M42 weapon-switch is honored via
  // attacker._chosenWeapon (set by the planner).
  let attackStats;
  let sneakDice = 0;
  let monsterAttack = null;
  let rerollBelow = 0;
  if (attacker.kind === 'pc') {
    const chosen = weaponRef;
    const a = deriveWeaponAttack(attacker.ref, chosen);
    attackStats = {
      bonus: a.bonus, dice: a.dice, damageType: a.damageType,
      parts: [{ source: chosen?.name || 'Attack', value: a.bonus }],
      damageParts: []
    };
    // M64 phase 1.5 — Fighting Styles (Archery, Dueling, Great Weapon
    // Fighting) and the off-hand attack's damage (Two-Weapon Fighting).
    const style = swingStyleMods(attacker.ref, chosen, a);
    if (style.attackBonus) {
      attackStats.bonus += style.attackBonus;
      attackStats.parts.push(...style.parts.filter(p => p.source === 'Archery'));
    }
    if (style.damageBonus) attackStats.damageParts.push(...style.parts.filter(p => p.source !== 'Archery'));
    rerollBelow = style.rerollBelow;
    if (opts.offhand) attackStats.dice = offhandDice(a.dice, attacker.ref?.abilityModifiers?.[a.ability] ?? 0, attacker.ref);
    // M64 phase 1.5 — Rage: +2/+3/+4 on STR melee weapon attacks.
    if (isRaging(attacker) && !a.ranged && a.ability === 'STR') {
      attackStats.damageParts.push({ source: 'Rage', value: rageDamageBonus(attacker) });
    }
    // M42 — Sneak Attack (once per turn: the first swing). M64 R1 — the
    // extra dice are appended AFTER the resolver (below) so its flat
    // combatMods damage fold still sees a single-term spec.
    if (!turn.sneakDone && plan?.featuresFired?.includes('sneak-attack')) {
      turn.sneakDone = true;
      const lvl = (attacker.ref.classes || []).find(c => /rogue/i.test(c.name))?.level || 1;
      sneakDice = Math.max(1, Math.ceil(lvl / 2));
      PC_FEATURES['sneak-attack'].consume(attacker);
      emitEvent(ctx, 'feature.used', { entityId: actorId, featureId: 'sneak-attack' });
    }
    // M42.1 — Reckless Attack (decided on the first attack of the turn;
    // advantage then lasts for every STR melee swing this turn).
    if (!turn.recklessDone && plan?.featuresFired?.includes('reckless-attack')) {
      turn.recklessDone = true;
      PC_FEATURES['reckless-attack'].consume(attacker);
      emitEvent(ctx, 'feature.used', { entityId: actorId, featureId: 'reckless-attack' });
    }
  } else {
    monsterAttack = weaponRef || attacker.attack;
    attackStats = {
      bonus: monsterAttack.bonus, dice: monsterAttack.dice,
      damageType: monsterAttack.damageType ?? null,
      parts: [{ source: monsterAttack.name, value: monsterAttack.bonus }],
      damageParts: []
    };
  }

  const attackerForResolver = {
    ...attacker.ref,
    conditions: attacker.conditions,
    _position: attacker._position || attacker.position,
    combatMods: attacker.combatMods || attacker.ref?.combatMods || []
  };
  const targetForResolver = {
    ...target.ref,
    conditions: target.conditions,
    _position: target._position || target.position
  };
  const { allies: allyList, hostiles: hostileList } = factionLists({
    attackerKind: attacker.kind,
    attackerId: attacker.id,
    party: attacker.kind === 'pc'
      ? allies.map(p => ({ ...p.ref, _position: p._position, conditions: p.conditions, id: p.id, name: p.name }))
      : enemies.map(p => ({ ...p.ref, _position: p._position, conditions: p.conditions, id: p.id, name: p.name })),
    monsters: attacker.kind === 'pc'
      ? enemies.map(m => ({ ...m.ref, position: m.position, conditions: m.conditions, id: m.id, name: m.name }))
      : allies.map(m => ({ ...m.ref, position: m.position, conditions: m.conditions, id: m.id, name: m.name }))
  });

  // M42.1 — Reckless Attack overrides advantage on the barb's swing.
  let advantageOverride = 'auto';
  if (attacker.kind === 'pc' && attacker._recklessUntilNextTurn) {
    advantageOverride = 'advantage';
  } else if (attacker.kind === 'monster' && target?._recklessUntilNextTurn) {
    advantageOverride = 'advantage';
  }
  const weaponUsed = attacker.kind === 'pc' ? weaponRef : { name: monsterAttack.name };
  const verdict = resolveAttack({
    attacker: attackerForResolver,
    target: targetForResolver,
    weapon: weaponUsed,
    scene,
    attackerKind: attacker.kind,
    targetKind: target.kind,
    targetAC: target.ac,
    advantageOverride,
    allies: allyList,
    hostiles: hostileList,
    attackStats,
    charmerIds: charmers,
    targetId: target.id,
    coverEntities: scene?.terrain ? [...allies, ...enemies] : null
  });

  if (verdict.autoMiss) {
    if (explicit && index === 0 && firstAction) {
      emitEvent(ctx, 'turn.rejected', {
        actorId, code: 'blocked', reason: (verdict.blockers || []).join('; ') || 'attack not possible'
      });
      return 'rejected';
    }
    return 'blocked';
  }

  if (shared.group === null) shared.group = nextCinemaGroup(ctx);
  const group = shared.group;
  const exchangeId = index === 0 || group === null ? group : `${group}.s${index + 1}`;
  const targetHpBefore = target.hp;
  const finalBonus = verdict.attackBonus.total;
  const finalDmgDice = sneakDice > 0
    ? `${verdict.damage.dice}+${sneakDice}d6`
    : verdict.damage.dice;
  let atk;
  if (verdict.autoCrit) {
    atk = { hit: true, crit: true, total: 20 + finalBonus };
  } else {
    atk = rollAttack({ bonus: finalBonus, advantage: dodgeMode(verdict.d20.mode, target), targetAC: verdict.targetAC }, rng);
    if (prompts.onRoll) atk = await reviewRoll(prompts, ctx, group, 'attack', attacker, target, atk);
  }
  // M33.1 — Shield reaction (target casts AFTER the roll lands).
  // M64 N1 — offered only when Shield could block it; answer gated.
  if (await askShield(target, atk, { weapon: weaponUsed }, prompts, ctx, group)) {
    spendShield(target, ctx, group);
    atk.hit = false;
    atk.shielded = true;
  }
  emitAttackRolled(ctx, group, attacker, target, atk, { weapon: weaponUsed?.name ?? null, isReaction: false, mode: verdict.d20.mode, bonus: finalBonus });
  // Attacking a hostile keeps a rage going.
  if (attacker._rageSustained === false && isRaging(attacker)) attacker._rageSustained = true;
  // M64 T6 — re-check after the Shield await (a DM edit can land there).
  if (!isAlive(attacker) || !canHit(target, wasDying)) return 'blocked';
  const modifiers = {
    sneak: sneakDice > 0,
    reckless: !!plan?.featuresFired?.includes('reckless-attack'),
    surge: !!plan?.featuresFired?.includes('action-surge'),
    smiteSlot: null
  };
  const cinemaInfo = { reaction: false, cast: false, targetHpBefore, modifiers, exchangeId, attackRecord: monsterAttack, weaponRef };
  if (!atk.hit) {
    // Dispatch a cinema round for the miss too — the live runner uses
    // this to dramatize the swing even when no damage lands.
    await dispatchCinema(prompts, ctx, group, {
      attacker, defender: target, plan, atk, dmg: 0, crit: false, miss: true
    }, cinemaInfo);
    return 'done';
  }
  let dmg = rollDamage(finalDmgDice, rerollBelow ? { crit: atk.crit, rerollBelow } : { crit: atk.crit }, rng);
  if (prompts.onRoll) {
    dmg = await reviewRoll(prompts, ctx, group, 'damage', attacker, target, dmg);
    if (!isAlive(attacker) || !canHit(target, wasDying)) return 'blocked';
  }
  // M64 R8 — one damage path. With a smite following, the concentration
  // save waits for the smite so the hit forces ONE save on its total.
  // Divine Smite rides the first hit of the action (one slot per action).
  const smiting = attacker.kind === 'pc' && !shared.smiteDone && !!plan?.featuresFired?.includes('divine-smite') &&
    (index === 0 || PC_FEATURES['divine-smite'].available(attacker));
  const weaponHit = applyDamage(target, dmg.total, verdict.damage.damageType ?? null, {
    crit: !!atk.crit, attacker, ctx, rng, group, roster: [...allies, ...enemies],
    parts: { weapon: dmg.total, ...(sneakDice > 0 ? { sneakDice } : {}) },
    checkConcentration: !smiting
  });

  // M42.1 — Divine Smite
  let smiteTotal = 0;
  if (smiting) {
    shared.smiteDone = true;
    PC_FEATURES['divine-smite'].consume(attacker, rng);
    const slotLevel = attacker._smiteSlotUsed || 1;
    modifiers.smiteSlot = slotLevel;
    emitEvent(ctx, 'feature.used', { entityId: actorId, featureId: 'divine-smite' }, group);
    if (attacker._smiteSlotUsed) {
      emitEvent(ctx, 'resource.spent', { entityId: actorId, resource: 'spell-slot', level: attacker._smiteSlotUsed }, group);
    }
    let smiteDice = Math.min(5, 2 + (slotLevel - 1));
    const tType = String(target?.ref?.race?.name || target?.presetSlug || '').toLowerCase();
    if (/fiend|devil|demon|undead|zombie|skeleton|vampire|ghoul/.test(tType)) smiteDice += 1;
    let smiteRoll = rollDamage(`${smiteDice}d8`, { crit: atk.crit }, rng);
    if (prompts.onRoll) smiteRoll = await reviewRoll(prompts, ctx, group, 'damage', attacker, target, smiteRoll);
    const smiteHit = applyDamage(target, smiteRoll.total, 'Radiant', {
      crit: !!atk.crit, attacker, ctx, rng, group, roster: [...allies, ...enemies],
      parts: { smite: smiteRoll.total }, checkConcentration: false
    });
    smiteTotal = smiteRoll.total;
    concentrationCheck(target, weaponHit.amount + smiteHit.amount, rng, ctx, group, [...allies, ...enemies]);
  }

  // M45 Phase 4b — Dramatize the resolved exchange.
  await dispatchCinema(prompts, ctx, group, {
    attacker, defender: target, plan, atk,
    dmg: dmg.total + smiteTotal, crit: !!atk.crit, miss: false
  }, { ...cinemaInfo, smiteTotal, damageType: verdict.damage.damageType ?? null });
  return 'done';
}

// =====================================================================
// runMonsterSpell — spell casting (both monster + PC)
// =====================================================================

export async function runMonsterSpell({ attacker, target, plan, scene, rng, witnesses = [], allEnemies = [], allies = [], prompts = {}, ctx = NO_CTX }) {
  const baseSpell = spellById(plan.spellId);
  if (!baseSpell) return;
  // M64 phase 1.5 — a feat / race / item spell with its own uses (Fey
  // Touched Misty Step) spends `resources.features['spell:<id>']`, not a
  // slot, and is cast at its own level.
  const grant = attacker.kind === 'pc' && baseSpell.level > 0 && !plan.isInnate
    ? grantedSpellEntry(attacker.ref, String(plan.spellId)) : null;
  const useKey = grant ? spellUseKey(String(plan.spellId)) : null;
  if (grant) {
    ensureUseLedger(attacker, useKey, grant);
    if (usesLeft(attacker, useKey) <= 0) {
      emitEvent(ctx, 'turn.rejected', { actorId: idOf(attacker), code: 'no-uses', reason: `${baseSpell.name} has no uses left` });
      return;
    }
  }
  let spell = grant ? baseSpell : applyUpcast(baseSpell, plan.castAtLevel);
  // M64 phase 1.5 — PC cantrips scale with character level (5 / 11 / 17).
  if (attacker.kind === 'pc' && baseSpell.level === 0 && !plan.isInnate) {
    spell = scaleCantrip(spell, totalLevel(attacker.ref || attacker), ownSpellEntry(attacker.ref, String(plan.spellId)));
  }
  const book = attacker.kind === 'monster' ? spellbookFor(attacker.presetSlug) : null;
  const innateBook = !book && attacker._innate
    ? { dc: 12, attackBonus: 4, abilityMod: 3 }
    : null;
  const pcBook = !book && !innateBook && attacker.kind === 'pc'
    ? pcSpellBook(attacker, baseSpell) : null;
  const effectiveBook = book || innateBook || pcBook;
  if (!effectiveBook) return;
  const casterId = idOf(attacker);
  const group = nextCinemaGroup(ctx);
  const wasDying = isDying(target);

  const roster = [...allies, ...allEnemies];
  // M64 phase 1.5 — with a terrain layer, a single target behind total
  // cover cannot be targeted (PHB p196); refused before anything is spent.
  if (scene?.terrain && target && !spell.aoe && spell.kind !== 'heal' && target !== attacker &&
      coverBetweenWrappers(scene, roster, attacker, target) === 'total') {
    emitEvent(ctx, 'turn.rejected', { actorId: casterId, code: 'no-line', reason: `${target.name || idOf(target)} has total cover` });
    return;
  }
  // M64 phase 1.5 wave 6 — Misty Step: the destination is checked before
  // anything is spent.
  let teleport = null;
  if (spell.kind === 'teleport') {
    teleport = teleportDestination(attacker, plan.moveTo, spell.teleportFt || 30, scene, roster, allEnemies);
    if (teleport.error) {
      emitEvent(ctx, 'turn.rejected', { actorId: casterId, code: 'bad-move', reason: teleport.error });
      return;
    }
  }
  if (spell.concentration && isConcentrating(attacker)) {
    endConcentration(attacker, 'recast', ctx, group, roster);
  }

  let slotSpent = null;
  if (grant) {
    spendUse(attacker, useKey);
    emitEvent(ctx, 'resource.spent', { entityId: casterId, resource: `feature:${useKey}`, level: null }, group);
  } else if (plan.isInnate) {
    if (!attacker._innate) attacker._innate = freshInnateState(attacker.presetSlug);
    consumeInnate(attacker, plan.spellId);
    emitEvent(ctx, 'resource.spent', { entityId: casterId, resource: `innate:${plan.spellId}`, level: null }, group);
  } else {
    const lvl = baseSpell.level > 0 ? Math.max(baseSpell.level, plan.castAtLevel || baseSpell.level) : 0;
    const had = lvl > 0 ? (attacker._slots?.[lvl] ?? 0) : 0;
    consumeSlot(attacker._slots, baseSpell, plan.castAtLevel);
    if (lvl > 0 && had > 0) {
      slotSpent = lvl;
      emitEvent(ctx, 'resource.spent', { entityId: casterId, resource: 'spell-slot', level: lvl }, group);
    }
  }
  emitEvent(ctx, 'spell.cast', {
    casterId, spellId: String(plan.spellId),
    castAtLevel: grant ? baseSpell.level : Math.max(spell.level || 0, plan.castAtLevel || 0),
    slotSpent, innate: !!plan.isInnate,
    targetIds: target ? [idOf(target)] : []
  }, group);

  // M45 Phase 4b — Cast announcement (live runner logs the cast and
  // paints the spell-cast cinema motion before resolution lands).
  if (prompts.onCastBegin) {
    await prompts.onCastBegin({ attacker, target, plan, spell });
    // M64 T6 — re-check after the await: a dead caster's spell is lost;
    // a dropped single target wastes it (heals may still land on 0 HP).
    if (!isAlive(attacker)) return;
    if (!spell.aoe && spell.kind !== 'heal' && !canHit(target, wasDying)) return;
  }

  // M34.1 — Counterspell witness loop.
  for (const witness of witnesses) {
    // M64 N1 — only eligible witnesses are asked, and a `true` answer is
    // re-checked after the await.
    if (!canCastCounterspell(witness)) continue;
    const auto = shouldCounterspell(witness, spell.level);
    const witnessId = idOf(witness);
    emitEvent(ctx, 'reaction.offered', offeredPayload(ctx, witnessId, 'counterspell', auto, { casterId, spellId: String(plan.spellId) }), group);
    const { answer, by } = normalizeAnswer(prompts.onCounterspell
      ? await prompts.onCounterspell({ witness, caster: attacker, spell, autoAnswer: auto })
      : auto, !!prompts.onCounterspell);
    // M64 T6 — re-checked after the await, including both creatures' HP.
    const used = answer && canCastCounterspell(witness) && isAlive(witness) && isAlive(attacker);
    emitEvent(ctx, 'reaction.resolved', { reactorId: witnessId, kind: 'counterspell', used, by }, group);
    if (!used) continue;
    const ability = abilityModFor(witness, abilityForCounterer(witness));
    const result = resolveCounterspell({ spellLevel: spell.level, counterMod: ability }, rng);
    const lvl = consumeCounterspell(witness);
    emitEvent(ctx, 'resource.spent', { entityId: witnessId, resource: 'reaction', level: null }, group);
    if (lvl) emitEvent(ctx, 'resource.spent', { entityId: witnessId, resource: 'spell-slot', level: lvl }, group);
    if (result.countered) {
      emitEvent(ctx, 'spell.countered', {
        casterId, counterId: witnessId,
        check: result.mode === 'check' ? { d20: result.d20, total: result.total, dc: result.dc } : null
      }, group);
      emitEvent(ctx, 'spell.fizzled', { casterId, reason: 'counterspell', spellId: String(plan.spellId) }, group);
      return;
    }
    break;
  }

  // M56 Phase 2 — Every resolved cast dramatizes through the same
  // onCinemaRound prompt as weapon swings, tagged `cast: true` with a
  // per-kind `outcome` payload. Shield-negated casts dispatch no cinema
  // (M64 T4: they emit spell.fizzled instead).
  const castCinema = (defender, outcome, extra = {}) => dispatchCinema(prompts, ctx, group, {
    attacker, defender, plan, spell, cast: true, outcome
  }, { reaction: false, cast: true, targetHpBefore: extra.hpBefore ?? defender?.hp, spell, outcome, effects: extra.effects, exchangeId: extra.exchangeId });

  if (teleport) {
    const at = attacker._position || attacker.position;
    const from = { col: at.col, row: at.row };
    const to = { col: teleport.cell.col, row: teleport.cell.row };
    if (attacker.kind === 'pc') attacker._position = to;
    else attacker.position = to;
    emitEvent(ctx, 'move', { actorId: casterId, from, to, path: [from, to], teleport: true }, group);
    if (typeof prompts.onMove === 'function') {
      await prompts.onMove({ mover: attacker, from, to, path: [from, to], teleport: true });
    }
    return;
  }

  if (spell.kind === 'heal') {
    const dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
    const mod = spell.addsAbilityMod ? (effectiveBook.abilityMod || 0) : 0;
    const heal = dmgRoll.total + mod;
    if (target?.hpMax > 0) {
      const healed = applyHealing(target, heal, { ctx, source: attacker, group });
      await castCinema(target, { heal }, { hpBefore: healed.hpBefore });
    }
    return;
  }

  if (spell.kind === 'auto-hit') {
    // Shield (PHB p275) blocks Magic Missile outright. M64 N1 — routed
    // through onShieldReaction like every other Shield window.
    const mmAtk = { hit: true, crit: false, total: null, autoHit: true };
    if (await askShield(target, mmAtk, { weapon: null, spell }, prompts, ctx, group)) {
      spendShield(target, ctx, group);
      emitEvent(ctx, 'spell.fizzled', { casterId, reason: 'shield', spellId: String(plan.spellId), targetId: idOf(target) }, group);
      return;
    }
    if (!isAlive(attacker) || !canHit(target, wasDying)) return;
    const darts = spell.darts || 1;
    let totalDmg = 0;
    for (let i = 0; i < darts; i++) {
      const r = rollDamage(spell.perDart, { crit: false }, rng);
      totalDmg += r.total;
    }
    if (prompts.onRoll) {
      totalDmg = (await reviewRoll(prompts, ctx, group, 'damage', attacker, target, { total: totalDmg, spec: `${darts}x${spell.perDart}`, crit: false })).total;
      if (!isAlive(attacker) || !canHit(target, wasDying)) return;
    }
    const before = target.hp;
    applyDamage(target, totalDmg, spell.damageType ?? null, { attacker, ctx, rng, group, parts: { darts }, roster });
    await castCinema(target, { dmg: totalDmg, darts }, { hpBefore: before });
    return;
  }

  if (spell.kind === 'spell-attack') {
    // M64 phase 1.5 — Eldritch Blast style cantrips fire `spell.beams`
    // attacks (cantrip-scaling.js); each beam is its own roll, sharing the
    // cast's cinema group (beam k >= 2: exchangeId `<group>.s<k>`).
    const beam = async (t, k) => {
      const exchangeId = k === 0 || group === null ? group : `${group}.s${k + 1}`;
      // M64 R12 — spell attacks go through resolveAttack: conditions,
      // prone (melee vs ranged spell attack), a ranged caster next to a
      // hostile, auto-crits. The book's bonus already folds the 'spell'
      // attack combatMods, so only damage mods reach the resolver.
      const verdict = resolveAttack({
        attacker: {
          ...attacker.ref,
          conditions: attacker.conditions,
          _position: attacker._position || attacker.position,
          combatMods: combatModsOf(attacker).filter(m => m?.kind === 'damage')
        },
        target: { ...t.ref, conditions: t.conditions, _position: t._position || t.position },
        weapon: null,
        spell,
        scene,
        attackerKind: attacker.kind,
        targetKind: t.kind,
        targetAC: t.ac,
        advantageOverride: 'auto',
        allies: allies.filter(a => a !== attacker && isAlive(a)).map(a => ({ ...a.ref, _position: a._position || a.position, conditions: a.conditions, id: a.id, name: a.name })),
        hostiles: allEnemies.filter(isAlive).map(e => ({ ...e.ref, _position: e._position || e.position, conditions: e.conditions, id: e.id, name: e.name })),
        attackStats: {
          bonus: effectiveBook.attackBonus, dice: spell.dice, damageType: spell.damageType ?? null,
          parts: [{ source: spell.name, value: effectiveBook.attackBonus }], damageParts: []
        },
        charmerIds: charmerIds(attacker),
        targetId: t.id,
        coverEntities: scene?.terrain ? roster : null
      });
      if (verdict.autoMiss) {
        await castCinema(t, { dmg: 0, miss: true }, { exchangeId });
        return true;
      }
      const mode = verdict.d20.mode;
      let atk = verdict.autoCrit
        ? { hit: true, crit: true, total: 20 + verdict.attackBonus.total }
        : rollAttack({ bonus: verdict.attackBonus.total, advantage: dodgeMode(mode, t), targetAC: verdict.targetAC }, rng);
      if (prompts.onRoll) atk = await reviewRoll(prompts, ctx, group, 'attack', attacker, t, atk);
      if (await askShield(t, atk, { weapon: null, spell }, prompts, ctx, group)) {
        spendShield(t, ctx, group);
        atk.hit = false;
        atk.shielded = true;
        emitAttackRolled(ctx, group, attacker, t, atk, { weapon: null, isReaction: false, mode, bonus: verdict.attackBonus.total, spellId: String(plan.spellId) });
        emitEvent(ctx, 'spell.fizzled', { casterId, reason: 'shield', spellId: String(plan.spellId), targetId: idOf(t) }, group);
        return true;
      }
      emitAttackRolled(ctx, group, attacker, t, atk, { weapon: null, isReaction: false, mode, bonus: verdict.attackBonus.total, spellId: String(plan.spellId) });
      if (!isAlive(attacker) || !canHit(t, wasDying)) return false;
      if (!atk.hit) {
        await castCinema(t, { dmg: 0, miss: true }, { exchangeId });
        return true;
      }
      let dmg = rollDamage(verdict.damage.dice || spell.dice, { crit: atk.crit }, rng);
      if (prompts.onRoll) {
        dmg = await reviewRoll(prompts, ctx, group, 'damage', attacker, t, dmg);
        if (!isAlive(attacker) || !canHit(t, wasDying)) return false;
      }
      const before = t.hp;
      applyDamage(t, dmg.total, spell.damageType ?? null, { crit: !!atk.crit, attacker, ctx, rng, group, roster });
      await castCinema(t, { dmg: dmg.total, crit: !!atk.crit }, { hpBefore: before, exchangeId });
      return true;
    };
    const beams = Math.max(1, Math.min(4, Math.trunc(Number(spell.beams) || 1)));
    let t = target;
    for (let k = 0; k < beams; k++) {
      if (k > 0 && !isAlive(t)) {
        t = nearestInRange(attacker, allEnemies, spell.range || 5);
        if (!t) break;
      }
      if (!(await beam(t, k))) break;
    }
    return;
  }

  // AoE save
  if (spell.aoe && allEnemies.length > 0) {
    const center = attacker._position || attacker.position;
    if (center) {
      let totalDmg = 0;
      const aoeResults = [];
      for (const e of allEnemies) {
        // M64 R9 — an AoE also catches dying PCs (a failed death save each).
        if (!canHit(e)) continue;
        const ep = e._position || e.position;
        if (!ep) continue;
        if (chebyshevFeet(center, ep) > (spell.range || 15)) continue;
        // M64 phase 1.5 — cover from the effect's origin: +2 / +5 to a
        // DEX save; total cover shields the creature entirely.
        const eCover = scene?.terrain ? coverBetweenWrappers(scene, roster, attacker, e) : 'none';
        if (eCover === 'total') continue;
        const eBonus = saveBonusFor(e, spell.saveStat) + coverSaveBonus(eCover, spell.saveStat);
        const eSave = rollSave({ bonus: eBonus, dc: effectiveBook.dc, advantage: saveModeFor(e, spell.saveStat) }, rng);
        emitSave(ctx, group, e, spell.saveStat, eSave, 'spell');
        const dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
        let dmg = dmgRoll.total;
        if (eSave.success) dmg = spell.saveOnHalf ? Math.floor(dmg / 2) : 0;
        const before = e.hp;
        applyDamage(e, dmg, spell.damageType ?? null, { attacker, ctx, rng, group, roster });
        totalDmg += dmg;
        aoeResults.push({ entity: e, dmg, saved: eSave.success, before });
      }
      // Frame the hardest-hit target; nobody in range → no dispatch.
      if (aoeResults.length > 0) {
        const framed = aoeResults.reduce((a, b) => (b.dmg > a.dmg ? b : a));
        await castCinema(framed.entity, {
          dmg: framed.dmg, saved: framed.saved,
          total: totalDmg, targets: aoeResults.length
        }, {
          hpBefore: framed.before,
          effects: aoeResults.map(r => ({ entityId: idOf(r.entity), hp: { before: r.before, after: r.entity.hp, max: r.entity.hpMax ?? r.before } }))
        });
      }
    }
    return;
  }

  // Save-based, single target
  const saveStat = spell.saveStat;
  const targetSaveBonus = saveBonusFor(target, saveStat) +
    (scene?.terrain ? coverSaveBonus(coverBetweenWrappers(scene, roster, attacker, target), saveStat) : 0);
  let save = rollSave({ bonus: targetSaveBonus, dc: effectiveBook.dc, advantage: saveModeFor(target, saveStat) }, rng);
  if (prompts.onRoll) save = await reviewRoll(prompts, ctx, group, 'save', target, attacker, save);
  emitSave(ctx, group, target, saveStat, save, 'spell');
  const before = target.hp;
  let saveDmg = 0;
  if (spell.dice) {
    let dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
    if (prompts.onRoll) dmgRoll = await reviewRoll(prompts, ctx, group, 'damage', attacker, target, dmgRoll);
    let dmg = dmgRoll.total;
    if (save.success) dmg = spell.saveOnHalf ? Math.floor(dmg / 2) : 0;
    applyDamage(target, dmg, spell.damageType ?? null, { attacker, ctx, rng, group, roster });
    saveDmg = dmg;
  }
  if (!save.success && spell.appliesCondition) {
    // M64 R7 — the registry declares how the condition ends
    // (conditionEndsOn) and its repeat save (conditionSave, at the
    // caster's DC).
    applyCondition(target, {
      id: spell.appliesCondition,
      sourceId: casterId,
      endsOn: spell.conditionEndsOn || (spell.concentration ? 'concentration' : 'encounter'),
      save: spell.conditionSave ? { stat: spell.conditionSave, dc: effectiveBook.dc } : null,
      appliedRound: Number.isInteger(ctx.round) ? ctx.round : null
    }, { ctx, group, roster });
    if (spell.concentration) {
      startConcentration(attacker, spell, [target.id]);
      emitEvent(ctx, 'concentration.started', { casterId, spellId: String(spell.id), targetIds: [idOf(target)] }, group);
    }
  }
  // Condition-only spells (dice: null) dispatch dmg 0 — the bridge
  // pins miss: false so a landed Hold Person never reads as a whiff.
  await castCinema(target, { dmg: saveDmg, saved: save.success }, { hpBefore: before });
}

// =====================================================================
// runReactionAttack — opportunity / reaction attacks
// =====================================================================

export async function runReactionAttack(attacker, target, targetBeforePos, scene, rng, prompts = {}, ctx = NO_CTX, opts = {}) {
  if (!attacker || !target) return;
  let attackStats;
  if (attacker.kind === 'pc') {
    const a = deriveWeaponAttack(attacker.ref, attacker.weapon);
    attackStats = {
      bonus: a.bonus, dice: a.dice, damageType: a.damageType,
      parts: [{ source: attacker.weapon?.name || 'Attack', value: a.bonus }],
      damageParts: []
    };
  } else {
    attackStats = {
      bonus: attacker.attack.bonus, dice: attacker.attack.dice,
      damageType: null,
      parts: [{ source: attacker.attack.name, value: attacker.attack.bonus }],
      damageParts: []
    };
  }
  const targetForResolver = {
    ...target.ref,
    conditions: target.conditions,
    _position: targetBeforePos
  };
  const attackerForResolver = {
    ...attacker.ref,
    conditions: attacker.conditions,
    _position: attacker._position || attacker.position,
    combatMods: attacker.combatMods || attacker.ref?.combatMods || []
  };
  const weaponUsed = attacker.kind === 'pc' ? attacker.weapon : { name: attacker.attack.name };
  const verdict = resolveAttack({
    attacker: attackerForResolver,
    target: targetForResolver,
    weapon: weaponUsed,
    scene,
    attackerKind: attacker.kind,
    targetKind: target.kind,
    targetAC: target.ac,
    advantageOverride: 'auto',
    allies: [], hostiles: [],
    attackStats,
    charmerIds: charmerIds(attacker),
    targetId: target.id,
    coverEntities: scene?.terrain ? (opts.roster || []) : null
  });
  if (verdict.autoMiss) return;
  const group = nextCinemaGroup(ctx);
  const targetHpBefore = target.hp;
  let atk = verdict.autoCrit
    ? { hit: true, crit: true, total: 20 + verdict.attackBonus.total }
    : rollAttack({ bonus: verdict.attackBonus.total, advantage: dodgeMode(verdict.d20.mode, target), targetAC: verdict.targetAC }, rng);
  if (prompts.onRoll && atk.d20) atk = await reviewRoll(prompts, ctx, group, 'attack', attacker, target, atk);
  if (await askShield(target, atk, { weapon: attacker.weapon }, prompts, ctx, group)) {
    spendShield(target, ctx, group);
    atk.hit = false;
    // M64 T4 — the OA path now flags a Shield-negated swing like the main
    // attack path (was DEFERRED.md "shielded OA flag").
    atk.shielded = true;
  }
  emitAttackRolled(ctx, group, attacker, target, atk, {
    weapon: weaponUsed?.name ?? null, isReaction: true, mode: verdict.d20.mode, bonus: verdict.attackBonus.total
  });
  if (!isAlive(attacker) || !isAlive(target)) return;
  // M56 Phase 4 — opportunity attacks dramatize through the same
  // onCinemaRound prompt, tagged reaction: true.
  if (!atk.hit) {
    await dispatchCinema(prompts, ctx, group, {
      attacker, defender: target, plan: null, atk,
      dmg: 0, crit: false, miss: true, reaction: true
    }, { reaction: true, cast: false, targetHpBefore });
    return;
  }
  let dmg = rollDamage(verdict.damage.dice, { crit: atk.crit }, rng);
  if (prompts.onRoll) {
    dmg = await reviewRoll(prompts, ctx, group, 'damage', attacker, target, dmg);
    if (!isAlive(attacker) || !isAlive(target)) return;
  }
  applyDamage(target, dmg.total, verdict.damage.damageType ?? null, {
    crit: !!atk.crit, attacker, ctx, rng, group, parts: { weapon: dmg.total }, roster: opts.roster ?? null
  });
  await dispatchCinema(prompts, ctx, group, {
    attacker, defender: target, plan: null, atk,
    dmg: dmg.total, crit: !!atk.crit, miss: false, reaction: true
  }, { reaction: true, cast: false, targetHpBefore, damageType: verdict.damage.damageType ?? null });
}

// =====================================================================
// Legendary actions (M41; M64 T7 — moved here from the simulator so the
// turn manager runs them in every caller: simulator, browser, server)
// =====================================================================

/**
 * Spend a legendary creature's remaining budget after an opposing turn
 * (PHB/MM: at the end of another creature's turn). Greedy: keeps picking
 * the best action the budget allows until it is spent or nothing has a
 * valid target. Shield windows go through the same gated prompt as every
 * other attack.
 *
 * @param {object} monster — legendary monster wrapper
 * @param {object[]} enemies — its opponents' wrappers
 * @param {object} scene
 * @param {function} rng
 * @param {EnginePrompts} [prompts] — reaction prompts only (no forcePlan)
 * @param {object} [ctx] — engine ctx ({ emit, turnId })
 * @returns {Promise<number>} actions spent
 */
export async function runLegendaryActions(monster, enemies, scene, rng, prompts = {}, ctx = NO_CTX) {
  let spent = 0;
  for (let safety = 0; safety < 4; safety++) {
    if (!isAlive(monster) || (monster._legendaryBudget ?? 0) <= 0) break;
    const pick = chooseLegendaryAction({ self: monster, enemies });
    if (!pick) break;
    const group = nextCinemaGroup(ctx);
    emitEvent(ctx, 'feature.used', { entityId: idOf(monster), featureId: `legendary:${pick.action.id}` }, group);
    await applyLegendaryAction(monster, pick, scene, rng, prompts || {}, ctx, group);
    spendLegendaryAction(monster, pick.action);
    emitEvent(ctx, 'resource.spent', { entityId: idOf(monster), resource: 'legendary', level: null, cost: pick.action.cost }, group);
    spent++;
  }
  return spent;
}

async function applyLegendaryAction(monster, pick, scene, rng, prompts, ctx, group) {
  const { action } = pick;
  if (action.kind === 'melee-attack') {
    const target = pick.target;
    if (!target || !isAlive(target)) return;
    let atk = rollAttack({ bonus: action.attackBonus, advantage: dodgeMode('normal', target), targetAC: target.ac }, rng);
    if (prompts.onRoll) atk = await reviewRoll(prompts, ctx, group, 'attack', monster, target, atk);
    // M33.1: Shield can still block a legendary melee attack.
    if (await askShield(target, atk, { weapon: { name: action.name } }, prompts, ctx, group)) {
      spendShield(target, ctx, group);
      atk.hit = false;
      atk.shielded = true;
    }
    emitAttackRolled(ctx, group, monster, target, atk, { weapon: action.name, isReaction: false, mode: 'normal', bonus: action.attackBonus });
    if (!atk.hit || !isAlive(monster) || !isAlive(target)) return;
    let dmg = rollDamage(action.dice, { crit: atk.crit }, rng);
    if (prompts.onRoll) {
      dmg = await reviewRoll(prompts, ctx, group, 'damage', monster, target, dmg);
      if (!isAlive(monster) || !isAlive(target)) return;
    }
    applyDamage(target, dmg.total, action.damageType ?? null, { crit: !!atk.crit, attacker: monster, ctx, rng, group });
    return;
  }
  if (action.kind === 'aoe-save') {
    const center = monster._position || monster.position;
    if (!center) return;
    for (const e of (pick.targets || [])) {
      if (!isAlive(e)) continue;
      const ep = e._position || e.position;
      if (!ep) continue;
      if (chebyshevFeet(center, ep) > action.range) continue;
      const eBonus = saveBonusFor(e, action.saveStat);
      const save = rollSave({ bonus: eBonus, dc: action.dc, advantage: saveModeFor(e, action.saveStat) }, rng);
      emitSave(ctx, group, e, action.saveStat, save, 'legendary');
      const dmgRoll = rollDamage(action.dice, { crit: false }, rng);
      let dmg = dmgRoll.total;
      if (save.success) dmg = Math.floor(dmg / 2);
      applyDamage(e, dmg, action.damageType ?? null, { attacker: monster, ctx, rng, group });
    }
  }
}

// =====================================================================
// Event helpers (M64 T4)
// =====================================================================

/**
 * M64 T8 — offer a resolved roll to `prompts.onRoll` (the DM hook). It
 * runs AFTER the rng draw, so an override never shifts the stream. An
 * attack override re-resolves through withD20 (hit/crit recomputed); a
 * save through withSaveD20; a damage override replaces the total. Any
 * change emits dm.override {kind: 'roll.<kind>'}.
 *
 * @param {EnginePrompts} prompts
 * @param {object} ctx
 * @param {string|null} group
 * @param {'attack'|'damage'|'save'} kind
 * @param {object} actor — attacker (for a save: the creature saving)
 * @param {object} other — target (for a save: the caster)
 * @param {object} result — rollAttack / rollDamage / rollSave result
 * @returns {Promise<object>} the result to use
 */
async function reviewRoll(prompts, ctx, group, kind, actor, other, result) {
  const out = await prompts.onRoll({ kind, actorId: idOf(actor), targetId: idOf(other), result });
  if (!out || out === result) return result;
  let next = result;
  if (kind === 'attack') {
    if (out.d20 && result.d20 && Number.isInteger(out.d20.kept) && out.d20.kept !== result.d20.kept) next = withD20(result, out.d20.kept);
    else if (typeof out.hit === 'boolean' && (out.hit !== result.hit || !!out.crit !== !!result.crit)) next = { ...result, hit: out.hit, crit: !!out.crit && out.hit };
  } else if (kind === 'save') {
    if (Number.isInteger(out.kept) && out.kept !== result.kept) next = withSaveD20(result, out.kept);
    else if (typeof out.success === 'boolean' && out.success !== result.success) next = { ...result, success: out.success, forced: true };
  } else if (Number.isFinite(out.total) && Math.trunc(out.total) !== result.total) {
    next = { ...result, total: Math.max(0, Math.trunc(out.total)), forced: true };
  }
  if (next !== result) {
    emitEvent(ctx, 'dm.override', {
      kind: `roll.${kind}`, entityId: idOf(actor),
      before: rollSummary(kind, result), after: rollSummary(kind, next)
    }, group);
  }
  return next;
}

function rollSummary(kind, r) {
  if (kind === 'attack') return { kept: r.d20?.kept ?? null, total: r.total ?? null, hit: !!r.hit, crit: !!r.crit };
  if (kind === 'save') return { kept: r.kept ?? null, total: r.total ?? null, success: !!r.success };
  return { total: r.total ?? 0 };
}

/**
 * M64 R13 — fold the target's Dodge into an attack's d20 mode: a dodging,
 * capable target imposes disadvantage (cancelling advantage, PHB p173).
 * @param {'normal'|'advantage'|'disadvantage'} mode
 * @param {object} target
 * @returns {'normal'|'advantage'|'disadvantage'}
 */
export function dodgeMode(mode, target) {
  if (!target?._dodging || isIncapacitated(target)) return mode;
  if (mode === 'advantage') return 'normal';
  return 'disadvantage';
}

/** JSON summary of a plan for dm.override before/after (ids only). */
function planSummary(plan) {
  if (!plan) return null;
  return {
    kind: String(plan.kind),
    targetId: plan.targetId != null ? String(plan.targetId) : null,
    targetSide: plan.targetSide ?? null,
    weapon: plan.weapon?.name ?? null,
    spellId: plan.spellId ?? null,
    castAtLevel: Number.isInteger(plan.castAtLevel) ? plan.castAtLevel : null,
    featuresFired: [...(plan.featuresFired || [])]
  };
}

function offeredPayload(ctx, reactorId, kind, autoAnswer, extra = {}) {
  return {
    reactorId, kind, autoAnswer: !!autoAnswer,
    deadlineMs: Number.isInteger(ctx.reactionDeadlineMs) ? ctx.reactionDeadlineMs : null,
    ...extra
  };
}

function emitAttackRolled(ctx, group, attacker, target, atk, { weapon, isReaction, mode, bonus, spellId }) {
  if (!canEmit(ctx)) return;
  const d20 = atk.d20 || { kept: 20, dice: [20], advantage: mode || 'normal' };
  emitEvent(ctx, 'attack.rolled', {
    attackerId: idOf(attacker), targetId: idOf(target),
    weapon: weapon ?? null,
    isReaction: !!isReaction,
    advantage: d20.advantage || mode || 'normal',
    d20: [...d20.dice],
    kept: d20.kept,
    bonus: Number.isFinite(atk.bonus) ? atk.bonus : (bonus ?? 0),
    total: Number.isFinite(atk.total) ? atk.total : d20.kept + (bonus ?? 0),
    ac: Number.isFinite(atk.ac) ? atk.ac : (target.ac ?? 0),
    hit: !!atk.hit,
    crit: !!atk.crit,
    shielded: !!atk.shielded,
    ...(atk.d20 ? {} : { autoCrit: true }),
    ...(spellId ? { spellId } : {})
  }, group);
}

function emitSave(ctx, group, entity, stat, save, reason) {
  if (!canEmit(ctx)) return;
  emitEvent(ctx, 'save.rolled', {
    entityId: idOf(entity), stat, dc: save.dc,
    d20: save.dice ? [...save.dice] : [save.d20],
    total: save.total, success: !!save.success, reason
  }, group);
}

function spendShield(target, ctx, group) {
  const lvl = consumeShield(target);
  const id = idOf(target);
  emitEvent(ctx, 'resource.spent', { entityId: id, resource: 'reaction', level: null }, group);
  if (lvl) emitEvent(ctx, 'resource.spent', { entityId: id, resource: 'spell-slot', level: lvl }, group);
}

/**
 * Emit the `exchange` event (the cinema spec, events v1.1) and await
 * onCinemaRound. The exchange carries ids and resolved numbers only;
 * `fxSeed` is a hash of the exchange id, never an rng draw. Style and
 * swing are seat state the engine does not own: `ctx.cinemaInputs({
 * attackerId, weapon })` may supply them (else null). `durationMs` is 0:
 * the engine cannot import the anim builders, so the server falls back
 * to its fixed pacing cap.
 */
async function dispatchCinema(prompts, ctx, group, roundPayload, info) {
  if (canEmit(ctx)) {
    const { attacker, defender, atk } = roundPayload;
    const effects = info.effects || (defender ? [{
      entityId: idOf(defender),
      hp: { before: info.targetHpBefore ?? defender.hp, after: defender.hp, max: defender.hpMax ?? defender.hp }
    }] : []);
    const weapon = info.cast ? null : cinemaWeapon(attacker, info.damageType, info);
    const exchangeId = info.exchangeId ?? group;
    const seat = typeof ctx.cinemaInputs === 'function'
      ? (ctx.cinemaInputs({ attackerId: idOf(attacker), weapon }) || {})
      : {};
    const mods = info.modifiers || {};
    const modifiers = [];
    if (mods.sneak) modifiers.push('sneak-attack');
    if (mods.reckless) modifiers.push('reckless-attack');
    if (mods.smiteSlot) modifiers.push('divine-smite');
    if (mods.surge) modifiers.push('action-surge');
    const spell = info.spell
      ? { id: String(info.spell.id), kind: String(info.spell.kind), aoe: !!info.spell.aoe, damageType: info.spell.damageType ?? null }
      : null;
    emitEvent(ctx, 'exchange', {
      exchangeId,
      attackerId: idOf(attacker),
      defenderId: idOf(defender),
      reaction: !!info.reaction,
      cast: !!info.cast,
      roll: atk && atk.total != null
        ? {
            ...(atk.d20 ? { d20: { dice: [...atk.d20.dice], kept: atk.d20.kept, mode: atk.d20.advantage } } : {}),
            bonus: atk.bonus ?? null, total: atk.total, ac: atk.ac ?? defender?.ac ?? null,
            hit: !!atk.hit, crit: !!atk.crit, shielded: !!atk.shielded
          }
        : null,
      damage: info.cast
        ? { total: info.outcome?.dmg ?? 0, heal: info.outcome?.heal ?? 0, smite: 0 }
        : { total: roundPayload.dmg | 0, smite: info.smiteTotal ?? 0, heal: 0, type: info.damageType ?? null, crit: !!roundPayload.crit },
      effects,
      miss: !!roundPayload.miss,
      cinema: {
        weapon,
        style: seat.style ?? null,
        swing: seat.swing ?? null,
        modifiers,
        smiteSlot: Number.isInteger(mods.smiteSlot) ? mods.smiteSlot : null,
        attackerLevel: attackerLevelOf(attacker),
        killing: !!defender && (info.targetHpBefore ?? 0) > 0 && defender.hp <= 0,
        spell,
        outcome: info.outcome ? { ...info.outcome } : null,
        fxSeed: fxSeedOf(exchangeId),
        durationMs: 0
      }
    }, group);
  }
  if (prompts.onCinemaRound) await prompts.onCinemaRound(roundPayload);
}

function cinemaWeapon(attacker, damageType, info = {}) {
  if (attacker?.kind === 'pc') {
    const w = info.weaponRef !== undefined ? info.weaponRef : (attacker._chosenWeapon || attacker.weapon || null);
    const name = w?.name || 'Unarmed Strike';
    const bonus = Number(w?.magicBonus ?? w?.bonus ?? 0);
    return {
      name,
      damageType: w?.damageType ?? damageType ?? null,
      magical: bonus > 0 || !!w?.magic || /\+\d/.test(name)
    };
  }
  const a = info.attackRecord || attacker?.attack || {};
  return { name: a.name || 'Strike', damageType: a.damageType ?? damageType ?? null, magical: false };
}

function attackerLevelOf(attacker) {
  if (attacker?.kind === 'pc') return Math.max(0, Math.min(30, totalLevel(attacker.ref || attacker)));
  const cr = Number(attacker?.cr ?? attacker?.ref?.cr ?? 0);
  return Number.isFinite(cr) ? Math.max(0, Math.min(30, Math.round(cr))) : 0;
}

async function askReactionAttack(triggerer, mover, trigger, prompts, ctx) {
  const reactorId = idOf(triggerer);
  emitEvent(ctx, 'reaction.offered', offeredPayload(ctx, reactorId, 'oa', true, { trigger, moverId: idOf(mover) }));
  // Default (simulator path) is "always fire the OA"; the live runner
  // can return false to skip when the player declines.
  const { answer, by } = normalizeAnswer(prompts.onReactionAttack
    ? await prompts.onReactionAttack({ triggerer, mover, kind: trigger, autoAnswer: true })
    : true, !!prompts.onReactionAttack);
  // M64 N1 — gate the answer: the triggerer must still have its reaction.
  // M64 T6 — and both creatures must still be standing after the await.
  const used = answer && hasReactionAvailable(triggerer) && isAlive(triggerer) && isAlive(mover);
  emitEvent(ctx, 'reaction.resolved', { reactorId, kind: 'oa', used, by });
  return used;
}

// =====================================================================
// Reaction gating (M64 N1)
// =====================================================================

/**
 * Could Shield turn this attack into a miss right now? True only for a
 * non-crit hit on a PC that can cast Shield (reaction + spell + slot),
 * where +5 AC beats the attack total. Auto-hit spells (Magic Missile,
 * `atk.autoHit`) skip the AC test: Shield blocks them outright.
 *
 * @param {object} defender — entity wrapper
 * @param {object} atk — { hit, crit, total, autoHit? }
 * @returns {boolean}
 */
export function shieldCanBlock(defender, atk) {
  if (!defender || defender.kind !== 'pc' || !atk) return false;
  if (!atk.hit || atk.crit) return false;
  if (!canCastShield(defender)) return false;
  if (atk.autoHit) return true;
  // M64 phase 1.5 — the AC the roll was made against (cover included).
  return atk.total < (Number.isFinite(atk.ac) ? atk.ac : defender.ac) + 5;
}

/**
 * Offer the Shield window and return whether Shield should be applied.
 * The prompt is skipped when Shield could not help; a `true` answer is
 * re-checked with shieldCanBlock after the await, so an ineligible
 * defender never gets a free Shield whatever the prompt returns.
 * Without `prompts.onShieldReaction` the heuristic answers (simulator).
 *
 * @param {object} defender
 * @param {object} atk
 * @param {{ weapon: object|null, spell?: object }} ctx
 * @param {object} prompts — EnginePrompts
 * @returns {Promise<boolean>}
 */
async function askShield(defender, atk, info, prompts, ctx = NO_CTX, group = null) {
  if (!shieldCanBlock(defender, atk)) return false;
  const auto = atk.autoHit
    ? true
    : shouldCastShield({ target: defender, attackerTotal: atk.total, targetAc: Number.isFinite(atk.ac) ? atk.ac : defender.ac });
  const reactorId = idOf(defender);
  emitEvent(ctx, 'reaction.offered', offeredPayload(ctx, reactorId, 'shield', auto, { attackTotal: atk.total ?? null }), group);
  const { answer, by } = normalizeAnswer(prompts.onShieldReaction
    ? await prompts.onShieldReaction({ defender, atk, ...info, autoAnswer: auto })
    : auto, !!prompts.onShieldReaction);
  const used = answer && shieldCanBlock(defender, atk) && isAlive(defender);
  emitEvent(ctx, 'reaction.resolved', { reactorId, kind: 'shield', used, by }, group);
  return used;
}

// =====================================================================
// Shared helpers (exported so simulator's legendary path can reuse them)
// =====================================================================

// =====================================================================
// M64 R8 — the one damage path and the one healing path
// =====================================================================

/**
 * Lower-cased damage-type list from an entity's `resistances` /
 * `immunities` / `vulnerabilities` (the wrapper's own array, else the
 * sheet's / stat block's). Entries may be strings ('fire') or DDB-style
 * modifier objects ({ subType | type | damageType | friendlySubtypeName }).
 * @param {object} entity — wrapper
 * @param {'resistances'|'immunities'|'vulnerabilities'} key
 * @returns {string[]}
 */
export function damageTypeList(entity, key) {
  const raw = Array.isArray(entity?.[key]) ? entity[key]
    : Array.isArray(entity?.ref?.[key]) ? entity.ref[key]
      : [];
  const out = [];
  for (const r of raw) {
    const v = typeof r === 'string' ? r : (r?.subType ?? r?.type ?? r?.damageType ?? r?.friendlySubtypeName);
    if (typeof v === 'string' && v) out.push(v.toLowerCase().replace(/\s*damage$/, '').trim());
  }
  return out;
}

/**
 * Apply immunity / resistance / vulnerability to one damage amount
 * (PHB p197: resistance, then vulnerability; immunity zeroes it).
 * @param {object} target — wrapper
 * @param {number} amount — non-negative integer
 * @param {string|null} type — damage type ('Fire', 'slashing', …); null skips R/I/V
 * @returns {{amount: number, modifier: 'immune'|'resistant'|'vulnerable'|'resistant+vulnerable'|null}}
 */
export function applyDamageModifiers(target, amount, type) {
  if (!type || amount <= 0) return { amount, modifier: null };
  const t = String(type).toLowerCase();
  if (damageTypeList(target, 'immunities').includes(t)) return { amount: 0, modifier: 'immune' };
  // M64 phase 1.5 — Rage: resistance to bludgeoning, piercing, slashing.
  const resist = damageTypeList(target, 'resistances').includes(t) ||
    ((t === 'bludgeoning' || t === 'piercing' || t === 'slashing') && isRaging(target));
  const vuln = damageTypeList(target, 'vulnerabilities').includes(t);
  let out = amount;
  if (resist) out = Math.floor(out / 2);
  if (vuln) out *= 2;
  const modifier = resist && vuln ? 'resistant+vulnerable' : resist ? 'resistant' : vuln ? 'vulnerable' : null;
  return { amount: out, modifier };
}

/**
 * M64 R8 — the ONE way damage reaches a creature. Every engine path
 * (weapon, opportunity attack, smite, spell attack, auto-hit, AoE save,
 * single-target save, legendary action) calls it. In order:
 *
 *   1. resistance / immunity / vulnerability (`damageTypeList`)
 *   2. temporary hit points (`hpTemp`) absorb what is left
 *   3. HP drops (floor 0); `damage` event; the source's damageDealt
 *      is credited with the post-R/I/V amount
 *   4. concentration: a CON save (seeded rng) at DC max(10, taken/2)
 *      — skipped when the hit drops the creature, whose concentration
 *      simply ends (incapacitated, PHB p203)
 *   5. downed: HP 0 emits `entity.downed`. The creature stays in the
 *      encounter (death saves land in phase 1.5); `isAlive` is unchanged.
 *
 * `raw: true` (DM HP edits) skips 1, 2, 4 and every event.
 *
 * @param {object} target — wrapper ({ hp, hpMax, hpTemp?, _concentrating?, … })
 * @param {number} amount — rolled damage; non-positive is a no-op
 * @param {string|null} [type] — damage type
 * @param {object} [opts]
 * @param {boolean} [opts.crit]
 * @param {object|null} [opts.attacker] — the source wrapper (credited, named in events)
 * @param {object} [opts.ctx] — engine ctx ({ emit })
 * @param {function} [opts.rng] — required when the target may be concentrating
 * @param {string|null} [opts.group] — cinema group
 * @param {object} [opts.parts] — damage event `parts`
 * @param {boolean} [opts.checkConcentration=true] — false defers the save to
 *   the caller (a weapon hit with a smite forces ONE save on the total)
 * @param {boolean} [opts.credit=true] — add to attacker.damageDealt
 * @param {object[]|null} [opts.roster] — every wrapper in the encounter: when
 *   the target's concentration drops, conditions it held end at once (R7);
 *   without it the turn manager's sweep clears them at the end of the turn
 * @param {boolean} [opts.raw=false]
 * @returns {{rolled: number, amount: number, absorbed: number, hpLost: number,
 *   hpBefore: number, hpAfter: number, modifier: string|null, downed: boolean}}
 *   `amount` is the damage taken after R/I/V (temp HP included).
 */
export function applyDamage(target, amount, type = null, opts = {}) {
  const {
    attacker = null, ctx = NO_CTX, rng = null, group = null, parts = null,
    checkConcentration = true, credit = true, raw = false, roster = null
  } = opts;
  const n = Math.max(0, Math.trunc(Number(amount) || 0));
  const hpBefore = target?.hp ?? 0;
  const out = { rolled: n, amount: 0, absorbed: 0, hpLost: 0, hpBefore, hpAfter: hpBefore, modifier: null, downed: false };
  if (!target || n <= 0) return out;
  // M64 R9 — the dead take no more damage.
  if (target.status === 'dead') return out;
  if (raw) {
    target.hp = Math.max(0, hpBefore - n);
    out.amount = n;
    out.hpLost = hpBefore - target.hp;
    out.hpAfter = target.hp;
    out.downed = hpBefore > 0 && target.hp <= 0;
    // DM edits flip the status silently (no events).
    if (out.downed) dropToZero(target, 0, { ctx: NO_CTX, raw: true });
    return out;
  }
  // M64 R9 — a dying PC (0 HP) takes no HP loss: each hit is a failed
  // death save (two on a crit), and damage >= its HP maximum kills it.
  if (hpBefore <= 0 && isDying(target)) {
    const mod0 = applyDamageModifiers(target, n, type);
    out.amount = mod0.amount;
    out.modifier = mod0.modifier;
    const temp0 = Math.max(0, Math.trunc(Number(target.hpTemp) || 0));
    out.absorbed = Math.min(temp0, out.amount);
    if (out.absorbed > 0) target.hpTemp = temp0 - out.absorbed;
    const taken = out.amount - out.absorbed;
    if (canEmit(ctx)) {
      emitEvent(ctx, 'damage', {
        sourceId: idOf(attacker), targetId: idOf(target), amount: 0, type: type ?? null,
        hpBefore: 0, hpAfter: 0, rolled: n,
        ...(parts ? { parts } : {}),
        ...(out.absorbed > 0 ? { absorbed: out.absorbed } : {}),
        ...(out.modifier ? { modifier: out.modifier } : {})
      }, group);
    }
    if (taken > 0) {
      markRageSustained(target);
      deathSaveFailureFromDamage(target, taken, !!opts.crit, attacker, ctx, group);
    }
    return out;
  }
  // 1. R/I/V
  const mod = applyDamageModifiers(target, n, type);
  out.amount = mod.amount;
  out.modifier = mod.modifier;
  // 2. temp HP
  const temp = Math.max(0, Math.trunc(Number(target.hpTemp) || 0));
  out.absorbed = Math.min(temp, out.amount);
  if (out.absorbed > 0) target.hpTemp = temp - out.absorbed;
  // 3. HP
  target.hp = Math.max(0, hpBefore - (out.amount - out.absorbed));
  out.hpLost = hpBefore - target.hp;
  out.hpAfter = target.hp;
  out.downed = hpBefore > 0 && target.hp <= 0;
  if (attacker && credit) attacker.damageDealt = (attacker.damageDealt || 0) + out.amount;
  if (canEmit(ctx)) {
    emitEvent(ctx, 'damage', {
      sourceId: idOf(attacker), targetId: idOf(target),
      amount: out.hpLost,
      type: type ?? null,
      hpBefore, hpAfter: target.hp,
      rolled: n,
      ...(parts ? { parts } : {}),
      ...(out.absorbed > 0 ? { absorbed: out.absorbed } : {}),
      ...(out.modifier ? { modifier: out.modifier } : {})
    }, group);
  }
  // 4. concentration
  if (out.downed) {
    if (isConcentrating(target)) endConcentration(target, 'downed', ctx, group, roster);
  } else if (checkConcentration) {
    concentrationCheck(target, out.amount, rng, ctx, group, roster);
  }
  if (out.amount - out.absorbed > 0) markRageSustained(target);
  // 5. downed — M64 R9: a PC starts dying (or dies outright from massive
  // damage); a monster dies.
  if (out.downed) {
    emitEvent(ctx, 'entity.downed', { entityId: idOf(target), byId: idOf(attacker) }, group);
    dropToZero(target, (out.amount - out.absorbed) - hpBefore, { ctx, group, attacker, roster });
  }
  return out;
}

// =====================================================================
// M64 phase 1.5 — usable class features (the 'feature' action kind)
// =====================================================================

/**
 * Use a class feature now (a 'feature' plan, or a bonus-action feature
 * riding an attack plan). Second Wind: heal 1d10 + fighter level (once
 * per short rest). Rage: the 'raging' condition `{sourceId: self, endsOn:
 * 'encounter', appliedRound}`, one use of `_features.rage` (sheet
 * featureUses, else the Barbarian table), concentration ends. Emits
 * feature.used (+ resource.spent 'feature:rage' / heal). Returns false,
 * changing nothing, when the feature is unknown or not available.
 * @param {object} pc — PC wrapper (mutated)
 * @param {string} featureId
 * @param {{ctx?: object, rng: function, roster?: object[]|null}} opts
 * @returns {boolean}
 */
export function useFeature(pc, featureId, { ctx = NO_CTX, rng, roster = null } = {}) {
  const f = featureId ? PC_FEATURES[featureId] : null;
  if (!pc || pc.kind !== 'pc' || !f || !f.action || !f.available(pc)) return false;
  const entityId = idOf(pc);
  if (featureId === 'second-wind') {
    f.consume(pc);
    emitEvent(ctx, 'feature.used', { entityId, featureId });
    const roll = rollDamage(`1d10+${Math.max(1, classLevel(pc, 'Fighter'))}`, { crit: false }, rng);
    applyHealing(pc, roll.total, { ctx, source: pc });
    return true;
  }
  if (featureId === 'rage') {
    if (!pc._features || typeof pc._features !== 'object') pc._features = featureLedgerFor(pc.ref || {});
    if (!pc._features.rage) pc._features.rage = { max: ragesPerLongRest(pc), spent: 0 };
    if (!spendUse(pc, 'rage')) return false;
    emitEvent(ctx, 'feature.used', { entityId, featureId });
    emitEvent(ctx, 'resource.spent', { entityId, resource: 'feature:rage', level: null });
    if (isConcentrating(pc)) endConcentration(pc, 'ended', ctx, null, roster);
    applyCondition(pc, {
      id: 'raging', sourceId: entityId, endsOn: 'encounter',
      appliedRound: Number.isInteger(ctx.round) ? ctx.round : null
    }, { ctx, roster });
    pc._rageSustained = true;
    return true;
  }
  return false;
}

/** d20 mode for a creature's saving throw: Rage gives advantage on STR saves. */
export function saveModeFor(entity, stat) {
  return stat === 'STR' && isRaging(entity) ? 'advantage' : 'normal';
}

/** Taking damage keeps a rage going (sets the flag only on a raging creature). */
function markRageSustained(target) {
  if (target._rageSustained === false && isRaging(target)) target._rageSustained = true;
}

// =====================================================================
// M64 R9 — dying, death saves, stabilising, reviving
// =====================================================================

/**
 * A PC at 0 HP that is still in the fight: making death saves (`downed`)
 * or `stable`. Dead creatures and anyone above 0 HP are not dying.
 * @param {object} e — wrapper
 * @returns {boolean}
 */
export function isDying(e) {
  return !!e && e.kind === 'pc' && (e.hp ?? 0) <= 0 && (e.status === 'downed' || e.status === 'stable');
}

/**
 * Has this creature died (status 'dead')?
 * @param {object} e — wrapper
 * @returns {boolean}
 */
export function isDead(e) {
  return !!e && e.status === 'dead';
}

/** Fresh death-save tallies. */
export function freshDeathSaves() {
  return { successes: 0, failures: 0, stable: false };
}

function ensureDeathSaves(e) {
  if (!e.deathSaves || typeof e.deathSaves !== 'object') e.deathSaves = freshDeathSaves();
  return e.deathSaves;
}

/** A creature just reached 0 HP (`overflow` = damage left after its HP ran out). */
function dropToZero(target, overflow, { ctx = NO_CTX, group = null, attacker = null, roster = null, raw = false }) {
  if (target.kind !== 'pc') {
    target.status = 'dead';
    if (!raw) emitEvent(ctx, 'entity.died', { entityId: idOf(target), byId: idOf(attacker), cause: 'monster' }, group);
    return;
  }
  if (target.status === 'dead') return;
  const ds = ensureDeathSaves(target);
  ds.successes = 0; ds.failures = 0; ds.stable = false;
  // Rage ends when the barbarian is knocked out.
  if (hasCondition(target, 'raging')) {
    if (raw) removeConditionFrom(target, 'raging');
    else removeCondition(target, 'raging', { ctx, group, reason: 'downed' });
  }
  if (!raw && Number.isFinite(target.hpMax) && overflow >= target.hpMax) {
    target.status = 'dead';
    emitEvent(ctx, 'entity.died', { entityId: idOf(target), byId: idOf(attacker), cause: 'massive' }, group);
    return;
  }
  target.status = 'downed';
  if (raw) addConditionTo(target, 'unconscious');
  else applyCondition(target, 'unconscious', { ctx, group, roster });
}

function die(target, cause, attacker, ctx, group) {
  target.status = 'dead';
  if (target.deathSaves) target.deathSaves.stable = false;
  emitEvent(ctx, 'entity.died', { entityId: idOf(target), byId: idOf(attacker), cause }, group);
}

function emitDeathSave(ctx, group, target, d20, success, crit, cause) {
  const ds = target.deathSaves || freshDeathSaves();
  emitEvent(ctx, 'death.save', {
    entityId: idOf(target), d20, success, crit,
    successes: ds.successes, failures: ds.failures, cause
  }, group);
}

/** Damage to a dying PC: one failure (two on a crit); damage >= hpMax kills. */
function deathSaveFailureFromDamage(target, taken, crit, attacker, ctx, group) {
  const ds = ensureDeathSaves(target);
  if (Number.isFinite(target.hpMax) && taken >= target.hpMax) {
    emitDeathSave(ctx, group, target, null, false, crit, 'damage');
    die(target, 'massive', attacker, ctx, group);
    return;
  }
  if (target.status === 'stable') { target.status = 'downed'; ds.stable = false; ds.successes = 0; }
  ds.failures = Math.min(3, ds.failures + (crit ? 2 : 1));
  emitDeathSave(ctx, group, target, null, false, crit, 'damage');
  if (ds.failures >= 3) die(target, 'failures', attacker, ctx, group);
}

/**
 * The death saving throw a downed PC makes at the start of its turn (PHB
 * p197): d20 ≥ 10 succeeds; a natural 1 is two failures; a natural 20
 * brings it back with 1 HP (it then takes its turn). Three successes →
 * `stable`; three failures → `dead`. Seeded rng; one d20 draw. No-op for
 * anyone not `downed`.
 * @param {object} actor — wrapper
 * @param {function} rng
 * @param {object} [ctx]
 * @returns {{rolled: boolean, d20: number|null, revived: boolean, status: string}}
 */
export function rollDeathSave(actor, rng, ctx = NO_CTX) {
  if (!actor || actor.kind !== 'pc' || actor.status !== 'downed' || (actor.hp ?? 0) > 0) {
    return { rolled: false, d20: null, revived: false, status: actor?.status ?? 'active' };
  }
  const d20 = 1 + Math.floor(rng() * 20);
  const ds = ensureDeathSaves(actor);
  if (d20 === 20) {
    ds.successes = 0; ds.failures = 0; ds.stable = false;
    emitDeathSave(ctx, null, actor, d20, true, true, 'roll');
    applyHealing(actor, 1, { ctx });
    return { rolled: true, d20, revived: true, status: actor.status };
  }
  if (d20 >= 10) {
    ds.successes = Math.min(3, ds.successes + 1);
    emitDeathSave(ctx, null, actor, d20, true, false, 'roll');
    if (ds.successes >= 3) {
      ds.stable = true;
      actor.status = 'stable';
      emitEvent(ctx, 'entity.stabilized', { entityId: idOf(actor) });
    }
  } else {
    ds.failures = Math.min(3, ds.failures + (d20 === 1 ? 2 : 1));
    emitDeathSave(ctx, null, actor, d20, false, d20 === 1, 'roll');
    if (ds.failures >= 3) die(actor, 'failures', null, ctx, null);
  }
  return { rolled: true, d20, revived: false, status: actor.status };
}

/**
 * The concentration save after a creature takes `taken` damage (PHB
 * p203): CON save (saveBonusFor — proficiency and combatMods included)
 * against max(10, taken / 2), seeded rng. Emits `save.rolled` (reason
 * 'concentration') and, on a failure, `concentration.broken`.
 *
 * @param {object} target — wrapper
 * @param {number} taken — damage taken (temp HP included)
 * @param {function} rng
 * @param {object} [ctx]
 * @param {string|null} [group]
 * @param {object[]|null} [roster] — clears the dropped spell's conditions (R7)
 * @returns {{broke: boolean, save: object|null}}
 */
export function concentrationCheck(target, taken, rng, ctx = NO_CTX, group = null, roster = null) {
  if (!target || !(taken > 0) || !isConcentrating(target) || !isAlive(target)) return { broke: false, save: null };
  const conMod = saveBonusFor(target, 'CON');
  const res = handleDamageOnConcentration({ caster: target, damage: taken, conMod }, rng);
  if (res.save) emitSave(ctx, group, target, 'CON', res.save, 'concentration');
  if (res.broke) {
    emitEvent(ctx, 'concentration.broken', {
      casterId: idOf(target), spellId: String(res.dropped?.spellId), reason: 'damage',
      targetIds: (res.dropped?.targetIds || []).map(String)
    }, group);
    if (roster) clearConcentrationConditions(target, roster, ctx, group);
  }
  return { broke: res.broke, save: res.save };
}

/**
 * End a creature's concentration for `reason` and emit
 * `concentration.broken` (with the dropped `targetIds`). With a roster,
 * the conditions the spell held (`endsOn: 'concentration'`) end now.
 * No-op when it is not concentrating.
 * @param {object} caster — wrapper
 * @param {string} reason — 'downed' | 'recast' | 'incapacitated' | 'ended' | …
 * @param {object} [ctx]
 * @param {string|null} [group]
 * @param {object[]|null} [roster] — every wrapper in the encounter
 * @returns {object|null} the dropped block
 */
export function endConcentration(caster, reason, ctx = NO_CTX, group = null, roster = null) {
  const dropped = dropConcentration(caster);
  if (!dropped) return null;
  emitEvent(ctx, 'concentration.broken', {
    casterId: idOf(caster), spellId: String(dropped.spellId), reason,
    targetIds: (dropped.targetIds || []).map(String)
  }, group);
  if (roster) clearConcentrationConditions(caster, roster, ctx, group);
  return dropped;
}

// =====================================================================
// M64 R7 — condition lifecycle (data helpers in conditions.js)
// =====================================================================

/**
 * Apply a condition (string or `{id, sourceId, endsOn, save,
 * appliedRound}`) and emit `condition.applied` with its lifecycle. An
 * incapacitating condition ends the bearer's own concentration (PHB
 * p203). Re-applying a present id refreshes its lifecycle silently.
 * @param {object} target — wrapper
 * @param {string|object} cond
 * @param {{ctx?: object, group?: string|null, roster?: object[]|null}} [opts]
 * @returns {boolean} whether it was newly applied
 */
export function applyCondition(target, cond, { ctx = NO_CTX, group = null, roster = null } = {}) {
  const { added, condition } = addConditionTo(target, cond);
  if (!added) return false;
  emitEvent(ctx, 'condition.applied', {
    entityId: idOf(target), condition: condition.id, sourceId: condition.sourceId,
    endsOn: condition.endsOn, save: condition.save ? { ...condition.save } : null
  }, group);
  if (INCAPACITATING.includes(condition.id) && isConcentrating(target)) {
    endConcentration(target, 'incapacitated', ctx, group, roster);
  }
  return true;
}

/**
 * Remove a condition and emit `condition.removed {entityId, condition,
 * sourceId, reason}`.
 * @param {object} target — wrapper
 * @param {string} id
 * @param {{ctx?: object, group?: string|null, reason?: string}} [opts]
 * @returns {object|null} the removed condition
 */
export function removeCondition(target, id, { ctx = NO_CTX, group = null, reason = 'removed' } = {}) {
  const meta = removeConditionFrom(target, id);
  if (!meta) return null;
  emitEvent(ctx, 'condition.removed', { entityId: idOf(target), condition: id, sourceId: meta.sourceId, reason }, group);
  return meta;
}

/** Remove every `endsOn: 'concentration'` condition `caster` applied. */
function clearConcentrationConditions(caster, roster, ctx, group) {
  for (const e of roster) {
    for (const id of conditionIds(e)) {
      const meta = conditionMeta(e, id);
      if (meta?.endsOn === 'concentration' && sameId(meta.sourceId, caster.id)) {
        removeCondition(e, id, { ctx, group, reason: 'concentration' });
      }
    }
  }
}

/**
 * Remove `endsOn: 'concentration'` conditions whose source no longer
 * concentrates on this creature (dropped elsewhere, e.g. by a legendary
 * action that saw only part of the encounter). The turn manager runs it
 * after every turn.
 * @param {object[]} roster — every wrapper in the encounter
 * @param {object} [ctx]
 * @returns {number} conditions removed
 */
export function sweepConcentrationConditions(roster, ctx = NO_CTX) {
  let removed = 0;
  for (const e of roster) {
    for (const id of conditionIds(e)) {
      const meta = conditionMeta(e, id);
      if (meta?.endsOn !== 'concentration') continue;
      const source = roster.find(w => sameId(w.id, meta.sourceId));
      const held = source && isConcentrating(source) &&
        (source._concentrating.targetIds || []).some(t => sameId(t, e.id));
      if (!held && removeCondition(e, id, { ctx, reason: 'concentration' })) removed++;
    }
  }
  return removed;
}

/**
 * Start-of-turn lifecycle for `actor`: conditions with
 * `endsOn: 'turn-start'` end.
 * @param {object} actor — wrapper
 * @param {object} [ctx]
 */
export function startOfTurnConditions(actor, ctx = NO_CTX) {
  for (const id of conditionIds(actor)) {
    if (conditionMeta(actor, id)?.endsOn === 'turn-start') removeCondition(actor, id, { ctx, reason: 'turn-start' });
  }
  // M64 phase 1.5 — Rage lasts 1 minute (10 rounds).
  if (isRaging(actor) && Number.isInteger(ctx.round)) {
    const since = conditionMeta(actor, 'raging')?.appliedRound;
    if (Number.isInteger(since) && ctx.round - since >= 10) removeCondition(actor, 'raging', { ctx, reason: 'rage-expired' });
  }
}

/**
 * End-of-turn lifecycle for `actor` (runs even when the actor was too
 * incapacitated to act):
 *   - its `endsOn: 'turn-end'` conditions end;
 *   - each condition with a `save` repeats it (seeded rng, `save.rolled`
 *     reason 'condition'); a success ends it, and the source stops
 *     concentrating on this creature (its concentration ends when no
 *     target is left — Hold Person on one target);
 *   - conditions anyone holds with `endsOn: 'source-turn-end'` and
 *     `sourceId` = actor end.
 * @param {object} actor — wrapper
 * @param {object[]} roster — every wrapper in the encounter
 * @param {function} rng
 * @param {object} [ctx]
 */
export function endOfTurnConditions(actor, roster, rng, ctx = NO_CTX) {
  // M64 phase 1.5 — Rage ends early when the barbarian neither attacked
  // a hostile nor took damage since its last turn.
  if (actor && actor._rageSustained !== undefined) {
    if (isRaging(actor) && !actor._rageSustained) removeCondition(actor, 'raging', { ctx, reason: 'rage-lapsed' });
    if (actor._rageSustained) actor._rageSustained = false;
  }
  for (const id of conditionIds(actor)) {
    const meta = conditionMeta(actor, id);
    if (!meta) continue;
    if (meta.endsOn === 'turn-end') {
      removeCondition(actor, id, { ctx, reason: 'turn-end' });
      continue;
    }
    if (!meta.save || !isAlive(actor)) continue;
    const save = rollSave({ bonus: saveBonusFor(actor, meta.save.stat), dc: meta.save.dc, advantage: saveModeFor(actor, meta.save.stat) }, rng);
    emitSave(ctx, null, actor, meta.save.stat, save, 'condition');
    if (!save.success) continue;
    removeCondition(actor, id, { ctx, reason: 'save' });
    const source = meta.sourceId != null ? roster.find(w => sameId(w.id, meta.sourceId)) : null;
    const conc = source?._concentrating;
    if (meta.endsOn === 'concentration' && conc && (conc.targetIds || []).some(t => sameId(t, actor.id))) {
      conc.targetIds = conc.targetIds.filter(t => !sameId(t, actor.id));
      if (conc.targetIds.length === 0) endConcentration(source, 'ended', ctx, null, roster);
    }
  }
  for (const e of roster) {
    for (const id of conditionIds(e)) {
      const meta = conditionMeta(e, id);
      if (meta?.endsOn === 'source-turn-end' && sameId(meta.sourceId, actor.id)) {
        removeCondition(e, id, { ctx, reason: 'source-turn-end' });
      }
    }
  }
}

/**
 * M64 R8 — the ONE way healing reaches a creature. HP rises to at most
 * `hpMax`; a creature at 0 HP (downed) may be healed back up. Emits
 * `heal`. `raw: true` (DM HP edits) emits nothing.
 *
 * @param {object} target — wrapper
 * @param {number} amount — rolled healing; non-positive is a no-op
 * @param {{ctx?: object, source?: object|null, group?: string|null, raw?: boolean}} [opts]
 * @returns {{rolled: number, amount: number, hpBefore: number, hpAfter: number}}
 */
export function applyHealing(target, amount, opts = {}) {
  const { ctx = NO_CTX, source = null, group = null, raw = false } = opts;
  const n = Math.max(0, Math.trunc(Number(amount) || 0));
  const hpBefore = target?.hp ?? 0;
  if (!target || n <= 0) return { rolled: n, amount: 0, hpBefore, hpAfter: hpBefore };
  // M64 R9 — no healing brings back the dead (a DM edit can: raw).
  if (target.status === 'dead' && !raw) return { rolled: n, amount: 0, hpBefore, hpAfter: hpBefore };
  const max = Number.isFinite(target.hpMax) ? target.hpMax : Infinity;
  target.hp = Math.max(hpBefore, Math.min(max, hpBefore + n));
  const healed = target.hp - hpBefore;
  if (!raw) {
    emitEvent(ctx, 'heal', { sourceId: idOf(source), targetId: idOf(target), amount: healed, hpBefore, hpAfter: target.hp, rolled: n }, group);
  }
  // M64 R9 — any healing wakes a dying PC: active again, tallies reset.
  if (hpBefore <= 0 && target.hp > 0 && target.status && target.status !== 'active') {
    target.status = 'active';
    if (target.kind === 'pc') target.deathSaves = freshDeathSaves();
    if (raw) {
      removeConditionFrom(target, 'unconscious');
    } else {
      removeCondition(target, 'unconscious', { ctx, group, reason: 'healed' });
      emitEvent(ctx, 'entity.revived', { entityId: idOf(target), hp: target.hp, byId: idOf(source) }, group);
    }
  }
  return { rolled: n, amount: healed, hpBefore, hpAfter: target.hp };
}

/**
 * Set a creature's HP to `value` through applyDamage / applyHealing in
 * raw mode (DM edits: no R/I/V, temp HP, concentration or events).
 * @param {object} target — wrapper
 * @param {number} value
 * @returns {number} the new HP
 */
export function setHpRaw(target, value) {
  const want = Math.max(0, Math.min(target.hpMax ?? Infinity, Math.trunc(Number(value) || 0)));
  if (want < target.hp) applyDamage(target, target.hp - want, null, { raw: true });
  else if (want > target.hp) applyHealing(target, want - target.hp, { raw: true });
  return target.hp;
}

/**
 * @deprecated M64 R8 — use applyDamage. Kept for existing callers: the
 * same path, with the source credited by the caller as before.
 * @param {object} target
 * @param {number} damage
 * @param {function} rng
 * @param {object} [ctx]
 * @param {{source?: object, type?: string|null, parts?: object, group?: string|null}} [meta]
 */
export function applyDamageToEntity(target, damage, rng, ctx = NO_CTX, meta = {}) {
  applyDamage(target, damage, meta.type ?? null, {
    attacker: meta.source ?? null, ctx, rng, group: meta.group ?? null, parts: meta.parts ?? null, credit: false
  });
}

/**
 * A PC's spellcasting numbers for one cast (M64 R3).
 *
 *   ability — the spell's own `spellCastingAbility` when the character's
 *             parsed spell list carries this spell (matched by name),
 *             else the first spellcasting class's default ability
 *   prof    — proficiency bonus from TOTAL character level (multiclass)
 *   attackBonus = prof + mod + active combatMods kind 'attack' scoped
 *             'spell' or 'all' (Amulet of the Devout, Rod of the Pact
 *             Keeper)
 *   dc      = 8 + prof + mod + active combatMods kind 'save-dc'
 *
 * @param {object} attacker — wrapper ({ ref, combatMods? }) or a bare sheet
 * @param {object} [spell] — registry spell (name used for the lookup)
 * @returns {{ dc: number, attackBonus: number, abilityMod: number, ability: string }}
 */
export function pcSpellBook(attacker, spell = null) {
  const ref = attacker?.ref || attacker;
  const stat = spellAbilityFor(ref, spell);
  const mod = ref?.abilityModifiers?.[stat] ?? 0;
  const prof = proficiencyBonus(totalLevel(ref));
  let atkMods = 0;
  let dcMods = 0;
  for (const m of combatModsOf(attacker)) {
    if (!m || m.inactive) continue;
    const v = Number(m.value) || 0;
    if (m.kind === 'attack' && (m.scope === 'spell' || m.scope === 'all')) atkMods += v;
    else if (m.kind === 'save-dc' && (m.scope === 'spell' || m.scope === 'all')) dcMods += v;
  }
  return {
    dc: 8 + prof + mod + dcMods,
    attackBonus: prof + mod + atkMods,
    abilityMod: mod,
    ability: stat
  };
}

function spellAbilityFor(ref, spell) {
  const wanted = String(spell?.name || '').toLowerCase();
  if (spell?.spellCastingAbility) return spell.spellCastingAbility;
  if (wanted) {
    const own = (ref?.spells || []).find(s => String(s?.name || '').toLowerCase() === wanted);
    if (own?.spellCastingAbility) return own.spellCastingAbility;
  }
  for (const c of ref?.classes || []) {
    const name = String(c?.name || '').toLowerCase();
    if (name === 'cleric' || name === 'druid' || name === 'ranger') return 'WIS';
    if (name === 'bard' || name === 'sorcerer' || name === 'warlock' || name === 'paladin') return 'CHA';
    if (name === 'wizard' || name === 'artificer') return 'INT';
  }
  return 'INT';
}

export function abilityForCounterer(pc) {
  const classes = pc?.ref?.classes || [];
  for (const c of classes) {
    const name = String(c?.name || '').toLowerCase();
    if (name === 'wizard' || name === 'artificer') return 'INT';
    if (name === 'cleric' || name === 'druid' || name === 'ranger') return 'WIS';
    if (name === 'bard' || name === 'sorcerer' || name === 'warlock' || name === 'paladin') return 'CHA';
  }
  return 'INT';
}

/**
 * Saving-throw bonus for an entity wrapper.
 *
 * PCs (M64 R2): ability mod + proficiency when proficient
 * (`savingThrowProficiencies`, via pc-stats.saveBonus) + every active
 * `combatMods` entry of kind 'save' whose scope is 'all' or this stat
 * (Cloak of Protection, Paladin aura bonuses parsed from DDB). The
 * concentration save goes through this same function.
 * Monsters: the preset save table.
 *
 * @param {object} entity — wrapper ({ kind, ref, combatMods?, presetSlug })
 * @param {string} stat — 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA'
 * @returns {number}
 */
export function saveBonusFor(entity, stat) {
  if (!entity || !stat) return 0;
  if (entity.kind === 'pc') {
    const ref = entity.ref || entity;
    const scope = String(stat).toLowerCase();
    let bonus = pcSaveBonus(ref, stat);
    for (const mod of combatModsOf(entity)) {
      if (mod?.inactive || mod?.kind !== 'save') continue;
      if (mod.scope === 'all' || mod.scope === scope) bonus += Number(mod.value) || 0;
    }
    return bonus;
  }
  // M64 T5 — an imported stat block's saves (EncounterState statBlock.saves)
  // win over the visual preset's table.
  if (entity.saves && typeof entity.saves === 'object') return Number(entity.saves[stat]) || 0;
  const table = MONSTER_DEFAULT_SAVES[entity.presetSlug];
  return table ? (table[stat] || 0) : 0;
}

/**
 * Raw ability modifier (ability checks such as the Counterspell check
 * add no proficiency). PCs read `abilityModifiers`; monsters fall back
 * to their save table, as before.
 *
 * @param {object} entity
 * @param {string} stat
 * @returns {number}
 */
export function abilityModFor(entity, stat) {
  if (!entity || !stat) return 0;
  if (entity.kind === 'pc') {
    const ref = entity.ref || entity;
    return ref.abilityModifiers?.[stat] ?? 0;
  }
  return saveBonusFor(entity, stat);
}

/**
 * M64 phase 1.5 — cover between two wrappers on the scene's terrain
 * (grid-legality.coverBetween; other creatures give half cover).
 * @param {object} scene
 * @param {object[]} roster — wrappers that may stand in the way
 * @param {object} from — wrapper
 * @param {object} to — wrapper
 * @returns {'none'|'half'|'threeQuarters'|'total'}
 */
export function coverBetweenWrappers(scene, roster, from, to) {
  const a = from?._position || from?.position;
  const b = to?._position || to?.position;
  if (!scene?.terrain || !a || !b) return 'none';
  return coverBetween(scene.terrain, roster || [], a, b);
}

/**
 * DEX-save bonus from cover (PHB p196): half +2, three-quarters +5.
 * @param {string} cover
 * @param {string} stat
 * @returns {number}
 */
export function coverSaveBonus(cover, stat) {
  if (stat !== 'DEX') return 0;
  return cover === 'half' ? 2 : cover === 'threeQuarters' ? 5 : 0;
}

/** The sheet's own spell entry (parsed spells[]) for a registry id, or null. */
/**
 * M64 phase 1.5 wave 6 — where a teleport (Misty Step) lands. An explicit
 * `moveTo` must be on the grid, unoccupied, not blocked terrain, within
 * `rangeFt` and (with terrain) in line of sight. Without one (the AI), the
 * legal cell farthest from the nearest living hostile wins; ties go to the
 * shorter hop, then scan order (rows, then columns).
 * @param {object} caster — wrapper
 * @param {{col: number, row: number}|undefined} moveTo
 * @param {number} rangeFt
 * @param {object} scene
 * @param {object[]} roster — every wrapper in the encounter
 * @param {object[]} hostiles — the caster's enemies
 * @returns {{cell: {col: number, row: number}}|{error: string}}
 */
function teleportDestination(caster, moveTo, rangeFt, scene, roster, hostiles) {
  const from = caster._position || caster.position;
  if (!from) return { error: 'the caster has no position' };
  const terrain = scene?.terrain ? asTerrain(scene.terrain) : null;
  const cols = terrain ? terrain.cols : (scene?.cols || 99);
  const rows = terrain ? terrain.rows : (scene?.rows || 99);
  const taken = new Set();
  for (const w of roster) {
    if (w === caster || sameId(w.id, caster.id) || (w.kind === 'monster' && !isAlive(w))) continue;
    const p = w._position || w.position;
    if (p) taken.add(`${p.col},${p.row}`);
  }
  const legal = (c) => {
    if (!(c.col >= 0 && c.row >= 0 && c.col < cols && c.row < rows)) return 'destination is off the grid';
    if (taken.has(`${c.col},${c.row}`)) return 'destination is occupied';
    if (chebyshevFeet(from, c) > rangeFt) return `destination is beyond ${rangeFt} ft`;
    if (terrain && (terrain.cells[c.row * terrain.cols + c.col] & TERRAIN_FLAGS.BLOCKED) !== 0) return 'destination is blocked';
    if (terrain && !lineOfSight(scene.terrain, from, c)) return 'destination is out of sight';
    return null;
  };
  if (moveTo) {
    const cell = { col: moveTo.col, row: moveTo.row };
    const error = legal(cell);
    return error ? { error } : { cell };
  }
  const threats = hostiles.filter(isAlive).map(h => h._position || h.position).filter(Boolean);
  const reach = Math.floor(rangeFt / 5);
  let best = null;
  for (let row = from.row - reach; row <= from.row + reach; row++) {
    for (let col = from.col - reach; col <= from.col + reach; col++) {
      const cell = { col, row };
      if ((col === from.col && row === from.row) || legal(cell)) continue;
      const away = threats.length ? Math.min(...threats.map(t => chebyshevFeet(cell, t))) : 0;
      const hop = chebyshevFeet(from, cell);
      if (!best || away > best.away || (away === best.away && hop < best.hop)) best = { cell, away, hop };
    }
  }
  return best ? { cell: best.cell } : { error: `no free cell within ${rangeFt} ft` };
}

function ownSpellEntry(ref, spellId) {
  for (const sp of Array.isArray(ref?.spells) ? ref.spells : []) {
    if (sp && typeof sp === 'object' && spellSlug(sp.name) === spellId) return sp;
  }
  return null;
}

/** Nearest standing creature in `list` within `rangeFt` of `from`'s wrapper. */
function nearestInRange(from, list, rangeFt) {
  const p0 = from._position || from.position;
  if (!p0) return null;
  let best = null;
  let bestD = Infinity;
  for (const e of list) {
    if (!isAlive(e)) continue;
    const p = e._position || e.position;
    if (!p) continue;
    const d = chebyshevFeet(p0, p);
    if (d <= rangeFt && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

/** A wrapper's ledger entry for a granted spell, created fully rested on first use. */
function ensureUseLedger(w, key, grant) {
  if (!w._features || typeof w._features !== 'object') w._features = featureLedgerFor(w.ref || {});
  if (!w._features[key]) w._features[key] = { max: Math.max(1, Math.trunc(Number(grant?.uses?.max) || 1)), spent: 0 };
}

function combatModsOf(entity) {
  if (Array.isArray(entity?.combatMods)) return entity.combatMods;
  const ref = entity?.ref || entity;
  return Array.isArray(ref?.combatMods) ? ref.combatMods : [];
}

/** Ids compare as strings (DDB ids are numbers, EncounterState ids strings). */
export function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

export function pickTarget(enemies) {
  let best = null;
  for (const e of enemies) {
    if (!isAlive(e)) continue;
    if (!best || e.hp < best.hp) best = e;
  }
  return best;
}

export function isAlive(e) { return e.hp > 0; }
export function isIncapacitated(e) {
  return isIncapacitatedBy(e);
}
export function sideAlive(side) {
  return side.filter(e => isAlive(e) && !isIncapacitated(e)).length;
}
