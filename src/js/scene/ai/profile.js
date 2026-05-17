/**
 * M32 — chooseAction engine.
 *
 * Given a monster (`self`), the live enemies it can see, and its allies,
 * decide what to do this turn. Output is an "action plan" the simulator
 * (or versus auto-fight) consumes; the engine itself doesn't mutate
 * anything.
 *
 * Decision flow:
 *   1. Flee check — if self.hp/hpMax < profile.retreat_below_hp, return
 *      a 'flee' action targeting the nearest enemy (the simulator
 *      inverts the move direction).
 *   2. Score every alive enemy with profile.considerations. Each
 *      consideration produces a 0..1 raw signal, gets curved, multiplied
 *      by its weight, and summed. Highest-scoring target wins.
 *   3. Return { kind, targetId, archetype, score, breakdown } where
 *      `breakdown` is an array of {name, raw, weighted} entries so the
 *      roll log + tooltips can show the reasoning (M19 theme).
 *
 * Pure module — no DOM, no RNG required (we use deterministic scoring;
 * RNG only enters for tie-breaks, accepted via param so tests stay
 * deterministic).
 */

import { scoreConsideration } from './considerations.js';
import { profileFor } from './profiles.js';
import { chebyshevFeet } from '../grid-rules.js';

function posOf(e) { return e?._position || e?.position || null; }
function hpOf(e) {
  if (!e) return 0;
  if (typeof e.hp === 'number') return e.hp;
  return e.hp?.current ?? 0;
}
function hpMaxOf(e) {
  if (!e) return 1;
  if (Number.isFinite(e.hpMax)) return e.hpMax;
  return e.hp?.max ?? 1;
}
function alive(e) { return e && hpOf(e) > 0; }

/**
 * @param {object} args
 * @param {object} args.self     — simulator-shape entity (monster)
 * @param {string} [args.slug]   — preset slug; defaults to self.presetSlug
 * @param {object[]} args.enemies
 * @param {object[]} args.allies
 * @param {function} [args.rng]  — () -> [0,1), for tie-break only
 * @returns {{kind:'attack'|'flee', targetId:string|null, archetype:string,
 *           score:number, breakdown:Array<{name:string,raw:number,weighted:number}>}}
 */
export function chooseAction({ self, slug, enemies, allies, rng = Math.random } = {}) {
  const profile = profileFor(slug || self?.presetSlug);
  const archetype = profile.archetype;
  const liveEnemies = (enemies || []).filter(alive);
  if (liveEnemies.length === 0) {
    return { kind: 'attack', targetId: null, archetype, score: 0, breakdown: [] };
  }

  // 1. Flee check
  const selfHp = hpOf(self);
  const selfMax = hpMaxOf(self);
  if (profile.retreat_below_hp > 0 && selfMax > 0) {
    const frac = selfHp / selfMax;
    if (frac < profile.retreat_below_hp) {
      const nearest = nearestEnemy(self, liveEnemies);
      return {
        kind: 'flee',
        targetId: nearest?.id ?? null,
        archetype,
        score: 0,
        breakdown: [{
          name: 'retreat_below_hp',
          raw: frac,
          weighted: profile.retreat_below_hp,
          note: `hp ${selfHp}/${selfMax} < ${(profile.retreat_below_hp*100)|0}%`
        }]
      };
    }
  }

  // 2. Score every enemy with the profile's considerations
  let best = null;
  for (const target of liveEnemies) {
    const ctx = { self, target, allies: allies || [], enemies: liveEnemies };
    let total = 0;
    const breakdown = [];
    for (const [name, entry] of Object.entries(profile.considerations || {})) {
      const piece = scoreConsideration(name, entry, ctx);
      total += piece.weighted;
      // Only surface non-zero contributions to keep the log readable
      if (Math.abs(piece.weighted) > 0.0001) {
        breakdown.push({ name: piece.name, raw: piece.raw, weighted: piece.weighted });
      }
    }
    if (!best || total > best.score ||
        (total === best.score && rng() < 0.5)) {
      best = { target, score: total, breakdown };
    }
  }

  return {
    kind: 'attack',
    targetId: best.target.id,
    archetype,
    score: best.score,
    breakdown: best.breakdown
  };
}

function nearestEnemy(self, enemies) {
  const sp = posOf(self);
  if (!sp) return enemies[0] || null;
  let best = null;
  let bestD = Infinity;
  for (const e of enemies) {
    const d = chebyshevFeet(sp, posOf(e));
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

/**
 * Compute a "flee toward" target cell for the planMovement step: a point
 * on the opposite side of the grid from the threat, clamped to bounds.
 * The simulator passes this to planMovement instead of the threat's pos.
 */
export function fleeTargetCell(self, threat, bounds = { cols: 10, rows: 10 }) {
  const sp = posOf(self), tp = posOf(threat);
  if (!sp || !tp) return sp;
  const dc = Math.sign(sp.col - tp.col) || (Math.random() < 0.5 ? -1 : 1);
  const dr = Math.sign(sp.row - tp.row) || (Math.random() < 0.5 ? -1 : 1);
  return {
    col: clampInt(sp.col + dc * 6, 0, (bounds.cols || 10) - 1),
    row: clampInt(sp.row + dr * 6, 0, (bounds.rows || 10) - 1)
  };
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/**
 * Pretty-print the breakdown for the roll log. Returns "considerations: A(+0.42), B(-0.31)".
 */
export function formatBreakdown(plan) {
  if (!plan || !plan.breakdown || plan.breakdown.length === 0) return '';
  const parts = plan.breakdown
    .map(b => `${b.name}(${b.weighted >= 0 ? '+' : ''}${b.weighted.toFixed(2)})`)
    .join(', ');
  return `${plan.archetype}: ${parts}`;
}
