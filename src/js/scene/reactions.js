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
  if (!canCastShield(target)) return false;
  // Only fires when it would actually convert a hit into a miss.
  // Crit hits ignore Shield: crits hit regardless of AC.
  if (attackerTotal < targetAc) return false;
  if (attackerTotal >= targetAc + 5) return false;
  return true;
}

/**
 * Lower-level predicate: does `target` have the *resources* to cast
 * Shield right now? Used by the Magic Missile path, where the PHB text
 * states Shield negates the spell entirely — no AC math involved.
 */
export function canCastShield(target) {
  if (!hasReactionAvailable(target)) return false;
  if (!hasShieldSpell(target)) return false;
  if ((target._lvl1Slots ?? 0) <= 0) return false;
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

// 5e PHB spell-slot table by spell-level + class level. Used by the
// simulator to seed `_lvl1Slots` (Shield) and `_lvl3Slots` (Counterspell)
// on each PC wrapper. Doesn't account for multiclass slot stacking.
const FULL_CASTER_LVL1 = [0, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
const FULL_CASTER_LVL3 = [0, 0, 0, 0, 0, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
const HALF_CASTER_LVL1 = [0, 0, 2, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4];
const HALF_CASTER_LVL3 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
const FULL_CASTERS = new Set(['wizard', 'sorcerer', 'bard', 'cleric', 'druid', 'warlock']);
const HALF_CASTERS = new Set(['paladin', 'ranger', 'artificer']);

/** Pick the slot table for a class name; returns null for non-casters. */
function tablesFor(name) {
  if (FULL_CASTERS.has(name)) return { lvl1: FULL_CASTER_LVL1, lvl3: FULL_CASTER_LVL3 };
  if (HALF_CASTERS.has(name)) return { lvl1: HALF_CASTER_LVL1, lvl3: HALF_CASTER_LVL3 };
  return null;
}

/** M42.1 — Estimate PC's full spell-slot pool. Returns { 1: N, 2: M, ... }
 *  shaped like monster `_slots`. Used by Divine Smite + Healing Word. */
export function slotsForPc(pc) {
  const classes = pc?.classes || [];
  // 1st-level slot table per full-caster level (already exported). We
  // populate 1-5 from FULL_CASTER tables and a parallel 2/4/5 tables.
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  // Single-class approximation: take the deepest caster class.
  let pickClass = null, pickLvl = 0;
  for (const c of classes) {
    const name = String(c?.name || '').toLowerCase();
    if (FULL_CASTERS.has(name) || HALF_CASTERS.has(name)) {
      if ((c.level || 0) > pickLvl) { pickClass = name; pickLvl = c.level || 0; }
    }
  }
  if (!pickClass) return out;
  // Tables below are PHB p15 / p84-85 abbreviated to lvl 1-5 slots up
  // through character level 11 (covers the bulk of play).
  const FULL = {
    //         1   2   3   4   5
    1:  { 1: 2 },
    2:  { 1: 3 },
    3:  { 1: 4, 2: 2 },
    4:  { 1: 4, 2: 3 },
    5:  { 1: 4, 2: 3, 3: 2 },
    6:  { 1: 4, 2: 3, 3: 3 },
    7:  { 1: 4, 2: 3, 3: 3, 4: 1 },
    8:  { 1: 4, 2: 3, 3: 3, 4: 2 },
    9:  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
    10: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
    11: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 }
  };
  const HALF = {
    1:  {}, 2:  { 1: 2 }, 3:  { 1: 3 }, 4:  { 1: 3 },
    5:  { 1: 4, 2: 2 }, 6:  { 1: 4, 2: 2 }, 7:  { 1: 4, 2: 3 },
    8:  { 1: 4, 2: 3 }, 9:  { 1: 4, 2: 3, 3: 2 }, 10: { 1: 4, 2: 3, 3: 2 },
    11: { 1: 4, 2: 3, 3: 3 }
  };
  const table = FULL_CASTERS.has(pickClass) ? FULL : HALF;
  const row = table[Math.max(1, Math.min(11, pickLvl))] || {};
  return { ...out, ...row };
}

/** Estimate PC's starting 1st-level slot pool. 0 for non-casters. */
export function lvl1SlotsForPc(pc) {
  const classes = pc?.classes || [];
  let best = 0;
  for (const c of classes) {
    const name = String(c?.name || '').toLowerCase();
    const t = tablesFor(name);
    if (!t) continue;
    const lvl = Math.max(0, Math.min(20, c?.level || 0));
    best = Math.max(best, t.lvl1[lvl] || 0);
  }
  return best;
}

/** Estimate PC's starting 3rd-level slot pool — needed by Counterspell. */
export function lvl3SlotsForPc(pc) {
  const classes = pc?.classes || [];
  let best = 0;
  for (const c of classes) {
    const name = String(c?.name || '').toLowerCase();
    const t = tablesFor(name);
    if (!t) continue;
    const lvl = Math.max(0, Math.min(20, c?.level || 0));
    best = Math.max(best, t.lvl3[lvl] || 0);
  }
  return best;
}

// =====================================================================
// M34.1 — Counterspell (PHB p228)
//
// Triggers when the caster sees a creature within 60ft start to cast a
// spell. Spends one 3rd-level slot + reaction. Auto-counters spells of
// level ≤ 3; higher levels require an ability check (DC 10 + spell
// level) using the counterer's spellcasting modifier.
//
// In v1 the AI policy is simple: any PC who has the spell + a 3rd-level
// slot will counter any *leveled* monster spell of level ≥ 2. Cantrips
// (lvl 0) and 1st-level filler aren't worth the slot.
// =====================================================================

/** Does this PC know Counterspell? */
export function hasCounterspell(entity) {
  const ref = entity?.ref || entity;
  if (!ref) return false;
  const spells = ref.spells;
  if (!spells) return false;
  const match = (s) => /^counterspell$/i.test(typeof s === 'string' ? s : (s?.name || ''));
  if (Array.isArray(spells)) return spells.some(match);
  if (typeof spells === 'object') {
    for (const v of Object.values(spells)) {
      if (Array.isArray(v) && v.some(match)) return true;
    }
  }
  return false;
}

/** Resources only: reaction + spell known + a 3rd-level slot available. */
export function canCastCounterspell(entity) {
  if (!hasReactionAvailable(entity)) return false;
  if (!hasCounterspell(entity)) return false;
  if ((entity._lvl3Slots ?? 0) <= 0) return false;
  return true;
}

/** Burn the slot + reaction. */
export function consumeCounterspell(entity) {
  if (!entity) return;
  consumeReaction(entity);
  entity._lvl3Slots = Math.max(0, (entity._lvl3Slots ?? 0) - 1);
}

/**
 * Policy: would this entity Counterspell a spell of `spellLevel`?
 * v1 rule: only counter leveled spells of level >= 2.
 */
export function shouldCounterspell(entity, spellLevel) {
  if (!canCastCounterspell(entity)) return false;
  if (!Number.isFinite(spellLevel)) return false;
  return spellLevel >= 2;
}

/**
 * Resolve the counter check. Returns { countered: bool, mode, total?, dc? }.
 *   mode: 'auto' (level <= 3) or 'check' (level > 3 — ability check).
 *   For the 'check' path, the rng yields the d20; mod is the counterer's
 *   spellcasting ability modifier (defaults to 0 if not provided).
 */
export function resolveCounterspell({ spellLevel, counterMod = 0 } = {}, rng = Math.random) {
  if (spellLevel <= 3) {
    return { countered: true, mode: 'auto' };
  }
  const d20 = Math.floor(rng() * 20) + 1;
  const total = d20 + counterMod;
  const dc = 10 + spellLevel;
  return { countered: total >= dc, mode: 'check', d20, total, dc };
}
