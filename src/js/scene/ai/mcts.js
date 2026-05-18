/**
 * M42.2 — Shallow Monte Carlo Tree Search for resource decisions.
 *
 * Utility AI (M32, M42) picks "the best action right now" but is blind
 * to the future cost of resources. MCTS fixes that: for each candidate
 * action that BURNS a resource (smite slot, action surge, upcast slot),
 * we forward-simulate a few random-policy rollouts and average the
 * resulting outcomes. The action with the best expected value wins.
 *
 * Why shallow:
 *   - Full-game MCTS would mean running the simulator inside the AI's
 *     decision step. Too expensive (200 sims × 5 candidates × N rounds).
 *   - For one-action turns in 5e, 1-2 ply with a handful of rollouts
 *     captures most of the value ("does smite now hasten the kill
 *     enough to be worth the slot?").
 *
 * Scope (v1):
 *   - Used by choosePcAction for explicit resource decisions: Divine
 *     Smite (which slot to burn) and upcasting (Magic Missile @ 1 vs 3).
 *   - Pure function. Takes a `rollout` callback so the simulator (or a
 *     mock) can plug in its own forward-step.
 *   - Deterministic with injectable rng.
 *
 * Out of scope:
 *   - Full game-tree MCTS with UCT exploration. Our search horizon is
 *     too short to need PUCT-style exploration.
 *   - Caching across turns (a real MCTS would reuse the tree). Each
 *     turn is independent for our purposes.
 */

/**
 * @typedef {object} Candidate
 * @property {string} id        — opaque identifier
 * @property {number} baseScore — pre-MCTS utility score
 * @property {*}      [data]    — caller-defined payload (e.g. slot level)
 */

/**
 * Run MCTS over a candidate list. For each candidate, call
 *   rollout(candidate, { rng, depth })
 * `rollouts` times. Average the returned values, add to baseScore,
 * sort, return the list (mutated in-place with `.mctsValue`).
 *
 * The rollout callback is responsible for the actual forward-simulation
 * — this module just orchestrates the search.
 *
 * @param {object} args
 * @param {Candidate[]} args.candidates
 * @param {function}    args.rollout      — (candidate, {rng,depth}) → number
 * @param {number}      [args.rollouts]   — per candidate, default 6
 * @param {number}      [args.depth]      — plies to look ahead, default 2
 * @param {function}    [args.rng]        — RNG; defaults to Math.random
 * @returns {Candidate[]} sorted by descending total value
 */
export function mctsEvaluate({ candidates, rollout, rollouts = 6, depth = 2, rng = Math.random } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (typeof rollout !== 'function') return candidates.slice();
  for (const cand of candidates) {
    let total = 0;
    for (let i = 0; i < rollouts; i++) {
      const v = rollout(cand, { rng, depth });
      if (Number.isFinite(v)) total += v;
    }
    cand.mctsValue = total / Math.max(1, rollouts);
    cand.totalValue = (cand.baseScore || 0) + cand.mctsValue;
  }
  return candidates.slice().sort((a, b) => b.totalValue - a.totalValue);
}

/**
 * A reusable rollout helper for "should I burn a slot now?" decisions.
 * Estimates expected damage saved over the remaining turns by killing
 * the target faster vs the resource cost of the burn.
 *
 *   damageDelta — extra damage this action does vs the no-burn baseline
 *                 (e.g. 2d8 ≈ 9 for a smite)
 *   targetHp    — current HP of the target
 *   targetDpr   — target's damage-per-round output if it survives
 *   roundsLeft  — estimated turns until end of fight
 *   resourceTax — opportunity cost in "future damage" units of the
 *                 burned resource (set higher when slot is scarce)
 *
 * Returns a scalar value: higher = better to burn now.
 */
export function estimateBurnValue({
  damageDelta = 0, targetHp = 1, targetDpr = 0,
  roundsLeft = 3, resourceTax = 0
} = {}) {
  // If the extra damage finishes the target, save roundsLeft*targetDpr
  // damage to the party.
  const killBonus = damageDelta >= targetHp ? roundsLeft * targetDpr : 0;
  // Otherwise, the action shortens the fight roughly proportionally.
  const shortenBonus = damageDelta < targetHp
    ? (damageDelta / Math.max(1, targetHp)) * targetDpr
    : 0;
  return killBonus + shortenBonus - resourceTax;
}

/**
 * For the simulator: a tiny single-ply rollout that asks "if I spend
 * this slot now, how much damage do I expect to do (this attack) AND
 * how much pressure do I take off the party (target's potential
 * future output)?".
 *
 * The caller passes the target + a slot-economy estimate; we return a
 * scalar so mctsEvaluate can rank candidates.
 */
export function shallowRolloutForResource({ candidate, ctx } = {}) {
  if (!candidate || !ctx) return 0;
  const { target, roundsLeft = 3, slotPool = 0 } = ctx;
  const damageDelta = candidate.expectedExtraDamage || 0;
  const targetHp = typeof target?.hp === 'number' ? target.hp : (target?.hp?.current ?? 0);
  const targetDpr = ctx.targetDpr ?? estimateTargetDpr(target);
  // Slot scarcity penalty — each remaining slot is worth ~5 damage of
  // future leverage. Spending the last one is much more costly.
  const resourceTax = slotPool <= 1 ? 6 : slotPool <= 2 ? 3 : 1;
  return estimateBurnValue({
    damageDelta, targetHp, targetDpr, roundsLeft, resourceTax
  });
}

/** Rough DPR estimate from a monster's preset attack record. */
function estimateTargetDpr(target) {
  if (!target) return 0;
  const atk = target.attack;
  if (!atk?.dice) return 0;
  // Parse "1d8+3" or "2d6+4" — average = (n*(d+1)/2) + mod
  const m = String(atk.dice).match(/^(\d+)d(\d+)([+-]\d+)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const d = Number(m[2]);
  const mod = Number(m[3] || 0);
  // Assume 60% hit rate
  return 0.6 * (n * (d + 1) / 2 + mod);
}
