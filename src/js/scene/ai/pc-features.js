/**
 * M42 — PC class feature registry for the AI.
 *
 * Each feature describes:
 *   - `available(entity, ctx)` — predicate (does the PC have it + uses left?)
 *   - `scoreBoost(option, ctx)` — additive utility for an option when this
 *     feature would fire with it (e.g. Sneak Attack on a melee finesse
 *     weapon against a target with advantage source)
 *   - `consume(entity)`       — burn the usage (action surge, smite slot)
 *
 * Pure module; mutation is funneled through consume(). Feature presence
 * is detected from the parsed character (M14: feats, classes) plus a few
 * per-turn flags (action surge used this short rest, etc.).
 */

import { chebyshevFeet } from '../grid-rules.js';
import { mctsEvaluate, shallowRolloutForResource } from './mcts.js';

/**
 * M42.2 — MCTS-style slot picker for Divine Smite.
 *
 * Enumerates each available slot level (1..5) as a candidate, then runs
 * a shallow rollout per candidate to estimate expected encounter
 * value: extra damage × kill probability − slot scarcity tax. The
 * winning slot is the one that maximizes total value.
 *
 * Caller (the consume() above) reads the returned slot level and
 * decrements the pool accordingly.
 */
function pickSmiteSlot(pc, slots) {
  // Target context lives on `pc._mctsTargetCtx` (stamped by the scorer
  // just before consume). If absent we fall back to lowest-slot.
  const targetCtx = pc._mctsTargetCtx;
  if (!targetCtx) return null;
  const candidates = [];
  const slotPool = Object.values(slots).reduce((s, n) => s + (n || 0), 0);
  for (let lvl = 1; lvl <= 5; lvl++) {
    if ((slots[lvl] ?? 0) <= 0) continue;
    const smiteDice = Math.min(5, 2 + (lvl - 1));   // 2..5 d8
    // Average d8 = 4.5
    const expectedExtraDamage = smiteDice * 4.5;
    candidates.push({
      id: `smite-${lvl}`, level: lvl, baseScore: 0,
      expectedExtraDamage
    });
  }
  if (candidates.length === 0) return null;
  const ranked = mctsEvaluate({
    candidates,
    rollout: (cand) => shallowRolloutForResource({
      candidate: cand,
      ctx: { ...targetCtx, slotPool }
    }),
    rollouts: 4, depth: 1
  });
  return ranked[0].level;
}

/** Does this PC have a given class at all? */
function hasClass(pc, name) {
  const re = new RegExp(`^${name}$`, 'i');
  return (pc?.classes || []).some(c => re.test(String(c?.name || '')));
}
function classLevel(pc, name) {
  const re = new RegExp(`^${name}$`, 'i');
  for (const c of (pc?.classes || [])) {
    if (re.test(String(c?.name || ''))) return c.level || 0;
  }
  return 0;
}

/** Is `target` a "valid sneak attack victim" right now? */
function sneakAttackEligible({ self, target, allies, weapon }) {
  if (!weapon) return false;
  const name = String(weapon.name || '').toLowerCase();
  // Finesse OR ranged weapon required for SA (PHB p96)
  const isFinesse = /dagger|rapier|scimitar|shortsword|whip|finesse/.test(name);
  const isRanged  = /shortbow|longbow|crossbow|dart|sling|hand crossbow/.test(name);
  if (!isFinesse && !isRanged) return false;
  // Advantage source: any ally within 5ft of the target. (We don't track
  // every advantage source here; this catches the canonical flank
  // condition Rogues build around.)
  const tp = target?._position || target?.position;
  if (!tp) return false;
  for (const a of (allies || [])) {
    if (!a || a === self) continue;
    const ap = a._position || a.position;
    if (!ap) continue;
    if (chebyshevFeet(ap, tp) <= 5) return true;
  }
  return false;
}

/**
 * Registry of class features the AI can reason about. Keep additive
 * — each feature is independent. Order doesn't matter; consume() is
 * always called on the winning option's chosen features.
 */
export const PC_FEATURES = {
  'sneak-attack': {
    id: 'sneak-attack',
    label: 'Sneak Attack',
    available(pc) {
      // Available once per turn — flagged on the entity wrapper after use
      return hasClass(pc, 'Rogue') && !pc._sneakAttackUsedThisTurn;
    },
    scoreBoost(option, ctx) {
      if (option.kind !== 'melee' && option.kind !== 'ranged') return 0;
      const eligible = sneakAttackEligible({
        self: ctx.self, target: ctx.target,
        allies: ctx.allies, weapon: option.weapon
      });
      if (!eligible) return 0;
      // Sneak Attack dice scale with rogue level (1d6 per 2 levels). The
      // boost reflects the *extra damage* expected from firing the rider.
      const lvl = classLevel(ctx.self?.ref || ctx.self, 'Rogue');
      const dice = Math.max(1, Math.ceil(lvl / 2));
      return Math.min(1.5, dice * 0.25);
    },
    consume(pc) { pc._sneakAttackUsedThisTurn = true; }
  },

  'action-surge': {
    id: 'action-surge',
    label: 'Action Surge',
    available(pc) {
      // Fighter level 2+; 2 uses per short rest at lvl 17, otherwise 1
      const lvl = classLevel(pc, 'Fighter');
      if (lvl < 2) return false;
      const max = lvl >= 17 ? 2 : 1;
      return (pc._actionSurgeUsed ?? 0) < max;
    },
    scoreBoost(option, ctx) {
      // Surge is a meta-action that GRANTS another action this turn.
      // Boost any melee/ranged plan when target is bloodied (kill window)
      // OR when the target is a caster (interrupt concentration / kill it).
      if (option.kind !== 'melee' && option.kind !== 'ranged') return 0;
      const t = ctx.target;
      const hp = typeof t?.hp === 'number' ? t.hp : t?.hp?.current;
      const hpMax = t?.hpMax ?? t?.hp?.max ?? 1;
      const bloodied = hp > 0 && (hp / hpMax) <= 0.5;
      const targetIsCaster = !!(t?.ref?.spells && Object.keys(t.ref.spells).length);
      if (bloodied || targetIsCaster) return 0.8;
      return 0;
    },
    consume(pc) { pc._actionSurgeUsed = (pc._actionSurgeUsed ?? 0) + 1; pc._extraActionThisTurn = true; }
  },

  'cunning-action': {
    id: 'cunning-action',
    label: 'Cunning Action',
    available(pc) {
      return classLevel(pc, 'Rogue') >= 2 && !pc._cunningActionUsedThisTurn;
    },
    scoreBoost(option, ctx) {
      // Disengage is much more valuable for a rogue surrounded by enemies.
      if (option.kind !== 'disengage') return 0;
      return ctx.hostileAdjacent ? 0.8 : 0;
    },
    consume(pc) { pc._cunningActionUsedThisTurn = true; }
  },

  'second-wind': {
    id: 'second-wind',
    label: 'Second Wind',
    available(pc) {
      return hasClass(pc, 'Fighter') && !pc._secondWindUsed;
    },
    scoreBoost(option, ctx) {
      // Self-heal as a bonus action. We surface it as an option only
      // when self is bloodied (< 50% hp).
      if (option.kind !== 'feature' || option.featureId !== 'second-wind') return 0;
      const hp = typeof ctx.self?.hp === 'number' ? ctx.self.hp : ctx.self?.hp?.current;
      const max = ctx.self?.hpMax ?? ctx.self?.hp?.max ?? 1;
      if (max > 0 && hp / max < 0.5) return 1.0;
      return 0;
    },
    consume(pc) { pc._secondWindUsed = true; }
  },

  // M42.1 — Divine Smite (PHB p85). After a paladin lvl 2+ hits with
  // a melee weapon attack, they may expend a spell slot to deal
  // radiant damage (2d8 + 1d8/slot above 1st, max 5d8, +1d8 vs
  // fiends/undead). This feature flags the attack at AI-decision time;
  // the simulator's runOneAttack applies the dice after the hit lands.
  'divine-smite': {
    id: 'divine-smite',
    label: 'Divine Smite',
    available(pc) {
      // Paladin lvl 2+, has at least one slot (any level — we burn the
      // lowest-level slot that satisfies the chosen smite level)
      if (classLevel(pc, 'Paladin') < 2) return false;
      const slots = pc._slots || {};
      for (let i = 1; i <= 5; i++) if ((slots[i] ?? 0) > 0) return true;
      return false;
    },
    scoreBoost(option, ctx) {
      if (option.kind !== 'melee') return 0;
      // Smite math: 2d8 base = ~9 dmg, +1d8 per upcast. Paladins
      // usually smite freely when they have slots to burn, more
      // eagerly on high-value targets. Slot economy is the gate.
      const t = ctx.target;
      const hp = typeof t?.hp === 'number' ? t.hp : t?.hp?.current;
      const hpMax = t?.hpMax ?? t?.hp?.max ?? 1;
      const frac = hp > 0 ? hp / hpMax : 1;
      const targetIsCaster = !!(t?.ref?.spells && Object.keys(t.ref.spells).length);
      const slots = ctx.self._slots || ctx.self.ref?._slots || {};
      const totalSlots = Object.values(slots).reduce((s, n) => s + (n || 0), 0);
      if (totalSlots <= 0) return 0;
      // Base fire-when-you-have-slots boost. Scales with slot supply.
      let boost = totalSlots >= 3 ? 0.45 : totalSlots >= 2 ? 0.30 : 0.15;
      // Kill-window bonus on top
      if (frac <= 0.3) boost += 0.4;
      else if (frac <= 0.5) boost += 0.2;
      if (targetIsCaster) boost += 0.2;
      return boost;
    },
    consume(pc) {
      // Pick the slot via MCTS-style lookahead: 2d8 base + 1d8 per
      // upcast (max 5d8). Cheap shallow rollout estimates which slot
      // tier maximizes expected encounter value given the current
      // target HP and slot economy. If MCTS pool is empty, falls back
      // to the lowest available slot (cheapest baseline).
      const slots = pc._slots || {};
      const choice = pickSmiteSlot(pc, slots);
      if (choice && (slots[choice] ?? 0) > 0) {
        slots[choice] -= 1;
        pc._smiteSlotUsed = choice;
        return;
      }
      for (let i = 1; i <= 5; i++) {
        if ((slots[i] ?? 0) > 0) { slots[i] -= 1; pc._smiteSlotUsed = i; return; }
      }
    }
  },

  // M42.1 — Reckless Attack (PHB p48). Barbarian lvl 1+. Once per
  // turn: a STR-based melee attack rolls with advantage; ALL attacks
  // against the barbarian have advantage until their next turn.
  'reckless-attack': {
    id: 'reckless-attack',
    label: 'Reckless Attack',
    available(pc) {
      return classLevel(pc, 'Barbarian') >= 1 && !pc._recklessUsedThisTurn;
    },
    scoreBoost(option, ctx) {
      if (option.kind !== 'melee') return 0;
      // Only worth the downside when offense matters. Boost when the
      // target is bloodied (kill window) or when the barb is at full HP
      // (can afford the return-fire advantage).
      const t = ctx.target;
      const hp = typeof t?.hp === 'number' ? t.hp : t?.hp?.current;
      const hpMax = t?.hpMax ?? t?.hp?.max ?? 1;
      const targetBloodied = hp > 0 && hp / hpMax <= 0.5;
      const selfHp = typeof ctx.self?.hp === 'number' ? ctx.self.hp : ctx.self?.hp?.current;
      const selfMax = ctx.self?.hpMax ?? 1;
      const selfHealthy = selfMax > 0 && selfHp / selfMax >= 0.7;
      if (targetBloodied || selfHealthy) return 0.6;
      return 0;
    },
    consume(pc) {
      pc._recklessUsedThisTurn = true;
      // Resolver reads this flag to grant advantage on attack rolls AND
      // to grant attackers advantage against this PC until next turn.
      pc._recklessUntilNextTurn = true;
    }
  }
};

/** Pull the list of features this PC currently has access to. */
export function availableFeatures(pc) {
  return Object.values(PC_FEATURES).filter(f => f.available(pc));
}

/** Refresh per-turn feature flags (cunning action, sneak attack window). */
export function resetPerTurnFlags(pc) {
  if (!pc) return;
  pc._sneakAttackUsedThisTurn = false;
  pc._cunningActionUsedThisTurn = false;
  pc._extraActionThisTurn = false;
}

/** Refresh per-encounter / short-rest flags (action surge, second wind). */
export function resetPerEncounterFlags(pc) {
  if (!pc) return;
  pc._actionSurgeUsed = 0;
  pc._secondWindUsed = false;
}
