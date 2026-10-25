/**
 * M42 — choosePcAction.
 *
 * Mirrors chooseAction (the monster decision-maker in profile.js) but
 * for PCs. Walks every ActionOption + every castable spell + every
 * applicable class feature, scores them, returns the winning plan.
 *
 * Plan shape (extends the monster plan shape with PC-specific fields):
 *   {
 *     kind:        'melee' | 'ranged' | 'cast' | 'heal' | 'dash' | 'disengage' | 'dodge' | 'feature' | 'item',
 *     featureId?:  string,        // kind 'feature' (M64 phase 1.5)
 *     itemId?:     string,        // kind 'item' (M65 T23): a run item (potion)
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
import { requireRng } from '../rng.js';
import { spellSlug, grantedSpellEntry, spellUseKey, usesLeft } from '../feature-uses.js';
import { hasReactionAvailable } from '../reactions.js';
import { itemEffectOf, itemUsesLeft } from '../item-effects.js';
import { attacksPerAction, classLevel } from './pc-features.js';
import { weaponsAvailableFor } from './action-options.js';
import { deriveWeaponAttack } from '../pc-stats.js';
import { parseDiceExpr } from '../combat-roll.js';
import { isRangedWeapon } from '../grid-rules.js';
// Function-declaration import across the engine ⇄ planner cycle (the
// engine imports choosePcAction): hoisted, so safe at evaluation time.
import { attackSequenceFor } from '../combat-engine.js';

/**
 * M65 T23 — a PC only considers drinking a healing potion below this HP
 * fraction, and only when no heal spell can answer (profiles may set
 * `potionThreshold`). Matches Second Wind's "bloodied" gate. Below it the
 * M65 phase 2 expected-value test decides (see considerPotion).
 */
export const POTION_HEAL_THRESHOLD = 0.5;
/**
 * Below this HP fraction a PC at risk of being downed before its next
 * turn (POTION_DOWN_RISK) prefers the potion: it drinks on the smaller
 * POTION_MIN_GAIN_CRITICAL.
 */
export const POTION_CRITICAL_FRACTION = 0.25;
/** "At risk of being downed next turn": P(incoming ≥ HP) at least this. */
export const POTION_DOWN_RISK = 0.25;
/**
 * Minimum gain in P(surviving the fight) — drinking line minus attacking
 * line, × `actionWeights.potion` — before a PC spends its action on a
 * potion; lower when critical (below POTION_CRITICAL_FRACTION and at risk).
 * Measured on the Fighter 5 vs orc + goblin bench: drinking on any
 * positive modelled gain cost ~5 pp of win rate (the rollout is optimistic
 * about the drinking line), 0.05+ recovers it.
 */
export const POTION_MIN_GAIN = 0.1;
export const POTION_MIN_GAIN_CRITICAL = 0.05;
/** `actionWeights.potion` when a profile does not set one (conservative). */
export const DEFAULT_POTION_WEIGHT = 1;
/** Base score of a potion plan: above any ordinary attack once it qualifies. */
const POTION_BASE_SCORE = 3;
/** Incoming-damage distributions are tracked to this many HP (tail bucket). */
const PMF_CAP = 600;

function posOf(e) { return e?._position || e?.position || null; }
function hpOf(e)  { return typeof e?.hp === 'number' ? e.hp : (e?.hp?.current ?? 0); }
function alive(e) { return e && hpOf(e) > 0; }

/**
 * @param {object} args
 * @param {object} args.self      — PC entity (simulator wrapper or live)
 * @param {object[]} args.enemies
 * @param {object[]} args.allies
 * @param {object[]} [args.downedAllies] — allies at 0 HP (M64 R8): heal
 *   candidates only (Healing Word picks a downed ally back up)
 * @param {function} [args.rng]
 */
export function choosePcAction({ self, enemies, allies, downedAllies = [], rng } = {}) {
  requireRng(rng, 'choosePcAction');
  const profile = profileForPc(self);
  const archetype = profile.archetype;
  const liveEnemies = (enemies || []).filter(alive);
  if (liveEnemies.length === 0) {
    return { kind: 'dodge', targetId: null, archetype, score: 0, breakdown: [], featuresFired: [] };
  }

  // For each live enemy, score the best action against them.
  let best = null;
  for (const target of liveEnemies) {
    const candidate = scoreActionsAgainst({ self, target, allies: allies || [], enemies: liveEnemies, profile, rng });
    if (candidate && (!best || candidate.score > best.score ||
        (candidate.score === best.score && rng() < 0.5))) {
      best = { ...candidate, target };
    }
  }
  // M42.1 — Healing Word & Cure Wounds for PCs. If an ally is hurt
  // and the PC knows a heal spell with a positive castWeight, score
  // the heal plan and compete against the offensive plan.
  const healPlan = considerPcHeal({ self, profile, allies: [...(allies || []), ...(downedAllies || [])] });
  if (healPlan && (!best || healPlan.score > best.score)) {
    best = { ...healPlan, target: healPlan.target };
  }
  // M65 T23 — a healing potion (a dying ally in reach, or self when the
  // expected-value test says drinking beats attacking) when no heal spell
  // answers. No items → no work, no rng.
  if (!healPlan && self?._items) {
    const potion = considerPotion({ self, profile, allies: [...(allies || []), ...(downedAllies || [])], enemies: liveEnemies, best });
    if (potion && (potion.decisive || !best || potion.score > best.score)) best = potion;
  }
  if (!best) {
    return { kind: 'dodge', targetId: null, archetype, score: 0, breakdown: [], featuresFired: [] };
  }
  // M64 phase 1.5 wave 6 — a caster pinned in melee teleports out.
  const escape = considerMistyStep({ self, profile, enemies: liveEnemies, best });
  if (escape) return { ...escape, archetype };
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
    ...(best.kind === 'feature' ? { featureId: best.featureId } : {}),
    ...(best.kind === 'item' ? { itemId: best.itemId } : {}),
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
function scoreActionsAgainst({ self, target, allies, enemies, profile, rng }) {
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
    if (kindWeight === 0 && opt.kind !== 'cast' && opt.kind !== 'feature') continue;
    let score = perTargetBase + opt.baseScore + kindWeight;
    const featuresFired = [];
    const featureBreakdown = [];
    // M64 phase 1.5 — a feature option is worth only what its own
    // feature says (Second Wind when bloodied); zero means never.
    if (opt.kind === 'feature') {
      const f = features.find(x => x.id === opt.featureId);
      const boost = f ? f.scoreBoost(opt, ctx) * (featureWeights[f.id] ?? 1) : 0;
      if (!(boost > 0)) continue;
      score += boost;
      if (!bestOption || score > bestOption.score) {
        bestOption = {
          kind: 'feature', featureId: opt.featureId, weapon: null,
          spellId: null, castAtLevel: null, score,
          featuresFired: [opt.featureId],
          breakdown: [...baseBreakdown, { name: `feature:${opt.featureId}`, raw: 1, weighted: boost + opt.baseScore }]
        };
      }
      continue;
    }
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
      // Only bonus-action / passive features ride an attack plan.
      if (f.action === 'action') continue;
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
    if (spell.targetSide === 'self') continue; // Misty Step: considerMistyStep
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

    // Feat / race spells: their own uses, cast at the base level.
    const granted = grantedUsable(self, id);
    if (granted !== null) {
      if (!granted) continue;
      const score = perTargetBase + w + kindWeight;
      if (!bestOption || score > bestOption.score) {
        bestOption = {
          kind: 'cast', weapon: null,
          spellId: id, castAtLevel: spell.level,
          score, featuresFired: [],
          breakdown: [
            ...baseBreakdown,
            { name: 'action:cast', raw: 1, weighted: kindWeight },
            { name: `spell:${spell.name}`, raw: 1, weighted: w },
            { name: 'uses:granted', raw: 1, weighted: 0 }
          ]
        };
      }
      continue;
    }
    if (!slots) continue;
    const upcastChoice = pickUpcastTier({ spell, baseScore: perTargetBase + w + kindWeight, slots, target, rng });
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
function pickUpcastTier({ spell, baseScore, slots, target, rng }) {
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
    rollouts: 4, depth: 1, rng
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
    // M64 R8 — a downed ally (0 HP) is a heal candidate, the most urgent one.
    return max > 0 && cur >= 0 && cur < max;
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
    const granted = spell.level > 0 ? grantedUsable(self, id) : null;
    if (granted === false) continue;
    if (granted === null && spell.level > 0 && (!slots || !canCastSpell(spell, slots))) continue;
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
  return spellSlug(name);
}

/**
 * M64 phase 1.5 wave 6 — Misty Step as a disengage. Chosen over the best
 * plan when the profile opts in (`castWeights['misty-step'] > 0`), the PC
 * can cast it (a granted use, else a slot of level 2+, the lowest one),
 * the best plan is not a melee swing, and a hostile within reach still
 * has its reaction — walking away would provoke. The engine picks the
 * landing cell (farthest from the hostiles) since the planner has no grid.
 * @returns {object|null} plan
 */
function considerMistyStep({ self, profile, enemies, best }) {
  const id = 'misty-step';
  const w = profile.castWeights?.[id];
  if (!(w > 0) || best.kind === 'melee' || best.kind === 'feature' || best.targetSide === 'ally') return null;
  const ref = self.ref || self;
  if (!collectSpells(ref).some(n => nameToSpellId(n) === id)) return null;
  const spell = spellById(id);
  if (!spell) return null;
  const sp = posOf(self);
  if (!sp) return null;
  const pinned = enemies.some(e => {
    const ep = posOf(e);
    const reach = Math.max(5, Number(e.attack?.reachFt) || 5);
    return ep && chebyshevFeet(sp, ep) <= reach && hasReactionAvailable(e);
  });
  if (!pinned) return null;
  let castAtLevel = spell.level;
  const granted = grantedUsable(self, id);
  if (granted === false) return null;
  if (granted === null) {
    const slots = self._slots || ref._slots || null;
    const lvl = slots ? [2, 3, 4, 5, 6, 7, 8, 9].find(l => (slots[l] ?? 0) > 0) : null;
    if (!lvl) return null;
    castAtLevel = lvl;
  }
  return {
    kind: 'cast', targetId: self.id ?? ref.id ?? null, targetSide: 'self',
    weapon: null, spellId: id, castAtLevel,
    featuresFired: [],
    score: best.score + w,
    breakdown: [{ name: 'action:cast', raw: 1, weighted: 0 }, { name: `spell:${spell.name}`, raw: 1, weighted: w }, { name: 'escape:leave-oa', raw: 1, weighted: 0 }]
  };
}

/**
 * M65 T23 — whether `self` can cast a heal (ally-targeted) spell right
 * now: a cantrip, a granted spell with a use left, or one with a slot.
 */
function canCastAnyHeal(self) {
  const ref = self.ref || self;
  const slots = self._slots || ref._slots || null;
  for (const sname of collectSpells(ref)) {
    const id = nameToSpellId(sname);
    const spell = spellById(id);
    if (!spell || spell.targetSide !== 'ally') continue;
    if (spell.level === 0) return true;
    const granted = grantedUsable(self, id);
    if (granted === true) return true;
    if (granted === null && slots && canCastSpell(spell, slots)) return true;
  }
  return false;
}

/**
 * M65 T23 — the potion plan: feed a dying ally within 5 ft first, else
 * drink when the trade is worth the action. Only when no heal spell is
 * castable. Picks the first usable healing item (run item order).
 *
 * M65 phase 2 — self-drinking is an expected-value decision, not a flat
 * "below half HP" reflex (a solo Fighter 5 drinking at 50% lost fights it
 * won without potions: 0.77 → 0.58). Below `potionThreshold`:
 *   - never when the fight is nearly won (the last hostile is at ≤ 25% HP,
 *     or reachable and within this turn's expected damage);
 *   - drink when no hostile is reachable this turn;
 *   - else weigh the action: expected damage this turn (attack line,
 *     with its Action Surge / Second Wind riders) against the healed HP
 *     (drink line) in one currency — P(surviving until the last foe
 *     drops) from a shallow analytic rollout (raceSurvival) seeded by the
 *     round-1 incoming-damage distribution, so the heal counts only in
 *     the worlds where `self` would be downed. Drink when the gain ×
 *     `actionWeights.potion` beats POTION_MIN_GAIN, or the lower
 *     POTION_MIN_GAIN_CRITICAL when below POTION_CRITICAL_FRACTION and
 *     P(downed before the next turn) ≥ POTION_DOWN_RISK.
 * (A one-turn "heal × P(down) vs damage dealt" test alone measured 0.71:
 * it ignores that drinking also delays the kill by a turn.)
 * `actionWeights.potion` 0 never self-drinks; dying allies are fed first
 * regardless.
 * @returns {object|null} a plan candidate (kind 'item', target set;
 *   `decisive` when the EV test chose it over the action plan)
 */
function considerPotion({ self, profile, allies, enemies = [], best = null }) {
  let itemId = null;
  let item = null;
  for (const [id, it] of Object.entries(self._items || {})) {
    if (itemUsesLeft(it) > 0 && itemEffectOf(it)?.kind === 'heal') { itemId = id; item = it; break; }
  }
  if (!item || canCastAnyHeal(self)) return null;
  const selfId = self.id ?? self.ref?.id;
  const sp = posOf(self);
  const dying = (allies || []).find(a => a && a !== self && a.id !== selfId && hpOf(a) <= 0 &&
    a.status !== 'dead' && sp && posOf(a) && chebyshevFeet(sp, posOf(a)) <= 5);
  if (dying) return potionPlan(itemId, item, dying, 'ally_dying', 1, [], false);

  const max = self.hpMax || self.hp?.max || 0;
  const hp = hpOf(self);
  const frac = max > 0 ? hp / max : 1;
  const threshold = Number.isFinite(profile?.potionThreshold) ? profile.potionThreshold : POTION_HEAL_THRESHOLD;
  if (!(frac < threshold)) return null;
  const weight = profile?.actionWeights?.potion ?? DEFAULT_POTION_WEIGHT;
  if (!(weight > 0)) return null;

  const target = best?.target && best.targetSide !== 'ally' ? best.target : nearestOf(self, enemies);
  const attackEv = expectedActionDamage(self, best, target);
  const reachable = enemies.some(e => hostileReachable(self, e, best));
  const lastFoe = enemies.length === 1 ? enemies[0] : null;
  if (lastFoe) {
    const foeMax = lastFoe.hpMax || lastFoe.hp?.max || 0;
    const foeHp = hpOf(lastFoe);
    if ((reachable && foeHp <= attackEv) || (foeMax > 0 && foeHp / foeMax <= 0.25)) return null;
  }
  const heal = Math.max(0, Math.min(diceMean(itemEffectOf(item).dice), max - hp));
  const temp = Number(self.hpTemp) || 0;
  const round1 = incomingPmf(self, enemies, true);
  const pDown = tailFrom(round1, hp + temp);
  const pAfter = tailFrom(round1, hp + heal + temp);
  const hpSaved = heal * pDown * weight;
  const order = [target, ...enemies.filter(e => e !== target).sort((x, y) => hpOf(x) - hpOf(y))].filter(Boolean);
  // The action plan's riders: Second Wind heals and Action Surge doubles
  // the first turn's damage only on the attack line (an item is the action).
  // A standalone feature plan (Second Wind, Rage) deals no damage this turn.
  const fired = best?.featuresFired || [];
  const surge = best?.kind === 'feature' ? 0 : fired.includes('action-surge') ? 2 : 1;
  const secondWind = fired.includes('second-wind') ? 5.5 + classLevel(self, 'Fighter') : 0;
  const winAttack = raceSurvival(self, best, order, hp + temp, { surge, heal: secondWind });
  const winDrink = raceSurvival(self, best, order, hp + heal + temp, { drinkFirst: true });
  const signals = [
    { name: 'potion:p_down', raw: pDown, weighted: 0 },
    { name: 'potion:hp_saved', raw: hpSaved, weighted: 0 },
    { name: 'potion:attack_ev', raw: attackEv, weighted: 0 },
    { name: 'potion:survive_attack', raw: winAttack, weighted: 0 },
    { name: 'potion:survive_drink', raw: winDrink, weighted: 0 }
  ];
  const critical = frac < POTION_CRITICAL_FRACTION && pDown >= POTION_DOWN_RISK && pAfter < pDown;
  const gain = (winDrink - winAttack) * weight;
  let reason = null;
  if (!reachable) reason = 'no_hostile_reachable';
  else if (critical && gain > POTION_MIN_GAIN_CRITICAL) reason = 'critical_down_risk';
  else if (gain > POTION_MIN_GAIN) reason = 'drinking_outlasts';
  if (!reason) return null;
  return potionPlan(itemId, item, self, reason, 1 - frac, signals, true);
}

function potionPlan(itemId, item, target, reason, urgency, signals, decisive) {
  return {
    kind: 'item', itemId, target, targetSide: 'ally',
    weapon: null, spellId: null, castAtLevel: null, featuresFired: [],
    score: POTION_BASE_SCORE + urgency,
    decisive,
    breakdown: [
      { name: `item:${item.name}`, raw: 1, weighted: POTION_BASE_SCORE },
      { name: reason, raw: urgency, weighted: urgency },
      ...signals
    ]
  };
}

function nearestOf(self, enemies) {
  const sp = posOf(self);
  let out = null;
  let bestD = Infinity;
  for (const e of enemies) {
    const d = sp && posOf(e) ? chebyshevFeet(sp, posOf(e)) : 999;
    if (d < bestD) { bestD = d; out = e; }
  }
  return out;
}

/** Mean of a dice expression ('2d4+2' → 7); 0 when unparseable. */
function diceMean(spec) {
  const parsed = parseDiceExpr(String(spec || ''));
  if (!parsed) return Number(spec) || 0;
  return parsed.terms.reduce((s, t) => s + t.sign * t.count * (t.sides + 1) / 2, parsed.mod);
}

/** P(d20 + bonus ≥ ac), a natural 1 always missing and a 20 always hitting. */
function hitChance(bonus, ac) {
  return Math.min(0.95, Math.max(0.05, (21 + (Number(bonus) || 0) - (Number(ac) || 10)) / 20));
}

/**
 * Expected damage of this turn's action plan (`best`) against `target`:
 * a damaging spell's dice, else one Attack action with the plan's weapon
 * (or the main hand) — `attacksPerAction` swings × hit chance × mean.
 */
function expectedActionDamage(self, best, target) {
  if (!target) return 0;
  const ref = self.ref || self;
  if (best?.kind === 'cast' && best.spellId) {
    const spell = spellById(best.spellId);
    if (spell?.perDart) return (spell.darts || 1) * diceMean(spell.perDart);
    if (spell?.dice) return diceMean(spell.dice) * (spell.kind === 'auto-hit' ? 1 : 0.6);
  }
  const weapon = best?.weapon || ref.equipment?.mainhand || null;
  const atk = deriveWeaponAttack(ref, weapon);
  return Math.min(4, attacksPerAction(self)) * hitChance(atk.bonus, target.ac ?? 12) * Math.max(0, diceMean(atk.dice));
}

/** Can `self` attack `enemy` this turn (move + reach, a ranged weapon, or the planned spell)? */
function hostileReachable(self, enemy, best) {
  const sp = posOf(self);
  const ep = posOf(enemy);
  if (!sp || !ep) return true;
  const d = chebyshevFeet(sp, ep);
  if (best?.kind === 'cast' && best.spellId && d <= (spellById(best.spellId)?.range || 5)) return true;
  const speed = Number.isFinite(self.speedFt) ? self.speedFt : 30;
  const ref = self.ref || self;
  for (const w of weaponsAvailableFor(self)) {
    const atk = deriveWeaponAttack(ref, w);
    const ranged = atk.ranged || isRangedWeapon(w);
    if (d <= (ranged ? atk.range.long : speed + (atk.reach || 5))) return true;
  }
  return weaponsAvailableFor(self).length === 0 && d <= speed + 5;
}

/**
 * M65 phase 2 — P(the hostiles' attacks before `self`'s next turn deal at
 * least `hp`): every live enemy that can reach `self` this round (speed +
 * reach, or a ranged attack record) makes its Attack action
 * (`attackSequenceFor`: Multiattack or the one primary attack); each
 * attack misses, hits (its damage dice) or crits (dice doubled, 5%)
 * against `self.ac`. Exact convolution of the damage distributions.
 * Pure: no rng.
 * @param {object} self — PC wrapper (`ac`, position)
 * @param {object[]} enemies — live hostile wrappers
 * @param {number} hp — HP (with temp HP) to survive with
 * @returns {number} probability in [0, 1]
 */
export function incomingDownRisk(self, enemies, hp) {
  if (!(hp > 0)) return 1;
  return tailFrom(incomingPmf(self, enemies, true), hp);
}

/** P(X ≥ hp) of a damage distribution. */
function tailFrom(pmf, hp) {
  if (!(hp > 0)) return 1;
  let p = 0;
  for (let i = Math.min(Math.ceil(hp), pmf.length); i < pmf.length; i++) p += pmf[i];
  return Math.min(1, Math.max(0, p));
}

/**
 * Damage distribution of one round of the hostiles' Attack actions on
 * `self`; `inReachOnly` drops attackers that cannot reach `self` this round.
 */
function incomingPmf(self, enemies, inReachOnly) {
  const ac = Number.isFinite(self?.ac) ? self.ac : 10;
  const sp = posOf(self);
  let pmf = [1];
  for (const e of enemies || []) {
    if (!alive(e)) continue;
    const d = inReachOnly && sp && posOf(e) ? chebyshevFeet(sp, posOf(e)) : 0;
    const speed = Number.isFinite(e.speedFt) ? e.speedFt : 30;
    for (const rec of attackSequenceFor(e)) {
      if (!rec?.dice) continue;
      const ranged = (Number.isFinite(rec.rangeFt) && !Number.isFinite(rec.reachFt)) || isRangedWeapon({ name: rec.name });
      const reach = Number.isFinite(rec.reachFt) ? rec.reachFt : 5;
      const range = ranged ? (Number.isFinite(rec.rangeFt) ? rec.rangeFt : 80) : speed + reach;
      if (d > range) continue;
      const attack = attackPmf(rec.dice, hitChance(rec.bonus, ac));
      if (attack) pmf = convolve(pmf, attack);
    }
  }
  return pmf;
}

/** Rounds the analytic race looks ahead. */
const RACE_HORIZON = 8;

/**
 * M65 phase 2 — a shallow analytic rollout of the fight from `self`'s
 * side: each of its turns deals its expected action damage to the foes
 * in `order` (overflow carries), then the foes still up make their Attack
 * actions (round 1: only those in reach). Returns P(`self` is never
 * downed before the last foe drops, within RACE_HORIZON rounds).
 * `drinkFirst`: the first turn is spent drinking (no damage dealt);
 * `surge` multiplies the first turn's damage (Action Surge) and `heal`
 * is HP the first turn's bonus action restores (Second Wind).
 */
function raceSurvival(self, best, order, hp, { drinkFirst = false, surge = 1, heal = 0 } = {}) {
  const cap = Math.max(1, Math.ceil(hp + heal));
  const foes = order.map(e => ({ e, left: hpOf(e), ev: Math.max(0.5, expectedActionDamage(self, best, e)) }));
  let first = 0;
  let pmf = [1];
  const cache = new Map();
  for (let r = 0; r < RACE_HORIZON && first < foes.length; r++) {
    if (!(drinkFirst && r === 0)) {
      let dmg = foes[first].ev * (r === 0 ? surge : 1);
      while (first < foes.length && dmg > 0) {
        const f = foes[first];
        const hit = Math.min(dmg, f.left);
        f.left -= hit;
        dmg = f.left <= 0 ? (dmg - hit) / f.ev * (foes[first + 1]?.ev ?? 0) : 0;
        if (f.left <= 0) first++;
      }
    }
    if (first >= foes.length) break;
    const key = r === 0 ? `r0:${first}` : String(first);
    let inc = cache.get(key);
    if (!inc) {
      inc = incomingPmf(self, foes.slice(first).map(f => f.e), r === 0);
      cache.set(key, inc);
    }
    pmf = convolveTo(pmf, inc, cap);
  }
  let alive = 0;
  for (let i = 0; i < Math.min(cap, pmf.length); i++) alive += pmf[i];
  return alive;
}

/** Convolution with every outcome ≥ cap folded into index cap (absorbing). */
function convolveTo(a, b, cap) {
  const out = new Array(Math.min(cap + 1, a.length + b.length - 1)).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    if (i >= cap) { out[cap] += a[i]; continue; }
    for (let j = 0; j < b.length; j++) {
      if (!b[j]) continue;
      out[Math.min(cap, i + j)] += a[i] * b[j];
    }
  }
  return out;
}

/** One attack's damage distribution: miss / hit (dice) / crit (dice doubled, 5%). */
function attackPmf(spec, pHit) {
  const parsed = parseDiceExpr(String(spec));
  if (!parsed) return null;
  const hit = damagePmf(parsed, 1);
  const crit = damagePmf(parsed, 2);
  const pCrit = 0.05;
  const pNormal = Math.max(0, pHit - pCrit);
  const out = new Array(Math.max(hit.length, crit.length)).fill(0);
  out[0] += 1 - pHit;
  for (let i = 0; i < hit.length; i++) out[i] += pNormal * hit[i];
  for (let i = 0; i < crit.length; i++) out[i] += pCrit * crit[i];
  return out;
}

/** Damage distribution of a parsed dice expression (dice × mult), floored at 0. */
function damagePmf(parsed, mult) {
  let pmf = [1];
  let shift = parsed.mod;
  for (const t of parsed.terms) {
    const die = new Array(t.sides + 1).fill(1 / t.sides);
    die[0] = 0;
    for (let i = 0; i < t.count * mult; i++) {
      if (t.sign > 0) pmf = convolve(pmf, die);
      else shift -= (t.sides + 1) / 2;   // a subtracted die: its mean
    }
  }
  const off = Math.round(shift);
  const out = [];
  for (let i = 0; i < pmf.length; i++) {
    if (!pmf[i]) continue;
    const v = Math.min(PMF_CAP, Math.max(0, i + off));
    out[v] = (out[v] || 0) + pmf[i];
  }
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = 0;
  return out;
}

function convolve(a, b) {
  const out = new Array(Math.min(PMF_CAP + 1, a.length + b.length - 1)).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) {
      if (!b[j]) continue;
      out[Math.min(PMF_CAP, i + j)] += a[i] * b[j];
    }
  }
  return out;
}

/**
 * M64 phase 1.5 — can `self` cast a feat / race granted spell from its
 * own uses? null when the spell is not granted (slots apply); else
 * whether a use is left (an untracked ledger counts as fully rested).
 */
function grantedUsable(self, id) {
  const grant = grantedSpellEntry(self.ref || self, id);
  if (!grant) return null;
  const key = spellUseKey(id);
  if (!self._features?.[key]) return true;
  return usesLeft(self, key) > 0;
}

// Re-export common helpers so callers can compose with the monster path
export { applyUpcast };
