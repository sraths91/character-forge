/**
 * M15 — Class-feature availability registry.
 *
 * The plan from the original M11/M14 design was a tiny rules registry,
 * keyed by feature name, that each return availability + reason for an
 * attack context. The resolver doesn't need to know about every feature
 * 5e ships with — only that it can ask the registry "is anything special
 * available for this attack?" and the registry knows what rules to run
 * based on what features the character has parsed (from M10).
 *
 * Pure functions, no DOM, no globals. Inputs are the same ctx the
 * resolver builds, plus the resolver's already-computed advReasons /
 * disReasons (so feature rules can read net advantage state).
 *
 * Each rule returns:
 *   {
 *     available: boolean,        // true = the feature can be invoked on this hit
 *     dice: '2d6',               // if applicable
 *     reason: 'Flanking',        // why it's available (UI label)
 *     blockReason: 'No advantage'// when available=false, why
 *   }
 *
 * The resolver collects { feature.name → result } into verdict.features.
 */

import { chebyshevFeet, isRangedWeapon } from './grid-rules.js';

const RULES = new Map();

/**
 * Register a feature rule. Tests + future features can call this; the
 * built-in rules below register themselves at module load.
 *
 * Keying is on the feature.name canonical (lowercased, whitespace
 * collapsed) so "Sneak Attack" and "sneak attack" match the same rule.
 */
export function registerFeatureRule(featureName, ruleFn) {
  RULES.set(canonical(featureName), ruleFn);
}

function canonical(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Evaluate every registered rule against the attacker's parsed features.
 * Skips features that aren't in the registry (most class features are
 * descriptive, not mechanically active during an attack roll).
 *
 * Returns an array of { name, source, ...ruleResult } so the UI can
 * group them or pick the most relevant one to surface.
 */
export function evaluateFeatures(ctx) {
  const features = ctx.attacker?.classFeatures;
  if (!Array.isArray(features) || features.length === 0) return [];
  const results = [];
  for (const f of features) {
    const rule = RULES.get(canonical(f.name));
    if (!rule) continue;
    const result = rule({ ...ctx, feature: f });
    if (result) results.push({ name: f.name, source: f.source, level: f.level, ...result });
  }
  return results;
}

// ---------- Built-in rules ----------

/**
 * Sneak Attack (PHB p96, Rogue).
 *
 * "Once per turn, you can deal an extra ... damage to one creature you
 * hit with an attack if you have advantage on the attack roll. The
 * attack must use a finesse or a ranged weapon. You don't need advantage
 * on the attack roll if another enemy of the target is within 5 feet of
 * it, that enemy isn't incapacitated, and you don't have disadvantage
 * on the attack roll."
 *
 * Once-per-turn isn't enforced — that's player tracking. We surface
 * availability; the rogue decides when to call it.
 *
 * Available iff:
 *   (weapon is finesse OR ranged)
 *   AND NOT (resolvedMode === 'disadvantage')
 *   AND (
 *     resolvedMode === 'advantage'
 *     OR (an ally is within 5 ft of the target AND that ally isn't incapacitated)
 *   )
 */
registerFeatureRule('Sneak Attack', (ctx) => {
  const { feature, weapon, target, targetKind, scene, resolvedMode } = ctx;
  // Dice come from the parsed action (M10 extraction): e.g. "3d6" at L5.
  const dice = feature?.dice || '1d6';

  // Weapon eligibility
  const isFinesseWeapon = weaponHasFinesse(weapon);
  const isRanged = isRangedWeapon(weapon);
  if (!isFinesseWeapon && !isRanged) {
    return {
      available: false, dice,
      blockReason: 'Weapon must be finesse or ranged'
    };
  }

  // Disadvantage blocks both paths
  if (resolvedMode === 'disadvantage') {
    return {
      available: false, dice,
      blockReason: 'Cannot sneak attack with disadvantage'
    };
  }

  // Path A: net advantage
  if (resolvedMode === 'advantage') {
    return {
      available: true, dice,
      reason: 'Advantage on the attack'
    };
  }

  // Path B: ally within 5 ft of target, not incapacitated, no disadvantage
  const targetPos = target?._position || target?.position
    || (targetKind === 'pc' ? scene?.positions?.[String(target?.id)] : null);
  if (!targetPos) {
    return {
      available: false, dice,
      blockReason: 'Cannot determine target position'
    };
  }
  const allyAdjacent = findEligibleAdjacentAlly(targetPos, ctx.allies, ctx.attacker);
  if (allyAdjacent) {
    return {
      available: true, dice,
      reason: `Ally adjacent to target (${allyAdjacent.name || 'Ally'})`
    };
  }

  return {
    available: false, dice,
    blockReason: 'Need advantage OR ally within 5 ft of target'
  };
});

function weaponHasFinesse(weapon) {
  if (!weapon) return false;
  const props = Array.isArray(weapon.properties)
    ? weapon.properties.map(p => String(p?.name || p || '').toLowerCase())
    : [];
  if (props.includes('finesse')) return true;
  // Name fallback for parser shapes that don't carry properties.
  const n = String(weapon.name || '').toLowerCase();
  return /\b(dagger|rapier|scimitar|shortsword|whip|dart)\b/.test(n);
}

function findEligibleAdjacentAlly(targetPos, allies, attacker) {
  if (!Array.isArray(allies)) return null;
  for (const ally of allies) {
    if (!ally || ally === attacker) continue;
    const pos = ally._position || ally.position;
    if (!pos) continue;
    if (chebyshevFeet(pos, targetPos) > 5) continue;
    if (isIncapacitated(ally)) continue;
    return ally;
  }
  return null;
}

function isIncapacitated(entity) {
  const c = Array.isArray(entity?.conditions) ? entity.conditions : [];
  return c.includes('paralyzed') || c.includes('stunned') ||
         c.includes('unconscious') || c.includes('petrified');
}
