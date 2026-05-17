/**
 * M33 — Reactions: infrastructure + trigger detection.
 *
 * 5e gives every creature one reaction per round (PHB p190). A reaction
 * is consumed when it triggers and refreshes at the start of the
 * creature's next turn. The opportunity attack (PHB p195) is the
 * universal melee reaction: when a hostile leaves your reach without
 * using the Disengage action, you can spend your reaction to make one
 * melee attack against them.
 *
 * This module is the *infrastructure* layer:
 *   - Per-entity reaction budget (resetReaction / hasReactionAvailable /
 *     consumeReaction). State lives on each entity as `_reactionUsed`.
 *   - Trigger detection for the move-out-of-reach event
 *     (detectOpportunityAttacks). Pure function; returns a list of
 *     hostiles whose reactions should fire.
 *
 * No DOM, no logging, no actual attack rolls. The caller (simulator
 * or versus auto-fight) is responsible for running the resulting
 * attack(s) through the existing resolver.
 */

import { chebyshevFeet, meleeReachFt } from './grid-rules.js';

const INCAPACITATING_CONDITIONS = ['incapacitated', 'paralyzed', 'stunned', 'unconscious', 'petrified'];

/** Mark entity's reaction as available again. Call at the start of its turn. */
export function resetReaction(entity) {
  if (!entity) return;
  entity._reactionUsed = false;
}

/** Mark every entity's reaction as available. Useful at top-of-round. */
export function resetReactionsForAll(entities) {
  for (const e of (entities || [])) resetReaction(e);
}

/** Whether this entity is *able* to take a reaction right now. */
export function hasReactionAvailable(entity) {
  if (!entity) return false;
  if (entity._reactionUsed) return false;
  const conds = entity.conditions || [];
  for (const c of INCAPACITATING_CONDITIONS) {
    if (conds.includes(c)) return false;
  }
  return true;
}

/** Burn the reaction. Idempotent. */
export function consumeReaction(entity) {
  if (!entity) return;
  entity._reactionUsed = true;
}

/**
 * Detect opportunity-attack triggers for a single move step.
 *
 * Returns an array of { triggerer, reason } — each `triggerer` is a
 * hostile entity whose reaction would fire on this movement. The caller
 * decides whether to resolve them and is responsible for calling
 * consumeReaction() afterwards.
 *
 * @param {object} args
 * @param {object} args.mover      — entity that's moving
 * @param {{col,row}} args.before  — start cell
 * @param {{col,row}} args.after   — end cell
 * @param {object[]} args.hostiles — entities on the opposing side
 * @returns {Array<{triggerer:object, reason:string}>}
 */
export function detectOpportunityAttacks({ mover, before, after, hostiles = [] } = {}) {
  if (!mover || !before || !after) return [];
  if (before.col === after.col && before.row === after.row) return [];
  const disengaged = !!mover._disengaged;

  const triggers = [];
  for (const h of hostiles) {
    if (!hasReactionAvailable(h)) continue;
    const hp = h._position || h.position;
    if (!hp) continue;
    const reach = meleeReachFt(weaponOf(h));
    const wasInReach = chebyshevFeet(hp, before) <= reach;
    const isInReach  = chebyshevFeet(hp, after)  <= reach;
    if (!wasInReach || isInReach) continue;
    // M33.2 — Disengage normally suppresses every OA (PHB p192), but
    // Sentinel (PHB p169) explicitly overrides this for hostiles within
    // 5ft of the mover's starting cell.
    if (disengaged) {
      if (!hasSentinel(h) || chebyshevFeet(hp, before) > 5) continue;
    }
    triggers.push({ triggerer: h, reason: 'left-reach' });
  }
  return triggers;
}

/**
 * M33.2 — Polearm Master entry OAs (PHB p168).
 *
 * "While wielding a glaive, halberd, pike, or quarterstaff, other
 *  creatures provoke an opportunity attack from you when they enter
 *  your reach."
 *
 * Detects hostiles who have the feat, are wielding a qualifying
 * polearm, were NOT in reach at `before`, and ARE in reach at `after`.
 */
export function detectPolearmEntryOAs({ mover, before, after, hostiles = [] } = {}) {
  if (!mover || !before || !after) return [];
  if (before.col === after.col && before.row === after.row) return [];
  const triggers = [];
  for (const h of hostiles) {
    if (!hasReactionAvailable(h)) continue;
    if (!hasPolearmMaster(h)) continue;
    const wpn = weaponOf(h);
    if (!isPolearmWeapon(wpn)) continue;
    const hp = h._position || h.position;
    if (!hp) continue;
    const reach = meleeReachFt(wpn);
    const wasInReach = chebyshevFeet(hp, before) <= reach;
    const isInReach  = chebyshevFeet(hp, after)  <= reach;
    if (!wasInReach && isInReach) {
      triggers.push({ triggerer: h, reason: 'entered-reach-PAM' });
    }
  }
  return triggers;
}

/** Read a feat-name list off any entity-shape we use. Case-insensitive. */
function readFeats(entity) {
  const ref = entity?.ref || entity;
  if (!ref) return [];
  if (Array.isArray(ref.feats)) return ref.feats;
  if (Array.isArray(entity?.feats)) return entity.feats;
  return [];
}
function hasFeat(entity, namePattern) {
  for (const f of readFeats(entity)) {
    const name = typeof f === 'string' ? f : (f?.name || '');
    if (namePattern.test(String(name))) return true;
  }
  return false;
}
export function hasSentinel(entity) { return hasFeat(entity, /sentinel/i); }
export function hasPolearmMaster(entity) { return hasFeat(entity, /polearm\s*master/i); }

/** Is this weapon one of the four polearms PAM keys off? */
export function isPolearmWeapon(weapon) {
  if (!weapon) return false;
  const name = String(weapon.name || '').toLowerCase();
  return /\b(glaive|halberd|pike|quarterstaff)\b/.test(name);
}

function weaponOf(entity) {
  if (!entity) return null;
  // simulator-shape PCs
  if (entity.weapon) return entity.weapon;
  // simulator-shape monsters
  if (entity.attack?.name) return { name: entity.attack.name };
  // raw character refs
  if (entity.equipment?.mainhand) return entity.equipment.mainhand;
  // live-scene monster instances
  if (entity._presetSlug || entity.presetSlug) return null;
  return null;
}

// =====================================================================
// M33.1 — Shield (1st-level wizard/sorcerer reaction, PHB p275)
//
// Cast as a reaction when you are hit by an attack: +5 AC against that
// triggering attack (and against any attacks until your next turn).
// Consumes one 1st-level spell slot.
//
// In the simulator we evaluate Shield AFTER the d20 lands but BEFORE
// damage applies: if the attacker's total >= target.ac AND
// total < target.ac + 5, Shield converts a hit into a miss. If
// total >= target.ac + 5, Shield can't save us, so we don't waste the
// slot.
// =====================================================================

/**
 * Whether `target` would cast Shield to block this hit. Pure check —
 * caller is responsible for consuming the slot + reaction if true.
 */
export function shouldCastShield({ target, attackerTotal, targetAc } = {}) {
  if (!hasReactionAvailable(target)) return false;
  if (!hasShieldSpell(target)) return false;
  if ((target._lvl1Slots ?? 0) <= 0) return false;
  // Only fires when it would actually convert a hit into a miss.
  // Crit hits ignore Shield: crits hit regardless of AC.
  if (attackerTotal < targetAc) return false;
  if (attackerTotal >= targetAc + 5) return false;
  return true;
}

/** Spend a 1st-level slot + the reaction. */
export function consumeShield(target) {
  if (!target) return;
  consumeReaction(target);
  target._lvl1Slots = Math.max(0, (target._lvl1Slots ?? 0) - 1);
  target._shieldActive = true;
}

/** Does this PC know Shield? Reads the DDB-parsed spell list. */
export function hasShieldSpell(entity) {
  const ref = entity?.ref || entity;
  if (!ref) return false;
  const spells = ref.spells;
  if (!spells) return false;
  if (Array.isArray(spells)) return spells.some(matchShield);
  if (typeof spells === 'object') {
    for (const v of Object.values(spells)) {
      if (Array.isArray(v) && v.some(matchShield)) return true;
    }
  }
  return false;
}
function matchShield(s) {
  if (!s) return false;
  const name = typeof s === 'string' ? s : (s.name || '');
  return /^shield$/i.test(String(name).trim());
}

// 5e PHB spell-slot table — 1st-level slots per class level. Rough but
// adequate for v1: full casters peak at 4 lvl-1 slots; half-casters
// don't get any until level 2.
const FULL_CASTER_LVL1 = [0, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
const HALF_CASTER_LVL1 = [0, 0, 2, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
const FULL_CASTERS = new Set(['wizard', 'sorcerer', 'bard', 'cleric', 'druid', 'warlock']);
const HALF_CASTERS = new Set(['paladin', 'ranger', 'artificer']);

/**
 * Estimate the PC's starting 1st-level spell slot pool. Used by the
 * simulator to seed `_lvl1Slots` on each entity wrapper. Returns 0 for
 * non-casters; doesn't account for multiclassing-rule slot stacking.
 */
export function lvl1SlotsForPc(pc) {
  const classes = pc?.classes || [];
  let best = 0;
  for (const c of classes) {
    const name = String(c?.name || '').toLowerCase();
    const lvl = Math.max(0, Math.min(20, c?.level || 0));
    if (FULL_CASTERS.has(name)) best = Math.max(best, FULL_CASTER_LVL1[lvl] || 0);
    else if (HALF_CASTERS.has(name)) best = Math.max(best, HALF_CASTER_LVL1[lvl] || 0);
  }
  return best;
}
