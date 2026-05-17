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
  // Disengage suppresses every OA from this move (PHB p192).
  if (mover._disengaged) return [];
  if (before.col === after.col && before.row === after.row) return [];

  const triggers = [];
  for (const h of hostiles) {
    if (!hasReactionAvailable(h)) continue;
    const hp = h._position || h.position;
    if (!hp) continue;
    const reach = meleeReachFt(weaponOf(h));
    const wasInReach = chebyshevFeet(hp, before) <= reach;
    const isInReach  = chebyshevFeet(hp, after)  <= reach;
    if (wasInReach && !isInReach) {
      triggers.push({ triggerer: h, reason: 'left-reach' });
    }
  }
  return triggers;
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
