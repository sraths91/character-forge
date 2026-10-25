/**
 * M65 T23 — what a run item does when a creature uses it in combat.
 *
 * An entity carries its run items as `resources.items {[runItemId]:
 * {name, effect, max, spent}}` (wrapper `_items`). `effect` is either a
 * registry key ('potion-of-healing') or an inline `{kind: 'heal', dice}`.
 *
 * The data source is E4's campaign consumables registry
 * (campaign/consumables.js `POTIONS`, SRD 5.1 p.235 — Open5e has the
 * amounts only as prose). This module only derives the engine's
 * `{kind, dice}` view of it and resolves an entity's item record.
 *
 * Pure module: no DOM, no rng.
 */

import { POTIONS } from '../campaign/consumables.js';

/** SRD consumables the engine resolves, keyed like the item's slug (derived from POTIONS). */
export const ITEM_EFFECTS = Object.freeze(Object.fromEntries(
  Object.values(POTIONS).map(p => [p.id, Object.freeze({ kind: 'heal', dice: p.dice })])
));

/** Effect kinds the engine can resolve. */
export const ITEM_EFFECT_KINDS = Object.freeze(['heal']);

const DICE = /^\d+d\d+(?:[+-]\d+)?$/;

function slugOf(name) {
  return String(name || '').toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The resolvable effect of a run item, or null when the engine cannot use
 * it (unknown key, unsupported kind, bad dice). A missing `effect` falls
 * back to the item's name ("Potion of Healing" → 'potion-of-healing').
 * @param {{name?: string, effect?: string|object|null}|null} item
 * @returns {{kind: 'heal', dice: string}|null}
 */
export function itemEffectOf(item) {
  if (!item || typeof item !== 'object') return null;
  const e = item.effect;
  if (e && typeof e === 'object') {
    if (!ITEM_EFFECT_KINDS.includes(e.kind) || !DICE.test(String(e.dice || '').replace(/\s+/g, ''))) return null;
    return { kind: e.kind, dice: String(e.dice).replace(/\s+/g, '') };
  }
  const key = typeof e === 'string' && e ? e : slugOf(item.name);
  const known = ITEM_EFFECTS[key];
  return known ? { ...known } : null;
}

/**
 * Uses left on an item record (`max - spent`, never negative).
 * @param {{max?: number, spent?: number}|null} item
 * @returns {number}
 */
export function itemUsesLeft(item) {
  return Math.max(0, (Math.trunc(Number(item?.max) || 0)) - (Math.trunc(Number(item?.spent) || 0)));
}
