/**
 * M41 — Legendary actions.
 *
 * High-CR monsters (dragons, liches, vampires) get to act *outside*
 * their own turn. The 5e rule: each legendary creature has a budget of
 * legendary actions per round (typically 3). They can spend that budget
 * after another creature ends its turn. Different actions cost
 * different amounts.
 *
 *   Budget resets at the start of the legendary creature's own turn.
 *   Actions can't be used by an incapacitated creature.
 *
 * This module is the pure engine: registry, fresh-budget helpers, the
 * "pick the best action right now" decision. The caller (simulator or
 * versus auto-fight) drives the end-of-turn tick.
 *
 * Out of scope (M41.1+):
 *   - Detect actions (flavor; no combat effect).
 *   - "Spend a legendary action on a recharged ability" cross-system
 *     interaction (e.g. spending an LA to use a recharged breath weapon).
 */

import { chebyshevFeet } from './grid-rules.js';

/** Registry: per-slug legendary action menu. */
export const LEGENDARY_ACTIONS = {
  'young-dragon': {
    budget: 3,
    actions: [
      {
        id: 'tail-attack',
        name: 'Tail Attack',
        cost: 1,
        kind: 'melee-attack',
        range: 15,                  // tail reach
        attackBonus: 7,             // matches young-dragon attack
        dice: '2d8+4',
        damageType: 'Bludgeoning'
      },
      {
        id: 'wing-attack',
        name: 'Wing Attack',
        cost: 2,
        kind: 'aoe-save',
        range: 15,                  // 15ft radius around the dragon
        saveStat: 'STR',
        dc: 14,
        dice: '2d6+4',
        damageType: 'Bludgeoning'
      }
    ]
  }
};

export function isLegendary(slug) { return !!LEGENDARY_ACTIONS[slug]; }
export function legendaryBlockFor(slug) { return LEGENDARY_ACTIONS[slug] || null; }
export function freshLegendaryBudget(slug) {
  const block = LEGENDARY_ACTIONS[slug];
  if (!block) return 0;
  return block.budget;
}

/**
 * Refresh the legendary budget at the start of this monster's turn.
 * Pure mutation on the entity wrapper.
 */
export function resetLegendaryBudget(monster) {
  if (!monster) return;
  const slug = monster.presetSlug || monster._presetSlug;
  monster._legendaryBudget = freshLegendaryBudget(slug);
}

/**
 * Pick the best legendary action this monster could spend NOW. The
 * decision is greedy — the highest-cost action whose cost fits the
 * remaining budget AND has a valid target wins. Returns null when no
 * action is usable.
 *
 * @returns {{ action, target?: object } | null}
 */
export function chooseLegendaryAction({ self, enemies = [] } = {}) {
  if (!self) return null;
  const slug = self.presetSlug || self._presetSlug;
  const block = LEGENDARY_ACTIONS[slug];
  if (!block) return null;
  if (isIncapacitated(self)) return null;
  const budget = self._legendaryBudget ?? 0;
  if (budget <= 0) return null;

  const live = enemies.filter(e => hpOf(e) > 0);
  if (live.length === 0) return null;
  const selfPos = self._position || self.position;

  // Greedy: walk actions by cost-descending so we always burn the
  // beefiest legal option first. Each action contributes 0 score if it
  // has no valid target.
  const ordered = block.actions.slice().sort((a, b) => b.cost - a.cost);
  for (const action of ordered) {
    if (action.cost > budget) continue;
    if (action.kind === 'melee-attack') {
      const target = nearestInRange(selfPos, live, action.range);
      if (!target) continue;
      return { action, target };
    }
    if (action.kind === 'aoe-save') {
      // AoE only worth spending when there's at least one enemy in range.
      const hits = live.filter(e => {
        const ep = e._position || e.position;
        if (!ep) return false;
        return chebyshevFeet(selfPos, ep) <= action.range;
      });
      if (hits.length === 0) continue;
      return { action, targets: hits };
    }
  }
  return null;
}

/** Burn the budget for a chosen action. Idempotent on a null action. */
export function spendLegendaryAction(self, action) {
  if (!self || !action) return;
  self._legendaryBudget = Math.max(0, (self._legendaryBudget ?? 0) - action.cost);
}

// ---------- helpers ----------

function hpOf(e) {
  if (!e) return 0;
  if (typeof e.hp === 'number') return e.hp;
  return e.hp?.current ?? 0;
}

function isIncapacitated(e) {
  const c = e.conditions || [];
  return c.includes('paralyzed') || c.includes('stunned') ||
         c.includes('unconscious') || c.includes('petrified');
}

function nearestInRange(selfPos, candidates, reach) {
  if (!selfPos) return null;
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const cp = c._position || c.position;
    if (!cp) continue;
    const d = chebyshevFeet(selfPos, cp);
    if (d > reach) continue;
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}
