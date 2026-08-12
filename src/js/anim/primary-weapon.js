/**
 * Pick a character's ICONIC / primary weapon record, overriding the parser's
 * incidental `equipment.mainhand` (which is just the first-in-inventory
 * weapon). A warhammer cleric who also carries a shortsword sidearm + a hand
 * crossbow resolves to the warhammer, so the preview — and, once promoted in
 * the parser, combat — reflects the weapon a player thinks of as "theirs".
 *
 * Pure + dependency-light: reuses the app's canonical `motionForWeapon`
 * taxonomy and `archetypePreferences` (both DOM/three-free, so this module is
 * safe to import from the backend parser). Returns the raw `carried[]` record
 * (or null for empty-hands / focus casters); callers consume it unchanged.
 */

import { motionForWeapon } from './weapon-motions.js';
import { archetypePreferences } from './archetype-select.js';

/**
 * A low-priority in-flavour tiebreak: the weapon motion a class is "known"
 * for. Only breaks ties among structurally-equal weapons (rung 3 below), so
 * exact values are low-stakes. Keyed on the highest-level class name.
 */
const CLASS_PREFERRED_MOTION = {
  barbarian: 'axe-cleave',
  fighter:   'sword-slash',
  paladin:   'sword-slash',
  knight:    'sword-slash',
  cleric:    'axe-cleave',   // warhammer/mace live in the axe-cleave (blunt) bucket
  ranger:    'bow-draw',
  rogue:     'dagger-stab',
  monk:      'fist-jab',
  wizard:    'staff-cast',
  sorcerer:  'staff-cast',
  warlock:   'staff-cast',
  druid:     'staff-cast'
};

/** Sidearm motions a pure caster shouldn't brandish over their focus. */
const SIDEARM_MOTIONS = new Set(['dagger-stab', 'bow-draw']);

/** Product of the damage dice (`"1d8"` → 8, `"2d6"` → 12); 0 when absent. */
function parseMaxDamage(diceString) {
  const m = /(\d+)d(\d+)/i.exec(String(diceString || ''));
  return m ? Number(m[1]) * Number(m[2]) : 0;
}

/** Highest-level class name (mirrors archetype-select's primaryClass pick). */
function primaryClassName(character) {
  const list = Array.isArray(character?.classes) ? character.classes : [];
  let best = list[0];
  for (const c of list) if ((Number(c?.level) || 0) > (Number(best?.level) || 0)) best = c;
  return String(best?.name || best?.definition?.name || '').toLowerCase();
}

/**
 * Lexicographic score tuple (higher wins). Rungs, most → least significant:
 *  1. two-handed hero weapon   2. max damage   3. class-preferred motion
 *  4. melee over ranged (unless the class IS ranged)   5. magical
 *  6. parser's mainhand flag. Ties fall through to iteration order (rung 7).
 */
function scoreTuple(weapon, prefMotion) {
  const motion = motionForWeapon(weapon);
  const meleeBonus = prefMotion === 'bow-draw' ? 0 : (motion !== 'bow-draw' ? 1 : 0);
  return [
    weapon.twoHanded ? 1 : 0,
    parseMaxDamage(weapon.damage),
    prefMotion && motion === prefMotion ? 1 : 0,
    meleeBonus,
    weapon.magical ? 1 : 0,
    weapon.slot === 'mainhand' ? 1 : 0
  ];
}

/** true when a's tuple is strictly greater than b's, lexicographically. */
function greater(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;   // equal → not greater (keeps the earlier candidate; rung 7)
}

/**
 * @param {object} character - ddb-parser shape: `carried[]`, `equipment.mainhand`, `classes[]`.
 * @returns {(object|null)} the chosen weapon record, or null for empty hands / focus caster.
 */
export function primaryWeaponForCharacter(character) {
  // A — candidates: every equipped weapon (1H + 2H), from carried[].
  let candidates = (character?.carried || [])
    .filter(w => w && (w.inferredSlot === 'mainhand' || w.inferredSlot === 'mainhand-twohanded'));
  // Defensive: hand-built fixtures / older data with no carried[] weapons.
  if (!candidates.length && character?.equipment?.mainhand) candidates = [character.equipment.mainhand];

  // B — no weapon → empty hands / focus.
  if (!candidates.length) return null;

  // C — a lone weapon is always "theirs" (even a dagger).
  if (candidates.length === 1) return candidates[0];

  // D — caster guard: a PURE arcane caster whose only weapons are light
  // sidearms shows a focus (null), not a brandished dagger. Narrow on purpose
  // (mage archetype only) so gish/martial-dip builds are untouched. A
  // quarterstaff is `lance-thrust`, not in SIDEARM_MOTIONS, so it survives.
  if (archetypePreferences(character)[0] === 'mage'
      && candidates.every(w => SIDEARM_MOTIONS.has(motionForWeapon(w)) && !w.twoHanded)) {
    return null;
  }

  // E — rank by the tuple; earliest candidate wins ties (stable).
  const pref = CLASS_PREFERRED_MOTION[primaryClassName(character)] || null;
  let best = candidates[0];
  let bestTuple = scoreTuple(best, pref);
  for (let i = 1; i < candidates.length; i++) {
    const t = scoreTuple(candidates[i], pref);
    if (greater(t, bestTuple)) { best = candidates[i]; bestTuple = t; }
  }
  return best;
}
