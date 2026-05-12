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
