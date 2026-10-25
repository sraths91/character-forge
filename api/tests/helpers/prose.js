// Prose scanner for the M65 licensing rule (decision 9, B27): a player
// never receives another seat's rules or character prose. `proseOf` is
// E3's B27 definition (run-privacy.test.js), shared so the run smokes
// (S21, S22) and the acceptance scan (S23) test the same thing.

/**
 * Every prose string in a sheet: rules descriptions (`description`,
 * `snippet`, `desc` at any depth, ≥ 8 chars) and the character's traits.
 * @param {object} sheet  parsed / run sheet
 * @returns {Set<string>}
 */
export function proseOf(sheet) {
  const out = new Set();
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (['description', 'snippet', 'desc'].includes(key) && v.length >= 8) out.add(v);
      return;
    }
    if (Array.isArray(v)) { v.forEach(x => walk(x, key)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(sheet, '');
  for (const v of Object.values(sheet?.traits || {})) if (typeof v === 'string' && v.length >= 8) out.add(v);
  for (const k of ['backstory', 'notes']) if (typeof sheet?.[k] === 'string' && sheet[k].length >= 8) out.add(sheet[k]);
  return out;
}

/**
 * The prose strings of `theirs` a viewer who legitimately holds `mine`
 * must never receive (shared SRD text both sheets carry is excluded).
 * @param {object} mine   the viewer's own sheet (or null)
 * @param {object} theirs another seat's sheet
 * @returns {string[]}
 */
export function foreignProse(mine, theirs) {
  const own = mine ? proseOf(mine) : new Set();
  return [...proseOf(theirs)].filter(x => !own.has(x));
}

/**
 * Every `[label, prose]` leak: a recorded frame (or HTTP body) whose JSON
 * contains one of `forbidden`.
 * @param {Array<{t?: string}|object>} frames
 * @param {string[]} forbidden
 * @param {(f: object, i: number) => string} [label]
 * @returns {Array<[string, string]>}
 */
export function proseLeaks(frames, forbidden, label = (f, i) => `${f?.t ?? 'body'}#${i}`) {
  const leaks = [];
  frames.forEach((f, i) => {
    const text = JSON.stringify(f);
    for (const p of forbidden) if (text.includes(p)) leaks.push([label(f, i), p.slice(0, 60)]);
  });
  return leaks;
}
