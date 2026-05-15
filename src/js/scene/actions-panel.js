/**
 * M17 — Active-turn actions panel.
 *
 * Given an entity (PC or monster instance) and the scene context, builds
 * the structured "what can this entity do right now?" list. Pure
 * functions, no DOM. Inputs: the entity, kind ('pc' | 'monster'), the
 * scene, the party/monster lists, and the entity's combat resolver
 * state (weapons, conditions, position).
 *
 * Output shape:
 *   {
 *     attacks: [
 *       { weapon, bonus, dice, damageType, reachFt, isRanged,
 *         targetsInRange: [ { entity, kind, distance } ],
 *         available: bool, blockReason: string | null,
 *         hints: [ 'Sneak Attack: 3d6 (Ally adjacent to Goblin 1)', ... ]
 *       }
 *     ],
 *     features: [
 *       { name, source, dice, uses, summary }
 *     ],
 *     common: [
 *       { name, available, blockReason }
 *     ],
 *     blockers: [ '...' ]   // entity-wide refusals (incapacitated etc.)
 *   }
 */

import { deriveWeaponAttack } from './pc-stats.js';
import {
  chebyshevFeet, meleeReachFt, isRangedWeapon, factionLists
} from './grid-rules.js';
import { resolveAttack } from './combat-resolver.js';

// Fallback ranges (normal range, in feet) for ranged weapons when the
// parser hasn't supplied range.normal. Numbers from PHB.
const RANGED_NORMAL_FT = {
  shortbow: 80, longbow: 150,
  'hand crossbow': 30, 'light crossbow': 80, 'heavy crossbow': 100,
  crossbow: 80, sling: 30, dart: 20, javelin: 30, blowgun: 25
};

/**
 * Look up the normal range in feet for a weapon. Uses weapon.range.normal
 * when present, else the name keyword table, else a generous 80ft default
 * so we don't accidentally hide useful options.
 */
export function rangedNormalFt(weapon) {
  if (!weapon) return 0;
  if (weapon.range && Number.isFinite(weapon.range.normal)) return weapon.range.normal;
  const n = String(weapon.name || '').toLowerCase();
  for (const key of Object.keys(RANGED_NORMAL_FT)) {
    if (n.includes(key)) return RANGED_NORMAL_FT[key];
  }
  return 80;
}

/**
 * Build the full action list for the given entity.
 *
 *   entity     — the PC or monster instance
 *   kind       — 'pc' | 'monster'
 *   scene      — current scene
 *   party      — array of all PCs on the scene (rendered objects)
 *   monsters   — array of all monster instances
 *
 * The entity is expected to have a resolvable position (PC via
 * scene.positions or monster via .position). If position is missing the
 * function falls back to "targets unknown" and marks attacks as
 * available without distance filtering.
 */
export function buildActionsFor({ entity, kind, scene, party, monsters }) {
  const conditions = new Set(Array.isArray(entity?.conditions) ? entity.conditions : []);

  // Entity-wide blockers (no actions whatsoever)
  const blockers = [];
  for (const c of ['paralyzed', 'stunned', 'unconscious', 'petrified']) {
    if (conditions.has(c)) blockers.push(`Incapacitated (${c})`);
  }
  // Even when incapacitated we still build the lists below so the UI can
  // dim them with a banner — easier to read than an empty panel.

  const { allies, hostiles } = factionLists({
    attackerKind: kind, attackerId: entity?.id, party, monsters
  });
  const entityPos = entityPosition(entity, kind, scene);

  const attacks  = buildAttacks({ entity, kind, scene, allies, hostiles, entityPos, blockers });
  const features = buildFeatures(entity);
  const common   = buildCommonActions({ entity, kind, scene, allies, hostiles, entityPos, conditions, blockers });

  return { attacks, features, common, blockers };
}

// ---------- Attacks ----------

function buildAttacks({ entity, kind, scene, allies, hostiles, entityPos, blockers }) {
  const weapons = collectWeapons(entity);
  if (weapons.length === 0) {
    return [];
  }
  return weapons.map(weapon => {
    const stats = (kind === 'pc')
      ? deriveWeaponAttack(entity, weapon)
      : { name: weapon.name || 'Strike', bonus: 0, dice: '1d4', damageType: null };
    const ranged = isRangedWeapon(weapon);
    const reach  = ranged ? rangedNormalFt(weapon) : meleeReachFt(weapon);

    // For each hostile, ask the resolver what would happen if we
    // attacked them with this weapon. That gives us availability + the
    // class-feature hints (Sneak Attack etc.) for free.
    const targetsInRange = [];
    const featureHints = new Set();
    for (const h of hostiles) {
      const hPos = h?._position || h?.position;
      const dist = entityPos && hPos ? chebyshevFeet(entityPos, hPos) : null;
      if (dist != null && dist > reach) continue;
      targetsInRange.push({ entity: h, distance: dist });

      // Run the resolver against this candidate target. We don't need
      // the full attack roll — just availability hints (autoMiss,
      // features). attackStats are passed pre-baked from `stats`.
      const verdict = resolveAttack({
        attacker: entity,
        target: h,
        weapon,
        scene,
        attackerKind: kind,
        targetKind: 'monster',     // hostiles list is opposite faction
        targetAC: 10,              // placeholder — we don't use atk total here
        advantageOverride: 'auto',
        attackStats: stats,
        allies, hostiles
      });
      for (const f of (verdict.features || [])) {
        if (f.available) {
          featureHints.add(`${f.name}: ${f.dice} vs ${h.name || 'target'} (${f.reason || ''})`.trim());
        }
      }
    }

    let available = !blockers.length;
    let blockReason = blockers.length ? blockers[0] : null;
    if (available && targetsInRange.length === 0) {
      available = false;
      blockReason = ranged
        ? `No targets within ${reach} ft`
        : `No targets in reach (${reach} ft)`;
    }
    return {
      weapon, name: stats.name, bonus: stats.bonus, dice: stats.dice,
      damageType: stats.damageType, reachFt: reach, isRanged: ranged,
      targetsInRange, available, blockReason,
      hints: [...featureHints]
    };
  });
}

/**
 * Pull every weapon attached to the entity. For PCs that's equipment.*
 * (mainhand/offhand) plus carried items with a damage field. For monsters
 * we synthesize one weapon from preset.attack (caller wires that in
 * separately by setting entity._weapons before calling).
 */
function collectWeapons(entity) {
  if (!entity) return [];
  const seen = new Set();
  const out = [];
  const consider = (w) => {
    if (!w || !w.name) return;
    if (!w.damage) return;     // shields, amulets, etc. — not weapons
    const key = `${w.name}|${w.damage}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };
  const eq = entity.equipment || {};
  consider(eq.mainhand);
  consider(eq.offhand);
  for (const c of (entity.carried || [])) {
    if (c?.slot === 'back' || c?.slot === 'waist') consider(c);
  }
  // Allow callers to pre-attach extra weapons (e.g. monster preset attack)
  if (Array.isArray(entity._weapons)) {
    for (const w of entity._weapons) consider(w);
  }
  return out;
}

// ---------- Class features ----------

function buildFeatures(entity) {
  const list = Array.isArray(entity?.classFeatures) ? entity.classFeatures : [];
  // Only surface "actionable" features in the panel — ones with dice or
  // limited uses. Passive grants (Bonus Proficiencies, Spellcasting
  // header) are noise here even though they show on the sheet.
  return list
    .filter(f => f.dice || f.uses)
    .map(f => ({
      name: f.name, source: f.source, dice: f.dice || null,
      uses: f.uses || null, level: f.level
    }));
}

// ---------- Common actions (PHB p192–193) ----------

const COMMON_ACTIONS = [
  { key: 'Attack',     summary: 'Use the Attack action with a weapon row above.' },
  { key: 'Dash',       summary: 'Double your movement speed for this turn.' },
  { key: 'Disengage',  summary: "Your movement doesn't provoke opportunity attacks." },
  { key: 'Dodge',      summary: 'Attacks against you have disadvantage; DEX saves at advantage.' },
  { key: 'Hide',       summary: 'Make a Stealth check to become hidden.' },
  { key: 'Help',       summary: 'Aid an ally within 5 ft; their next attack has advantage.' },
  { key: 'Ready',      summary: 'Prepare a trigger + reaction action.' },
  { key: 'Search',     summary: 'Look or listen for something.' },
  { key: 'Use Object', summary: 'Interact with a second object on your turn.' }
];

function buildCommonActions({ allies, entityPos, conditions, blockers }) {
  const speedZero = conditions.has('grappled') || conditions.has('restrained');
  const allyAdjacent = allies.some(a => {
    const aPos = a._position || a.position;
    return entityPos && aPos && chebyshevFeet(entityPos, aPos) <= 5;
  });

  return COMMON_ACTIONS.map(({ key, summary }) => {
    let available = !blockers.length;
    let blockReason = blockers.length ? blockers[0] : null;
    if (available) {
      if (key === 'Dash' || key === 'Disengage') {
        if (speedZero) {
          available = false;
          blockReason = 'Speed 0 (grappled / restrained)';
        } else if (conditions.has('prone')) {
          // Prone halves movement; you can still Dash. Just note it.
          blockReason = 'Prone — half movement until you stand';
        }
      } else if (key === 'Hide' || key === 'Search') {
        if (conditions.has('blinded')) {
          available = false;
          blockReason = 'Blinded';
        }
      } else if (key === 'Help') {
        if (!allyAdjacent) {
          available = false;
          blockReason = 'No ally within 5 ft';
        }
      }
    }
    return { name: key, summary, available, blockReason };
  });
}

// ---------- Position lookup ----------

function entityPosition(entity, kind, scene) {
  if (!entity || !scene) return null;
  if (entity._position) return entity._position;
  if (entity.position)  return entity.position;
  if (kind === 'pc' && entity.id != null) {
    return scene.positions?.[String(entity.id)] || null;
  }
  return null;
}
