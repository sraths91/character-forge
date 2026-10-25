// The run controller (M65 B24–B26): a campaign run, attached to the Room
// that hosts it. It sequences and persists; every 5e rule comes from
// src/js/campaign/* (rests, XP, death, level-ups, items) and the engine
// (src/js/scene/*). Nothing here computes a rule.
//
// Lifecycle (docs/M65-CAMPAIGN-LOOP-PLAN.md "Run lifecycle"):
//   start → run.started, character.joined per seat, node.entered (start node)
//   encounter node: dm.node.begin builds the encounter from the run states
//     (buildEncounter + entityFromSheet(sheet, {runState, items})) and
//     starts it in the room's turn lane; its end — natural (#runOneTurn) or
//     DM (#endEncounter) — calls onEncounterEnded exactly once
//     (encounters.run_applied_at), which writes everything back in ONE
//     transaction before anything is broadcast:
//       endEncounterCleanup → runStateFromEntity per PC → settleAfterEncounter
//       → item spend → encounterXp → levelsCrossed → level_ups → run_events
//   between kinds (rest / loot / shop / story): between intents
//   dm.run.advance takes an offered edge (nextNodes) or, with override, any node
//   dm.run.end → run.ended {outcome}
//
// Authority is split by time (decision 3): while an encounter is live the
// EncounterState is authoritative and every between intent is refused
// (E_ENCOUNTER_LIVE). Every mutation is one run_events row carrying
// {before, after}, appended in the same transaction as the change and
// broadcast (`run.event`) only after the commit. Between-node randomness
// draws from the persisted run RNG (runs.rng_json, decision 6), so a run
// replays from its log.
//
// Ids the clients see are run-local and deterministic: level-ups are
// `lu-<n>` (stored as `<runId>.lu-<n>`), run items `<runId>.<seq>.<k>`
// (seq = the run event that created them), encounters `<runId>:<nodeId>`.

import { randomInt } from 'node:crypto';
import { createRng } from '../../src/js/scene/rng.js';
import * as TM from '../../src/js/scene/turn-manager.js';
import { runStateFromEntity, itemSpendFromEntity } from '../../src/js/scene/encounter-adapters.js';
import { validateCampaign, startNodeId, campaignSettings } from '../../src/js/shared/campaign.js';
import { initialRunState, validateRunState } from '../../src/js/shared/run-state.js';
import { makeRunEvent, validateRunEvent } from '../../src/js/shared/run-events.js';
import { CampaignRuleError } from '../../src/js/campaign/errors.js';
import { sheetLevel } from '../../src/js/campaign/util.js';
import { encounterXp, levelsCrossed, levelForXp, xpForLevel } from '../../src/js/campaign/xp.js';
import { applyRest } from '../../src/js/campaign/rest.js';
import { settleAfterEncounter, onNodeEntry, lifeStatusOf } from '../../src/js/campaign/death.js';
import { itemsFromInventory } from '../../src/js/campaign/items.js';
import { itemsLedgerFor } from '../../src/js/campaign/consumables.js';
import { nextNodes } from '../../src/js/shared/campaign.js';
import { emptyProgress, reduceProgress, viewForRun, stripProse } from './views.js';

/** Run intents (protocol v1.6) this controller handles. */
export const RUN_INTENTS = Object.freeze([
  'rest.spend', 'loot.claim', 'item.equip', 'item.give', 'item.use', 'shop.buy', 'shop.sell',
  'story.choose', 'levelup.choose', 'levelup.reconcile', 'seat.reclaim',
  'dm.run.advance', 'dm.run.end', 'dm.node.begin', 'dm.rest.grant', 'dm.loot.assign', 'dm.story.resolve',
  'dm.xp.adjust', 'dm.levelup.confirm', 'dm.levelup.revert', 'dm.character.revive', 'dm.character.retire',
  'dm.seat.fill', 'dm.snapshot.save', 'dm.snapshot.load', 'dm.seat.reclaim.approve'
]);
const RUN_INTENT_SET = new Set(RUN_INTENTS);

/** An intent refusal with a stable protocol code (an `error {code}` frame). */
export class RunIntentError extends Error {
  /**
   * @param {string} code  protocol ERROR_CODES value, or a CampaignRuleError code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.runIntentError = true;
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const bySeat = (a, b) => a.seat - b.seat;
/** Engine outcome → the life-status rules' party result. */
const PARTY_RESULT = { 'party-victory': 'victory', 'hostile-victory': 'defeat' };
/** DM-authored actor id: one DM per room, whichever participant holds the token. */
const DM_ACTOR = 'dm';

/**
 * @typedef {object} RoomPort  — the Room's private lane, handed to the controller
 * @property {(t: string, p: object) => void} broadcast
 * @property {(member: object, t: string, p: object) => void} sendPrivate
 * @property {(status: string) => void} setStatus
 * @property {() => Map<string, object>} members
 * @property {() => boolean} encounterLive
 * @property {(o: {encounterId: string, seed: number, setup: object, party: object[], runId: string, nodeId: string}) => object} setupEncounter
 * @property {() => Promise<void>} startEncounter
 * @property {() => object[]} seats
 */

export class RunController {
  /**
   * @param {object} o
   * @param {import('../rooms/room.js').Room} o.room
   * @param {RoomPort} o.port
   * @param {ReturnType<import('./store.js').createRunStore>} o.store
   * @param {(level: string, msg: string, extra?: object) => void} [o.log]
   * @param {(setup: object, ctx: {campaignId: string|null, roomId: string}) => object} [o.materializeSetup]
   *   campaign assets → room uploads (campaigns/setup.js setupForRoom)
   */
  constructor({ room, port, store, log = () => {}, materializeSetup = null }) {
    this.room = room;
    this.port = port;
    this.store = store;
    this.log = log;
    this.materializeSetup = materializeSetup;
    this.row = null;
    this.progress = emptyProgress();
    this.seq = 0;
    this.pending = [];
    /** Hit dice declared for the next short rest: {slotId: {Class: n}} (in memory until granted). */
    this.pendingRest = {};
    /** seat.reclaim requests waiting for the DM: [{slotId, memberId}]. */
    this.reclaims = [];
    this.#load();
  }

  // ------------------------------------------------------------- state

  #load() {
    this.row = this.store.getRunByRoom(this.room.id);
    this.progress = emptyProgress();
    this.seq = this.row?.seq ?? 0;
    if (!this.row) return;
    let after = 0;
    for (;;) {
      const page = this.store.listEvents(this.row.id, { afterSeq: after, limit: 1000 });
      for (const ev of page) this.progress = reduceProgress(this.progress, ev);
      if (page.length < 1000) break;
      after = page.at(-1).seq;
    }
    this.sweep();
  }

  /** True while a run is open (not ended) in this room. */
  get active() {
    return !!this.row && this.row.status !== 'ended';
  }

  /** The room status a run room shows when no encounter is live. */
  get idleRoomStatus() {
    return this.active ? 'between' : 'lobby';
  }

  /** Does this controller handle intent `t`? */
  handles(t) {
    return RUN_INTENT_SET.has(t);
  }

  #runId() { return this.row.id; }
  #campaign() { return this.row.campaign; }
  #settings() { return campaignSettings(this.row.settings); }
  #node(id) { return (this.#campaign().nodes || []).find(n => n.id === id) || null; }
  #current() { return this.progress.currentNodeId ? this.#node(this.progress.currentNodeId) : null; }
  #characters() { return this.store.listCharacters(this.#runId()).sort(bySeat); }
  #character(slotId) {
    const c = this.store.getCharacter(slotId);
    if (!c || c.runId !== this.#runId()) throw new RunIntentError('E_INVALID_INTENT', `seat ${slotId} is not in this run`);
    return c;
  }
  #luDb(local) { return `${this.#runId()}.${local}`; }
  #luLocal(dbId) { return String(dbId).slice(this.#runId().length + 1); }
  #levelUps() { return this.store.listLevelUps(this.#runId()).map(l => ({ ...l, id: this.#luLocal(l.id) })); }

  /** The next free `lu-<n>`. */
  #nextLevelUpId() {
    let n = 0;
    for (const id of this.store.levelUpIds(this.#runId())) {
      const m = /\.lu-(\d+)$/.exec(id);
      if (m) n = Math.max(n, Number(m[1]));
    }
    return `lu-${n + 1}`;
  }

  // ------------------------------------------------------ transactions

  /**
   * Run `fn` in one SQLite transaction; run events it appended are
   * broadcast only after the commit. On failure nothing is broadcast and
   * the in-memory walk is rolled back.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  #tx(fn) {
    const saved = { progress: this.progress, seq: this.seq, row: this.row };
    this.pending = [];
    let out;
    try {
      out = this.store.tx(fn)();
    } catch (err) {
      this.progress = saved.progress;
      this.seq = saved.seq;
      this.row = saved.row;
      this.pending = [];
      throw err;
    }
    this.row = this.store.getRun(this.row.id);
    const evs = this.pending;
    this.pending = [];
    for (const ev of evs) this.port.broadcast('run.event', stripProse(ev));
    if (evs.length) this.#broadcastUpdated();
    return out;
  }

  #broadcastUpdated() {
    this.port.broadcast('run.updated', {
      runId: this.row.id, status: this.row.status, currentNodeId: this.progress.currentNodeId, runSeq: this.row.seq,
      completed: this.progress.completed, pendingRest: clone(this.pendingRest)
    });
  }

  /**
   * Append one run event (inside #tx). Validated against catalogue v1
   * before it is written.
   */
  #emit(type, payload, { actorKind = 'system', actorId = null, override = false, nodeId } = {}) {
    const node = nodeId === undefined ? this.progress.currentNodeId : nodeId;
    const ev = makeRunEvent({ seq: this.seq + 1, type, nodeId: node, actorKind, actorId, override, payload: clone(payload) });
    const v = validateRunEvent(ev);
    if (!v.ok) throw new Error(`run event ${type} is invalid: ${v.errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('; ')}`);
    const seq = this.store.appendEvent(this.#runId(), { type, actorKind, actorId, nodeId: node, override, payload: ev.payload });
    if (seq !== ev.seq) throw new Error(`run seq drifted: expected ${ev.seq}, store gave ${seq}`);
    this.seq = seq;
    this.progress = reduceProgress(this.progress, ev);
    this.pending.push(ev);
    return ev;
  }

  #rng() {
    return createRng(this.row.rng || { s: 0 });
  }

  /** Write a character row (version-checked) and return the fresh row. */
  #write(c, patch) {
    this.store.updateCharacter(this.#runId(), c.slotId, c.version, patch);
    return this.store.getCharacter(c.slotId);
  }

  // ------------------------------------------------------------- start

  /**
   * Start a run in this room with its seated party (M65 B24).
   * @param {object} o
   * @param {object} o.campaign       campaign v1 (frozen into runs.campaign_json)
   * @param {string|null} [o.campaignId]  campaigns.id (null for an ad-hoc campaign)
   * @param {string} [o.runId]
   * @param {number} [o.seed]         run RNG seed (random when absent)
   * @param {Record<string, number>} [o.xp]  starting XP per slotId
   * @param {boolean} [o.importLiveState]  seed state_json from D&D Beyond's live state (default: the room setting)
   * @returns {{runId: string, status: string, currentNodeId: string}}
   */
  start({ campaign, campaignId = null, runId, seed, xp = {}, importLiveState } = {}) {
    if (this.row) throw new RunIntentError('E_INVALID_INTENT', this.active ? 'this room already has an open run' : 'this room already hosted a run');
    if (this.port.encounterLive()) throw new RunIntentError('E_ENCOUNTER_LIVE', 'end the encounter before starting a run');
    const v = validateCampaign(campaign);
    if (!v.ok) throw new RunIntentError('E_INVALID_INTENT', `the campaign is not playable: ${v.errors[0].path} ${v.errors[0].message}`, { errors: v.errors });
    const start = startNodeId(campaign.nodes);
    if (!start) throw new RunIntentError('E_INVALID_INTENT', 'the campaign has no start node');
    const seats = this.port.seats().filter(s => s.seed).sort(bySeat);
    if (!seats.length) throw new RunIntentError('E_INVALID_INTENT', 'seat at least one character before starting a run');
    const live = importLiveState ?? this.room.settings?.importLiveState === true;
    const settings = campaignSettings(campaign.settings);
    const rngSeed = Number.isInteger(seed) ? seed >>> 0 : randomInt(0, 0x100000000);
    const frozen = clone(campaign);

    this.pending = [];
    try {
      this.store.tx(() => {
        const id = this.store.createRun({
          id: runId, campaignId, roomId: this.room.id, campaign: frozen, settings, stash: { currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 } },
          rng: { algo: 'mulberry32', s: rngSeed }, status: 'lobby'
        });
        this.row = this.store.getRun(id);
        this.seq = 0;
        this.progress = emptyProgress();
        const joined = seats.map((s) => {
          const sheet = clone(s.seed);
          const level = sheetLevel(sheet);
          const state = initialRunState(sheet, { importDdbState: live });
          const sv = validateRunState(state, { sheet });
          if (!sv.ok) throw new RunIntentError('E_INVALID_INTENT', `seat ${s.seat}: ${sv.errors[0].path} ${sv.errors[0].message}`);
          const ddbXp = Number.isInteger(sheet.currentXp) && levelForXp(sheet.currentXp) === level ? sheet.currentXp : null;
          const startXp = Number.isInteger(xp[s.id]) ? xp[s.id] : (ddbXp ?? xpForLevel(level));
          this.store.attachSeat(id, s.id, { sheet, state, level, xp: startXp, lifeStatus: 'active' });
          return { s, sheet, state, level, xp: startXp };
        });
        this.#emit('run.started', {
          campaignId: campaign.id, startNodeId: start,
          seats: joined.map(j => ({ slotId: j.s.id, seat: j.s.seat, characterId: String(j.sheet.id) }))
        }, { nodeId: null });
        for (const j of joined) {
          const ev = this.#emit('character.joined', {
            slotId: j.s.id, characterId: String(j.sheet.id), level: j.level, before: null,
            after: { state: j.state, xp: j.xp, level: j.level, lifeStatus: 'active' }
          }, { nodeId: null });
          this.#seedItems(j.s.id, j.sheet, ev.seq);
        }
        this.#enterNode(start, { override: false });
      })();
    } catch (err) {
      this.row = null;
      this.seq = 0;
      this.progress = emptyProgress();
      this.pending = [];
      throw err;
    }
    this.row = this.store.getRun(this.row.id);
    const evs = this.pending;
    this.pending = [];
    for (const ev of evs) this.port.broadcast('run.event', stripProse(ev));
    this.#broadcastUpdated();
    this.#afterChange();
    this.log('info', 'run: started', { roomId: this.room.id, runId: this.row.id, seats: seats.length, startNodeId: start });
    return { runId: this.row.id, status: this.row.status, currentNodeId: this.progress.currentNodeId };
  }

  /** A seat's DDB inventory as run items (ids `<runId>.<seq>.<k>`). */
  #seedItems(slotId, sheet, seq) {
    itemsFromInventory(sheet, { ownerSlotId: slotId }).forEach((it, k) => {
      this.store.addItem(this.#runId(), { ...it, id: `${this.#runId()}.${seq}.${k}`, ownerSlotId: slotId });
    });
  }

  // -------------------------------------------------------- node entry

  /**
   * Enter a node (inside #tx): a stable PC regains 1 HP (owner default 7),
   * node.entered, then the run is in-node (encounter) or between.
   */
  #enterNode(nodeId, { override }) {
    const node = this.#node(nodeId);
    if (!node) throw new RunIntentError('E_INVALID_INTENT', `no node ${nodeId} in this campaign`);
    const from = this.progress.currentNodeId;
    const before = {};
    const after = {};
    for (const c of this.#characters()) {
      if (c.lifeStatus !== 'stable') continue;
      const r = onNodeEntry(c.state);
      before[c.slotId] = { state: c.state, lifeStatus: c.lifeStatus };
      after[c.slotId] = { state: r.state, lifeStatus: r.lifeStatus };
      this.#write(c, { state: r.state, lifeStatus: r.lifeStatus });
    }
    const recovered = Object.keys(after).length ? { before, after } : {};
    this.pendingRest = {};
    this.#emit('node.entered', { nodeId, kind: node.kind, fromNodeId: from, ...recovered },
      { nodeId, actorKind: 'dm', actorId: DM_ACTOR, override });
    this.store.setCurrentNode(this.#runId(), nodeId);
    this.store.setStatus(this.#runId(), node.kind === 'encounter' ? 'in-node' : 'between');
    this.#onEnter(node);
  }

  /** Per-kind effects of entering a node (extended by the between kinds). */
  #onEnter(_node) {}

  // --------------------------------------------------------- encounters

  /** dm.node.begin: build the current encounter node from the run states and start it. */
  async #beginNode(p) {
    const node = this.#current();
    if (!node || node.kind !== 'encounter') throw new RunIntentError('E_INVALID_INTENT', 'the current node is not an encounter');
    if (this.progress.completed || this.progress.result.outcome) throw new RunIntentError('E_INVALID_INTENT', 'this encounter has been fought; advance the run');
    let setup = p.setup ? clone(p.setup) : clone(node.payload.setup ?? (this.#campaign().templates || []).find(t => t.id === node.payload.templateId)?.setup);
    if (!setup) throw new RunIntentError('E_INVALID_INTENT', `node ${node.id} has no encounter setup`);
    const named = setup.map?.assetId || (setup.monsters || []).some(m => m?.tokenAssetId);
    if (named) {
      if (!this.materializeSetup) throw new RunIntentError('E_INVALID_INTENT', 'this server cannot place campaign assets');
      setup = this.materializeSetup(setup, { campaignId: this.row.campaignId, roomId: this.room.id });
    }
    const chars = this.#characters().filter(c => c.lifeStatus !== 'dead');
    if (!chars.length) throw new RunIntentError('E_INVALID_INTENT', 'every character is dead');
    const seats = new Map(this.port.seats().map(s => [s.id, s]));
    const placements = { ...(setup.placements || {}) };
    for (const c of chars) {
      const id = `pc-${c.seat}`;
      if (!placements[id]) placements[id] = clone(node.payload.partyPlacement?.[String(c.seat)] ?? { col: 0, row: c.seat - 1 });
    }
    setup.placements = placements;
    const items = this.store.listItems(this.#runId());
    const party = chars.map(c => {
      const seat = seats.get(c.slotId);
      const ledger = itemsLedgerFor(items.filter(i => i.ownerSlotId === c.slotId));
      return {
        slotId: c.slotId, seat: c.seat, characterId: String(c.sheet.id), characterName: c.sheet.name ?? null,
        controller: this.port.controllerFor(seat), aiArchetype: seat?.aiArchetype ?? null,
        seed: c.sheet, runState: c.state, items: Object.keys(ledger).length ? ledger : null
      };
    });
    let encounterId = `${this.#runId()}:${node.id}`;
    for (let k = 2; this.store.encounterExists(encounterId); k++) encounterId = `${this.#runId()}:${node.id}:${k}`;
    const rng = this.#rng();
    const seed = Math.floor(rng() * 0x100000000) >>> 0;
    // The seed draw and the encounter row commit together.
    this.store.tx(() => {
      this.store.setRng(this.#runId(), rng.state());
      this.port.setupEncounter({ encounterId, seed, setup, party, runId: this.#runId(), nodeId: node.id });
    })();
    this.row = this.store.getRun(this.row.id);
    await this.port.startEncounter();
    return { encounterId };
  }

  /**
   * The room's single encounter-end hook (both end paths). Applies the
   * result exactly once: the run_applied_at mark is taken first, inside
   * the same transaction as every write-back.
   * @param {string} encounterId
   * @returns {boolean} true when this call applied it
   */
  onEncounterEnded(encounterId) {
    if (!this.row) return false;
    const enc = this.store.getEncounter(encounterId);
    if (!enc || enc.runId !== this.row.id || enc.status !== 'ended' || enc.runAppliedAt) return false;
    let applied = false;
    try {
      applied = this.#tx(() => this.#applyEncounter(enc));
    } catch (err) {
      this.log('error', 'run: encounter write-back failed', { roomId: this.room.id, runId: this.row.id, encounterId, error: err.message, stack: err.stack });
      throw err;
    }
    if (applied) {
      this.#afterChange();
      this.#offerLevelUps();
    }
    return applied;
  }

  /** Boot sweep: apply every ended run encounter of this room's run whose mark is NULL. */
  sweep() {
    if (!this.row) return 0;
    let n = 0;
    for (const u of this.store.unappliedEncounters()) {
      if (u.runId !== this.row.id) continue;
      if (this.onEncounterEnded(u.encounterId)) {
        n++;
        this.log('info', 'run: applied an ended encounter at boot', { roomId: this.room.id, runId: this.row.id, encounterId: u.encounterId });
      }
    }
    return n;
  }

  /** The seven write-back steps (inside #tx). */
  #applyEncounter(enc) {
    if (!this.store.markEncounterApplied(enc.id)) return false;
    const node = this.#node(enc.nodeId) || this.#current();
    const settings = this.#settings();
    const outcome = enc.outcome || 'dm-ended';
    // 1–2. Encounter-scoped conditions and concentration end (T22).
    const sheets = enc.sheets || {};
    const ts = TM.turnStateFromEncounter(clone(enc.state), sheets);
    TM.endEncounterCleanup(ts);
    const final = TM.encounterFromTurnState(ts);
    const chars = new Map(this.#characters().map(c => [c.slotId, c]));
    const pcs = Object.values(final.entities).filter(e => e.kind === 'pc' && chars.has(e.controller?.seatId))
      .sort((a, b) => chars.get(a.controller.seatId).seat - chars.get(b.controller.seatId).seat);
    const before = {};
    const after = {};
    const next = new Map();
    for (const e of pcs) {
      const slotId = e.controller.seatId;
      const c = chars.get(slotId);
      const written = runStateFromEntity(e, c.state);
      const sv = validateRunState(written, { sheet: c.sheet });
      if (!sv.ok) throw new Error(`${slotId}: write-back state invalid: ${sv.errors[0].path} ${sv.errors[0].message}`);
      // 4. Life status (death.js: owner default 7 / deathMode).
      const settled = settleAfterEncounter(written, { outcome: PARTY_RESULT[outcome] ?? outcome, deathMode: settings.deathMode });
      const life = c.lifeStatus === 'dead' ? 'dead' : settled.lifeStatus;
      before[slotId] = { state: c.state, lifeStatus: c.lifeStatus };
      after[slotId] = { state: settled.state, lifeStatus: life };
      next.set(slotId, { state: settled.state, lifeStatus: life, xp: c.xp });
    }
    this.#emit('encounter.result', { encounterId: enc.id, outcome, rounds: final.round, before, after }, { nodeId: node.id });
    for (const [slotId, n] of next) {
      if (n.lifeStatus === 'dead' && before[slotId].lifeStatus !== 'dead') {
        this.#emit('character.died', { slotId, cause: 'encounter', before: { lifeStatus: before[slotId].lifeStatus }, after: { lifeStatus: 'dead' } }, { nodeId: node.id });
      }
    }
    // 5. Potions and charges the PCs spent → run_items.
    for (const e of pcs) {
      for (const [itemId, spent] of Object.entries(itemSpendFromEntity(e))) {
        if (!(spent > 0)) continue;
        const it = this.store.getItem(this.#runId(), itemId);
        if (!it) continue;
        const qty = Math.max(0, it.qty - spent);
        this.store.updateItem(this.#runId(), itemId, { qty });
        this.#emit('item.used', { itemId, slotId: e.controller.seatId, targetSlotId: null, spent, before: { qty: it.qty }, after: { qty } }, { nodeId: node.id });
      }
    }
    // 3. XP (milestone mode awards nothing).
    if (settings.xpMode === 'xp') {
      const defeated = Object.values(final.entities).filter(e => e.side === 'hostile' && (e.hp === 0 || e.status === 'dead'));
      const participants = [...next.keys()].filter(s => next.get(s).lifeStatus !== 'dead').map(id => ({ id }));
      const override = node.kind === 'encounter' && Number.isInteger(node.payload?.xpOverride);
      const award = encounterXp(override ? [{ xp: node.payload.xpOverride }] : defeated, participants, { mode: 'xp' });
      const xb = {};
      const xa = {};
      for (const [slotId, n] of Object.entries(award.awards)) {
        xb[slotId] = next.get(slotId).xp;
        next.get(slotId).xp += n;
        xa[slotId] = next.get(slotId).xp;
      }
      this.#emit('xp.awarded', { total: award.total, perCharacter: award.awards, before: xb, after: xa }, { nodeId: node.id });
      // 6. One level_ups row per crossed threshold.
      for (const slotId of Object.keys(award.awards)) this.#queueLevels(chars.get(slotId), xb[slotId], xa[slotId], node.id);
    }
    // 1. Write back (version + 1 each).
    for (const [slotId, n] of next) this.#write(chars.get(slotId), { state: n.state, lifeStatus: n.lifeStatus, xp: n.xp });
    this.#onEncounterResult(node, outcome);
    // 7. Close the node; the run is between nodes.
    this.#emit('node.completed', { nodeId: node.id, kind: node.kind }, { nodeId: node.id });
    this.store.setStatus(this.#runId(), 'between');
    return true;
  }

  /** Victory loot and other per-outcome effects (extended by the between kinds). */
  #onEncounterResult(_node, _outcome) {}

  /** level_ups rows (and level.queued) for the thresholds between two XP totals. */
  #queueLevels(c, fromXp, toXp, nodeId) {
    const settings = this.#settings();
    const pending = this.store.pendingLevelUps(c.slotId);
    const top = pending.length ? pending[pending.length - 1].toLevel : (c.level ?? sheetLevel(c.sheet));
    for (const to of levelsCrossed(fromXp, toXp, { mode: settings.xpMode, currentLevel: top })) {
      const local = this.#nextLevelUpId();
      this.store.addLevelUp(this.#runId(), {
        id: this.#luDb(local), slotId: c.slotId, fromLevel: to - 1, mode: settings.levelUpMode,
        status: settings.levelUpMode === 'choose' ? 'pending_player' : 'pending_dm'
      });
      this.#emit('level.queued', { levelUpId: local, slotId: c.slotId, fromLevel: to - 1, toLevel: to }, { nodeId });
    }
  }

  /** levelup.offer to each pending level-up's seat (and the DM). Extended in B25. */
  #offerLevelUps() {}

  // --------------------------------------------------------- broadcasts

  /** After a committed change: room status and fresh run snapshots. */
  #afterChange() {
    if (!this.port.encounterLive()) this.port.setStatus(this.idleRoomStatus);
    for (const m of this.port.members().values()) if (m.conn) this.sendSnapshot(m);
  }

  /**
   * The `run.snapshot` payload for one member, or null without a run.
   * @param {{role: 'dm'|'player', id: string}} member
   */
  snapshotFor(member) {
    if (!this.row) return null;
    return viewForRun({
      run: this.row, progress: this.progress, characters: this.#characters(), items: this.store.listItems(this.#runId()),
      levelUps: this.#levelUps(), seats: this.port.seats(), pendingRest: this.pendingRest, reclaims: this.reclaims
    }, member);
  }

  /** Send a member its run.snapshot (no-op without a run). */
  sendSnapshot(member) {
    const p = this.snapshotFor(member);
    if (p) this.port.sendPrivate(member, 'run.snapshot', p);
  }

  // ------------------------------------------------------------ intents

  /**
   * Handle one run intent (already validated by protocol.js and the
   * room's dm/player role check).
   * @param {{id: string, role: 'dm'|'player'}} member
   * @param {string} t
   * @param {object} p
   * @returns {Promise<object>} ack extras
   */
  async handle(member, t, p) {
    if (!this.row) throw new RunIntentError('E_NO_RUN', 'this room has no run');
    if (this.row.status === 'ended') throw new RunIntentError('E_NO_RUN', 'this run has ended');
    if (this.port.encounterLive()) throw new RunIntentError('E_ENCOUNTER_LIVE', `${t} waits until the encounter ends`);
    try {
      return await this.#dispatch(member, t, p);
    } catch (err) {
      if (err instanceof CampaignRuleError) throw new RunIntentError(err.code, err.message, err.details);
      throw err;
    }
  }

  async #dispatch(member, t, p) {
    const actor = member.role === 'dm' ? { actorKind: 'dm', actorId: DM_ACTOR } : { actorKind: 'player', actorId: member.id };
    switch (t) {
      case 'dm.run.advance': return this.#advance(p);
      case 'dm.run.end': return this.#end(p);
      case 'dm.node.begin': return this.#beginNode(p);
      case 'rest.spend': return this.#restSpend(member, p);
      case 'dm.rest.grant': return this.#restGrant(p);
      default: return this.#more(member, t, p, actor);
    }
  }

  /** Intents added by later tasks. */
  #more(_member, t) {
    throw new RunIntentError('E_UNKNOWN_TYPE', `${t} is not available yet`);
  }

  /**
   * A seat intent's seat: a player only for the seat they control; the DM
   * for a seat no player controls (an AI / DM-driven seat).
   */
  #ownSeat(member, slotId) {
    const c = this.#character(slotId);
    const seat = this.port.seats().find(s => s.id === slotId);
    const ctl = seat?.controllerParticipantId ?? null;
    if (member.role === 'dm' ? ctl !== null : ctl !== member.id) throw new RunIntentError('E_FORBIDDEN', 'that is not your seat');
    return c;
  }

  #advance({ toNodeId, override = false }) {
    const node = this.#current();
    if (!this.#node(toNodeId)) throw new RunIntentError('E_INVALID_INTENT', `no node ${toNodeId} in this campaign`);
    const offered = node ? nextNodes(node, this.progress.result).map(e => e.to) : [];
    const isOffered = offered.includes(toNodeId);
    if (!isOffered && !override) throw new RunIntentError('E_INVALID_INTENT', `${toNodeId} is not on offer (${offered.join(', ') || 'none'}); override to go anywhere`);
    if (node?.kind === 'encounter' && !this.progress.result.outcome && !override) {
      throw new RunIntentError('E_INVALID_INTENT', 'fight this encounter first (dm.node.begin), or override');
    }
    this.#tx(() => {
      if (node && !this.progress.completed) this.#emit('node.completed', { nodeId: node.id, kind: node.kind });
      this.#enterNode(toNodeId, { override: !isOffered });
    });
    this.#afterChange();
    return { currentNodeId: this.progress.currentNodeId };
  }

  #end({ outcome }) {
    this.#tx(() => {
      this.#emit('run.ended', { outcome }, { actorKind: 'dm', actorId: DM_ACTOR });
      this.store.setStatus(this.#runId(), 'ended', { outcome });
    });
    this.pendingRest = {};
    this.#afterChange();
    this.log('info', 'run: ended', { roomId: this.room.id, runId: this.row.id, outcome });
    return { outcome };
  }

  // -------------------------------------------------------------- rests

  /** rest.spend: declare the hit dice a seat spends at the next short rest (validated, not yet rolled). */
  #restSpend(member, { slotId, hitDice }) {
    const c = this.#ownSeat(member, slotId);
    // Dry run with a throwaway rng: the rules refuse an overspend before rolling.
    applyRest(c.sheet, c.state, 'short', { spend: hitDice, rng: createRng({ s: 1 }), lifeStatus: c.lifeStatus });
    this.pendingRest[slotId] = clone(hitDice);
    this.#broadcastUpdated();
    return { pending: clone(hitDice) };
  }

  /** dm.rest.grant: the rest happens (applyRest per character, one rest.taken). */
  #restGrant({ type, slotIds }) {
    const node = this.#current();
    const nodeRest = node?.kind === 'rest' && !this.progress.completed && (node.payload.type === 'choice' || node.payload.type === type);
    const listed = Array.isArray(slotIds) ? new Set(slotIds) : null;
    const chars = this.#characters().filter(c => (listed ? listed.has(c.slotId) : true));
    if (listed && chars.length !== listed.size) throw new RunIntentError('E_INVALID_INTENT', 'a listed seat is not in this run');
    const settings = this.#settings();
    this.#tx(() => {
      const rng = this.#rng();
      const before = {};
      const after = {};
      const rolls = {};
      const skipped = {};
      const applied = [];
      const lives = {};
      for (const c of chars) {
        if (c.lifeStatus === 'dead') { skipped[c.slotId] = 'dead'; continue; }
        let r;
        try {
          r = applyRest(c.sheet, c.state, type, {
            spend: type === 'short' ? this.pendingRest[c.slotId] : undefined, rng, dawnIsLongRest: settings.dawnIsLongRest, lifeStatus: c.lifeStatus
          });
        } catch (err) {
          if (!(err instanceof CampaignRuleError) || listed) throw err;
          skipped[c.slotId] = err.code;
          continue;
        }
        before[c.slotId] = c.state;
        after[c.slotId] = r.state;
        rolls[c.slotId] = r.rolls;
        applied.push(c.slotId);
        const life = lifeStatusOf(r.state);
        lives[c.slotId] = life;
        this.#write(c, life !== c.lifeStatus ? { state: r.state, lifeStatus: life } : { state: r.state });
      }
      this.store.setRng(this.#runId(), rng.state());
      const extra = Object.keys(skipped).length ? { skipped } : {};
      this.#emit('rest.taken', { type, slotIds: applied, rolls, before, after, ...extra },
        nodeRest ? {} : { actorKind: 'dm', actorId: DM_ACTOR, override: true });
      for (const s of applied) delete this.pendingRest[s];
      if (nodeRest) this.#emit('node.completed', { nodeId: node.id, kind: node.kind });
    });
    this.#afterChange();
    return {};
  }
}
