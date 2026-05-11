/**
 * Slot-override + auto-fill primitive for character-forge.
 *
 * `assignCarriedSlots` is the single source of truth for slot assignment.
 * It applies explicit overrides AND auto-fills overflow weapons into back/
 * waist when those slots aren't explicitly touched. The render plan then
 * reads canonical `carried[].slot` tags only.
 *
 * Equipment-slot invariant: equipment.mainhand and equipment.offhand always
 * reflect carried[].slot. Moving an item OUT of a hand slot via a non-hand
 * override clears the corresponding equipment entry; moving INTO a hand
 * slot populates it. Two-handed mainhand overrides also null offhand and
 * demote whatever was held there.
 */

const STORAGE_PREFIX = 'cf_slot_overrides_';
const PICKABLE_SLOTS = ['mainhand', 'offhand', 'back', 'waist'];

export function loadOverrides(characterId) {
  if (!characterId) return {};
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + characterId);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveOverrides(characterId, overrides) {
  if (!characterId) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + characterId, JSON.stringify(overrides));
  } catch { /* quota / private mode — ignore */ }
}

/**
 * Produce a canonical character clone whose carried[].slot tags reflect:
 *   1. Manual overrides (overrides[slot] = item name | null | undefined)
 *      - undefined: leave that slot's auto-fill behaviour intact
 *      - null: explicit "empty" — slot stays empty even if overflow exists
 *      - name: the named carried item is placed in that slot; whoever was
 *        there is demoted to overflow
 *   2. Auto-fill of remaining 'overflow' weapons into back / waist when
 *      those slots aren't explicitly overridden.
 *
 * Always operates on a deep clone — never mutates the input.
 *
 * Behaviour when an override names an item not in carried[]:
 *   - The previous slot occupant IS still demoted (slot is cleared).
 *   - No replacement is placed (the named item doesn't exist).
 *   - The override entry remains in the override map; it may activate later
 *     if the user re-imports with that item equipped.
 */
export function assignCarriedSlots(character, overrides = {}) {
  if (!character) return character;
  const out = JSON.parse(JSON.stringify(character));
  const carried = out.carried || [];

  // 1. Apply explicit overrides (clears + reassigns)
  //
  // CRITICAL invariant: equipment.mainhand and equipment.offhand must reflect
  // carried[].slot. Three places mutate this pair:
  //
  //   (a) Clear the target slot before reassign (whoever was here goes overflow)
  //   (b) When an item moves OUT of mainhand/offhand to a non-hand slot,
  //       clear the equipment entry it left behind.
  //   (c) When an item moves INTO mainhand/offhand, populate equipment.
  for (const slot of PICKABLE_SLOTS) {
    if (!(slot in overrides)) continue;
    const target = overrides[slot];

    // (a) Demote whoever currently holds this slot
    const cur = carried.find(c => c.slot === slot);
    if (cur) cur.slot = 'overflow';
    if (slot === 'mainhand' || slot === 'offhand') {
      out.equipment[slot] = null;
    }

    if (target == null) continue; // explicit clear

    const item = carried.find(c => c.name === target);
    if (!item) continue; // item not in carried — silently no-op

    // (b) If the item came FROM a hand slot, clear that equipment entry
    const prevSlot = item.slot;
    if ((prevSlot === 'mainhand' || prevSlot === 'offhand') && prevSlot !== slot) {
      out.equipment[prevSlot] = null;
    }

    // Move the targeted item into this slot
    item.slot = slot;

    // (c) If the item is going INTO a hand slot, populate equipment
    if (slot === 'mainhand' || slot === 'offhand') {
      out.equipment[slot] = {
        name: item.name,
        rarity: item.rarity,
        magical: item.magical,
        attuned: item.attuned,
        armorClass: item.armorClass,
        damage: item.damage,
        damageType: item.damageType,
        ...(slot === 'mainhand' && item.twoHanded ? { twoHanded: true } : {})
      };
      if (slot === 'mainhand' && item.twoHanded) {
        out.equipment.offhand = null;
        const off = carried.find(c => c.slot === 'offhand' && c.name !== item.name);
        if (off) off.slot = 'overflow';
      }
    }
  }

  // 2. Auto-fill back / waist from overflow when not explicitly overridden
  const backTouched = 'back' in overrides;
  const waistTouched = 'waist' in overrides;
  const isWeapon = (c) =>
    c.inferredSlot === 'mainhand' || c.inferredSlot === 'mainhand-twohanded';

  if (!backTouched) {
    const firstOverflow = carried.find(c => c.slot === 'overflow' && isWeapon(c));
    if (firstOverflow) firstOverflow.slot = 'back';
  }
  if (!waistTouched) {
    // Only one-handed weapons go on the hip
    const nextOverflow = carried.find(c => c.slot === 'overflow' && isWeapon(c) && !c.twoHanded);
    if (nextOverflow) nextOverflow.slot = 'waist';
  }

  return out;
}
