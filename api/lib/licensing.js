// Licensing text served by /api/licenses and written into campaign
// exports (M65 plan, "Licensing"). The gate checks SRD_ATTRIBUTION word
// for word against the SRD 5.1 PDF's Legal Information page before it ships.

/** The SRD 5.1 CC-BY-4.0 attribution, verbatim from the M65 plan. */
export const SRD_ATTRIBUTION = 'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.';

/** Keys that hold rules prose (D&D Beyond text is often non-SRD). */
export const PROSE_KEYS = Object.freeze(['description', 'snippet', 'desc', 'text', 'notes', 'traits', 'backstory']);

/**
 * Remove D&D Beyond prose from authored campaign data: every object that
 * says it came from D&D Beyond (`origin: 'ddb'` or `source: 'ddb'`) loses
 * its prose keys, at any depth. DM-authored text is left alone.
 * Returns a new value; the input is not mutated.
 * @param {unknown} v
 * @returns {unknown}
 */
export function stripDdbProse(v) {
  if (Array.isArray(v)) return v.map(stripDdbProse);
  if (!v || typeof v !== 'object') return v;
  const fromDdb = v.origin === 'ddb' || v.source === 'ddb';
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (fromDdb && PROSE_KEYS.includes(k)) continue;
    out[k] = stripDdbProse(x);
  }
  return out;
}
