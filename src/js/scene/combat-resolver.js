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
import {
  chebyshevFeet as gridDistance,
  meleeReachFt,
  isFlanking,
  hostileInMeleeOfRangedAttacker,
  isRangedWeapon
} from './grid-rules.js';
import { evaluateFeatures } from './class-feature-rules.js';

// Re-export grid distance + ranged-detection helpers so existing M11
// callers (and tests importing from combat-resolver) keep working.
// The canonical home is grid-rules.js.
export { chebyshevFeet, isRangedWeapon } from './grid-rules.js';

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
  // Start from the M6 derivation (ability mod + proficiency + magic +N
  // from the weapon name), then add any M12 combatMods that apply to
  // this attack type.
  const atkStats = ctx.attackStats || deriveAttackStatsForContext(ctx);
  const attackParts = atkStats.parts
    ? [...atkStats.parts]
    : [{ source: weapon?.name || 'Attack', value: atkStats.bonus }];
  const damageParts = atkStats.damageParts ? [...atkStats.damageParts] : [];
  const attackScope = attackScopeFor(weapon, ranged);

  // M12 — Apply combat modifiers from the attacker's items/feats/etc.
  const mods = Array.isArray(attacker?.combatMods) ? attacker.combatMods : [];
  for (const mod of mods) {
    if (mod.inactive) continue;
    if (mod.kind === 'attack' && scopeMatches(mod.scope, attackScope)) {
      attackParts.push({ source: mod.source, value: mod.value });
    } else if (mod.kind === 'damage' && scopeMatches(mod.scope, attackScope)) {
      damageParts.push({ source: mod.source, value: mod.value });
    }
  }

  const attackBonusTotal = attackParts.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
  const damageFlatTotal  = damageParts.reduce((sum, p) => sum + (Number(p.value) || 0), 0);

  const attackBonus = { total: attackBonusTotal, parts: attackParts };

  const damage = {
    dice: appendModToDice(atkStats.dice, damageFlatTotal),
    damageType: atkStats.damageType,
    parts: damageParts,
    flatBonus: damageFlatTotal
  };

  // Position lookup — used by reach/flanking/ranged-adjacent/autoCrit.
  const attackerPos = positionOfEntity(attacker, attackerKind, scene);
  const targetPos   = positionOfEntity(target, targetKind, scene);
  const distance    = gridDistance(attackerPos, targetPos);

  // --- M14: Out-of-reach blocker for melee attacks ---
  if (!ranged && Number.isFinite(distance)) {
    const reach = meleeReachFt(weapon);
    if (distance > reach) {
      blockers.push(`Out of reach (${distance} ft away, ${reach} ft reach)`);
    }
  }

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

  // --- M14: Flanking advantage (5e optional rule, scene-toggled) ---
  // Both attacker and a friendly creature must be adjacent to the target
  // on opposite sides. Only applies to melee attacks.
  if (!ranged && scene?.flankingEnabled && Array.isArray(ctx.allies) && ctx.allies.length) {
    const fl = isFlanking(attackerPos, targetPos, ctx.allies);
    if (fl.flanking) {
      advReasons.push(`Flanking with ${fl.ally?.name || 'ally'}`);
    }
  }

  // --- M14: Ranged attacker adjacent to a hostile → disadvantage ---
  // PHB p195: "You have disadvantage on a ranged attack roll if you are
  // within 5 feet of a hostile creature who can see you and isn't
  // incapacitated." We can't model "can see you" without vision rules,
  // so we apply RAW minus that clause (conservative).
  if (ranged && Array.isArray(ctx.hostiles)) {
    const adjacent = hostileInMeleeOfRangedAttacker(attackerPos, ctx.hostiles);
    if (adjacent) {
      disReasons.push(`Ranged attacker adjacent to ${adjacent.name || 'hostile'}`);
    }
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

  // --- M15: Class-feature availability (Sneak Attack et al) ---
  // The registry evaluates rules against the attack context. We pass
  // finalMode as `resolvedMode` because per 5e RAW "if you have
  // advantage on the attack roll" refers to the actual roll mode —
  // a player invoking Reckless Attack or another override DOES have
  // advantage for SA purposes. resolvedModeRaw is also exposed so
  // future rules that care specifically about RAW pre-override state
  // (e.g. some homebrew) can access it.
  const features = evaluateFeatures({
    attacker, target, weapon, scene, attackerKind, targetKind,
    resolvedMode: finalMode,
    resolvedModeRaw: resolvedMode,
    advReasons, disReasons,
    allies: ctx.allies, hostiles: ctx.hostiles
  });

  // --- autoCrit: melee within 5ft of paralyzed / unconscious target ---
  // (positions and distance computed earlier; reuse them here.)
  let autoCrit = false;
  let autoCritReason = null;
  const targetIncapacitatedToAutoCrit =
    targetConditions.has('paralyzed') ||
    targetConditions.has('unconscious');
  if (targetIncapacitatedToAutoCrit && !ranged && distance <= 5) {
    autoCrit = true;
    autoCritReason = `Target ${targetConditions.has('paralyzed') ? 'paralyzed' : 'unconscious'}, melee within 5 ft`;
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
    weaponIsRanged: ranged,
    features
  };
}

// ---------- Helpers ----------

function conditionsOf(entity) {
  return new Set(Array.isArray(entity?.conditions) ? entity.conditions : []);
}

// M12 — Determine what scope tag matches the current attack so combat
// modifiers can be filtered. Spells aren't supported in the attack flow
// yet (M11 only handles weapon attacks), so we always return a weapon
// scope here. The 'spell' branch is reserved for the future spell flow.
function attackScopeFor(weapon, isRanged) {
  if (!weapon) return 'weapon-melee';   // unarmed strikes are melee
  return isRanged ? 'weapon-ranged' : 'weapon-melee';
}

// Modifier scope matching against the current attack scope.
// Hierarchy: 'all' > 'weapon-all' > specific weapon-melee/ranged.
// 'spell' / 'unarmored' never match a weapon attack.
function scopeMatches(modScope, attackScope) {
  if (modScope === 'all') return true;
  if (modScope === 'weapon-all' && attackScope.startsWith('weapon-')) return true;
  return modScope === attackScope;
}

// Append a numeric modifier to an existing dice spec.
//   '1d8+3' + 1 → '1d8+4'
//   '1d6'  + 2 → '1d6+2'
//   '1d6-1' + 2 → '1d6+1'
//   '2d6+3' + -3 → '2d6'
function appendModToDice(diceSpec, extra) {
  if (!extra) return diceSpec;
  const m = String(diceSpec || '').match(/^(\d*d\d+)\s*([+-]\s*\d+)?\s*$/i);
  if (!m) return diceSpec;
  const base = m[1];
  const existing = m[2] ? parseInt(m[2].replace(/\s+/g, ''), 10) : 0;
  const total = existing + extra;
  if (total === 0) return base;
  return total > 0 ? `${base}+${total}` : `${base}${total}`;
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
