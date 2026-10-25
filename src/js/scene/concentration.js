/**
 * M34 — Concentration tracking (PHB p203).
 *
 * Many spells require the caster to maintain "Concentration" — only one
 * such spell at a time, and it ends if the caster:
 *   - Casts another concentration spell
 *   - Takes damage and fails a CON save (DC = max(10, damage_taken / 2))
 *   - Is incapacitated
 *
 * State lives on the entity as `_concentrating: { spell, targetIds }`.
 * When concentration breaks, the caller is responsible for clearing any
 * condition the spell applied to its targets (we surface a list of
 * targetIds for that).
 */

import { requireRng } from './rng.js';

/** Mark `caster` as concentrating on `spell`, targeting `targetIds[]`. */
export function startConcentration(caster, spell, targetIds = []) {
  if (!caster || !spell?.concentration) return;
  caster._concentrating = {
    spellId: spell.id,
    spellName: spell.name,
    targetIds: [...targetIds]
  };
}

/** Whether `caster` currently has concentration active. */
export function isConcentrating(caster) {
  return !!caster?._concentrating;
}

/** Drop concentration. Returns the previously held block (or null). */
export function dropConcentration(caster) {
  if (!caster?._concentrating) return null;
  const dropped = caster._concentrating;
  caster._concentrating = null;
  return dropped;
}

/**
 * Roll a CON concentration save against `dc`. Returns true if held.
 *   conMod   — caster's CON saving-throw bonus
 *   dc       — max(10, floor(damageTaken / 2))
 *   advantage — 'normal' | 'advantage' | 'disadvantage' (saveModeFor)
 *   rng      — injectable for tests
 */
export function rollConcentrationSave({ conMod = 0, dc = 10, advantage = 'normal' } = {}, rng) {
  requireRng(rng, 'rollConcentrationSave');
  const a = Math.floor(rng() * 20) + 1;
  if (advantage !== 'advantage' && advantage !== 'disadvantage') {
    const total = a + conMod;
    return { d20: a, conMod, total, dc, success: total >= dc };
  }
  // M65 — a second d20 only when the save has advantage / disadvantage
  // (exhaustion 3+), so a straight roll draws exactly as before.
  const b = Math.floor(rng() * 20) + 1;
  const d20 = advantage === 'advantage' ? Math.max(a, b) : Math.min(a, b);
  const total = d20 + conMod;
  return { d20, dice: [a, b], advantage, conMod, total, dc, success: total >= dc };
}

/** DC for a concentration save after taking `damage`. */
export function concentrationDc(damage) {
  return Math.max(10, Math.floor(damage / 2));
}

/**
 * Apply a damage event to `caster`. If they're concentrating, roll the
 * save; on failure, drop concentration and return the dropped block.
 *   conMod — caster's CON save modifier
 *   rng    — RNG; threaded for determinism
 * Returns { broke: bool, dropped: block|null, save: rollResult|null }.
 */
export function handleDamageOnConcentration({ caster, damage, conMod = 0, advantage = 'normal' } = {}, rng) {
  requireRng(rng, 'handleDamageOnConcentration');
  if (!isConcentrating(caster)) return { broke: false, dropped: null, save: null };
  if (damage <= 0) return { broke: false, dropped: null, save: null };
  const dc = concentrationDc(damage);
  const save = rollConcentrationSave({ conMod, dc, advantage }, rng);
  if (save.success) return { broke: false, dropped: null, save };
  const dropped = dropConcentration(caster);
  return { broke: true, dropped, save };
}
