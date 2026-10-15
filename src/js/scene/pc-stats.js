/**
 * M6 — Combat stats for PCs.
 *
 * The D&DB parser exposes ability scores, equipment, and class/level info
 * but not a precomputed AC or attack stat. We derive both here using 5e
 * rules of thumb. Best-effort: if any field is missing we fall back to
 * pragmatic defaults so combat still resolves.
 *
 * Pure functions — no DOM, no globals — so they're testable.
 */

/** 5e proficiency bonus by total character level (PHB p15). */
export function proficiencyBonus(level) {
  const lv = Math.max(1, Math.min(20, Number(level) || 1));
  return 2 + Math.floor((lv - 1) / 4);
}

/** Pull the total level from a character record (sum of class levels). */
export function totalLevel(character) {
  if (Number.isFinite(character?.level)) return character.level;
  const sum = (character?.classes || []).reduce((a, c) => a + (Number(c.level) || 0), 0);
  return sum > 0 ? sum : 1;
}

/**
 * DDB `definition.armorTypeId` → armor category. Verified against a real
 * export: Chain Mail is 3 ("Heavy Armor"), Shield is 4.
 */
export const ARMOR_TYPE_BY_ID = Object.freeze({ 1: 'light', 2: 'medium', 3: 'heavy', 4: 'shield' });

/**
 * Compute AC for a PC: armor base + DEX (capped by armor category) +
 * shield + every active `combatMods` entry of kind `ac` (Ring / Cloak of
 * Protection, +N armor). The category comes from the parser's
 * `armorTypeId` when present and from the armor name otherwise (older
 * parsed rows). Falls back to 10 + DEX when no armor is equipped.
 *
 * Class features that replace the formula (Unarmored Defense, Mage
 * Armor) are not modelled here.
 *
 * @param {object} character — parsed character (parseCharacter output)
 * @returns {number}
 */
export function deriveAC(character) {
  if (!character) return 10;
  const dex = character.abilityModifiers?.DEX ?? 0;
  const armor = character.equipment?.armor;
  const shield = character.equipment?.offhand;
  const hasShield = !!shield && (shield.armorTypeId === 4 || /shield/i.test(String(shield.name || '')));
  const shieldBonus = hasShield ? 2 : 0;
  const modBonus = acModBonus(character.combatMods, !armor);

  if (!armor) {
    return 10 + dex + shieldBonus + modBonus;
  }
  const armorName = String(armor.name || '').toLowerCase();
  const baseAC = Number(armor.armorClass) || armorBaseFromName(armorName);
  const fromId = ARMOR_TYPE_BY_ID[armor.armorTypeId];
  const armorType = fromId && fromId !== 'shield' ? fromId : classifyArmor(armorName);
  // Heavy armor caps DEX at 0; medium at +2; light unlimited.
  let dexToAC = dex;
  if (armorType === 'heavy') dexToAC = 0;
  else if (armorType === 'medium') dexToAC = Math.min(dex, 2);
  return baseAC + dexToAC + shieldBonus + modBonus;
}

/**
 * Sum of active AC bonuses from parsed combatMods. Scope `all` always
 * applies; scope `unarmored` only when no armor is worn. Inactive mods
 * (attunement required but not attuned) are skipped.
 */
function acModBonus(combatMods, unarmored) {
  if (!Array.isArray(combatMods)) return 0;
  let sum = 0;
  for (const m of combatMods) {
    if (!m || m.kind !== 'ac' || m.inactive) continue;
    if (m.scope === 'unarmored' && !unarmored) continue;
    const v = Number(m.value);
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}

/**
 * Armor category from the armor's name (fallback when the parser did not
 * carry `armorTypeId`). Medium is tested first so "breastplate" and
 * "half plate" are not swallowed by the heavy `plate` pattern.
 *
 * @param {string} name
 * @returns {'light'|'medium'|'heavy'}
 */
export function classifyArmor(name) {
  const n = String(name || '').toLowerCase();
  if (/chain shirt|scale mail|breastplate|half plate|hide/.test(n)) return 'medium';
  if (/plate|chain mail|splint|ring mail/.test(n)) return 'heavy';
  if (/padded|leather|studded/.test(n)) return 'light';
  return 'light';
}

/** Fallback AC values (before DEX) when armor.armorClass is absent. */
function armorBaseFromName(name) {
  if (/half plate/.test(name)) return 15;
  if (/breastplate|scale mail/.test(name)) return 14;
  if (/plate/.test(name)) return 18;
  if (/chain mail/.test(name)) return 16;
  if (/splint/.test(name)) return 17;
  if (/ring mail/.test(name)) return 14;
  if (/chain shirt/.test(name)) return 13;
  if (/hide/.test(name)) return 12;
  if (/studded leather/.test(name)) return 12;
  if (/leather/.test(name)) return 11;
  if (/padded/.test(name)) return 11;
  return 11;
}

/**
 * Damage dice for the most common weapons. Best-effort — D&DB doesn't
 * always expose the damage die in a stable shape, so we look up by name.
 * Two-handed weapons have their full die; finesse weapons get DEX from
 * the caller (deriveAttack handles ability choice).
 */
const WEAPON_DICE = {
  club: '1d4', dagger: '1d4', sickle: '1d4', dart: '1d4',
  handaxe: '1d6', javelin: '1d6', mace: '1d6', sling: '1d4',
  spear: '1d6', quarterstaff: '1d6', shortbow: '1d6', shortsword: '1d6',
  scimitar: '1d6', rapier: '1d8', longsword: '1d8', battleaxe: '1d8',
  warhammer: '1d8', longbow: '1d8', flail: '1d8', morningstar: '1d8',
  trident: '1d6', whip: '1d4', greatclub: '1d8', greatsword: '2d6',
  greataxe: '1d12', maul: '2d6', halberd: '1d10', glaive: '1d10',
  pike: '1d10', lance: '1d12', heavycrossbow: '1d10',
  'heavy crossbow': '1d10', 'hand crossbow': '1d6', crossbow: '1d8',
  unarmed: '1', 'unarmed strike': '1'
};

const FINESSE = new Set(['dagger', 'dart', 'rapier', 'scimitar', 'shortsword', 'whip']);
// Name fallback for rows parsed before R6 (no `properties`). Dart and
// javelin are thrown MELEE weapons, so they are not listed here: dart is
// finesse (best of STR/DEX), javelin uses STR.
const RANGED  = new Set(['shortbow', 'longbow', 'sling', 'crossbow', 'heavy crossbow', 'hand crossbow', 'heavycrossbow']);
// SRD simple weapons (name keywords); everything else in WEAPON_DICE is martial.
const SIMPLE_WEAPON_KEYS = new Set([
  'club', 'dagger', 'greatclub', 'handaxe', 'javelin', 'light hammer', 'mace',
  'quarterstaff', 'sickle', 'spear', 'crossbow', 'dart', 'shortbow', 'sling'
]);
// One die step up for a versatile weapon wielded two-handed when DDB gave
// no explicit versatile die.
const VERSATILE_STEP = { 4: 6, 6: 8, 8: 10, 10: 12 };

/**
 * Derive a PC's primary attack: delegates to deriveWeaponAttack with the
 * main-hand weapon. Kept as a thin wrapper because the combat-roll path
 * (M6) only cares about the active main-hand attack.
 */
export function deriveAttack(character) {
  if (!character) return { name: 'Strike', bonus: 0, dice: '1d4' };
  return deriveWeaponAttack(character, character.equipment?.mainhand);
}

/**
 * Derive attack stats for any specific weapon (equipped OR carried).
 *
 *   - Damage die: the parser's `weapon.damage` (DDB diceString), else the
 *     WEAPON_DICE keyword table. A versatile weapon rolls its two-handed
 *     die (`versatileDamage`, else one die step up) when the wielder has
 *     no shield and nothing else in the off hand.
 *   - Ability: from the R6 `properties` / `attackType` when present —
 *     finesse → max(STR, DEX); ranged (attackType 2) → DEX; melee,
 *     including thrown melee weapons like the javelin → STR. Rows without
 *     those fields fall back to name keywords.
 *   - Proficiency: from `character.weaponProficiencies` (category or
 *     per-weapon slug). When the character carries no weapon-proficiency
 *     data (older rows, hand-built test sheets) proficiency is assumed.
 *   - Magic bonus: `weapon.magicBonus` (DDB grantedModifiers), else
 *     `weapon.bonus`, else a "+N" in the name.
 *
 * @param {object} character — parsed character
 * @param {object} weapon — equipment / carried weapon summary
 * @returns {{name: string, bonus: number, dice: string, damageType: string|null,
 *   ability: 'STR'|'DEX', proficient: boolean, ranged: boolean,
 *   range: {normal: number, long: number}, reach: number|null, versatile: boolean,
 *   magicBonus: number}}
 */
export function deriveWeaponAttack(character, weapon) {
  const strMod = character?.abilityModifiers?.STR ?? 0;
  const dexMod = character?.abilityModifiers?.DEX ?? 0;
  const prof   = proficiencyBonus(totalLevel(character));

  if (!weapon || !weapon.name) {
    return {
      name: 'Unarmed Strike',
      bonus: strMod + prof,
      dice: formatDice('1', strMod),
      damageType: 'Bludgeoning',
      ability: 'STR', proficient: true, ranged: false,
      range: { normal: 5, long: 5 }, reach: 5, versatile: false, magicBonus: 0
    };
  }

  const wn = String(weapon.name).toLowerCase();
  const key = Object.keys(WEAPON_DICE).find(k => wn.includes(k));
  const props = Array.isArray(weapon.properties)
    ? weapon.properties.map(p => String(p?.name ?? p ?? '').toLowerCase())
    : [];
  const hasRulesData = props.length > 0 || weapon.attackType === 1 || weapon.attackType === 2;

  const isFinesse = props.includes('finesse') || (!hasRulesData && !!key && FINESSE.has(key));
  const isRanged = weapon.attackType === 2
    || (weapon.attackType == null && (props.includes('ranged') || props.includes('ammunition')))
    || (!hasRulesData && !!key && RANGED.has(key));

  let ability = 'STR';
  if (isFinesse) ability = dexMod > strMod ? 'DEX' : 'STR';
  else if (isRanged) ability = 'DEX';
  const abilityMod = ability === 'DEX' ? dexMod : strMod;

  let baseDice = weapon.damage || (key ? WEAPON_DICE[key] : '1d4');
  const versatile = !isRanged && props.includes('versatile') && bothHandsFree(character, weapon);
  if (versatile) baseDice = weapon.versatileDamage || stepUpDie(baseDice);

  const proficient = isProficientWith(character, weapon, key);
  const plus = magicBonus(weapon);
  return {
    name: weapon.name,
    bonus: abilityMod + (proficient ? prof : 0) + plus,
    dice: formatDice(baseDice, abilityMod + plus),
    damageType: weapon.damageType || null,
    ability,
    proficient,
    ranged: isRanged,
    range: weaponRange(weapon, isRanged, props),
    reach: isRanged ? null : (props.includes('reach') ? 10 : 5),
    versatile,
    magicBonus: plus
  };
}

/** True when nothing but `weapon` is held (no shield, no off-hand item). */
function bothHandsFree(character, weapon) {
  const off = character?.equipment?.offhand;
  const main = character?.equipment?.mainhand;
  if (!off) return true;
  if (off.name !== weapon.name) return false;
  // The weapon itself sits in the off hand; the main hand must be empty.
  return !main || main.name === weapon.name;
}

function stepUpDie(dice) {
  const m = String(dice || '').match(/^(\d+)d(\d+)$/);
  if (!m) return dice;
  const next = VERSATILE_STEP[Number(m[2])];
  return next ? `${m[1]}d${next}` : dice;
}

/** Token set of a weapon slug: "hand-crossbows" and "crossbow-hand" match. */
function slugTokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .map(t => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t)).sort().join(' ');
}

function isProficientWith(character, weapon, key) {
  const profs = character?.weaponProficiencies;
  if (!Array.isArray(profs) || profs.length === 0) return true;   // no data: assume
  const set = new Set(profs.map(p => String(p).toLowerCase()));
  const category = weapon.weaponCategory
    || (key ? (SIMPLE_WEAPON_KEYS.has(key) ? 'simple' : 'martial') : null);
  if (category === 'simple' && set.has('simple-weapons')) return true;
  if (category === 'martial' && set.has('martial-weapons')) return true;
  const own = new Set([slugTokens(weapon.weaponType), slugTokens(weapon.name), key ? slugTokens(key) : ''].filter(Boolean));
  for (const p of set) if (own.has(slugTokens(p))) return true;
  // Unknown weapon (homebrew with no category or slug match): assume.
  return category == null && !key;
}

/**
 * Normal/long range in feet. Ranged and thrown weapons use DDB's
 * range/longRange; melee is 5 ft (10 with reach).
 */
function weaponRange(weapon, isRanged, props) {
  const normal = Number(weapon.range);
  const long = Number(weapon.longRange);
  if ((isRanged || props.includes('thrown')) && normal > 0) {
    return { normal, long: long > 0 ? long : normal };
  }
  const reach = props.includes('reach') ? 10 : 5;
  return { normal: reach, long: reach };
}

// M18 — Spellcasting stats.
//
// For a given spell, derive the attack bonus and save DC:
//   attackBonus = abilityMod + proficiency
//   saveDC      = 8 + abilityMod + proficiency
// The ability comes from spell.spellCastingAbility (per-spell override) or
// the character's primary spellcasting class.

/**
 * Pick the spellcasting ability for this spell. The spell record (from
 * the M18 parser) carries it; if absent, fall back to the character's
 * first spellcasting class default.
 */
export function spellcastingAbility(character, spell) {
  if (spell?.spellCastingAbility) return spell.spellCastingAbility;
  // Fall back to first spell on the character that declares an ability
  const list = character?.spells || [];
  for (const s of list) if (s.spellCastingAbility) return s.spellCastingAbility;
  return null;
}

/**
 * Spell attack bonus: ability mod + proficiency.
 * Returns { total, parts } in the same shape M12 attackBonus uses so the
 * resolver can fold combatMods on top.
 */
export function spellAttackBonus(character, spell) {
  const ability = spellcastingAbility(character, spell);
  const abilityMod = ability ? (character?.abilityModifiers?.[ability] ?? 0) : 0;
  const prof = proficiencyBonus(totalLevel(character));
  return {
    total: abilityMod + prof,
    parts: ability
      ? [
          { source: `${ability} mod`, value: abilityMod },
          { source: 'Proficiency', value: prof }
        ]
      : [{ source: 'Proficiency', value: prof }],
    ability
  };
}

/**
 * Spell save DC: 8 + ability mod + proficiency.
 */
export function spellSaveDC(character, spell) {
  const a = spellAttackBonus(character, spell);
  return 8 + a.total;
}

/**
 * M21 — Save bonus for a single ability.
 *   = abilityModifier + (proficiency if proficient in this save)
 * Proficiency comes from character.savingThrowProficiencies (M21 parser).
 */
export function saveBonus(character, stat) {
  if (!character || !stat) return 0;
  const abilityMod = character.abilityModifiers?.[stat] ?? 0;
  const profs = character.savingThrowProficiencies || [];
  const proficient = profs.includes(stat);
  const prof = proficient ? proficiencyBonus(totalLevel(character)) : 0;
  return abilityMod + prof;
}

function magicBonus(weapon) {
  if (!weapon) return 0;
  if (typeof weapon.magicBonus === 'number') return weapon.magicBonus;
  if (typeof weapon.bonus === 'number') return weapon.bonus;
  const m = String(weapon.name || '').match(/\+(\d)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** "1d8" + 3 → "1d8+3"; "1d8" + -1 → "1d8-1"; "1d8" + 0 → "1d8" */
function formatDice(diceSpec, mod) {
  if (mod === 0) return diceSpec;
  return mod > 0 ? `${diceSpec}+${mod}` : `${diceSpec}${mod}`;
}
