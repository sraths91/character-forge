/**
 * M32 — Considerations library for the per-monster AI.
 *
 * Each consideration is a pure function `(ctx) -> number in [0..1]` that
 * describes a single, named *preference signal* (e.g. "how much do I like
 * targets that are bloodied?"). Profiles weight each consideration with a
 * positive or negative coefficient and a curve; the engine sums them per
 * candidate target to pick an action.
 *
 * Inputs (ctx) are the simulator's internal entity shape:
 *   self     — { id, hp, hpMax, _position?, position?, kind, ... }
 *   target   — same shape (the enemy under evaluation)
 *   allies   — array of self's allies (excludes self)
 *   enemies  — array of all live enemies (incl. target)
 *
 * Curves shape the raw 0..1 signal: linear (identity), step (>=0.5 → 1
 * else 0), quadratic (x^2), inverse (1-x). Profiles select a curve per
 * consideration; the engine applies it before multiplying by weight.
 */

import { chebyshevFeet } from '../grid-rules.js';

function posOf(e) { return e?._position || e?.position || null; }
// Accept both shapes:
//   simulator: { hp: number, hpMax: number }
//   live UI:   { hp: { current, max } }
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
function fracHp(e) {
  const max = hpMaxOf(e);
  if (!max) return 1;
  return Math.max(0, Math.min(1, hpOf(e) / max));
}
function adjacent(a, b) {
  const pa = posOf(a), pb = posOf(b);
  if (!pa || !pb) return false;
  return chebyshevFeet(pa, pb) <= 5;
}

// ---------- Considerations (each returns 0..1) ----------

export const CONSIDERATIONS = {
  /** Higher when target is at low HP. Bloodied target → ~0.5, downed → 1. */
  target_low_hp: ({ target }) => 1 - fracHp(target),

  /** Step: 1 if target is at or below half HP, else 0. */
  target_is_bloodied: ({ target }) => fracHp(target) <= 0.5 ? 1 : 0,

  /** Step: 1 if target has any spell list / cantrips, else 0. */
  target_is_caster: ({ target }) => {
    const ref = target?.ref || target;
    if (!ref) return 0;
    const spells = ref.spells;
    if (Array.isArray(spells) && spells.length > 0) return 1;
    if (spells && typeof spells === 'object' && Object.keys(spells).length > 0) return 1;
    return 0;
  },

  /** Higher when the target is closer. 5ft → 1, 60ft → 0. */
  distance_to_target: ({ self, target }) => {
    const d = chebyshevFeet(posOf(self), posOf(target));
    if (!Number.isFinite(d)) return 0;
    return Math.max(0, 1 - d / 60);
  },

  /** Step: 1 if any ally is within 5ft of self. */
  has_adjacent_ally: ({ self, allies }) =>
    (allies || []).some(a => alive(a) && adjacent(self, a)) ? 1 : 0,

  /** Step: 1 if no ally is within 10ft of self. */
  self_isolated: ({ self, allies }) => {
    const pos = posOf(self);
    if (!pos) return 0;
    const near = (allies || []).some(a => {
      if (!alive(a)) return false;
      const ap = posOf(a);
      return ap && chebyshevFeet(pos, ap) <= 10;
    });
    return near ? 0 : 1;
  },

  /** Step: 1 if self.hp <= half max. */
  self_bloodied: ({ self }) => fracHp(self) <= 0.5 ? 1 : 0,

  /** Step: 1 if any ally is adjacent to the target (Pack Tactics-style). */
  pack_tactics_active: ({ target, allies }) =>
    (allies || []).some(a => alive(a) && adjacent(a, target)) ? 1 : 0,

  /** Step: 1 if the target has the "prone" condition. */
  target_prone: ({ target }) =>
    (target?.conditions || []).includes('prone') ? 1 : 0,

  /** Higher when target's AC is low (1 - clamped(AC/20)). */
  target_low_ac: ({ target }) => {
    const ac = target?.ac ?? 12;
    return Math.max(0, 1 - ac / 20);
  }
};

// ---------- Curves ----------

const CURVES = {
  linear:    x => x,
  step:      x => x >= 0.5 ? 1 : 0,
  quadratic: x => x * x,
  inverse:   x => 1 - x
};

/**
 * Evaluate one consideration with a profile entry.
 *   entry = { weight, curve } OR a bare number (treated as weight, linear).
 *   ctx   = { self, target, allies, enemies }
 * Returns { name, raw, curved, weighted }.
 */
export function scoreConsideration(name, entry, ctx) {
  const fn = CONSIDERATIONS[name];
  if (!fn) return { name, raw: 0, curved: 0, weighted: 0 };
  const weight = typeof entry === 'number' ? entry : (entry?.weight ?? 0);
  const curveName = typeof entry === 'number' ? 'linear' : (entry?.curve || 'linear');
  const curve = CURVES[curveName] || CURVES.linear;
  const raw = clamp01(fn(ctx));
  const curved = clamp01(curve(raw));
  return { name, raw, curved, weighted: curved * weight };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
