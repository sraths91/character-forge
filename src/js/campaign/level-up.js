/**
 * M65 R26 — level-up between nodes.
 *
 * planLevelUp splits one level into
 *   auto      — applied without asking: HP (fixed average or a roll) + CON,
 *               one more hit die, proficiency bonus from total level, slots
 *               from the class's levelSpellSlots row (multiclass divisor),
 *               ladder features at their requiredLevel, levelScales dice;
 *   choices   — the player picks, the DM confirms: an ASI (+2 or +1/+1,
 *               cap 20), SRD spells within the known / prepared maxima,
 *               which existing class gains the level;
 *   reconcile — what only a DDB re-import can supply (subclass, feats in
 *               place of an ASI, invocations, non-SRD spells, a new class).
 * applyLevelUp records every sheet patch with its `before` value in
 * `granted`, so revertLevelUp restores the sheet byte for byte.
 * reconcileDiff compares the run sheet to a fresh DDB parse
 * (diffCharacters) and refuses when DDB is ahead of the granted level;
 * applyReconcile copies only accepted structural changes (never XP, HP,
 * resources, inventory or currency).
 *
 * Pure module (Node + browser): no DOM, no `node:` imports, no
 * Math.random — a rolled HP gain draws from the injected run rng.
 */

import { rollDice } from '../scene/combat-roll.js';
import { requireRng } from '../scene/rng.js';
import { proficiencyBonus } from '../scene/pc-stats.js';
import { diffCharacters } from '../character/diff-character.js';
import { casterClassEntry, combineSpellSlots, slotRowToObject } from './spell-slots.js';
import { CampaignRuleError, ruleAssert } from './errors.js';
import { clone, abilityMod, sheetLevel, hitDieOf } from './util.js';
import { MAX_LEVEL } from './xp.js';

/** HP-on-level modes (`settings.hpOnLevel`; the shared contract's list). */
export { HP_ON_LEVEL_MODES } from '../shared/campaign.js';

/** Ability score cap for an ASI. */
export const ASI_CAP = 20;

const STATS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

/** Prepared casters (prepare from the class list) and their prepared-count formula. */
const PREPARED_CASTERS = {
  cleric: { ability: 'WIS', half: false },
  druid: { ability: 'WIS', half: false },
  wizard: { ability: 'INT', half: false },
  paladin: { ability: 'CHA', half: true },
  artificer: { ability: 'INT', half: true }
};

/** Wizards add two spells to their spellbook per wizard level (SRD p.114). */
const WIZARD_SPELLBOOK_PER_LEVEL = 2;

/** Ladder feature names that mean "choose your subclass now". */
const SUBCLASS_CHOICE_RE = /\b(archetype|domain|tradition|oath|circle|college|path|patron|origin|conclave|subclass)\b/i;

/** SRD 5.1 Barbarian rages per long rest (20 = unlimited, stored as 99). */
function rageUses(level) {
  if (level >= 20) return 99;
  if (level >= 17) return 6;
  if (level >= 12) return 5;
  if (level >= 6) return 4;
  if (level >= 3) return 3;
  return 2;
}

/** Feature-use maxima the SRD class tables fix by class level (parser fallbacks). */
const SRD_USE_TABLES = {
  rage: { className: /barbarian/i, max: rageUses },
  'action-surge': { className: /fighter/i, max: (lv) => (lv >= 17 ? 2 : 1) }
};

const featureSlug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Fixed-average HP for a hit die (SRD: d6 → 4, d8 → 5, d10 → 6, d12 → 7).
 * @param {number} die
 * @returns {number}
 */
export function averageHitDieGain(die) {
  return Math.floor(Number(die) / 2) + 1;
}

/**
 * A class's level on the sheet (0 when absent).
 * @param {object} sheet
 * @param {string} className
 * @returns {number}
 */
export function classLevelOf(sheet, className) {
  const c = (sheet?.classes || []).find(x => x?.name === className);
  return c ? Number(c.level) || 0 : 0;
}

/** Highest slot level a class's own row grants at `level` (0 = none). */
function maxSpellLevelFor(prog, level) {
  if (!prog?.levelSpellSlots) return 0;
  const row = prog.levelSpellSlots[Math.min(level, prog.levelSpellSlots.length - 1)] || [];
  const keys = Object.keys(slotRowToObject(row)).map(Number);
  return keys.length ? Math.max(...keys) : 0;
}

/** Number of prepared spells (class formula), or null for non-prepared casters. */
function preparedCount(sheet, prog, className, level, abilityScores) {
  const fromTable = prog?.preparedMaxes?.[level];
  if (Number.isFinite(fromTable) && fromTable > 0) return fromTable;
  const rule = PREPARED_CASTERS[String(className).toLowerCase()];
  if (!rule) return null;
  const mod = abilityMod((abilityScores || sheet?.abilityScores || {})[prog?.spellcastingAbility || rule.ability]);
  const lv = rule.half ? Math.floor(level / 2) : level;
  if (lv <= 0) return 0;
  return Math.max(1, mod + lv);
}

/** Spell-choice allowance for one class level step. */
function spellAllowance(sheet, prog, className, fromLv, toLv) {
  if (!prog) return null;
  const maxSpellLevel = maxSpellLevelFor(prog, toLv);
  const diff = (arr) => (Array.isArray(arr) && Number.isFinite(arr[toLv]) && Number.isFinite(arr[fromLv])
    ? Math.max(0, arr[toLv] - arr[fromLv]) : 0);
  const cantrips = diff(prog.cantripMaxes);
  let known = diff(prog.knownMaxes);
  if (!known && /wizard/i.test(className) && maxSpellLevel > 0) known = WIZARD_SPELLBOOK_PER_LEVEL;
  let prepared = 0;
  if (!/wizard/i.test(className)) {
    const a = preparedCount(sheet, prog, className, fromLv);
    const b = preparedCount(sheet, prog, className, toLv);
    if (a !== null && b !== null) prepared = Math.max(0, b - a);
  }
  if (!cantrips && !known && !prepared) return null;
  return { className, cantrips, known, prepared, maxSpellLevel };
}

/** Uses at `level` from a definition's byLevel table (null when it has no usable levels). */
function usesAtLevel(limitedUse, level) {
  if (!limitedUse) return null;
  if (Number.isFinite(limitedUse.max)) return limitedUse.max;
  const rows = (limitedUse.byLevel || []).filter(r => Number.isFinite(r.level) && r.level <= level);
  if (!rows.length) return null;
  return rows.reduce((best, r) => (r.level >= best.level ? r : best)).uses;
}

/** The levelScales row in effect at `level`. */
function scaleAt(scales, level) {
  let hit = null;
  for (const s of (scales || [])) if (s.level <= level) hit = s;
  return hit;
}

/** Recompute the sheet's slot table with `className` at `classLevel`. */
function slotTableWith(sheet, className, classLevel) {
  const classes = [];
  const missing = [];
  for (const c of (sheet?.classes || [])) {
    const lv = c.name === className ? classLevel : Number(c.level) || 0;
    const prog = sheet?.progression?.[c.name];
    if (prog?.levelSpellSlots) {
      classes.push(casterClassEntry({ name: c.name, level: lv, rows: prog.levelSpellSlots, divisor: prog.spellSlotDivisor, rounding: prog.spellSlotRounding }));
    } else if ((sheet?.spellSlotTable?.classes || []).some(x => x.name === c.name)) {
      missing.push(c.name);
    }
  }
  const { spell, pact } = combineSpellSlots(classes);
  return { table: { classes, spell, pact }, missing };
}

/**
 * Plan one level (toLevel must be the sheet's level + 1).
 *
 * @param {object} sheet — run sheet (parseCharacter shape with R23 `progression`)
 * @param {object} state — state_json v1
 * @param {{toLevel?: number, className?: string, settings?: {hpOnLevel?: 'average'|'roll'}}} [opts]
 * @returns {{request: object, fromLevel: number, toLevel: number, className: string|null,
 *   classLevelFrom: number|null, classLevelTo: number|null, auto: object|null,
 *   choices: {className: {options: string[]}|null, asi: object|null, spells: object|null},
 *   reconcile: {kind: string, reason: string}[], missing: string[], requiresDm: boolean}}
 * @throws {CampaignRuleError} bad-level | max-level | unknown-class
 */
export function planLevelUp(sheet, state, { toLevel, className, settings = {} } = {}) {
  const fromLevel = sheetLevel(sheet);
  const target = toLevel === undefined ? fromLevel + 1 : Math.trunc(Number(toLevel));
  ruleAssert(fromLevel < MAX_LEVEL, 'max-level', `Already level ${MAX_LEVEL}.`);
  ruleAssert(target === fromLevel + 1, 'bad-level', `Level up one level at a time (sheet level ${fromLevel}, asked for ${toLevel}).`,
    { fromLevel, toLevel: target });
  const hpMode = settings.hpOnLevel === 'roll' ? 'roll' : 'average';
  const classNames = (sheet?.classes || []).map(c => c.name).filter(Boolean);
  const request = { toLevel: target, className: className ?? null, settings: { ...settings } };
  const choices = { className: null, asi: null, spells: null };
  const reconcile = [];
  const missing = [];

  let cls = className ?? null;
  if (cls != null) {
    ruleAssert(classNames.includes(cls), 'unknown-class',
      `${cls} is not on this sheet; a new class goes through a DDB re-import (reconcile).`, { className: cls, options: classNames });
  } else if (classNames.length === 1) {
    cls = classNames[0];
  } else {
    choices.className = { options: classNames };
  }
  reconcile.push({ kind: 'multiclass', reason: 'A level in a class not on the sheet comes from a DDB re-import.' });

  if (!cls) {
    return { request, fromLevel, toLevel: target, className: null, classLevelFrom: null, classLevelTo: null,
      auto: null, choices, reconcile, missing, requiresDm: true };
  }

  const prog = sheet?.progression?.[cls] || null;
  if (!prog) missing.push('progression');
  const classLevelFrom = classLevelOf(sheet, cls);
  const classLevelTo = classLevelFrom + 1;

  // HP + hit die.
  const die = hitDieOf(sheet, state, cls);
  if (!die) missing.push('hitDie');
  const con = abilityMod(sheet?.abilityScores?.CON ?? (10 + 2 * (sheet?.abilityModifiers?.CON ?? 0)));
  const fixed = die ? averageHitDieGain(die) : null;
  const hp = { mode: hpMode, die, fixed: hpMode === 'average' ? fixed : null, con,
    gain: hpMode === 'average' && fixed !== null ? Math.max(1, fixed + con) : null };

  // Slots.
  const { table, missing: slotMissing } = slotTableWith(sheet, cls, classLevelTo);
  if (slotMissing.length) missing.push('levelSpellSlots');
  const slotsBefore = { spell: clone(sheet?.spellSlotTable?.spell || {}), pact: clone(sheet?.spellSlotTable?.pact ?? null) };
  const slotsAfter = { spell: table.spell, pact: table.pact };
  // Unknown slot rows (a sheet parsed before R23): keep the old table; the DM confirms.
  const spellSlots = slotMissing.length || (JSON.stringify(slotsBefore) === JSON.stringify(slotsAfter) && !table.classes.length)
    ? null : { from: slotsBefore, to: slotsAfter };

  // Features at this class level (ASIs are choices; subclass picks are reconcile).
  const ladder = prog?.features || [];
  const atLevel = ladder.filter(f => f.requiredLevel === classLevelTo);
  const features = atLevel.filter(f => !f.asi).map(f => ({
    name: f.name, source: f.source, requiredLevel: f.requiredLevel, subclass: !!f.subclass,
    uses: usesAtLevel(f.limitedUse, classLevelTo), reset: f.limitedUse?.reset ?? null,
    resourceKey: f.limitedUse?.resourceKey ?? null
  }));
  const subclassName = (sheet?.classes || []).find(c => c.name === cls)?.subclass || null;
  for (const f of atLevel) {
    if (!subclassName && SUBCLASS_CHOICE_RE.test(f.name)) {
      reconcile.push({ kind: 'subclass', reason: `${f.name}: choose the subclass on D&D Beyond, then re-import.` });
    }
  }

  // levelScales stepping at this level, and use-count changes of features already held.
  const levelScales = [];
  for (const [slug, scales] of Object.entries(prog?.levelScales || {})) {
    const now = scaleAt(scales, classLevelTo);
    const was = scaleAt(scales, classLevelFrom);
    if (now && now.level === classLevelTo) {
      const feature = ladder.find(f => featureSlug(f.name) === slug);
      levelScales.push({ feature: feature?.name || slug, slug, from: was ? (was.dice ?? was.value) : null, to: now.dice ?? now.value, description: now.description });
    }
  }
  const usesChanged = [];
  for (const f of ladder) {
    if (f.requiredLevel > classLevelFrom || f.asi || !f.limitedUse) continue;
    const a = usesAtLevel(f.limitedUse, classLevelFrom);
    const b = usesAtLevel(f.limitedUse, classLevelTo);
    if (a !== null && b !== null && a !== b) usesChanged.push({ slug: featureSlug(f.name), name: f.name, from: a, to: b });
  }
  for (const [slug, t] of Object.entries(SRD_USE_TABLES)) {
    if (!t.className.test(cls) || !sheet?.featureUses?.[slug] || usesChanged.some(u => u.slug === slug)) continue;
    const a = t.max(classLevelFrom);
    const b = t.max(classLevelTo);
    if (a !== b) usesChanged.push({ slug, name: sheet.resources?.[`feat:${slug}`]?.label || slug, from: a, to: b });
  }

  // Choices: ASI and spells.
  const asiCount = atLevel.filter(f => f.asi).length;
  if (asiCount) choices.asi = { count: asiCount, points: 2 * asiCount, cap: ASI_CAP, perStatMax: 2 * asiCount };
  if (asiCount) reconcile.push({ kind: 'feat', reason: 'A feat in place of the ASI comes from a DDB re-import.' });
  choices.spells = spellAllowance(sheet, prog, cls, classLevelFrom, classLevelTo);

  const auto = {
    hp,
    hitDice: { className: cls, die, maxFrom: classLevelFrom, maxTo: classLevelTo },
    proficiencyBonus: { from: proficiencyBonus(fromLevel), to: proficiencyBonus(target) },
    spellSlots,
    features,
    levelScales,
    usesChanged
  };
  const hasChoice = !!(choices.className || choices.asi || choices.spells);
  return { request, fromLevel, toLevel: target, className: cls, classLevelFrom, classLevelTo,
    auto, choices, reconcile, missing, requiresDm: hasChoice || missing.length > 0 };
}

/** Validate an ASI pick against a plan's allowance; returns {stat: +n}. */
function validateAsi(sheet, allowance, pick) {
  if (!allowance) {
    ruleAssert(pick == null, 'asi-not-offered', 'No ability score improvement at this level.');
    return {};
  }
  if (pick === 'reconcile') return {};
  ruleAssert(pick && typeof pick === 'object', 'asi-required', 'Pick the ability score improvement (+2, or +1/+1).');
  const entries = Object.entries(pick);
  let total = 0;
  for (const [stat, n] of entries) {
    ruleAssert(STATS.includes(stat), 'asi-bad-stat', `Unknown ability "${stat}".`);
    ruleAssert(Number.isInteger(n) && n >= 1 && n <= allowance.perStatMax, 'asi-bad-amount', `${stat} +${n} is not a valid increase.`);
    const after = (Number(sheet?.abilityScores?.[stat]) || 10) + n;
    ruleAssert(after <= allowance.cap, 'asi-cap', `${stat} would be ${after}; the cap is ${allowance.cap}.`, { stat, after });
    total += n;
  }
  ruleAssert(total === allowance.points, 'asi-points', `An ASI spends exactly ${allowance.points} points (got ${total}).`);
  return Object.fromEntries(entries);
}

/** Validate spell picks; returns the spell records to add (sheet shape). */
function validateSpells(sheet, allowance, picks, prog) {
  const list = Array.isArray(picks) ? picks : [];
  if (!list.length) return [];
  ruleAssert(allowance, 'spells-not-offered', 'No new spells at this level.');
  const have = new Set((sheet?.spells || []).map(s => String(s?.name || '').toLowerCase()));
  const seen = new Set();
  let cantrips = 0;
  let leveled = 0;
  const out = [];
  for (const s of list) {
    ruleAssert(s && typeof s.name === 'string' && s.name.trim() && Number.isInteger(s.level) && s.level >= 0 && s.level <= 9,
      'spell-bad', 'Each spell needs a name and a level 0–9.');
    const key = s.name.trim().toLowerCase();
    ruleAssert(!have.has(key) && !seen.has(key), 'spell-duplicate', `${s.name} is already on the sheet.`);
    seen.add(key);
    if (s.level === 0) cantrips++;
    else {
      leveled++;
      ruleAssert(s.level <= allowance.maxSpellLevel, 'spell-too-high',
        `${s.name} is level ${s.level}; the highest slot is level ${allowance.maxSpellLevel}.`);
    }
    out.push({
      ...clone(s),
      source: s.source || 'class',
      spellCastingAbility: s.spellCastingAbility ?? prog?.spellcastingAbility ?? null,
      usesSpellSlot: s.usesSpellSlot ?? s.level > 0,
      castAtLevel: s.castAtLevel ?? s.level
    });
  }
  ruleAssert(cantrips <= allowance.cantrips, 'spells-over-max', `Only ${allowance.cantrips} new cantrip(s) at this level.`);
  ruleAssert(leveled <= allowance.known + allowance.prepared, 'spells-over-max',
    `Only ${allowance.known + allowance.prepared} new levelled spell(s) at this level.`);
  return out;
}

/** Sheet patch: replace top-level `field`, recording before/after. */
function patchSheet(sheet, patches, field, value) {
  const had = Object.prototype.hasOwnProperty.call(sheet, field);
  patches.push({ path: [field], before: had ? clone(sheet[field]) : undefined, existed: had, after: clone(value) });
  sheet[field] = value;
}

/**
 * Apply a planned level.
 *
 * @param {object} sheet — run sheet
 * @param {object} state — state_json v1
 * @param {object} plan — planLevelUp output (re-planned when `picks.className` resolves a multiclass choice)
 * @param {{className?: string, asi?: Record<string, number>|'reconcile', spells?: object[]}} [picks]
 * @param {{rng?: function(): number}} [opts] — required when hpOnLevel is 'roll'
 * @returns {{sheet: object, state: object, granted: object}}
 * @throws {CampaignRuleError} stale-plan | class-required | asi-* | spell* | missing-data
 */
export function applyLevelUp(sheet, state, plan, picks = {}, { rng } = {}) {
  ruleAssert(plan && plan.request, 'bad-plan', 'applyLevelUp needs a planLevelUp result.');
  ruleAssert(sheetLevel(sheet) === plan.fromLevel, 'stale-plan',
    `The sheet is level ${sheetLevel(sheet)}; this plan is for level ${plan.fromLevel}.`);
  let p = plan;
  if (!p.className) {
    ruleAssert(picks.className, 'class-required', 'Choose which class gains the level.', { options: plan.choices?.className?.options });
    p = planLevelUp(sheet, state, { ...plan.request, className: picks.className });
  } else if (picks.className && picks.className !== p.className) {
    p = planLevelUp(sheet, state, { ...plan.request, className: picks.className });
  }
  ruleAssert(!p.missing.includes('hitDie'), 'missing-data', 'The hit die is unknown; the DM sets HP by hand (reconcile).', { missing: p.missing });
  const cls = p.className;
  const prog = sheet?.progression?.[cls] || null;
  const asi = validateAsi(sheet, p.choices.asi, picks.asi);
  const newSpells = validateSpells(sheet, p.choices.spells, picks.spells, prog);

  const outSheet = clone(sheet);
  const outState = clone(state || {});
  const sheetPatches = [];
  const statePatches = [];

  // Ability scores (ASI) first: CON feeds the HP gain, retroactively.
  const oldCon = abilityMod(sheet?.abilityScores?.CON ?? (10 + 2 * (sheet?.abilityModifiers?.CON ?? 0)));
  if (Object.keys(asi).length) {
    const scores = { ...(outSheet.abilityScores || {}) };
    for (const [stat, n] of Object.entries(asi)) scores[stat] = (Number(scores[stat]) || 10) + n;
    const mods = { ...(outSheet.abilityModifiers || {}) };
    for (const stat of Object.keys(asi)) mods[stat] = abilityMod(scores[stat]);
    patchSheet(outSheet, sheetPatches, 'abilityScores', scores);
    patchSheet(outSheet, sheetPatches, 'abilityModifiers', mods);
  }
  const newCon = abilityMod(outSheet?.abilityScores?.CON ?? (10 + 2 * (outSheet?.abilityModifiers?.CON ?? 0)));

  // HP: die gain (fixed or rolled) + new CON, min 1; CON change applies to every earlier level.
  const die = p.auto.hp.die;
  let dieGain = p.auto.hp.fixed;
  let hpRoll = null;
  if (p.auto.hp.mode === 'roll') {
    requireRng(rng, 'applyLevelUp');
    hpRoll = rollDice(`1d${die}`, rng).total;
    dieGain = hpRoll;
  }
  const levelGain = Math.max(1, dieGain + newCon);
  const retro = (newCon - oldCon) * p.fromLevel;
  const hpGain = levelGain + retro;
  const hp = { ...(outSheet.hp || {}) };
  hp.base = (Number(hp.base) || 0) + dieGain;
  if (typeof hp.override === 'number') hp.override += hpGain;
  hp.max = (Number(hp.max) || 0) + hpGain;
  hp.current = Math.max(0, hp.max - (Number(hp.removed) || 0));
  patchSheet(outSheet, sheetPatches, 'hp', hp);

  // Level + class level.
  patchSheet(outSheet, sheetPatches, 'classes', (outSheet.classes || []).map(c => (c.name === cls ? { ...c, level: p.classLevelTo } : c)));
  patchSheet(outSheet, sheetPatches, 'level', p.toLevel);
  if (prog) {
    patchSheet(outSheet, sheetPatches, 'progression', { ...outSheet.progression, [cls]: { ...prog, level: p.classLevelTo } });
  }

  // Slots.
  if (p.auto.spellSlots) {
    const { table } = slotTableWith(outSheet, cls, p.classLevelTo);
    patchSheet(outSheet, sheetPatches, 'spellSlotTable', table);
  }

  // Features, level-scaled dice, use counts.
  const classFeatures = clone(outSheet.classFeatures || []);
  const featureUses = clone(outSheet.featureUses || {});
  const resources = clone(outSheet.resources || {});
  const ladder = prog?.features || [];
  for (const f of p.auto.features) {
    const full = ladder.find(x => x.name === f.name && x.requiredLevel === f.requiredLevel) || {};
    const scale = scaleAt(full.levelScales, p.classLevelTo);
    classFeatures.push({
      name: f.name, source: f.source, level: f.requiredLevel,
      description: full.description || '',
      dice: scale?.dice ?? null,
      uses: f.uses && f.reset ? { max: f.uses, used: 0, reset: f.reset } : null
    });
    if (f.uses && f.reset) {
      const slug = featureSlug(f.name);
      featureUses[slug] = { max: f.uses, used: 0, reset: f.reset };
      resources[`feat:${slug}`] = { label: f.name, max: f.uses, spent: 0, recovery: clone(full.limitedUse?.recovery || []), source: 'feature' };
    }
  }
  for (const ls of p.auto.levelScales) {
    const cf = classFeatures.find(x => featureSlug(x.name) === ls.slug);
    if (cf && typeof ls.to === 'string') cf.dice = ls.to;
  }
  for (const u of p.auto.usesChanged) {
    if (featureUses[u.slug]) featureUses[u.slug] = { ...featureUses[u.slug], max: u.to };
    const cf = classFeatures.find(x => featureSlug(x.name) === u.slug);
    if (cf?.uses) cf.uses = { ...cf.uses, max: u.to };
    if (resources[`feat:${u.slug}`]) resources[`feat:${u.slug}`] = { ...resources[`feat:${u.slug}`], max: u.to };
  }
  classFeatures.sort((a, b) => a.level - b.level || a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  if (JSON.stringify(classFeatures) !== JSON.stringify(outSheet.classFeatures || [])) patchSheet(outSheet, sheetPatches, 'classFeatures', classFeatures);
  if (JSON.stringify(featureUses) !== JSON.stringify(outSheet.featureUses || {})) patchSheet(outSheet, sheetPatches, 'featureUses', featureUses);
  if (JSON.stringify(resources) !== JSON.stringify(outSheet.resources || {})) patchSheet(outSheet, sheetPatches, 'resources', resources);

  // Spells.
  if (newSpells.length) {
    const spells = [...clone(outSheet.spells || []), ...newSpells];
    spells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    patchSheet(outSheet, sheetPatches, 'spells', spells);
  }

  // State: the HP gain, the new hit die entry, new slot levels, new / resized resources.
  outState.hp = { current: 0, temp: 0, ...(outState.hp || {}) };
  outState.hp.current = Math.min(hp.max, (Number(outState.hp.current) || 0) + hpGain);
  statePatches.push({ op: 'add', path: ['hp', 'current'], delta: hpGain });
  if (!outState.hitDice?.[cls]) {
    outState.hitDice = { ...(outState.hitDice || {}), [cls]: { die, spent: 0 } };
    statePatches.push({ op: 'create', path: ['hitDice', cls] });
  }
  if (p.auto.spellSlots) {
    outState.slots = { spell: {}, pact: {}, ...(outState.slots || {}) };
    outState.slots.spell = { ...(outState.slots.spell || {}) };
    for (const lvl of Object.keys(outSheet.spellSlotTable.spell || {})) {
      if (!outState.slots.spell[lvl]) {
        outState.slots.spell[lvl] = { spent: 0 };
        statePatches.push({ op: 'create', path: ['slots', 'spell', lvl] });
      }
    }
    if (outSheet.spellSlotTable.pact && !Number.isFinite(outState.slots.pact?.spent)) {
      statePatches.push({ op: 'set', path: ['slots', 'pact'], before: clone(outState.slots.pact) });
      outState.slots.pact = { spent: 0 };
    }
  }
  for (const [key, r] of Object.entries(resources)) {
    const cur = outState.resources?.[key];
    if (!cur) {
      outState.resources = { ...(outState.resources || {}), [key]: { label: r.label, max: r.max, spent: 0, recovery: clone(r.recovery || []) } };
      statePatches.push({ op: 'create', path: ['resources', key] });
    } else if (cur.max !== r.max) {
      statePatches.push({ op: 'set', path: ['resources', key, 'max'], before: cur.max });
      outState.resources[key] = { ...cur, max: r.max, spent: Math.min(cur.spent, r.max) };
    }
  }

  const granted = {
    v: 1,
    fromLevel: p.fromLevel,
    toLevel: p.toLevel,
    className: cls,
    classLevelTo: p.classLevelTo,
    hp: { mode: p.auto.hp.mode, die, roll: hpRoll, dieGain, con: newCon, gain: hpGain },
    asi,
    asiDeferred: picks.asi === 'reconcile',
    spells: newSpells.map(s => s.name),
    features: p.auto.features.map(f => f.name),
    sheet: sheetPatches,
    state: statePatches
  };
  return { sheet: outSheet, state: outState, granted };
}

/** Walk to the parent of `path` (creating nothing); returns [parent, lastKey] or [null]. */
function parentOf(obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!cur || typeof cur !== 'object') return [null, null];
    cur = cur[path[i]];
  }
  return cur && typeof cur === 'object' ? [cur, path[path.length - 1]] : [null, null];
}

/**
 * Undo an applied level-up. The sheet is restored byte for byte (every
 * top-level field `applyLevelUp` replaced goes back to its `before`
 * value, absent fields are deleted). The state loses the HP gain
 * (clamped to the restored max, never below 1 for a conscious PC) and
 * every slot level / resource / hit-die entry the level created;
 * resized resource maxima go back. Only the most recent level-up can
 * be reverted (the sheet must still be at `granted.toLevel`).
 * @param {object} sheet
 * @param {object} state
 * @param {object} granted — applyLevelUp's `granted`
 * @returns {{sheet: object, state: object}}
 * @throws {CampaignRuleError} revert-order | bad-granted
 */
export function revertLevelUp(sheet, state, granted) {
  ruleAssert(granted && granted.v === 1 && Array.isArray(granted.sheet), 'bad-granted', 'Not a level-up record.');
  ruleAssert(sheetLevel(sheet) === granted.toLevel, 'revert-order',
    `Only the latest level-up can be reverted (sheet level ${sheetLevel(sheet)}, record ${granted.fromLevel}→${granted.toLevel}).`);
  const outSheet = clone(sheet);
  for (let i = granted.sheet.length - 1; i >= 0; i--) {
    const { path, before, existed } = granted.sheet[i];
    const [parent, key] = parentOf(outSheet, path);
    if (!parent) continue;
    if (existed === false) delete parent[key];
    else parent[key] = clone(before);
  }
  const outState = clone(state || {});
  for (let i = (granted.state || []).length - 1; i >= 0; i--) {
    const op = granted.state[i];
    const [parent, key] = parentOf(outState, op.path);
    if (!parent) continue;
    if (op.op === 'create') delete parent[key];
    else if (op.op === 'set') {
      if (op.before === undefined) delete parent[key];
      else parent[key] = clone(op.before);
      if (op.path[0] === 'resources' && op.path[2] === 'max') {
        const r = outState.resources?.[op.path[1]];
        if (r) r.spent = Math.min(r.spent, r.max);
      }
    } else if (op.op === 'add') {
      const cur = Number(parent[key]) || 0;
      const max = Number(outSheet?.hp?.max) || 0;
      const floor = cur > 0 ? 1 : 0;
      parent[key] = Math.max(floor, Math.min(max, cur - op.delta));
    }
  }
  return { sheet: outSheet, state: outState };
}

/** Diff kinds a re-import may propose (structural only). */
const RECONCILE_KINDS = new Set(['subclass', 'ability', 'feature-added', 'feature-removed', 'spell-added', 'spell-removed', 'feat-added', 'feat-removed']);

/**
 * What a fresh DDB import would change structurally. Refused when the DDB
 * sheet's level is above the level the game granted. XP, HP, resources,
 * inventory and currency are never proposed; existing classes' levels are
 * game-owned (only a class the run sheet lacks — a new multiclass — is
 * proposed).
 * @param {object} runSheet — the run's sheet_json
 * @param {object} freshParse — parseCharacter of the new DDB export
 * @param {number} grantedLevel — the level the game has granted
 * @returns {{ok: boolean, code?: string, reason?: string, ddbLevel: number, grantedLevel: number,
 *   proposals: object[]}}
 */
export function reconcileDiff(runSheet, freshParse, grantedLevel) {
  const ddbLevel = sheetLevel(freshParse);
  const granted = Math.trunc(Number(grantedLevel) || sheetLevel(runSheet));
  if (ddbLevel > granted) {
    return { ok: false, code: 'ddb-level-ahead', ddbLevel, grantedLevel: granted, proposals: [],
      reason: `D&D Beyond is at level ${ddbLevel}; the game has granted level ${granted}. Level up in the game first.` };
  }
  const runClasses = new Set((runSheet?.classes || []).map(c => c.name));
  const proposals = diffCharacters(runSheet, freshParse).filter(d =>
    RECONCILE_KINDS.has(d.kind) || (d.kind === 'class-level' && d.from === 0 && !runClasses.has(d.class)));
  return { ok: true, ddbLevel, grantedLevel: granted, proposals: proposals.map((d, i) => ({ id: `p${i}`, ...d })) };
}

/**
 * Apply the DM-approved reconcile proposals (ids from reconcileDiff) to the
 * run sheet, recording `granted` patches revertLevelUp-style (sheet only).
 * Copies classFeatures / spells / feats rows, subclass names (with the
 * fresh progression ladder), ability scores, and a new class (its
 * classes row, progression and the recomputed slot table; its HP is the
 * DM's call). Never copies XP, HP, resources, inventory or currency.
 * @param {object} runSheet
 * @param {object} freshParse
 * @param {object} diff — reconcileDiff output
 * @param {string[]} acceptedIds
 * @returns {{sheet: object, granted: object}}
 * @throws {CampaignRuleError} reconcile-refused | unknown-proposal
 */
export function applyReconcile(runSheet, freshParse, diff, acceptedIds) {
  ruleAssert(diff?.ok, 'reconcile-refused', diff?.reason || 'This re-import was refused.');
  const byId = new Map(diff.proposals.map(p => [p.id, p]));
  const accepted = (acceptedIds || []).map(id => {
    ruleAssert(byId.has(id), 'unknown-proposal', `No proposal ${id}.`);
    return byId.get(id);
  });
  const sheet = clone(runSheet);
  const patches = [];
  const work = {};
  const field = (name) => {
    if (!(name in work)) work[name] = clone(sheet[name] ?? (name === 'feats' || name === 'spells' || name === 'classFeatures' || name === 'classes' ? [] : {}));
    return work[name];
  };
  for (const d of accepted) {
    switch (d.kind) {
      case 'subclass': {
        const classes = field('classes');
        const c = classes.find(x => x.name === d.class);
        if (c) c.subclass = d.name;
        if (freshParse?.progression?.[d.class]) {
          const prog = field('progression');
          prog[d.class] = { ...clone(freshParse.progression[d.class]), level: c ? c.level : freshParse.progression[d.class].level };
        }
        break;
      }
      case 'ability': {
        const scores = field('abilityScores');
        scores[d.stat] = d.to;
        field('abilityModifiers')[d.stat] = abilityMod(d.to);
        break;
      }
      case 'feature-added': {
        const row = (freshParse.classFeatures || []).find(f => f.name === d.name && f.source === d.source);
        if (row) field('classFeatures').push(clone(row));
        break;
      }
      case 'feature-removed': {
        work.classFeatures = field('classFeatures').filter(f => !(f.name === d.name && f.source === d.source));
        break;
      }
      case 'spell-added': {
        const row = (freshParse.spells || []).find(s => s.name === d.name && s.level === d.level);
        if (row) field('spells').push(clone(row));
        break;
      }
      case 'spell-removed': {
        work.spells = field('spells').filter(s => !(s.name === d.name && s.level === d.level));
        break;
      }
      case 'feat-added': field('feats').push(d.name); break;
      case 'feat-removed': work.feats = field('feats').filter(f => f !== d.name); break;
      case 'class-level': {
        const row = (freshParse.classes || []).find(c => c.name === d.class);
        if (row) field('classes').push(clone(row));
        if (freshParse?.progression?.[d.class]) field('progression')[d.class] = clone(freshParse.progression[d.class]);
        break;
      }
      default:
        throw new CampaignRuleError('unknown-proposal', `Cannot apply a ${d.kind} change.`);
    }
  }
  if (work.classes) {
    work.level = work.classes.reduce((s, c) => s + (Number(c.level) || 0), 0);
    if (accepted.some(d => d.kind === 'class-level')) {
      const probe = { ...sheet, classes: work.classes, progression: work.progression || sheet.progression };
      const { table } = slotTableWith(probe, null, 0);
      work.spellSlotTable = table;
    }
  }
  if (work.classFeatures) work.classFeatures.sort((a, b) => a.level - b.level || a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  if (work.spells) work.spells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  for (const [name, value] of Object.entries(work)) patchSheet(sheet, patches, name, value);
  return { sheet, granted: { v: 1, kind: 'reconcile', fromLevel: sheetLevel(runSheet), toLevel: sheetLevel(sheet), accepted: accepted.map(d => d.id), sheet: patches, state: [] } };
}
