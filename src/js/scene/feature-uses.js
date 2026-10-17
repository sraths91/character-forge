/**
 * M64 phase 1.5 — limited-use ledgers that are not spell slots.
 *
 * One map on the engine wrapper, `_features: {key: {max, spent}}`,
 * persisted as EncounterState `resources.features` (encounter-adapters).
 * Keys:
 *   'spell:<spellId>'  — a feat / race / item / background spell cast
 *                        through its own uses (Fey Touched Misty Step,
 *                        1 per long rest): `spell.source !== 'class'`
 *                        with `uses: {max, used, reset}` on the parsed
 *                        sheet (E4's parser, R14)
 *   'rage', …          — class features (sheet `featureUses`, E4)
 * Action Surge and Second Wind keep their legacy wrapper fields
 * (`_actionSurgeUsed`, `_secondWindUsed`), which win for their keys.
 *
 * Pure module: no DOM, no rng.
 */

/**
 * Spell name → registry id slug ("Hunter's Mark" → 'hunters-mark').
 * @param {string} name
 * @returns {string}
 */
export function spellSlug(name) {
  return String(name || '').toLowerCase()
    .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Ledger key of a granted spell's own uses.
 * @param {string} spellId
 * @returns {string}
 */
export function spellUseKey(spellId) {
  return `spell:${spellId}`;
}

/**
 * The sheet's own entry for `spellId` when it is granted by something
 * other than a class AND carries its own uses; else null.
 * @param {object} sheet — parsed character (or wrapper; `ref` is read)
 * @param {string} spellId
 * @returns {object|null}
 */
export function grantedSpellEntry(sheet, spellId) {
  const ref = sheet?.ref || sheet;
  const list = Array.isArray(ref?.spells) ? ref.spells : [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    if (spellSlug(s.name) !== spellId) continue;
    if (s.source && s.source !== 'class' && s.uses && Number(s.uses.max) > 0) return s;
  }
  return null;
}

/**
 * A fully rested ledger for every limited-use resource on the sheet that
 * is not a spell slot: granted spells' uses, and `featureUses` entries
 * (E4: `{key: {max, used, reset}}`) other than Action Surge / Second Wind.
 * @param {object} sheet — parsed character
 * @returns {Record<string, {max: number, spent: number}>}
 */
export function featureLedgerFor(sheet) {
  const out = {};
  for (const s of Array.isArray(sheet?.spells) ? sheet.spells : []) {
    if (!s || typeof s !== 'object' || !s.source || s.source === 'class') continue;
    const max = Math.trunc(Number(s.uses?.max) || 0);
    if (max > 0) out[spellUseKey(spellSlug(s.name))] = { max, spent: 0 };
  }
  const fu = sheet?.featureUses;
  if (fu && typeof fu === 'object') {
    for (const [key, u] of Object.entries(fu)) {
      if (key === 'action-surge' || key === 'second-wind') continue;
      const max = Math.trunc(Number(u?.max) || 0);
      if (max > 0) out[key] = { max, spent: 0 };
    }
  }
  return out;
}

/**
 * Uses left on a wrapper's ledger key (0 when the key is unknown).
 * @param {object} w — wrapper
 * @param {string} key
 * @returns {number}
 */
export function usesLeft(w, key) {
  const l = w?._features?.[key];
  if (!l) return 0;
  return Math.max(0, (Number(l.max) || 0) - (Number(l.spent) || 0));
}

/**
 * Spend one use. Returns false (and spends nothing) when none is left.
 * @param {object} w — wrapper (mutated)
 * @param {string} key
 * @returns {boolean}
 */
export function spendUse(w, key) {
  if (usesLeft(w, key) <= 0) return false;
  w._features[key].spent = (Number(w._features[key].spent) || 0) + 1;
  return true;
}
