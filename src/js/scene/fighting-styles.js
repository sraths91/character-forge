/**
 * M64 phase 1.5 — Fighting Styles (PHB p72, p84, p91) from the parsed
 * sheet's `fightingStyles: string[]` (E4: DDB option names, e.g.
 * "Defense", "Great Weapon Fighting"; [] or absent when none).
 *
 *   Defense               +1 AC while wearing armor           → acFor
 *   Dueling               +2 damage, a melee weapon in one hand and no
 *                         other weapon                         → swingStyleMods
 *   Great Weapon Fighting reroll 1s and 2s on the weapon dice of a
 *                         two-handed / versatile-two-handed melee attack
 *   Archery               +2 to hit with ranged weapons
 *   Two-Weapon Fighting   the off-hand bonus attack adds the ability
 *                         modifier (offhandAttack)
 *
 * The off-hand bonus attack itself (PHB p195) — a light melee weapon in
 * each hand — is `offhandWeaponFor`; the engine runs it after the Attack
 * action when the bonus action is still free.
 *
 * Pure module: no DOM, no rng. deriveAC / deriveWeaponAttack (pc-stats,
 * E4) stay untouched; styles layer on their results.
 */

import { deriveAC } from './pc-stats.js';

const STYLE_IDS = [
  ['defense', /^defen[cs]e$/],
  ['dueling', /^duel(l)?ing$/],
  ['great-weapon-fighting', /^great[\s-]*weapon[\s-]*fighting$/],
  ['archery', /^archery$/],
  ['two-weapon-fighting', /^two[\s-]*weapon[\s-]*fighting$/]
];

const TWO_HANDED_NAMES = /\b(greatsword|greataxe|maul|glaive|halberd|pike|greatclub|lance)\b/;
const LIGHT_NAMES = /\b(dagger|handaxe|shortsword|scimitar|light hammer|sickle|club)\b/;

/**
 * The character's Fighting Style ids ('defense', 'dueling',
 * 'great-weapon-fighting', 'archery', 'two-weapon-fighting'); unknown
 * names are kept lower-cased. Accepts strings or `{name}` objects.
 * @param {object} sheet — parsed character or wrapper (`ref` is read)
 * @returns {string[]}
 */
export function fightingStylesOf(sheet) {
  const ref = sheet?.ref || sheet;
  const raw = Array.isArray(ref?.fightingStyles) ? ref.fightingStyles : [];
  const out = [];
  for (const s of raw) {
    const name = String(typeof s === 'string' ? s : s?.name || '').trim().toLowerCase();
    if (!name) continue;
    const hit = STYLE_IDS.find(([, re]) => re.test(name));
    const id = hit ? hit[0] : name;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * @param {object} sheet
 * @param {string} id — style id
 * @returns {boolean}
 */
export function hasStyle(sheet, id) {
  return fightingStylesOf(sheet).includes(id);
}

/**
 * Armor Class with the Defense style (+1 while wearing armor).
 * @param {object} sheet — parsed character
 * @returns {number}
 */
export function acFor(sheet) {
  const base = deriveAC(sheet);
  return sheet?.equipment?.armor && hasStyle(sheet, 'defense') ? base + 1 : base;
}

function props(weapon) {
  return Array.isArray(weapon?.properties) ? weapon.properties.map(p => String(p?.name ?? p ?? '').toLowerCase()) : [];
}

/** Two-handed weapon (property, else name). */
export function isTwoHanded(weapon) {
  const p = props(weapon);
  if (p.length) return p.includes('two-handed');
  return TWO_HANDED_NAMES.test(String(weapon?.name || '').toLowerCase());
}

/** Light weapon (property, else name). */
export function isLight(weapon) {
  const p = props(weapon);
  if (p.length) return p.includes('light');
  return LIGHT_NAMES.test(String(weapon?.name || '').toLowerCase());
}

function isWeaponItem(item) {
  return !!item && (!!item.damage || item.attackType === 1 || item.attackType === 2 || /weapon/i.test(item.weaponCategory || '') ||
    LIGHT_NAMES.test(String(item.name || '').toLowerCase()) || /sword|axe|mace|hammer|spear|rapier|flail|pick|trident|whip/i.test(String(item.name || '')));
}

/**
 * Fighting-style adjustments for one weapon swing.
 * @param {object} sheet — parsed character
 * @param {object|null} weapon — the swing's weapon
 * @param {{ranged: boolean, versatile: boolean}} derived — deriveWeaponAttack result
 * @returns {{attackBonus: number, damageBonus: number, rerollBelow: number, parts: {source: string, value: number}[]}}
 */
export function swingStyleMods(sheet, weapon, derived) {
  const styles = fightingStylesOf(sheet);
  const out = { attackBonus: 0, damageBonus: 0, rerollBelow: 0, parts: [] };
  if (!styles.length || !weapon?.name) return out;
  if (derived.ranged) {
    if (styles.includes('archery')) { out.attackBonus += 2; out.parts.push({ source: 'Archery', value: 2 }); }
    return out;
  }
  const ref = sheet?.ref || sheet;
  const off = ref?.equipment?.offhand;
  const twoHands = isTwoHanded(weapon) || !!derived.versatile;
  if (styles.includes('great-weapon-fighting') && twoHands) out.rerollBelow = 2;
  // Two weapons wielded (main hand and off hand both weapons): no Dueling.
  const otherWeapon = isWeaponItem(off) && isWeaponItem(ref?.equipment?.mainhand || weapon);
  if (styles.includes('dueling') && !twoHands && !otherWeapon) {
    out.damageBonus += 2;
    out.parts.push({ source: 'Dueling', value: 2 });
  }
  return out;
}

/**
 * The off-hand weapon for the two-weapon bonus attack (PHB p195): a light
 * melee weapon in each hand. Null otherwise.
 * @param {object} sheet — parsed character
 * @param {object|null} mainWeapon — the Attack action's weapon
 * @returns {object|null}
 */
export function offhandWeaponFor(sheet, mainWeapon) {
  const ref = sheet?.ref || sheet;
  const off = ref?.equipment?.offhand;
  const main = mainWeapon || ref?.equipment?.mainhand;
  if (!off || !main || off === main || !isWeaponItem(off)) return null;
  if (!isLight(main) || !isLight(off)) return null;
  if (props(off).includes('ammunition') || off.attackType === 2) return null;
  return off;
}

/**
 * Damage dice for the off-hand attack: the ability modifier is dropped
 * unless it is negative or the character has Two-Weapon Fighting.
 * @param {string} dice — deriveWeaponAttack dice ('1d6+3')
 * @param {number} abilityMod
 * @param {object} sheet
 * @returns {string}
 */
export function offhandDice(dice, abilityMod, sheet) {
  if (hasStyle(sheet, 'two-weapon-fighting') || !(abilityMod > 0)) return dice;
  const m = String(dice).match(/^(\d*d\d+)([+-]\d+)?$/);
  if (!m) return dice;
  const mod = (m[2] ? parseInt(m[2], 10) : 0) - abilityMod;
  if (mod === 0) return m[1];
  return mod > 0 ? `${m[1]}+${mod}` : `${m[1]}${mod}`;
}
