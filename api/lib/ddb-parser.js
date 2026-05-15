/**
 * Normalize a D&D Beyond character JSON into the shape the sprite renderer
 * expects. Defensive: unknown fields fall through; missing fields return
 * sensible defaults rather than throwing.
 *
 * DDB stat ids: 1=STR, 2=DEX, 3=CON, 4=INT, 5=WIS, 6=CHA.
 */

const STAT_NAMES = { 1: 'STR', 2: 'DEX', 3: 'CON', 4: 'INT', 5: 'WIS', 6: 'CHA' };

export function parseCharacter(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('parseCharacter: raw must be an object');
  }

  const id = String(raw.id ?? '');
  const name = String(raw.name ?? 'Unnamed');
  const race = parseRace(raw);
  const classes = parseClasses(raw);
  const level = classes.reduce((sum, c) => sum + c.level, 0);
  const abilityScores = parseAbilityScores(raw);
  const { slots: equipment, carried } = parseEquipment(raw);
  const feats = parseFeats(raw);
  const classFeatures = parseClassFeatures(raw);
  const combatMods = parseCombatModifiers(raw);
  const hp = parseHitPoints(raw, abilityScores, level);
  const deathSaves = parseDeathSaves(raw);

  return {
    id,
    name,
    race,
    classes,
    level,
    abilityScores,
    abilityModifiers: deriveModifiers(abilityScores),
    hp,
    deathSaves,
    // Phase E3/H — fields populated by UI (user-toggled live state); not
    // typically present in D&DB static character JSON. Initialize as empty.
    conditions: [],
    concentration: null,
    equipment,
    carried,
    feats,
    classFeatures,
    combatMods,
    // Note: skinTone is intentionally NOT set here. The renderer's
    // inferSkinTone() consults character.appearance.skin first (via the
    // E1 appearance-parser) and falls back to a race default — setting
    // a race-derived tone here would mask appearance overrides. The
    // legacy export of deriveSkinTone is kept for any callers that
    // want a quick race-based hint without the full pipeline.
    visualHints: deriveVisualHints({ feats, equipment, abilityScores }),
    // Phase E1 — physical appearance free-text fields from D&DB. The sprite
    // renderer's appearance-parser consumes these to override race defaults.
    appearance: parseAppearance(raw),
    // Roleplay narrative fields. Not consumed by the sprite today, but
    // surfacing them here makes them available to future phases (companions,
    // background prop selection) without re-fetching.
    traits: parseTraits(raw),
    gender: raw.gender ?? null,
    faith:  raw.faith  ?? null,
    lifestyle: decodeLifestyle(raw),
    background: parseBackground(raw),  // Phase F2 — drives default props
    inspiration: !!raw.inspiration
  };
}

/**
 * D&DB stores background as either an official `background.definition.name`
 * (e.g., "Acolyte") or a `background.customBackground.name` for homebrew.
 * Returns the string name or null when no background is set.
 */
function parseBackground(raw) {
  const bg = raw.background;
  if (!bg || typeof bg !== 'object') return null;
  const name = bg.definition?.name || bg.customBackground?.name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return null;
}

/**
 * D&DB stores lifestyle as a numeric `lifestyleId` (1–7). Older imports may
 * use the string `lifestyle`. Map id → canonical name for downstream
 * matchers (Phase F4 will key off this).
 *   1=Wretched 2=Squalid 3=Poor 4=Modest 5=Comfortable 6=Wealthy 7=Aristocratic
 */
const LIFESTYLE_NAMES = {
  1: 'Wretched', 2: 'Squalid', 3: 'Poor', 4: 'Modest',
  5: 'Comfortable', 6: 'Wealthy', 7: 'Aristocratic'
};
function decodeLifestyle(raw) {
  if (typeof raw.lifestyleId === 'number') return LIFESTYLE_NAMES[raw.lifestyleId] || null;
  if (typeof raw.lifestyle === 'string' && raw.lifestyle.trim()) return raw.lifestyle.trim();
  return null;
}

/**
 * Pull the physical-description free-text from a raw D&DB character. All
 * fields are optional on D&DB and may be empty strings or null. Empty
 * strings are coerced to null so the appearance-parser can fall through
 * to race defaults cleanly.
 */
function parseAppearance(raw) {
  const trim = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
  };
  // D&DB ships a `weight` field as a number (lbs) and a `height` string.
  // Age is usually a number but stored as text in some imports.
  return {
    hair:   trim(raw.hair),
    eyes:   trim(raw.eyes),
    skin:   trim(raw.skin),
    age:    trim(raw.age),
    height: trim(raw.height),
    weight: trim(raw.weight),
    // 'build' is not a native D&DB field — left null; populated from the
    // appearance free-text inside `traits.appearance` if present.
    build:  trim(raw.traits?.appearance) || null
  };
}

/**
 * Roleplay text from D&DB's `traits` object: personality traits, ideals,
 * bonds, flaws, free-form appearance description, and backstory.
 */
function parseTraits(raw) {
  // D&DB sometimes stores literal "null" strings in free-text fields.
  // Coerce to actual null so downstream rendering doesn't display "null".
  const trim = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return (s.length === 0 || s.toLowerCase() === 'null') ? null : s;
  };
  const t = raw.traits || {};
  return {
    personalityTraits: trim(t.personalityTraits),
    ideals: trim(t.ideals),
    bonds:  trim(t.bonds),
    flaws:  trim(t.flaws),
    appearance: trim(t.appearance),
    backstory:  trim(raw.notes?.backstory) || trim(t.backstory)
  };
}

function deriveSkinTone(race) {
  const name = String(race?.name || race?.base || '').toLowerCase();
  if (name.includes('drow') || name.includes('dark elf') || name.includes('duergar')) return 'ashen';
  if (name.includes('orc') || name.includes('hobgoblin') || name.includes('goblin') || name.includes('bugbear')) return 'green';
  if (name.includes('tiefling')) return 'red';
  if (name.includes('triton') || name.includes('sea elf')) return 'blue';
  if (name.includes('halfling') || name.includes('hill dwarf') || name.includes('gnome')) return 'tan';
  if (name.includes('mountain dwarf')) return 'tan';
  if (name.includes('dragonborn')) return 'olive';
  if (name.includes('aasimar') || name.includes('high elf')) return 'pale';
  return 'light';
}

function parseRace(raw) {
  const r = raw.race || {};
  return {
    name: r.fullName || r.baseRaceName || r.baseName || 'Human',
    base: r.baseRaceName || r.baseName || null
  };
}

function parseClasses(raw) {
  const list = Array.isArray(raw.classes) ? raw.classes : [];
  return list.map(c => ({
    name: c?.definition?.name || 'Unknown',
    level: Number(c?.level) || 0,
    subclass: c?.subclassDefinition?.name || null
  }));
}

// M10 — Class & subclass features.
//
// D&DB exposes the full ladder of features for each class (1..20) inside
// `classes[i].classFeatures`. We want the ones the character has actually
// unlocked at their current level. Subclass features are flagged with
// `definition.isSubClassFeature` and routed to the subclass name as
// source so the UI can group them.
//
// We also cross-reference `actions.class[]` by `componentId === feature.id`
// to surface dice and usage caps (e.g. Channel Divinity 1/short rest).
//
// Noise features (Hit Points, Equipment, Proficiencies, ASI placeholders,
// Languages) are filtered out — they aren't actionable abilities the
// player needs surfaced on a play sheet.

const FEATURE_NAME_DENYLIST = new Set([
  'Hit Points',
  'Equipment',
  'Proficiencies',
  'Ability Score Improvement',
  'Languages',
  'Saving Throws',
  'Tool Proficiencies',
  'Weapon Proficiencies',
  'Armor Proficiencies'
]);

// D&DB encodes resetType as either a numeric code OR a string label
// depending on where in the JSON it appears. The numeric codes come
// from actions.class[].limitedUse and follow D&DB's internal enum.
// String labels appear in some other paths; we keep both for safety.
const RESET_TYPE_LABEL = {
  // String forms
  'shortrest': 'short rest',
  'short': 'short rest',
  'longrest': 'long rest',
  'long': 'long rest',
  'turn': 'turn',
  'dawn': 'dawn',
  // Numeric forms (from limitedUse.resetType — observed empirically)
  '1': 'short rest',
  '2': 'long rest',
  '3': 'dawn',
  '4': 'dusk',
  '5': 'turn'
};

export function parseClassFeatures(raw) {
  const classes = Array.isArray(raw.classes) ? raw.classes : [];
  const actionsByComponent = indexClassActions(raw.actions?.class);
  const out = [];

  for (const cls of classes) {
    const className = cls?.definition?.name || 'Class';
    const subclassName = cls?.subclassDefinition?.name || null;
    const currentLevel = Number(cls?.level) || 0;
    const features = Array.isArray(cls.classFeatures) ? cls.classFeatures : [];

    // Subclass detection. D&DB sets `definition.classId` on every feature
    // to the id of the class (or subclass) it BELONGS to. The parent class
    // id matches `cls.definition.id`, the subclass id matches
    // `cls.subclassDefinition.id`. Cross-referencing isSubClassFeature
    // and the subclassDefinition.classFeatures id-set proved unreliable
    // on real character data — both ignored Twilight Domain attribution.
    const baseClassId = cls?.definition?.id;

    for (const f of features) {
      const def = f?.definition;
      if (!def) continue;
      if (def.hideInSheet) continue;
      const featureName = String(def.name || '').trim();
      if (!featureName || FEATURE_NAME_DENYLIST.has(featureName)) continue;
      const requiredLevel = Number(def.requiredLevel) || 1;
      if (requiredLevel > currentLevel) continue;

      const action = actionsByComponent.get(def.id) || null;
      const description = pickDescription(def, action);
      const dice = action ? formatDDBDice(action.dice) : null;
      const uses = action ? formatUses(action.limitedUse) : null;

      const isSub = baseClassId != null && def.classId != null && def.classId !== baseClassId;
      out.push({
        name: featureName,
        source: isSub && subclassName ? subclassName : className,
        level: requiredLevel,
        description,
        dice,
        uses
      });
    }
  }

  // Stable ordering: by level, then by source then name. The sheet groups
  // by source anyway, but a stable order within each group keeps re-imports
  // visually stable.
  out.sort((a, b) =>
    a.level - b.level ||
    a.source.localeCompare(b.source) ||
    a.name.localeCompare(b.name));
  return out;
}

function indexClassActions(actions) {
  const map = new Map();
  if (!Array.isArray(actions)) return map;
  for (const a of actions) {
    if (a?.componentId != null) map.set(a.componentId, a);
  }
  return map;
}

/**
 * Pick the most readable, compact description. Snippet is plain text and
 * preferred. Falls back to first paragraph of HTML description with tags
 * stripped — keeps the sheet from drowning in 800-word feature writeups.
 */
function pickDescription(def, action) {
  const snippet = (action?.snippet || def?.snippet || '').trim();
  if (snippet) return stripHtml(snippet).trim();   // snippets also carry {{tokens}}
  const desc = String(def?.description || '');
  if (!desc) return '';
  // First <p>...</p> block, tags stripped; fall back to entire text stripped.
  const para = desc.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const inner = para ? para[1] : desc;
  return stripHtml(inner).trim();
}

function stripHtml(s) {
  return String(s)
    .replace(/<\/?[^>]+>/g, '')
    // D&DB embeds inline templating like {{modifier:wis@min:1}} for stat
    // refs and proficiency bonus. We can't compute them in-parser without
    // the full modifier engine, so strip the token entirely rather than
    // showing the raw mustache to the user.
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

/**
 * D&DB dice are usually `{ diceCount, diceValue, fixedValue, diceString }`.
 * We trust diceString when present; otherwise compose from the parts.
 * Returns null if the action carries no dice info.
 */
export function formatDDBDice(dice) {
  if (!dice) return null;
  if (typeof dice.diceString === 'string' && dice.diceString) return dice.diceString;
  const count = Number(dice.diceCount) || 0;
  const sides = Number(dice.diceValue) || 0;
  const mod   = Number(dice.fixedValue) || 0;
  if (!count || !sides) return null;
  const base = `${count}d${sides}`;
  if (!mod) return base;
  return mod > 0 ? `${base}+${mod}` : `${base}${mod}`;
}

/**
 * Format D&DB limited-use info into { max, reset } — e.g. Channel Divinity
 * at L2 has maxUses=1 resetType='shortrest'. Returns null when uses are
 * unspecified (most features don't cap by rest).
 */
// M12 — Combat modifier extraction.
//
// D&DB encodes per-item / per-feat / per-class numeric bonuses as records
// in raw.modifiers.{item,feat,class,race,background}. Each modifier has
//   - type    (e.g. 'bonus', 'set', 'advantage', 'proficiency')
//   - subType (e.g. 'spell-attacks', 'damage-rolls', 'armor-class')
//   - value/fixedValue (numeric)
//   - componentId (id of the item/feat/feature it came from)
//
// We pull the combat-relevant ones (attack/damage/AC bonuses; saves and
// initiative kept for future use) and resolve componentId back to the
// source item/feat/feature so the UI can label every part of an attack
// breakdown with where the bonus came from ("+1 from Amulet of the
// Devout").
//
// Attunement: items with `definition.canAttune === true` only contribute
// their modifiers while `isAttuned === true`. We flag inactive mods with
// `inactive: true` rather than dropping them so the future "why isn't
// this bonus applying?" UI has something to point at.

const COMBAT_MOD_SUBTYPES = new Map([
  // Attack bonuses
  ['attack-rolls',          { kind: 'attack', scope: 'all' }],
  ['weapon-attacks',        { kind: 'attack', scope: 'weapon-all' }],
  ['melee-attacks',         { kind: 'attack', scope: 'weapon-melee' }],
  ['ranged-attacks',        { kind: 'attack', scope: 'weapon-ranged' }],
  ['melee-weapon-attacks',  { kind: 'attack', scope: 'weapon-melee' }],
  ['ranged-weapon-attacks', { kind: 'attack', scope: 'weapon-ranged' }],
  ['spell-attacks',         { kind: 'attack', scope: 'spell' }],
  // Damage bonuses
  ['damage-rolls',          { kind: 'damage', scope: 'all' }],
  ['weapon-damage',         { kind: 'damage', scope: 'weapon-all' }],
  ['melee-damage',          { kind: 'damage', scope: 'weapon-melee' }],
  ['ranged-damage',         { kind: 'damage', scope: 'weapon-ranged' }],
  ['melee-weapon-damage',   { kind: 'damage', scope: 'weapon-melee' }],
  ['ranged-weapon-damage',  { kind: 'damage', scope: 'weapon-ranged' }],
  ['spell-damage',          { kind: 'damage', scope: 'spell' }],
  // Save DC bonuses
  ['spell-save-dc',         { kind: 'save-dc', scope: 'spell' }],
  // AC
  ['armor-class',           { kind: 'ac', scope: 'all' }],
  ['unarmored-armor-class', { kind: 'ac', scope: 'unarmored' }],
  // Saves
  ['saving-throws',         { kind: 'save', scope: 'all' }],
  ['strength-saving-throws',     { kind: 'save', scope: 'str' }],
  ['dexterity-saving-throws',    { kind: 'save', scope: 'dex' }],
  ['constitution-saving-throws', { kind: 'save', scope: 'con' }],
  ['intelligence-saving-throws', { kind: 'save', scope: 'int' }],
  ['wisdom-saving-throws',       { kind: 'save', scope: 'wis' }],
  ['charisma-saving-throws',     { kind: 'save', scope: 'cha' }],
  // Initiative
  ['initiative',            { kind: 'initiative', scope: 'all' }]
]);

export function parseCombatModifiers(raw) {
  const buckets = ['item', 'feat', 'class', 'race', 'background'];
  const out = [];

  // Build componentId → source-name index once per bucket so we don't
  // re-scan inventory/feats for every modifier row.
  const itemIndex = indexInventoryItems(raw.inventory);
  const featIndex = indexById(raw.feats, f => f?.definition?.id, f => f?.definition?.name);
  const classFeatureIndex = indexClassFeatureNames(raw.classes);

  for (const bucket of buckets) {
    const mods = raw.modifiers?.[bucket];
    if (!Array.isArray(mods)) continue;
    for (const m of mods) {
      // We only care about numeric bonuses (advantages, proficiencies,
      // sets, etc. are handled elsewhere or out of M12 scope).
      if (m.type !== 'bonus') continue;
      const meta = COMBAT_MOD_SUBTYPES.get(m.subType);
      if (!meta) continue;
      const value = Number(m.value ?? m.fixedValue);
      if (!Number.isFinite(value) || value === 0) continue;

      let source = 'Unknown';
      let attunementInfo = null;
      if (bucket === 'item') {
        const itemEntry = itemIndex.get(m.componentId);
        if (itemEntry) {
          source = itemEntry.name;
          attunementInfo = {
            requiresAttunement: !!itemEntry.canAttune,
            attuned: !!itemEntry.isAttuned
          };
        }
      } else if (bucket === 'feat') {
        source = featIndex.get(m.componentId) || 'Feat';
      } else if (bucket === 'class') {
        source = classFeatureIndex.get(m.componentId) || 'Class';
      } else {
        source = bucket.charAt(0).toUpperCase() + bucket.slice(1);
      }

      const inactive = attunementInfo?.requiresAttunement && !attunementInfo.attuned;

      out.push({
        bucket,
        source,
        subType: m.subType,
        kind: meta.kind,
        scope: meta.scope,
        value,
        inactive: !!inactive,
        requiresAttunement: !!attunementInfo?.requiresAttunement,
        attuned: attunementInfo?.attuned ?? null
      });
    }
  }

  return out;
}

function indexInventoryItems(inventory) {
  const map = new Map();
  if (!Array.isArray(inventory)) return map;
  for (const it of inventory) {
    const id = it?.definition?.id;
    if (id == null) continue;
    map.set(id, {
      name: it.definition.name || 'Item',
      canAttune: !!it.definition.canAttune,
      isAttuned: !!it.isAttuned
    });
  }
  return map;
}

function indexById(arr, idFn, valueFn) {
  const map = new Map();
  if (!Array.isArray(arr)) return map;
  for (const x of arr) {
    const id = idFn(x);
    if (id == null) continue;
    map.set(id, valueFn(x));
  }
  return map;
}

function indexClassFeatureNames(classes) {
  const map = new Map();
  if (!Array.isArray(classes)) return map;
  for (const cls of classes) {
    for (const f of (cls.classFeatures || [])) {
      const id = f?.definition?.id;
      if (id != null) map.set(id, f.definition.name || 'Class Feature');
    }
  }
  return map;
}

export function formatUses(limitedUse) {
  if (!limitedUse) return null;
  const max = Number(limitedUse.maxUses) || null;
  if (!max) return null;
  const reset = RESET_TYPE_LABEL[String(limitedUse.resetType || '').toLowerCase()] || null;
  return { max, reset };
}

// D&DB stores ability-score adjustments in two places:
//   1. raw.bonusStats[]      — point-buy/manual bonuses (recorded per-stat)
//   2. raw.modifiers.*[]     — race/class/feat/background/item modifiers,
//      where each entry with type='bonus' and subType='<stat>-score'
//      adds to the corresponding ability. type='set' with the same
//      subType replaces the score entirely.
//
// Stat names in the modifier subType match D&DB's lowercase convention:
//   strength-score, dexterity-score, constitution-score, intelligence-score,
//   wisdom-score, charisma-score.
const STAT_SUBTYPE_TO_KEY = {
  'strength-score':     'STR',
  'dexterity-score':    'DEX',
  'constitution-score': 'CON',
  'intelligence-score': 'INT',
  'wisdom-score':       'WIS',
  'charisma-score':     'CHA'
};

function collectAllModifiers(raw) {
  const m = raw.modifiers || {};
  return [
    ...(Array.isArray(m.race)       ? m.race       : []),
    ...(Array.isArray(m.class)      ? m.class      : []),
    ...(Array.isArray(m.feat)       ? m.feat       : []),
    ...(Array.isArray(m.background) ? m.background : []),
    ...(Array.isArray(m.item)       ? m.item       : []),
    ...(Array.isArray(m.condition)  ? m.condition  : [])
  ];
}

function parseAbilityScores(raw) {
  const stats = Array.isArray(raw.stats) ? raw.stats : [];
  const bonus = Array.isArray(raw.bonusStats) ? raw.bonusStats : [];
  const override = Array.isArray(raw.overrideStats) ? raw.overrideStats : [];
  const out = { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 };
  // Base scores
  for (const s of stats) {
    const key = STAT_NAMES[s.id];
    if (key && Number.isFinite(s.value)) out[key] = s.value;
  }
  // Bonus stats array (point-buy bonuses, negative for racial penalties etc.)
  for (const s of bonus) {
    const key = STAT_NAMES[s.id];
    if (key && Number.isFinite(s.value)) out[key] += s.value;
  }
  // Modifier-section bonuses (race/feat/etc.) — this is where Resilient's
  // +1 CON, Custom Lineage's +2 ability bonus, and many magic items live.
  for (const mod of collectAllModifiers(raw)) {
    const key = STAT_SUBTYPE_TO_KEY[mod.subType];
    if (!key) continue;
    const v = Number(mod.value ?? mod.fixedValue);
    if (!Number.isFinite(v)) continue;
    if (mod.type === 'bonus') out[key] += v;
    else if (mod.type === 'set' && v > out[key]) out[key] = v;   // 'set' floors the score
  }
  // Manual overrides (per-stat) — last to win
  for (const s of override) {
    const key = STAT_NAMES[s.id];
    if (key && Number.isFinite(s.value)) out[key] = s.value;
  }
  return out;
}

function deriveModifiers(scores) {
  const mods = {};
  for (const [k, v] of Object.entries(scores)) {
    mods[k] = Math.floor((v - 10) / 2);
  }
  return mods;
}

/**
 * Hit points. D&DB's `baseHitPoints` is the dice-sum component only — the
 * CON-modifier-per-level contribution is NOT included and must be added
 * here. Formula (when no manual override is set):
 *
 *   max = baseHitPoints + bonusHitPoints + (CON_mod × totalLevel)
 *
 * If `overrideHitPoints` is set (rare — only when the user manually pins
 * the value), it wins over the derived max. `bonusHitPoints` covers feats
 * like Tough that ADD to HP without going through CON.
 */
function parseHitPoints(raw, abilityScores, totalLevel) {
  const base = Number(raw.baseHitPoints) || 0;
  const bonus = Number(raw.bonusHitPoints) || 0;
  const override = raw.overrideHitPoints ?? null;
  const temp = Number(raw.temporaryHitPoints) || 0;
  const removed = Number(raw.removedHitPoints) || 0;
  const conMod = abilityScores ? Math.floor(((abilityScores.CON ?? 10) - 10) / 2) : 0;
  const derived = base + bonus + (conMod * (totalLevel || 0));
  const max = (typeof override === 'number' ? override : derived) || 0;
  const current = Math.max(0, max - removed);
  return { base, bonus, override, temp, removed, max, current };
}

/**
 * Phase E2 — D&DB tracks death saves on the static character. Each is a
 * count 0-3 (3 successes = stable, 3 failures = dead). Defaults to zeros.
 */
function parseDeathSaves(raw) {
  const ds = raw.deathSaves || {};
  return {
    successes: Math.min(3, Math.max(0, Number(ds.successCount ?? ds.successes) || 0)),
    failures:  Math.min(3, Math.max(0, Number(ds.failCount    ?? ds.failures)  || 0))
  };
}

function parseFeats(raw) {
  const list = Array.isArray(raw.feats) ? raw.feats : [];
  return list
    .map(f => f?.definition?.name)
    .filter(Boolean);
}

/**
 * Map an inventory item to a canonical equipment slot. Returns null if
 * the item is not visually slottable (e.g., backpack, potion).
 */
export function classifyItem(item) {
  const def = item?.definition;
  if (!def) return null;
  const filterType = def.filterType || '';
  const type = def.type || '';
  const subType = def.subType || '';
  const name = (def.name || '').toLowerCase();

  if (filterType === 'Armor') {
    if (subType === 'Shield' || name.includes('shield')) return 'offhand';
    return 'armor';
  }

  if (filterType === 'Weapon' || type === 'Weapon') {
    // Trust only the explicit "two-handed" property. DDB's attackType marks
    // melee (1) vs ranged (2) — using it as a two-handed signal wrongly tags
    // hand crossbows / slings as two-handed and nulls the off-hand slot.
    const props = (def.properties || []).map(p => (p?.name || '').toLowerCase());
    const isTwoHanded = props.includes('two-handed');
    return isTwoHanded ? 'mainhand-twohanded' : 'mainhand';
  }

  if (filterType === 'Wondrous item' || filterType === 'Wondrous Item' || type === 'Wondrous item') {
    if (name.includes('boots') || name.includes('slippers') || name.includes('sandals')) return 'boots';
    if (name.includes('cloak') || name.includes('cape') || name.includes('mantle')) return 'cloak';
    if (name.includes('gauntlet') || name.includes('gloves') || name.includes('bracers')) return 'gloves';
    if (name.includes('helm') || name.includes('hat') || name.includes('circlet') || name.includes('crown') || name.includes('headband') || name.includes('mask')) return 'helm';
    if (name.includes('amulet') || name.includes('necklace') || name.includes('pendant') || name.includes('periapt')) return 'amulet';
    if (name.includes('belt') || name.includes('girdle')) return 'belt';
  }

  if (filterType === 'Ring' || name.includes('ring of ')) return 'ring';
  return null;
}

function parseEquipment(raw) {
  const inventory = Array.isArray(raw.inventory) ? raw.inventory : [];
  const slots = {
    armor: null,
    mainhand: null,
    offhand: null,
    helm: null,
    boots: null,
    cloak: null,
    gloves: null,
    belt: null,
    amulet: null,
    rings: []
  };
  const carried = [];

  for (const item of inventory) {
    if (!item.equipped) continue;
    const inferredSlot = classifyItem(item);
    if (!inferredSlot) continue;

    const summary = {
      name: item.definition?.name || 'Unknown item',
      rarity: item.definition?.rarity || 'Common',
      magical: !!item.definition?.magic,
      attuned: !!item.isAttuned,
      armorClass: item.definition?.armorClass ?? null,
      damage: item.definition?.damage?.diceString ?? null,
      damageType: item.definition?.damageType ?? null
    };

    let assignedSlot = 'overflow';
    if (inferredSlot === 'mainhand-twohanded') {
      // Existing behaviour: two-handed unconditionally overwrites mainhand.
      // Preserved verbatim — Tier 1 doesn't change auto-assignment policy,
      // it just records overflow when the slot was already filled.
      if (slots.mainhand === null) {
        slots.mainhand = { ...summary, twoHanded: true };
        slots.offhand = null;
        assignedSlot = 'mainhand';
      }
    } else if (inferredSlot === 'ring') {
      if (slots.rings.length < 2) {
        slots.rings.push(summary);
        assignedSlot = 'ring';
      }
    } else if (slots[inferredSlot] === null) {
      slots[inferredSlot] = summary;
      assignedSlot = inferredSlot;
    }

    carried.push({
      ...summary,
      slot: assignedSlot,
      inferredSlot,
      twoHanded: inferredSlot === 'mainhand-twohanded'
    });
  }

  return { slots, carried };
}

const FEAT_VISUAL_MAP = {
  'Sharpshooter': { tag: 'quiver', tint: null },
  'Great Weapon Master': { tag: 'oversized-weapon', tint: null },
  'Magic Initiate': { tag: 'glow-hand', tint: '#6366f1' },
  'Tough': { tag: 'bulkier', tint: null },
  'Defensive Duelist': { tag: 'duelist-stance', tint: null },
  'War Caster': { tag: 'glow-hand', tint: '#a855f7' },
  'Heavily Armored': { tag: 'armor-emphasis', tint: null }
};

function deriveVisualHints({ feats, equipment, abilityScores }) {
  const featTags = feats
    .map(name => FEAT_VISUAL_MAP[name])
    .filter(Boolean);

  return {
    featTags,
    bodyWidth: abilityScores.CON >= 16 ? 'broad' : abilityScores.CON <= 9 ? 'thin' : 'normal',
    armorWeight: abilityScores.STR >= 16 ? 'heavy' : 'normal',
    stance: abilityScores.DEX >= 16 ? 'dynamic' : 'planted',
    palette: abilityScores.CHA >= 16 ? 'saturated' : 'normal',
    twoHandedWeapon: !!equipment.mainhand?.twoHanded
  };
}
