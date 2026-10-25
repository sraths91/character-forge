/**
 * M65 T23 — what a run item does when a creature uses it in combat.
 *
 * An entity carries its run items as `resources.items {[runItemId]:
 * {name, effect, max, spent}}` (wrapper `_items`). `effect` is either a
 * registry key ('potion-of-healing') or an inline `{kind: 'heal', dice}`.
 * The SRD potion amounts live here because Open5e has them only as prose
 * (M65 "Rests, items, currency"): Healing 2d4+2, Greater 4d4+4, Superior
 * 8d4+8, Supreme 10d4+20 (SRD 5.1 p.235). E4's campaign consumables
 * registry produces the same keys / shapes.
 *
 * Pure module: no DOM, no rng.
 */

/** SRD consumables the engine resolves, keyed like the item's slug. */
export const ITEM_EFFECTS = Object.freeze({
  'potion-of-healing': Object.freeze({ kind: 'heal', dice: '2d4+2' }),
  'potion-of-greater-healing': Object.freeze({ kind: 'heal', dice: '4d4+4' }),
  'potion-of-superior-healing': Object.freeze({ kind: 'heal', dice: '8d4+8' }),
  'potion-of-supreme-healing': Object.freeze({ kind: 'heal', dice: '10d4+20' })
});

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
