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
 * Compute AC for a PC. Best-effort: looks at armor + shield, applies
 * DEX cap based on armor type name keywords. Falls back to 10 + DEX mod
 * (unarmored) if no armor is equipped.
 *
 * This is intentionally simple — proper 5e AC depends on class features
 * (Unarmored Defense for Barbarians/Monks, Mage Armor, etc.) that we
 * don't have a clean source for. The user can always override via the
 * existing AppearancePicker if we add an override field later.
 */
export function deriveAC(character) {
  if (!character) return 10;
  const dex = character.abilityModifiers?.DEX ?? 0;
  const armor = character.equipment?.armor;
  const shield = character.equipment?.offhand;
  const hasShield = shield && /shield/i.test(String(shield.name || ''));
  const shieldBonus = hasShield ? 2 : 0;

  if (!armor) {
    // Unarmored
    return 10 + dex + shieldBonus;
  }
  const armorName = String(armor.name || '').toLowerCase();
  const baseAC = Number(armor.armorClass) || armorBaseFromName(armorName);
  // Heavy armor caps DEX at 0; medium at +2; light unlimited.
  const armorType = classifyArmor(armorName);
  let dexToAC = dex;
  if (armorType === 'heavy') dexToAC = 0;
  else if (armorType === 'medium') dexToAC = Math.min(dex, 2);
  return baseAC + dexToAC + shieldBonus;
}

function classifyArmor(name) {
  if (/plate|chain mail|splint|ring mail/.test(name)) return 'heavy';
  if (/chain shirt|scale mail|breastplate|half plate|hide/.test(name)) return 'medium';
  if (/padded|leather|studded/.test(name)) return 'light';
  return 'light';
}

/** Fallback AC values (before DEX) when armor.armorClass is absent. */
function armorBaseFromName(name) {
  if (/plate/.test(name) && !/half/.test(name)) return 18;
  if (/half plate/.test(name)) return 15;
  if (/chain mail/.test(name)) return 16;
  if (/splint/.test(name)) return 17;
  if (/ring mail/.test(name)) return 14;
  if (/scale mail|breastplate/.test(name)) return 14;
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
const RANGED  = new Set(['shortbow', 'longbow', 'sling', 'crossbow', 'heavy crossbow', 'hand crossbow', 'heavycrossbow', 'dart', 'javelin']);

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
 * Used by M9 to render an attack chip next to every weapon line on the
 * sheet, not just the active main-hand.
 *
 *   - Damage die: prefer the parser-extracted `weapon.damage` (D&DB's
 *     `damage.diceString`). Fall back to WEAPON_DICE keyword lookup if
 *     missing or unparseable (e.g. homebrew with no damage record).
 *   - Ability mod: finesse weapons pick max(STR, DEX); ranged use DEX;
 *     everything else uses STR.
 *   - Magic bonus: +N from weapon.bonus or a "+N" prefix in the name.
 *   - Damage dice include ability mod + magic bonus in the modifier.
 *   - Attack bonus is ability mod + proficiency + magic bonus.
 *     (We assume PC has proficiency in their carried weapons; this is
 *     true for the overwhelming majority of imports.)
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
      damageType: 'Bludgeoning'
    };
  }

  const wn = String(weapon.name).toLowerCase();
  const key = Object.keys(WEAPON_DICE).find(k => wn.includes(k));
  // Trust the parser's damage string when present; fall back to the
  // keyword table only when the import didn't carry damage info.
  const baseDice = weapon.damage || (key ? WEAPON_DICE[key] : '1d4');

  // Finesse / ranged detection: prefer explicit weapon.properties when
  // available, otherwise fall back to the name keyword.
  const props = Array.isArray(weapon.properties)
    ? weapon.properties.map(p => String(p?.name || p || '').toLowerCase())
    : [];
  const isFinesse = props.includes('finesse') || (key && FINESSE.has(key));
  const isRanged  = props.includes('ranged')  || (key && RANGED.has(key));

  const abilityMod = isRanged
    ? dexMod
    : (isFinesse ? Math.max(strMod, dexMod) : strMod);
  const plus = magicBonus(weapon);
  return {
    name: weapon.name,
    bonus: abilityMod + prof + plus,
    dice: formatDice(baseDice, abilityMod + plus),
    damageType: weapon.damageType || null
  };
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

function magicBonus(weapon) {
  if (!weapon) return 0;
  if (typeof weapon.bonus === 'number') return weapon.bonus;
  const m = String(weapon.name || '').match(/\+(\d)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** "1d8" + 3 → "1d8+3"; "1d8" + -1 → "1d8-1"; "1d8" + 0 → "1d8" */
function formatDice(diceSpec, mod) {
  if (mod === 0) return diceSpec;
  return mod > 0 ? `${diceSpec}+${mod}` : `${diceSpec}${mod}`;
}
