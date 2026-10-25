/**
 * M65 H24 — run golden harness: drives a scripted campaign run through
 * the pure campaign layer and the real combat engine, without ws, rooms
 * or SQL. It is what the server's run controller (B24) does, minus
 * persistence, so a run is reproducible from its seed and its events.
 *
 * Script: src/tests/fixtures/runs/<name>.run.json
 *   { name, runId, seed, party: [{slotId, seat, fixture, xp?}], campaign
 *     (campaign v1, validated), steps: [...] }
 * Steps:
 *   { t: 'enter', nodeId }        the first node (or a DM override)
 *   { t: 'advance', to? }         take an offered edge (nextNodes); `to`
 *                                 must be one of them; default the first
 *   { t: 'fight', maxRounds? }    the current encounter node, every
 *                                 creature AI-driven, to its end
 *   { t: 'rest', type?, spend? }  the current rest node; spend =
 *                                 {slotId: {Class: hitDice}}
 *   { t: 'level', slotId, picks? } between nodes: apply the slot's next
 *                                 queued level (adapter.planLevelUp /
 *                                 applyLevelUp, R26; hit points rolled on
 *                                 the run rng when hpOnLevel is 'roll')
 *   { t: 'end', outcome }         run.ended
 *
 * Randomness: one run RNG (mulberry32, `seed`). Each encounter draws its
 * own seed from it; rests roll hit dice from it (M65 decision 6).
 *
 * The campaign rules (E4: src/js/campaign/*) and the run-state seam (E1:
 * T21) arrive in Wave 1, so the driver takes them through an ADAPTER:
 *
 *   entityFromSheet(sheet, {id, pos, rev, controller, runState})
 *       → EncounterState entity seeded from state_json            (T21)
 *   runStateFromEntity(entity, prevState) → state_json            (T21)
 *   encounterXp(defeated: statBlock[], participants: {id, lifeStatus}[],
 *       {mode}) → {total, awards: {slotId: xp}}                   (R24)
 *   levelForXp(xp) → level 1–20                                   (R24)
 *   applyRest(sheet, state, 'short'|'long',
 *       {spend, rng, dawnIsLongRest, lifeStatus})
 *       → {state, rolls}  (throws on an illegal rest)             (R25)
 *   settleAfterEncounter(state, {outcome: RUN_OUTCOMES, deathMode})
 *       → {state, lifeStatus}  after write-back                   (R28)
 *   endEncounterCleanup?(ts)       optional, before write-back    (T22)
 *   planLevelUp?(sheet, state, {settings}) /
 *   applyLevelUp?(sheet, state, plan, picks, {rng})
 *       → {sheet, state}    optional, only for 'level' steps       (R26)
 *
 * The signatures are E4's and E1's as merged, so the real modules plug in
 * unwrapped. The engine ends an encounter with an ENCOUNTER_OUTCOMES value
 * ('party-victory', …); R28 settles on the run vocabulary ('victory', …),
 * so the driver maps it (`settleOutcomeOf`) as the run controller must.
 *
 * `referenceAdapter` implements the interface with SRD rules written out
 * here (test-only) so the two can be compared; run-golden.test.js runs it
 * and the real adapter (E4's + E1's modules) side by side.
 */

import { createRng } from '../../js/scene/rng.js';
import { entityFromSheet as restedEntityFromSheet, entityFromPreset } from '../../js/scene/encounter-adapters.js';
import * as TM from '../../js/scene/turn-manager.js';
import { emptyEncounterState, validateEncounterState } from '../../js/shared/encounter-state.js';
import { validateEvent, validateEventLog } from '../../js/shared/events.js';
import { validateCampaign, nextNodes, campaignSettings } from '../../js/shared/campaign.js';
import {
  initialRunState, validateRunState, ledgerKeyForResource, resourceKeyForLedger
} from '../../js/shared/run-state.js';
import { makeRunEvent, validateRunEvent, validateRunEventLog } from '../../js/shared/run-events.js';
import { stateHash, canonicalJson, hash53 } from '../../js/shared/state-hash.js';
import { parsedDdbFixture } from './entities.js';
import { readFileSync } from 'node:fs';

const FIXTURE_DIR = new URL('../fixtures/runs/', import.meta.url);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Adapter methods the driver calls (`endEncounterCleanup` is optional). */
export const RUN_ADAPTER_METHODS = Object.freeze([
  'entityFromSheet', 'runStateFromEntity', 'encounterXp', 'levelForXp', 'applyRest', 'settleAfterEncounter'
]);

/**
 * Engine encounter outcome (events.js ENCOUNTER_OUTCOMES) → the run
 * vocabulary R28's settleAfterEncounter takes (run-state RUN_OUTCOMES).
 * @param {string} outcome
 * @returns {'victory'|'defeat'|'abandoned'}
 */
export function settleOutcomeOf(outcome) {
  if (outcome === 'party-victory') return 'victory';
  if (outcome === 'hostile-victory') return 'defeat';
  return 'abandoned';
}

/**
 * Throw unless `adapter` implements every required method.
 * @param {object} adapter
 */
export function assertRunAdapter(adapter) {
  const missing = RUN_ADAPTER_METHODS.filter(m => typeof adapter?.[m] !== 'function');
  if (missing.length) throw new Error(`run adapter is missing ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------
// The reference adapter (test-only SRD rules over today's engine)
// ---------------------------------------------------------------------

/** SRD 5.1 p.56 XP thresholds, index = level - 1. */
export const SRD_XP_THRESHOLDS = Object.freeze([
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000
]);
const CR_XP = { 0: 10, '1/8': 25, '1/4': 50, '1/2': 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900 };
const PRESET_XP = { goblin: 50, bugbear: 200, orc: 100, hobgoblin: 100, kobold: 25, bandit: 25, cultist: 25, skeleton: 50, zombie: 50, gnoll: 100 };

/** @type {object} — see the module header for the interface. */
export const referenceAdapter = Object.freeze({
  entityFromSheet(sheet, { runState, ...opts }) {
    const e = restedEntityFromSheet(sheet, opts);
    if (!runState) return e;
    e.hp = Math.min(e.hpMax, runState.hp.current);
    e.hpTemp = runState.hp.temp;
    for (const [lvl, l] of Object.entries(e.resources.slots)) l.spent = Math.min(l.max, runState.slots.spell[lvl]?.spent ?? 0);
    if (Number.isInteger(e.resources.pact.max)) e.resources.pact.spent = Math.min(e.resources.pact.max, runState.slots.pact.spent);
    for (const [key, r] of Object.entries(runState.resources)) {
      const l = e.resources.features[ledgerKeyForResource(key)];
      if (l) l.spent = Math.min(l.max, r.spent);
    }
    if (runState.exhaustion > 0) e.exhaustion = runState.exhaustion;
    e.conditions = [...runState.conditions];
    if (e.hp === 0) {
      e.status = runState.deathSaves.stable ? 'stable' : 'downed';
      e.deathSaves = { ...runState.deathSaves };
      e.conditions.push('unconscious');
    }
    return e;
  },

  runStateFromEntity(entity, prev) {
    const next = clone(prev);
    next.hp = { current: entity.hp, temp: entity.hpTemp };
    for (const [lvl, l] of Object.entries(entity.resources.slots)) {
      if (next.slots.spell[lvl]) next.slots.spell[lvl].spent = l.spent;
    }
    if (Number.isInteger(entity.resources.pact.spent)) next.slots.pact.spent = entity.resources.pact.spent;
    for (const [key, l] of Object.entries(entity.resources.features)) {
      const r = next.resources[resourceKeyForLedger(key)];
      if (r) r.spent = Math.min(r.max, l.spent);
    }
    const ds = entity.deathSaves;
    next.deathSaves = entity.hp > 0 || !ds
      ? { successes: 0, failures: 0, stable: false }
      : { successes: ds.successes, failures: ds.failures, stable: !!ds.stable || entity.status === 'stable' };
    // Encounter-scoped conditions and concentration end with the encounter;
    // only the DM-marked persistent ones carry over.
    next.conditions = prev.conditions.filter(c => prev.conditionMeta[c]?.persistent === true);
    next.conditionMeta = Object.fromEntries(Object.entries(prev.conditionMeta).filter(([c]) => next.conditions.includes(c)));
    next.concentration = null;
    next.exhaustion = entity.exhaustion ?? prev.exhaustion;
    return next;
  },

  encounterXp(defeated, participants) {
    const total = defeated.reduce((n, sb) => n + (Number.isInteger(sb.xp) ? sb.xp : (CR_XP[sb.cr] ?? PRESET_XP[sb.slug] ?? 25)), 0);
    const ids = participants.filter(p => p.lifeStatus !== 'dead').map(p => String(p.id));
    const each = ids.length ? Math.floor(total / ids.length) : 0;
    return { total, awards: Object.fromEntries(ids.map(id => [id, each])) };
  },

  levelForXp(xp) {
    let level = 1;
    for (let i = 0; i < SRD_XP_THRESHOLDS.length; i++) if (xp >= SRD_XP_THRESHOLDS[i]) level = i + 1;
    return level;
  },

  applyRest(sheet, state, type, { spend = {}, rng, dawnIsLongRest = true, lifeStatus }) {
    if (lifeStatus === 'dead') throw new Error('applyRest: a dead character cannot rest');
    const next = clone(state);
    const hpMax = sheet.hp.max;
    const con = sheet.abilityModifiers?.CON ?? 0;
    const rolls = [];
    const recovers = new Set(type === 'long'
      ? ['sr', 'lr', ...(dawnIsLongRest ? ['dawn', 'day'] : [])]
      : ['sr']);
    if (type === 'short') {
      for (const [cls, n] of Object.entries(spend)) {
        const hd = next.hitDice[cls];
        const level = (sheet.classes || []).filter(c => c.name === cls).reduce((a, c) => a + c.level, 0);
        if (!hd || hd.spent + n > level) throw new Error(`applyRest: cannot spend ${n} ${cls} hit dice`);
        for (let i = 0; i < n; i++) {
          const roll = 1 + Math.floor(rng() * hd.die);
          rolls.push({ cls, die: hd.die, roll });
          next.hp.current = Math.min(hpMax, next.hp.current + Math.max(0, roll + con));
        }
        hd.spent += n;
      }
      next.slots.pact.spent = 0;
    } else {
      if (state.hp.current < 1) throw new Error('applyRest: a long rest needs at least 1 HP');
      next.hp = { current: hpMax, temp: 0 };
      const total = Object.values(next.hitDice).length;
      let back = Math.max(1, Math.floor((sheet.level || total) / 2));
      for (const hd of Object.values(next.hitDice)) { const r = Math.min(hd.spent, back); hd.spent -= r; back -= r; }
      for (const l of Object.values(next.slots.spell)) l.spent = 0;
      next.slots.pact.spent = 0;
      next.exhaustion = Math.max(0, next.exhaustion - 1);
      next.deathSaves = { successes: 0, failures: 0, stable: false };
    }
    for (const r of Object.values(next.resources)) if (r.recovery.some(p => recovers.has(p))) r.spent = 0;
    return { state: next, deltas: { hp: next.hp.current - state.hp.current }, rolls };
  },

  settleAfterEncounter(state, { outcome }) {
    if (state.deathSaves.failures >= 3) return { state, lifeStatus: 'dead' };
    if (state.hp.current > 0) return { state, lifeStatus: 'active' };
    if (state.deathSaves.stable) return { state, lifeStatus: 'stable' };
    // Owner default 7: a dying PC on a winning side is auto-stabilised.
    if (outcome !== 'victory') return { state, lifeStatus: 'dying' };
    return { state: { ...state, deathSaves: { ...state.deathSaves, stable: true } }, lifeStatus: 'stable' };
  }
});

/**
 * The real adapter: E4's rules (R24 / R25 / R26 / R28) and E1's run-state
 * seam (T21 / T22), unwrapped. Imported lazily so a caller can install
 * its tripwires before any rules module loads.
 * @returns {Promise<object>}
 */
export async function realRunAdapter() {
  const adapters = await import('../../js/scene/encounter-adapters.js');
  const xp = await import('../../js/campaign/xp.js');
  const rest = await import('../../js/campaign/rest.js');
  const death = await import('../../js/campaign/death.js');
  const levelUp = await import('../../js/campaign/level-up.js');
  return {
    entityFromSheet: adapters.entityFromSheet,           // T21: (sheet, {…, runState})
    runStateFromEntity: adapters.runStateFromEntity,     // T21: (entity, prevState)
    encounterXp: xp.encounterXp,                         // R24: (defeated, participants, {mode})
    levelForXp: xp.levelForXp,                           // R24
    applyRest: rest.applyRest,                           // R25: (sheet, state, type, {spend, rng, dawnIsLongRest, lifeStatus})
    settleAfterEncounter: death.settleAfterEncounter,    // R28: (state, {outcome, deathMode})
    planLevelUp: levelUp.planLevelUp,                    // R26
    applyLevelUp: levelUp.applyLevelUp,                  // R26
    endEncounterCleanup: TM.endEncounterCleanup          // T22
  };
}

// ---------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------

/**
 * Load and validate a run script.
 * @param {string} name
 * @returns {object}
 */
export function loadRunScript(name) {
  const script = JSON.parse(readFileSync(new URL(`${name}.run.json`, FIXTURE_DIR), 'utf8'));
  const v = validateCampaign(script.campaign);
  if (!v.ok) throw new Error(`${name}: invalid campaign: ${JSON.stringify(v.errors)}`);
  if (!Number.isInteger(script.seed) || !Array.isArray(script.party) || !Array.isArray(script.steps)) {
    throw new Error(`${name}: a run script needs seed, party[] and steps[]`);
  }
  return script;
}

const levelOfSheet = (sheet) => Math.max(1, Math.min(20, Math.trunc(Number(sheet.level)) || 1));

/**
 * Run a script. Every run event and engine event is validated as it is
 * produced, every state_json after every write.
 * @param {object} script — loadRunScript output
 * @param {object} adapter — see the module header
 * @param {{sheets?: Record<string, object>}} [opts] — parsed sheets by
 *   fixture name (default: the synthetic DDB fixtures)
 * @returns {Promise<{scenario: string, seed: number, runEvents: object[],
 *   encounters: object[], encounterLogs: object[][], final: object, runHash: string,
 *   sheets: Record<string, object>}>} — `sheets`: each slot's run sheet at the end
 */
export async function runScript(script, adapter, opts = {}) {
  assertRunAdapter(adapter);
  const where = (s) => `${script.name}: ${s}`;
  const settings = campaignSettings(script.campaign.settings);
  const nodes = new Map(script.campaign.nodes.map(n => [n.id, n]));
  const templates = new Map((script.campaign.templates || []).map(t => [t.id, t]));
  const runRng = createRng({ s: script.seed >>> 0 });

  const runEvents = [];
  let runSeq = 0;
  const emitRun = (type, payload, { nodeId = current?.id ?? null, actorKind = 'system', actorId = null, override = false } = {}) => {
    const ev = makeRunEvent({ seq: ++runSeq, type, nodeId, actorKind, actorId, override, payload: clone(payload) });
    const v = validateRunEvent(ev);
    if (!v.ok) throw new Error(where(`run event ${type} is invalid: ${JSON.stringify(v.errors)}`));
    runEvents.push(ev);
  };
  const checkState = (slotId, state, sheet) => {
    const v = validateRunState(state, { sheet });
    if (!v.ok) throw new Error(where(`${slotId} state_json is invalid: ${JSON.stringify(v.errors)}`));
  };

  const chars = new Map();
  for (const p of [...script.party].sort((a, b) => a.seat - b.seat)) {
    const sheet = opts.sheets?.[p.fixture] ?? parsedDdbFixture(p.fixture);
    const level = levelOfSheet(sheet);
    const state = initialRunState(sheet);
    checkState(p.slotId, state, sheet);
    chars.set(p.slotId, {
      slotId: p.slotId, seat: p.seat, sheet, state, level, lifeStatus: 'active',
      xp: Number.isInteger(p.xp) ? p.xp : SRD_XP_THRESHOLDS[level - 1], pendingLevels: []
    });
  }
  const summary = (c) => ({ state: c.state, xp: c.xp, level: c.level, lifeStatus: c.lifeStatus });

  let current = null;
  let lastResult = {};
  const encounters = [];
  const encounterLogs = [];
  let levelUps = 0;

  emitRun('run.started', {
    campaignId: script.campaign.id,
    startNodeId: script.campaign.nodes.find(n => n.start)?.id ?? script.campaign.nodes[0].id,
    seats: [...chars.values()].map(c => ({ slotId: c.slotId, seat: c.seat, characterId: String(c.sheet.id) }))
  }, { nodeId: null });
  for (const c of chars.values()) {
    emitRun('character.joined', { slotId: c.slotId, characterId: String(c.sheet.id), level: c.level, before: null, after: summary(c) }, { nodeId: null });
  }

  const enter = (nodeId, override) => {
    const node = nodes.get(nodeId);
    if (!node) throw new Error(where(`unknown node ${nodeId}`));
    const from = current?.id ?? null;
    current = node;
    lastResult = {};
    emitRun('node.entered', { nodeId, kind: node.kind, fromNodeId: from }, { actorKind: 'dm', actorId: 'dm', override });
  };

  for (const [i, step] of script.steps.entries()) {
    const at = `step ${i} (${step.t})`;
    if (step.t === 'enter') {
      enter(step.nodeId, current !== null);
    } else if (step.t === 'advance') {
      const offered = nextNodes(current, lastResult).map(e => e.to);
      const to = step.to ?? offered[0];
      if (!to || !offered.includes(to)) throw new Error(where(`${at}: ${to} is not an offered edge (${offered.join(', ')})`));
      enter(to, false);
    } else if (step.t === 'fight') {
      if (current?.kind !== 'encounter') throw new Error(where(`${at}: the current node is not an encounter`));
      const setup = current.payload.setup ?? templates.get(current.payload.templateId)?.setup;
      if (!setup) throw new Error(where(`${at}: no setup for ${current.id}`));
      const encounterSeed = Math.floor(runRng() * 0x100000000) >>> 0;
      const encounterId = `${script.runId}:${current.id}`;
      const state = emptyEncounterState({ encounterId, cols: setup.grid.cols, rows: setup.grid.rows, seed: encounterSeed });
      state.runId = script.runId;
      state.nodeId = current.id;
      const sheets = {};
      const pcIds = new Map();
      for (const c of chars.values()) {
        if (c.lifeStatus === 'dead') continue;
        const id = `pc-${c.seat}`;
        const pos = current.payload.partyPlacement?.[String(c.seat)] ?? { col: 0, row: c.seat - 1 };
        const e = adapter.entityFromSheet(c.sheet, { id, pos, rev: 0, controller: { type: 'ai', seatId: c.slotId }, runState: c.state });
        state.entities[id] = e;
        sheets[e.sheetRef.characterId] = c.sheet;
        pcIds.set(c.slotId, id);
      }
      setup.monsters.forEach((m, k) => {
        const id = m.id || `m-${k + 1}`;
        const pos = setup.placements?.[id] ?? { col: setup.grid.cols - 1, row: k };
        state.entities[id] = entityFromPreset(m.slug, { id, pos });
      });
      const sv = validateEncounterState(state);
      if (!sv.ok) throw new Error(where(`${at}: built an invalid EncounterState: ${JSON.stringify(sv.errors)}`));

      const events = [];
      let seq = 0;
      const emit = (ev) => {
        const full = { seq: ++seq, type: ev.type, round: ev.round, turnId: ev.turnId ?? null, cinemaGroup: ev.cinemaGroup ?? null, payload: ev.payload };
        const v = validateEvent(full);
        if (!v.ok) throw new Error(where(`${at}: engine event ${ev.type} is invalid: ${JSON.stringify(v.errors)}`));
        events.push(full);
      };
      const ts = TM.turnStateFromEncounter(state, sheets);
      const rng = createRng(state.rng);
      TM.startEncounter(ts, { rng, initiative: 'roll', maxRounds: step.maxRounds ?? 20 });
      while (ts.phase === 'running') await TM.runTurn(ts, { rng, emit });
      if (typeof adapter.endEncounterCleanup === 'function') adapter.endEncounterCleanup(ts);
      const final = TM.encounterFromTurnState(ts, rng);
      const fv = validateEncounterState(final);
      if (!fv.ok) throw new Error(where(`${at}: final EncounterState invalid: ${JSON.stringify(fv.errors)}`));
      const lv = validateEventLog(events);
      if (!lv.ok) throw new Error(where(`${at}: engine log invalid: ${JSON.stringify(lv.errors)}`));
      const outcome = ts.outcome;

      // Write-back (M65 "Encounter end"): state_json, then life status.
      const before = {};
      const after = {};
      for (const [slotId, id] of pcIds) {
        const c = chars.get(slotId);
        const e = final.entities[id];
        before[slotId] = { state: c.state, lifeStatus: c.lifeStatus };
        const written = adapter.runStateFromEntity(e, c.state);
        checkState(slotId, written, c.sheet);
        const settled = adapter.settleAfterEncounter(written, { outcome: settleOutcomeOf(outcome), deathMode: settings.deathMode });
        checkState(slotId, settled.state, c.sheet);
        c.state = settled.state;
        c.lifeStatus = settled.lifeStatus;
        after[slotId] = { state: c.state, lifeStatus: c.lifeStatus };
      }
      emitRun('encounter.result', { encounterId, outcome, rounds: ts.round, before, after });
      for (const [slotId] of pcIds) {
        const c = chars.get(slotId);
        if (c.lifeStatus === 'dead' && before[slotId].lifeStatus !== 'dead') {
          emitRun('character.died', { slotId, cause: 'encounter', before: { lifeStatus: before[slotId].lifeStatus }, after: { lifeStatus: 'dead' } });
        }
      }
      if (settings.xpMode === 'xp') {
        const defeated = Object.values(final.entities)
          .filter(e => e.side === 'hostile' && (e.hp === 0 || e.status === 'dead'))
          .map(e => ({ slug: e.statBlock.slug, ...(e.statBlock.xp !== undefined ? { xp: e.statBlock.xp } : {}), ...(e.statBlock.cr !== undefined ? { cr: e.statBlock.cr } : {}) }));
        const participants = [...pcIds.keys()].map(s => ({ id: s, lifeStatus: chars.get(s).lifeStatus }));
        const xp = adapter.encounterXp(defeated, participants, { mode: settings.xpMode });
        let award = { total: xp.total, perCharacter: xp.awards };
        const living = participants.filter(p => p.lifeStatus !== 'dead').map(p => p.id);
        if (Number.isInteger(current.payload.xpOverride) && living.length) {
          const each = Math.floor(current.payload.xpOverride / living.length);
          award = { total: current.payload.xpOverride, perCharacter: Object.fromEntries(living.map(s => [s, each])) };
        }
        const xb = {};
        const xa = {};
        for (const [slotId, n] of Object.entries(award.perCharacter)) {
          const c = chars.get(slotId);
          xb[slotId] = c.xp;
          c.xp += n;
          xa[slotId] = c.xp;
        }
        emitRun('xp.awarded', { total: award.total, perCharacter: award.perCharacter, before: xb, after: xa });
        for (const slotId of Object.keys(award.perCharacter)) {
          const c = chars.get(slotId);
          const target = adapter.levelForXp(c.xp);
          const pendingTop = c.pendingLevels.length ? c.pendingLevels[c.pendingLevels.length - 1].toLevel : c.level;
          for (let to = pendingTop + 1; to <= Math.min(20, target); to++) {
            const lu = { levelUpId: `lu-${++levelUps}`, slotId, fromLevel: to - 1, toLevel: to };
            c.pendingLevels.push(lu);
            emitRun('level.queued', lu);
          }
        }
      }
      emitRun('node.completed', { nodeId: current.id, kind: current.kind });
      lastResult = { outcome };
      const counts = {};
      for (const ev of events) counts[ev.type] = (counts[ev.type] || 0) + 1;
      encounters.push({
        nodeId: current.id, encounterId, seed: encounterSeed, outcome, rounds: ts.round,
        eventCount: events.length, eventTypes: Object.fromEntries(Object.entries(counts).sort()),
        eventsHash: hash53(canonicalJson(events)), finalStateHash: stateHash(final)
      });
      encounterLogs.push(events);
    } else if (step.t === 'rest') {
      if (current?.kind !== 'rest') throw new Error(where(`${at}: the current node is not a rest`));
      const type = current.payload.type === 'choice' ? step.type : current.payload.type;
      if (type !== 'short' && type !== 'long') throw new Error(where(`${at}: a choice rest needs step.type`));
      const before = {};
      const after = {};
      const rolls = {};
      const slotIds = [];
      for (const c of chars.values()) {
        if (c.lifeStatus === 'dead') continue;
        const r = adapter.applyRest(c.sheet, c.state, type, {
          spend: step.spend?.[c.slotId] ?? {}, rng: runRng, dawnIsLongRest: settings.dawnIsLongRest, lifeStatus: c.lifeStatus
        });
        checkState(c.slotId, r.state, c.sheet);
        before[c.slotId] = c.state;
        after[c.slotId] = r.state;
        rolls[c.slotId] = r.rolls;
        c.state = r.state;
        slotIds.push(c.slotId);
      }
      emitRun('rest.taken', { type, slotIds, rolls, before, after });
      emitRun('node.completed', { nodeId: current.id, kind: current.kind });
      lastResult = {};
    } else if (step.t === 'level') {
      if (typeof adapter.planLevelUp !== 'function' || typeof adapter.applyLevelUp !== 'function') {
        throw new Error(where(`${at}: the adapter has no planLevelUp / applyLevelUp`));
      }
      const c = chars.get(step.slotId);
      const lu = c?.pendingLevels[0];
      if (!lu) throw new Error(where(`${at}: ${step.slotId} has no queued level`));
      const plan = adapter.planLevelUp(c.sheet, c.state, { toLevel: lu.toLevel, settings });
      const r = adapter.applyLevelUp(c.sheet, c.state, plan, step.picks ?? {}, { rng: runRng });
      checkState(c.slotId, r.state, r.sheet);
      const before = { state: c.state, level: c.level };
      c.sheet = r.sheet;
      c.state = r.state;
      c.level = lu.toLevel;
      c.pendingLevels.shift();
      emitRun('level.applied', { ...lu, granted: r.granted, before, after: { state: c.state, level: c.level } }, { actorKind: 'player', actorId: c.slotId });
    } else if (step.t === 'end') {
      emitRun('run.ended', { outcome: step.outcome }, { actorKind: 'dm', actorId: 'dm' });
    } else {
      throw new Error(where(`${at}: unknown step type`));
    }
  }

  const log = validateRunEventLog(runEvents);
  if (!log.ok) throw new Error(where(`run event log invalid: ${JSON.stringify(log.errors)}`));
  const final = {};
  for (const c of chars.values()) final[c.slotId] = { ...summary(c), pendingLevels: c.pendingLevels.map(l => l.toLevel) };
  return {
    scenario: script.name,
    seed: script.seed,
    runEvents,
    encounters,
    encounterLogs,
    final,
    runHash: hash53(canonicalJson(runEvents)),
    sheets: Object.fromEntries([...chars.values()].map(c => [c.slotId, c.sheet]))
  };
}

/**
 * Rebuild every character's final state from the run events alone (the
 * replay contract B24 / B26 rely on): character.joined seeds, the
 * `after` of encounter.result / rest.taken / xp.awarded / character.died /
 * level.applied overwrite, level.queued queues, level.applied dequeues.
 * @param {object[]} runEvents
 * @returns {Record<string, {state: object, xp: number, level: number, lifeStatus: string, pendingLevels: number[]}>}
 */
export function replayRunEvents(runEvents) {
  const out = {};
  for (const ev of runEvents) {
    const p = ev.payload;
    switch (ev.type) {
      case 'character.joined': out[p.slotId] = { ...clone(p.after), pendingLevels: [] }; break;
      case 'encounter.result':
        for (const [slotId, a] of Object.entries(p.after)) Object.assign(out[slotId], clone(a));
        break;
      case 'rest.taken':
        for (const [slotId, s] of Object.entries(p.after)) out[slotId].state = clone(s);
        break;
      case 'xp.awarded':
        for (const [slotId, xp] of Object.entries(p.after)) out[slotId].xp = xp;
        break;
      case 'character.died': out[p.slotId].lifeStatus = p.after.lifeStatus; break;
      case 'level.queued': out[p.slotId].pendingLevels.push(p.toLevel); break;
      case 'level.applied':
        Object.assign(out[p.slotId], clone(p.after));
        out[p.slotId].pendingLevels.shift();
        break;
      default: break;
    }
  }
  return out;
}

/**
 * The golden projection of a run result (drops the bulky engine logs and
 * the run sheets; the logs' hashes and per-type counts stay).
 * @param {Awaited<ReturnType<typeof runScript>>} result
 * @returns {object}
 */
export function goldenOf(result) {
  const { encounterLogs: _logs, sheets: _sheets, ...rest } = result;
  return rest;
}
