// The real engine port (M64 Wave 4): implements the EnginePort typedef in
// engine-port.js over E1's turn manager, encounter adapters, prompt
// adapter and intent validation. ONE spine: every rule (initiative,
// resets, planning, resolution, reactions, legendary actions, victory)
// runs in src/js/scene/**; this file only converts between the room's
// EncounterState + prompts and the engine's TurnState + callbacks.
//
//   room ctx.prompts.intent    → turn-manager runActorTurn hook (before runOneAttack)
//   room ctx.prompts.reaction  → createPromptAdapter({ask}) → onShield/onCounterspell/onReactionAttack
//   room ctx.prompts.planReady → onPlanReady (only when ctx.review.plans)
//   room ctx.prompts.roll      → onRoll      (only when ctx.review.rolls)
//   room ctx.prompts.cinema    → onCinemaRound (after each `exchange`)
//
// Event ownership (engine-port.js rule 4): the room emits
// `reaction.offered` (with the PromptBroker's deadline) and the gate
// `dm.override`s, so the engine's own copies of those two are dropped
// here. `reaction.resolved` is the engine's: it re-checks eligibility
// after the answer, so its `used` is authoritative. Everything else the
// engine emits is forwarded in order.
//
// Sheets: PC wrappers need the parsed character. They are not part of
// EncounterState, so the port caches them per encounter at build time and
// falls back to `resolveSheets(state)` (the DB: party_slots seeds, then
// characters.parsed_json) after a restart.

import { MONSTER_PRESETS } from '../../src/js/scene/monster-presets.js';
import { PC_PROFILES } from '../../src/js/scene/ai/pc-profiles.js';
import { PC_FEATURES } from '../../src/js/scene/ai/pc-features.js';
import { inferProfile } from '../../src/js/scene/ai/infer.js';
import { runOneAttack, applyDamageToEntity } from '../../src/js/scene/combat-engine.js';
import {
  entityFromSheet, entityFromPreset, toEngineSides, applyEngineSides, stripTransient,
  setEntityHp, setEntityConditions, wrapperFromEntity, poolFromLedger, ledgerFromPool
} from '../../src/js/scene/encounter-adapters.js';
import { spellById } from '../../src/js/scene/monster-spells.js';
import { normalizeCreature, withEngineFields } from '../../src/js/scene/open5e-normalize.js';
import * as TM from '../../src/js/scene/turn-manager.js';
import { createPromptAdapter } from '../../src/js/scene/prompt-adapter.js';
import { validateIntent as validateTurnIntent, planFromIntent } from '../../src/js/scene/intent-validation.js';
import { weaponRangeBand, lineOfSight } from '../../src/js/scene/grid-legality.js';
import { chebyshevFeet } from '../../src/js/scene/grid-rules.js';
import { emptyEncounterState } from '../../src/js/shared/encounter-state.js';
import { asTerrain, createTerrain, encodeTerrain, applyTerrainPaint, TERRAIN_FLAG_MASK } from '../../src/js/map/terrain.js';

/**
 * Engine version stored as encounters.engine_version. Distinct from the
 * stub's (1): an encounter built by one cannot be resumed by the other.
 */
export const REAL_ENGINE_VERSION = 2;

/** Encounters whose sheets are kept in memory. */
const SHEET_CACHE_SIZE = 64;
/**
 * Back-stop on the prompt adapter's own deadline: the room's broker
 * enforces the real (room-setting) deadline, so this only fires if a
 * broker promise is lost. Its timers are unref'd.
 */
const ADAPTER_BACKSTOP_MS = 10 * 60_000;
/** Engine event types the room owns (engine-port.js rule 4). */
const ROOM_OWNED_EVENTS = new Set(['reaction.offered', 'dm.override']);

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const invalid = (msg) => Object.assign(new Error(msg), { code: 'E_INVALID_INTENT' });
const unrefClock = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: (t) => clearTimeout(t)
};

/**
 * The sheet a seat's PC fights with: the frozen seed, plus the AI
 * archetype the DM picked for an AI seat (profileForPc reads
 * `ref._aiProfile`). Shared by buildEncounter and the DB resolver so a
 * rebuilt cache matches the original.
 * @param {{seed: object|null, aiArchetype?: string|null}} seat
 * @returns {object|null}
 */
export function sheetForSeat(seat) {
  if (!seat?.seed) return null;
  const sheet = clone(seat.seed);
  const a = seat.aiArchetype;
  if (a && a !== 'auto' && PC_PROFILES[a]) sheet._aiProfile = clone(PC_PROFILES[a]);
  return sheet;
}

/**
 * A preset slug (sprite + base stats) for a setup monster: its `preset`,
 * its `slug` when that is a preset (Open5e `srd_` prefix stripped), else
 * the browser's Open5e name/type heuristic (main.js matchPresetForOpen5e,
 * mirrored here until it moves to a shared module), else 'bandit'.
 * A monster with neither slug nor preset is a goblin (the stub's default).
 * @param {object} m  setup monster ({slug?, preset?, name?})
 * @param {string|null} [type]  creature type from the Open5e record
 * @returns {string}
 */
export function presetSlugFor(m, type = null) {
  for (const k of [m.preset, m.slug]) {
    const s = String(k || '').toLowerCase().replace(/^srd[_-]/, '');
    if (s && MONSTER_PRESETS[s]) return s;
  }
  if (m.slug === undefined && m.preset === undefined && !m.open5eSlug) return 'goblin';
  const n = String(m.name || m.slug || '').toLowerCase().replace(/^srd[_-]/, '');
  const t = String(type || '').toLowerCase();
  for (const slug of Object.keys(MONSTER_PRESETS)) if (n.includes(slug)) return slug;
  if (t.includes('undead') || n.includes('skeleton')) return 'skeleton';
  if (n.includes('zombie') || n.includes('ghoul')) return 'zombie';
  if (n.includes('vampire')) return 'vampire';
  if (n.includes('orc') || n.includes('hobgoblin')) return 'orc';
  if (n.includes('goblin') || n.includes('kobold')) return 'goblin';
  if (n.includes('troll') || n.includes('ogre') || n.includes('giant')) return 'troll';
  if (n.includes('minotaur')) return 'minotaur';
  if (n.includes('wolf') || n.includes('gnoll')) return 'gnoll';
  if (n.includes('dragon') || t === 'dragon') return 'young-dragon';
  return 'bandit';
}

/**
 * The stat block an Open5e monster fights with (M64 1.5): E4's
 * normalised SRD block (`normalizeCreature`: real AC, HP, weapon attacks,
 * saves, R/I/V, multiattack, recharge / legendary metadata) with the
 * engine fields filled (`withEngineFields`: `hpMax`, `attacks[]`) and an
 * inferred AI profile. `source: 'srd-2014'` marks it. The preset
 * (presetSlugFor) stays the sprite and the fallback for anything the
 * block lacks: no HP, an implausible AC or no parseable weapon attack.
 * @param {object|null} c  Open5e v2 creature payload
 * @returns {object} normalised stat block, or {} for no record
 */
export function statBlockFromOpen5e(c) {
  const sb = normalizeCreature(c);
  if (!sb) return {};
  const out = withEngineFields(sb);
  if (!(Number.isInteger(out.hpMax) && out.hpMax > 0)) delete out.hpMax;
  const ac = Number(c.armor_class ?? c.ac);
  if (!(Number.isInteger(ac) && ac > 0 && ac <= 50)) delete out.ac;
  out.profile = inferProfile({
    slug: sb.open5eSlug, name: sb.name, type: sb.type, cr: sb.cr, hp: sb.hp.average,
    intelligence: sb.abilities?.INT, traits: sb.traits, actions: sb.actions
  });
  return out;
}

/**
 * @param {object} [o]
 * @param {(state: object) => Record<string, object>|null} [o.resolveSheets]
 *   sheets by `sheetRef.characterId` for an encounter not in the cache
 * @param {(slug: string) => object|null} [o.monsterLookup]  cached Open5e creature payload
 * @param {number} [o.version=REAL_ENGINE_VERSION]
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 * @returns {import('./engine-port.js').EnginePort & {sheetsFor: (state: object) => Record<string, object>}}
 */
export function createRealEngine({ resolveSheets = () => null, monsterLookup = () => null, version = REAL_ENGINE_VERSION, log = () => {} } = {}) {
  /** encounterId → {characterId: sheet} (LRU by insertion). */
  const sheetCache = new Map();

  function remember(encounterId, sheets) {
    sheetCache.delete(encounterId);
    sheetCache.set(encounterId, sheets);
    while (sheetCache.size > SHEET_CACHE_SIZE) sheetCache.delete(sheetCache.keys().next().value);
  }

  /** Sheets for every PC in `state` (cache, else the resolver); throws when one is missing. */
  function sheetsFor(state) {
    let sheets = sheetCache.get(state.encounterId);
    const pcs = Object.values(state.entities).filter(e => e.kind === 'pc');
    const missing = (s) => pcs.filter(e => !s?.[e.sheetRef?.characterId]);
    if (!sheets || missing(sheets).length) {
      const resolved = resolveSheets(state) || {};
      sheets = { ...(sheets || {}), ...resolved };
      const gone = missing(sheets);
      if (gone.length) throw new Error(`no character sheet for ${gone.map(e => e.id).join(', ')}`);
      log('info', 'engine: character sheets resolved for an encounter', { encounterId: state.encounterId, pcs: pcs.length });
      remember(state.encounterId, sheets);
    }
    return sheets;
  }

  // ------------------------------------------------------------- setup

  function buildEncounter({ encounterId, seed, setup, party, settings = {} }) {
    // Room setting (dm.room.settings): grid-rules measure Chebyshev 5-ft diagonals only.
    if (settings.diagonalRule !== undefined && settings.diagonalRule !== '5ft') throw new Error(`diagonal rule ${settings.diagonalRule} is not supported`);
    const cols = setup.grid.cols;
    const rows = setup.grid.rows;
    const state = emptyEncounterState({ encounterId, cols, rows, seed, flankingEnabled: setup.grid.flankingEnabled === true });
    state.map = setup.map ? clone(setup.map) : null;
    const terrain = setup.grid.terrain ?? setup.terrain ?? null;
    if (terrain) {
      const t = asTerrain(terrain);
      if (!t || t.cols !== cols || t.rows !== rows) throw new Error('terrain must match the grid');
      state.grid.terrain = encodeTerrain(t);
    }
    if (setup.fog !== undefined && setup.fog !== null) {
      if (typeof setup.fog?.revealed !== 'string') throw new Error('fog must be {revealed: base64}');
      state.fog = { revealed: setup.fog.revealed };
    }
    const placements = setup.placements || {};
    const place = (id, i, row) => {
      const p = placements[id];
      return p && Number.isInteger(p.col) && Number.isInteger(p.row)
        ? { col: Math.min(Math.max(0, p.col), cols - 1), row: Math.min(Math.max(0, p.row), rows - 1) }
        : { col: Math.min(i, cols - 1), row: Math.min(row, rows - 1) };
    };
    const live = settings.importLiveState === true;
    const sheets = {};
    party.forEach((s, i) => {
      const sheet = sheetForSeat(s);
      if (!sheet) throw new Error(`seat ${s.seat} has no character sheet`);
      const id = `pc-${s.seat}`;
      const e = entityFromSheet(sheet, {
        id, pos: place(id, i, 0), rev: 0,
        controller: { type: s.controller === 'player' ? 'player' : 'ai', seatId: s.slotId }
      });
      if (live) seedLiveState(e, sheet);
      state.entities[id] = e;
      sheets[e.sheetRef.characterId] = sheet;
    });
    (setup.monsters || []).forEach((m, i) => {
      const id = typeof m.id === 'string' && m.id ? m.id.slice(0, 128) : `m-${i + 1}`;
      if (state.entities[id]) throw new Error(`duplicate entity id ${id}`);
      state.entities[id] = monsterEntity(m, id, place(id, i, rows - 1));
    });
    remember(encounterId, sheets);
    return state;
  }

  /** `importLiveState`: HP and spent slots from the sheet instead of rested. */
  function seedLiveState(e, sheet) {
    const cur = Number(sheet?.hp?.current);
    if (Number.isFinite(cur)) e.hp = Math.max(0, Math.min(e.hpMax, Math.trunc(cur)));
    const used = sheet?.slotsUsed;
    if (!used || typeof used !== 'object') return;
    const spell = used.spell && typeof used.spell === 'object' ? used.spell : used;
    for (const [lvl, l] of Object.entries(e.resources.slots)) {
      const n = Math.trunc(Number(spell[lvl]) || 0);
      l.spent = Math.max(0, Math.min(l.max, n));
    }
    const pact = e.resources.pact;
    if (Number.isInteger(pact?.level) && used.pact && typeof used.pact === 'object') {
      pact.spent = Math.max(0, Math.min(pact.max, Math.trunc(Number(used.pact[pact.level]) || 0)));
    }
  }

  function monsterEntity(m, id, pos) {
    const o5 = m.open5eSlug || (!MONSTER_PRESETS[String(m.slug || '').replace(/^srd[_-]/, '')] && m.slug ? m.slug : null);
    const record = o5 ? monsterLookup(String(o5)) : null;
    const statBlock = statBlockFromOpen5e(record);
    const type = typeof record?.type === 'object' && record.type ? (record.type.name || record.type.key) : (record?.type ?? null);
    const slug = presetSlugFor({ ...m, name: m.name || record?.name }, type);
    if (Number.isInteger(m.hp) && m.hp > 0) statBlock.hpMax = m.hp;
    if (Number.isInteger(m.ac) && m.ac >= 0 && m.ac <= 50) statBlock.ac = m.ac;
    const name = String(m.name || statBlock.name || MONSTER_PRESETS[slug].name).slice(0, 128);
    return entityFromPreset(slug, { id, pos, name, statBlock, controller: { type: m.controller === 'dm' ? 'dm' : 'ai', seatId: null } });
  }

  // ------------------------------------------------------------ turns

  async function startEncounter(input, { rng }) {
    const ts = TM.turnStateFromEncounter(clone(input), sheetsFor(input));
    TM.startEncounter(ts, { rng, initiative: input.initiative.length ? 'given' : 'roll' });
    return { state: stateOf(ts), events: [] };
  }

  /** EncounterState from a TurnState, transient wrapper fields dropped. */
  function stateOf(ts) {
    return clone(applyEngineSidesFromTs(ts));
  }

  function applyEngineSidesFromTs(ts) {
    const next = applyEngineSides(ts.baseState, Object.values(ts.entities).map(stripTransient));
    next.round = ts.round;
    next.turnIndex = ts.turnIndex;
    next.phase = ts.phase;
    next.initiative = ts.initiative.map(r => ({ ...r }));
    return next;
  }

  async function runTurn(input, ctx) {
    const sheets = sheetsFor(input);
    const ts = TM.turnStateFromEncounter(clone(input), sheets);
    const actorId = ts.initiative[ts.turnIndex]?.entityId ?? null;
    const events = [];
    let turnEnded = false;
    let lastExchange = null;
    const progress = () => ctx.progress(stateOf(ts));

    const forward = (ev) => {
      const st = ctx.emit({ type: ev.type, payload: ev.payload, cinemaGroup: ev.cinemaGroup ?? null });
      events.push(st);
      if (ev.type === 'turn.ended') turnEnded = true;
      if (ev.type === 'exchange') lastExchange = st;
      return st;
    };
    const emit = (ev) => {
      if (ROOM_OWNED_EVENTS.has(ev.type)) return null;
      if (ev.type === 'encounter.ended' && !turnEnded && actorId) forward({ type: 'turn.ended', payload: { actorId } });
      return forward(ev);
    };

    const review = ctx.review || {};
    const prompts = {
      ...createPromptAdapter({
        timeoutMs: ADAPTER_BACKSTOP_MS,
        clock: unrefClock,
        ask: async (req) => {
          const { kind, reactorId, autoAnswer, ...ids } = req;
          progress();
          const r = await ctx.prompts.reaction({ kind, reactorId, autoAnswer, eligible: true, payload: clone(ids) });
          return { answer: r?.answer === true, by: r?.by || 'player' };
        }
      }),
      onCinemaRound: async () => {
        const ex = lastExchange;
        lastExchange = null;
        if (!ex) return;
        progress();
        await ctx.prompts.cinema(ex);
      }
    };
    if (review.plans) {
      prompts.onPlanReady = async ({ attacker, plan, source }) => {
        if (source !== 'ai') return plan;
        const id = String(attacker.id);
        const proposed = intentPlanOf(plan);
        progress();
        const out = await ctx.prompts.planReady({ actorId: id, plan: proposed, breakdown: jsonSafe(plan.breakdown) || [] });
        if (out === null) return null;
        if (!out || same(out, proposed)) return plan;
        return planFromIntent(stateOf(ts), { actorId: id, plan: out }, { sheets });
      };
    }
    if (review.rolls) {
      prompts.onRoll = async ({ kind, actorId: who, targetId, result }) => {
        const n = rollNumber(kind, result);
        if (n === null) return result;
        progress();
        const v = await ctx.prompts.roll({ rollKind: kind, actorId: who, targetId: targetId ?? null, result: n });
        return Number.isInteger(v) && v !== n ? withRoll(kind, result, v) : result;
      };
    }

    const runActorTurn = async (actor, { enemies, allies, ctx: engineCtx }) => {
      const id = String(actor.id);
      let planSource = null;
      let forcePlan = null;
      const cur = stateOf(ts);
      const controller = cur.entities[id]?.controller;
      if (controller && controller.type !== 'ai') {
        ctx.progress(cur);
        const res = await ctx.prompts.intent({ actorId: id, turnId: ctx.turnId, controller: clone(controller), state: clone(cur) });
        if (!same(res.state, cur)) resync(ts, clone(res.state), sheets, actor, enemies, allies);
        if (res.intent.kind === 'skip') {
          engineCtx.emit({ type: 'turn.skipped', payload: { actorId: id, reason: 'skipped' }, cinemaGroup: null });
          return;
        }
        if (!ts.entities[id] || !(ts.entities[id].hp > 0)) {
          engineCtx.emit({ type: 'turn.skipped', payload: { actorId: id, reason: 'down' }, cinemaGroup: null });
          return;
        }
        if (res.intent.kind === 'plan') {
          forcePlan = planFromIntent(stateOf(ts), { actorId: id, plan: res.intent.plan }, { sheets });
          planSource = res.state.entities[id].controller.type === 'dm' ? 'dm' : 'player';
        }
      }
      if (planSource) engineCtx.planSource = planSource;
      const side = ts.sides[id];
      const mine = Object.entries(ts.entities).filter(([oid]) => ts.sides[oid] === side).map(([, w]) => w);
      const theirs = Object.entries(ts.entities).filter(([oid]) => ts.sides[oid] !== side).map(([, w]) => w);
      await runOneAttack(ts.entities[id], theirs, mine, ts.scene, ctx.rng, forcePlan ? { ...prompts, forcePlan } : prompts, engineCtx);
      void enemies; void allies;
    };

    await TM.runTurn(ts, {
      rng: ctx.rng,
      prompts,
      emit,
      runActorTurn,
      victoryRule: 'hp',
      ...(typeof ctx.cinemaInputs === 'function' ? { cinemaInputs: ctx.cinemaInputs } : {}),
      ...(Number.isInteger(ctx.reactionDeadlineMs) ? { reactionDeadlineMs: ctx.reactionDeadlineMs } : {})
    });
    if (!turnEnded && actorId) forward({ type: 'turn.ended', payload: { actorId } });
    return { state: stateOf(ts), events };
  }

  /**
   * DM edits made while the turn waited for its intent: bring the live
   * wrappers in line with the returned state (in place, so the turn
   * manager's references stay valid).
   */
  function resync(ts, next, sheets, actor, enemies, allies) {
    ts.baseState = next;
    const fresh = toEngineSides(next, sheets);
    ts.scene = fresh.scene;
    const actorSide = ts.sides[String(actor.id)];
    for (const id of Object.keys(ts.entities)) {
      if (next.entities[id]) continue;
      for (const list of [enemies, allies]) { const i = list.indexOf(ts.entities[id]); if (i >= 0) list.splice(i, 1); }
      delete ts.entities[id];
      delete ts.sides[id];
    }
    for (const w of fresh.wrappers) {
      const id = String(w.id);
      const cur = ts.entities[id];
      if (cur) {
        for (const k of Object.keys(cur)) delete cur[k];
        Object.assign(cur, w);
      } else {
        ts.entities[id] = w;
        ts.sides[id] = next.entities[id].side;
        (ts.sides[id] === actorSide ? allies : enemies).push(w);
      }
    }
    ts.initiative = next.initiative.map(r => ({ ...r }));
    ts.turnIndex = next.turnIndex;
    ts.round = next.round;
  }

  // ------------------------------------------------------- validation

  function validateIntent(state, { actorId, plan }) {
    let sheets;
    try { sheets = sheetsFor(state); } catch (err) { return { ok: false, code: 'no-sheet', reason: err.message }; }
    const { innate: _i, ...clean } = plan || {};
    const v = validateTurnIntent(state, { actorId, plan: clean }, { sheets, rangeBand: rangeBandFor(state) });
    if (v.ok) return { ok: true };
    // intent-validation's features[] check (its LAST check, so every other
    // rule already passed) asks pc-features `available()` with the bare
    // wrapper, which has no `classes`: every class feature reads level 0
    // and a legal Action Surge is rejected at the turn's safe point.
    // Re-check features the way the planner does (pc-action
    // mergeSelfForFeatures: wrapper fields over the sheet).
    if (v.code === 'bad-feature' && clean.features?.length) return featuresAvailable(state, actorId, clean.features, sheets);
    return { ok: false, code: v.code, reason: v.reason };
  }

  /**
   * features[] against the actor's state at the safe point: the turn has
   * started, so per-turn flags (turnFlags) are already reset and the
   * per-rest ledgers (resources.features) are current.
   */
  function featuresAvailable(state, actorId, features, sheets) {
    const id = actorId ?? state.initiative?.[state.turnIndex]?.entityId;
    const actor = state.entities[id];
    if (!actor || actor.kind !== 'pc') return { ok: false, code: 'bad-feature', reason: 'only PCs use class features' };
    const sheet = sheets[actor.sheetRef?.characterId] ?? null;
    const w = wrapperFromEntity(actor, sheet);
    const self = { ...(sheet || {}), ...w, classes: w.classes || sheet?.classes, equipment: w.equipment || sheet?.equipment, spells: w.spells || sheet?.spells };
    for (const f of features) {
      const def = PC_FEATURES[f];
      if (!def) return { ok: false, code: 'bad-feature', reason: `unknown feature ${f}` };
      if (!def.available(self)) return { ok: false, code: 'bad-feature', reason: `${def.label} is not available now` };
    }
    return { ok: true };
  }

  /** grid-legality range bands (+ line of sight when the actor does not move first). */
  function rangeBandFor(state) {
    const terrain = state.grid?.terrain ?? null;
    return (from, to, { weapon, spell, budgetFt = 0 }) => {
      const dist = chebyshevFeet(from, to);
      if (spell) {
        if (dist > (spell.range || 5)) return 'out';
      } else {
        const ranged = weaponRangeBand(weapon, dist);
        const band = ranged === 'out' ? weaponRangeBand(weapon, Math.max(0, dist - budgetFt)) : ranged;
        if (band === 'out') return 'out';
      }
      if (budgetFt === 0 && terrain && !lineOfSight(terrain, from, to)) return 'out';
      return 'normal';
    };
  }

  // -------------------------------------------------------- DM edits

  function applyDmCommand(input, { type, payload }, { emit, rng }) {
    const p = payload || {};
    const state = clone(input);
    const need = (id) => {
      const e = state.entities[id];
      if (!e) throw invalid(`unknown entity ${id}`);
      return e;
    };
    switch (type) {
      case 'dm.entity.patch': {
        let s = state;
        const e = need(p.entityId);
        if (p.hp !== undefined) s = setEntityHp(s, e.id, p.hp).state;
        if (p.addConditions || p.removeConditions) {
          const rm = new Set(p.removeConditions || []);
          const keep = s.entities[e.id].conditions.filter(c => !rm.has(typeof c === 'string' ? c : c.id));
          s = setEntityConditions(s, e.id, [...keep, ...(p.addConditions || [])]).state;
        }
        if (p.hpTemp !== undefined) s.entities[e.id] = { ...s.entities[e.id], hpTemp: Math.max(0, Math.trunc(p.hpTemp)) };
        if (p.position) {
          const { col, row } = p.position;
          if (col >= s.grid.cols || row >= s.grid.rows) throw invalid('position is off the grid');
          if (Object.values(s.entities).some(o => o.id !== e.id && o.pos.col === col && o.pos.row === row)) throw invalid('that cell is occupied');
          s.entities[e.id] = { ...s.entities[e.id], pos: { col, row } };
        }
        return { state: s, events: [] };
      }
      case 'dm.entity.add': {
        const m = p.entity || {};
        let id = typeof m.id === 'string' && m.id ? m.id.slice(0, 120) : `m-${Object.keys(state.entities).length + 1}`;
        while (state.entities[id]) id += 'x';
        const pos = m.pos && Number.isInteger(m.pos.col) && Number.isInteger(m.pos.row)
          ? { col: Math.min(m.pos.col, state.grid.cols - 1), row: Math.min(m.pos.row, state.grid.rows - 1) }
          : { col: 0, row: state.grid.rows - 1 };
        const entity = monsterEntity(m, id, pos);
        if (state.phase === 'setup' && state.initiative.length === 0) {
          state.entities[id] = entity;
          return { state, events: [] };
        }
        const ts = TM.turnStateFromEncounter(state, sheetsFor(state));
        ts.baseState = { ...state, entities: { ...state.entities, [id]: entity } };
        const wrapper = wrapperFromEntity(entity);
        const score = typeof p.initiativeScore === 'number'
          ? p.initiativeScore
          : TM.rollInitiative({ entities: { [id]: wrapper } }, rng)[0].score;
        TM.insertInitiative(ts, { wrapper, side: entity.side, score });
        return { state: stateOf(ts), events: [] };
      }
      case 'dm.entity.remove': {
        need(p.entityId);
        const ts = TM.turnStateFromEncounter(state, sheetsFor(state));
        if (!TM.removeInitiative(ts, p.entityId)) delete ts.entities[p.entityId];
        const next = stateOf(ts);
        delete next.entities[p.entityId];
        for (const e of Object.values(next.entities)) {
          if (e.concentration) e.concentration.targetIds = e.concentration.targetIds.filter(t => t !== p.entityId);
        }
        if (next.turnIndex >= next.initiative.length) next.turnIndex = 0;
        return { state: next, events: [] };
      }
      case 'dm.initiative.roll': {
        const ts = TM.turnStateFromEncounter(state, sheetsFor(state));
        state.initiative = TM.rollInitiative(ts, rng);
        state.turnIndex = 0;
        return { state, events: [] };
      }
      case 'dm.terrain.paint': {
        // map/terrain.js codec: one flag byte per cell, undefined bits masked.
        const t = asTerrain(state.grid.terrain) || createTerrain(state.grid.cols, state.grid.rows);
        const painted = applyTerrainPaint(t, { cells: p.cells, flag: (p.flags | 0) & TERRAIN_FLAG_MASK, op: p.mode === 'clear' ? 'clear' : 'set' });
        state.grid.terrain = encodeTerrain(painted);
        return { state, events: [] };
      }
      case 'dm.initiative.set': {
        const ids = p.order;
        const all = Object.keys(state.entities);
        if (ids.length !== all.length || !ids.every(id => state.entities[id])) throw invalid('order must list every entity exactly once');
        state.initiative = ids.map((id, i) => ({ entityId: id, score: ids.length - i }));
        state.turnIndex = 0;
        return { state, events: [] };
      }
      case 'dm.spell.adjudicate':
        return adjudicateSpell(state, p, { emit, rng });
      default:
        throw invalid(`unsupported DM command ${type}`);
    }
  }

  /**
   * The DM rules a spell the engine cannot resolve (homebrew, no registry
   * entry): spend the slot from the ledger, then apply the DM's numbers —
   * damage through the engine's applyDamageToEntity (concentration saves
   * included), healing and conditions through the adapters.
   */
  function adjudicateSpell(state, p, { emit, rng }) {
    const caster = state.entities[p.casterId];
    if (!caster) throw invalid(`unknown caster ${p.casterId}`);
    for (const t of p.targets) if (!state.entities[t.entityId]) throw invalid(`unknown target ${t.entityId}`);
    const events = [];
    const out = (type, payload) => { const ev = emit({ type, payload }); if (ev) events.push(ev); };
    let s = state;
    let slotSpent = null;
    if (Number.isInteger(p.slotLevel)) {
      const lvl = String(p.slotLevel);
      const res = s.entities[caster.id].resources;
      const pool = poolFromLedger(res.slots);
      if ((pool[lvl] ?? 0) > 0) {
        res.slots = ledgerFromPool(res.slots, { ...pool, [lvl]: pool[lvl] - 1 });
      } else if (res.pact?.level === p.slotLevel && res.pact.max - res.pact.spent > 0) {
        res.pact.spent += 1;
      } else {
        throw invalid(`${caster.name} has no level-${lvl} slot left`);
      }
      slotSpent = p.slotLevel;
    }
    // Order (E2's client relies on it): spell.cast {adjudicated} heads the
    // ruling, then the slot, then damage / heal / conditions; the room's
    // dm.override + entity.updated follow.
    const known = spellById(p.spellId);
    out('spell.cast', {
      casterId: caster.id, spellId: p.spellId,
      castAtLevel: slotSpent ?? known?.level ?? 0,
      slotSpent, innate: false, targetIds: p.targets.map(t => t.entityId), adjudicated: true
    });
    if (slotSpent !== null) out('resource.spent', { entityId: caster.id, resource: 'spell-slot', level: slotSpent });
    for (const t of p.targets) {
      if (t.damage > 0) {
        const w = wrapperFromEntity(s.entities[t.entityId], sheetsFor(s)[s.entities[t.entityId].sheetRef?.characterId] ?? null);
        applyDamageToEntity(w, t.damage, rng, { emit: (ev) => { const st = emit(ev); if (st) events.push(st); } }, { source: { id: caster.id }, type: t.type ?? null });
        s = applyEngineSides(s, [w]);
      }
      if (t.healed > 0) {
        const before = s.entities[t.entityId].hp;
        const r = setEntityHp(s, t.entityId, before + t.healed);
        s = r.state;
        out('heal', { sourceId: caster.id, targetId: t.entityId, amount: r.after - before, hpBefore: before, hpAfter: r.after });
      }
      if (t.conditions?.length) {
        const have = new Set(s.entities[t.entityId].conditions.map(c => (typeof c === 'string' ? c : c.id)));
        s = setEntityConditions(s, t.entityId, [...s.entities[t.entityId].conditions, ...t.conditions]).state;
        for (const c of t.conditions) if (!have.has(c)) { have.add(c); out('condition.applied', { entityId: t.entityId, condition: c, sourceId: caster.id }); }
      }
    }
    log('info', 'engine: DM adjudicated a spell', { encounterId: state.encounterId, casterId: caster.id, spellId: p.spellId, targets: p.targets.length });
    return { state: clone(s), events };
  }

  return { version, buildEncounter, startEncounter, runTurn, validateIntent, applyDmCommand, sheetsFor };
}

/** The engine's internal plan as a protocol turn.act plan (ids and names only). */
function intentPlanOf(plan) {
  const out = { kind: String(plan.kind) };
  if (plan.targetId != null) out.targetId = String(plan.targetId);
  if (plan.targetSide) out.targetSide = plan.targetSide;
  if (plan.weapon?.name) out.weaponName = String(plan.weapon.name);
  if (plan.spellId) out.spellId = String(plan.spellId);
  if (Number.isInteger(plan.castAtLevel)) out.castAtLevel = plan.castAtLevel;
  if (plan.moveTo) out.moveTo = { col: plan.moveTo.col, row: plan.moveTo.row };
  if (plan.featuresFired?.length) out.features = [...plan.featuresFired];
  return out;
}

function jsonSafe(v) {
  try { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); } catch { return undefined; }
}

/** The number a DM sees for a roll: the kept d20 (attack / save) or the damage total. */
function rollNumber(kind, r) {
  if (!r) return null;
  if (kind === 'attack') return Number.isInteger(r.d20?.kept) ? r.d20.kept : null;
  if (kind === 'save') return Number.isInteger(r.kept) ? r.kept : null;
  return Number.isFinite(r.total) ? Math.trunc(r.total) : null;
}

/** The roll result with the DM's number; the engine's reviewRoll re-resolves it. */
function withRoll(kind, r, v) {
  if (kind === 'attack') return { ...r, d20: { ...r.d20, kept: Math.max(1, Math.min(20, v)) } };
  if (kind === 'save') return { ...r, kept: Math.max(1, Math.min(20, v)) };
  return { ...r, total: Math.max(0, v) };
}
