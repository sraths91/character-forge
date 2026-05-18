/**
 * M42 — choosePcAction.
 *
 * Mirrors chooseAction (the monster decision-maker in profile.js) but
 * for PCs. Walks every ActionOption + every castable spell + every
 * applicable class feature, scores them, returns the winning plan.
 *
 * Plan shape (extends the monster plan shape with PC-specific fields):
 *   {
 *     kind:        'melee' | 'ranged' | 'cast' | 'heal' | 'dash' | 'disengage' | 'dodge',
 *     targetId:    string | null,
 *     weapon?:     object,        // the chosen weapon for melee/ranged
 *     spellId?:    string,
 *     castAtLevel?: number,
 *     featuresFired: string[],    // ids of class features that fire this turn
 *     archetype:   string,
 *     score:       number,
 *     breakdown:   [{name, raw, weighted}]
 *   }
 */

import { profileForPc } from './pc-profiles.js';
import { enumerateActions, gateOk } from './action-options.js';
import { availableFeatures } from './pc-features.js';
import { scoreConsideration } from './considerations.js';
import { chebyshevFeet } from '../grid-rules.js';
import { spellById, canCastSpell, applyUpcast } from '../monster-spells.js';

function posOf(e) { return e?._position || e?.position || null; }
function hpOf(e)  { return typeof e?.hp === 'number' ? e.hp : (e?.hp?.current ?? 0); }
function alive(e) { return e && hpOf(e) > 0; }

/**
 * @param {object} args
 * @param {object} args.self      — PC entity (simulator wrapper or live)
 * @param {object[]} args.enemies
 * @param {object[]} args.allies
 * @param {function} [args.rng]
 */
export function choosePcAction({ self, enemies, allies, rng = Math.random } = {}) {
  const profile = profileForPc(self);
  const archetype = profile.archetype;
  const liveEnemies = (enemies || []).filter(alive);
  if (liveEnemies.length === 0) {
    return { kind: 'dodge', targetId: null, archetype, score: 0, breakdown: [], featuresFired: [] };
  }

  // For each live enemy, score the best action against them.
  let best = null;
  for (const target of liveEnemies) {
    const candidate = scoreActionsAgainst({ self, target, allies: allies || [], enemies: liveEnemies, profile });
    if (candidate && (!best || candidate.score > best.score ||
        (candidate.score === best.score && rng() < 0.5))) {
      best = { ...candidate, target };
    }
  }
  if (!best) {
    return { kind: 'dodge', targetId: null, archetype, score: 0, breakdown: [], featuresFired: [] };
  }
  // M42 — Fallback: if the chosen action is dash/dodge/disengage AND
  // the entity has a melee weapon, default to a mainhand melee attack
  // against the chosen target. The simulator's movement step closes
  // the gap and the resolver handles out-of-reach via autoMiss. This
  // preserves the pre-M42 "PC always swings at the end of their turn"
  // baseline while keeping the new feature/weapon-switch decisions for
  // turns where the PC IS in range.
  if (best.kind === 'dash' || best.kind === 'dodge' || best.kind === 'disengage') {
    const ref = self.ref || self;
    const mainhand = ref.equipment?.mainhand;
    if (mainhand) {
      best = {
        kind: 'melee',
        weapon: mainhand,
        spellId: null,
        castAtLevel: null,
        score: best.score,
        featuresFired: [],
        breakdown: [...best.breakdown, { name: 'fallback:swing', raw: 1, weighted: 0 }],
        target: best.target
      };
    }
  }
  return {
    kind: best.kind,
    targetId: best.target.id,
    weapon: best.weapon,
    spellId: best.spellId,
    castAtLevel: best.castAtLevel,
    featuresFired: best.featuresFired,
    archetype,
    score: best.score,
    breakdown: best.breakdown
  };
}

/**
 * Score every option this PC has against `target`. Returns the
 * highest-scoring action + breakdown.
 */
function scoreActionsAgainst({ self, target, allies, enemies, profile }) {
  const selfPos = posOf(self);
  const targetPos = posOf(target);
  const distance = (selfPos && targetPos) ? chebyshevFeet(selfPos, targetPos) : 999;
  const hostileAdjacent = (enemies || []).some(e => {
    const ep = posOf(e);
    return ep && chebyshevFeet(selfPos, ep) <= 5;
  });
  const ctx = { self, target, allies, enemies, distance, hostileAdjacent };

  // Per-target considerations contribute to *every* action against this
  // target. The action's own kind/weight then adds on top.
  let perTargetBase = 0;
  const baseBreakdown = [];
  for (const [name, entry] of Object.entries(profile.considerations || {})) {
    const piece = scoreConsideration(name, entry, ctx);
    perTargetBase += piece.weighted;
    if (Math.abs(piece.weighted) > 0.0001) {
      baseBreakdown.push({ name: piece.name, raw: piece.raw, weighted: piece.weighted });
    }
  }

  const actionWeights = profile.actionWeights || {};
  const featureWeights = profile.featureWeights || {};
  const features = availableFeatures(self.ref || self);

  let bestOption = null;

  // ---- Weapon actions ----
  const options = enumerateActions(self, target);
  for (const opt of options) {
    if (!gateOk(opt, ctx)) {
      // Weapon out of range: skip. The action ALSO doubles as a hint
      // for the dash/disengage path elsewhere.
      continue;
    }
    const kindWeight = actionWeights[opt.kind] ?? 0;
    if (kindWeight === 0 && opt.kind !== 'cast') continue;
    let score = perTargetBase + opt.baseScore + kindWeight;
    const featuresFired = [];
    const featureBreakdown = [];
    // Per-feature boost: features may add value to certain options
    for (const f of features) {
      const boost = f.scoreBoost(opt, ctx) * (featureWeights[f.id] ?? 1);
      if (boost > 0) {
        score += boost;
        featuresFired.push(f.id);
        featureBreakdown.push({ name: `feature:${f.id}`, raw: 1, weighted: boost });
      }
    }
    if (!bestOption || score > bestOption.score) {
      bestOption = {
        kind: opt.kind, weapon: opt.weapon,
        spellId: null, castAtLevel: null,
        score,
        featuresFired,
        breakdown: [
          ...baseBreakdown,
          { name: `action:${opt.kind}`, raw: 1, weighted: kindWeight + opt.baseScore },
          ...featureBreakdown
        ]
      };
    }
  }

  // ---- Spell actions ----
  // PCs cast spells from their `spells` array. We score each spell
  // available and pick the best. Cantrip range checks come from the
  // spell record; slot spells require an entity-level slot pool.
  const ref = self.ref || self;
  const castWeights = profile.castWeights || {};
  const slots = self._slots || ref._slots || null;
  const spellsKnown = collectSpells(ref);
  for (const sname of spellsKnown) {
    const id = nameToSpellId(sname);
    const spell = spellById(id);
    if (!spell) continue;
    if (spell.targetSide === 'ally') continue; // heal handled below
    const w = castWeights[id];
    if (w == null) continue;
    if (spell.level > 0 && (!slots || !canCastSpell(spell, slots))) continue;
    if (distance > (spell.range || 5)) continue;
    const kindWeight = actionWeights.cast ?? 0;
    const score = perTargetBase + w + kindWeight;
    if (!bestOption || score > bestOption.score) {
      bestOption = {
        kind: 'cast',
        weapon: null,
        spellId: id,
        castAtLevel: spell.level,
        score,
        featuresFired: [],
        breakdown: [
          ...baseBreakdown,
          { name: 'action:cast', raw: 1, weighted: kindWeight },
          { name: `spell:${spell.name}`, raw: 1, weighted: w }
        ]
      };
    }
  }

  return bestOption;
}

/** Pull spells off the PC's parsed character. Handles both array and
 *  grouped-by-level shapes (DDB returns either depending on version). */
function collectSpells(ref) {
  const sp = ref?.spells;
  if (!sp) return [];
  if (Array.isArray(sp)) return sp.map(s => typeof s === 'string' ? s : s?.name).filter(Boolean);
  const out = [];
  for (const v of Object.values(sp)) {
    if (Array.isArray(v)) {
      for (const s of v) out.push(typeof s === 'string' ? s : s?.name);
    }
  }
  return out.filter(Boolean);
}

/** Convert a human spell name to our spell-id slug. */
function nameToSpellId(name) {
  return String(name || '').toLowerCase()
    .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Re-export common helpers so callers can compose with the monster path
export { applyUpcast };
