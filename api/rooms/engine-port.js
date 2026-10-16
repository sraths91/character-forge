// The engine-step interface the room drives (M64 B7/B8).
//
// The room never imports the combat engine directly; it drives an
// EnginePort. Wave 3 ships `createStubEngine` (deterministic, tiny rules)
// so rooms, prompts, persistence and recovery are testable now. Wave 4
// swaps in an adapter over E1's turn manager + encounter adapters + prompt
// adapter + validateIntent (one file: implement this typedef).
//
// Contract rules (the room relies on every one of them):
//  1. State in, state out. Every method takes an EncounterState v1 (pure
//     JSON, shared/encounter-state.js) and returns a NEW one; it never
//     mutates the argument and never keeps references to it.
//  2. Every die goes through `ctx.rng` (a `createRng` stream). The room
//     builds it from `state.rng` before the call and writes `rng.state()`
//     back afterwards, so the port must not touch `state.rng` itself.
//  3. Events: call `ctx.emit({type, payload, cinemaGroup?})` for every
//     event, in order, as it happens. `emit` validates the event, stamps
//     `seq`, `round` and `turnId`, and returns the stamped event. The
//     resolved `{events}` is that same stamped list (for callers that pass
//     a collecting emit, e.g. a simulator). Payloads carry ids only.
//  4. The ROOM emits `reaction.offered` / `reaction.resolved` (from its
//     PromptBroker) and `dm.override` (from DM gates). The port must not.
//  5. `turn.ended` is the last event of `runTurn`; the room fills its
//     `payload.stateHash` from the returned state. On victory the port
//     emits `encounter.ended {outcome}` after `turn.ended` and returns
//     `phase: 'ended'`.
//  6. Determinism: given the same input state, rng state and prompt
//     answers, `runTurn` emits the same events and returns the same state.
//     Boot recovery re-runs an interrupted turn this way (no wall clock,
//     no Math.random).
//  7. Before every awaited prompt, call `ctx.progress(currentState)` so a
//     client (re)connecting mid-turn gets a current snapshot.
//
// Prompts (all answered by the room; all may be awaited):
//   intent({actorId, turnId, controller, state})
//       → Promise<{intent: {kind:'plan', plan} | {kind:'delegate'} | {kind:'skip'}, state}>
//     Asked when the actor's controller is 'player' or 'dm'. This is the
//     turn's safe point: DM edits made while waiting are applied to `state`
//     and the engine MUST continue from the returned `state`.
//   reaction({kind:'oa'|'shield'|'counterspell', reactorId, autoAnswer, eligible, payload}) → Promise<boolean>
//     The room checks `eligible` first (false → resolves false, no prompt).
//     The engine re-checks eligibility after any `true`.
//   planReady({actorId, plan, breakdown}) → Promise<plan|null>   (null = skip the action)
//   roll({rollKind:'attack'|'damage'|'save', actorId, targetId, result}) → Promise<number>
//     Called after the rng draw so the stream stays aligned.
//   cinema(exchangeEvent) → Promise<void>
//     After emitting an `exchange` (events v1.1: payload.cinema.durationMs =
//     sequence length, 0 when unknown); resolves on every connected
//     member's `cinema.done` or the cap (durationMs, or the room's fallback
//     when 0, plus 1.5 s).

/** Version of this interface; also stored as encounters.engine_version by the stub. */
export const ENGINE_PORT_VERSION = 1;

/**
 * @typedef {import('../../src/js/shared/encounter-state.js').EncounterState} EncounterState
 * @typedef {import('../../src/js/shared/events.js').EncounterEvent} EncounterEvent
 * @typedef {{type: string, payload: object, cinemaGroup?: string|null}} PortEvent
 * @typedef {(() => number) & {state: () => {algo: 'mulberry32', s: number}}} PortRng
 *
 * @typedef {object} TurnPrompts
 * @property {(a: {actorId: string, turnId: string, controller: object, state: EncounterState}) => Promise<{intent: {kind: 'plan'|'delegate'|'skip', plan?: object}, state: EncounterState}>} intent
 * @property {(a: {kind: string, reactorId: string, autoAnswer: boolean, eligible: boolean, payload?: object}) => Promise<boolean>} reaction
 * @property {(a: {actorId: string, plan: object, breakdown?: unknown[]}) => Promise<object|null>} planReady
 * @property {(a: {rollKind: string, actorId: string, targetId?: string|null, result: number}) => Promise<number>} roll
 * @property {(exchange: EncounterEvent) => Promise<void>} cinema
 *
 * @typedef {object} TurnContext
 * @property {string} turnId
 * @property {PortRng} rng
 * @property {(ev: PortEvent) => EncounterEvent} emit
 * @property {(state: EncounterState) => void} progress
 * @property {TurnPrompts} prompts
 *
 * @typedef {object} SeatInfo
 * @property {string} slotId        party_slots.id (becomes controller.seatId)
 * @property {number} seat
 * @property {string|null} characterId
 * @property {string|null} characterName
 * @property {'player'|'ai'} controller
 * @property {string|null} aiArchetype
 * @property {object|null} seed     parsed character (party_slots.seed_parsed_json)
 *
 * @typedef {object} EnginePort
 * @property {number} version
 * @property {(a: {encounterId: string, seed: number, setup: object, party: SeatInfo[]}) => EncounterState} buildEncounter
 *   From `dm.encounter.setup {map, grid, monsters, placements}` and the seats; phase 'setup'.
 * @property {(state: EncounterState, ctx: {emit: TurnContext['emit'], rng: PortRng}) => Promise<{state: EncounterState, events: EncounterEvent[]}>} startEncounter
 *   Rolls initiative if empty, round 1, turnIndex 0, phase 'running'.
 * @property {(state: EncounterState, ctx: TurnContext) => Promise<{state: EncounterState, events: EncounterEvent[]}>} runTurn
 *   One creature's turn, then advance turnIndex/round.
 * @property {(state: EncounterState, intent: {actorId: string, plan: object}) => ({ok: true} | {ok: false, code: string, reason: string})} validateIntent
 * @property {(state: EncounterState, cmd: {type: string, payload: object}, ctx: {emit: TurnContext['emit'], rng: PortRng}) => {state: EncounterState, events: EncounterEvent[]}} applyDmCommand
 *   DM edits at a safe point: dm.entity.patch / add / remove, dm.terrain.paint,
 *   dm.initiative.roll / set. Emits `dm.override` itself only for rules
 *   effects; the room diffs entities and broadcasts `entity.updated`.
 */

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * A deterministic stand-in engine with tiny rules: d20 initiative, one
 * melee attack per turn (d20 + 4 vs AC, 1d6 + 2 damage), an optional
 * Shield reaction for player-controlled targets (+5 AC), and victory when
 * one side is down. Exercises every prompt the room implements.
 *
 * @param {object} [opts]
 * @param {number} [opts.version=ENGINE_PORT_VERSION]
 * @param {number} [opts.cinemaMs=600]  cinema.durationMs put on each exchange
 * @returns {EnginePort}
 */
export function createStubEngine({ version = ENGINE_PORT_VERSION, cinemaMs = 600 } = {}) {
  const d = (rng, n) => 1 + Math.floor(rng() * n);
  const alive = (e) => e && e.hp > 0;
  const enemiesOf = (state, e) => Object.values(state.entities).filter(o => o.side !== e.side && alive(o));
  const sideAlive = (state, side) => Object.values(state.entities).some(o => o.side === side && alive(o));

  function entity(id, kind, side, name, { hp = 12, ac = 12, pos, controller, sheetRef = null, slug = null }) {
    return {
      id, kind, side, name, controller, pos, hp, hpMax: hp, hpTemp: 0, ac, speedFt: 30,
      conditions: [], concentration: null,
      resources: { reactionUsed: false, slots: kind === 'pc' ? { 1: { max: 2, spent: 0 } } : {}, pact: {}, innate: null, legendaryBudget: 0, features: {} },
      turnFlags: {},
      ...(kind === 'pc' ? { sheetRef } : { statBlock: { slug } })
    };
  }

  function buildEncounter({ encounterId, seed, setup, party }) {
    const cols = setup.grid.cols;
    const rows = setup.grid.rows;
    const placements = setup.placements || {};
    const state = {
      v: 1, encounterId, round: 0, turnIndex: 0, phase: 'setup',
      rng: { algo: 'mulberry32', s: seed >>> 0 },
      grid: { cols, rows, cellFt: 5, flankingEnabled: false },
      map: setup.map ? clone(setup.map) : null,
      initiative: [], entities: {}, lastEventSeq: 0
    };
    const place = (id, i, row) => {
      const p = placements[id];
      return p && Number.isInteger(p.col) && Number.isInteger(p.row)
        ? { col: Math.min(p.col, cols - 1), row: Math.min(p.row, rows - 1) }
        : { col: Math.min(i, cols - 1), row: Math.min(row, rows - 1) };
    };
    party.forEach((s, i) => {
      const id = `pc-${s.seat}`;
      state.entities[id] = entity(id, 'pc', 'party', s.characterName || `Seat ${s.seat}`, {
        hp: 14, ac: 14, pos: place(id, i, 0),
        controller: { type: s.controller === 'player' ? 'player' : 'ai', seatId: s.slotId },
        sheetRef: { characterId: String(s.characterId ?? s.slotId), rev: 0 }
      });
    });
    (setup.monsters || []).forEach((m, i) => {
      const id = typeof m.id === 'string' && m.id ? m.id : `m-${i + 1}`;
      state.entities[id] = entity(id, 'monster', 'hostile', String(m.name || `Monster ${i + 1}`).slice(0, 128), {
        hp: Number.isInteger(m.hp) && m.hp > 0 ? m.hp : 7, ac: Number.isInteger(m.ac) ? m.ac : 12,
        pos: place(id, i, rows - 1), controller: { type: 'ai', seatId: null }, slug: String(m.slug || 'goblin')
      });
    });
    return state;
  }

  function rollInitiative(state, rng) {
    const rolls = Object.keys(state.entities).sort().map(id => ({ entityId: id, score: d(rng, 20) }));
    rolls.sort((a, b) => b.score - a.score || (a.entityId < b.entityId ? -1 : 1));
    return rolls;
  }

  async function startEncounter(state, { rng }) {
    const s = clone(state);
    if (s.initiative.length === 0) s.initiative = rollInitiative(s, rng);
    s.round = 1;
    s.turnIndex = 0;
    s.phase = 'running';
    return { state: s, events: [] };
  }

  function advance(s) {
    const n = s.initiative.length;
    for (let k = 1; k <= n; k++) {
      const idx = (s.turnIndex + k) % n;
      if (idx === 0) s.round += 1;
      if (alive(s.entities[s.initiative[idx].entityId])) { s.turnIndex = idx; return; }
    }
  }

  async function runTurn(input, ctx) {
    let s = clone(input);
    const events = [];
    const emit = (ev) => { const st = ctx.emit(ev); events.push(st); return st; };
    const actorId = s.initiative[s.turnIndex].entityId;
    let actor = s.entities[actorId];
    actor.resources.reactionUsed = false;
    actor.turnFlags = {};
    emit({ type: 'turn.started', payload: { actorId } });

    let plan = null;
    let source = 'ai';
    if (actor.controller.type !== 'ai') {
      ctx.progress(s);
      const res = await ctx.prompts.intent({ actorId, turnId: ctx.turnId, controller: clone(actor.controller), state: clone(s) });
      s = clone(res.state);
      actor = s.entities[actorId];
      if (res.intent.kind === 'skip') {
        emit({ type: 'turn.skipped', payload: { actorId, reason: 'skipped' } });
        emit({ type: 'turn.ended', payload: { actorId } });
        advance(s);
        return { state: s, events };
      }
      if (res.intent.kind === 'plan') { plan = clone(res.intent.plan); source = actor.controller.type === 'dm' ? 'dm' : 'player'; }
    }
    if (!alive(actor)) {
      emit({ type: 'turn.skipped', payload: { actorId, reason: 'down' } });
    } else {
      if (!plan) {
        const target = enemiesOf(s, actor).sort((a, b) => a.hp - b.hp || (a.id < b.id ? -1 : 1))[0];
        plan = { kind: 'melee', targetId: target ? target.id : null };
        if (target) {
          ctx.progress(s);
          const reviewed = await ctx.prompts.planReady({ actorId, plan: clone(plan), breakdown: [] });
          plan = reviewed ? clone(reviewed) : null;
        }
      }
      if (plan && plan.targetId && alive(s.entities[plan.targetId])) {
        emit({ type: 'plan.chosen', payload: { actorId, kind: plan.kind, targetId: plan.targetId, source } });
        const target = s.entities[plan.targetId];
        const raw = d(ctx.rng, 20);
        ctx.progress(s);
        const kept = await ctx.prompts.roll({ rollKind: 'attack', actorId, targetId: target.id, result: raw });
        const bonus = 4;
        let ac = target.ac;
        let shielded = false;
        const wouldHit = kept === 20 || kept + bonus >= ac;
        const slot = target.resources.slots['1'];
        if (wouldHit && kept !== 20 && target.controller.type === 'player') {
          ctx.progress(s);
          const eligible = !target.resources.reactionUsed && !!slot && slot.spent < slot.max && kept + bonus < ac + 5;
          const used = await ctx.prompts.reaction({ kind: 'shield', reactorId: target.id, autoAnswer: false, eligible, payload: { attackTotal: kept + bonus, ac } });
          if (used && eligible) {
            shielded = true;
            ac += 5;
            target.resources.reactionUsed = true;
            slot.spent += 1;
            emit({ type: 'resource.spent', payload: { entityId: target.id, resource: 'slot', level: 1 } });
          }
        }
        const crit = kept === 20;
        const hit = crit || kept + bonus >= ac;
        const group = `x-${ctx.turnId}`;
        emit({ type: 'attack.rolled', cinemaGroup: group, payload: {
          attackerId: actorId, targetId: target.id, weapon: null, isReaction: false, advantage: 'normal',
          d20: [kept], kept, bonus, total: kept + bonus, ac, hit, crit, shielded
        } });
        const before = target.hp;
        let amount = 0;
        if (hit) {
          const rolled = d(ctx.rng, 6) * (crit ? 2 : 1) + 2;
          amount = await ctx.prompts.roll({ rollKind: 'damage', actorId, targetId: target.id, result: rolled });
          target.hp = Math.max(0, target.hp - Math.max(0, amount));
          emit({ type: 'damage', cinemaGroup: group, payload: { sourceId: actorId, targetId: target.id, amount: before - target.hp, type: 'slashing', hpBefore: before, hpAfter: target.hp } });
        }
        const fx = Math.floor(ctx.rng() * 0xFFFFFFFF) >>> 0;
        const exchange = emit({ type: 'exchange', cinemaGroup: group, payload: {
          exchangeId: `x-${ctx.turnId}`, attackerId: actorId, defenderId: target.id, reaction: false, cast: false,
          roll: { kept, total: kept + bonus, ac, hit, crit, shielded },
          damage: hit ? { total: before - target.hp } : null,
          effects: [{ entityId: target.id, hp: { before, after: target.hp, max: target.hpMax } }],
          cinema: {
            weapon: null, style: null, swing: null, modifiers: [], smiteSlot: null, attackerLevel: 1,
            killing: before > 0 && target.hp === 0, spell: null, outcome: null, fxSeed: fx, durationMs: cinemaMs
          }
        } });
        ctx.progress(s);
        await ctx.prompts.cinema(exchange);
        if (before > 0 && target.hp === 0) emit({ type: 'entity.downed', payload: { entityId: target.id } });
      } else {
        emit({ type: 'turn.skipped', payload: { actorId, reason: plan ? 'no-target' : 'dm-skipped' } });
      }
    }
    emit({ type: 'turn.ended', payload: { actorId } });
    const partyUp = sideAlive(s, 'party');
    const hostileUp = sideAlive(s, 'hostile');
    if (!partyUp || !hostileUp) {
      s.phase = 'ended';
      emit({ type: 'encounter.ended', payload: { outcome: partyUp ? 'party-victory' : hostileUp ? 'hostile-victory' : 'draw' } });
    } else {
      advance(s);
    }
    return { state: s, events };
  }

  function validateIntent(state, { actorId, plan }) {
    const actor = state.entities[actorId];
    if (!actor || state.initiative[state.turnIndex]?.entityId !== actorId) return { ok: false, code: 'NOT_YOUR_TURN', reason: 'not this creature\'s turn' };
    if (!['melee', 'attack', 'ranged'].includes(plan.kind)) return { ok: false, code: 'UNSUPPORTED', reason: `the stub engine only resolves attacks, not ${plan.kind}` };
    const target = plan.targetId ? state.entities[plan.targetId] : null;
    if (!target) return { ok: false, code: 'BAD_TARGET', reason: 'unknown target' };
    if (target.side === actor.side) return { ok: false, code: 'BAD_TARGET', reason: 'target is an ally' };
    if (!alive(target)) return { ok: false, code: 'BAD_TARGET', reason: 'target is down' };
    return { ok: true };
  }

  function applyDmCommand(state, { type, payload }, { rng }) {
    const s = clone(state);
    const p = payload || {};
    switch (type) {
      case 'dm.entity.patch': {
        const e = s.entities[p.entityId];
        if (!e) throw Object.assign(new Error('unknown entity'), { code: 'E_INVALID_INTENT' });
        if (p.hp !== undefined) e.hp = Math.min(p.hp, e.hpMax);
        if (p.hpTemp !== undefined) e.hpTemp = p.hpTemp;
        if (p.position) e.pos = { col: Math.min(p.position.col, s.grid.cols - 1), row: Math.min(p.position.row, s.grid.rows - 1) };
        const rm = new Set(p.removeConditions || []);
        e.conditions = e.conditions.filter(c => !rm.has(typeof c === 'string' ? c : c.id));
        for (const c of p.addConditions || []) if (!e.conditions.includes(c)) e.conditions.push(c);
        break;
      }
      case 'dm.entity.remove': {
        if (!s.entities[p.entityId]) throw Object.assign(new Error('unknown entity'), { code: 'E_INVALID_INTENT' });
        const cur = s.initiative[s.turnIndex]?.entityId;
        delete s.entities[p.entityId];
        s.initiative = s.initiative.filter(r => r.entityId !== p.entityId);
        const idx = s.initiative.findIndex(r => r.entityId === cur);
        s.turnIndex = idx >= 0 ? idx : Math.min(s.turnIndex, Math.max(0, s.initiative.length - 1));
        break;
      }
      case 'dm.entity.add': {
        const m = p.entity || {};
        let id = typeof m.id === 'string' && m.id ? m.id : `m-${Object.keys(s.entities).length + 1}`;
        while (s.entities[id]) id += 'x';
        s.entities[id] = entity(id, 'monster', 'hostile', String(m.name || 'Monster').slice(0, 128), {
          hp: Number.isInteger(m.hp) && m.hp > 0 ? m.hp : 7, ac: Number.isInteger(m.ac) ? m.ac : 12,
          pos: { col: 0, row: s.grid.rows - 1 }, controller: { type: 'ai', seatId: null }, slug: String(m.slug || 'goblin')
        });
        if (s.phase !== 'setup' || s.initiative.length) {
          s.initiative.push({ entityId: id, score: typeof p.initiativeScore === 'number' ? p.initiativeScore : d(rng, 20) });
        }
        break;
      }
      case 'dm.initiative.roll':
        s.initiative = rollInitiative(s, rng);
        s.turnIndex = 0;
        break;
      case 'dm.initiative.set': {
        const ids = p.order;
        const all = Object.keys(s.entities);
        if (ids.length !== all.length || !ids.every(id => s.entities[id])) {
          throw Object.assign(new Error('order must list every entity exactly once'), { code: 'E_INVALID_INTENT' });
        }
        s.initiative = ids.map((id, i) => ({ entityId: id, score: ids.length - i }));
        s.turnIndex = 0;
        break;
      }
      case 'dm.terrain.paint': {
        // One byte of flags per cell (stub layout; Wave 4 uses grid-legality's codec).
        const n = s.grid.cols * s.grid.rows;
        const bytes = s.grid.terrain ? Buffer.from(s.grid.terrain.flags, 'base64') : Buffer.alloc(n);
        for (const c of p.cells) {
          if (c.col >= s.grid.cols || c.row >= s.grid.rows) continue;
          const i = c.row * s.grid.cols + c.col;
          bytes[i] = p.mode === 'set' ? (bytes[i] | p.flags) : (bytes[i] & ~p.flags);
        }
        s.grid.terrain = { v: 1, cols: s.grid.cols, rows: s.grid.rows, flags: bytes.toString('base64') };
        break;
      }
      default:
        throw Object.assign(new Error(`unsupported DM command ${type}`), { code: 'E_INVALID_INTENT' });
    }
    return { state: s, events: [] };
  }

  return { version, buildEncounter, startEncounter, runTurn, validateIntent, applyDmCommand };
}
