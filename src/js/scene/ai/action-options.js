/**
 * M42 — Action option enumeration.
 *
 * Unified "what could this entity do this turn?" enumeration for both
 * PCs and monsters. Replaces the implicit "always melee with mainhand"
 * assumption baked into the simulator with an explicit menu of every
 * legal action, each with preconditions and a base utility hint.
 *
 * The scoring layer (chooseEntityAction) takes this list and picks the
 * winner. This module is pure data + filtering — no rng, no decision.
 *
 * ActionOption shape:
 *   {
 *     id:         string             // 'melee:longsword' | 'ranged:longbow' | 'cast:fire-bolt' | 'feature:action-surge'
 *     kind:       string             // 'melee' | 'ranged' | 'cast' | 'heal' | 'feature' | 'dash' | 'disengage'
 *     label:      string             // human-readable, surfaces in roll log
 *     weapon?:    object             // weapon record (for melee/ranged)
 *     spellId?:   string             // for kind:'cast'
 *     castAtLevel?: number
 *     featureId?: string             // for kind:'feature'
 *     range:      number             // ft. for distance-to-target gating
 *     baseScore:  number             // before profile weighting
 *     gates:      string[]           // names of preconditions that must hold
 *   }
 */

import { isRangedWeapon, meleeReachFt } from '../grid-rules.js';

/** Build the action menu for `entity`. The `_target` parameter is
 *  reserved for future target-aware option filtering (e.g. surface a
 *  Throw action only when target is at the right range). */
export function enumerateActions(entity, _target) {
  if (!entity) return [];
  const options = [];

  // ---- Weapon attacks (PC or monster) ----
  for (const wpn of weaponsAvailableFor(entity)) {
    const ranged = isRangedWeapon(wpn);
    const reach = ranged ? (wpn.range || 80) : meleeReachFt(wpn);
    options.push({
      id: `${ranged ? 'ranged' : 'melee'}:${wpn.id || wpn.name || 'weapon'}`,
      kind: ranged ? 'ranged' : 'melee',
      label: wpn.name || (ranged ? 'Ranged attack' : 'Melee attack'),
      weapon: wpn,
      range: reach,
      baseScore: 0.5,
      gates: ranged ? ['target_in_ranged_range'] : ['target_in_melee_reach']
    });
  }

  // ---- Dash / Disengage / Dodge ----
  // These are utility actions; the scorer turns them on when conditions
  // demand (e.g., low HP + far from target → dash to flee, etc.).
  options.push({
    id: 'dash',         kind: 'dash',
    label: 'Dash',      range: 0, baseScore: 0.1, gates: []
  });
  options.push({
    id: 'disengage',    kind: 'disengage',
    label: 'Disengage', range: 0, baseScore: 0.1, gates: ['hostile_adjacent']
  });
  options.push({
    id: 'dodge',        kind: 'dodge',
    label: 'Dodge',     range: 0, baseScore: 0.1, gates: []
  });

  return options;
}

/**
 * Pull every weapon `entity` could swing this turn. PCs return
 * mainhand + offhand + any carried weapons; monsters return their
 * preset's primary plus an optional `secondary` attack record (e.g.
 * a goblin's shortbow alongside its scimitar).
 */
export function weaponsAvailableFor(entity) {
  if (!entity) return [];
  const ref = entity.ref || entity;
  const out = [];
  // Monster-shape: preset.attack is the primary
  if (entity.kind === 'monster' || ref._isMonster) {
    if (entity.attack) out.push({ ...entity.attack, _slot: 'primary' });
    if (entity.secondary) out.push({ ...entity.secondary, _slot: 'secondary' });
    return out;
  }
  // PC-shape: equipment + carried
  const eq = ref.equipment || {};
  if (eq.mainhand) out.push({ ...eq.mainhand, _slot: 'mainhand' });
  if (eq.offhand && eq.offhand.name && /\b(sword|axe|dagger|mace|hammer|club)\b/i.test(eq.offhand.name)) {
    // Treat shields / books as non-weapons (offhand exists but isn't a weapon)
    out.push({ ...eq.offhand, _slot: 'offhand' });
  }
  // M42 — Stowed weapons (mostly ranged) live in carried[]. The PC can
  // switch to them as a "free interact with one object per turn".
  for (const item of (ref.carried || [])) {
    if (!item) continue;
    const name = (item.name || '').toLowerCase();
    if (/longbow|shortbow|crossbow|sling|javelin|throwing|dart|hand crossbow/.test(name)) {
      out.push({ ...item, _slot: 'stowed' });
    }
  }
  return out;
}

/** Distance + reach gate. Pure helper used by the scorer. */
export function gateOk(option, ctx) {
  const { distance, hostileAdjacent } = ctx;
  for (const g of option.gates) {
    if (g === 'target_in_melee_reach' && distance > option.range) return false;
    if (g === 'target_in_ranged_range' && distance > option.range) return false;
    if (g === 'hostile_adjacent' && !hostileAdjacent) return false;
  }
  return true;
}
