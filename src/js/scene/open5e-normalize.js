/**
 * M64 R11 — Open5e v2 creature payload → normalised stat block.
 *
 * Pure and dependency-free so the server (`api/lib/open5e.js` re-exports
 * it) and the browser share one implementation.
 *
 * Open5e's structured attack fields are unreliable: the Young Red
 * Dragon's Bite is listed as `2D10, damage_bonus null, type thunder`
 * while its SRD text reads "+10 to hit, reach 10 ft. ... 17 (2d10 + 6)
 * piercing damage plus 3 (1d6) fire damage". Every number here is
 * therefore parsed from the SRD `desc` text; the structured fields are a
 * fallback when the text does not parse and a cross-check otherwise
 * (disagreements land in `crossCheck[]` for the DM panel). Likewise
 * `legendary_action_cost: 1` appears on ordinary actions, so a cost is
 * only read for `action_type: 'LEGENDARY_ACTION'`.
 *
 * Shape (`source: 'srd-2014'` marks a normalised block):
 *   {slug, open5eSlug, name, size, type, cr, xp, pb, ac, acDetail,
 *    hp: {average, formula}, speedFt, speeds, abilities, saves, skills,
 *    resistances[], immunities[], vulnerabilities[], conditionImmunities[],
 *    nonmagicalOnly: {resistances[], immunities[]}, senses,
 *    actions: [Action], multiattack: [{action, count, kind?, limits?}]|null,
 *    multiattackText, legendary: {perRound, actions: [Action]}|null,
 *    legendaryResistance, spellcasting: {...}|null, traits: [{name, desc}],
 *    crossCheck: [{action, field, text, structured}], source}
 *
 * Action:
 *   {name, actionType: 'action'|'bonus'|'reaction'|'legendary',
 *    kind: 'melee'|'ranged'|'save'|'special', attackType: 'weapon'|'spell'|null,
 *    toHit, reachFt, rangeFt, longRangeFt,
 *    damage: [{dice, bonus, type, avg}],
 *    save: {stat, dc, half, damage: [...], condition}|null,
 *    condition, area: {shape, sizeFt}|null, recharge: {min}|null,
 *    usesPerDay, legendaryCost, desc, invokes?}
 *
 * `invokes` (legendary actions such as "Tail Attack: The dragon makes a
 * tail attack.") names the action it uses, or null when none matches.
 *
 * For melee/ranged actions `damage` is the hit damage and `save` an
 * on-hit rider (Giant Spider bite: CON 11, half, 2d8 poison). For `save`
 * actions `damage` is the save damage. Multiattack `action` is exactly an
 * `actions[].name`; `action: null` means "any weapon attack" (optionally
 * of `kind`, with per-name `limits`).
 */

/** Marks a stat block produced by `normalizeCreature`. */
export const OPEN5E_SOURCE = 'srd-2014';

const ABILITY_KEYS = [
  ['strength', 'STR'], ['dexterity', 'DEX'], ['constitution', 'CON'],
  ['intelligence', 'INT'], ['wisdom', 'WIS'], ['charisma', 'CHA']
];
const ABILITY_BY_WORD = Object.fromEntries(ABILITY_KEYS.map(([w, k]) => [w, k]));

/** The thirteen 5e damage types. */
export const DAMAGE_TYPES = Object.freeze([
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'
]);

/** The SRD conditions (plus exhaustion). */
export const CONDITION_NAMES = Object.freeze([
  'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
  'prone', 'restrained', 'stunned', 'unconscious'
]);

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, once: 1, two: 2, twice: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

const ACTION_TYPES = {
  ACTION: 'action', BONUS_ACTION: 'bonus', REACTION: 'reaction',
  LEGENDARY_ACTION: 'legendary'
};

// SRD 5.1 p.9 — XP by challenge rating (fallback when the payload has none).
const XP_BY_CR = {
  0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100,
  5: 1800, 6: 2300, 7: 2900, 8: 3900, 9: 5000, 10: 5900, 11: 7200,
  12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000,
  18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000,
  24: 62000, 25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000,
  30: 155000
};

/**
 * Proficiency bonus by challenge rating (SRD 5.1 p.8).
 * @param {number} cr
 * @returns {number}
 */
export function proficiencyForCr(cr) {
  const c = Number(cr) || 0;
  if (c < 5) return 2;
  return Math.min(9, 2 + Math.ceil((c - 4) / 4));
}

/**
 * Normalise one Open5e v2 creature payload.
 * @param {object|null} payload — `GET /v2/creatures/<key>/` body
 * @returns {object|null} normalised stat block, or null for a non-object
 */
export function normalizeCreature(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const c = payload;
  const key = String(c.key || c.slug || '');
  const cr = toNumber(c.challenge_rating ?? c.challenge_rating_decimal ?? c.cr, 0);
  const pb = Number.isFinite(Number(c.proficiency_bonus)) && c.proficiency_bonus !== null
    ? Number(c.proficiency_bonus) : proficiencyForCr(cr);
  const abilities = parseAbilities(c);
  const crossCheck = [];
  const defenses = parseDefenses(c.resistances_and_immunities || {});

  const rawActions = (Array.isArray(c.actions) ? c.actions : [])
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (toNumber(x.a.order_in_statblock, x.i) - toNumber(y.a.order_in_statblock, y.i)) || x.i - y.i)
    .map(x => x.a);

  const actions = [];
  const legendaryActions = [];
  let multiattackText = null;
  for (const raw of rawActions) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    if (/^multiattack$/i.test(name)) { multiattackText = String(raw.desc || '').trim(); continue; }
    const action = parseAction(raw, crossCheck);
    if (action.actionType === 'legendary') legendaryActions.push(action);
    else actions.push(action);
  }

  for (const la of legendaryActions) {
    if (la.invokes === undefined) continue;
    la.invokes = matchAction(la.invokes, actions);
  }

  const traits = (Array.isArray(c.traits) ? c.traits : [])
    .filter(t => t && t.name)
    .map(t => ({ name: String(t.name), desc: String(t.desc || '') }));
  const lrTrait = traits.find(t => /^legendary resistance/i.test(t.name));
  const lrMatch = lrTrait && /\((\d+)\s*\/\s*day\)/i.exec(lrTrait.name);

  const hpAverage = Math.trunc(toNumber(c.hit_points ?? c.hp, 0));
  return {
    slug: key.replace(/^srd[_-]/, ''),
    open5eSlug: key,
    name: String(c.name || 'Unknown').slice(0, 128),
    size: lowerName(c.size),
    type: lowerName(c.type),
    cr,
    xp: Number.isFinite(Number(c.experience_points)) && c.experience_points !== null
      ? Number(c.experience_points) : (XP_BY_CR[cr] ?? 0),
    pb,
    ac: Math.trunc(toNumber(c.armor_class ?? c.ac, 10)),
    acDetail: c.armor_detail ? String(c.armor_detail) : null,
    hp: { average: hpAverage, formula: c.hit_dice ? String(c.hit_dice).replace(/\s+/g, '') : null },
    speedFt: Math.trunc(toNumber(c.speed?.walk, 30)),
    speeds: parseSpeeds(c.speed),
    abilities,
    saves: parseSaves(c, abilities),
    skills: parseSkills(c.skill_bonuses),
    resistances: defenses.resistances,
    immunities: defenses.immunities,
    vulnerabilities: defenses.vulnerabilities,
    conditionImmunities: defenses.conditionImmunities,
    nonmagicalOnly: defenses.nonmagicalOnly,
    senses: {
      darkvisionFt: rangeOrNull(c.darkvision_range),
      blindsightFt: rangeOrNull(c.blindsight_range),
      tremorsenseFt: rangeOrNull(c.tremorsense_range),
      truesightFt: rangeOrNull(c.truesight_range),
      passivePerception: Number.isFinite(Number(c.passive_perception)) ? Number(c.passive_perception) : null
    },
    actions,
    multiattack: multiattackText ? parseMultiattack(multiattackText, actions) : null,
    multiattackText,
    legendary: legendaryActions.length ? { perRound: 3, actions: legendaryActions } : null,
    legendaryResistance: lrMatch ? Number(lrMatch[1]) : 0,
    spellcasting: parseSpellcasting(traits),
    traits,
    crossCheck,
    source: OPEN5E_SOURCE
  };
}

/**
 * Engine attack records (`{name, bonus, dice, damageType, ...}`, the
 * MONSTER_PRESETS `attack` shape) for a normalised stat block's weapon
 * actions: melee first, then ranged, stat-block order within each.
 * Actions without a to-hit or without damage dice are skipped.
 * @param {object} statBlock — from `normalizeCreature`
 * @returns {object[]}
 */
export function engineAttacksFrom(statBlock) {
  const actions = Array.isArray(statBlock?.actions) ? statBlock.actions : [];
  const weapon = actions.filter(a => a && a.actionType === 'action'
    && (a.kind === 'melee' || a.kind === 'ranged')
    && Number.isFinite(a.toHit) && (a.damage || []).some(d => d.dice));
  const ordered = [...weapon.filter(a => a.kind === 'melee'), ...weapon.filter(a => a.kind === 'ranged')];
  return ordered.map(a => ({
    name: a.name,
    bonus: a.toHit,
    dice: diceString(a.damage),
    damageType: a.damage[0]?.type ?? null,
    damageParts: a.damage.map(d => ({ dice: d.dice, bonus: d.bonus, type: d.type })),
    reachFt: a.reachFt,
    rangeFt: a.rangeFt,
    longRangeFt: a.longRangeFt
  }));
}

/**
 * True when `sb` came out of `normalizeCreature`.
 * @param {object|null} sb
 * @returns {boolean}
 */
export function isNormalizedStatBlock(sb) {
  return !!sb && typeof sb === 'object' && sb.source === OPEN5E_SOURCE;
}

/**
 * Fill the engine-facing fields (`hpMax`, `attacks`) of a normalised stat
 * block when the caller has not set them. Non-normalised blocks are
 * returned unchanged. Pure: returns a new object.
 * @param {object} sb
 * @returns {object}
 */
export function withEngineFields(sb) {
  if (!isNormalizedStatBlock(sb)) return sb;
  const out = { ...sb };
  if (out.hpMax === undefined && Number.isInteger(sb.hp?.average) && sb.hp.average > 0) out.hpMax = sb.hp.average;
  if (out.attacks === undefined) {
    const attacks = engineAttacksFrom(sb);
    if (attacks.length) out.attacks = attacks;
  }
  return out;
}

// ---------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------

function toNumber(v, fallback) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
}

function rangeOrNull(v) {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) && n > 0 ? n : null;
}

function lowerName(v) {
  if (v && typeof v === 'object') return String(v.key || v.name || '').toLowerCase() || null;
  return typeof v === 'string' && v ? v.toLowerCase() : null;
}

function parseAbilities(c) {
  const scores = c.ability_scores || {};
  const out = {};
  for (const [word, k] of ABILITY_KEYS) {
    out[k] = Math.trunc(toNumber(scores[word] ?? c[word], 10));
  }
  return out;
}

function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function parseSaves(c, abilities) {
  const all = c.saving_throws_all || {};
  const prof = c.saving_throws || {};
  const out = {};
  for (const [word, k] of ABILITY_KEYS) {
    out[k] = Math.trunc(toNumber(prof[word] ?? all[word], abilityMod(abilities[k])));
  }
  return out;
}

function parseSkills(skills) {
  const out = {};
  if (!skills || typeof skills !== 'object') return out;
  for (const [k, v] of Object.entries(skills)) {
    if (Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
}

function parseSpeeds(speed) {
  const out = {};
  if (!speed || typeof speed !== 'object') return out;
  for (const k of ['walk', 'fly', 'swim', 'climb', 'burrow']) {
    const n = Number(speed[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  if (speed.hover) out.hover = true;
  return out;
}

function keysOf(list) {
  return (Array.isArray(list) ? list : [])
    .map(x => (typeof x === 'string' ? x : (x?.key || x?.name || '')).toLowerCase().trim())
    .filter(Boolean);
}

function wordsIn(text, vocabulary) {
  const t = String(text || '').toLowerCase();
  return vocabulary.filter(w => new RegExp(`\\b${w}\\b`).test(t));
}

/**
 * R/I/V + condition immunities. The structured lists and the SRD display
 * text are unioned; a display group mentioning "nonmagical" also lists its
 * types under `nonmagicalOnly` (the engine does not yet model magic
 * weapons, so they still count as resisted).
 */
function parseDefenses(ri) {
  const out = { nonmagicalOnly: { resistances: [], immunities: [] } };
  for (const [field, struct, display] of [
    ['resistances', 'damage_resistances', 'damage_resistances_display'],
    ['immunities', 'damage_immunities', 'damage_immunities_display'],
    ['vulnerabilities', 'damage_vulnerabilities', 'damage_vulnerabilities_display']
  ]) {
    const set = new Set(keysOf(ri[struct]).filter(k => DAMAGE_TYPES.includes(k)));
    for (const group of String(ri[display] || '').split(';')) {
      const types = wordsIn(group, DAMAGE_TYPES);
      for (const t of types) set.add(t);
      if (/nonmagical/i.test(group) && out.nonmagicalOnly[field]) {
        for (const t of types) if (!out.nonmagicalOnly[field].includes(t)) out.nonmagicalOnly[field].push(t);
      }
    }
    out[field] = [...set].sort();
  }
  const cond = new Set(keysOf(ri.condition_immunities).filter(k => CONDITION_NAMES.includes(k)));
  for (const w of wordsIn(ri.condition_immunities_display, CONDITION_NAMES)) cond.add(w);
  out.conditionImmunities = [...cond].sort();
  out.nonmagicalOnly.resistances.sort();
  out.nonmagicalOnly.immunities.sort();
  return out;
}

const DAMAGE_RE = /(\d+)\s*\(\s*(\d+)d(\d+)\s*(?:([+-])\s*(\d+))?\s*\)\s*([a-z]+)\s+damage/gi;
const FLAT_DAMAGE_RE = /(?:^|\s)(\d+)\s+([a-z]+)\s+damage/gi;

/** Every "N (XdY + Z) type damage" in `text`, in order. */
function parseDamageList(text) {
  const out = [];
  const t = String(text || '');
  DAMAGE_RE.lastIndex = 0;
  let m;
  while ((m = DAMAGE_RE.exec(t)) !== null) {
    const type = m[6].toLowerCase();
    if (!DAMAGE_TYPES.includes(type)) continue;
    const bonus = m[5] ? (m[4] === '-' ? -1 : 1) * Number(m[5]) : 0;
    out.push({ dice: `${m[2]}d${m[3]}`, bonus, type, avg: Number(m[1]) });
  }
  if (out.length) return out;
  FLAT_DAMAGE_RE.lastIndex = 0;
  while ((m = FLAT_DAMAGE_RE.exec(t)) !== null) {
    const type = m[2].toLowerCase();
    if (DAMAGE_TYPES.includes(type)) out.push({ dice: null, bonus: Number(m[1]), type, avg: Number(m[1]) });
  }
  return out;
}

/** A dice expression for the engine ('2d10+6+1d6'); flat parts fold into the bonus. */
function diceString(damage) {
  let dice = '';
  let flat = 0;
  for (const d of damage || []) {
    if (d.dice) dice += (dice ? '+' : '') + d.dice;
    flat += Number(d.bonus) || 0;
  }
  if (!dice) return null;
  if (flat > 0) return `${dice}+${flat}`;
  if (flat < 0) return `${dice}${flat}`;
  return dice;
}

function conditionIn(text) {
  const t = String(text || '').toLowerCase();
  const m = /\b(?:be|become|becomes|is|are|knocked|knock it|knocks it)\s+(?:knocked\s+)?([a-z]+)/g;
  let hit;
  while ((hit = m.exec(t)) !== null) {
    if (CONDITION_NAMES.includes(hit[1])) return hit[1];
  }
  return null;
}

const SAVE_RE = /DC\s*(\d+)\s+(strength|dexterity|constitution|intelligence|wisdom|charisma)\s+saving throw/i;

function parseSave(text) {
  const m = SAVE_RE.exec(String(text || ''));
  if (!m) return null;
  // Only the sentence carrying the save: the Giant Spider's later "is
  // paralyzed while poisoned in this way" is conditional, not the rider.
  const rest = String(text).slice(m.index);
  const end = rest.search(/\.(?:\s+(?=[A-Z])|\s*$)/);
  const after = end < 0 ? rest : rest.slice(0, end);
  return {
    stat: ABILITY_BY_WORD[m[2].toLowerCase()],
    dc: Number(m[1]),
    half: /half as much damage/i.test(after),
    damage: parseDamageList(after),
    condition: conditionIn(after)
  };
}

function parseArea(text) {
  const t = String(text || '');
  const shaped = /(\d+)-foot[- ](cone|line|cube|sphere|cylinder|radius)/i.exec(t);
  if (shaped) return { shape: shaped[2].toLowerCase(), sizeFt: Number(shaped[1]) };
  const within = /each creature within (\d+) (?:ft\.|feet) of/i.exec(t);
  if (within) return { shape: 'radius', sizeFt: Number(within[1]) };
  return null;
}

function parseRecharge(name, usage) {
  const m = /\(recharge\s+(\d)(?:\s*[-–—]\s*\d)?\)/i.exec(name);
  if (m) return { min: Number(m[1]) };
  if (usage?.type === 'RECHARGE_ON_ROLL' && Number(usage.param) >= 2) return { min: Number(usage.param) };
  return null;
}

function parseUsesPerDay(name, usage) {
  const m = /\((\d+)\s*\/\s*day\)/i.exec(name);
  if (m) return Number(m[1]);
  if (usage?.type === 'PER_DAY' && Number(usage.param) > 0) return Number(usage.param);
  return null;
}

function cleanName(name) {
  return String(name || '').replace(/\s*\((?:recharge[^)]*|costs?\s+\d+\s+actions?|\d+\s*\/\s*day[^)]*)\)\s*/gi, ' ').trim();
}

/** Everything after "Hit:" (`all`) and its first sentence (`first`). */
function hitClause(desc) {
  const i = desc.search(/\bHit:\s*/);
  if (i < 0) return { all: '', first: '' };
  const all = desc.slice(i).replace(/^Hit:\s*/, '');
  const end = all.search(/\.(?:\s+(?=[A-Z])|\s*$)/);
  return { all, first: end < 0 ? all : all.slice(0, end) };
}

function parseAction(raw, crossCheck) {
  const rawName = String(raw.name || '').trim();
  const name = cleanName(rawName) || rawName;
  const desc = String(raw.desc || '').trim();
  const actionType = ACTION_TYPES[raw.action_type] || 'action';
  const struct = Array.isArray(raw.attacks) && raw.attacks[0] ? raw.attacks[0] : null;
  const action = {
    name,
    actionType,
    kind: 'special',
    attackType: null,
    toHit: null,
    reachFt: null,
    rangeFt: null,
    longRangeFt: null,
    damage: [],
    save: null,
    condition: null,
    area: null,
    recharge: parseRecharge(rawName, raw.usage_limits),
    usesPerDay: parseUsesPerDay(rawName, raw.usage_limits),
    legendaryCost: null,
    desc
  };
  if (actionType === 'legendary') {
    const cost = /\(costs?\s+(\d+)\s+actions?\)/i.exec(rawName);
    action.legendaryCost = cost ? Number(cost[1]) : Math.max(1, Math.trunc(toNumber(raw.legendary_action_cost, 1)));
  }

  const atk = /\b(melee or ranged|melee|ranged)\s+(weapon|spell)\s+attack:\s*([+-]\s*\d+)\s+to hit/i.exec(desc);
  if (atk) {
    const mode = atk[1].toLowerCase();
    action.kind = mode === 'ranged' ? 'ranged' : 'melee';
    action.attackType = atk[2].toLowerCase();
    action.toHit = Number(atk[3].replace(/\s+/g, ''));
    const reach = /reach\s+(\d+)\s*ft/i.exec(desc);
    const range = /range\s+(\d+)(?:\s*\/\s*(\d+))?\s*ft/i.exec(desc);
    if (reach) action.reachFt = Number(reach[1]);
    if (range) {
      action.rangeFt = Number(range[1]);
      action.longRangeFt = range[2] ? Number(range[2]) : null;
    }
    if (action.kind === 'melee' && action.reachFt === null) action.reachFt = 5;

    // The hit damage is the first sentence up to any save rider; a rider
    // may sit in that sentence (Giant Spider) or a later one (Dire Wolf:
    // "If the target is a creature, it must succeed on a DC 13 ...").
    const hit = hitClause(desc);
    const riderAt = hit.first.search(/\b(?:the target|it|the creature)?\s*must\s+(?:make|succeed)/i);
    let primary = riderAt >= 0 ? hit.first.slice(0, riderAt) : hit.first;
    // "... in melee or 5 (1d6 + 2) piercing damage at range" / "... or 6
    // (1d10 + 1) slashing damage if used with two hands": keep the first.
    const alt = primary.search(/,?\s+or\s+\d+\s*\(/i);
    if (alt >= 0) primary = primary.slice(0, alt);
    action.damage = parseDamageList(primary);
    action.save = parseSave(hit.all);
    if (!action.save) action.condition = conditionIn(primary);
    crossCheckAttack(action, struct, crossCheck);
  } else {
    const save = parseSave(desc);
    if (save) {
      action.kind = 'save';
      action.save = save;
      action.damage = save.damage;
      action.area = parseArea(desc);
    } else if (/\bmakes (?:a|one) ([a-z' -]+?) attack\b/i.test(desc)) {
      // Legendary "Tail Attack: The dragon makes a tail attack." — the
      // name of the action it invokes is resolved by `normalizeCreature`.
      action.invokes = /\bmakes (?:a|one) ([a-z' -]+?) attack\b/i.exec(desc)[1];
    } else if (struct && Number.isFinite(Number(struct.to_hit_mod))) {
      // Text did not parse; fall back to the structured attack.
      fromStructured(action, struct);
      crossCheck.push({ action: name, field: 'desc', text: null, structured: 'used structured attack fields' });
    }
  }
  return action;
}

function structuredDamage(struct) {
  const out = [];
  const main = struct.damage_die_count && struct.damage_die_type
    ? `${Number(struct.damage_die_count)}${String(struct.damage_die_type).toLowerCase()}` : null;
  const mainType = lowerName(struct.damage_type);
  if (main || struct.damage_bonus) out.push({ dice: main, bonus: Number(struct.damage_bonus) || 0, type: mainType, avg: null });
  const extra = struct.extra_damage_die_count && struct.extra_damage_die_type
    ? `${Number(struct.extra_damage_die_count)}${String(struct.extra_damage_die_type).toLowerCase()}` : null;
  if (extra) out.push({ dice: extra, bonus: Number(struct.extra_damage_bonus) || 0, type: lowerName(struct.extra_damage_type), avg: null });
  return out;
}

function fromStructured(action, struct) {
  action.kind = struct.range && !struct.reach ? 'ranged' : 'melee';
  action.attackType = String(struct.attack_type || 'weapon').toLowerCase();
  action.toHit = Number(struct.to_hit_mod);
  action.reachFt = rangeOrNull(struct.reach) ?? (action.kind === 'melee' ? 5 : null);
  action.rangeFt = rangeOrNull(struct.range);
  action.longRangeFt = rangeOrNull(struct.long_range);
  action.damage = structuredDamage(struct);
}

function crossCheckAttack(action, struct, crossCheck) {
  if (!struct) return;
  const note = (field, text, structured) => {
    if (text !== structured) crossCheck.push({ action: action.name, field, text, structured });
  };
  if (struct.to_hit_mod !== null && struct.to_hit_mod !== undefined) note('toHit', action.toHit, Number(struct.to_hit_mod));
  if (action.reachFt !== null && rangeOrNull(struct.reach) !== null) note('reachFt', action.reachFt, Number(struct.reach));
  const sd = structuredDamage(struct);
  const td = action.damage;
  if (td[0] && sd[0]) {
    note('damage[0].dice', td[0].dice, sd[0].dice);
    // A null structured bonus is "not recorded", not 0.
    if (struct.damage_bonus !== null && struct.damage_bonus !== undefined) note('damage[0].bonus', td[0].bonus, sd[0].bonus);
    note('damage[0].type', td[0].type, sd[0].type);
  }
  if (td.length !== sd.length) note('damage.length', td.length, sd.length);
}

// ---------------------------------------------------------------------
// Multiattack
// ---------------------------------------------------------------------

function stem(word) {
  return String(word || '').toLowerCase().replace(/\s+attacks?$/, '').replace(/(?:es|s)$/, '').trim();
}

/** The action whose name matches a multiattack phrase ("claws" → "Claw"). */
function matchAction(phrase, actions) {
  const p = stem(phrase.replace(/^(?:its|his|her|their|the)\s+/i, ''));
  if (!p) return null;
  const exact = actions.find(a => stem(a.name) === p);
  if (exact) return exact.name;
  const loose = actions.find(a => stem(a.name).includes(p) || p.includes(stem(a.name)));
  return loose ? loose.name : null;
}

function countWord(w) {
  const k = String(w || '').toLowerCase();
  return NUMBER_WORDS[k] ?? (Number.isFinite(Number(k)) ? Number(k) : null);
}

/**
 * Parse an SRD Multiattack sentence into `[{action, count, kind?, limits?}]`.
 * Returns null when nothing in it parses.
 * @param {string} text
 * @param {object[]} actions — normalised actions (names to match)
 * @returns {object[]|null}
 */
export function parseMultiattack(text, actions = []) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const out = [];
  // "The dragon can use its Frightful Presence. It then makes ..."
  const use = /\buse its ([a-z' -]+?)(?:\.|,| and | then )/i.exec(t);
  if (use) {
    const name = matchAction(use[1], actions);
    if (name) out.push({ action: name, count: 1 });
  }
  const makes = /\bmakes (\w+) (?:(melee|ranged) )?(?:([a-z]+) )?attacks?\b([^.]*)/i.exec(t);
  if (!makes) return out.length ? out : null;
  const total = countWord(makes[1]);
  const kind = makes[2] ? makes[2].toLowerCase() : null;
  const named = makes[3] ? matchAction(makes[3], actions) : null;
  const tail = makes[4] || '';

  // ": one with its bite and two with its claws"
  const colon = /:\s*(.+)$/.exec(tail);
  if (colon) {
    const parts = colon[1].split(/,\s*(?:and\s+)?|\s+and\s+/i);
    const listed = [];
    for (const part of parts) {
      const m = /^(\w+)\s+(?:with|using)\s+(?:its|his|her|their)?\s*(.+?)$/i.exec(part.trim());
      if (!m) continue;
      const count = countWord(m[1]);
      const name = matchAction(m[2], actions);
      if (count && name) listed.push({ action: name, count });
    }
    if (listed.length) return [...out, ...listed];
  }
  if (!total) return out.length ? out : null;
  // "makes two attacks with its claws"
  const withIts = /\bwith its ([a-z' -]+?)(?:\.|,|$)/i.exec(tail);
  const withName = withIts ? matchAction(withIts[1], actions) : null;
  if (named || withName) return [...out, { action: named || withName, count: total }];
  // "makes two attacks, only one of which can be a bite attack"
  const entry = { action: null, count: total };
  if (kind) entry.kind = kind;
  const limit = /only one of which can be (?:a|an|its) ([a-z' -]+?)(?: attack)?(?:\.|,|$)/i.exec(tail);
  if (limit) {
    const name = matchAction(limit[1], actions);
    if (name) entry.limits = { [name]: 1 };
  }
  return [...out, entry];
}

// ---------------------------------------------------------------------
// Spellcasting
// ---------------------------------------------------------------------

function splitSpellList(s) {
  return String(s || '')
    .split(',')
    .map(x => x.replace(/[*_]/g, '').replace(/\(.*?\)/g, '').trim())
    .filter(Boolean);
}

/**
 * The Spellcasting / Innate Spellcasting traits as
 * `{dc, toHit, ability, casterLevel, slots: {level: count}, spells: [{name, level, perDay?}], innate}`.
 */
function parseSpellcasting(traits) {
  const t = traits.find(x => /^spellcasting\b/i.test(x.name)) || traits.find(x => /spellcasting/i.test(x.name));
  if (!t) return null;
  const d = t.desc;
  const dc = /spell save DC (\d+)/i.exec(d);
  const hit = /([+-]\d+) to hit with spell attacks/i.exec(d);
  const ability = /(?:spell ?casting ability is|ability is) (strength|dexterity|constitution|intelligence|wisdom|charisma)/i.exec(d);
  const level = /(\d+)(?:st|nd|rd|th)-level spellcaster/i.exec(d);
  const out = {
    dc: dc ? Number(dc[1]) : null,
    toHit: hit ? Number(hit[1]) : null,
    ability: ability ? ABILITY_BY_WORD[ability[1].toLowerCase()] : null,
    casterLevel: level ? Number(level[1]) : null,
    innate: /innate/i.test(t.name),
    slots: {},
    spells: []
  };
  for (const line of d.split(/\n+/)) {
    const l = line.replace(/^\s*[*-]\s*/, '').trim();
    let m;
    if ((m = /^cantrips? \(at will\):\s*(.+)$/i.exec(l))) {
      for (const name of splitSpellList(m[1])) out.spells.push({ name, level: 0 });
    } else if ((m = /^(\d+)(?:st|nd|rd|th) level \((\d+) slots?\):\s*(.+)$/i.exec(l))) {
      out.slots[m[1]] = Number(m[2]);
      for (const name of splitSpellList(m[3])) out.spells.push({ name, level: Number(m[1]) });
    } else if ((m = /^at will:\s*(.+)$/i.exec(l))) {
      for (const name of splitSpellList(m[1])) out.spells.push({ name, level: null, perDay: null });
    } else if ((m = /^(\d+)\s*\/\s*day(?: each)?:\s*(.+)$/i.exec(l))) {
      for (const name of splitSpellList(m[2])) out.spells.push({ name, level: null, perDay: Number(m[1]) });
    }
  }
  return out;
}
