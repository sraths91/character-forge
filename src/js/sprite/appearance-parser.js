/**
 * Phase E1 — fuzzy free-text appearance parser.
 *
 * D&D Beyond stores hair/eyes/skin/age/height/weight as free-text on the
 * character sheet. Users write things like "Auburn, shoulder-length",
 * "Hazel", "Salt-and-pepper", "Tanned with freckles". This module maps
 * those descriptors to our existing sprite vocabulary via first-match
 * substring scans against synonym tables.
 *
 * Pure logic — no DOM, safe to call from Node tests. Returns canonical
 * keys that the lpc-config picker chain consumes:
 *   - hairColor key  → HAIR_COLOR_FILTERS
 *   - hairStyle key  → ASSET_MAP.hair
 *   - eyeColor key   → ASSET_MAP.eyes
 *   - skinTone key   → SKIN_TONES
 *   - bodyWidth key  → 'thin' | 'normal' | 'broad' (consumed by compositor.applyBodySilhouette)
 *   - ageBias number → hint for upstream pickers (gray-hair likelihood)
 */

// ---- Synonym tables. Order matters: more-specific entries first. ----

const HAIR_COLOR_RULES = [
  // Multi-word forms first
  ['salt-and-pepper', 'gray'],
  ['salt and pepper', 'gray'],
  // Specific shades → canonical color
  ['platinum',  'white'],
  ['silver',    'gray'],
  ['ash',       'gray'],
  ['raven',     'black'],
  ['jet',       'black'],
  ['ebony',     'black'],
  ['auburn',    'red'],
  ['ginger',    'red'],
  ['copper',    'red'],
  ['strawberry','blonde'],
  ['flaxen',    'blonde'],
  ['honey',     'blonde'],
  ['chestnut',  'brown'],
  ['mahogany',  'brown'],
  // Direct color names
  ['black',     'black'],
  ['white',     'white'],
  ['blonde',    'blonde'],
  ['blond',     'blonde'],
  ['red',       'red'],
  ['gray',      'gray'],
  ['grey',      'gray'],
  ['brown',     'brown']
];

const HAIR_STYLE_RULES = [
  // 'bald' / 'balding' must beat 'short' fallback
  ['shaved',           'balding'],
  ['bald',             'balding'],
  ['buzzed',           'buzzcut'],
  ['buzzcut',          'buzzcut'],
  ['crew cut',         'buzzcut'],
  ['crew-cut',         'buzzcut'],
  ['cropped',          'buzzcut'],
  ['short',            'buzzcut'],
  ['bob',              'bob'],
  ['shoulder-length',  'bob'],
  ['shoulder length',  'bob'],
  ['afro',             'afro'],
  ['fro',              'afro'],
  ['curly',            'afro'],
  ['spiked',           'spiked'],
  ['spiky',            'spiked'],
  ['mohawk',           'spiked'],
  ['punk',             'spiked'],
  ['messy',            'bedhead'],
  ['unkempt',          'bedhead'],
  ['bedhead',          'bedhead'],
  ['tousled',          'bedhead'],
  ['waist-length',     'long'],
  ['waist length',     'long'],
  ['flowing',          'long'],
  ['long',             'long']
];

const EYE_COLOR_RULES = [
  ['hazel',     'brown'],
  ['amber',     'brown'],
  ['emerald',   'green'],
  ['sapphire',  'blue'],
  ['cobalt',    'blue'],
  ['azure',     'blue'],
  ['violet',    'gray'],   // closest available
  ['purple',    'gray'],   // closest available
  ['silver',    'gray'],
  ['blue',      'blue'],
  ['brown',     'brown'],
  ['green',     'green'],
  ['gray',      'gray'],
  ['grey',      'gray']
];

const SKIN_RULES = [
  // Specific descriptors
  ['ebony',     'dark'],
  ['mahogany',  'dark'],
  ['umber',     'dark'],
  ['ghostly',   'ashen'],
  ['ashen',     'ashen'],
  ['sun-kissed', 'tan'],
  ['sunkissed', 'tan'],
  ['tanned',    'tan'],
  ['swarthy',   'olive'],
  ['ruddy',     'red'],
  ['freckled',  'light'],
  // Direct keys (already in SKIN_TONES)
  ['light',     'light'],
  ['pale',      'pale'],
  ['tan',       'tan'],
  ['olive',     'olive'],
  ['dark',      'dark'],
  ['green',     'green'],
  ['red',       'red'],
  ['blue',      'blue']
];

const BUILD_RULES = [
  // Broad / heavy
  ['broad-shouldered', 'broad'],
  ['broad shouldered', 'broad'],
  ['burly',     'broad'],
  ['bulky',     'broad'],
  ['hulking',   'broad'],
  ['muscular',  'broad'],
  ['stocky',    'broad'],
  ['heavy',     'broad'],
  ['broad',     'broad'],
  ['athletic',  'broad'],
  // Thin / slender
  ['slender',   'thin'],
  ['slim',      'thin'],
  ['lean',      'thin'],
  ['wiry',      'thin'],
  ['gaunt',     'thin'],
  ['skinny',    'thin'],
  ['thin',      'thin']
];

// ---- Parsers (each returns null when no match found) ----

function firstMatch(text, rules) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const [needle, key] of rules) {
    if (t.includes(needle)) return key;
  }
  return null;
}

export function parseHairColor(text) { return firstMatch(text, HAIR_COLOR_RULES); }
export function parseHairStyle(text) { return firstMatch(text, HAIR_STYLE_RULES); }
export function parseEyeColor(text)  { return firstMatch(text, EYE_COLOR_RULES);  }
export function parseSkin(text)      { return firstMatch(text, SKIN_RULES);       }

/**
 * Parse build from any of build/height/weight free-text. Build keywords win.
 * Falls back to a height+weight heuristic only when both are numerical and
 * outside the average range. Returns 'thin' | 'broad' | 'normal' | null.
 */
export function parseBuild(buildText, heightText, weightText) {
  const fromKeyword = firstMatch(buildText, BUILD_RULES) ||
                      firstMatch(heightText, BUILD_RULES) ||
                      firstMatch(weightText, BUILD_RULES);
  if (fromKeyword) return fromKeyword;

  // Heuristic fallback: extract numerical height (feet+inches or cm) and
  // weight (lb or kg). Compare against a rough 'average' band.
  const heightInches = parseHeightToInches(heightText);
  const weightLbs    = parseWeightToLbs(weightText);
  if (heightInches != null && weightLbs != null && heightInches > 0) {
    // BMI-ish proxy: weight / height^2 (in lb / in^2 × 703 ≈ BMI).
    const bmi = (weightLbs / (heightInches * heightInches)) * 703;
    if (bmi < 20) return 'thin';
    if (bmi > 27) return 'broad';
    return 'normal';
  }
  return null;
}

/**
 * Parse age — return either an integer year, or a coarse age band token
 * ('young' | 'adult' | 'elderly'). Used to bias hair color toward gray.
 */
export function parseAge(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  // Numerical years win
  const m = t.match(/(\d{1,4})\s*(?:y|yr|year)?/);
  if (m) return parseInt(m[1], 10);
  // Coarse band keywords
  if (t.includes('ancient') || t.includes('elderly') || t.includes('aged') || t.includes('old')) return 'elderly';
  if (t.includes('young') || t.includes('youth') || t.includes('teen')) return 'young';
  if (t.includes('adult') || t.includes('middle')) return 'adult';
  return null;
}

/**
 * Map an age value to an age-bias key that pickers can use. Older ages
 * trend gray hair; very young ages don't override defaults.
 *   - Under 25 (or 'young')           → 'young'
 *   - 25-59 (or 'adult')              → 'adult'
 *   - 60+ (or 'elderly'/'ancient')    → 'elderly' (push toward gray hair)
 *
 * Race-aware: D&D elves live ~750 years; what counts as 'elderly' depends
 * on the species. We accept a `race` string and scale thresholds.
 */
export function ageBiasFromAge(age, race) {
  if (age == null) return null;
  if (typeof age === 'string') return age;       // already a band token
  const r = String(race || '').toLowerCase();
  let elderlyAt = 60;
  let youngAt   = 25;
  if (r.includes('elf'))   { elderlyAt = 500; youngAt = 80; }
  if (r.includes('dwarf')) { elderlyAt = 250; youngAt = 50; }
  if (r.includes('gnome')) { elderlyAt = 350; youngAt = 60; }
  if (r.includes('halfling')) { elderlyAt = 120; youngAt = 25; }
  if (r.includes('dragonborn')) { elderlyAt = 70; youngAt = 18; }
  if (age < youngAt)    return 'young';
  if (age >= elderlyAt) return 'elderly';
  return 'adult';
}

// ---- Numerical parsers (helpers) ----

function parseHeightToInches(text) {
  if (!text) return null;
  const t = String(text).trim();
  // 5'10" / 5'10 / 5 ft 10 in
  let m = t.match(/(\d+)\s*(?:'|ft|feet)\s*(\d+)?\s*(?:"|in|inch)?/i);
  if (m) return parseInt(m[1], 10) * 12 + (m[2] ? parseInt(m[2], 10) : 0);
  // 180 cm
  m = t.match(/(\d+(?:\.\d+)?)\s*cm/i);
  if (m) return Math.round(parseFloat(m[1]) / 2.54);
  // D&DB compact format: "5 4" or "5  4" (digits separated by whitespace, no
  // unit markers) — treat first number as feet, second as inches when both
  // are reasonable values for a humanoid.
  m = t.match(/^(\d+)\s+(\d+)\s*$/);
  if (m) {
    const feet = parseInt(m[1], 10);
    const inches = parseInt(m[2], 10);
    if (feet >= 1 && feet <= 9 && inches >= 0 && inches < 12) return feet * 12 + inches;
  }
  // bare number assumed inches
  m = t.match(/^(\d+(?:\.\d+)?)\s*$/);
  if (m) return parseFloat(m[1]);
  return null;
}

function parseWeightToLbs(text) {
  if (!text) return null;
  const t = String(text).trim();
  // 180 lb / 180 lbs / 180 pounds
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|pounds?)/i);
  if (m) return parseFloat(m[1]);
  // 82 kg
  m = t.match(/(\d+(?:\.\d+)?)\s*kg/i);
  if (m) return Math.round(parseFloat(m[1]) * 2.20462);
  // bare number assumed lb
  m = t.match(/^(\d+(?:\.\d+)?)\s*$/);
  if (m) return parseFloat(m[1]);
  return null;
}

/**
 * Combine all appearance-text parsing into one structured result. Returns
 * a snapshot object with whichever fields could be parsed; missing fields
 * are null and the caller falls back to race defaults.
 */
export function inferAppearanceTraits(character) {
  const a = character.appearance || {};
  const raceName = character.race?.name || character.race?.base || '';
  return {
    hair: {
      color: parseHairColor(a.hair),
      style: parseHairStyle(a.hair)
    },
    eyes: {
      color: parseEyeColor(a.eyes)
    },
    skin: parseSkin(a.skin),
    bodyWidth: parseBuild(a.build, a.height, a.weight),
    ageBias: ageBiasFromAge(parseAge(a.age), raceName)
  };
}
