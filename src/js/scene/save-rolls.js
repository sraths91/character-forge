/**
 * M21 — Saving-throw rolls and spell-save resolution.
 *
 * Pure module: d20 + saveBonus vs DC, plus a `resolveSpellSave` helper
 * that applies the spell's damage policy (half on success / none on
 * success) and returns a structured result the UI can render in the
 * roll log.
 *
 * No DOM, no globals. RNG is injectable for deterministic tests.
 */

import { rollDamage } from './combat-roll.js';

/**
 * Roll a single saving throw.
 *
 *   bonus     — total save bonus (ability mod + prof if proficient)
 *   dc        — spell save DC
 *   advantage — 'normal' | 'advantage' | 'disadvantage' (default normal)
 *
 * Returns { kept, dice, advantage, total, dc, success }.
 */
export function rollSave({ bonus = 0, dc = 10, advantage = 'normal' } = {}, rng = Math.random) {
  const a = 1 + Math.floor(rng() * 20);
  let kept, dice;
  if (advantage === 'normal') {
    kept = a; dice = [a];
  } else {
    const b = 1 + Math.floor(rng() * 20);
    kept = advantage === 'advantage' ? Math.max(a, b) : Math.min(a, b);
    dice = [a, b];
  }
  const total = kept + bonus;
  return { kept, dice, advantage, bonus, total, dc, success: total >= dc };
}

/**
 * Resolve a save-based spell against ONE target.
 *
 * Inputs:
 *   spell        — { name, dice, damageType, saveStat, saveOnHalf }
 *   targetSaveBonus — number; the target's bonus on the save stat
 *   dc           — caster's spell save DC
 *   advantage    — target's advantage on the save (default normal)
 *
 * Returns:
 *   {
 *     save: { ...rollSave output },
 *     damageRoll: { total, rolls, spec } | null  (null if no damage)
 *     damage: number,           // final damage applied (after half/none policy)
 *     outcome: 'full' | 'half' | 'none'   // verbal description
 *   }
 */
export function resolveSpellSave({ spell, targetSaveBonus = 0, dc, advantage = 'normal' }, rng = Math.random) {
  const save = rollSave({ bonus: targetSaveBonus, dc, advantage }, rng);
  // No dice on the spell? Then it's pure control (Hold Person) — no damage either way.
  if (!spell?.dice) {
    return {
      save,
      damageRoll: null,
      damage: 0,
      outcome: save.success ? 'none' : 'failed-no-damage'
    };
  }
  // Roll damage once. Apply policy:
  //   success + saveOnHalf → half (floored).
  //   success + !saveOnHalf → 0 (cantrip / control with damage).
  //   fail → full.
  const damageRoll = rollDamage(spell.dice, { crit: false }, rng);
  let damage = damageRoll.total;
  let outcome = 'full';
  if (save.success) {
    if (spell.saveOnHalf) {
      damage = Math.floor(damage / 2);
      outcome = 'half';
    } else {
      damage = 0;
      outcome = 'none';
    }
  }
  return { save, damageRoll, damage, outcome };
}
