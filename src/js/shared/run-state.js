/**
 * M65 H22 — run character state (`party_slots.state_json` v1) and the run
 * snapshot blob (`run_snapshots.blob_json` v1).
 *
 * state_json v1 was settled in M64 ("Data model"); this module is its
 * validator and its seed:
 *
 *   {
 *     schema_v: 1,
 *     hp:          { current, temp },
 *     deathSaves:  { successes, failures, stable },
 *     hitDice:     { <class name>: { die, spent } },
 *     slots:       { spell: { <1-9>: { spent } }, pact: { spent } },
 *     resources:   { <key>: { label, max, spent, recovery[], source? } },
 *     conditions:  [ <condition id> ],          persistent across nodes
 *     conditionMeta: { <condition id>: { sourceId?, endsOn?, save?, appliedRound?, persistent? } },
 *     exhaustion:  0-6,
 *     inspiration: boolean,
 *     currency:    { cp, sp, ep, gp, pp },
 *     concentration: null | { spellId, targetIds? }
 *   }
 *
 * Spent, not remaining (M65 decision 10): maxima come from the sheet
 * (`sheet_json`), never from the state. HP max likewise. Resource keys are
 * namespaced (M65 "Rests"):
 *   feat:<slug>        class features — the sheet's `featureUses` slugs
 *                      ('feat:action-surge', 'feat:second-wind', 'feat:rage')
 *   spell:<spellId>    a feat / race / item spell cast through its own uses
 *   ddb:<componentId>  any other DDB limited use (the parser's R23
 *                      `sheet.resources`: race / feat / item / background
 *                      actions, optional class features). DM-adjudicated:
 *                      the engine has no ledger for them and never reads
 *                      or writes them; they persist across nodes and
 *                      recover on rests by their `recovery` (an empty
 *                      list = only the DM resets it).
 *   item:<id>, dm:<id> reserved
 * `source` (optional) is the parser's provenance tag ('feature', 'race',
 * 'feat', 'item', 'class', …), accepted so a state seeded straight from
 * `sheet.resources` validates. Added in M65 phase 2 (additive: schema_v
 * stays 1; a state without it is unchanged).
 * `ledgerKeyForResource` / `resourceKeyForLedger` map them to and from the
 * EncounterState entity's `resources.features` keys (T21's seam).
 *
 * Imported by both Vite and Node: no DOM, no Node built-ins. Pure.
 */

import {
  createCollector, checkSpec, checkJsonSafe, joinPath, isPlainObject,
  str, int, bool, oneOf, arrayOf, shape, mapOf, anyJson, optional, nullable,
  VALIDATION_CODES
} from './check.js';
import { ABILITIES, RNG_ALGOS } from './encounter-state.js';
import { CURRENCY_KEYS, ITEM_ORIGINS, LEVEL_UP_MODES, validateCampaign, validateCampaignSettings } from './campaign.js';

const C = VALIDATION_CODES;

/** `state_json.schema_v`. */
export const RUN_STATE_SCHEMA_V = 1;
/** `run_snapshots.blob_json.v`. */
export const RUN_SNAPSHOT_VERSION = 1;
/** `runs.status` (CHECK). */
export const RUN_STATUSES = Object.freeze(['lobby', 'in-node', 'between', 'paused', 'ended']);
/** `runs.outcome`. */
export const RUN_OUTCOMES = Object.freeze(['victory', 'defeat', 'abandoned']);
/** `party_slots.life_status` (CHECK). */
export const LIFE_STATUSES = Object.freeze(['active', 'dying', 'stable', 'dead']);
/** `level_ups.status` (CHECK). */
export const LEVEL_UP_STATUSES = Object.freeze(['pending_player', 'pending_dm', 'applied', 'reverted']);
/** Run statuses a snapshot may be taken in (between nodes only). */
export const SNAPSHOT_RUN_STATUSES = Object.freeze(['lobby', 'between']);
/**
 * When a resource recovers. `sr` also recovers on a long rest; `dawn` /
 * `day` recover on a long rest when the campaign sets dawnIsLongRest.
 */
export const RECOVERY_PERIODS = Object.freeze(['sr', 'lr', 'dawn', 'dusk', 'day', 'turn']);
/** Resource key namespaces. */
export const RESOURCE_KEY_PREFIXES = Object.freeze(['feat', 'spell', 'ddb', 'item', 'dm']);
/** Most attuned items one character may hold (SRD). */
export const MAX_ATTUNED = 3;
/** SRD hit die per class (last fallback: see `hitDieForClass`). */
export const HIT_DIE_BY_CLASS = Object.freeze({
  Barbarian: 12, Fighter: 10, Paladin: 10, Ranger: 10,
  Bard: 8, Cleric: 8, Druid: 8, Monk: 8, Rogue: 8, Warlock: 8, Artificer: 8,
  Sorcerer: 6, Wizard: 6
});

const RESOURCE_KEY = /^(feat|spell|ddb|item|dm):[A-Za-z0-9._-]{1,120}$/;
const ID = str({ maxLength: 128 });
const COIN = int(0, 1e9);

/** A full purse: all five denominations, non-negative integers. */
export const FULL_CURRENCY_SPEC = shape(Object.fromEntries(CURRENCY_KEYS.map(k => [k, COIN])));

const RUN_STATE_SPEC = shape({
  schema_v: anyJson(),   // checked explicitly (VERSION code)
  hp: shape({ current: int(0), temp: int(0) }),
  deathSaves: shape({ successes: int(0, 3), failures: int(0, 3), stable: bool() }),
  hitDice: mapOf(shape({ die: oneOf([6, 8, 10, 12]), spent: int(0, 20) })),
  slots: shape({
    spell: mapOf(shape({ spent: int(0) }), { keyPattern: /^[1-9]$/ }),
    pact: shape({ spent: int(0) })
  }),
  resources: mapOf(shape({
    label: str({ maxLength: 128 }),
    max: int(0),
    spent: int(0),
    recovery: arrayOf(oneOf(RECOVERY_PERIODS), { unique: true }),
    source: optional(str({ maxLength: 32 }))   // parser provenance (additive)
  }), { keyPattern: RESOURCE_KEY }),
  conditions: arrayOf(str({ maxLength: 64 }), { unique: true }),
  conditionMeta: mapOf(shape({
    sourceId: optional(nullable(ID)),
    endsOn: optional(nullable(str({ maxLength: 64 }))),
    save: optional(nullable(shape({ stat: oneOf(ABILITIES), dc: int(0) }))),
    appliedRound: optional(nullable(int(0))),
    persistent: optional(bool())   // DM-marked: survives encounter end
  })),
  exhaustion: int(0, 6),
  inspiration: bool(),
  currency: FULL_CURRENCY_SPEC,
  concentration: nullable(shape({ spellId: str({ maxLength: 128 }), targetIds: optional(arrayOf(ID)) }))
});

function classLevels(sheet) {
  const out = {};
  for (const c of Array.isArray(sheet?.classes) ? sheet.classes : []) {
    if (c && typeof c.name === 'string') out[c.name] = (out[c.name] || 0) + (Math.trunc(Number(c.level)) || 0);
  }
  return out;
}

/**
 * Validate a run character's `state_json` v1. With `opts.sheet` (the run
 * `sheet_json`, parseCharacter shape) the ledgers are also checked
 * against the sheet's maxima: HP, spell / pact slots, hit dice per class.
 * @param {unknown} state
 * @param {{sheet?: object}} [opts]
 * @returns {import('./check.js').ValidationResult}
 */
export function validateRunState(state, opts = {}) {
  const c = createCollector();
  checkJsonSafe(c, state, '');
  checkSpec(c, state, RUN_STATE_SPEC, '');
  if (!isPlainObject(state)) return c.result();
  if (state.schema_v !== RUN_STATE_SCHEMA_V) {
    c.add('schema_v', C.VERSION, `expected ${RUN_STATE_SCHEMA_V}, got ${JSON.stringify(state.schema_v)}`);
  }
  for (const [k, r] of Object.entries(isPlainObject(state.resources) ? state.resources : {})) {
    if (isPlainObject(r) && Number.isInteger(r.spent) && Number.isInteger(r.max) && r.spent > r.max) {
      c.add(joinPath('resources', k), C.RANGE, `spent ${r.spent} exceeds max ${r.max}`);
    }
  }
  const conds = Array.isArray(state.conditions) ? state.conditions : [];
  for (const k of Object.keys(isPlainObject(state.conditionMeta) ? state.conditionMeta : {})) {
    if (!conds.includes(k)) c.add(joinPath('conditionMeta', k), C.REF, `"${k}" is not in conditions`);
  }
  conds.forEach((id, i) => {
    if (id === 'exhaustion') c.add(`conditions[${i}]`, C.FORBIDDEN_FIELD, 'exhaustion is the `exhaustion` level, not a condition');
  });
  const ds = state.deathSaves;
  if (isPlainObject(state.hp) && state.hp.current > 0 && isPlainObject(ds) &&
      (ds.successes > 0 || ds.failures > 0 || ds.stable === true)) {
    c.add('deathSaves', C.RANGE, 'death saves must be clear while hp.current > 0');
  }

  const sheet = opts?.sheet;
  if (isPlainObject(sheet)) {
    const hpMax = Number(sheet.hp?.max);
    if (Number.isFinite(hpMax) && isPlainObject(state.hp) && state.hp.current > hpMax) {
      c.add('hp.current', C.RANGE, `${state.hp.current} exceeds the sheet's hp.max ${hpMax}`);
    }
    const table = isPlainObject(sheet.spellSlotTable?.spell) ? sheet.spellSlotTable.spell : {};
    for (const [lvl, l] of Object.entries(isPlainObject(state.slots?.spell) ? state.slots.spell : {})) {
      const max = Math.trunc(Number(table[lvl])) || 0;
      if (isPlainObject(l) && Number.isInteger(l.spent) && l.spent > max) {
        c.add(`slots.spell.${lvl}`, C.RANGE, `spent ${l.spent} exceeds the sheet's ${max} level-${lvl} slots`);
      }
    }
    const pactMax = Math.trunc(Number(sheet.spellSlotTable?.pact?.max)) || 0;
    if (isPlainObject(state.slots?.pact) && Number.isInteger(state.slots.pact.spent) && state.slots.pact.spent > pactMax) {
      c.add('slots.pact.spent', C.RANGE, `spent ${state.slots.pact.spent} exceeds the sheet's ${pactMax} pact slots`);
    }
    const levels = classLevels(sheet);
    for (const [cls, hd] of Object.entries(isPlainObject(state.hitDice) ? state.hitDice : {})) {
      if (!(cls in levels)) { c.add(joinPath('hitDice', cls), C.REF, `"${cls}" is not a class on the sheet`); continue; }
      if (isPlainObject(hd) && Number.isInteger(hd.spent) && hd.spent > levels[cls]) {
        c.add(joinPath(joinPath('hitDice', cls), 'spent'), C.RANGE, `spent ${hd.spent} exceeds ${cls} level ${levels[cls]}`);
      }
    }
  }
  return c.result();
}

/**
 * Spell name → registry id slug. Mirrors scene/feature-uses.js spellSlug
 * (shared/ imports nothing outside shared/; a test pins the two together).
 * @param {string} name
 * @returns {string}
 */
export function spellSlug(name) {
  return String(name || '').toLowerCase()
    .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Parser reset label ('short rest', 'long rest', 'dawn', …) → recovery periods.
 * @param {string|null|undefined} reset
 * @returns {string[]}
 */
export function recoveryForReset(reset) {
  switch (String(reset || '').toLowerCase()) {
    case 'short rest': case 'shortrest': case 'short': case 'sr': return ['sr'];
    case 'long rest': case 'longrest': case 'long': case 'lr': return ['lr'];
    case 'dawn': return ['dawn'];
    case 'dusk': return ['dusk'];
    case 'day': return ['day'];
    case 'turn': return ['turn'];
    default: return [];
  }
}

/**
 * Run resource key → EncounterState entity `resources.features` key:
 * 'feat:rage' → 'rage'; 'spell:…', 'ddb:…' and the rest are kept as is.
 * @param {string} key
 * @returns {string}
 */
export function ledgerKeyForResource(key) {
  const k = String(key);
  return k.startsWith('feat:') ? k.slice(5) : k;
}

/**
 * Entity `resources.features` key → run resource key: 'rage' →
 * 'feat:rage'; already-namespaced keys ('spell:misty-step') are kept.
 * @param {string} ledgerKey
 * @returns {string}
 */
export function resourceKeyForLedger(ledgerKey) {
  const k = String(ledgerKey);
  return k.includes(':') ? k : `feat:${k}`;
}

const titleCase = (slug) => String(slug).split('-').filter(Boolean)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Every limited-use resource on a parsed sheet as `{key: {label, max,
 * spent: 0, recovery}}`. The parser's R23 `sheet.resources` map (`{key:
 * {label, max, spent, recovery[], source}}`, including the
 * DM-adjudicated `ddb:<componentId>` pools) wins when present; otherwise
 * `featureUses` → `feat:<slug>` and granted spells with their own uses →
 * `spell:<id>`. The parser's `spent` (DDB's live uses) is not copied:
 * initialRunState carries it only on importDdbState.
 * @param {object} sheet
 * @returns {Record<string, {label: string, max: number, spent: number, recovery: string[]}>}
 */
export function resourcesFromSheet(sheet) {
  const out = {};
  if (isPlainObject(sheet?.resources)) {
    for (const [key, r] of Object.entries(sheet.resources)) {
      const max = Math.trunc(Number(r?.max)) || 0;
      if (!RESOURCE_KEY.test(key) || max <= 0) continue;
      const recovery = Array.isArray(r.recovery) ? r.recovery.filter(p => RECOVERY_PERIODS.includes(p)) : recoveryForReset(r.reset);
      out[key] = { label: String(r.label || key).slice(0, 128), max, spent: 0, recovery: [...new Set(recovery)] };
    }
    return out;
  }
  for (const [slug, u] of Object.entries(isPlainObject(sheet?.featureUses) ? sheet.featureUses : {})) {
    const max = Math.trunc(Number(u?.max)) || 0;
    const key = `feat:${slug}`;
    if (max > 0 && RESOURCE_KEY.test(key)) out[key] = { label: titleCase(slug), max, spent: 0, recovery: recoveryForReset(u.reset) };
  }
  for (const s of Array.isArray(sheet?.spells) ? sheet.spells : []) {
    if (!isPlainObject(s) || !s.source || s.source === 'class') continue;
    const max = Math.trunc(Number(s.uses?.max)) || 0;
    const key = `spell:${spellSlug(s.name)}`;
    if (max > 0 && RESOURCE_KEY.test(key)) out[key] = { label: String(s.name).slice(0, 128), max, spent: 0, recovery: recoveryForReset(s.uses.reset) };
  }
  return out;
}

/** An empty purse. @returns {{cp: number, sp: number, ep: number, gp: number, pp: number}} */
export function emptyCurrency() {
  return Object.fromEntries(CURRENCY_KEYS.map(k => [k, 0]));
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v)) || 0));

const HIT_DIE_SIZES = [6, 8, 10, 12];
const asHitDie = (v) => (HIT_DIE_SIZES.includes(Number(v)) ? Number(v) : null);

/**
 * A class's hit die on a parsed sheet. The parser (M65 R23) emits it as
 * `sheet.hitDice[Class].die` and `sheet.progression[Class].hitDie` (from
 * DDB `definition.hitDice`, so homebrew dice survive); a hand-built
 * `classes[].hitDie` is read next, the SRD table last, 8 when unknown.
 * @param {object} sheet — parseCharacter output
 * @param {string} className
 * @returns {6|8|10|12}
 */
export function hitDieForClass(sheet, className) {
  const row = (Array.isArray(sheet?.classes) ? sheet.classes : []).find(c => c?.name === className);
  return asHitDie(isPlainObject(sheet?.hitDice) ? sheet.hitDice[className]?.die : null)
    ?? asHitDie(isPlainObject(sheet?.progression) ? sheet.progression[className]?.hitDie : null)
    ?? asHitDie(row?.hitDie)
    ?? HIT_DIE_BY_CLASS[className]
    ?? 8;
}

/** DDB's spent hit dice for a class (`hitDice[Class].spent`, else progression `hitDiceUsed`). */
function ddbHitDiceSpent(sheet, className) {
  const hd = isPlainObject(sheet?.hitDice) ? sheet.hitDice[className] : null;
  if (Number.isFinite(Number(hd?.spent))) return Number(hd.spent);
  const p = isPlainObject(sheet?.progression) ? sheet.progression[className] : null;
  return Number(p?.hitDiceUsed) || 0;
}

/**
 * A run character's starting state from its parsed sheet: fully rested
 * (M65 B24) — full HP, no temp HP, every slot / hit die / resource
 * unspent, no conditions, no exhaustion. Hit dice come from
 * `hitDieForClass` (the parser's `hitDice` / `progression` first, the SRD
 * table last). With `importDdbState` (the DM's opt-in) DDB's live play
 * state is carried instead: HP / temp HP, death saves at 0 HP, spent hit
 * dice, used slots and resource uses, conditions, exhaustion and
 * inspiration. Currency comes from `sheet.currency`
 * (E4 R23) when present. XP and level live on the party_slots row.
 * @param {object} sheet — parseCharacter output (the run sheet_json)
 * @param {{importDdbState?: boolean}} [opts]
 * @returns {object} state_json v1
 */
export function initialRunState(sheet, opts = {}) {
  const live = !!opts?.importDdbState;
  const hpMax = Math.max(1, Math.trunc(Number(sheet?.hp?.max)) || 1);
  const hitDice = {};
  const levels = classLevels(sheet);
  for (const name of Object.keys(levels)) {
    const spent = live ? clampInt(ddbHitDiceSpent(sheet, name), 0, Math.min(20, levels[name])) : 0;
    hitDice[name] = { die: hitDieForClass(sheet, name), spent };
  }
  const table = isPlainObject(sheet?.spellSlotTable?.spell) ? sheet.spellSlotTable.spell : {};
  const used = sheet?.slotsUsed || {};
  const spell = {};
  for (const lvl of Object.keys(table).filter(k => /^[1-9]$/.test(k)).sort()) {
    const max = Math.trunc(Number(table[lvl])) || 0;
    if (max > 0) spell[lvl] = { spent: live ? clampInt(used.spell?.[lvl], 0, max) : 0 };
  }
  const pact = sheet?.spellSlotTable?.pact;
  const pactSpent = live && pact ? clampInt(used.pact?.[pact.level], 0, Math.trunc(Number(pact.max)) || 0) : 0;
  const resources = resourcesFromSheet(sheet);
  if (live && isPlainObject(sheet?.resources)) {
    // R23 sheet: every pool (feat:, spell:, ddb:) carries DDB's live `spent`.
    for (const [key, r] of Object.entries(resources)) r.spent = clampInt(sheet.resources[key]?.spent, 0, r.max);
  } else if (live) {
    for (const [slug, u] of Object.entries(isPlainObject(sheet?.featureUses) ? sheet.featureUses : {})) {
      const r = resources[`feat:${slug}`];
      if (r) r.spent = clampInt(u?.used, 0, r.max);
    }
    for (const s of Array.isArray(sheet?.spells) ? sheet.spells : []) {
      const r = isPlainObject(s) ? resources[`spell:${spellSlug(s.name)}`] : null;
      if (r) r.spent = clampInt(s.uses?.used, 0, r.max);
    }
  }
  const ddbConds = live && Array.isArray(sheet?.ddbConditions) ? sheet.ddbConditions : [];
  const current = live ? clampInt(sheet?.hp?.current ?? hpMax, 0, hpMax) : hpMax;
  const ds = live && current === 0 ? sheet?.deathSaves : null;
  const currency = emptyCurrency();
  if (isPlainObject(sheet?.currency)) for (const k of CURRENCY_KEYS) currency[k] = clampInt(sheet.currency[k], 0, 1e9);
  return {
    schema_v: RUN_STATE_SCHEMA_V,
    hp: { current, temp: live ? clampInt(sheet?.hp?.temp, 0, 999) : 0 },
    deathSaves: { successes: clampInt(ds?.successes, 0, 3), failures: clampInt(ds?.failures, 0, 3), stable: false },
    hitDice,
    slots: { spell, pact: { spent: pactSpent } },
    resources,
    conditions: [...new Set(ddbConds.map(x => x?.id).filter(id => typeof id === 'string' && id !== 'exhaustion'))],
    conditionMeta: {},
    exhaustion: clampInt(ddbConds.find(x => x?.id === 'exhaustion')?.level, 0, 6),
    inspiration: live ? !!sheet?.inspiration : false,
    currency,
    concentration: null
  };
}

// ---------------------------------------------------------------------
// Run snapshot blob (run_snapshots.blob_json v1)
// ---------------------------------------------------------------------

const SNAP_CHARACTER = shape({
  slotId: ID,
  seat: int(1, 6),
  characterId: nullable(ID),
  name: str({ maxLength: 128 }),
  level: int(1, 20),
  xp: int(0),
  lifeStatus: oneOf(LIFE_STATUSES),
  version: int(0),
  controllerParticipantId: optional(nullable(ID)),
  sheet: shape({}, { strict: false }),
  state: anyJson()   // validateRunState below
});

const SNAP_ITEM = shape({
  id: ID,
  ownerSlotId: nullable(ID),   // null = party stash
  origin: oneOf(ITEM_ORIGINS),
  refKey: nullable(str({ maxLength: 128 })),
  name: str({ maxLength: 128 }),
  qty: int(0),
  equipped: bool(),
  attuned: bool(),
  chargesSpent: int(0),
  data: anyJson()
});

const SNAP_LEVEL_UP = shape({
  id: ID,
  slotId: ID,
  fromLevel: int(1, 20),
  toLevel: int(1, 20),
  className: nullable(str({ maxLength: 64 })),
  mode: oneOf(LEVEL_UP_MODES),
  status: oneOf(LEVEL_UP_STATUSES),
  auto: optional(anyJson()),
  choices: optional(anyJson()),
  granted: optional(anyJson())
});

const SNAPSHOT_SPEC = shape({
  v: anyJson(),   // checked explicitly (VERSION code)
  runId: ID,
  atSeq: int(0),
  run: shape({
    status: oneOf(SNAPSHOT_RUN_STATUSES),
    currentNodeId: nullable(ID),
    visitedNodeIds: arrayOf(ID, { unique: true }),
    settings: anyJson(),   // validateCampaignSettings below
    stash: shape({ currency: FULL_CURRENCY_SPEC }),
    rng: shape({ algo: oneOf(RNG_ALGOS), s: int(0, 0xFFFFFFFF) })
  }),
  characters: arrayOf(SNAP_CHARACTER, { max: 6 }),
  items: arrayOf(SNAP_ITEM),
  levelUps: arrayOf(SNAP_LEVEL_UP),
  campaign: optional(anyJson())   // the frozen campaign_json; validateCampaign below
});

/**
 * Validate a run snapshot blob v1: the run row (between nodes only), every
 * character's sheet + state (validateRunState against its sheet), items
 * (owners exist, ≤ 3 attuned each), level-ups, and — when the frozen
 * campaign is included — node references.
 * @param {unknown} blob
 * @returns {import('./check.js').ValidationResult}
 */
export function validateRunSnapshot(blob) {
  const c = createCollector();
  checkJsonSafe(c, blob, '');
  checkSpec(c, blob, SNAPSHOT_SPEC, '');
  if (!isPlainObject(blob)) return c.result();
  if (blob.v !== RUN_SNAPSHOT_VERSION) c.add('v', C.VERSION, `expected ${RUN_SNAPSHOT_VERSION}, got ${JSON.stringify(blob.v)}`);
  const prefix = (base, errs) => { for (const e of errs) c.add(e.path ? joinPath(base, e.path).replace('.[', '[') : base, e.code, e.message); };
  if (isPlainObject(blob.run) && blob.run.settings !== undefined) prefix('run.settings', validateCampaignSettings(blob.run.settings).errors);

  const slots = new Set();
  const seats = new Set();
  (Array.isArray(blob.characters) ? blob.characters : []).forEach((ch, i) => {
    if (!isPlainObject(ch)) return;
    const p = `characters[${i}]`;
    if (typeof ch.slotId === 'string') {
      if (slots.has(ch.slotId)) c.add(`${p}.slotId`, C.DUPLICATE, `slot "${ch.slotId}" appears twice`);
      slots.add(ch.slotId);
    }
    if (Number.isInteger(ch.seat)) {
      if (seats.has(ch.seat)) c.add(`${p}.seat`, C.DUPLICATE, `seat ${ch.seat} appears twice`);
      seats.add(ch.seat);
    }
    prefix(`${p}.state`, validateRunState(ch.state, { sheet: isPlainObject(ch.sheet) ? ch.sheet : undefined }).errors);
  });
  const attuned = new Map();
  (Array.isArray(blob.items) ? blob.items : []).forEach((it, i) => {
    if (!isPlainObject(it)) return;
    if (typeof it.ownerSlotId === 'string' && !slots.has(it.ownerSlotId)) {
      c.add(`items[${i}].ownerSlotId`, C.REF, `unknown slot "${it.ownerSlotId}"`);
    }
    if (it.attuned === true) {
      if (it.ownerSlotId === null) c.add(`items[${i}].attuned`, C.RANGE, 'a stash item cannot be attuned');
      const n = (attuned.get(it.ownerSlotId) || 0) + 1;
      attuned.set(it.ownerSlotId, n);
      if (n > MAX_ATTUNED) c.add(`items[${i}].attuned`, C.RANGE, `more than ${MAX_ATTUNED} attuned items`);
    }
  });
  (Array.isArray(blob.levelUps) ? blob.levelUps : []).forEach((l, i) => {
    if (!isPlainObject(l)) return;
    if (typeof l.slotId === 'string' && !slots.has(l.slotId)) c.add(`levelUps[${i}].slotId`, C.REF, `unknown slot "${l.slotId}"`);
    if (Number.isInteger(l.fromLevel) && Number.isInteger(l.toLevel) && l.toLevel <= l.fromLevel) {
      c.add(`levelUps[${i}].toLevel`, C.RANGE, 'toLevel must exceed fromLevel');
    }
  });
  const run = isPlainObject(blob.run) ? blob.run : {};
  const visited = Array.isArray(run.visitedNodeIds) ? run.visitedNodeIds : [];
  if (typeof run.currentNodeId === 'string' && !visited.includes(run.currentNodeId)) {
    c.add('run.currentNodeId', C.REF, 'the current node must be in visitedNodeIds');
  }
  if (blob.campaign !== undefined) {
    prefix('campaign', validateCampaign(blob.campaign).errors);
    const ids = new Set((Array.isArray(blob.campaign?.nodes) ? blob.campaign.nodes : []).map(n => n?.id));
    visited.forEach((id, i) => {
      if (!ids.has(id)) c.add(`run.visitedNodeIds[${i}]`, C.REF, `unknown node "${id}"`);
    });
  }
  return c.result();
}
