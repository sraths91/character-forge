/**
 * M11 — Combat resolver.
 *
 * A pure module that sits between the UI/attack-flow and combat-roll.js.
 * Given an attacker, target, weapon, and scene state, it returns a
 * structured "what's actually rolling" object describing:
 *   - Attack bonus: the total + each source contributing to it
 *   - Damage bonus: same shape
 *   - d20 mode (normal / advantage / disadvantage) with the human-readable
 *     reasons each side contributed
 *   - autoMiss / autoCrit flags for incapacitated targets
 *   - blockers — hard refusals (charmed can't attack charmer, etc.)
 *
 * No DOM, no globals. All inputs are plain JS values; callers can mock
 * any field. Decisions go in here so the resolver tests can pin every
 * rule independently of the UI.
 *
 * Scope (M11 + M13):
 *   - Condition mechanics (poisoned, blinded, frightened, invisible, prone,
 *     restrained, paralyzed, stunned, unconscious, petrified, charmed).
 *   - Advantage/disadvantage canceling rule (5e PHB p173).
 *   - Auto-crit for melee-within-5ft against paralyzed/unconscious.
 *   - Override path: when the UI radio is set to advantage/disadvantage/
 *     normal, that wins over the resolver verdict.
 *
 * Out of scope for this bundle (M12/M14/M15 ship later):
 *   - Item/feat/class modifiers (Amulet of the Devout +1 etc.)
 *   - Flanking, reach, ranged-adjacent disadvantage
 *   - Sneak Attack availability + feature-specific rules
 */

import { deriveWeaponAttack } from './pc-stats.js';

/**
 * Compute Chebyshev distance between two cells, in feet (5ft per cell).
 * Same cell → 0ft, adjacent → 5ft, two cells away → 10ft. Used for
 * "within 5ft" melee checks (auto-crit on paralyzed target).
 */
export function chebyshevFeet(posA, posB) {
  if (!posA || !posB) return Infinity;
  return Math.max(Math.abs(posA.col - posB.col), Math.abs(posA.row - posB.row)) * 5;
}

/**
 * Heuristic: is this weapon ranged? A ranged weapon attack triggers
 * different mechanics than melee (e.g. prone target = disadvantage for
 * ranged, advantage for melee).
 */
const RANGED_NAME_KEYWORDS = ['bow', 'crossbow', 'sling', 'dart', 'javelin', 'blowgun'];
export function isRangedWeapon(weapon) {
  if (!weapon) return false;
  const props = Array.isArray(weapon.properties)
    ? weapon.properties.map(p => String(p?.name || p || '').toLowerCase())
    : [];
  if (props.includes('ranged')) return true;
  if (props.includes('thrown') && !props.includes('finesse')) {
    // Thrown weapons used as ranged attacks — caller can disambiguate by
    // setting weapon.usedAsRanged. Default: treat as melee since most
    // throws happen in melee on the LPC stage.
    return !!weapon.usedAsRanged;
  }
  const n = String(weapon.name || '').toLowerCase();
  return RANGED_NAME_KEYWORDS.some(k => n.includes(k));
}

/**
 * Resolve an attack given the scene context. Returns a fully structured
 * object the UI can both preview (before clicking 🎲) and act on (when
 * the click happens).
 *
 * @param {object} ctx
 * @param {object} ctx.attacker         - PC or monster-instance record
 * @param {object} ctx.target           - PC or monster-instance record
 * @param {object} ctx.weapon           - Weapon being used (parser shape)
 * @param {object} ctx.scene            - Scene object (positions, monsters)
 * @param {string} ctx.attackerKind     - 'pc' | 'monster'
 * @param {string} ctx.targetKind       - 'pc' | 'monster'
 * @param {number} ctx.targetAC         - Target AC (caller pre-derives)
 * @param {string} [ctx.advantageOverride] - 'auto' (default) | 'normal' | 'advantage' | 'disadvantage'
 */
export function resolveAttack(ctx) {
  const {
    attacker, target, weapon, scene,
    attackerKind, targetKind,
    targetAC,
    advantageOverride = 'auto'
  } = ctx;

  const attackerConditions = conditionsOf(attacker);
  const targetConditions   = conditionsOf(target);
  const ranged = isRangedWeapon(weapon);

  // --- Hard blockers: refuse the attack outright ---
  const blockers = [];

  // Attacker incapacitated → cannot take actions at all.
  for (const c of ['paralyzed', 'stunned', 'unconscious', 'petrified']) {
    if (attackerConditions.has(c)) {
      blockers.push(`Attacker is ${c} (incapacitated — cannot attack)`);
    }
  }
  // Charmed can't attack the charmer. We model "charmer" as any entity —
  // since per-pair charm relationships aren't tracked, we fall back to:
  // if attacker is charmed, refuse all attacks (conservative). A future
  // version with per-target charm links can lift this.
  if (attackerConditions.has('charmed')) {
    blockers.push('Attacker is charmed (cannot attack)');
  }

  // --- Attack bonus breakdown ---
  // For M11 we lean on the existing M6 deriveWeaponAttack for PCs and the
  // preset attack record for monsters. M12 will plug in combatMods.
  const atkStats = ctx.attackStats || deriveAttackStatsForContext(ctx);
  const attackBonus = {
    total: atkStats.bonus,
    parts: atkStats.parts || [{ source: weapon?.name || 'Attack', value: atkStats.bonus }]
  };

  // --- Damage breakdown ---
  // Same approach: trust the M6 derivation for now; M12 adds magic +N etc.
  const damage = {
    dice: atkStats.dice,
    damageType: atkStats.damageType,
    parts: atkStats.damageParts || []
  };

  // --- d20 mode: collect advantage + disadvantage reasons ---
  const advReasons = [];
  const disReasons = [];

  // Attacker conditions
  if (attackerConditions.has('poisoned'))    disReasons.push('Attacker poisoned');
  if (attackerConditions.has('blinded'))     disReasons.push('Attacker blinded');
  if (attackerConditions.has('frightened'))  disReasons.push('Attacker frightened');
  if (attackerConditions.has('restrained'))  disReasons.push('Attacker restrained');
  if (attackerConditions.has('prone'))       disReasons.push('Attacker prone');
  if (attackerConditions.has('invisible'))   advReasons.push('Attacker invisible');

  // Target conditions
  if (targetConditions.has('blinded'))     advReasons.push('Target blinded');
  if (targetConditions.has('restrained'))  advReasons.push('Target restrained');
  if (targetConditions.has('invisible'))   disReasons.push('Target invisible');
  if (targetConditions.has('paralyzed'))   advReasons.push('Target paralyzed');
  if (targetConditions.has('stunned'))     advReasons.push('Target stunned');
  if (targetConditions.has('unconscious')) advReasons.push('Target unconscious');
  if (targetConditions.has('petrified'))   advReasons.push('Target petrified');
  if (targetConditions.has('prone')) {
    // Prone is the only condition with a melee/ranged split.
    if (ranged) disReasons.push('Target prone (ranged)');
    else        advReasons.push('Target prone (melee)');
  }

  // 5e PHB: any advantage + any disadvantage → normal (canceling).
  let resolvedMode = 'normal';
  if (advReasons.length && !disReasons.length) resolvedMode = 'advantage';
  else if (disReasons.length && !advReasons.length) resolvedMode = 'disadvantage';
  else if (advReasons.length && disReasons.length) resolvedMode = 'normal';

  // Override path: UI radio outranks resolver verdict when set.
  let finalMode = resolvedMode;
  let overrideApplied = false;
  if (advantageOverride && advantageOverride !== 'auto') {
    finalMode = advantageOverride;
    overrideApplied = true;
  }

  // --- autoCrit: melee within 5ft of paralyzed / unconscious target ---
  let autoCrit = false;
  let autoCritReason = null;
  const targetIncapacitatedToAutoCrit =
    targetConditions.has('paralyzed') ||
    targetConditions.has('unconscious');
  if (targetIncapacitatedToAutoCrit && !ranged) {
    const attackerPos = positionOfEntity(attacker, attackerKind, scene);
    const targetPos   = positionOfEntity(target, targetKind, scene);
    if (chebyshevFeet(attackerPos, targetPos) <= 5) {
      autoCrit = true;
      autoCritReason = `Target ${targetConditions.has('paralyzed') ? 'paralyzed' : 'unconscious'}, melee within 5 ft`;
    }
  }

  return {
    attackBonus,
    damage,
    d20: {
      mode: finalMode,
      resolvedMode,
      overrideApplied,
      advantage: advReasons,
      disadvantage: disReasons
    },
    autoCrit,
    autoCritReason,
    autoMiss: blockers.length > 0,
    blockers,
    targetAC: targetAC ?? 10,
    weaponIsRanged: ranged
  };
}

// ---------- Helpers ----------

function conditionsOf(entity) {
  return new Set(Array.isArray(entity?.conditions) ? entity.conditions : []);
}

/**
 * Pull positions out of the scene. PC positions live on scene.positions
 * keyed by character id; monster positions live on the instance itself.
 * Callers may pass entities that already carry _position (the rendered
 * monster character) — we honor that as a shortcut.
 */
function positionOfEntity(entity, kind, scene) {
  if (!entity || !scene) return null;
  if (entity._position) return entity._position;
  if (entity.position)  return entity.position;   // monster instance shape
  if (kind === 'pc' && entity.id != null) {
    return scene.positions?.[String(entity.id)] || null;
  }
  return null;
}

/**
 * Fallback attack-stat derivation. For PCs we use the M6 deriveWeaponAttack
 * pipeline; for monsters we mirror the simpler preset-driven shape.
 * Returns { bonus, dice, damageType, parts, damageParts }.
 *
 * Callers SHOULD pass `ctx.attackStats` directly when they have richer
 * info (e.g. main.js's getAttackStats already mixes monster preset attack
 * blocks); this fallback exists so the resolver can be tested in isolation.
 */
function deriveAttackStatsForContext(ctx) {
  if (ctx.attackerKind === 'pc') {
    const a = deriveWeaponAttack(ctx.attacker, ctx.weapon);
    return {
      bonus: a.bonus,
      dice:  a.dice,
      damageType: a.damageType,
      parts: [{ source: ctx.weapon?.name || 'Attack', value: a.bonus }],
      damageParts: []
    };
  }
  // Monster: caller passes attackStats directly (we don't reach into
  // MONSTER_PRESETS here to keep this module decoupled from that data).
  return { bonus: 0, dice: '1d4', damageType: null, parts: [], damageParts: [] };
}
