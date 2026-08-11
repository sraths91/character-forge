/**
 * Smarter 3D archetype selection (Path B, roster upgrade).
 *
 * Replaces three-viewer.js's primary-class-only `archetypeForCharacter`.
 * Instead of a flat `CLASS_TO_ARCHETYPE[class]` lookup, this builds an
 * ORDERED preference list per character — factoring in subclass, worn armor
 * and the equipped weapon — then returns the first preference that actually
 * has a curated model in `available`. That makes it forward-compatible with
 * the roster the other agent is adding: if a `cleric`/`paladin`/`ranger`
 * model lands, an armoured cleric maps to `cleric`; until then the same
 * character gracefully collapses to `knight`. Only keys present in
 * `available` are ever returned — the base four are the guaranteed tail.
 *
 * Pure function. No three.js, no I/O. Reuses the app's canonical weapon
 * classifier (`motionForWeapon`) rather than inventing a weapon taxonomy.
 */

import { motionForWeapon } from './weapon-motions.js';

/** The models that ship today (three-viewer.js ARCHETYPE keys). Every
 *  preference list ends inside this set so selection can never miss. */
export const BASE_ARCHETYPES = new Set(['knight', 'barbarian', 'mage', 'rogue']);

/** Regex signatures for worn armour classes, read off `equipment.armor.name`. */
const HEAVY_ARMOR = /plate|chain mail|chain shirt|scale|splint|ring mail|breastplate|half[\s-]?plate/i;
const LIGHT_ARMOR = /leather|hide|padded|studded/i;

/**
 * Pick the character's dominant class record — the highest-level class in a
 * multiclass build, falling back to the first entry. Tolerates the flat
 * `character.class` string some legacy/monster shapes use.
 * @param {object} character
 * @returns {{ name: string, subclass: (string|null) }}
 */
function primaryClass(character) {
  const list = Array.isArray(character?.classes) ? character.classes : [];
  if (list.length) {
    let best = list[0];
    for (const c of list) if ((Number(c?.level) || 0) > (Number(best?.level) || 0)) best = c;
    return {
      name: String(best?.name || best?.definition?.name || '').toLowerCase(),
      subclass: best?.subclass ? String(best.subclass).toLowerCase() : null
    };
  }
  return { name: String(character?.class || '').toLowerCase(), subclass: null };
}

/**
 * Build the ordered archetype preference list (best → worst) for a character.
 * Exported for testing / debugging the selection ladder. The list always
 * terminates in the base four so a first-available scan cannot fall through.
 * @param {object} character - parsed character (ddb-parser shape)
 * @returns {string[]} archetype keys, most-fitting first
 */
export function archetypePreferences(character) {
  const { name: cls, subclass: sub } = primaryClass(character);
  const armorName = character?.equipment?.armor?.name || '';
  const hasArmor = !!character?.equipment?.armor;
  const heavy = HEAVY_ARMOR.test(armorName);
  const light = LIGHT_ARMOR.test(armorName);
  const weapon = character?.equipment?.mainhand || null;
  const motion = weapon ? motionForWeapon(weapon) : null;
  const finesse = motion === 'dagger-stab' || motion === 'sword-thrust';

  switch (cls) {
    case 'paladin':
      return ['paladin', 'knight', 'fighter', 'barbarian', 'mage', 'rogue'];

    case 'fighter':
      // Eldritch Knight leans caster only when unarmoured + a focus in hand;
      // otherwise a fighter is a knight.
      if (/eldritch/.test(sub || '') && !hasArmor && motion === 'staff-cast')
        return ['fighter', 'mage', 'knight', 'rogue'];
      return ['fighter', 'knight', 'barbarian', 'rogue', 'mage'];

    case 'cleric':
      // Armoured cleric reads as a knight; a robed, unarmoured caster-cleric
      // (Arcana / Light / Knowledge, no metal) reads as a mage.
      if (heavy) return ['cleric', 'knight', 'paladin', 'mage', 'rogue'];
      if (!hasArmor) return ['cleric', 'mage', 'knight', 'rogue'];
      return ['cleric', 'knight', 'mage', 'rogue'];

    case 'barbarian':
      return ['barbarian', 'fighter', 'knight', 'rogue', 'mage'];

    case 'monk':
      return ['monk', 'rogue', 'knight', 'mage'];

    case 'rogue':
      return ['rogue', 'ranger', 'monk', 'mage', 'knight'];

    case 'ranger':
      // Ranged/finesse ranger → rogue-like agility; keep ranger first for
      // forward compat with a future ranger model.
      return ['ranger', 'rogue', 'monk', 'knight', 'mage'];

    case 'druid':
      return ['druid', 'mage', 'rogue', 'knight'];

    case 'bard':
      // A blade-and-buckler bard reads roguish; a pure caster bard reads mage.
      if (finesse && !heavy) return ['bard', 'rogue', 'mage', 'knight'];
      return ['bard', 'mage', 'rogue', 'knight'];

    case 'wizard':
    case 'sorcerer':
    case 'warlock':
      return ['mage', 'rogue', 'knight'];

    case 'artificer':
      // Armorer/Battle Smith in plate → knight; else a gadget caster → mage.
      if (heavy) return ['artificer', 'knight', 'mage', 'rogue'];
      return ['artificer', 'mage', 'knight', 'rogue'];

    default: {
      // Unknown class: let equipment speak. Heavy armour → knight; a focus /
      // no weapon on someone unarmoured → mage; light-armour skirmisher →
      // rogue; otherwise knight.
      if (heavy) return ['knight', 'barbarian', 'rogue', 'mage'];
      if (!hasArmor && (motion === 'staff-cast' || motion === null)) return ['mage', 'rogue', 'knight'];
      if (light || finesse) return ['rogue', 'mage', 'knight'];
      return ['knight', 'barbarian', 'rogue', 'mage'];
    }
  }
}

/**
 * Pick the 3D archetype key for a character. Smarter than primary-class-only:
 * weighs subclass, worn armour and the equipped weapon, then returns the
 * best archetype that has a model in `available`.
 * @param {object} character - parsed character (ddb-parser shape)
 * @param {{ available?: Set<string> }} [opts]
 *   `available` — the set of archetype keys that actually have a loaded model.
 *   Defaults to the four base models. Pass an expanded set once the roster
 *   grows so the extra models get used.
 * @returns {string} an archetype key guaranteed to be in `available`
 */
export function archetypeForCharacter(character, { available = BASE_ARCHETYPES } = {}) {
  const prefs = archetypePreferences(character);
  for (const key of prefs) if (available.has(key)) return key;
  // Nothing in the ladder matched (exotic `available` set) — honest fallbacks.
  if (available.has('knight')) return 'knight';
  const first = [...available][0];
  return first || 'knight';
}
