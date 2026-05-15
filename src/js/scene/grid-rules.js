/**
 * M14 — Positional rules.
 *
 * Pure functions that answer geometric questions about the battle scene:
 * Is this target within the attacker's reach? Is an ally flanking? Is the
 * ranged attacker adjacent to a hostile (and therefore at disadvantage)?
 *
 * No DOM, no globals. Inputs are plain values; the resolver passes the
 * already-built allies + hostiles lists in via ctx.
 *
 * Faction model (v1): two factions only — PCs and monsters. PCs are allies
 * of other PCs and hostile to monsters; monsters are allies of other
 * monsters and hostile to PCs. Per-entity factions can land later when
 * we have a "convert this monster to an ally" use case.
 */

/**
 * Square-grid distance in feet. 1 cell = 5ft per 5e PHB. Adjacent (incl.
 * diagonal) = 5ft, two cells away = 10ft. Co-located = 0ft.
 */
export function chebyshevFeet(posA, posB) {
  if (!posA || !posB) return Infinity;
  return Math.max(Math.abs(posA.col - posB.col), Math.abs(posA.row - posB.row)) * 5;
}

const REACH_NAME_KEYWORDS = ['halberd', 'glaive', 'pike', 'lance', 'whip'];
const RANGED_NAME_KEYWORDS = ['bow', 'crossbow', 'sling', 'dart', 'javelin', 'blowgun'];

/**
 * Heuristic: is this weapon used as a ranged attack? Trusted property
 * "ranged" wins. "thrown" weapons default to melee unless the caller sets
 * weapon.usedAsRanged. Falls back to name keyword match.
 */
export function isRangedWeapon(weapon) {
  if (!weapon) return false;
  const props = Array.isArray(weapon.properties)
    ? weapon.properties.map(p => String(p?.name || p || '').toLowerCase())
    : [];
  if (props.includes('ranged')) return true;
  if (props.includes('thrown') && !props.includes('finesse')) {
    return !!weapon.usedAsRanged;
  }
  const n = String(weapon.name || '').toLowerCase();
  return RANGED_NAME_KEYWORDS.some(k => n.includes(k));
}

/**
 * Reach for a melee weapon, in feet. Defaults to 5ft; reach weapons (or
 * anything with the "reach" property) get 10ft. Monster attack records
 * may include `.reach` on the preset which overrides everything else.
 */
export function meleeReachFt(weapon) {
  if (!weapon) return 5;
  if (Number.isFinite(weapon.reach)) return weapon.reach;
  const props = Array.isArray(weapon.properties)
    ? weapon.properties.map(p => String(p?.name || p || '').toLowerCase())
    : [];
  if (props.includes('reach')) return 10;
  const n = String(weapon.name || '').toLowerCase();
  if (REACH_NAME_KEYWORDS.some(k => n.includes(k))) return 10;
  return 5;
}

/**
 * Whether a target is within the attacker's melee reach.
 */
export function inMeleeReach(weapon, distanceFt) {
  return distanceFt <= meleeReachFt(weapon);
}

/**
 * Flanking (5e optional rule, DMG p251).
 *
 * Two creatures flank a target when they're on opposite sides of the
 * target's space — i.e. the ally is positioned diametrically opposite
 * the attacker, with the target between them. Both creatures must:
 *   - Be adjacent to the target (within 5ft).
 *   - Be capable of acting (not incapacitated).
 *   - Not be the target themselves.
 *
 * "Opposite sides" on a square grid: if the attacker is at offset (dc, dr)
 * relative to the target, the ally must be at (-dc, -dr). The 8 adjacent
 * cells of the target give 4 flanking pairs:
 *   N-S, E-W, NE-SW, NW-SE.
 *
 * Returns { flanking: boolean, ally: <entity or null> }. The ally is
 * returned so the UI can say "Flanking with <name>".
 */
export function isFlanking(attackerPos, targetPos, allies) {
  if (!attackerPos || !targetPos) return { flanking: false, ally: null };
  // Attacker must itself be adjacent
  if (chebyshevFeet(attackerPos, targetPos) > 5) return { flanking: false, ally: null };
  // Same cell as target doesn't make sense for flanking
  if (attackerPos.col === targetPos.col && attackerPos.row === targetPos.row) {
    return { flanking: false, ally: null };
  }
  const opposite = {
    col: 2 * targetPos.col - attackerPos.col,
    row: 2 * targetPos.row - attackerPos.row
  };
  for (const ally of (allies || [])) {
    const pos = ally._position || ally.position;
    if (!pos) continue;
    if (pos.col === opposite.col && pos.row === opposite.row) {
      if (isIncapacitatedForFlank(ally)) continue;
      return { flanking: true, ally };
    }
  }
  return { flanking: false, ally: null };
}

/**
 * Find any hostile creature adjacent (within 5ft) to the attacker.
 * Used to apply ranged-attacker disadvantage (PHB p195: "you have
 * disadvantage on a ranged attack roll if you are within 5 feet of a
 * hostile creature who can see you and isn't incapacitated").
 *
 * Returns the hostile entity that triggered it (null if none).
 */
export function hostileInMeleeOfRangedAttacker(attackerPos, hostiles) {
  if (!attackerPos) return null;
  for (const h of (hostiles || [])) {
    if (isIncapacitatedForFlank(h)) continue;
    const pos = h._position || h.position;
    if (!pos) continue;
    if (chebyshevFeet(attackerPos, pos) <= 5) return h;
  }
  return null;
}

/**
 * Build allies + hostiles lists for an attacker, given the party (PCs)
 * and the scene's monsters. Convenience for callers that don't want to
 * re-implement the faction split.
 *
 *   attackerKind === 'pc'      → allies: other PCs, hostiles: monsters
 *   attackerKind === 'monster' → allies: other monsters, hostiles: PCs
 *
 * Excludes the attacker itself from the allies list (you can't flank
 * with yourself).
 */
export function factionLists({ attackerKind, attackerId, party, monsters }) {
  const pcs = party || [];
  const mons = monsters || [];
  if (attackerKind === 'pc') {
    return {
      allies: pcs.filter(p => String(p.id) !== String(attackerId)),
      hostiles: mons
    };
  }
  return {
    allies: mons.filter(m => String(m.id) !== String(attackerId)),
    hostiles: pcs
  };
}

function isIncapacitatedForFlank(entity) {
  const conds = Array.isArray(entity?.conditions) ? entity.conditions : [];
  return conds.includes('paralyzed') ||
         conds.includes('stunned') ||
         conds.includes('unconscious') ||
         conds.includes('petrified');
}
