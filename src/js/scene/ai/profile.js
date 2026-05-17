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
import { profileForEntity } from './infer.js';
import { chebyshevFeet } from '../grid-rules.js';
import { spellbookFor, spellById, canCastSpell } from '../monster-spells.js';

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
  // M32.2: prefer a per-entity override (Open5e-inferred profile attached
  // at spawn) over the slug-based lookup.
  const profile = profileForEntity(self) || profileFor(slug || self?.presetSlug);
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

  const meleePlan = {
    kind: 'attack',
    targetId: best.target.id,
    archetype,
    score: best.score,
    breakdown: best.breakdown
  };

  // M34 — Consider casting a spell. We compare each spell's utility
  // (per-target consideration score + the profile's castWeight for it)
  // against the melee plan; the highest score wins. The spellbook +
  // monster spellcasting block live on the entity; profiles describe
  // *preferences* via `castWeights`.
  const spellPlan = considerCast({ self, profile, archetype, target: best.target, enemies: liveEnemies });
  // M34.2 — Also consider ally-targeted heals. The best heal plan
  // competes with the offensive cast and the melee fall-back; highest
  // score wins overall.
  const healPlan = considerHeal({ self, profile, archetype, allies: allies || [] });
  const candidates = [meleePlan, spellPlan, healPlan].filter(Boolean);
  return candidates.reduce((acc, p) => (p.score > acc.score ? p : acc), meleePlan);
}

/**
 * Score the best spell `self` could cast right now against `target`.
 * Returns null if the monster isn't a caster, has no usable spells, or
 * no spell beats the melee score.
 */
function considerCast({ self, profile, archetype, target, enemies }) {
  const slug = self?.presetSlug || self?.ref?._presetSlug;
  const book = spellbookFor(slug);
  if (!book) return null;
  const castWeights = profile.castWeights || {};
  const slots = self?._slots;
  if (!slots) return null;   // simulator hasn't seeded a slot pool

  // Score each spell the monster knows; pick the best one we can cast.
  let bestSpell = null;
  for (const id of book.spells) {
    const weight = castWeights[id];
    if (!weight) continue;             // profile didn't authorize this spell
    const spell = spellById(id);
    if (!spell) continue;
    if (spell.targetSide === 'ally') continue;     // M34.2: heal spells handled separately
    if (!canCastSpell(spell, slots)) continue;
    // Range / line-of-fire: cantrip-save & spell-attack use spell.range;
    // melee spell attacks (range 5) only when adjacent.
    if (!spellInRange(spell, self, target)) continue;
    // Hold Person flavored: don't double-stack on a paralyzed target.
    if (spell.appliesCondition && (target.conditions || []).includes(spell.appliesCondition)) continue;
    const aoeBoost = aoeOpportunity(spell, target, enemies);
    const score = weight + aoeBoost;
    if (!bestSpell || score > bestSpell.score) {
      bestSpell = { id, spell, score, weight, aoeBoost };
    }
  }
  if (!bestSpell) return null;
  return {
    kind: 'cast',
    targetId: target.id,
    spellId: bestSpell.id,
    archetype,
    score: bestSpell.score,
    breakdown: [
      { name: `cast:${bestSpell.spell.name}`, raw: 1, weighted: bestSpell.weight },
      ...(bestSpell.aoeBoost > 0 ? [{ name: 'crowded_target', raw: 1, weighted: bestSpell.aoeBoost }] : [])
    ]
  };
}

function spellInRange(spell, self, target) {
  const sp = posOf(self), tp = posOf(target);
  if (!sp || !tp) return true;
  const dFeet = chebyshevFeet(sp, tp);
  return dFeet <= (spell.range ?? 5);
}

/**
 * M34.2 — Pick the best heal-an-ally cast, if any. The candidate pool
 * is `allies`, scored by "how wounded" they are; the spell must be in
 * range, an ally-targeted heal, and the caster needs the slot.
 */
function considerHeal({ self, profile, archetype, allies }) {
  const slug = self?.presetSlug || self?.ref?._presetSlug;
  const book = spellbookFor(slug);
  if (!book) return null;
  const castWeights = profile.castWeights || {};
  const slots = self?._slots;
  if (!slots) return null;
  const hurt = (allies || []).filter(a => {
    const max = a.hpMax || a.hp?.max || 0;
    const cur = typeof a.hp === 'number' ? a.hp : a.hp?.current;
    return max > 0 && cur > 0 && cur < max;
  });
  if (hurt.length === 0) return null;

  // Pick the most-wounded ally as the heal target.
  let mostHurt = null;
  let mostHurtScore = -1;
  for (const a of hurt) {
    const max = a.hpMax || a.hp?.max || 1;
    const cur = typeof a.hp === 'number' ? a.hp : a.hp?.current;
    const wounded = 1 - cur / max;   // 0..1
    if (wounded > mostHurtScore) {
      mostHurt = a;
      mostHurtScore = wounded;
    }
  }
  if (!mostHurt) return null;

  // Score each known heal spell; require slot + range + targetSide=ally.
  let bestSpell = null;
  for (const id of book.spells) {
    const weight = castWeights[id];
    if (!weight) continue;
    const spell = spellById(id);
    if (!spell || spell.targetSide !== 'ally') continue;
    if (!canCastSpell(spell, slots)) continue;
    if (!spellInRange(spell, self, mostHurt)) continue;
    // ally_bloodied boost: how wounded the target is folds into the score.
    const score = weight + mostHurtScore * 0.5;
    if (!bestSpell || score > bestSpell.score) {
      bestSpell = { id, spell, score, weight };
    }
  }
  if (!bestSpell) return null;
  return {
    kind: 'cast',
    targetId: mostHurt.id,
    spellId: bestSpell.id,
    targetSide: 'ally',
    archetype,
    score: bestSpell.score,
    breakdown: [
      { name: `heal:${bestSpell.spell.name}`, raw: 1, weighted: bestSpell.weight },
      { name: 'ally_bloodied', raw: mostHurtScore, weighted: mostHurtScore * 0.5 }
    ]
  };
}

/** Tiny AoE-cluster heuristic: count hostiles within 10ft of `target`. */
function aoeOpportunity(spell, target, enemies) {
  if (spell.range > 5 && spell.darts) {
    // Magic Missile-shaped: more targets = more value
    return Math.min(0.3, (enemies.length - 1) * 0.1);
  }
  return 0;
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
export function fleeTargetCell(self, threat, bounds = { cols: 10, rows: 10 }, rng = Math.random) {
  const sp = posOf(self), tp = posOf(threat);
  if (!sp || !tp) return sp;
  // When the mover is axis-aligned with the threat, pick a perpendicular
  // direction. The randomness MUST come from the supplied rng so that
  // simulator runs stay deterministic across calls with the same seed.
  const dc = Math.sign(sp.col - tp.col) || (rng() < 0.5 ? -1 : 1);
  const dr = Math.sign(sp.row - tp.row) || (rng() < 0.5 ? -1 : 1);
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
