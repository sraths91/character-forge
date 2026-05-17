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
 *   rng      — injectable for tests
 */
export function rollConcentrationSave({ conMod = 0, dc = 10 } = {}, rng = Math.random) {
  const d20 = Math.floor(rng() * 20) + 1;
  const total = d20 + conMod;
  return { d20, conMod, total, dc, success: total >= dc };
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
export function handleDamageOnConcentration({ caster, damage, conMod = 0 } = {}, rng = Math.random) {
  if (!isConcentrating(caster)) return { broke: false, dropped: null, save: null };
  if (damage <= 0) return { broke: false, dropped: null, save: null };
  const dc = concentrationDc(damage);
  const save = rollConcentrationSave({ conMod, dc }, rng);
  if (save.success) return { broke: false, dropped: null, save };
  const dropped = dropConcentration(caster);
  return { broke: true, dropped, save };
}
