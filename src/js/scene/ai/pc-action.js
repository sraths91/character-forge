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
import { mctsEvaluate, shallowRolloutForResource } from './mcts.js';

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
  // M42.1 — Healing Word & Cure Wounds for PCs. If an ally is hurt
  // and the PC knows a heal spell with a positive castWeight, score
  // the heal plan and compete against the offensive plan.
  const healPlan = considerPcHeal({ self, profile, allies: allies || [] });
  if (healPlan && (!best || healPlan.score > best.score)) {
    best = { ...healPlan, target: healPlan.target };
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
    targetSide: best.targetSide || (best.kind === 'cast' && best.spellId
      ? (spellById(best.spellId)?.targetSide || 'enemy') : 'enemy'),
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
  // Features need to see both the inner character ref (for class/lvl)
  // AND the simulator wrapper (for _slots, _actionSurgeUsed, etc.).
  // Pass a merged shape so available() can read everything.
  const mergedSelf = mergeSelfForFeatures(self);
  const features = availableFeatures(mergedSelf);

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
    // Per-feature boost: features may add value to certain options.
    // M42.2 — Stash the rollout context on the PC so the feature's
    // consume() can run a shallow MCTS over slot-level choices.
    if (self) {
      const hp = typeof target?.hp === 'number' ? target.hp : (target?.hp?.current ?? 0);
      self._mctsTargetCtx = {
        target,
        roundsLeft: Math.max(1, Math.ceil(hp / 7)),   // rough turns-to-kill
        targetDpr: undefined                          // shallowRollout estimates
      };
    }
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
  //
  // M45 Phase 3 — Slot-burning spells run through mctsEvaluate so the
  // chosen upcast tier reflects expected encounter value, not the
  // base level. Cantrips bypass MCTS (no slot decision to make).
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
    if (distance > (spell.range || 5)) continue;
    const kindWeight = actionWeights.cast ?? 0;

    if (spell.level === 0) {
      // Cantrip — single candidate, score directly.
      const score = perTargetBase + w + kindWeight;
      if (!bestOption || score > bestOption.score) {
        bestOption = {
          kind: 'cast', weapon: null,
          spellId: id, castAtLevel: 0,
          score, featuresFired: [],
          breakdown: [
            ...baseBreakdown,
            { name: 'action:cast', raw: 1, weighted: kindWeight },
            { name: `spell:${spell.name}`, raw: 1, weighted: w }
          ]
        };
      }
      continue;
    }

    if (!slots) continue;
    const upcastChoice = pickUpcastTier({ spell, baseScore: perTargetBase + w + kindWeight, slots, target });
    if (!upcastChoice) continue;
    if (!bestOption || upcastChoice.score > bestOption.score) {
      bestOption = {
        kind: 'cast', weapon: null,
        spellId: id, castAtLevel: upcastChoice.level,
        score: upcastChoice.score, featuresFired: [],
        breakdown: [
          ...baseBreakdown,
          { name: 'action:cast', raw: 1, weighted: kindWeight },
          { name: `spell:${spell.name}`, raw: 1, weighted: w },
          { name: `upcast:${upcastChoice.level}`, raw: upcastChoice.mctsValue, weighted: upcastChoice.mctsValue }
        ]
      };
    }
  }

  return bestOption;
}

/**
 * M45 Phase 3 — MCTS-driven upcast tier selection.
 *
 * For a leveled spell, enumerate every available slot tier from
 * spell.level..5 and run a shallow rollout per candidate. Returns the
 * winning tier with combined utility + MCTS score, or null if no slot
 * is available.
 *
 * Slot scarcity is folded into the rollout's resource tax — burning
 * the last 5th-level slot costs more "future damage" than the first.
 * Targets with high HP favor higher tiers (more dice = more pressure);
 * low-HP targets favor the base level (kill window already closed by
 * the base dice).
 */
function pickUpcastTier({ spell, baseScore, slots, target }) {
  const baseLevel = spell.level;
  const candidates = [];
  const slotPool = Object.values(slots).reduce((s, n) => s + (n || 0), 0);
  for (let lvl = baseLevel; lvl <= 5; lvl++) {
    if ((slots[lvl] ?? 0) <= 0) continue;
    if (!canCastSpell({ level: lvl }, slots)) continue;
    // Expected extra damage from upcast. The spell registry's applyUpcast
    // is the source of truth, but a fast approximation: each tier above
    // base adds roughly the spell's per-die value.
    const tiersOver = lvl - baseLevel;
    const expectedExtraDamage = approximateUpcastDamage(spell, tiersOver);
    // Higher tiers cost more future leverage. We multiply the slot-tax
    // by the tier so a level-5 burn is taxed harder than a level-1 burn.
    candidates.push({
      id: `${spell.id}-l${lvl}`,
      level: lvl,
      baseScore,
      expectedExtraDamage,
      _slotTax: lvl
    });
  }
  if (candidates.length === 0) return null;
  const ranked = mctsEvaluate({
    candidates,
    rollout: (cand) => shallowRolloutForResource({
      candidate: cand,
      ctx: { target, roundsLeft: 3, slotPool: slotPool / cand._slotTax }
    }),
    rollouts: 4, depth: 1
  });
  const best = ranked[0];
  return {
    level: best.level,
    score: best.totalValue,
    mctsValue: best.mctsValue
  };
}

/** Rough estimate of extra damage gained from upcasting `tiersOver` tiers.
 *  Magic Missile adds 1 dart (1d4+1 ≈ 3.5); damage spells typically add
 *  one die at the spell's base die size. Pure approximation — the real
 *  applyUpcast logic decides at cast time. */
function approximateUpcastDamage(spell, tiersOver) {
  if (tiersOver <= 0) return 0;
  // Magic Missile-style: extra darts
  if (spell.perDart) return tiersOver * 3.5;
  // AoE / single-target damage: extra die of base size
  const m = String(spell.dice || '').match(/(\d+)d(\d+)/);
  if (!m) return tiersOver * 4;
  const dieSize = Number(m[2]);
  return tiersOver * ((dieSize + 1) / 2);
}

/**
 * M42.1 — Score the best heal-an-ally action for `self`. Returns a
 * plan with kind:'cast', targetSide:'ally' when worth picking; null
 * otherwise. Mirrors monster considerHeal but for PC profile shape.
 */
function considerPcHeal({ self, profile, allies }) {
  const castWeights = profile.castWeights || {};
  const ref = self.ref || self;
  const slots = self._slots || ref._slots || null;
  const spellsKnown = collectSpells(ref);
  // Find the most-wounded ally (excluding self)
  const selfId = self.id ?? ref.id;
  const hurt = (allies || []).filter(a => {
    if (a === self || a?.id === selfId) return false;
    const max = a.hpMax || a.hp?.max || 0;
    const cur = typeof a.hp === 'number' ? a.hp : a.hp?.current;
    return max > 0 && cur > 0 && cur < max;
  });
  if (hurt.length === 0) return null;
  let mostHurt = null;
  let mostHurtScore = -1;
  for (const a of hurt) {
    const max = a.hpMax || a.hp?.max || 1;
    const cur = typeof a.hp === 'number' ? a.hp : a.hp?.current;
    const w = 1 - cur / max;
    if (w > mostHurtScore) { mostHurt = a; mostHurtScore = w; }
  }
  if (!mostHurt) return null;

  // Score each known heal spell. Healing Word > Cure Wounds when the
  // ally is bloodied + far (bonus action + 60ft range).
  let bestSpell = null;
  for (const sname of spellsKnown) {
    const id = nameToSpellId(sname);
    const w = castWeights[id];
    if (w == null) continue;
    const spell = spellById(id);
    if (!spell || spell.targetSide !== 'ally') continue;
    if (spell.level > 0 && (!slots || !canCastSpell(spell, slots))) continue;
    const sp = posOf(self), tp = posOf(mostHurt);
    if (sp && tp) {
      const d = chebyshevFeet(sp, tp);
      if (d > (spell.range || 5)) continue;
    }
    // M45 Phase 5 — Heal weight now defaults to 0 (matching every
    // other action kind) so profiles that don't opt in don't favour
    // healing over offense for mildly wounded allies. Profiles that
    // want healing must set actionWeights.heal explicitly (the support
    // archetype defaults to a positive value).
    const kindWeight = (profile.actionWeights?.heal) ?? 0;
    const score = w + mostHurtScore * 0.5 + kindWeight;
    if (!bestSpell || score > bestSpell.score) {
      bestSpell = { id, spell, score, weight: w };
    }
  }
  if (!bestSpell) return null;
  return {
    kind: 'cast',
    targetId: mostHurt.id,
    targetSide: 'ally',
    weapon: null,
    spellId: bestSpell.id,
    castAtLevel: bestSpell.spell.level,
    featuresFired: [],
    score: bestSpell.score,
    breakdown: [
      { name: `heal:${bestSpell.spell.name}`, raw: 1, weighted: bestSpell.weight },
      { name: 'ally_bloodied', raw: mostHurtScore, weighted: mostHurtScore * 0.5 }
    ],
    target: mostHurt
  };
}

/** Build a single entity view exposing both `_slots`-style runtime
 *  state from the simulator wrapper AND the underlying character ref
 *  (classes, equipment, spells). Features and considerations consume
 *  this merged shape. */
function mergeSelfForFeatures(self) {
  if (!self) return self;
  const ref = self.ref || self;
  // Direct properties on the wrapper (e.g. _slots) take precedence over
  // ref. Class data and equipment live on ref.
  return {
    ...ref,
    ...self,
    classes: self.classes || ref.classes,
    equipment: self.equipment || ref.equipment,
    spells: self.spells || ref.spells
  };
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

/** Convert a human spell name to our spell-id slug. Exported so the
 *  live runner's manual-cast path can resolve registry entries
 *  consistently with the AI planner. */
export function nameToSpellId(name) {
  return String(name || '').toLowerCase()
    .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Re-export common helpers so callers can compose with the monster path
export { applyUpcast };
