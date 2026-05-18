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
