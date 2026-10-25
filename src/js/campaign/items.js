/**
 * M65 R27 — run items: model, Open5e → equipment mapping, equip /
 * unequip / attune rules, pricing and coin purses.
 *
 * A run item mirrors a `run_items` row in camelCase:
 *   {id, ownerSlotId (null = party stash), origin: 'ddb'|'open5e'|'dm',
 *    refKey, name, qty, equipped, attuned, chargesSpent,
 *    data: {slot, equipment, canAttune, magical, rarity, consumable,
 *           cost (gp, null = unpriced), weight, potionId, uses}}
 * `data.equipment` is exactly the summary the DDB parser puts in
 * `sheet.equipment[slot]`, so equipping rewrites `sheet.equipment` and the
 * existing `deriveAC` / `deriveWeaponAttack` (pc-stats.js) re-derive AC
 * and attacks at the next encounter. `sheet.carried` (the sprite view)
 * is kept in step.
 *
 * Pure module (Node + browser): no DOM, no `node:` imports, no rng.
 * Functions return new objects; inputs are never mutated.
 */

import { CampaignRuleError, ruleAssert } from './errors.js';
import { clone } from './util.js';
import { potionFor } from './consumables.js';
import { ITEM_ORIGINS } from '../shared/campaign.js';
import { MAX_ATTUNED } from '../shared/run-state.js';

/** Where a run item came from; the attunement limit (shared contracts). */
export { ITEM_ORIGINS, MAX_ATTUNED };

/** Ring slots on the sheet. */
export const MAX_RINGS = 2;

/** Equipment slots on `sheet.equipment` (rings is a list). */
export const EQUIPMENT_SLOTS = Object.freeze(['armor', 'mainhand', 'offhand', 'helm', 'boots', 'cloak', 'gloves', 'belt', 'amulet', 'ring']);

const WEAPON_PROPS = new Set(['finesse', 'light', 'heavy', 'thrown', 'versatile', 'two-handed', 'reach', 'ammunition', 'loading', 'special']);
const ARMOR_TYPE_ID = { light: 1, medium: 2, heavy: 3 };
const COIN_CP = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
const COINS = ['cp', 'sp', 'ep', 'gp', 'pp'];

/**
 * Wondrous-item slot from the name (the parser's classifyItem rules).
 * @param {string} name
 * @returns {string|null}
 */
function wondrousSlot(name) {
  const n = String(name || '').toLowerCase();
  if (/boots|slippers|sandals/.test(n)) return 'boots';
  if (/cloak|cape|mantle/.test(n)) return 'cloak';
  if (/gauntlet|gloves|bracers/.test(n)) return 'gloves';
  if (/helm|hat|circlet|crown|headband|mask/.test(n)) return 'helm';
  if (/amulet|necklace|pendant|periapt/.test(n)) return 'amulet';
  if (/belt|girdle/.test(n)) return 'belt';
  if (/\bring of\b|^ring\b/.test(n)) return 'ring';
  return null;
}

const nameSlug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;

/** "range 20/60" → {range: 20, longRange: 60}. */
function rangeFrom(detail) {
  const m = String(detail || '').match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { range: Number(m[1]), longRange: Number(m[2]) } : null;
}

/**
 * An Open5e v2 item (`/v2/items/` or `/v2/magicitems/`, srd-2014) → the
 * parser's equipment summary, or null when it is not armour, a shield or
 * a weapon. Armour: `armorClass` = `armor.ac_base`, `armorTypeId` from
 * `armor.category` (light 1 / medium 2 / heavy 3). Shield (category key
 * 'shield'): armorClass 2, armorTypeId 4. Weapon: `damage_dice`,
 * `damage_type.name`, normalised `properties`, attackType 2 for
 * ammunition weapons else 1, range from the property detail
 * ("range 20/60"), versatile die from the Versatile detail, simple /
 * martial category, and `twoHanded` like the parser's two-handed mainhand.
 * Verified against Open5e v2 payloads (srd_breastplate, srd_chain-mail,
 * srd_shield, srd_longsword, srd_dagger, srd_longbow) on 2026-10-25.
 * @param {object} o — Open5e item payload
 * @returns {object|null}
 */
export function itemToEquipment(o) {
  if (!o || typeof o !== 'object') return null;
  const base = {
    name: String(o.name || 'Item'),
    rarity: o.rarity?.name || 'Common',
    magical: !!o.requires_attunement || (!!o.rarity && o.rarity.key !== 'common'),
    attuned: false
  };
  if (o.armor && typeof o.armor === 'object') {
    return {
      ...base,
      armorClass: Number(o.armor.ac_base) || null,
      damage: null,
      damageType: null,
      armorTypeId: ARMOR_TYPE_ID[String(o.armor.category || '').toLowerCase()] ?? null
    };
  }
  if (o.category?.key === 'shield' || /^shield$/i.test(String(o.name || ''))) {
    return { ...base, armorClass: 2, damage: null, damageType: null, armorTypeId: 4 };
  }
  const w = o.weapon;
  if (w && typeof w === 'object') {
    const props = [];
    let range = null;
    let versatileDamage = null;
    for (const p of (Array.isArray(w.properties) ? w.properties : [])) {
      const n = String(p?.property?.name || p?.name || '').trim().toLowerCase().replace(/\s+/g, '-');
      if (WEAPON_PROPS.has(n) && !props.includes(n)) props.push(n);
      if ((n === 'thrown' || n === 'ammunition') && !range) range = rangeFrom(p?.detail);
      if (n === 'versatile' && /^\d+d\d+$/.test(String(p?.detail || '').trim())) versatileDamage = String(p.detail).trim();
    }
    const ranged = props.includes('ammunition');
    const isSimple = !!w.is_simple;
    const weaponType = nameSlug(String(w.name || o.name).split(',').map(s => s.trim()).join(' '));
    const out = {
      ...base,
      armorClass: null,
      damage: w.damage_dice || null,
      damageType: w.damage_type?.name || null,
      armorTypeId: null,
      properties: props,
      attackType: ranged ? 2 : 1,
      range: range ? range.range : 5,
      longRange: range ? range.longRange : 5,
      isMonkWeapon: !ranged && (weaponType === 'shortsword' || (isSimple && !props.includes('two-handed') && !props.includes('heavy'))),
      magicBonus: null,
      versatileDamage,
      weaponCategory: isSimple ? 'simple' : w.is_martial ? 'martial' : null,
      weaponType
    };
    if (props.includes('two-handed')) out.twoHanded = true;
    return out;
  }
  return null;
}

/** Slot of an equipment summary (+ the item name for wondrous items). */
function slotOf(equipment, name) {
  if (!equipment) return wondrousSlot(name);
  if (equipment.armorTypeId === 4) return 'offhand';
  if (equipment.armorTypeId >= 1 && equipment.armorTypeId <= 3) return 'armor';
  if (equipment.attackType === 1 || equipment.attackType === 2 || equipment.damage) return 'mainhand';
  return wondrousSlot(name);
}

/**
 * Price of an item in gold, from Open5e `cost` (a decimal string) or a
 * number. "0.00", null and junk are unpriced (the DM sets the price).
 * Sell-back is half, rounded down to the copper.
 * @param {object|string|number|null} itemOrCost — payload with `cost`, run item (`data.cost`), or the cost
 * @returns {{priced: boolean, buyCp: number|null, sellCp: number|null, buyGp: number|null, sellGp: number|null}}
 */
export function priceOf(itemOrCost) {
  const raw = itemOrCost && typeof itemOrCost === 'object'
    ? (itemOrCost.cost !== undefined ? itemOrCost.cost : itemOrCost.data?.cost)
    : itemOrCost;
  const gp = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(gp) || gp <= 0) return { priced: false, buyCp: null, sellCp: null, buyGp: null, sellGp: null };
  const buyCp = Math.round(gp * 100);
  const sellCp = Math.floor(buyCp / 2);
  return { priced: true, buyCp, sellCp, buyGp: buyCp / 100, sellGp: sellCp / 100 };
}

/**
 * A run item (validated, defaults filled).
 * @param {object} fields
 * @returns {object}
 */
export function makeItem(fields = {}) {
  ruleAssert(ITEM_ORIGINS.includes(fields.origin), 'bad-item', `Item origin must be one of ${ITEM_ORIGINS.join(', ')}.`);
  ruleAssert(typeof fields.name === 'string' && fields.name.trim(), 'bad-item', 'An item needs a name.');
  const qty = fields.qty === undefined ? 1 : Math.trunc(Number(fields.qty));
  ruleAssert(Number.isInteger(qty) && qty >= 0, 'bad-item', 'Quantity must be a whole number ≥ 0.');
  return {
    id: fields.id ?? null,
    ownerSlotId: fields.ownerSlotId ?? null,
    origin: fields.origin,
    refKey: fields.refKey ?? null,
    name: fields.name.trim(),
    qty,
    equipped: !!fields.equipped,
    attuned: !!fields.attuned,
    chargesSpent: Math.max(0, Math.trunc(Number(fields.chargesSpent) || 0)),
    data: clone(fields.data || {})
  };
}

/**
 * Run items from a parsed sheet's `inventory[]` (origin 'ddb').
 * @param {object} sheet — parseCharacter output (R23 inventory rows)
 * @param {{ownerSlotId?: string|null, idPrefix?: string}} [opts]
 * @returns {object[]}
 */
export function itemsFromInventory(sheet, { ownerSlotId = null, idPrefix = 'ddb' } = {}) {
  return (sheet?.inventory || []).map((row, i) => makeItem({
    id: `${idPrefix}-${row.inventoryId ?? i}`,
    ownerSlotId,
    origin: 'ddb',
    refKey: row.ddbId != null ? `ddb:${row.ddbId}` : null,
    name: row.name,
    qty: row.quantity ?? 1,
    equipped: !!row.equipped && !!row.slot,
    attuned: !!row.attuned,
    chargesSpent: row.uses?.used ?? 0,
    data: {
      slot: row.slot ?? null,
      equipment: row.equipment ?? null,
      canAttune: !!row.canAttune,
      magical: !!row.magical,
      rarity: row.rarity ?? null,
      consumable: !!row.consumable,
      cost: row.cost ?? null,
      weight: row.weight ?? null,
      potionId: potionFor(row.name)?.id ?? null,
      uses: row.uses ? { max: row.uses.max, reset: row.uses.reset } : null
    }
  }));
}

/**
 * A run item from an Open5e SRD payload.
 * @param {object} o — Open5e v2 item / magic item
 * @param {{id?: string, ownerSlotId?: string|null, qty?: number}} [opts]
 * @returns {object}
 */
export function itemFromOpen5e(o, { id = null, ownerSlotId = null, qty = 1 } = {}) {
  ruleAssert(o && typeof o === 'object' && o.name, 'bad-item', 'Not an Open5e item.');
  const equipment = itemToEquipment(o);
  const price = priceOf(o);
  return makeItem({
    id, ownerSlotId, origin: 'open5e', refKey: o.key ?? null, name: String(o.name), qty,
    data: {
      slot: slotOf(equipment, o.name),
      equipment,
      canAttune: !!o.requires_attunement,
      magical: equipment ? equipment.magical : !!o.requires_attunement || (!!o.rarity && o.rarity.key !== 'common'),
      rarity: o.rarity?.name ?? null,
      consumable: o.category?.key === 'potion' || !!potionFor(o),
      cost: price.priced ? price.buyGp : null,
      weight: Number.isFinite(Number(o.weight)) ? Number(o.weight) : null,
      potionId: potionFor(o)?.id ?? null,
      uses: null
    }
  });
}

/** The sheet's equipment entry for an item (its summary, attunement applied). */
function entryFor(item) {
  return { ...clone(item.data.equipment || { name: item.name, rarity: item.data.rarity || 'Common', magical: !!item.data.magical, armorClass: null, damage: null, damageType: null, armorTypeId: null }), attuned: !!item.attuned };
}

function emptyEquipment() {
  return { armor: null, mainhand: null, offhand: null, helm: null, boots: null, cloak: null, gloves: null, belt: null, amulet: null, rings: [] };
}

/** Remove one carried row for `name` in `slot` (the sprite view). */
function dropCarried(carried, name, slot) {
  const i = carried.findIndex(c => c.name === name && (slot ? c.slot === slot || (slot === 'ring' && c.slot === 'ring') : true));
  if (i >= 0) carried.splice(i, 1);
}

/**
 * Equip a run item: writes `sheet.equipment[slot]` (rings append, max 2),
 * keeps `sheet.carried` in step, and unequips whatever it displaces — the
 * old armour, a two-handed weapon when a shield or off-hand item goes on,
 * the off hand when a two-handed weapon goes on.
 * @param {object} sheet — run sheet
 * @param {object[]} items — the owner's run items
 * @param {string|number} itemId
 * @param {{slot?: 'mainhand'|'offhand'}} [opts] — a light weapon may go in the off hand
 * @returns {{sheet: object, items: object[], unequipped: (string|number)[]}}
 * @throws {CampaignRuleError} no-item | not-equippable | rings-full | no-quantity
 */
export function equipItem(sheet, items, itemId, { slot: wanted } = {}) {
  const list = clone(items || []);
  const item = list.find(i => String(i.id) === String(itemId));
  if (!item) throw new CampaignRuleError('no-item', `No item ${itemId}.`);
  ruleAssert(item.qty > 0, 'no-quantity', `No ${item.name} left.`);
  let slot = item.data?.slot || slotOf(item.data?.equipment, item.name);
  ruleAssert(slot, 'not-equippable', `${item.name} cannot be equipped.`);
  if (wanted) {
    ruleAssert(slot === 'mainhand' && (wanted === 'mainhand' || wanted === 'offhand'), 'not-equippable', `${item.name} cannot go in the ${wanted}.`);
    if (wanted === 'offhand') ruleAssert(!item.data?.equipment?.twoHanded, 'not-equippable', `${item.name} needs two hands.`);
    slot = wanted;
  }
  const out = clone(sheet);
  out.equipment = { ...emptyEquipment(), ...(out.equipment || {}) };
  out.equipment.rings = [...(out.equipment.rings || [])];
  out.carried = [...(out.carried || [])];
  const unequipped = [];
  const free = (pred) => {
    for (const other of list) {
      if (other === item || !other.equipped || !pred(other)) continue;
      other.equipped = false;
      unequipped.push(other.id);
    }
  };
  const entry = entryFor(item);
  if (item.equipped) return { sheet: out, items: list, unequipped };

  if (slot === 'ring') {
    ruleAssert(out.equipment.rings.length < MAX_RINGS, 'rings-full', `Already wearing ${MAX_RINGS} rings.`);
    out.equipment.rings.push(entry);
    out.carried.push({ ...entry, slot: 'ring', inferredSlot: 'ring', twoHanded: false });
  } else {
    const isTwoHanded = slot === 'mainhand' && !!entry.twoHanded;
    const displace = (s) => {
      const cur = out.equipment[s];
      if (!cur) return;
      free(o => o.name === cur.name && (o.data?.slot === s || (s === 'offhand' && o.data?.slot === 'mainhand')));
      dropCarried(out.carried, cur.name, s);
      out.equipment[s] = null;
    };
    displace(slot);
    if (isTwoHanded) displace('offhand');
    if (slot === 'offhand' && out.equipment.mainhand?.twoHanded) displace('mainhand');
    out.equipment[slot] = entry;
    out.carried.push({ ...entry, slot, inferredSlot: isTwoHanded ? 'mainhand-twohanded' : slot, twoHanded: isTwoHanded });
  }
  item.equipped = true;
  return { sheet: out, items: list, unequipped };
}

/**
 * Unequip a run item (clears its sheet slot and carried row). An item
 * that is not equipped is a no-op.
 * @param {object} sheet
 * @param {object[]} items
 * @param {string|number} itemId
 * @returns {{sheet: object, items: object[]}}
 * @throws {CampaignRuleError} no-item
 */
export function unequipItem(sheet, items, itemId) {
  const list = clone(items || []);
  const item = list.find(i => String(i.id) === String(itemId));
  if (!item) throw new CampaignRuleError('no-item', `No item ${itemId}.`);
  const out = clone(sheet);
  if (!item.equipped) return { sheet: out, items: list };
  out.equipment = { ...emptyEquipment(), ...(out.equipment || {}) };
  out.carried = [...(out.carried || [])];
  const slot = item.data?.slot || slotOf(item.data?.equipment, item.name);
  if (slot === 'ring') {
    const i = (out.equipment.rings || []).findIndex(r => r.name === item.name);
    if (i >= 0) out.equipment.rings = out.equipment.rings.filter((_, j) => j !== i);
    dropCarried(out.carried, item.name, 'ring');
  } else {
    for (const s of ['mainhand', 'offhand', 'armor', 'helm', 'boots', 'cloak', 'gloves', 'belt', 'amulet']) {
      if (out.equipment[s]?.name === item.name) {
        out.equipment[s] = null;
        dropCarried(out.carried, item.name, s);
        break;
      }
    }
  }
  item.equipped = false;
  return { sheet: out, items: list };
}

/**
 * Attune (or end attunement to) an item: at most 3 attuned items per
 * owner, only items that require attunement. Rewrites the item's sheet
 * equipment entry and flips its `combatMods` rows (`inactive` /
 * `attuned`) so pc-stats and the resolver see the change.
 * @param {object} sheet
 * @param {object[]} items — the owner's run items
 * @param {string|number} itemId
 * @param {boolean} [attune=true]
 * @returns {{sheet: object, items: object[]}}
 * @throws {CampaignRuleError} no-item | no-attunement | attunement-full
 */
export function attuneItem(sheet, items, itemId, attune = true) {
  const list = clone(items || []);
  const item = list.find(i => String(i.id) === String(itemId));
  if (!item) throw new CampaignRuleError('no-item', `No item ${itemId}.`);
  ruleAssert(item.data?.canAttune, 'no-attunement', `${item.name} does not require attunement.`);
  if (attune && !item.attuned) {
    const count = list.filter(i => i.attuned && i.ownerSlotId === item.ownerSlotId).length;
    ruleAssert(count < MAX_ATTUNED, 'attunement-full', `Already attuned to ${MAX_ATTUNED} items.`, { attuned: count });
  }
  item.attuned = !!attune;
  const out = clone(sheet);
  if (out.equipment) {
    for (const [s, e] of Object.entries(out.equipment)) {
      if (s === 'rings') out.equipment.rings = (e || []).map(r => (r.name === item.name ? { ...r, attuned: item.attuned } : r));
      else if (e && e.name === item.name) out.equipment[s] = { ...e, attuned: item.attuned };
    }
  }
  if (Array.isArray(out.carried)) out.carried = out.carried.map(c => (c.name === item.name ? { ...c, attuned: item.attuned } : c));
  if (Array.isArray(out.combatMods)) {
    out.combatMods = out.combatMods.map(m => (m.bucket === 'item' && m.source === item.name && m.requiresAttunement
      ? { ...m, attuned: item.attuned, inactive: !item.attuned } : m));
  }
  return { sheet: out, items: list };
}

/**
 * Total value of a coin purse in copper.
 * @param {{cp?: number, sp?: number, ep?: number, gp?: number, pp?: number}} purse
 * @returns {number}
 */
export function purseToCp(purse) {
  return COINS.reduce((s, c) => s + Math.max(0, Math.trunc(Number(purse?.[c]) || 0)) * COIN_CP[c], 0);
}

/**
 * Add coins to a purse (all denominations non-negative integers).
 * @param {object} purse
 * @param {object} add — coins to add
 * @returns {{cp: number, sp: number, ep: number, gp: number, pp: number}}
 */
export function addCurrency(purse, add) {
  const out = {};
  for (const c of COINS) {
    const v = Math.trunc(Number(purse?.[c]) || 0) + Math.trunc(Number(add?.[c]) || 0);
    ruleAssert(v >= 0, 'insufficient-funds', `Not enough ${c}.`);
    out[c] = v;
  }
  return out;
}

/**
 * Pay `costCp` from a purse: smallest coins first; when a larger coin
 * must be broken, the change comes back in gp / sp / cp.
 * @param {object} purse
 * @param {number} costCp
 * @returns {{cp: number, sp: number, ep: number, gp: number, pp: number}}
 * @throws {CampaignRuleError} insufficient-funds
 */
export function payFromPurse(purse, costCp) {
  const cost = Math.max(0, Math.trunc(Number(costCp) || 0));
  const have = purseToCp(purse);
  ruleAssert(have >= cost, 'insufficient-funds', `Costs ${cost / 100} gp; the purse holds ${have / 100} gp.`, { costCp: cost, haveCp: have });
  const out = {};
  for (const c of COINS) out[c] = Math.max(0, Math.trunc(Number(purse?.[c]) || 0));
  let due = cost;
  for (const c of COINS) {
    if (due <= 0) break;
    const use = Math.min(out[c], Math.floor(due / COIN_CP[c]));
    out[c] -= use;
    due -= use * COIN_CP[c];
  }
  // Break the smallest coin that covers the rest; change in gp / sp / cp.
  if (due > 0) {
    const c = COINS.find(k => out[k] > 0 && COIN_CP[k] >= due) || COINS.slice().reverse().find(k => out[k] > 0);
    out[c] -= 1;
    let change = COIN_CP[c] - due;
    for (const k of ['gp', 'sp', 'cp']) {
      const n = Math.floor(change / COIN_CP[k]);
      out[k] += n;
      change -= n * COIN_CP[k];
    }
  }
  return out;
}
