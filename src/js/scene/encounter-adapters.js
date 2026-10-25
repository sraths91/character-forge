/**
 * M64 T5 — EncounterState v1 ↔ combat-engine wrappers (pure adapters).
 *
 * The engine resolves turns on flat per-entity "wrappers" (`hp`,
 * `_position`, `_slots`, per-turn flags, …). The server, the golden
 * harness and the browser bridge (live-bridge.js) all hold the canonical
 * state as an EncounterState (src/js/shared/encounter-state.js) and reach
 * the engine only through this module:
 *
 *   const sides = toEngineSides(state, sheets, activeId);
 *   await runOneAttack(sides.active, sides.enemies, sides.allies, sides.scene, rng, prompts);
 *   const next = applyEngineSides(state, sides.wrappers);
 *
 * `toEngineSides` builds fresh wrappers (no references into `state`);
 * `applyEngineSides` returns a NEW state and never mutates its input.
 * Every wrapper field the engine mutates is mapped to its state location
 * (WRAPPER_FIELD_MAP); the transient ones (`TRANSIENT_WRAPPER_FIELDS`,
 * e.g. `_mctsTargetCtx`, which holds an entity copy) are never persisted.
 *
 * Slots: the wrapper carries ONE runtime ledger — `_slots: {lvl: remaining}`
 * plus `_pact: {level, max, spent}|null` — persisted as
 * `resources.slots{lvl:{max, spent}}` and `resources.pact`.
 *
 * M65 T21 — the run-state seam. Between encounters a run character's
 * mutable state lives in `party_slots.state_json` (state_json v1, M64 data
 * model; "spent, not remaining"). `entityFromSheet(sheet, {runState})`
 * seeds an entity from it and `runStateFromEntity(entity, prev)` writes the
 * encounter's result back, preserving every key the engine does not own.
 * Resource keys (`state.resources`, shared/run-state.js) ↔ entity
 * `resources.features` (run-state's ledgerKeyForResource /
 * resourceKeyForLedger):
 *
 *   'feat:<key>'             ↔ features['<key>']  ('feat:action-surge',
 *                              'feat:second-wind', 'feat:rage',
 *                              'feat:channel-divinity',
 *                              'feat:legendary-resistance', …)
 *   'spell:<spellId>'        ↔ features['spell:<spellId>'] (granted-spell
 *                              uses: Fey Touched Misty Step)
 *   'ddb:*', 'item:*', 'dm:*' — limited uses the engine does not model:
 *                              never read, never written (preserved)
 *
 * Conditions: only those the run state marks `conditionMeta[id].persistent`
 * enter the encounter as `endsOn: 'persistent'` and survive its end; the
 * rest enter with their stored lifecycle and end with the encounter.
 *
 * Pure module: no DOM, no storage, no clock, no randomness.
 */

import { MONSTER_PRESETS } from './monster-presets.js';
import { spellById, freshSlots, freshInnateState } from './monster-spells.js';
import { isLegendary, freshLegendaryBudget } from './monster-legendary.js';
import { acFor } from './fighting-styles.js';
import { slotsForPc, pactForPc } from './reactions.js';
import {
  wrapperConditions, normalizeCondition, hasLifecycle, endsWithEncounter, PERSISTENT_ENDS_ON
} from './conditions.js';
import { withEngineFields } from './open5e-normalize.js';
import { featureLedgerFor } from './feature-uses.js';
import { ledgerKeyForResource, resourceKeyForLedger } from '../shared/run-state.js';
import { applyExhaustionToEntity, exhaustionEffects } from '../campaign/exhaustion.js';
import {
  buildStatBlockKit, freshKitInnate, kitInnateState, kitLegendaryResistance, LEGENDARY_RESISTANCE_KEY
} from './stat-block-kit.js';

/** Wrapper fields that are recomputed per turn and never persisted. */
export const TRANSIENT_WRAPPER_FIELDS = Object.freeze([
  'weapon', '_chosenWeapon', '_lastPlan', '_mctsTargetCtx', 'damageDealt', 'combatMods'
]);

/** Wrapper per-turn flag → EncounterState `turnFlags` key. */
const FLAG_FIELDS = Object.freeze([
  ['_sneakAttackUsedThisTurn', 'sneakUsed'],
  ['_cunningActionUsedThisTurn', 'cunningUsed'],
  ['_recklessUsedThisTurn', 'recklessUsed'],
  ['_recklessUntilNextTurn', 'recklessUntilNextTurn'],
  ['_shieldActive', 'shieldActive'],
  ['_surgeFiredThisTurn', 'surgeFired'],
  ['_extraActionThisTurn', 'extraAction'],
  ['_smiteSlotUsed', 'smiteSlotUsed'],
  ['_dodging', 'dodging'],
  ['_disengaged', 'disengaged'],
  ['_rageSustained', 'rageSustained']
]);

/** PC slot pools always expose levels 1-5 (the planner's upcast range). */
const PC_BASE_SLOT_LEVELS = [1, 2, 3, 4, 5];

const ENTITY_STATUS_SET = new Set(['active', 'downed', 'stable', 'dead']);

/**
 * Death-save tallies in the contract shape (ints clamped 0-3).
 * @param {object|null|undefined} ds
 * @returns {{successes: number, failures: number, stable: boolean}}
 */
export function normalizeDeathSaves(ds) {
  const n = (v) => Math.max(0, Math.min(3, Math.trunc(Number(v) || 0)));
  return { successes: n(ds?.successes), failures: n(ds?.failures), stable: !!(ds?.stable ?? ds?.isStabilized) };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const conditionId = (c) => (typeof c === 'string' ? c : c?.id);

/**
 * Remaining-count pool from a `{lvl: {max, spent}}` ledger.
 * @param {Record<string, {max: number, spent: number}>} ledger
 * @param {number[]} [baseLevels] — levels always present (0 when absent)
 * @returns {Record<string, number>}
 */
export function poolFromLedger(ledger = {}, baseLevels = []) {
  const out = {};
  for (const lvl of baseLevels) out[lvl] = 0;
  for (const [lvl, l] of Object.entries(ledger || {})) {
    out[lvl] = Math.max(0, (l?.max ?? 0) - (l?.spent ?? 0));
  }
  return out;
}

/**
 * Write a remaining-count pool back onto a ledger (new object). Levels the
 * ledger lacks are added only when they still hold slots (max = remaining).
 * @param {Record<string, {max: number, spent: number}>} ledger
 * @param {Record<string, number>|null|undefined} pool
 * @returns {Record<string, {max: number, spent: number}>}
 */
export function ledgerFromPool(ledger = {}, pool) {
  const out = clone(ledger || {}) || {};
  if (!pool || typeof pool !== 'object') return out;
  for (const [lvl, rawRemaining] of Object.entries(pool)) {
    if (!/^[1-9]$/.test(String(lvl))) continue;
    const remaining = Math.max(0, Math.trunc(Number(rawRemaining) || 0));
    const l = out[lvl];
    if (l) {
      const max = Math.max(l.max, remaining);
      out[lvl] = { max, spent: Math.min(max, Math.max(0, max - remaining)) };
    } else if (remaining > 0) {
      out[lvl] = { max: remaining, spent: 0 };
    }
  }
  return out;
}

/**
 * Build one engine wrapper from an EncounterState entity.
 *
 * @param {object} entity — EncounterState entity
 * @param {object|null} sheet — PCs: the parsed character (becomes `ref`);
 *   monsters: optional object used as `ref` (the browser passes its live
 *   monster record so cinema can draw it), default `{name, presetSlug}`
 * @returns {object} wrapper
 */
export function wrapperFromEntity(entity, sheet = null) {
  const e = entity;
  const res = e.resources || {};
  const flags = e.turnFlags || {};
  const conc = e.concentration
    ? {
        spellId: e.concentration.spellId,
        spellName: spellById(e.concentration.spellId)?.name || e.concentration.spellId,
        targetIds: [...(e.concentration.targetIds || [])]
      }
    : null;
  // M64 R7 — conditions stay string ids on the wrapper; lifecycle objects
  // ride `_conditionMeta`.
  const wc = wrapperConditions(e.conditions || []);
  const base = {
    id: e.id,
    name: e.name,
    kind: e.kind,
    hp: e.hp,
    hpMax: e.hpMax,
    hpTemp: e.hpTemp ?? 0,
    ac: e.ac,
    speedFt: e.speedFt ?? 30,
    conditions: wc.conditions,
    ...(Object.keys(wc.meta).length ? { _conditionMeta: wc.meta } : {}),
    damageDealt: 0,
    _reactionUsed: !!res.reactionUsed,
    _concentrating: conc,
    // M64 R9 — absent status = active; PCs always carry death-save tallies.
    status: ENTITY_STATUS_SET.has(e.status) ? e.status : 'active',
    deathSaves: e.kind === 'pc' ? normalizeDeathSaves(e.deathSaves) : null,
    // M65 T21 / T23 — exhaustion (static in an encounter; the resolver
    // reads level 3) and the run items carried, only when present.
    ...(Number.isInteger(e.exhaustion) && e.exhaustion > 0 ? { exhaustion: e.exhaustion } : {}),
    ...(res.items && typeof res.items === 'object' ? { _items: clone(res.items) } : {})
  };
  for (const [field, key] of FLAG_FIELDS) {
    base[field] = key === 'smiteSlotUsed' ? (flags[key] ?? null) : !!flags[key];
  }
  const pact = res.pact && Number.isInteger(res.pact.level)
    ? { level: res.pact.level, max: res.pact.max ?? 0, spent: res.pact.spent ?? 0 }
    : null;

  if (e.kind === 'pc') {
    if (!sheet) throw new Error(`encounter-adapters: no sheet for PC "${e.id}"`);
    const mainhand = sheet.equipment?.mainhand || null;
    const f = res.features || {};
    return {
      ref: sheet,
      ...base,
      weapon: mainhand,
      _chosenWeapon: mainhand,
      _position: { col: e.pos.col, row: e.pos.row },
      combatMods: sheet.combatMods || [],
      _slots: poolFromLedger(res.slots, PC_BASE_SLOT_LEVELS),
      _pact: pact,
      _actionSurgeUsed: f['action-surge']?.spent ?? 0,
      _secondWindUsed: (f['second-wind']?.spent ?? 0) > 0,
      // Every other limited-use ledger (Rage, granted spells' uses, …).
      _features: featuresWithout(f, LEGACY_FEATURE_KEYS)
    };
  }

  const sb = e.statBlock || {};
  const slug = sb.slug;
  const preset = MONSTER_PRESETS[slug] || {};
  const attacks = Array.isArray(sb.attacks) ? sb.attacks : [];
  const hasSlots = res.slots && Object.keys(res.slots).length > 0;
  const w = {
    ref: sheet || { name: e.name, presetSlug: slug },
    ...base,
    presetSlug: slug,
    attack: clone(attacks[0] || preset.attack || { name: 'Strike', bonus: 2, dice: '1d6' }),
    position: { col: e.pos.col, row: e.pos.row },
    _slots: hasSlots ? poolFromLedger(res.slots) : null,
    _pact: pact,
    _innate: res.innate ? clone(res.innate) : null,
    _legendaryBudget: res.legendaryBudget ?? 0
  };
  const secondary = attacks[1] || preset.secondary;
  if (secondary) w.secondary = clone(secondary);
  // M64 R10 — Multiattack: every stat-block attack record plus the
  // multiattack routine (E4's normaliser shape, see attackSequenceFor).
  // Static: read from the stat block, never written back.
  if (attacks.length > 2) w.attacks = clone(attacks);
  if (sb.multiattack && (Array.isArray(sb.multiattack) || typeof sb.multiattack === 'object')) {
    if (!w.attacks && attacks.length) w.attacks = clone(attacks);
    w.multiattack = clone(sb.multiattack);
  }
  if (sb.saves && typeof sb.saves === 'object') w.saves = { ...sb.saves };
  // M64 R8 — damage resistances / immunities / vulnerabilities from an
  // imported stat block (applyDamage reads them; PCs read their sheet).
  for (const key of ['resistances', 'immunities', 'vulnerabilities']) {
    if (Array.isArray(sb[key]) && sb[key].length) w[key] = clone(sb[key]);
  }
  if (sb.profile) w._aiProfile = clone(sb.profile);
  // M64 phase 1.5 wave 6b — a normalised SRD block drives recharge
  // abilities, legendary actions and Legendary Resistance (the preset
  // slug is then only the sprite). The kit is static and never persisted.
  const kit = buildStatBlockKit(sb);
  if (kit) {
    w._statBlockKit = kit;
    w._innate = kitInnateState(kit, res.innate);
    const lr = kitLegendaryResistance(kit, res.features?.[LEGENDARY_RESISTANCE_KEY]);
    if (lr) w._features = { ...featuresWithout(res.features, []), [LEGENDARY_RESISTANCE_KEY]: lr };
  }
  return w;
}

/**
 * Write one wrapper's mutable state back onto a COPY of its entity.
 * Fields the wrapper does not carry keep the entity's value, so a
 * partial wrapper (`{hp}`) is a valid input.
 *
 * @param {object} entity — EncounterState entity (not mutated)
 * @param {object} w — engine wrapper
 * @returns {object} the updated entity
 */
export function applyWrapperToEntity(entity, w) {
  const e = clone(entity);
  if (!w) return e;
  if (Number.isFinite(w.hp)) e.hp = Math.max(0, Math.min(e.hpMax, Math.trunc(w.hp)));
  if (Number.isFinite(w.hpTemp)) e.hpTemp = Math.max(0, Math.trunc(w.hpTemp));
  const pos = w._position || w.position;
  if (pos && Number.isFinite(pos.col) && Number.isFinite(pos.row)) {
    e.pos = { col: Math.trunc(pos.col), row: Math.trunc(pos.row) };
  }
  if (Array.isArray(w.conditions)) {
    const prior = new Map((entity.conditions || []).map(c => [conditionId(c), c]));
    const seen = new Set();
    e.conditions = [];
    for (const c of w.conditions) {
      const id = conditionId(c);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const meta = w._conditionMeta?.[id] ? normalizeCondition(w._conditionMeta[id]) : null;
      const before = prior.get(id);
      // An untouched lifecycle object keeps its exact stored form.
      if (meta && hasLifecycle(meta)) {
        e.conditions.push(typeof before === 'object' && JSON.stringify(normalizeCondition(before)) === JSON.stringify(meta) ? clone(before) : meta);
      }
      else if (w._conditionMeta && typeof prior.get(id) === 'object') e.conditions.push(id);
      else e.conditions.push(clone(prior.get(id) ?? id));
    }
  }
  // M64 R9 — status / deathSaves are stored only while not 'active'
  // (monsters never carry deathSaves).
  if (w.status !== undefined) {
    if (ENTITY_STATUS_SET.has(w.status) && w.status !== 'active') {
      e.status = w.status;
      if (e.kind === 'pc') e.deathSaves = normalizeDeathSaves(w.deathSaves);
      else delete e.deathSaves;
    } else {
      delete e.status;
      delete e.deathSaves;
    }
  }
  if (w._concentrating !== undefined) {
    e.concentration = w._concentrating
      ? { spellId: String(w._concentrating.spellId), targetIds: (w._concentrating.targetIds || []).map(String) }
      : null;
  }
  const res = e.resources;
  if (w._reactionUsed !== undefined) res.reactionUsed = !!w._reactionUsed;
  if (w._slots !== undefined) res.slots = ledgerFromPool(res.slots, w._slots);
  if (w._pact && Number.isInteger(w._pact.level)) {
    const max = Math.max(0, w._pact.max ?? 0);
    res.pact = { level: w._pact.level, max, spent: Math.min(max, Math.max(0, w._pact.spent ?? 0)) };
  }
  if (w._innate !== undefined) res.innate = w._innate ? clone(w._innate) : null;
  if (w._legendaryBudget !== undefined) res.legendaryBudget = Math.max(0, Math.trunc(w._legendaryBudget || 0));
  if (w._features && typeof w._features === 'object') {
    for (const [key, l] of Object.entries(w._features)) {
      if (LEGACY_FEATURE_KEYS.includes(key) || !l) continue;
      const max = Math.max(1, Math.trunc(Number(l.max) || 0));
      (res.features || (res.features = {}))[key] = { max, spent: Math.max(0, Math.min(max, Math.trunc(Number(l.spent) || 0))) };
    }
  }
  // M65 T23 — run items: only `spent` changes in an encounter.
  if (w._items && typeof w._items === 'object' && res.items) {
    for (const [id, it] of Object.entries(res.items)) {
      const live = w._items[id];
      if (live) it.spent = Math.max(0, Math.min(it.max, Math.trunc(Number(live.spent) || 0)));
    }
  }
  if (w._actionSurgeUsed !== undefined) setFeature(res, 'action-surge', Math.trunc(w._actionSurgeUsed || 0));
  if (w._secondWindUsed !== undefined) setFeature(res, 'second-wind', w._secondWindUsed ? 1 : 0);
  // turnFlags are sparse: only set flags (true / a smite level) are stored.
  const flags = { ...(e.turnFlags || {}) };
  for (const [field, key] of FLAG_FIELDS) {
    if (w[field] === undefined) continue;
    const v = key === 'smiteSlotUsed' ? (Number.isInteger(w[field]) ? w[field] : null) : !!w[field];
    if (v) flags[key] = v;
    else delete flags[key];
  }
  e.turnFlags = flags;
  if (e.kind === 'monster' && w._aiProfile !== undefined && e.statBlock) {
    if (w._aiProfile) e.statBlock.profile = clone(w._aiProfile);
    else delete e.statBlock.profile;
  }
  return e;
}

/** Feature ledgers owned by legacy wrapper fields (_actionSurgeUsed, _secondWindUsed). */
const LEGACY_FEATURE_KEYS = Object.freeze(['action-surge', 'second-wind']);

function featuresWithout(features, skip) {
  const out = {};
  for (const [k, l] of Object.entries(features || {})) {
    if (!skip.includes(k) && l) out[k] = { max: l.max ?? 0, spent: l.spent ?? 0 };
  }
  return out;
}

function setFeature(res, id, spent) {
  const features = res.features || (res.features = {});
  const prior = features[id];
  if (!prior && spent <= 0) return;
  const max = Math.max(prior?.max ?? 0, spent, 1);
  features[id] = { max, spent: Math.max(0, Math.min(max, spent)) };
}

/**
 * Build engine wrappers for every entity in an EncounterState and split
 * them around the acting entity.
 *
 * @param {object} state — EncounterState v1
 * @param {Record<string, object>} [sheets] — parsed character sheets keyed
 *   by `sheetRef.characterId` (or entity id); monsters may also have an
 *   entry keyed by entity id, used as the wrapper's `ref`
 * @param {string|null} [activeId] — the entity taking the turn
 * @returns {{active: object|null, enemies: object[], allies: object[],
 *            wrappers: object[], byId: Map<string, object>,
 *            scene: {cols: number, rows: number, cellFt: number, flankingEnabled: boolean, terrain: object|null}}}
 *   `allies` includes the active entity; with no activeId both are empty.
 */
export function toEngineSides(state, sheets = {}, activeId = null) {
  const entities = Object.values(state?.entities || {});
  const lookup = sheets || {};
  const wrappers = entities.map(e => {
    const sheet = e.kind === 'pc'
      ? (lookup[e.sheetRef?.characterId] ?? lookup[e.id] ?? null)
      : (lookup[e.id] ?? null);
    return wrapperFromEntity(e, sheet);
  });
  const byId = new Map(wrappers.map(w => [w.id, w]));
  const active = activeId != null ? (byId.get(String(activeId)) || null) : null;
  const side = active ? state.entities[active.id].side : null;
  const allies = active ? wrappers.filter(w => state.entities[w.id].side === side) : [];
  const enemies = active ? wrappers.filter(w => state.entities[w.id].side !== side) : [];
  const grid = state?.grid || {};
  return {
    active, enemies, allies, wrappers, byId,
    scene: {
      cols: grid.cols, rows: grid.rows, cellFt: grid.cellFt ?? 5,
      flankingEnabled: !!grid.flankingEnabled,
      terrain: grid.terrain ?? null
    }
  };
}

/**
 * Write every wrapper back into a NEW EncounterState. Wrappers whose id is
 * not in the state are ignored; the input state is never mutated.
 *
 * @param {object} state — EncounterState v1
 * @param {object[]} wrappers — engine wrappers (any subset)
 * @returns {object} the next EncounterState
 */
export function applyEngineSides(state, wrappers = []) {
  const next = { ...state, entities: { ...state.entities } };
  for (const w of wrappers || []) {
    const id = w?.id != null ? String(w.id) : null;
    if (!id || !next.entities[id]) continue;
    next.entities[id] = applyWrapperToEntity(next.entities[id], w);
  }
  return next;
}

/**
 * Copy of a wrapper without its transient fields (no `ref`, no
 * `_mctsTargetCtx`, …): what a wrapper looks like once serialised.
 * @param {object} w
 * @returns {object}
 */
export function stripTransient(w) {
  const out = {};
  for (const [k, v] of Object.entries(w || {})) {
    if (k === 'ref' || TRANSIENT_WRAPPER_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The dynamic part of an EncounterState (what a state hash should cover):
 * every entity without its static `sheetRef` / `statBlock`, plus round,
 * turn index and initiative.
 * @param {object} state
 * @returns {object}
 */
export function dynamicStateOf(state) {
  const entities = {};
  for (const [id, e] of Object.entries(state?.entities || {})) {
    const { sheetRef: _s, statBlock: _b, ...rest } = e;
    entities[id] = rest;
  }
  return {
    round: state?.round ?? 0,
    turnIndex: state?.turnIndex ?? 0,
    initiative: state?.initiative || [],
    entities
  };
}

// ---------------------------------------------------------------------
// Entity builders (encounter setup: the server and tests build
// EncounterState entities from sheets and presets with these)
// ---------------------------------------------------------------------

function fullLedger(pool) {
  const out = {};
  for (const [lvl, n] of Object.entries(pool || {})) {
    if (/^[1-9]$/.test(String(lvl)) && n > 0) out[lvl] = { max: n, spent: 0 };
  }
  return out;
}

function fighterLevel(sheet) {
  return (sheet?.classes || []).filter(c => /fighter/i.test(c?.name || ''))
    .reduce((a, c) => a + (Number(c.level) || 0), 0);
}

/**
 * A fully rested PC entity from a parsed character sheet. Slot maxima
 * come from the sheet (`spellSlotTable` when the parser provides it, else
 * the slotsForPc estimate); Action Surge / Second Wind ledgers for
 * fighters.
 *
 * M65 T21 — with `opts.runState` (state_json v1) the entity starts from the
 * run's state instead of rested: HP and temp HP, spent slots and pact
 * slots, feature / granted-spell uses (resource key map in the module
 * header), death saves (0 HP → downed / stable / dead), exhaustion
 * (campaign/exhaustion.js applyExhaustionToEntity — 2: speed halved, 4: HP
 * max halved, 5: speed 0, 6: dead) and the persistent
 * conditions. Maxima always come from the sheet. `opts.items` (run items
 * the PC carries, `{[runItemId]: {name, effect?, max, spent?}}`, `effect`
 * a consumables-registry key) becomes
 * `resources.items` (M65 T23). Without either option the result is the
 * phase-1.5 rested entity, unchanged.
 *
 * @param {object} sheet — parseCharacter output (`id`, `hp`, `classes`, …)
 * @param {{id?: string, side?: 'party'|'hostile', pos: {col: number, row: number},
 *          controller?: {type: 'player'|'ai'|'dm', seatId: string|null},
 *          speedFt?: number, rev?: number|string,
 *          runState?: object|null,
 *          items?: Record<string, {name: string, effect?: string, max: number, spent?: number}>|null}} opts
 * @returns {object} EncounterState entity (sheetRef.characterId = String(sheet.id))
 */
export function entityFromSheet(sheet, opts) {
  const entity = restedEntityFromSheet(sheet, opts);
  const items = normalizeItems(opts?.items);
  if (items) entity.resources.items = items;
  return opts?.runState ? seedFromRunState(entity, opts.runState) : entity;
}

function restedEntityFromSheet(sheet, opts) {
  const max = Math.max(1, Math.trunc(sheet?.hp?.max ?? 1));
  const pact = pactForPc(sheet);
  const fl = fighterLevel(sheet);
  // Granted spells' own uses and sheet featureUses (Rage, …), fully rested.
  const features = featureLedgerFor(sheet);
  if (fl >= 2) features['action-surge'] = { max: fl >= 17 ? 2 : 1, spent: 0 };
  if (fl >= 1) features['second-wind'] = { max: 1, spent: 0 };
  return {
    id: String(opts?.id ?? sheet.id),
    kind: 'pc',
    side: opts?.side || 'party',
    name: String(sheet?.name || 'PC'),
    controller: opts?.controller || { type: 'ai', seatId: null },
    pos: { col: opts.pos.col, row: opts.pos.row },
    hp: max,
    hpMax: max,
    hpTemp: 0,
    ac: acFor(sheet),
    speedFt: Math.trunc(opts?.speedFt ?? sheet?.speedFt ?? sheet?.speed ?? 30) || 30,
    conditions: [],
    concentration: null,
    resources: {
      reactionUsed: false,
      slots: fullLedger(slotsForPc(sheet)),
      pact: pact ? { level: pact.level, max: pact.max, spent: 0 } : {},
      innate: null,
      legendaryBudget: 0,
      features
    },
    turnFlags: {},
    sheetRef: { characterId: String(sheet.id), rev: opts?.rev ?? 0 }
  };
}

// ---------------------------------------------------------------------
// M65 T21 — run state (state_json v1) ⇄ entity
// ---------------------------------------------------------------------

/** Run-state resource prefixes whose ledgers the engine spends. */
export const ENGINE_RESOURCE_PREFIXES = Object.freeze(['feat:', 'spell:']);

/** Default recovery periods (rest.js vocabulary) of ledgers the engine creates. */
const DEFAULT_RECOVERY = Object.freeze({
  'action-surge': ['sr'],
  'second-wind': ['sr'],
  'channel-divinity': ['sr'],
  rage: ['lr'],
  [LEGENDARY_RESISTANCE_KEY]: ['day']
});

/**
 * The entity `resources.features` key of a run-state resource key, or null
 * when the engine does not model it (`ddb:*`, `item:*`, `dm:*`).
 * @param {string} runKey — e.g. 'feat:action-surge', 'spell:misty-step'
 * @returns {string|null}
 */
export function featureKeyForRunResource(runKey) {
  const k = String(runKey || '');
  const prefix = ENGINE_RESOURCE_PREFIXES.find(p => k.startsWith(p));
  if (!prefix || k.length === prefix.length) return null;
  return ledgerKeyForResource(k);
}

/**
 * The run-state resource key of an entity feature ledger key.
 * @param {string} featureKey — e.g. 'action-surge', 'spell:misty-step'
 * @returns {string}
 */
export function runResourceKeyForFeature(featureKey) {
  return resourceKeyForLedger(String(featureKey || ''));
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0)));
}

/** Lifecycle fields a run-state `conditionMeta` entry hands to an entity condition. */
const CONDITION_LIFECYCLE_KEYS = Object.freeze(['sourceId', 'save', 'appliedRound']);

function lifecycleOf(c) {
  if (!c || typeof c !== 'object') return {};
  const out = {};
  for (const k of CONDITION_LIFECYCLE_KEYS) if (c[k] !== undefined && c[k] !== null) out[k] = clone(c[k]);
  return out;
}

export { endsWithEncounter };

/** Item name → consumables-registry key ("Potion of Healing" → 'potion-of-healing'). */
function itemKeyOf(name) {
  return String(name || '').toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * `resources.items` from a run-item map (null when empty / absent).
 * `effect` is a consumables-registry key (EncounterState v1, H23); a
 * missing one is the item name's key.
 */
function normalizeItems(items) {
  if (!items || typeof items !== 'object') return null;
  const out = {};
  for (const [id, it] of Object.entries(items)) {
    if (!it || typeof it !== 'object') continue;
    const max = Math.max(0, Math.trunc(Number(it.max) || 0));
    const name = String(it.name || id).slice(0, 128);
    out[String(id)] = {
      name,
      effect: (typeof it.effect === 'string' && it.effect ? it.effect : itemKeyOf(name)).slice(0, 64),
      max,
      spent: clampInt(it.spent, 0, max)
    };
  }
  return Object.keys(out).length ? out : null;
}

/** Seed a rested PC entity (mutated, then returned) from state_json v1. */
function seedFromRunState(rested, rs) {
  // Exhaustion (E4's campaign/exhaustion.js, the one table): speed, HP max
  // and level-6 death are seeded here; the attack / save disadvantage is
  // read off the entity by the resolver and saveModeFor.
  const entity = applyExhaustionToEntity(rested, rs.exhaustion);
  const res = entity.resources;
  const fx = exhaustionEffects(rs.exhaustion);
  const storedHp = rs.hp?.current;
  const startHp = fx.dead ? 0
    : (storedHp !== null && storedHp !== undefined && Number.isFinite(Number(storedHp)))
      ? clampInt(storedHp, 0, entity.hpMax) : entity.hpMax;
  entity.hp = startHp;   // run state → entity (construction, not a hit)
  entity.hpTemp = Math.max(0, Math.trunc(Number(rs.hp?.temp) || 0));
  // Slots: spent only; maxima stay the sheet's.
  const spell = rs.slots?.spell || {};
  for (const [lvl, l] of Object.entries(res.slots)) {
    if (spell[lvl]) l.spent = clampInt(spell[lvl].spent, 0, l.max);
  }
  if (Number.isInteger(res.pact?.level) && rs.slots?.pact) {
    res.pact.spent = clampInt(rs.slots.pact.spent, 0, res.pact.max);
  }
  for (const [key, r] of Object.entries(rs.resources || {})) {
    const fk = featureKeyForRunResource(key);
    if (!fk || !r || typeof r !== 'object') continue;
    const ledger = res.features[fk];
    if (ledger) ledger.spent = clampInt(r.spent, 0, ledger.max);
    else if (Math.trunc(Number(r.max) || 0) > 0) {
      const max = Math.trunc(Number(r.max));
      res.features[fk] = { max, spent: clampInt(r.spent, 0, max) };
    }
  }
  // M65 T22 — a DM-marked persistent condition (conditionMeta.persistent)
  // enters as `endsOn: 'persistent'` and survives the encounter; any other
  // (a DDB import's 'poisoned') keeps its stored lifecycle and ends with it.
  const meta = rs.conditionMeta || {};
  const seen = new Set();
  for (const c of Array.isArray(rs.conditions) ? rs.conditions : []) {
    const id = conditionId(c);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const m = meta[id] && typeof meta[id] === 'object' ? meta[id] : {};
    const life = { ...lifecycleOf(m), ...lifecycleOf(c) };
    if (m.persistent === true) entity.conditions.push({ id: String(id), ...life, endsOn: PERSISTENT_ENDS_ON });
    else if (Object.keys(life).length || m.endsOn) entity.conditions.push({ id: String(id), ...life, ...(m.endsOn ? { endsOn: m.endsOn } : {}) });
    else entity.conditions.push(String(id));
  }
  // Life: exhaustion 6 kills; 0 HP is dying (or stable / dead by the tallies).
  const ds = normalizeDeathSaves(rs.deathSaves);
  if (fx.dead) {
    entity.status = 'dead';   // applyExhaustionToEntity: hp 0, three failures
  } else if (entity.hp === 0) {
    entity.status = ds.failures >= 3 ? 'dead' : ds.stable ? 'stable' : 'downed';
    entity.deathSaves = ds;
    if (entity.status !== 'dead' && !seen.has('unconscious')) entity.conditions.push('unconscious');
  }
  return entity;
}

/** Label for a ledger the engine adds to a run state. */
function ledgerLabel(featureKey) {
  if (featureKey.startsWith('spell:')) {
    const id = featureKey.slice(6);
    return spellById(id)?.name || id;
  }
  return featureKey.split('-').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * Write an encounter's result for one PC back onto its run state
 * (state_json v1). Returns a NEW state; `prevState` is never mutated and
 * every key the engine does not own (hit dice, currency, inspiration,
 * `ddb:*` resources, labels / maxima / recovery, unknown keys) is kept as
 * it was. Engine-owned keys:
 *   hp {current, temp}; deathSaves (reset while active); slots.spell[lvl].spent
 *   and slots.pact.spent; resources[key].spent for every mapped ledger (a
 *   ledger the state lacks is added, `{label, max, spent, recovery}`, only
 *   once something is spent); conditions + conditionMeta (only the
 *   `endsOn: 'persistent'` conditions, each with `persistent: true` and
 *   its stored meta kept); exhaustion; concentration.
 * `prevState` should be a full state_json v1 (initialRunState): the
 * output then validates with validateRunState.
 *
 * @param {object} entity — EncounterState PC entity (after the encounter)
 * @param {object} [prevState] — the run state the encounter started from
 * @returns {object} state_json v1
 */
export function runStateFromEntity(entity, prevState = {}) {
  const prev = prevState && typeof prevState === 'object' ? prevState : {};
  const out = clone(prev) || {};
  if (out.schema_v === undefined) out.schema_v = 1;
  const e = entity || {};
  const res = e.resources || {};
  out.hp = { ...(prev.hp || {}), current: Math.max(0, Math.trunc(e.hp ?? 0)), temp: Math.max(0, Math.trunc(e.hpTemp ?? 0)) };
  const status = ENTITY_STATUS_SET.has(e.status) ? e.status : 'active';
  const ds = status === 'active'
    ? { successes: 0, failures: 0, stable: false }
    : normalizeDeathSaves({ ...e.deathSaves, stable: status === 'stable' || !!e.deathSaves?.stable });
  out.deathSaves = { ...(prev.deathSaves || {}), ...ds };

  const slots = { ...(out.slots || {}) };
  const spell = { ...(slots.spell || {}) };
  for (const [lvl, l] of Object.entries(res.slots || {})) {
    const spent = clampInt(l?.spent, 0, l?.max ?? 0);
    if (spell[lvl] || spent > 0) spell[lvl] = { ...(spell[lvl] || {}), spent };
  }
  slots.spell = spell;
  if (Number.isInteger(res.pact?.level)) {
    const spent = clampInt(res.pact.spent, 0, res.pact.max ?? 0);
    if (slots.pact || spent > 0) slots.pact = { ...(slots.pact || {}), spent };
  }
  out.slots = slots;

  const resources = { ...(out.resources || {}) };
  for (const [fk, l] of Object.entries(res.features || {})) {
    if (!l) continue;
    const rk = runResourceKeyForFeature(fk);
    const spent = clampInt(l.spent, 0, Math.max(0, Math.trunc(Number(l.max) || 0)));
    if (resources[rk]) resources[rk] = { ...resources[rk], spent };
    else if (spent > 0) {
      resources[rk] = {
        label: ledgerLabel(fk), max: Math.trunc(Number(l.max) || 0), spent,
        recovery: [...(DEFAULT_RECOVERY[fk] || ['lr'])]
      };
    }
  }
  out.resources = resources;

  const conditions = [];
  const conditionMeta = {};
  const prevMeta = prev.conditionMeta || {};
  for (const c of e.conditions || []) {
    const id = conditionId(c);
    if (!id || conditions.includes(id) || endsWithEncounter(c)) continue;
    conditions.push(id);
    conditionMeta[id] = { ...(prevMeta[id] || {}), ...lifecycleOf(c), persistent: true };
  }
  out.conditions = conditions;
  out.conditionMeta = conditionMeta;
  out.exhaustion = Number.isInteger(e.exhaustion) ? e.exhaustion : clampInt(prev.exhaustion, 0, 6);
  out.concentration = e.concentration ? clone(e.concentration) : null;
  return out;
}

/**
 * Uses spent from each run item the PC carried (`resources.items`), for
 * the run controller's `run_items` write-back: `{[runItemId]: spent}`.
 * @param {object} entity
 * @returns {Record<string, number>}
 */
export function itemSpendFromEntity(entity) {
  const out = {};
  for (const [id, it] of Object.entries(entity?.resources?.items || {})) {
    out[id] = clampInt(it?.spent, 0, it?.max ?? 0);
  }
  return out;
}

/**
 * A fresh monster entity from a MONSTER_PRESETS slug, optionally with an
 * imported stat block (`{name, ac, hpMax, attacks[], saves{}, profile}`)
 * layered over the preset. A normalised Open5e block (`normalizeCreature`,
 * M64 R11) also gets `hpMax` from `hp.average` and engine `attacks[]`
 * from its weapon actions when the caller has not set them.
 *
 * @param {string} slug — preset slug (also the sprite)
 * @param {{id: string, side?: 'party'|'hostile', pos: {col: number, row: number},
 *          name?: string, statBlock?: object, controller?: object, speedFt?: number}} opts
 * @returns {object} EncounterState entity
 */
export function entityFromPreset(slug, opts) {
  const preset = MONSTER_PRESETS[slug];
  if (!preset) throw new Error(`encounter-adapters: unknown monster preset "${slug}"`);
  const sb = opts?.statBlock ? withEngineFields(clone(opts.statBlock)) : {};
  const max = Math.max(1, Math.trunc(sb.hpMax ?? preset.defaultHp?.max ?? 1));
  // M64 phase 1.5 wave 6b — a normalised block's own recharge abilities,
  // legendary budget and Legendary Resistance replace the preset's.
  const kit = buildStatBlockKit(sb);
  const lr = kitLegendaryResistance(kit, null);
  return {
    id: String(opts.id),
    kind: 'monster',
    side: opts?.side || 'hostile',
    name: String(opts?.name || sb.name || preset.name),
    controller: opts?.controller || { type: 'ai', seatId: null },
    pos: { col: opts.pos.col, row: opts.pos.row },
    hp: max,
    hpMax: max,
    hpTemp: 0,
    ac: Math.trunc(sb.ac ?? preset.ac ?? 12),
    speedFt: Math.trunc(opts?.speedFt ?? sb.speedFt ?? preset.speedFt ?? 30) || 30,
    conditions: [],
    concentration: null,
    resources: {
      reactionUsed: false,
      // M65 leftover B — a block's own spellcasting brings its slots.
      slots: fullLedger(kit?.spellbook ? kit.spellbook.slots : freshSlots(slug)),
      pact: {},
      innate: kit ? freshKitInnate(kit) : freshInnateState(slug),
      legendaryBudget: kit ? (kit.legendary?.budget ?? 0) : (isLegendary(slug) ? freshLegendaryBudget(slug) : 0),
      features: lr ? { [LEGENDARY_RESISTANCE_KEY]: lr } : {}
    },
    turnFlags: {},
    statBlock: { ...sb, slug }
  };
}

// ---------------------------------------------------------------------
// M64 T8 — DM edits on an EncounterState (pure)
// ---------------------------------------------------------------------

/**
 * Set an entity's HP (clamped to [0, hpMax]). Returns a NEW state plus the
 * before/after values for the dm.override event; an unknown id returns
 * the input state unchanged with `entity: null`.
 * @param {object} state — EncounterState
 * @param {string} entityId
 * @param {number} hp
 * @returns {{state: object, entity: object|null, before: number|null, after: number|null}}
 */
export function setEntityHp(state, entityId, hp) {
  const e = state?.entities?.[String(entityId)];
  if (!e) return { state, entity: null, before: null, after: null };
  const after = Math.max(0, Math.min(e.hpMax, Math.trunc(Number(hp) || 0)));
  const entity = { ...clone(e), hp: after };
  // M64 R9 — a DM HP edit flips the life status silently (setHpRaw rules).
  if (after > 0 && e.status && e.status !== 'active') {
    delete entity.status;
    delete entity.deathSaves;
    entity.conditions = (entity.conditions || []).filter(c => conditionId(c) !== 'unconscious');
  } else if (after <= 0 && e.hp > 0 && (!e.status || e.status === 'active')) {
    if (e.kind === 'pc') {
      entity.status = 'downed';
      entity.deathSaves = { successes: 0, failures: 0, stable: false };
      if (!(entity.conditions || []).some(c => conditionId(c) === 'unconscious')) entity.conditions = [...(entity.conditions || []), 'unconscious'];
    } else {
      entity.status = 'dead';
    }
  }
  return { state: { ...state, entities: { ...state.entities, [e.id]: entity } }, entity, before: e.hp, after };
}

/**
 * Replace an entity's conditions (strings or R7 objects; duplicates by id
 * dropped). Returns a NEW state plus before/after condition ids.
 * @param {object} state — EncounterState
 * @param {string} entityId
 * @param {Array<string|{id: string}>} conditions
 * @returns {{state: object, entity: object|null, before: string[]|null, after: string[]|null}}
 */
export function setEntityConditions(state, entityId, conditions) {
  const e = state?.entities?.[String(entityId)];
  if (!e) return { state, entity: null, before: null, after: null };
  const seen = new Set();
  const next = [];
  for (const c of conditions || []) {
    const id = conditionId(c);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(clone(c));
  }
  const entity = { ...clone(e), conditions: next };
  return {
    state: { ...state, entities: { ...state.entities, [e.id]: entity } },
    entity,
    before: (e.conditions || []).map(conditionId),
    after: next.map(conditionId)
  };
}
