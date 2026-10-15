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
import { factionLists, chebyshevFeet } from './grid-rules.js';
import { planMovement, occupiedCellsOf } from './movement.js';
import { chooseAction, fleeTargetCell } from './ai/profile.js';
import { choosePcAction } from './ai/pc-action.js';
import { PC_FEATURES, resetPerTurnFlags } from './ai/pc-features.js';
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
import { MONSTER_DEFAULT_SAVES } from './monster-presets.js';
import { chooseLegendaryAction, spendLegendaryAction } from './monster-legendary.js';
import {
  NO_CTX, canEmit, emitEvent, nextCinemaGroup, fxSeedOf, idOf, normalizeAnswer
} from './engine-events.js';

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
    // stay pure JSON for snapshots.
    if (attacker && Object.prototype.hasOwnProperty.call(attacker, '_mctsTargetCtx')) {
      delete attacker._mctsTargetCtx;
    }
  }
}

/** Plan kinds that move (or not) but never reach the attack resolver. */
const NON_ATTACK_KINDS = new Set(['dash', 'dodge', 'disengage', 'move']);

async function resolveTurn(attacker, enemies, allies, scene, rng, prompts, ctx) {
  const actorId = idOf(attacker);
  // M64 R13 — Dodge lasts until the start of this creature's next turn.
  if (attacker._dodging) attacker._dodging = false;
  // M37 — At the start of each monster's turn, roll d6 for any innate
  // spells that are cooling down. M64 T2 — this is the single source of
  // the per-turn recharge roll; callers must not roll it again.
  if (attacker.kind === 'monster' && attacker._innate) {
    rollInnateRecharges(attacker, rng);
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
      enemies: enemies.filter(isAlive),
      allies: allies.filter(isAlive),
      rng
    });
  } else {
    // M42 — Per-turn AI for PCs. Resets sneak-attack/cunning-action
    // flags first, then picks the best (weapon/spell/feature) action.
    resetPerTurnFlags(attacker);
    plan = choosePcAction({
      self: attacker,
      enemies: enemies.filter(isAlive),
      allies: allies.filter(isAlive),
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
  let target;
  if (explicit) {
    // A player / DM plan names its side explicitly.
    if (plan.targetSide === 'ally') target = allies.find(a => sameId(a.id, plan.targetId));
    else if (plan.targetId != null) target = enemies.find(e => sameId(e.id, plan.targetId));
    else target = pickTarget(enemies);
  } else if (plan?.targetId) {
    target = enemies.find(e => sameId(e.id, plan.targetId));
  } else {
    target = pickTarget(enemies);
  }
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
  if (explicit && !isAlive(target) && !healsAlly && !NON_ATTACK_KINDS.has(plan.kind)) {
    emitEvent(ctx, 'turn.rejected', { actorId, code: 'target-down', reason: `${target.name || idOf(target)} is down` });
    return;
  }

  // M31 — Movement step before the attack. M32: if the profile said
  // 'flee', the attacker moves AWAY from the nearest threat instead of
  // toward it, and skips the attack roll this turn.
  const attackerPos = attacker._position || attacker.position;
  const targetPos   = target._position   || target.position;
  if (attackerPos && targetPos) {
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
    const baseSpeed = Number.isFinite(attacker.speedFt) ? attacker.speedFt : 30;
    const speedFt = plan?.kind === 'dash' ? baseSpeed * 2 : baseSpeed;
    attacker._disengaged = plan?.kind === 'disengage';
    let next;
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
    } else {
      const moveTarget = (plan && plan.kind === 'flee')
        ? fleeTargetCell(attacker, target, bounds, rng)
        : targetPos;
      next = planMovement({
        from: attackerPos, to: moveTarget, weapon,
        speedFt, occupied, bounds
      });
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
          await runReactionAttack(triggerer, attacker, attackerPos, scene, rng, prompts, ctx);
          consumeReaction(triggerer);
          emitEvent(ctx, 'resource.spent', { entityId: idOf(triggerer), resource: 'reaction', level: null });
        }
      }
      for (const { triggerer } of entryTriggers) {
        if (!isAlive(attacker)) break;
        if (await askReactionAttack(triggerer, attacker, 'entry', prompts, ctx)) {
          await runReactionAttack(triggerer, attacker, next, scene, rng, prompts, ctx);
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
      emitEvent(ctx, 'move', {
        actorId, from: { col: attackerPos.col, row: attackerPos.row }, to: { col: next.col, row: next.row }
      });
    }
  }

  // M64 R13 — Dodge: attacks against this creature have disadvantage
  // until its next turn (cleared at the top of resolveTurn).
  if (plan?.kind === 'dodge') attacker._dodging = true;
  // Fleeing creatures Dash instead of attacking
  if (plan && plan.kind === 'flee') return;
  // M64 T6 — the target may have dropped while we awaited reactions.
  if (!isAlive(target) && !healsAlly && !(plan && NON_ATTACK_KINDS.has(plan.kind))) {
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
    let castTarget = target;
    if (plan.targetSide === 'ally') {
      castTarget = allies.find(a => sameId(a.id, plan.targetId)) || null;
    }
    if (!castTarget) return;
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

  // Build the resolver context. PCs use deriveWeaponAttack; monsters
  // use the preset attack record directly. M42 weapon-switch is honored
  // via attacker._chosenWeapon (set by the planner above).
  let attackStats;
  let sneakDice = 0;
  if (attacker.kind === 'pc') {
    const chosen = attacker._chosenWeapon || attacker.weapon;
    const a = deriveWeaponAttack(attacker.ref, chosen);
    attackStats = {
      bonus: a.bonus, dice: a.dice, damageType: a.damageType,
      parts: [{ source: chosen?.name || 'Attack', value: a.bonus }],
      damageParts: []
    };
    // M42 — Sneak Attack. M64 R1 — the extra dice are appended AFTER the
    // resolver (below) so its flat combatMods damage fold still sees a
    // single-term spec; rollDamage handles the multi-term result.
    if (plan?.featuresFired?.includes('sneak-attack')) {
      const lvl = (attacker.ref.classes || []).find(c => /rogue/i.test(c.name))?.level || 1;
      sneakDice = Math.max(1, Math.ceil(lvl / 2));
      PC_FEATURES['sneak-attack'].consume(attacker);
      emitEvent(ctx, 'feature.used', { entityId: actorId, featureId: 'sneak-attack' });
    }
    // M42.1 — Reckless Attack
    if (plan?.featuresFired?.includes('reckless-attack')) {
      PC_FEATURES['reckless-attack'].consume(attacker);
      emitEvent(ctx, 'feature.used', { entityId: actorId, featureId: 'reckless-attack' });
    }
  } else {
    attackStats = {
      bonus: attacker.attack.bonus, dice: attacker.attack.dice,
      damageType: null,
      parts: [{ source: attacker.attack.name, value: attacker.attack.bonus }],
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
  const weaponUsed = attacker.kind === 'pc' ? attacker.weapon : { name: attacker.attack.name };
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
    attackStats
  });

  if (verdict.autoMiss) {
    if (explicit) {
      emitEvent(ctx, 'turn.rejected', {
        actorId, code: 'blocked', reason: (verdict.blockers || []).join('; ') || 'attack not possible'
      });
    }
    return;
  }

  const group = nextCinemaGroup(ctx);
  const targetHpBefore = target.hp;
  const finalBonus = verdict.attackBonus.total;
  const finalDmgDice = sneakDice > 0
    ? `${verdict.damage.dice}+${sneakDice}d6`
    : verdict.damage.dice;
  let atk;
  if (verdict.autoCrit) {
    atk = { hit: true, crit: true, total: 20 + finalBonus };
  } else {
    atk = rollAttack({ bonus: finalBonus, advantage: dodgeMode(verdict.d20.mode, target), targetAC: target.ac }, rng);
    if (prompts.onRoll) atk = await reviewRoll(prompts, ctx, group, 'attack', attacker, target, atk);
  }
  // M33.1 — Shield reaction (target casts AFTER the roll lands).
  // M64 N1 — offered only when Shield could block it; answer gated.
  if (await askShield(target, atk, { weapon: attacker.weapon }, prompts, ctx, group)) {
    spendShield(target, ctx, group);
    atk.hit = false;
    atk.shielded = true;
  }
  emitAttackRolled(ctx, group, attacker, target, atk, { weapon: weaponUsed?.name ?? null, isReaction: false, mode: verdict.d20.mode, bonus: finalBonus });
  // M64 T6 — re-check after the Shield await (a DM edit can land there).
  if (!isAlive(attacker) || !isAlive(target)) return;
  const modifiers = {
    sneak: sneakDice > 0,
    reckless: !!plan?.featuresFired?.includes('reckless-attack'),
    surge: !!plan?.featuresFired?.includes('action-surge'),
    smiteSlot: null
  };
  if (!atk.hit) {
    // Dispatch a cinema round for the miss too — the live runner uses
    // this to dramatize the swing even when no damage lands.
    await dispatchCinema(prompts, ctx, group, {
      attacker, defender: target, plan, atk, dmg: 0, crit: false, miss: true
    }, { reaction: false, cast: false, targetHpBefore, modifiers });
    return;
  }
  let dmg = rollDamage(finalDmgDice, { crit: atk.crit }, rng);
  if (prompts.onRoll) {
    dmg = await reviewRoll(prompts, ctx, group, 'damage', attacker, target, dmg);
    if (!isAlive(attacker) || !isAlive(target)) return;
  }
  const hpBeforeHit = target.hp;
  target.hp = Math.max(0, target.hp - dmg.total);
  attacker.damageDealt += dmg.total;
  emitDamage(ctx, group, attacker, target, hpBeforeHit, dmg.total, verdict.damage.damageType ?? null,
    { weapon: dmg.total, ...(sneakDice > 0 ? { sneakDice } : {}) });

  // M42.1 — Divine Smite
  let smiteTotal = 0;
  if (attacker.kind === 'pc' && plan?.featuresFired?.includes('divine-smite')) {
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
    const hpBeforeSmite = target.hp;
    target.hp = Math.max(0, target.hp - smiteRoll.total);
    attacker.damageDealt += smiteRoll.total;
    smiteTotal = smiteRoll.total;
    emitDamage(ctx, group, attacker, target, hpBeforeSmite, smiteRoll.total, 'Radiant', { smite: smiteRoll.total });
  }

  // M45 Phase 4b — Dramatize the resolved exchange.
  await dispatchCinema(prompts, ctx, group, {
    attacker, defender: target, plan, atk,
    dmg: dmg.total + smiteTotal, crit: !!atk.crit, miss: false
  }, { reaction: false, cast: false, targetHpBefore, modifiers, smiteTotal, damageType: verdict.damage.damageType ?? null });

  // M42 — Action Surge: a second action right now.
  if (plan?.featuresFired?.includes('action-surge') && !attacker._surgeFiredThisTurn) {
    attacker._surgeFiredThisTurn = true;
    PC_FEATURES['action-surge'].consume(attacker);
    emitEvent(ctx, 'feature.used', { entityId: actorId, featureId: 'action-surge' });
    if (isAlive(attacker) && sideAlive(enemies) > 0) {
      await runOneAttack(attacker, enemies, allies, scene, rng, prompts, ctx);
    }
    attacker._surgeFiredThisTurn = false;
  }
}

// =====================================================================
// runMonsterSpell — spell casting (both monster + PC)
// =====================================================================

export async function runMonsterSpell({ attacker, target, plan, scene, rng, witnesses = [], allEnemies = [], allies = [], prompts = {}, ctx = NO_CTX }) {
  const baseSpell = spellById(plan.spellId);
  if (!baseSpell) return;
  const spell = applyUpcast(baseSpell, plan.castAtLevel);
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

  if (spell.concentration && isConcentrating(attacker)) {
    const dropped = dropConcentration(attacker);
    emitEvent(ctx, 'concentration.broken', { casterId, spellId: String(dropped?.spellId), reason: 'recast' }, group);
  }

  let slotSpent = null;
  if (plan.isInnate) {
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
    castAtLevel: Math.max(spell.level || 0, plan.castAtLevel || 0),
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
    if (!spell.aoe && spell.kind !== 'heal' && !isAlive(target)) return;
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
  }, { reaction: false, cast: true, targetHpBefore: extra.hpBefore ?? defender?.hp, spell, outcome, effects: extra.effects });

  if (spell.kind === 'heal') {
    const dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
    const mod = spell.addsAbilityMod ? (effectiveBook.abilityMod || 0) : 0;
    const heal = dmgRoll.total + mod;
    if (target?.hpMax > 0) {
      const before = target.hp;
      target.hp = Math.min(target.hpMax, target.hp + heal);
      emitEvent(ctx, 'heal', { sourceId: casterId, targetId: idOf(target), amount: target.hp - before, hpBefore: before, hpAfter: target.hp, rolled: heal }, group);
      await castCinema(target, { heal }, { hpBefore: before });
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
    if (!isAlive(attacker) || !isAlive(target)) return;
    const darts = spell.darts || 1;
    let totalDmg = 0;
    for (let i = 0; i < darts; i++) {
      const r = rollDamage(spell.perDart, { crit: false }, rng);
      totalDmg += r.total;
    }
    if (prompts.onRoll) {
      totalDmg = (await reviewRoll(prompts, ctx, group, 'damage', attacker, target, { total: totalDmg, spec: `${darts}x${spell.perDart}`, crit: false })).total;
      if (!isAlive(attacker) || !isAlive(target)) return;
    }
    const before = target.hp;
    applyDamageToEntity(target, totalDmg, rng, ctx, { source: attacker, type: spell.damageType ?? null, parts: { darts }, group });
    attacker.damageDealt += totalDmg;
    await castCinema(target, { dmg: totalDmg, darts }, { hpBefore: before });
    return;
  }

  if (spell.kind === 'spell-attack') {
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
      target: { ...target.ref, conditions: target.conditions, _position: target._position || target.position },
      weapon: null,
      spell,
      scene,
      attackerKind: attacker.kind,
      targetKind: target.kind,
      targetAC: target.ac,
      advantageOverride: 'auto',
      allies: allies.filter(a => a !== attacker && isAlive(a)).map(a => ({ ...a.ref, _position: a._position || a.position, conditions: a.conditions, id: a.id, name: a.name })),
      hostiles: allEnemies.filter(isAlive).map(e => ({ ...e.ref, _position: e._position || e.position, conditions: e.conditions, id: e.id, name: e.name })),
      attackStats: {
        bonus: effectiveBook.attackBonus, dice: spell.dice, damageType: spell.damageType ?? null,
        parts: [{ source: spell.name, value: effectiveBook.attackBonus }], damageParts: []
      }
    });
    if (verdict.autoMiss) {
      await castCinema(target, { dmg: 0, miss: true });
      return;
    }
    const mode = verdict.d20.mode;
    let atk = verdict.autoCrit
      ? { hit: true, crit: true, total: 20 + verdict.attackBonus.total }
      : rollAttack({ bonus: verdict.attackBonus.total, advantage: dodgeMode(mode, target), targetAC: target.ac }, rng);
    if (prompts.onRoll) atk = await reviewRoll(prompts, ctx, group, 'attack', attacker, target, atk);
    if (await askShield(target, atk, { weapon: null, spell }, prompts, ctx, group)) {
      spendShield(target, ctx, group);
      atk.hit = false;
      atk.shielded = true;
      emitAttackRolled(ctx, group, attacker, target, atk, { weapon: null, isReaction: false, mode, bonus: verdict.attackBonus.total, spellId: String(plan.spellId) });
      emitEvent(ctx, 'spell.fizzled', { casterId, reason: 'shield', spellId: String(plan.spellId), targetId: idOf(target) }, group);
      return;
    }
    emitAttackRolled(ctx, group, attacker, target, atk, { weapon: null, isReaction: false, mode, bonus: verdict.attackBonus.total, spellId: String(plan.spellId) });
    if (!isAlive(attacker) || !isAlive(target)) return;
    if (!atk.hit) {
      await castCinema(target, { dmg: 0, miss: true });
      return;
    }
    let dmg = rollDamage(verdict.damage.dice || spell.dice, { crit: atk.crit }, rng);
    if (prompts.onRoll) {
      dmg = await reviewRoll(prompts, ctx, group, 'damage', attacker, target, dmg);
      if (!isAlive(attacker) || !isAlive(target)) return;
    }
    const before = target.hp;
    applyDamageToEntity(target, dmg.total, rng, ctx, { source: attacker, type: spell.damageType ?? null, group });
    attacker.damageDealt += dmg.total;
    await castCinema(target, { dmg: dmg.total, crit: !!atk.crit }, { hpBefore: before });
    return;
  }

  // AoE save
  if (spell.aoe && allEnemies.length > 0) {
    const center = attacker._position || attacker.position;
    if (center) {
      let totalDmg = 0;
      const aoeResults = [];
      for (const e of allEnemies) {
        if (!isAlive(e)) continue;
        const ep = e._position || e.position;
        if (!ep) continue;
        if (chebyshevFeet(center, ep) > (spell.range || 15)) continue;
        const eBonus = saveBonusFor(e, spell.saveStat);
        const eSave = rollSave({ bonus: eBonus, dc: effectiveBook.dc }, rng);
        emitSave(ctx, group, e, spell.saveStat, eSave, 'spell');
        const dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
        let dmg = dmgRoll.total;
        if (eSave.success) dmg = spell.saveOnHalf ? Math.floor(dmg / 2) : 0;
        const before = e.hp;
        applyDamageToEntity(e, dmg, rng, ctx, { source: attacker, type: spell.damageType ?? null, group });
        totalDmg += dmg;
        aoeResults.push({ entity: e, dmg, saved: eSave.success, before });
      }
      attacker.damageDealt += totalDmg;
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
  const targetSaveBonus = saveBonusFor(target, saveStat);
  let save = rollSave({ bonus: targetSaveBonus, dc: effectiveBook.dc }, rng);
  if (prompts.onRoll) save = await reviewRoll(prompts, ctx, group, 'save', target, attacker, save);
  emitSave(ctx, group, target, saveStat, save, 'spell');
  const before = target.hp;
  let saveDmg = 0;
  if (spell.dice) {
    let dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
    if (prompts.onRoll) dmgRoll = await reviewRoll(prompts, ctx, group, 'damage', attacker, target, dmgRoll);
    let dmg = dmgRoll.total;
    if (save.success) dmg = spell.saveOnHalf ? Math.floor(dmg / 2) : 0;
    applyDamageToEntity(target, dmg, rng, ctx, { source: attacker, type: spell.damageType ?? null, group });
    attacker.damageDealt += dmg;
    saveDmg = dmg;
  }
  if (!save.success && spell.appliesCondition) {
    if (!target.conditions.includes(spell.appliesCondition)) {
      target.conditions.push(spell.appliesCondition);
      emitEvent(ctx, 'condition.applied', { entityId: idOf(target), condition: spell.appliesCondition, sourceId: casterId }, group);
    }
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

export async function runReactionAttack(attacker, target, targetBeforePos, scene, rng, prompts = {}, ctx = NO_CTX) {
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
    attackStats
  });
  if (verdict.autoMiss) return;
  const group = nextCinemaGroup(ctx);
  const targetHpBefore = target.hp;
  let atk = verdict.autoCrit
    ? { hit: true, crit: true, total: 20 + verdict.attackBonus.total }
    : rollAttack({ bonus: verdict.attackBonus.total, advantage: dodgeMode(verdict.d20.mode, target), targetAC: target.ac }, rng);
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
  const before = target.hp;
  target.hp = Math.max(0, target.hp - dmg.total);
  attacker.damageDealt += dmg.total;
  emitDamage(ctx, group, attacker, target, before, dmg.total, verdict.damage.damageType ?? null, { weapon: dmg.total });
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
    applyDamageToEntity(target, dmg.total, rng, ctx, { source: monster, type: action.damageType ?? null, group });
    monster.damageDealt += dmg.total;
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
      const save = rollSave({ bonus: eBonus, dc: action.dc }, rng);
      emitSave(ctx, group, e, action.saveStat, save, 'legendary');
      const dmgRoll = rollDamage(action.dice, { crit: false }, rng);
      let dmg = dmgRoll.total;
      if (save.success) dmg = Math.floor(dmg / 2);
      applyDamageToEntity(e, dmg, rng, ctx, { source: monster, type: action.damageType ?? null, group });
      monster.damageDealt += dmg;
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

function emitDamage(ctx, group, source, target, hpBefore, rolled, type, parts) {
  if (!canEmit(ctx)) return;
  emitEvent(ctx, 'damage', {
    sourceId: idOf(source), targetId: idOf(target),
    amount: Math.max(0, hpBefore - target.hp),
    type: type ?? null,
    hpBefore, hpAfter: target.hp,
    rolled,
    ...(parts ? { parts } : {})
  }, group);
  if (hpBefore > 0 && target.hp <= 0) emitEvent(ctx, 'entity.downed', { entityId: idOf(target), byId: idOf(source) }, group);
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
    const weapon = info.cast ? null : cinemaWeapon(attacker, info.damageType);
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
      exchangeId: group,
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
        fxSeed: fxSeedOf(group),
        durationMs: 0
      }
    }, group);
  }
  if (prompts.onCinemaRound) await prompts.onCinemaRound(roundPayload);
}

function cinemaWeapon(attacker, damageType) {
  if (attacker?.kind === 'pc') {
    const w = attacker._chosenWeapon || attacker.weapon || null;
    const name = w?.name || 'Unarmed Strike';
    const bonus = Number(w?.magicBonus ?? w?.bonus ?? 0);
    return {
      name,
      damageType: w?.damageType ?? damageType ?? null,
      magical: bonus > 0 || !!w?.magic || /\+\d/.test(name)
    };
  }
  const a = attacker?.attack || {};
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
  return atk.total < defender.ac + 5;
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
    : shouldCastShield({ target: defender, attackerTotal: atk.total, targetAc: defender.ac });
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

/**
 * Apply damage to an entity wrapper, then roll the concentration save
 * (PHB p203) if it was concentrating. M64 T2 — `rng` is threaded into
 * the concentration save. M64 T4 — emits `damage`, `entity.downed`,
 * `save.rolled` (reason 'concentration') and `concentration.broken`.
 *
 * @param {object} target — entity wrapper ({ hp, _concentrating, ... })
 * @param {number} damage — non-positive values are a no-op
 * @param {function} rng — () → [0,1); required when target may be concentrating
 * @param {object} [ctx] — engine ctx ({ emit })
 * @param {{source?: object, type?: string|null, parts?: object, group?: string|null}} [meta]
 */
export function applyDamageToEntity(target, damage, rng, ctx = NO_CTX, meta = {}) {
  if (!target || damage <= 0) return;
  const before = target.hp;
  target.hp = Math.max(0, target.hp - damage);
  const dealtDamage = before - target.hp;
  const group = meta.group ?? null;
  emitDamage(ctx, group, meta.source ?? null, target, before, damage, meta.type ?? null, meta.parts);
  if (dealtDamage > 0 && isConcentrating(target)) {
    const conMod = saveBonusFor(target, 'CON');
    const res = handleDamageOnConcentration({ caster: target, damage: dealtDamage, conMod }, rng);
    if (res.save) emitSave(ctx, group, target, 'CON', res.save, 'concentration');
    if (res.broke) {
      emitEvent(ctx, 'concentration.broken', {
        casterId: idOf(target), spellId: String(res.dropped?.spellId), reason: 'damage'
      }, group);
    }
  }
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
  const c = e.conditions || [];
  return c.includes('paralyzed') || c.includes('stunned') ||
         c.includes('unconscious') || c.includes('petrified');
}
export function sideAlive(side) {
  return side.filter(e => isAlive(e) && !isIncapacitated(e)).length;
}
