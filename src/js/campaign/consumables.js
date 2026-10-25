/**
 * M65 R27 — consumables: the SRD potion registry and its effects.
 *
 * Open5e gives potion healing only as prose, so the amounts come from
 * the SRD 5.1 "Potions of Healing" table — one table, the engine's
 * `ITEM_EFFECTS` (scene/item-effects.js, T23); this registry adds names,
 * rarities and Open5e keys. Between nodes a potion is drunk through
 * `drinkPotion` (state_json); during an encounter it is the engine's item
 * action, fed by `itemsLedgerFor` (entity `resources.items`, `effect` =
 * the registry key).
 *
 * Pure module (Node + browser): no DOM, no `node:` imports, no
 * Math.random — rolls draw from the injected run rng.
 */

import { rollDice } from '../scene/combat-roll.js';
import { requireRng } from '../scene/rng.js';
import { ruleAssert } from './errors.js';
import { clone, pushDelta } from './util.js';
import { effectiveHpMax } from './exhaustion.js';
import { ITEM_EFFECTS } from '../scene/item-effects.js';

const potion = (id, name, rarity) => Object.freeze({
  id, name, rarity, dice: ITEM_EFFECTS[id].dice, refKeys: Object.freeze([`srd_${id}`])
});

/** SRD 5.1 Potions of Healing (2d4+2, 4d4+4, 8d4+8, 10d4+20 via ITEM_EFFECTS). */
export const POTIONS = Object.freeze({
  'potion-of-healing': potion('potion-of-healing', 'Potion of Healing', 'common'),
  'potion-of-greater-healing': potion('potion-of-greater-healing', 'Potion of Greater Healing', 'uncommon'),
  'potion-of-superior-healing': potion('potion-of-superior-healing', 'Potion of Superior Healing', 'rare'),
  'potion-of-supreme-healing': potion('potion-of-supreme-healing', 'Potion of Supreme Healing', 'very rare')
});

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The registry entry for an item (run item, inventory row, Open5e
 * payload, or a plain name / key), or null.
 * @param {object|string} itemOrName
 * @returns {object|null}
 */
export function potionFor(itemOrName) {
  if (!itemOrName) return null;
  const keys = typeof itemOrName === 'string'
    ? [itemOrName]
    : [itemOrName.refKey, itemOrName.key, itemOrName.name, itemOrName.data?.potionId];
  for (const k of keys) {
    if (!k) continue;
    const s = slug(String(k).replace(/^srd_/, ''));
    if (POTIONS[s]) return POTIONS[s];
    for (const p of Object.values(POTIONS)) if (p.refKeys.includes(String(k))) return p;
  }
  return null;
}

/**
 * The effect an item has when used, in the engine's `resources.items`
 * shape (`{kind: 'heal', dice}`), or null for items with no modelled effect.
 * @param {object|string} item
 * @returns {{kind: 'heal', dice: string}|null}
 */
export function itemEffectOf(item) {
  const p = potionFor(item);
  return p ? { ...ITEM_EFFECTS[p.id] } : null;
}

/**
 * The entity ledger for an owner's usable items (EncounterState v1 entity
 * `resources.items`): `{ [runItemId]: {name, effect: <registry key>, max,
 * spent: 0} }`, max = quantity. Items without a known effect or with no
 * quantity are skipped.
 * @param {{id: string|number, name: string, qty: number}[]} items — run items
 * @returns {Record<string, {name: string, effect: string, max: number, spent: number}>}
 */
export function itemsLedgerFor(items) {
  const out = {};
  for (const it of (Array.isArray(items) ? items : [])) {
    const p = potionFor(it);
    const qty = Math.trunc(Number(it?.qty) || 0);
    if (!p || qty <= 0 || it.id == null) continue;
    out[String(it.id)] = { name: it.name, effect: p.id, max: qty, spent: 0 };
  }
  return out;
}

/**
 * Roll a potion's healing.
 * @param {object|string} potion — registry entry or anything potionFor accepts
 * @param {function(): number} rng
 * @returns {{healed: number, rolls: number[], dice: string}}
 */
export function rollPotion(potion, rng) {
  requireRng(rng, 'rollPotion');
  const p = potion?.dice ? potion : potionFor(potion);
  ruleAssert(p, 'not-a-potion', 'That item has no healing effect.');
  const r = rollDice(p.dice, rng);
  return { healed: r.total, rolls: r.rolls, dice: p.dice };
}

/**
 * Drink a healing potion between nodes: HP up to the (exhaustion-adjusted)
 * max; a PC at 0 HP stands up and its death saves reset. Dead characters
 * cannot be healed by a potion.
 * @param {object} sheet — run sheet (hp.max)
 * @param {object} state — state_json v1
 * @param {object|string} potion
 * @param {function(): number} rng
 * @param {{lifeStatus?: string}} [opts]
 * @returns {{state: object, healed: number, rolled: number, rolls: number[], deltas: object[]}}
 */
export function drinkPotion(sheet, state, potion, rng, { lifeStatus } = {}) {
  ruleAssert(lifeStatus !== 'dead' && !(Number(state?.deathSaves?.failures) >= 3), 'dead', 'A dead character cannot drink a potion.');
  const roll = rollPotion(potion, rng);
  const next = clone(state || {});
  next.hp = { current: 0, temp: 0, ...(next.hp || {}) };
  const before = next.hp.current;
  next.hp.current = Math.min(effectiveHpMax(sheet, state), before + roll.healed);
  const deltas = [];
  pushDelta(deltas, 'hp.current', before, next.hp.current);
  if (before <= 0 && next.hp.current > 0 && next.deathSaves) {
    const ds = { successes: 0, failures: 0, stable: false };
    pushDelta(deltas, 'deathSaves', next.deathSaves, ds);
    next.deathSaves = ds;
  }
  return { state: next, healed: next.hp.current - before, rolled: roll.healed, rolls: roll.rolls, deltas };
}
