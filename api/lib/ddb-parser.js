/**
 * Normalize a D&D Beyond character JSON into the shape the sprite renderer
 * expects. Defensive: unknown fields fall through; missing fields return
 * sensible defaults rather than throwing.
 *
 * DDB stat ids: 1=STR, 2=DEX, 3=CON, 4=INT, 5=WIS, 6=CHA.
 */

import { primaryWeaponForCharacter } from '../../src/js/anim/primary-weapon.js';

const STAT_NAMES = { 1: 'STR', 2: 'DEX', 3: 'CON', 4: 'INT', 5: 'WIS', 6: 'CHA' };

/**
 * Promote the character's ICONIC weapon into `equipment.mainhand`, in place.
 * The parser flags mainhand purely by inventory order, so a warhammer cleric
 * who lists a shortsword first ends up "wielding" the sidearm. This swaps the
 * heuristic-chosen primary into the mainhand slot (mirroring the client-side
 * `assignCarriedSlots` override swap so the equipment↔carried invariant holds)
 * — which every consumer inherits: 2D sprite, 3D model, swing list, AND combat
 * (deriveWeaponAttack / the planner read `equipment.mainhand`). Idempotent.
 */
function promotePrimaryWeapon(character) {
  const { equipment, carried } = character;
  const primary = primaryWeaponForCharacter(character);
  if (!primary) return;
  const prim = carried.includes(primary) ? primary : carried.find(c => c.name === primary.name);
  if (!prim || prim.slot === 'mainhand') return;   // not found / already in hand

  // Demote whoever currently holds mainhand.
  const curMain = carried.find(c => c.slot === 'mainhand');
  if (curMain) curMain.slot = 'overflow';
  // If the primary came from the off hand, clear that equipment entry.
  if (prim.slot === 'offhand') equipment.offhand = null;

  prim.slot = 'mainhand';
  equipment.mainhand = {
    name: prim.name,
    rarity: prim.rarity,
    magical: prim.magical,
    attuned: prim.attuned,
    armorClass: prim.armorClass,
    damage: prim.damage,
    damageType: prim.damageType,
    ...pickWeaponFields(prim),
    ...(prim.twoHanded ? { twoHanded: true } : {})
  };
  // A two-handed primary frees the off hand and sheathes any shield.
  if (prim.twoHanded) {
    equipment.offhand = null;
    const off = carried.find(c => c.slot === 'offhand' && c.name !== prim.name);
    if (off) off.slot = 'overflow';
  }
}

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
  // Promote the iconic weapon into mainhand so every downstream consumer
  // (2D/3D preview, swing list, combat) reflects it, not the incidental
  // first-in-inventory weapon.
  promotePrimaryWeapon({ classes, equipment, carried });
  const feats = parseFeats(raw);
  const classFeatures = parseClassFeatures(raw);
  const combatMods = parseCombatModifiers(raw);
  const spells = parseSpells(raw);
  const savingThrowProficiencies = parseSavingThrowProficiencies(raw);
  const weaponProficiencies = parseWeaponProficiencies(raw);
  const hp = parseHitPoints(raw, abilityScores, level);
  const deathSaves = parseDeathSaves(raw);
  const ddbConditions = parseDdbConditions(raw);
  const slotsUsed = parseSlotsUsed(raw);
  const spellSlotTable = parseSpellSlotTable(raw);
  const inventory = parseInventory(raw);

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
    spells,
    savingThrowProficiencies,
    // R6 — weapon proficiency slugs from DDB `proficiency` modifiers.
    weaponProficiencies,
    // Note: skinTone is intentionally NOT set here. The renderer's
    // inferSkinTone() consults character.appearance.skin first (via the
    // E1 appearance-parser) and falls back to a race default — setting
    // a race-derived tone here would mask appearance overrides.
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
    inspiration: !!raw.inspiration,
    // R14 — DDB's current play state, imported only when the DM opts in
    // (imports start fully rested; `conditions` above stays empty).
    ddbConditions,
    slotsUsed,
    currentXp: Number.isFinite(Number(raw.currentXp)) ? Number(raw.currentXp) : 0,
    // R14 — slot maximums from DDB's class spellRules, not a hard-coded table.
    spellSlotTable,
    // R14 — every inventory row (equipped or not) with quantity and charges;
    // `equipment` / `carried` stay the sprite pipeline's slotted view.
    inventory,
    // R14 — racial trait names (Lucky, Relentless Endurance, ...).
    racialTraits: parseRacialTraits(raw)
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

      const action = classActionFor(actionsByComponent, def.id, featureName);
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

/**
 * componentId → class actions. Several actions can share one componentId
 * (DDB lists "Channel Divinity" and "Channel Divinity: Turn Undead" both
 * under the Channel Divinity feature id), so each id keeps a list and
 * `classActionFor` picks by name.
 */
function indexClassActions(actions) {
  const map = new Map();
  if (!Array.isArray(actions)) return map;
  for (const a of actions) {
    if (a?.componentId == null) continue;
    if (!map.has(a.componentId)) map.set(a.componentId, []);
    map.get(a.componentId).push(a);
  }
  return map;
}

/**
 * The action for a feature: exact name match first, then the one that
 * carries limited uses, then the first listed.
 */
function classActionFor(index, featureId, featureName) {
  const list = index.get(featureId);
  if (!list || list.length === 0) return null;
  const name = String(featureName || '').trim().toLowerCase();
  return list.find(a => String(a?.name || '').trim().toLowerCase() === name)
    || list.find(a => Number(a?.limitedUse?.maxUses) > 0)
    || list[0];
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

// M18 — Spell parser.
//
// D&DB exposes a character's spells in two shapes:
//   raw.classSpells[]  — class-granted prepared spells (the big bucket)
//   raw.spells.{race,feat,item} — innate/granted spells from other sources
//
// We pull both, filter to "things you'd cast at a target" (attack-roll or
// save-based damage-dealing), and normalize into a compact shape the
// combat resolver and Actions panel can consume.
//
// Each spell carries `spellCastingAbilityId` (DDB stat id 1-6) so the
// resolver can compute spell attack bonus / save DC per-spell rather
// than per-character (multiclass can mix WIS-cleric + CHA-warlock).
//
// Healing and pure-buff spells (Bless, Cure Wounds, Mage Armor) are
// surfaced too with kind='utility' so the Actions panel can show them
// without trying to attack-roll them. Filtering happens at the panel
// layer, not here, so future spell mechanics (heal, buff) can hook in.

const STAT_NAMES_BY_DDB_ID = { 1: 'STR', 2: 'DEX', 3: 'CON', 4: 'INT', 5: 'WIS', 6: 'CHA' };

export function parseSpells(raw) {
  const collected = [];
  // Map characterClassId → spellCastingAbilityId. D&DB puts the ability
  // on classes[].definition.spellCastingAbilityId (Cleric = 5/WIS,
  // Wizard = 4/INT, etc.). The classSpells[] groups are keyed by
  // characterClassId, NOT the class definition id, so we go through
  // raw.classes to map each prepared spell back to its caster ability.
  const abilityByCharacterClassId = new Map();
  for (const cls of (raw.classes || [])) {
    const ability = cls?.definition?.spellCastingAbilityId
      ?? cls?.subclassDefinition?.spellCastingAbilityId
      ?? null;
    if (cls?.id != null && ability != null) {
      abilityByCharacterClassId.set(cls.id, ability);
    }
  }

  // Class spells (Cleric prepared list, etc.)
  for (const cs of (raw.classSpells || [])) {
    const classAbility = cs.spellCastingAbilityId
      ?? abilityByCharacterClassId.get(cs.characterClassId)
      ?? null;
    for (const entry of (cs.spells || [])) {
      collected.push({ entry, classCastingAbility: classAbility, source: 'class' });
    }
  }
  // Granted spells from race/feat/item/background (e.g. Magic Initiate,
  // Fey Touched, Mark of Sentinel races, Ring of Spell Storing).
  const grantedBuckets = ['race', 'feat', 'item', 'background'];
  for (const b of grantedBuckets) {
    const list = raw.spells?.[b];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      collected.push({ entry, classCastingAbility: null, source: b });
    }
  }
  const featNames = indexById(raw.feats, f => f?.definition?.id, f => f?.definition?.name);
  const itemNames = indexById(raw.inventory, i => i?.definition?.id, i => i?.definition?.name);

  const out = [];
  for (const { entry, classCastingAbility, source } of collected) {
    const def = entry?.definition;
    if (!def) continue;
    // Only surface spells that are actually accessible right now.
    // Cantrips (level 0) are always accessible; leveled spells must be
    // `prepared` OR `alwaysPrepared` (Twilight Domain's domain spells).
    // R14 — race/feat/item/background grants are `prepared: false` but
    // castable through their own limited uses (Fey Touched's Misty Step,
    // 1/long rest), so a granted spell with uses counts as accessible.
    const isCantrip = def.level === 0;
    const uses = source === 'class' ? null : formatUsesWithUsed(entry.limitedUse);
    if (!isCantrip && !entry.prepared && !entry.alwaysPrepared && !uses) continue;

    const spell = {
      name: def.name,
      level: def.level,
      school: def.school || null,
      // Range: rangeValue (in feet) for ranged; origin for "Self"/"Touch".
      range: def.range?.rangeValue
        ? { kind: 'ranged', feet: def.range.rangeValue }
        : { kind: (def.range?.origin || 'self').toLowerCase(), feet: 0 },
      // Damage / dice. Cantrips often have an `atHigherLevels.scaleType`
      // that bumps the die count at L5/11/17, but for v1 we use the
      // base die unscaled. Caster level scaling can be a later pass.
      dice: extractSpellDice(def),
      damageType: extractSpellDamageType(def),
      requiresAttackRoll: !!def.requiresAttackRoll,
      requiresSavingThrow: !!def.requiresSavingThrow,
      saveStat: STAT_NAMES_BY_DDB_ID[def.saveDcAbilityId] || null,
      // M21 — save-success behavior: most damage spells with saves
      // deal HALF on success; control/cantrip saves usually deal none.
      saveOnHalf: spellSaveDealsHalfOnSuccess(def),
      ritual: !!def.ritual,
      concentration: def.duration?.durationType === 'Concentration',
      // Spellcasting ability for THIS spell — per-spell override beats
      // class default. Used by the resolver to compute attack bonus.
      spellCastingAbility:
        STAT_NAMES_BY_DDB_ID[entry.spellCastingAbilityId] ||
        STAT_NAMES_BY_DDB_ID[classCastingAbility] ||
        null,
      // Slot info: usesSpellSlot=true means a leveled spell that consumes
      // a slot of `castAtLevel`. Cantrips have usesSpellSlot=false.
      usesSpellSlot: !!entry.usesSpellSlot,
      castAtLevel: entry.castAtLevel || def.level,
      // Kind classification — drives the actions panel category.
      // attack-roll spells go in 'spell-attack', save-based in 'spell-save',
      // healing spells get 'heal', everything else 'utility'.
      kind: classifySpellKind(def),
      // R14 — where the spell comes from, and its own uses for non-class
      // grants ({ max, used, reset }; null for class spells).
      source,
      sourceName: source === 'feat' ? (featNames.get(entry.componentId) || null)
        : source === 'item' ? (itemNames.get(entry.componentId) || null)
        : null,
      uses
    };
    out.push(spell);
  }
  // Sort: cantrips first, then by level asc, then by name. Predictable order.
  out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  return out;
}

function extractSpellDice(def) {
  // D&DB stores damage dice on def.modifiers[].die for the base "deal damage" modifier.
  // Healing spells use def.healingDice / def.healing instead.
  const mods = Array.isArray(def.modifiers) ? def.modifiers : [];
  // Damage modifier first — prefer one tagged with a damage subType.
  const damageMod = mods.find(m => /damage$/i.test(m.subType || '') && m.die?.diceString);
  if (damageMod?.die?.diceString) return damageMod.die.diceString;
  // Fall back to first die we find
  const anyDie = mods.find(m => m.die?.diceString);
  if (anyDie) return anyDie.die.diceString;
  // Healing spells: def.healingDice is sometimes set
  if (Array.isArray(def.healingDice) && def.healingDice[0]?.diceString) {
    return def.healingDice[0].diceString;
  }
  return null;
}

function extractSpellDamageType(def) {
  const mods = Array.isArray(def.modifiers) ? def.modifiers : [];
  // Real DDB exports encode spell damage as { type: 'damage', subType:
  // 'radiant' }; older/synthetic shapes use subType 'radiant-damage'.
  const typed = mods.find(m => m.type === 'damage' && m.subType && !/damage$/i.test(m.subType));
  if (typed) return typed.subType.charAt(0).toUpperCase() + typed.subType.slice(1);
  const dmg = mods.find(m => /damage$/i.test(m.subType || ''));
  if (!dmg) return null;
  // SubType is like "fire-damage", "radiant-damage", etc.
  const m = String(dmg.subType || '').match(/^(.+)-damage$/);
  if (!m) return null;
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

function classifySpellKind(def) {
  if (def.requiresAttackRoll) return 'spell-attack';
  if (def.requiresSavingThrow) return 'spell-save';
  if (Array.isArray(def.healingDice) && def.healingDice.length) return 'heal';
  if (def.healing) return 'heal';
  // R14 — real DDB exports encode healing as a `bonus` / `hit-points`
  // modifier with a die (Healing Word 1d4). A die-less hit-points bonus
  // is a max-HP buff (Aid), not a heal.
  const mods = Array.isArray(def.modifiers) ? def.modifiers : [];
  if (mods.some(m => m?.type === 'bonus' && m?.subType === 'hit-points' && m?.die?.diceString)) return 'heal';
  return 'utility';
}

/**
 * M21 — Does this spell deal HALF damage on a successful save (the
 * common case for AoE damage spells) vs NO damage on save (most save-
 * based cantrips and control spells)? Heuristic on the description:
 * 5e canonical phrasing for half-damage spells is "half as much
 * damage on a successful one" or "half damage on a successful save".
 * If the spell isn't a save spell at all the question is moot.
 */
export function spellSaveDealsHalfOnSuccess(def) {
  if (!def?.requiresSavingThrow) return false;
  const desc = String(def.description || '').toLowerCase();
  if (/half as much damage on a successful/i.test(desc)) return true;
  if (/half damage on a successful/i.test(desc)) return true;
  return false;
}

/**
 * Pull the character's saving-throw proficiencies. D&DB encodes them as
 * `modifiers.class[]` (and sometimes feat/background) entries with
 * type='proficiency' and subType like 'wisdom-saving-throws'. Returns
 * a small array of stat keys (STR/DEX/CON/INT/WIS/CHA).
 */
export function parseSavingThrowProficiencies(raw) {
  const out = new Set();
  for (const m of collectAllModifiers(raw)) {
    if (m.type !== 'proficiency') continue;
    const match = String(m.subType || '').match(/^(strength|dexterity|constitution|intelligence|wisdom|charisma)-saving-throws$/);
    if (!match) continue;
    const stat = match[1].slice(0, 3).toUpperCase();
    out.add(stat === 'STR' ? 'STR'
          : stat === 'DEX' ? 'DEX'
          : stat === 'CON' ? 'CON'
          : stat === 'INT' ? 'INT'
          : stat === 'WIS' ? 'WIS'
          : stat === 'CHA' ? 'CHA' : '');
  }
  out.delete('');
  return [...out];
}

export function formatUses(limitedUse) {
  if (!limitedUse) return null;
  const max = Number(limitedUse.maxUses) || null;
  if (!max) return null;
  const reset = RESET_TYPE_LABEL[String(limitedUse.resetType || '').toLowerCase()] || null;
  return { max, reset };
}

/**
 * formatUses plus DDB's `numberUsed`: { max, used, reset } or null.
 * @param {object} limitedUse
 * @returns {{max: number, used: number, reset: string|null}|null}
 */
export function formatUsesWithUsed(limitedUse) {
  const base = formatUses(limitedUse);
  if (!base) return null;
  const used = Math.max(0, Math.min(base.max, Number(limitedUse.numberUsed) || 0));
  return { max: base.max, used, reset: base.reset };
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

// R14 — DDB condition ids (character `conditions[]` rows are
// { id, level }; level is set only for Exhaustion). Names are the
// engine's lowercase condition ids.
const DDB_CONDITION_IDS = {
  1: 'blinded', 2: 'charmed', 3: 'deafened', 4: 'exhaustion', 5: 'frightened',
  6: 'grappled', 7: 'incapacitated', 8: 'invisible', 9: 'paralyzed',
  10: 'petrified', 11: 'poisoned', 12: 'prone', 13: 'restrained',
  14: 'stunned', 15: 'unconscious'
};

/**
 * Current DDB conditions as [{ id, name, level }]. `id` is the engine's
 * lowercase condition id, `name` the display name, `level` the
 * exhaustion level (null for every other condition). Unknown ids are
 * dropped.
 * @param {object} raw
 * @returns {{id: string, name: string, level: number|null}[]}
 */
export function parseDdbConditions(raw) {
  const list = Array.isArray(raw.conditions) ? raw.conditions : [];
  const out = [];
  for (const c of list) {
    const id = DDB_CONDITION_IDS[Number(c?.id)];
    if (!id || out.some(o => o.id === id)) continue;
    const lvl = Number(c?.level);
    out.push({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      level: id === 'exhaustion' ? (lvl > 0 ? Math.min(6, lvl) : 1) : null
    });
  }
  return out;
}

/**
 * Used slot counts from DDB: { spell: {1..9: used}, pact: {1..5: used} }.
 * (DDB's `available` is 0 in real exports, so maximums come from
 * spellSlotTable instead.)
 * @param {object} raw
 * @returns {{spell: Object<string, number>, pact: Object<string, number>}}
 */
export function parseSlotsUsed(raw) {
  const read = (rows) => {
    const out = {};
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const lvl = Number(r?.level);
      if (!(lvl >= 1 && lvl <= 9)) continue;
      out[lvl] = Math.max(0, Number(r?.used) || 0);
    }
    return out;
  };
  return { spell: read(raw.spellSlots), pact: read(raw.pactMagic) };
}

// PHB multiclass spellcaster table (combined caster level → slots 1..9).
const MULTICLASS_SLOTS = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [2, 0, 0, 0, 0, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0, 0, 0, 0], [4, 2, 0, 0, 0, 0, 0, 0, 0],
  [4, 3, 0, 0, 0, 0, 0, 0, 0], [4, 3, 2, 0, 0, 0, 0, 0, 0], [4, 3, 3, 0, 0, 0, 0, 0, 0],
  [4, 3, 3, 1, 0, 0, 0, 0, 0], [4, 3, 3, 2, 0, 0, 0, 0, 0], [4, 3, 3, 3, 1, 0, 0, 0, 0],
  [4, 3, 3, 3, 2, 0, 0, 0, 0], [4, 3, 3, 3, 2, 1, 0, 0, 0], [4, 3, 3, 3, 2, 1, 0, 0, 0],
  [4, 3, 3, 3, 2, 1, 1, 0, 0], [4, 3, 3, 3, 2, 1, 1, 0, 0], [4, 3, 3, 3, 2, 1, 1, 1, 0],
  [4, 3, 3, 3, 2, 1, 1, 1, 0], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]
];

const slotRowToObject = (row) => {
  const out = {};
  for (let i = 0; i < 9; i++) {
    const n = Number(Array.isArray(row) ? row[i] : 0) || 0;
    if (n > 0) out[i + 1] = n;
  }
  return out;
};

/**
 * Spell-slot maximums from each class's DDB `spellRules.levelSpellSlots`
 * (indexed by class level, each row = slots of levels 1..9).
 *
 *   classes: [{ name, level, divisor, rounding, pact, slots }] — one per
 *            class with a non-empty slot table (base class or subclass)
 *   spell:   { [slotLevel]: max } — a single caster class uses its own
 *            row; several combine through the PHB multiclass table at
 *            sum(level / divisor) (rounded per DDB's rounding flag:
 *            2 = up, otherwise down)
 *   pact:    { level, max } | null — Warlock Pact Magic, kept apart
 *
 * NOTE: the Warlock row shape is unverified until a real Warlock export
 * lands; it is read as "slot count at the pact slot level".
 * @param {object} raw
 * @returns {{classes: object[], spell: Object<string, number>, pact: {level: number, max: number}|null}}
 */
export function parseSpellSlotTable(raw) {
  const classes = [];
  for (const cls of (Array.isArray(raw.classes) ? raw.classes : [])) {
    const level = Number(cls?.level) || 0;
    const name = cls?.definition?.name || 'Unknown';
    const rules = [cls?.definition?.spellRules, cls?.subclassDefinition?.spellRules]
      .find(r => Array.isArray(r?.levelSpellSlots) && r.levelSpellSlots.some(row => Array.isArray(row) && row.some(n => Number(n) > 0)));
    if (!rules) continue;
    const row = rules.levelSpellSlots[Math.min(level, rules.levelSpellSlots.length - 1)] || [];
    classes.push({
      name,
      level,
      divisor: Number(rules.multiClassSpellSlotDivisor) || 1,
      rounding: Number(rules.multiClassSpellSlotRounding) || 1,
      pact: /warlock/i.test(name),
      slots: slotRowToObject(row)
    });
  }
  const casters = classes.filter(c => !c.pact);
  let spell = {};
  if (casters.length === 1) {
    spell = { ...casters[0].slots };
  } else if (casters.length > 1) {
    let casterLevel = 0;
    for (const c of casters) {
      const share = c.level / c.divisor;
      casterLevel += c.rounding === 2 ? Math.ceil(share) : Math.floor(share);
    }
    spell = slotRowToObject(MULTICLASS_SLOTS[Math.max(0, Math.min(20, casterLevel))]);
  }
  const lock = classes.find(c => c.pact);
  let pact = null;
  if (lock) {
    const levels = Object.keys(lock.slots).map(Number);
    if (levels.length) {
      const top = Math.max(...levels);
      pact = { level: top, max: lock.slots[top] };
    }
  }
  return { classes, spell, pact };
}

/**
 * Every inventory row, equipped or not (potions, ammunition, charged
 * items). Charges are DDB's item `limitedUse`.
 * @param {object} raw
 * @returns {object[]}
 */
export function parseInventory(raw) {
  const list = Array.isArray(raw.inventory) ? raw.inventory : [];
  return list.filter(it => it?.definition).map(it => {
    const d = it.definition;
    return {
      name: d.name || 'Unknown item',
      quantity: Number.isFinite(Number(it.quantity)) ? Number(it.quantity) : 1,
      equipped: !!it.equipped,
      attuned: !!it.isAttuned,
      magical: !!d.magic,
      rarity: d.rarity || 'Common',
      filterType: d.filterType || null,
      type: d.type || null,
      subType: d.subType || null,
      consumable: !!d.isConsumable,
      uses: formatUsesWithUsed(it.limitedUse)
    };
  });
}

/**
 * Racial trait names (hidden bookkeeping traits like Speed and
 * Languages are skipped).
 * @param {object} raw
 * @returns {string[]}
 */
export function parseRacialTraits(raw) {
  const list = Array.isArray(raw.race?.racialTraits) ? raw.race.racialTraits : [];
  const out = [];
  for (const t of list) {
    const def = t?.definition;
    const name = String(def?.name || '').trim();
    if (!name || def.hideInSheet || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * Copy of a raw DDB character that is safe to store: drops
 * `campaign.characters[]` (other players' names, user ids and character
 * ids). Does not mutate the input. Call it on the raw JSON before
 * persisting it (api/app.js upsertCharacter `rawJson`).
 * @param {object} raw
 * @returns {object}
 */
export function scrubRawCharacter(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (!raw.campaign || typeof raw.campaign !== 'object' || !('characters' in raw.campaign)) return raw;
  const { characters: _others, ...campaign } = raw.campaign;
  return { ...raw, campaign };
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

// R6 — weapon rules data.
//
// DDB weapon definitions carry `properties[]` ({ id, name, notes }; the
// Versatile entry's `notes` is the two-handed die, e.g. "1d10"),
// `attackType` (1 melee / 2 ranged), `range` / `longRange` in feet
// (5/5 for melee), `isMonkWeapon`, `categoryId` (1 simple / 2 martial)
// and `grantedModifiers[]` where a +N weapon has
// { type: 'bonus', subType: 'magic', value: N }. Verified against a real
// export (Shortsword: Finesse|Light, Hand Crossbow: Range 30/120,
// Warhammer: Versatile notes "1d10").

const WEAPON_PROPERTY_NAMES = new Set([
  'finesse', 'light', 'heavy', 'thrown', 'versatile', 'two-handed',
  'reach', 'ammunition', 'loading', 'special'
]);

/** Field names parseWeaponFields may add to an equipment summary. */
const WEAPON_FIELD_KEYS = [
  'properties', 'attackType', 'range', 'longRange', 'isMonkWeapon',
  'magicBonus', 'versatileDamage', 'weaponCategory', 'weaponType'
];

function isWeaponDefinition(def) {
  return !!def && (def.filterType === 'Weapon' || def.type === 'Weapon' || def.attackType === 1 || def.attackType === 2);
}

/**
 * Normalise DDB weapon properties into a lowercase string list of the 5e
 * weapon properties (mastery tags like Vex / Push and DDB's internal
 * "Range" marker are dropped).
 * @param {Array<{name: string}>} props
 * @returns {string[]}
 */
export function normaliseWeaponProperties(props) {
  if (!Array.isArray(props)) return [];
  const out = [];
  for (const p of props) {
    const n = String(p?.name ?? p ?? '').trim().toLowerCase().replace(/\s+/g, '-');
    if (WEAPON_PROPERTY_NAMES.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Magic +N of a weapon from its grantedModifiers (bonus / magic). Returns
 * null when DDB lists no magic modifier, so the name heuristic can still
 * apply downstream; 0 when the bonus needs attunement the item lacks.
 */
function weaponMagicBonus(item) {
  const mods = Array.isArray(item?.definition?.grantedModifiers) ? item.definition.grantedModifiers : [];
  let found = false;
  let sum = 0;
  for (const m of mods) {
    if (m?.type !== 'bonus' || m?.subType !== 'magic') continue;
    found = true;
    if (m.requiresAttunement && !item.isAttuned) continue;
    const v = Number(m.value ?? m.fixedValue);
    if (Number.isFinite(v)) sum += v;
  }
  return found ? sum : null;
}

/** "Crossbow, Hand" → "crossbow-hand" (DDB proficiency-slug style). */
function weaponTypeSlug(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return null;
  return t.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

function parseWeaponFields(item) {
  const def = item?.definition;
  if (!isWeaponDefinition(def)) return {};
  const versatile = Array.isArray(def.properties)
    ? def.properties.find(p => String(p?.name || '').toLowerCase() === 'versatile')
    : null;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  return {
    properties: normaliseWeaponProperties(def.properties),
    attackType: def.attackType === 1 || def.attackType === 2 ? def.attackType : null,
    range: num(def.range),
    longRange: num(def.longRange),
    isMonkWeapon: !!def.isMonkWeapon,
    magicBonus: weaponMagicBonus(item),
    versatileDamage: versatile && typeof versatile.notes === 'string' && /^\d+d\d+$/.test(versatile.notes.trim())
      ? versatile.notes.trim() : null,
    weaponCategory: def.categoryId === 1 ? 'simple' : def.categoryId === 2 ? 'martial' : null,
    weaponType: weaponTypeSlug(def.type && def.type !== 'Weapon' ? def.type : def.name)
  };
}

function pickWeaponFields(entry) {
  const out = {};
  for (const k of WEAPON_FIELD_KEYS) if (entry[k] !== undefined) out[k] = entry[k];
  return out;
}

// R6 — weapon proficiencies. DDB lists them as `proficiency` modifiers:
// category rows ('simple-weapons', 'martial-weapons') and per-weapon rows
// named by the weapon's slug. Per-weapon rows are recognised by their
// entityTypeId (DDB's weapon entity type) or by the SRD weapon slug list.
const WEAPON_ENTITY_TYPE_ID = 1782728300;
const SRD_WEAPON_SLUGS = new Set([
  'club', 'dagger', 'greatclub', 'handaxe', 'javelin', 'light-hammer', 'mace',
  'quarterstaff', 'sickle', 'spear', 'crossbow-light', 'dart', 'shortbow', 'sling',
  'battleaxe', 'flail', 'glaive', 'greataxe', 'greatsword', 'halberd', 'lance',
  'longsword', 'maul', 'morningstar', 'pike', 'rapier', 'scimitar', 'shortsword',
  'trident', 'war-pick', 'warhammer', 'whip', 'blowgun', 'crossbow-hand',
  'crossbow-heavy', 'longbow', 'net',
  // plural / reversed spellings seen in class text
  'light-crossbows', 'hand-crossbows', 'heavy-crossbows', 'longswords', 'rapiers',
  'shortswords', 'daggers', 'darts', 'slings', 'quarterstaffs', 'light-crossbow',
  'hand-crossbow', 'heavy-crossbow', 'scimitars', 'shortbows', 'longbows',
  'handaxes', 'battleaxes', 'light-hammers', 'warhammers', 'clubs', 'maces',
  'sickles', 'spears', 'javelins'
]);

/**
 * Weapon proficiency slugs from every modifier bucket.
 * @param {object} raw — DDB character
 * @returns {string[]} e.g. ['simple-weapons', 'martial-weapons', 'crossbow-hand']
 */
export function parseWeaponProficiencies(raw) {
  const out = [];
  for (const m of collectAllModifiers(raw)) {
    if (m?.type !== 'proficiency') continue;
    const sub = String(m.subType || '');
    const isWeapon = sub === 'simple-weapons' || sub === 'martial-weapons'
      || m.entityTypeId === WEAPON_ENTITY_TYPE_ID || SRD_WEAPON_SLUGS.has(sub);
    if (isWeapon && !out.includes(sub)) out.push(sub);
  }
  return out;
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
      damageType: item.definition?.damageType ?? null,
      // R5 — DDB armor category: 1 light / 2 medium / 3 heavy / 4 shield.
      armorTypeId: item.definition?.armorTypeId ?? null,
      // R6 — weapon rules data (absent on non-weapons).
      ...parseWeaponFields(item)
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
