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
import {
  initialRunState, validateRunState, settleOutcomeOf, validateRunSnapshot, RUN_SNAPSHOT_VERSION, SNAPSHOT_RUN_STATUSES, runHash
} from '../../src/js/shared/run-state.js';
import { makeRunEvent, validateRunEvent } from '../../src/js/shared/run-events.js';
import { CampaignRuleError } from '../../src/js/campaign/errors.js';
import { sheetLevel } from '../../src/js/campaign/util.js';
import { encounterXp, levelsCrossed, levelForXp, xpForLevel } from '../../src/js/campaign/xp.js';
import { applyRest } from '../../src/js/campaign/rest.js';
import { settleAfterEncounter, onNodeEntry, lifeStatusOf } from '../../src/js/campaign/death.js';
import {
  itemsFromInventory, itemFromOpen5e, makeItem, equipItem, unequipItem, attuneItem,
  priceOf, purseToCp, addCurrency, payFromPurse
} from '../../src/js/campaign/items.js';
import { itemsLedgerFor, drinkPotion } from '../../src/js/campaign/consumables.js';
import { castDowntimeHeal } from '../../src/js/campaign/downtime-spells.js';
import { revive } from '../../src/js/campaign/death.js';
import { planLevelUp, applyLevelUp, revertLevelUp, reconcileDiff, applyReconcile } from '../../src/js/campaign/level-up.js';
import { newId } from '../rooms/tokens.js';
import { nextNodes } from '../../src/js/shared/campaign.js';
import { emptyProgress, reduceProgress, viewForRun, stripProse } from './views.js';

/** Run intents (protocol v1.6) this controller handles. */
export const RUN_INTENTS = Object.freeze([
  'rest.spend', 'loot.claim', 'item.equip', 'item.give', 'item.use', 'shop.buy', 'shop.sell',
  'story.choose', 'levelup.choose', 'levelup.reconcile', 'seat.reclaim',
  'dm.run.advance', 'dm.run.end', 'dm.node.begin', 'dm.rest.grant', 'dm.loot.assign', 'dm.story.resolve',
  'dm.xp.adjust', 'dm.levelup.confirm', 'dm.levelup.revert', 'dm.character.revive', 'dm.character.retire',
  'dm.seat.fill', 'dm.snapshot.save', 'dm.snapshot.load', 'dm.seat.reclaim.approve',
  'dm.stash.split', 'stash.take', 'cast.downtime'   // v1.7 (E3 M65 W4)
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

const spellKey = (x) => `${String(x?.name || '').toLowerCase()}|${x?.level}`;
const featureKey = (x) => `${String(x?.name || '').toLowerCase()}|${x?.source}`;
const isGameTagged = (x) => x?.source === 'game' || x?.grantedBy === 'game';

/**
 * What the game granted a seat: the spells, class features, feats and
 * raised ability scores its applied (not reverted) level-ups added,
 * read from each row's `granted` sheet patches (after minus before).
 * @param {object[]} levelUps  the seat's level_ups rows
 */
export function gameGrants(levelUps) {
  const out = { spells: new Set(), features: new Set(), feats: new Set(), stats: new Set() };
  for (const l of levelUps) {
    if (l.status !== 'applied' || l.mode === 'reconcile' || l.granted?.kind === 'reconcile') continue;
    for (const p of l.granted?.sheet || []) {
      const field = p.path?.[0];
      const before = p.before;
      const after = p.after;
      if (field === 'spells' || field === 'classFeatures') {
        const key = field === 'spells' ? spellKey : featureKey;
        const had = new Set((Array.isArray(before) ? before : []).map(key));
        for (const x of Array.isArray(after) ? after : []) if (!had.has(key(x))) out[field === 'spells' ? 'spells' : 'features'].add(key(x));
      } else if (field === 'feats') {
        const had = new Set(Array.isArray(before) ? before : []);
        for (const f of Array.isArray(after) ? after : []) if (!had.has(f)) out.feats.add(f);
      } else if (field === 'abilityScores') {
        for (const [stat, v] of Object.entries(after || {})) if (Number(v) > Number(before?.[stat] ?? v)) out.stats.add(stat);
      }
    }
  }
  return out;
}

/**
 * Reconcile safety (E2's finding: a fresh DDB paste removed Command): drop
 * the reconcileDiff proposals that would take back a game grant — a
 * removal of a spell / class feature / feat a level-up added (or one
 * tagged `source: 'game'` / `grantedBy: 'game'` on the run sheet), or an
 * ability score lowered below a game ASI. reconcileDiff never proposes
 * removing a level (only a brand-new class's levels).
 * @param {{proposals: object[]}} diff  reconcileDiff output (ok)
 * @param {object} runSheet
 * @param {object[]} levelUps  the seat's level_ups rows
 * @returns {{diff: object, dropped: object[]}}
 */
export function keepGameGrants(diff, runSheet, levelUps) {
  const g = gameGrants(levelUps);
  const tagged = (list, key, x) => (list || []).some(e => isGameTagged(e) && key(e) === key(x));
  const keeps = (d) => {
    switch (d.kind) {
      case 'spell-removed': return g.spells.has(spellKey(d)) || tagged(runSheet?.spells, spellKey, d);
      case 'feature-removed': return g.features.has(featureKey(d)) || tagged(runSheet?.classFeatures, featureKey, d);
      case 'feat-removed': return g.feats.has(d.name);
      case 'ability': return Number(d.to) < Number(d.from) && g.stats.has(d.stat);
      default: return false;
    }
  };
  const dropped = diff.proposals.filter(keeps);
  return { diff: { ...diff, proposals: diff.proposals.filter(d => !keeps(d)) }, dropped };
}
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
    /** seat.reclaim requests waiting for the DM: [{slotId, memberId}]. */
    this.reclaims = [];
    /** The run hashes as of a run seq: {runId, seq, runHash, wireHash} (computed once per seq). */
    this.hashCache = null;
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
    return this.active && this.row.status !== 'lobby' ? 'between' : 'lobby';
  }

  /** Does this controller handle intent `t`? */
  handles(t) {
    return RUN_INTENT_SET.has(t);
  }

  /** Hit dice declared for the next short rest: {slotId: {Class: n}} (runs.pending_json, 0007). */
  get pendingRest() {
    return this.row?.pending?.rest || {};
  }

  /** Replace one key of runs.pending_json (inside #tx; the row is re-read after the commit). */
  #setPending(key, value) {
    const pending = { ...(this.row.pending || {}) };
    if (value === undefined) delete pending[key];
    else pending[key] = clone(value);
    this.store.setPending(this.#runId(), pending);
    this.row = { ...this.row, pending };
  }

  /** An XP award held for the DM (xpAward 'confirm'): {total, perCharacter, nodeId, encounterIds}, or null. */
  #pendingXp() {
    return clone(this.row?.pending?.xp ?? null);
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
      completed: this.progress.completed, pendingRest: clone(this.pendingRest), pendingXp: this.#pendingXp(), ...this.hashes()
    });
  }

  /**
   * The run log's hashes at the current run seq (run-state.js runHash):
   * `runHash` over the stored log (run-driver's definition, the one the
   * smokes pin) and `wireHash` over the log as clients receive it
   * (stripProse) — what a client rebuilding its log from `run.event`s or
   * `GET /api/runs/:runId/events` can recompute. Cached per seq.
   * @returns {{runHash: string, wireHash: string}|{}}
   */
  hashes() {
    if (!this.row) return {};
    const c = this.hashCache;
    if (!c || c.runId !== this.row.id || c.seq !== this.row.seq) {
      const log = this.allEvents();
      this.hashCache = { runId: this.row.id, seq: this.row.seq, runHash: runHash(log), wireHash: runHash(log.map(stripProse)) };
    }
    return { runHash: this.hashCache.runHash, wireHash: this.hashCache.wireHash };
  }

  /**
   * The run log, oldest first (store rows: the envelope plus runId / ts).
   * @param {number} [afterSeq]
   * @returns {object[]}
   */
  allEvents(afterSeq = 0) {
    const out = [];
    let after = afterSeq;
    for (;;) {
      const page = this.store.listEvents(this.row.id, { afterSeq: after, limit: 1000 });
      out.push(...page);
      if (page.length < 1000) return out;
      after = page.at(-1).seq;
    }
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
    const seats = this.#unjoinedSeats();
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
        this.#emit('run.started', {
          campaignId: campaign.id, startNodeId: start,
          seats: seats.map(st => ({ slotId: st.id, seat: st.seat, characterId: String(st.seed.id) }))
        }, { nodeId: null });
        // With a seated party the run enters its start node now; an empty
        // room stays in the lobby until dm.node.begin (players seat first).
        if (seats.length) this.#enterNode(start, { override: false, join: { live, xp } });
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

  /** Seated characters not yet in the run (room store, fresh), by seat. */
  #unjoinedSeats() {
    return this.port.roomStore().listSeats(this.room.id).filter(s => s.seed && !s.runId).sort(bySeat);
  }

  /**
   * Bring every seated character not yet in the run into it (inside #tx):
   * sheet_json = its seed, state_json = initialRunState (rested unless
   * `live`), XP from D&D Beyond when it matches the level, else the
   * level's threshold; one character.joined each, items from the inventory.
   */
  #joinSeated({ live = this.room.settings?.importLiveState === true, xp = {} } = {}) {
    for (const s of this.#unjoinedSeats()) {
      const sheet = clone(s.seed);
      const level = sheetLevel(sheet);
      const state = initialRunState(sheet, { importDdbState: live });
      const sv = validateRunState(state, { sheet });
      if (!sv.ok) throw new RunIntentError('E_INVALID_INTENT', `seat ${s.seat}: ${sv.errors[0].path} ${sv.errors[0].message}`);
      const ddbXp = Number.isInteger(sheet.currentXp) && levelForXp(sheet.currentXp) === level ? sheet.currentXp : null;
      const startXp = Number.isInteger(xp[s.id]) ? xp[s.id] : (ddbXp ?? xpForLevel(level));
      this.store.attachSeat(this.#runId(), s.id, { sheet, state, level, xp: startXp, lifeStatus: 'active' });
      const ev = this.#emit('character.joined', {
        slotId: s.id, characterId: String(sheet.id), level, before: null,
        after: { state, xp: startXp, level, lifeStatus: 'active' }
      });
      this.#seedItems(s.id, sheet, ev.seq);
    }
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
  #enterNode(nodeId, { override, join } = {}) {
    const node = this.#node(nodeId);
    if (!node) throw new RunIntentError('E_INVALID_INTENT', `no node ${nodeId} in this campaign`);
    this.#joinSeated(join);
    if (!this.#characters().length) throw new RunIntentError('E_INVALID_INTENT', 'seat at least one character first');
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
    if (Object.keys(this.pendingRest).length) this.#setPending('rest', {});
    this.#emit('node.entered', { nodeId, kind: node.kind, fromNodeId: from, ...recovered },
      { nodeId, actorKind: 'dm', actorId: DM_ACTOR, override });
    this.store.setCurrentNode(this.#runId(), nodeId);
    this.store.setStatus(this.#runId(), node.kind === 'encounter' ? 'in-node' : 'between');
    this.#onEnter(node);
  }

  /** Per-kind effects of entering a node: a loot node fills the party stash. */
  #onEnter(node) {
    if (node.kind === 'loot') this.#grantLoot(node.payload, node.id);
  }

  /**
   * Loot into the party stash (items owner NULL; coins into
   * runs.stash_json) with one loot.granted. Open5e SRD items take their
   * data from the items cache (never fetched here).
   */
  #grantLoot(loot, nodeId) {
    const items = loot?.items || [];
    const coins = loot?.currency || null;
    if (!items.length && !coins) return;
    const seq = this.seq + 1;
    const stashBefore = clone(this.#stash());
    const granted = items.map((l, k) => {
      const id = `${this.#runId()}.${seq}.${k}`;
      const qty = l.qty ?? 1;
      const rec = l.origin === 'open5e' && l.ref ? this.store.srdRecord(l.ref) : null;
      const it = rec
        ? itemFromOpen5e(rec.payload, { id, ownerSlotId: null, qty })
        : makeItem({ id, origin: l.origin, refKey: l.ref ?? null, name: l.name || l.ref || 'Item', qty, data: l.data || {} });
      this.store.addItem(this.#runId(), { ...it, id, ownerSlotId: null });
      return { itemId: id, name: it.name, qty };
    });
    const stashAfter = coins ? { ...stashBefore, currency: addCurrency(stashBefore.currency, coins) } : stashBefore;
    if (coins) this.store.setStash(this.#runId(), stashAfter);
    this.#emit('loot.granted', { items: granted, ...(coins ? { currency: clone(coins) } : {}), before: { stash: stashBefore }, after: { stash: stashAfter } }, { nodeId });
  }

  #stash() {
    const st = this.store.getRun(this.#runId()).stash || {};
    return { ...st, currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0, ...(st.currency || {}) } };
  }

  // --------------------------------------------------------- encounters

  /**
   * dm.node.begin {nodeId?, setup?}: begin a node. From the lobby it
   * enters `nodeId` (default: the start node) with the seated party; with
   * a `nodeId` other than the current one it takes that offered edge. An
   * encounter node is then built in 'setup' from the run states (the DM's
   * `setup` tweak, else the node's setup or template); the DM may tweak it
   * again with dm.encounter.setup and starts it with dm.encounter.start.
   */
  async #beginNode(p) {
    const cur = this.#current();
    if (this.row.status === 'lobby' || !cur) {
      const to = p.nodeId ?? startNodeId(this.#campaign().nodes);
      this.#tx(() => this.#enterNode(to, { override: to !== startNodeId(this.#campaign().nodes) }));
    } else if (p.nodeId && p.nodeId !== cur.id) {
      this.#advance({ toNodeId: p.nodeId, override: false });
    }
    const node = this.#current();
    let encounterId = null;
    if (node.kind === 'encounter') {
      if (this.progress.completed || this.progress.result.outcome) throw new RunIntentError('E_INVALID_INTENT', 'this encounter has been fought; advance the run');
      encounterId = this.#buildEncounter(node, p.setup ?? null, null);
    }
    this.#afterChange();
    return { currentNodeId: node.id, kind: node.kind, ...(encounterId ? { encounterId } : {}) };
  }

  /**
   * dm.encounter.setup inside a run: rebuild the begun encounter node with
   * the DM's tweak (same seed, run states, linked to the node).
   * @param {object} setup  dm.encounter.setup payload
   * @returns {{encounterId: string}}
   */
  setupInRun(setup) {
    const enc = this.#begun();
    const node = this.#current();
    return { encounterId: this.#buildEncounter(node, setup, enc.state.rng?.s ?? null) };
  }

  /** dm.encounter.start inside a run: only a begun encounter node starts. */
  assertBegun() {
    this.#begun();
  }

  /** The room's setup-phase encounter for the current node, or E_NODE_NOT_BEGUN. */
  #begun() {
    const enc = this.port.encounter();
    const node = this.#current();
    if (!enc || enc.status !== 'setup' || enc.state.runId !== this.row?.id || !node || enc.state.nodeId !== node.id) {
      throw new RunIntentError('E_NODE_NOT_BEGUN', 'begin the encounter node first (dm.node.begin)');
    }
    return enc;
  }

  /** Build the encounter node in 'setup'; a fresh build draws its seed from the run RNG. */
  #buildEncounter(node, tweak, reuseSeed) {
    let setup = tweak ? clone(tweak) : clone(node.payload.setup ?? (this.#campaign().templates || []).find(t => t.id === node.payload.templateId)?.setup);
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
    const seed = Number.isInteger(reuseSeed) ? reuseSeed : Math.floor(rng() * 0x100000000) >>> 0;
    // The seed draw and the encounter row commit together.
    this.store.tx(() => {
      if (!Number.isInteger(reuseSeed)) this.store.setRng(this.#runId(), rng.state());
      this.port.setupEncounter({ encounterId, seed, setup, party, runId: this.#runId(), nodeId: node.id });
    })();
    this.row = this.store.getRun(this.row.id);
    return encounterId;
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
      const settled = settleAfterEncounter(written, { outcome: settleOutcomeOf(outcome), deathMode: settings.deathMode });
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
        this.#setQty(it, qty);
        this.#emit('item.used', { itemId, slotId: e.controller.seatId, targetSlotId: null, spent, before: { qty: it.qty }, after: { qty } }, { nodeId: node.id });
      }
    }
    // 3. XP (milestone mode awards nothing).
    if (settings.xpMode === 'xp') {
      const defeated = Object.values(final.entities).filter(e => e.side === 'hostile' && (e.hp === 0 || e.status === 'dead'));
      const participants = [...next.keys()].filter(s => next.get(s).lifeStatus !== 'dead').map(id => ({ id }));
      const override = node.kind === 'encounter' && Number.isInteger(node.payload?.xpOverride);
      const award = encounterXp(override ? [{ xp: node.payload.xpOverride }] : defeated, participants, { mode: 'xp' });
      if (settings.xpAward === 'confirm') {
        // Held for the DM (runs.pending_json.xp): dm.xp.adjust or dm.run.advance confirms it.
        this.#holdXp({ encounterId: enc.id, nodeId: node.id, total: award.total, perCharacter: award.awards });
        award.awards = {};
      }
      const xb = {};
      const xa = {};
      for (const [slotId, n] of Object.entries(award.awards)) {
        xb[slotId] = next.get(slotId).xp;
        next.get(slotId).xp += n;
        xa[slotId] = next.get(slotId).xp;
      }
      if (settings.xpAward !== 'confirm') {
        this.#emit('xp.awarded', { total: award.total, perCharacter: award.awards, before: xb, after: xa }, { nodeId: node.id });
        // 6. One level_ups row per crossed threshold.
        for (const slotId of Object.keys(award.awards)) this.#queueLevels(chars.get(slotId), xb[slotId], xa[slotId], node.id);
      }
    }
    // 1. Write back (version + 1 each).
    for (const [slotId, n] of next) this.#write(chars.get(slotId), { state: n.state, lifeStatus: n.lifeStatus, xp: n.xp });
    this.#autoLevels();
    this.#onEncounterResult(node, outcome);
    // 7. Close the node; the run is between nodes.
    this.#emit('node.completed', { nodeId: node.id, kind: node.kind }, { nodeId: node.id });
    this.store.setStatus(this.#runId(), 'between');
    return true;
  }

  /** An encounter node's victory loot goes to the party stash. */
  #onEncounterResult(node, outcome) {
    if (outcome === 'party-victory' && node.kind === 'encounter' && node.payload?.loot) this.#grantLoot(node.payload.loot, node.id);
  }

  /** level_ups rows (and level.queued) for the thresholds between two XP totals. */
  #queueLevels(c, fromXp, toXp, nodeId, opts = {}) {
    const settings = this.#settings();
    const pending = this.store.pendingLevelUps(c.slotId).filter(l => l.mode !== 'reconcile');
    const top = pending.length ? pending[pending.length - 1].toLevel : (c.level ?? sheetLevel(c.sheet));
    for (const to of levelsCrossed(fromXp, toXp, { mode: opts.mode ?? settings.xpMode, currentLevel: top })) {
      const local = this.#nextLevelUpId();
      this.store.addLevelUp(this.#runId(), {
        id: this.#luDb(local), slotId: c.slotId, fromLevel: to - 1, mode: settings.levelUpMode,
        status: settings.levelUpMode === 'choose' ? 'pending_player' : 'pending_dm'
      });
      this.#emit('level.queued', { levelUpId: local, slotId: c.slotId, fromLevel: to - 1, toLevel: to }, { nodeId });
    }
  }

  /**
   * The level-ups a seat can act on now: its lowest pending level row
   * (levels apply one at a time) and any pending reconcile rows.
   */
  #actionableLevelUps() {
    const out = [];
    const seen = new Set();
    for (const l of this.store.listLevelUps(this.#runId()).sort((a, b) => a.fromLevel - b.fromLevel)) {
      if (l.status !== 'pending_player' && l.status !== 'pending_dm') continue;
      if (l.mode === 'reconcile') { out.push(l); continue; }
      if (seen.has(l.slotId)) continue;
      seen.add(l.slotId);
      out.push(l);
    }
    return out;
  }

  /** The levelup.offer payload for a level-up row (plan computed by level-up.js). */
  #offerOf(l) {
    const local = this.#luLocal(l.id);
    const base = { levelUpId: local, slotId: l.slotId, fromLevel: l.fromLevel, toLevel: l.toLevel, mode: l.mode, status: l.status, ...(l.choices ? { picked: clone(l.choices) } : {}) };
    if (l.mode === 'reconcile') return { ...base, fromLevel: l.fromLevel, auto: { proposals: clone(l.auto?.diff?.proposals || []) } };
    const c = this.store.getCharacter(l.slotId);
    try {
      const plan = planLevelUp(c.sheet, c.state, { toLevel: l.toLevel, settings: { hpOnLevel: this.#settings().hpOnLevel } });
      return { ...base, auto: clone(plan.auto || {}), choices: clone(plan.choices), reconcile: clone(plan.reconcile), missing: clone(plan.missing), requiresDm: plan.requiresDm };
    } catch (err) {
      if (!(err instanceof CampaignRuleError)) throw err;
      return { ...base, auto: {}, blocked: err.code };
    }
  }

  /**
   * levelup.offer to each actionable level-up's seat controller (the DM
   * for AI seats) and the DM. Called only from sendSnapshot, so a change
   * (#afterChange → one snapshot per member) offers each level-up once.
   */
  #offerLevelUps(only = null) {
    const members = [...this.port.members().values()].filter(m => m.conn);
    if (!members.length) return;
    const seats = new Map(this.port.seats().map(s => [s.id, s]));
    for (const l of this.#actionableLevelUps()) {
      const owner = seats.get(l.slotId)?.controllerParticipantId ?? null;
      const to = members.filter(m => (m.role === 'dm' || m.id === owner) && (!only || only.id === m.id));
      if (!to.length) continue;
      const offer = this.#offerOf(l);
      for (const m of to) this.port.sendPrivate(m, 'levelup.offer', offer);
    }
  }

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
    return {
      ...viewForRun({
        run: this.row, progress: this.progress, characters: this.#characters(), items: this.store.listItems(this.#runId()),
        levelUps: this.#levelUps(), seats: this.port.seats(), pendingRest: this.pendingRest, reclaims: this.reclaims
      }, member),
      pendingXp: this.#pendingXp(),
      ...this.hashes()
    };
  }

  /** Send a member its run.snapshot (no-op without a run). */
  sendSnapshot(member) {
    const p = this.snapshotFor(member);
    if (!p) return;
    this.port.sendPrivate(member, 'run.snapshot', p);
    if (this.active) this.#offerLevelUps(member);
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
      case 'rest.spend': return this.#restSpend(member, p, actor);
      case 'dm.rest.grant': return this.#restGrant(p);
      default: return this.#more(member, t, p, actor);
    }
  }

  /** The between-node intents (M65 B25). */
  #more(member, t, p, actor) {
    switch (t) {
      case 'loot.claim': return this.#lootClaim(member, p, actor);
      case 'dm.loot.assign': return this.#lootAssign(p, actor);
      case 'item.equip': return this.#itemEquip(member, p, actor);
      case 'item.give': return this.#itemGive(member, p, actor);
      case 'item.use': return this.#itemUse(member, p, actor);
      case 'shop.buy': return this.#shopBuy(member, p, actor);
      case 'shop.sell': return this.#shopSell(member, p, actor);
      case 'story.choose':
      case 'dm.story.resolve': return this.#storyChoose(p, actor);
      case 'dm.xp.adjust': return this.#xpAdjust(p, actor);
      case 'levelup.choose': return this.#levelChoose(member, p, actor);
      case 'levelup.reconcile': return this.#levelReconcile(member, p, actor);
      case 'dm.levelup.confirm': return this.#levelConfirm(p, actor);
      case 'dm.levelup.revert': return this.#levelRevert(p, actor);
      case 'dm.character.revive': return this.#revive(p, actor);
      case 'dm.character.retire': return this.#retire(p, actor);
      case 'dm.seat.fill': return this.#seatFill(p, actor);
      default: return this.#later(member, t, p, actor);
    }
  }

  /** Save / load and rejoin (M65 B26). */
  #later(member, t, p, actor) {
    switch (t) {
      case 'dm.snapshot.save': return this.#snapshotSave(p, actor);
      case 'dm.snapshot.load': return this.#snapshotLoad(p, actor);
      case 'seat.reclaim': return this.#reclaim(member, p);
      case 'dm.stash.split': return this.#stashSplit(p, actor);
      case 'stash.take': return this.#stashTake(member, p, actor);
      case 'cast.downtime': return this.#castDowntime(member, p, actor);
      case 'dm.seat.reclaim.approve': return this.#reclaimApprove(p, actor);
      default: throw new RunIntentError('E_UNKNOWN_TYPE', `unhandled ${t}`);
    }
  }

  // ---------------------------------------------------------- snapshots

  /** The run snapshot blob v1 (run-state.js validateRunSnapshot) as of now. */
  #blob() {
    const chars = this.#characters();
    const seats = new Map(this.port.seats().map(x => [x.id, x]));
    const slots = new Set(chars.map(c => c.slotId));
    return {
      v: RUN_SNAPSHOT_VERSION, runId: this.#runId(), atSeq: this.seq,
      run: {
        status: this.row.status, currentNodeId: this.progress.currentNodeId, visitedNodeIds: [...this.progress.visited],
        settings: clone(this.row.settings), stash: { currency: clone(this.#stash().currency) }, rng: clone(this.row.rng)
      },
      characters: chars.map(c => ({
        slotId: c.slotId, seat: c.seat, characterId: c.sheet?.id !== undefined ? String(c.sheet.id) : null, name: String(c.sheet?.name || 'PC').slice(0, 128),
        level: c.level ?? 1, xp: c.xp, lifeStatus: c.lifeStatus, version: c.version,
        controllerParticipantId: seats.get(c.slotId)?.controllerParticipantId ?? null, sheet: clone(c.sheet), state: clone(c.state)
      })),
      items: this.store.listItems(this.#runId()).filter(i => i.ownerSlotId === null || slots.has(i.ownerSlotId)).map(i => ({
        id: i.id, ownerSlotId: i.ownerSlotId, origin: i.origin, refKey: i.refKey, name: i.name, qty: i.qty,
        equipped: i.equipped, attuned: i.attuned, chargesSpent: i.chargesSpent, data: clone(i.data)
      })),
      levelUps: this.store.listLevelUps(this.#runId()).filter(l => slots.has(l.slotId)).map(l => ({
        id: l.id, slotId: l.slotId, fromLevel: l.fromLevel, toLevel: l.toLevel, className: l.className, mode: l.mode, status: l.status,
        ...(l.auto != null ? { auto: clone(l.auto) } : {}), ...(l.choices != null ? { choices: clone(l.choices) } : {}),
        ...(l.granted != null ? { granted: clone(l.granted) } : {})
      })),
      campaign: clone(this.#campaign())
    };
  }

  /** dm.snapshot.save: between nodes only (decision: no turn-level rewind). */
  #snapshotSave({ label = null }, actor) {
    if (!SNAPSHOT_RUN_STATUSES.includes(this.row.status)) throw new RunIntentError('E_INVALID_INTENT', `save between nodes (the run is ${this.row.status})`);
    const blob = this.#blob();
    const v = validateRunSnapshot(blob);
    if (!v.ok) throw new Error(`run snapshot invalid: ${v.errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('; ')}`);
    let snapshotId;
    this.#tx(() => {
      snapshotId = this.store.saveSnapshot(this.#runId(), { label, atSeq: blob.atSeq, blob, createdBy: actor.actorId });
      this.#emit('snapshot.saved', { snapshotId, label, atSeq: blob.atSeq }, actor);
    });
    this.#afterChange();
    return { snapshotId, atSeq: blob.atSeq };
  }

  /**
   * dm.snapshot.load: characters, items, level-ups, stash, RNG and the node
   * walk go back to the save point; the log only grows (snapshot.restored
   * carries the walk as of the save, rebuilt from the events up to it).
   */
  #snapshotLoad({ snapshotId }, actor) {
    const snap = this.store.getSnapshot(this.#runId(), snapshotId);
    if (!snap) throw new RunIntentError('E_INVALID_INTENT', `no snapshot ${snapshotId}`);
    const blob = snap.blob;
    const v = validateRunSnapshot(blob);
    if (!v.ok) throw new RunIntentError('E_INVALID_INTENT', `snapshot ${snapshotId} is not loadable: ${v.errors[0].path} ${v.errors[0].message}`);
    let progress = emptyProgress();
    for (const ev of this.store.listEvents(this.#runId(), { afterSeq: 0, limit: blob.atSeq })) progress = reduceProgress(progress, ev);
    const live = new Map(this.#characters().map(c => [c.slotId, c]));
    const missing = blob.characters.filter(c => !live.has(c.slotId)).map(c => c.slotId);
    const kept = new Set(blob.characters.map(c => c.slotId).filter(id => live.has(id)));
    const before = { currentNodeId: this.progress.currentNodeId, seq: this.seq, status: this.row.status };
    this.#tx(() => {
      for (const c of blob.characters) {
        if (!kept.has(c.slotId)) continue;
        this.#write(live.get(c.slotId), { sheet: c.sheet, state: c.state, level: c.level, xp: c.xp, lifeStatus: c.lifeStatus });
      }
      this.store.replaceItems(this.#runId(), blob.items.filter(i => i.ownerSlotId === null || kept.has(i.ownerSlotId)));
      this.store.replaceLevelUps(this.#runId(), blob.levelUps.filter(l => kept.has(l.slotId)));
      this.store.setStash(this.#runId(), blob.run.stash);
      this.store.setRng(this.#runId(), blob.run.rng);
      this.store.setCurrentNode(this.#runId(), blob.run.currentNodeId);
      this.store.setStatus(this.#runId(), blob.run.status);
      this.#emit('snapshot.restored', {
        snapshotId, atSeq: blob.atSeq, ...(missing.length ? { missing } : {}),
        before, after: { currentNodeId: blob.run.currentNodeId, status: blob.run.status, progress }
      }, { ...actor, override: true });
      this.#setPending('rest', {});
      this.#setPending('xp', undefined);
    });
    this.#afterChange();
    return { currentNodeId: this.progress.currentNodeId, ...(missing.length ? { missing } : {}) };
  }

  // --------------------------------------------------------------- seats

  /**
   * seat.reclaim: a player (a new browser joined by code) takes back a run
   * seat. Automatic when the seat's old controller left or was kicked (or
   * there is none); otherwise the DM approves.
   */
  #reclaim(member, { slotId }) {
    const c = this.#character(slotId);
    const rs = this.port.roomStore();
    const seat = rs.getSeatById(this.room.id, slotId);
    if (seat.controllerParticipantId === member.id) return { reclaimed: true };
    if (rs.listSeats(this.room.id).some(x => x.controllerParticipantId === member.id)) throw new RunIntentError('E_SEAT_TAKEN', 'you already hold a seat');
    const old = seat.controllerParticipantId ? rs.getParticipant(this.room.id, seat.controllerParticipantId) : null;
    if (!old || old.status !== 'active') {
      this.#handSeat(c, seat, member.id, { actorKind: 'player', actorId: member.id }, 'reclaimed');
      return { reclaimed: true };
    }
    this.reclaims = this.reclaims.filter(x => !(x.slotId === slotId && x.memberId === member.id));
    this.reclaims.push({ slotId, memberId: member.id, displayName: member.displayName ?? null, from: old.id });
    const dm = [...this.port.members().values()].find(m => m.role === 'dm');
    if (dm?.conn) this.sendSnapshot(dm);
    return { reclaimed: false, pending: true };
  }

  #reclaimApprove({ slotId, memberId, approve }, actor) {
    const i = this.reclaims.findIndex(x => x.slotId === slotId && x.memberId === memberId);
    if (i < 0) throw new RunIntentError('E_STALE', 'no such reclaim request');
    this.reclaims.splice(i, 1);
    if (approve) {
      const rs = this.port.roomStore();
      const p = rs.getParticipant(this.room.id, memberId);
      if (!p || p.status !== 'active') throw new RunIntentError('E_STALE', 'that player has left');
      if (rs.listSeats(this.room.id).some(x => x.controllerParticipantId === memberId)) throw new RunIntentError('E_SEAT_TAKEN', 'that player already holds a seat');
      this.#handSeat(this.#character(slotId), rs.getSeatById(this.room.id, slotId), memberId, actor, 'reclaim-approved');
    } else {
      this.#afterChange();
    }
    return { approved: !!approve };
  }

  /** Give a run seat to `memberId` (seat.filled with the controller change). */
  #handSeat(c, seat, memberId, actor, reason) {
    this.#tx(() => {
      this.port.roomStore().setSeatController(this.room.id, c.slotId, memberId);
      this.#emit('seat.filled', {
        slotId: c.slotId, seat: c.seat, controller: 'player', reason,
        before: { memberId: seat.controllerParticipantId ?? null }, after: { memberId }
      }, actor);
    });
    this.port.seatsChanged();
    this.#afterChange();
  }

  // -------------------------------------------------------------- items

  /** A run item, or E_INVALID_INTENT. */
  #item(itemId) {
    const it = this.store.getItem(this.#runId(), itemId);
    if (!it) throw new RunIntentError('E_INVALID_INTENT', `no item ${itemId} in this run`);
    return it;
  }

  /** Set an item's quantity; an item that runs out is removed (ids are never reused). */
  #setQty(it, qty) {
    if (qty <= 0) this.store.deleteItem(this.#runId(), it.id);
    else this.store.updateItem(this.#runId(), it.id, { qty });
  }

  /**
   * Move `qty` of an unequipped item to a seat or the stash (null), with
   * one item.moved. A partial move splits the row (new id from the event seq).
   */
  #moveItem(it, toSlotId, qty, actor) {
    if (it.equipped || it.attuned) throw new RunIntentError('E_INVALID_INTENT', `unequip ${it.name} first`);
    const n = qty ?? it.qty;
    if (!(n >= 1 && n <= it.qty)) throw new RunIntentError('E_INVALID_INTENT', `only ${it.qty} ${it.name} to move`);
    if (toSlotId) this.#character(toSlotId);
    if ((it.ownerSlotId ?? null) === (toSlotId ?? null)) throw new RunIntentError('E_INVALID_INTENT', `${it.name} is already there`);
    let movedId = it.id;
    this.#tx(() => {
      if (n === it.qty) {
        this.store.updateItem(this.#runId(), it.id, { ownerSlotId: toSlotId ?? null });
      } else {
        movedId = `${this.#runId()}.${this.seq + 1}.0`;
        this.store.updateItem(this.#runId(), it.id, { qty: it.qty - n });
        this.store.addItem(this.#runId(), { ...it, id: movedId, ownerSlotId: toSlotId ?? null, qty: n });
      }
      this.#emit('item.moved', {
        itemId: it.id, ...(movedId !== it.id ? { newItemId: movedId } : {}), name: it.name,
        fromSlotId: it.ownerSlotId ?? null, toSlotId: toSlotId ?? null, qty: n,
        before: { ownerSlotId: it.ownerSlotId ?? null, qty: it.qty },
        after: { ownerSlotId: toSlotId ?? null, qty: n, remaining: it.qty - n }
      }, actor);
    });
    this.#afterChange();
    return { itemId: movedId };
  }

  #lootClaim(member, { slotId, itemId, qty }, actor) {
    this.#ownSeat(member, slotId);
    const it = this.#item(itemId);
    if (it.ownerSlotId !== null) throw new RunIntentError('E_INVALID_INTENT', `${it.name} is not in the party stash`);
    const node = this.#current();
    if (node?.kind === 'loot' && node.payload.assign === 'dm') throw new RunIntentError('E_FORBIDDEN', 'the DM hands out this loot');
    return this.#moveItem(it, slotId, qty, actor);
  }

  #lootAssign({ itemId, toSlotId, qty }, actor) {
    return this.#moveItem(this.#item(itemId), toSlotId, qty, actor);
  }

  #itemGive(member, { slotId, itemId, toSlotId, qty }, actor) {
    this.#ownSeat(member, slotId);
    const it = this.#item(itemId);
    if (it.ownerSlotId !== slotId) throw new RunIntentError('E_FORBIDDEN', `${it.name} is not yours`);
    return this.#moveItem(it, toSlotId, qty, actor);
  }

  /** item.equip: equip / unequip / attune through items.js; the sheet's equipment is rewritten. */
  #itemEquip(member, { slotId, itemId, equipped, attuned }, actor) {
    const c = this.#ownSeat(member, slotId);
    const it = this.#item(itemId);
    if (it.ownerSlotId !== slotId) throw new RunIntentError('E_FORBIDDEN', `${it.name} is not yours`);
    const mine = this.store.listItems(this.#runId(), { ownerSlotId: slotId });
    let sheet = c.sheet;
    let list = mine;
    if (equipped) {
      if (!it.equipped) ({ sheet, items: list } = equipItem(sheet, list, itemId));
      if (attuned !== undefined && attuned !== it.attuned) ({ sheet, items: list } = attuneItem(sheet, list, itemId, attuned));
    } else {
      if (it.attuned) ({ sheet, items: list } = attuneItem(sheet, list, itemId, false));
      ({ sheet, items: list } = unequipItem(sheet, list, itemId));
    }
    const was = new Map(mine.map(i => [i.id, i]));
    const changed = list.filter(i => was.get(i.id) && (was.get(i.id).equipped !== i.equipped || was.get(i.id).attuned !== i.attuned));
    this.#tx(() => {
      for (const i of changed) this.store.updateItem(this.#runId(), i.id, { equipped: i.equipped, attuned: i.attuned });
      this.#write(c, { sheet });
      const flags = (arr) => arr.map(i => ({ id: i.id, equipped: !!i.equipped, attuned: !!i.attuned }));
      this.#emit('item.moved', {
        itemId, name: it.name, fromSlotId: slotId, toSlotId: slotId, qty: Math.max(1, it.qty), equip: true,
        before: { equipment: clone(c.sheet.equipment ?? null), items: flags(changed.map(i => was.get(i.id))) },
        after: { equipment: clone(sheet.equipment ?? null), items: flags(changed) }
      }, actor);
    });
    this.#afterChange();
    return { equipped: !!list.find(i => i.id === itemId)?.equipped, attuned: !!list.find(i => i.id === itemId)?.attuned };
  }

  /** item.use between nodes: a potion through consumables.js (run RNG), on the user or a target seat. */
  #itemUse(member, { slotId, itemId, targetSlotId }, actor) {
    this.#ownSeat(member, slotId);
    const it = this.#item(itemId);
    if (it.ownerSlotId !== slotId) throw new RunIntentError('E_FORBIDDEN', `${it.name} is not yours`);
    const target = this.#character(targetSlotId ?? slotId);
    let out;
    this.#tx(() => {
      const rng = this.#rng();
      const r = drinkPotion(target.sheet, target.state, it, rng, { lifeStatus: target.lifeStatus });
      const life = target.lifeStatus === 'dead' ? 'dead' : lifeStatusOf(r.state);
      this.#write(target, life !== target.lifeStatus ? { state: r.state, lifeStatus: life } : { state: r.state });
      this.#setQty(it, it.qty - 1);
      this.store.setRng(this.#runId(), rng.state());
      this.#emit('item.used', {
        itemId, slotId, targetSlotId: target.slotId, healed: r.healed, rolls: r.rolls,
        before: { qty: it.qty, state: target.state, lifeStatus: target.lifeStatus },
        after: { qty: it.qty - 1, state: r.state, lifeStatus: life }
      }, actor);
      out = { healed: r.healed };
    });
    this.#afterChange();
    return out;
  }

  // ---------------------------------------------------------- stash coin

  /**
   * Move coins (exact denominations) from the party stash to a seat's
   * purse inside #tx: one `currency.changed` with before / after
   * {currency, stash}. items.js addCurrency refuses a coin the stash
   * lacks (insufficient-funds).
   */
  #coinsToSeat(c, coins, reason, actor) {
    const stashBefore = this.#stash();
    const stashAfter = { ...stashBefore, currency: addCurrency(stashBefore.currency, RunController.#negate(coins)) };
    const fresh = this.store.getCharacter(c.slotId);
    const before = clone(fresh.state.currency || {});
    const after = addCurrency(before, coins);
    this.store.setStash(this.#runId(), stashAfter);
    this.#write(fresh, { state: { ...fresh.state, currency: after } });
    this.#emit('currency.changed', {
      slotId: c.slotId, delta: RunController.#delta(before, after), reason,
      before: { currency: before, stash: clone(stashBefore.currency) }, after: { currency: after, stash: clone(stashAfter.currency) }
    }, actor);
  }

  static #negate(coins) {
    const out = {};
    for (const k of ['cp', 'sp', 'ep', 'gp', 'pp']) if (coins[k]) out[k] = -coins[k];
    return out;
  }

  static #coinsOnly(o) {
    const out = {};
    for (const k of ['cp', 'sp', 'ep', 'gp', 'pp']) if (Number.isInteger(o?.[k]) && o[k] > 0) out[k] = o[k];
    if (!Object.keys(out).length) throw new RunIntentError('E_INVALID_INTENT', 'name some coin to move');
    return out;
  }

  /** dm.stash.split: hand the stash's coin out to seats (one currency.changed per seat). */
  #stashSplit({ allocations }, actor) {
    const seen = new Set();
    const plan = allocations.map(a => {
      if (seen.has(a.slotId)) throw new RunIntentError('E_INVALID_INTENT', `seat ${a.slotId} is listed twice`);
      seen.add(a.slotId);
      return { c: this.#character(a.slotId), coins: RunController.#coinsOnly(a) };
    });
    this.#tx(() => { for (const { c, coins } of plan) this.#coinsToSeat(c, coins, 'stash.split', actor); });
    this.#afterChange();
    return { stash: clone(this.#stash().currency) };
  }

  /** stash.take: a seat takes coin from the stash — only on a loot node the party shares freely. */
  #stashTake(member, { slotId, amount }, actor) {
    const c = this.#ownSeat(member, slotId);
    const node = this.#current();
    if (node?.kind !== 'loot' || node.payload?.assign !== 'free') throw new RunIntentError('E_FORBIDDEN', 'the DM splits the stash here (dm.stash.split)');
    const coins = RunController.#coinsOnly(amount);
    this.#tx(() => this.#coinsToSeat(c, coins, 'stash.take', actor));
    this.#afterChange();
    return { currency: clone(this.store.getCharacter(slotId).state.currency) };
  }

  // ------------------------------------------------- downtime healing

  /**
   * cast.downtime: a healing spell between nodes (downtime-spells.js
   * castDowntimeHeal: Cure Wounds / Healing Word / Prayer of Healing, a
   * real slot, the run RNG). The caster seat's controller casts; the DM
   * may cast for any seat (an override for a player's seat). One
   * heal.cast with before / after {[slotId]: {state, lifeStatus}}.
   */
  #castDowntime(member, { casterSlotId, spellId, targetSlotId, targetSlotIds, slotLevel, slotKind = 'spell' }, actor) {
    if (this.row.status !== 'between') throw new RunIntentError('E_INVALID_INTENT', `downtime spells are cast between nodes (the run is ${this.row.status})`);
    const seat = this.port.seats().find(s => s.id === casterSlotId);
    const playerSeat = !!seat?.controllerParticipantId;
    if (member.role !== 'dm') this.#ownSeat(member, casterSlotId);
    const caster = this.#character(casterSlotId);
    const ids = targetSlotIds ?? (targetSlotId ? [targetSlotId] : []);
    if (!ids.length) throw new RunIntentError('E_INVALID_INTENT', 'name the target seat (targetSlotId or targetSlotIds)');
    const targets = [...new Set(ids)].map(id => this.#character(id));
    const who = (c) => ({ id: c.slotId, sheet: c.sheet, state: c.state, lifeStatus: c.lifeStatus });
    let out;
    this.#tx(() => {
      const rng = this.#rng();
      const r = castDowntimeHeal({ caster: who(caster), spell: spellId, slotLevel, slotKind, targets: targets.map(who), rng });
      this.#saveRng(rng);
      const next = new Map([[caster.slotId, r.casterState]]);
      for (const t of r.targets) if (t.id !== caster.slotId) next.set(t.id, t.state);
      const rows = new Map([caster, ...targets].map(c => [c.slotId, c]));
      const before = {};
      const after = {};
      for (const [slotId, state] of next) {
        const c = rows.get(slotId);
        const life = c.lifeStatus === 'dead' ? 'dead' : lifeStatusOf(state);
        before[slotId] = { state: c.state, lifeStatus: c.lifeStatus };
        after[slotId] = { state, lifeStatus: life };
        this.#write(this.store.getCharacter(slotId), life !== c.lifeStatus ? { state, lifeStatus: life } : { state });
      }
      const healed = Object.fromEntries(r.targets.map(t => [t.id, t.healed]));
      this.#emit('heal.cast', {
        casterSlotId, spellId, slotLevel: r.slot.level, slotKind: r.slot.kind, targetSlotIds: r.targets.map(t => t.id),
        roll: r.roll, healed, before, after
      }, { ...actor, override: member.role === 'dm' && playerSeat });
      out = { healed, slot: r.slot };
    });
    this.#afterChange();
    return out;
  }

  // --------------------------------------------------------------- shop

  #shopNode() {
    const node = this.#current();
    if (node?.kind !== 'shop') throw new RunIntentError('E_INVALID_INTENT', 'there is no shop here');
    return node;
  }

  /** Coins for a copper amount (gp / sp / cp). */
  static coinsOf(cp) {
    return { gp: Math.floor(cp / 100), sp: Math.floor((cp % 100) / 10), cp: cp % 10 };
  }

  static #delta(before, after) {
    const d = {};
    for (const k of ['cp', 'sp', 'ep', 'gp', 'pp']) if ((after[k] ?? 0) !== (before[k] ?? 0)) d[k] = (after[k] ?? 0) - (before[k] ?? 0);
    return d;
  }

  /** shop.buy: priced from the stock entry or the Open5e SRD cost (items.js priceOf); the seat pays, else the stash. */
  #shopBuy(member, { slotId, refKey, qty }, actor) {
    const c = this.#ownSeat(member, slotId);
    const node = this.#shopNode();
    const entry = (node.payload.stock || []).find(s => s.ref === refKey);
    if (!entry) throw new RunIntentError('E_INVALID_INTENT', `${refKey} is not for sale here`);
    const left = entry.qty - (this.progress.bought[refKey] || 0);
    if (qty > left) throw new RunIntentError('E_INVALID_INTENT', `only ${Math.max(0, left)} ${refKey} left`);
    const rec = this.store.srdRecord(refKey);
    const unit = entry.price ? purseToCp(entry.price) : (rec ? priceOf(rec.payload).buyCp : null);
    if (!(unit > 0)) throw new RunIntentError('E_INVALID_INTENT', `${refKey} has no price; the DM sets one in the shop's stock`);
    const total = unit * qty;
    const purse = c.state.currency || {};
    let paidFrom = 'seat';
    let after;
    try {
      after = payFromPurse(purse, total);
    } catch (err) {
      if (!(err instanceof CampaignRuleError)) throw err;
      try { after = payFromPurse(this.#stash().currency, total); paidFrom = 'stash'; } catch { throw err; }
    }
    let itemId;
    this.#tx(() => {
      itemId = `${this.#runId()}.${this.seq + 1}.0`;
      const it = rec ? itemFromOpen5e(rec.payload, { id: itemId, ownerSlotId: slotId, qty }) : makeItem({ id: itemId, origin: 'dm', refKey, name: refKey, qty });
      this.store.addItem(this.#runId(), { ...it, id: itemId, ownerSlotId: slotId });
      const before = paidFrom === 'seat' ? clone(purse) : clone(this.#stash().currency);
      if (paidFrom === 'seat') this.#write(c, { state: { ...c.state, currency: after } });
      else this.store.setStash(this.#runId(), { ...this.#stash(), currency: after });
      this.#emit('shop.bought', {
        slotId, refKey, qty, itemId, name: it.name, paidFrom, price: RunController.#delta(before, after),
        before: { [paidFrom === 'seat' ? 'currency' : 'stash']: before }, after: { [paidFrom === 'seat' ? 'currency' : 'stash']: after }
      }, actor);
    });
    this.#afterChange();
    return { itemId, paidFrom, costCp: total };
  }

  /** shop.sell: at the shop's buyback (default half the cost); unpriced items are refused. */
  #shopSell(member, { slotId, itemId, qty }, actor) {
    const c = this.#ownSeat(member, slotId);
    const node = this.#shopNode();
    const it = this.#item(itemId);
    if (it.ownerSlotId !== slotId) throw new RunIntentError('E_FORBIDDEN', `${it.name} is not yours`);
    if (it.equipped || it.attuned) throw new RunIntentError('E_INVALID_INTENT', `unequip ${it.name} first`);
    if (qty > it.qty) throw new RunIntentError('E_INVALID_INTENT', `only ${it.qty} ${it.name}`);
    const price = priceOf(it);
    if (!price.priced) throw new RunIntentError('E_INVALID_INTENT', `${it.name} has no price; the DM buys it back by hand`);
    const buyback = node.payload.buyback ?? 0.5;
    const total = Math.floor(price.buyCp * buyback) * qty;
    const before = clone(c.state.currency || {});
    const after = addCurrency(before, RunController.coinsOf(total));
    this.#tx(() => {
      this.#write(c, { state: { ...c.state, currency: after } });
      this.#setQty(it, it.qty - qty);
      this.#emit('shop.sold', {
        slotId, itemId, qty, name: it.name, price: RunController.#delta(before, after),
        before: { currency: before, qty: it.qty }, after: { currency: after, qty: it.qty - qty }
      }, actor);
    });
    this.#afterChange();
    return { gainedCp: total };
  }

  // -------------------------------------------------------------- story

  #storyChoose({ nodeId, choiceId }, actor) {
    const node = this.#current();
    if (node?.kind !== 'story' || node.id !== nodeId) throw new RunIntentError('E_STALE', 'that story is not the current node');
    if (!(node.payload.choices || []).some(ch => ch.id === choiceId)) throw new RunIntentError('E_INVALID_INTENT', `no choice ${choiceId}`);
    this.#tx(() => this.#emit('story.chosen', { nodeId, choiceId }, actor));
    this.#afterChange();
    return { choiceId };
  }

  // ----------------------------------------------------------------- XP

  /** dm.xp.adjust: a logged override; crossing a threshold queues level-ups (also the milestone-mode grant). */
  #xpAdjust({ slotId, delta, reason = null }, actor) {
    this.#character(slotId);
    let xp;
    this.#tx(() => {
      // A held award (xpAward 'confirm') is confirmed first; a delta of 0 only confirms.
      const confirmed = this.#confirmXp(actor);
      if (delta === 0 && confirmed) { xp = this.store.getCharacter(slotId).xp; return; }
      const c = this.store.getCharacter(slotId);
      xp = Math.max(0, c.xp + delta);
      this.#emit('dm.override', { kind: 'xp', slotId, reason, before: { xp: c.xp }, after: { xp } }, { ...actor, override: true });
      this.#write(c, { xp });
      if (xp > c.xp) this.#queueLevels(c, c.xp, xp, undefined, { mode: 'xp' });
      this.#autoLevels();
    });
    this.#afterChange();
    return { xp };
  }

  /**
   * xpAward 'confirm': hold an encounter's award in runs.pending_json.xp
   * (inside #tx). A second award before the DM confirms adds to it.
   */
  #holdXp({ encounterId, nodeId, total, perCharacter }) {
    const held = this.row.pending?.xp;
    const per = { ...(held?.perCharacter || {}) };
    for (const [slotId, n] of Object.entries(perCharacter)) per[slotId] = (per[slotId] || 0) + n;
    this.#setPending('xp', {
      total: (held?.total || 0) + total, perCharacter: per, nodeId, encounterIds: [...(held?.encounterIds || []), encounterId]
    });
  }

  /**
   * Confirm a held XP award (inside #tx): xp.awarded by the DM (with
   * `confirmed: true`), the level_ups it crosses, then auto level-ups.
   * @returns {boolean} whether an award was held
   */
  #confirmXp(actor) {
    const held = this.row.pending?.xp;
    if (!held) return false;
    const before = {};
    const after = {};
    const awarded = {};
    const rows = [];
    for (const [slotId, n] of Object.entries(held.perCharacter)) {
      const c = this.store.getCharacter(slotId);
      if (!c || c.runId !== this.#runId()) continue;   // retired since
      before[slotId] = c.xp;
      after[slotId] = c.xp + n;
      awarded[slotId] = n;
      rows.push(this.#write(c, { xp: after[slotId] }));
    }
    this.#setPending('xp', undefined);
    this.#emit('xp.awarded', {
      total: held.total, perCharacter: awarded, before, after, confirmed: true, encounterIds: held.encounterIds
    }, { actorKind: actor.actorKind, actorId: actor.actorId, nodeId: held.nodeId });
    for (const c of rows) this.#queueLevels(c, before[c.slotId], after[c.slotId], held.nodeId);
    this.#autoLevels();
    return true;
  }

  // ---------------------------------------------------------- level-ups

  #levelUp(local) {
    const l = this.store.getLevelUp(this.#runId(), this.#luDb(local));
    if (!l) throw new RunIntentError('E_INVALID_INTENT', `no level-up ${local}`);
    return l;
  }

  /** The level row a seat must take next (levels apply one at a time). */
  #assertNext(l) {
    if (l.mode === 'reconcile') return;
    const next = this.#actionableLevelUps().find(x => x.slotId === l.slotId && x.mode !== 'reconcile');
    if (!next || next.id !== l.id) throw new RunIntentError('E_INVALID_INTENT', `apply level ${next ? next.toLevel : '?'} first`);
  }

  /** Protocol choices → level-up.js picks (spell names resolved through the SRD cache). */
  #picks(choices = {}) {
    const picks = {};
    if (choices.className) picks.className = choices.className;
    if (choices.asi) picks.asi = clone(choices.asi);
    if (choices.spells?.length) {
      picks.spells = choices.spells.map(name => {
        const rec = this.store.srdRecord(name, 'spell');
        const level = Number(rec?.payload?.level);
        if (!rec || !Number.isInteger(level)) throw new RunIntentError('unknown-spell', `${name} is not a known SRD spell (search it first)`);
        return { name: rec.payload.name || rec.name, level, school: rec.payload.school?.name ?? rec.payload.school ?? null };
      });
    }
    return picks;
  }

  #plan(c, l, picks) {
    return planLevelUp(c.sheet, c.state, { toLevel: l.toLevel, className: picks.className, settings: { hpOnLevel: this.#settings().hpOnLevel } });
  }

  /**
   * levelup.choose: the player's picks, checked by a dry run of
   * applyLevelUp; the row waits for the DM. One `level.chosen` run event
   * records the row's {status, choices} before and after.
   */
  #levelChoose(member, { slotId, levelUpId, choices }, actor) {
    const c = this.#ownSeat(member, slotId);
    const l = this.#levelUp(levelUpId);
    if (l.slotId !== slotId) throw new RunIntentError('E_FORBIDDEN', 'that level-up is not yours');
    if (l.status !== 'pending_player' || l.mode === 'reconcile') throw new RunIntentError('E_STALE', `level-up ${levelUpId} is ${l.status}`);
    this.#assertNext(l);
    const picks = this.#picks(choices);
    applyLevelUp(c.sheet, c.state, this.#plan(c, l, picks), picks, { rng: createRng({ s: 1 }) });
    this.#tx(() => {
      if (!this.store.decideLevelUp(this.#runId(), l.id, { fromStatus: 'pending_player', status: 'pending_dm', choices })) {
        throw new RunIntentError('E_STALE', 'that level-up moved on');
      }
      this.#emit('level.chosen', {
        levelUpId, slotId, fromLevel: l.fromLevel, toLevel: l.toLevel, choices,
        before: { status: l.status, choices: clone(l.choices ?? null) }, after: { status: 'pending_dm', choices }
      }, actor);
    });
    this.#afterChange();
    return { status: 'pending_dm' };
  }

  /** levelup.reconcile: diff the run sheet against the latest D&D Beyond import (level-up.js reconcileDiff). */
  #levelReconcile(member, { slotId }, actor) {
    const c = this.#ownSeat(member, slotId);
    const fresh = c.characterRowId ? this.store.characterParsed(c.characterRowId) : null;
    if (!fresh) throw new RunIntentError('E_INVALID_INTENT', 're-import the character first');
    const level = c.level ?? sheetLevel(c.sheet);
    if (level >= 20) throw new RunIntentError('E_INVALID_INTENT', 'a level-20 sheet cannot queue a reconcile');
    const raw = reconcileDiff(c.sheet, fresh, level);
    if (!raw.ok) throw new RunIntentError(raw.code || 'reconcile-refused', raw.reason, { ddbLevel: raw.ddbLevel, grantedLevel: raw.grantedLevel });
    // Never let a D&D Beyond paste take back what the game granted.
    const { diff, dropped } = keepGameGrants(raw, c.sheet, this.store.listLevelUps(this.#runId()).filter(l => l.slotId === slotId));
    if (dropped.length) this.log('info', 'run: reconcile kept game-granted entries', { roomId: this.room.id, runId: this.row.id, slotId, dropped: dropped.map(d => `${d.kind}:${d.name ?? d.stat}`) });
    if (!diff.proposals.length) throw new RunIntentError('nothing-to-reconcile', 'D&D Beyond has no structural change to bring in', dropped.length ? { kept: dropped.length } : undefined);
    let local;
    this.#tx(() => {
      local = this.#nextLevelUpId();
      this.store.addLevelUp(this.#runId(), { id: this.#luDb(local), slotId, fromLevel: level, mode: 'reconcile', status: 'pending_dm', auto: { diff, fresh } });
      this.#emit('level.queued', {
        levelUpId: local, slotId, fromLevel: level, toLevel: level, mode: 'reconcile', proposals: diff.proposals.length,
        ...(dropped.length ? { kept: dropped.length } : {})
      }, actor);
    });
    this.#afterChange();
    return { levelUpId: local, proposals: diff.proposals.length, ...(dropped.length ? { kept: dropped.length } : {}) };
  }

  /** dm.levelup.confirm: apply (level-up.js applyLevelUp / applyReconcile), recording `granted` for revert. */
  #levelConfirm({ levelUpId, choices }, actor) {
    const l = this.#levelUp(levelUpId);
    if (l.status !== 'pending_dm' && l.status !== 'pending_player') throw new RunIntentError('E_STALE', `level-up ${levelUpId} is ${l.status}`);
    this.#assertNext(l);
    const c = this.#character(l.slotId);
    const picked = choices ?? l.choices ?? {};
    this.#tx(() => {
      this.#applyLevelRow(l, picked, { ...actor, override: l.status === 'pending_player' });
      this.#autoLevels();
    });
    this.#afterChange();
    return { level: this.store.getCharacter(c.slotId).level };
  }

  /**
   * Apply one level_ups row (inside #tx; level-up.js applyLevelUp /
   * applyReconcile), recording `granted` for revert, with one level.applied.
   */
  #applyLevelRow(l, picked, actor) {
    const levelUpId = this.#luLocal(l.id);
    const c = this.store.getCharacter(l.slotId);
    let sheet;
    let state = c.state;
    let granted;
    let level;
    if (l.mode === 'reconcile') {
      const ids = (l.auto?.diff?.proposals || []).map(x => x.id);
      ({ sheet, granted } = applyReconcile(c.sheet, l.auto.fresh, l.auto.diff, ids));
      level = sheetLevel(sheet);
    } else {
      const picks = this.#picks(picked);
      const rng = this.#rng();
      ({ sheet, state, granted } = applyLevelUp(c.sheet, c.state, this.#plan(c, l, picks), picks, { rng }));
      this.#saveRng(rng);
      level = l.toLevel;
    }
    if (!this.store.decideLevelUp(this.#runId(), l.id, { fromStatus: l.status, status: 'applied', choices: picked, granted, decidedBy: actor.actorId ?? null })) {
      throw new RunIntentError('E_STALE', 'that level-up moved on');
    }
    this.#write(c, { sheet, state, level });
    this.#emit('level.applied', {
      levelUpId, slotId: c.slotId, fromLevel: l.mode === 'reconcile' ? c.level : l.fromLevel, toLevel: level, mode: l.mode, granted,
      before: { state: c.state, level: c.level }, after: { state, level }
    }, actor);
  }

  /**
   * levelUpMode 'auto' (inside #tx): every seat's next queued level whose
   * plan has no choices (planLevelUp: no class / ASI / spell pick, nothing
   * missing) applies now without the DM, as a system level.applied. A
   * level with choices waits for dm.levelup.confirm; the levels after it
   * apply once it does.
   */
  #autoLevels() {
    if (this.#settings().levelUpMode !== 'auto') return;
    const system = { actorKind: 'system', actorId: null };
    for (let guard = 0; guard < 40; guard++) {
      let applied = false;
      for (const l of this.#actionableLevelUps()) {
        if (l.mode !== 'auto' || l.status !== 'pending_dm') continue;
        const c = this.store.getCharacter(l.slotId);
        let plan;
        try {
          plan = planLevelUp(c.sheet, c.state, { toLevel: l.toLevel, settings: { hpOnLevel: this.#settings().hpOnLevel } });
        } catch (err) {
          if (err instanceof CampaignRuleError) continue;
          throw err;
        }
        if (plan.requiresDm) continue;
        this.#applyLevelRow(l, {}, system);
        applied = true;
      }
      if (!applied) return;
    }
  }

  /** Persist a run RNG draw (inside #tx) and keep the in-memory row in step for the next draw. */
  #saveRng(rng) {
    const state = rng.state();
    this.store.setRng(this.#runId(), state);
    this.row = { ...this.row, rng: state };
  }

  /** dm.levelup.revert: the latest applied level-up, back byte for byte (level-up.js revertLevelUp). */
  #levelRevert({ levelUpId }, actor) {
    const l = this.#levelUp(levelUpId);
    if (l.status !== 'applied') throw new RunIntentError('E_STALE', `level-up ${levelUpId} is ${l.status}`);
    const c = this.#character(l.slotId);
    const r = revertLevelUp(c.sheet, c.state, l.granted);
    const level = sheetLevel(r.sheet);
    this.#tx(() => {
      if (!this.store.decideLevelUp(this.#runId(), l.id, { fromStatus: 'applied', status: 'reverted', decidedBy: actor.actorId })) {
        throw new RunIntentError('E_STALE', 'that level-up moved on');
      }
      this.#write(c, { sheet: r.sheet, state: r.state, level });
      this.#emit('level.reverted', {
        levelUpId, slotId: c.slotId, fromLevel: c.level, toLevel: level, mode: l.mode,
        before: { state: c.state, level: c.level }, after: { state: r.state, level }
      }, actor);
    });
    this.#afterChange();
    return { level };
  }

  // -------------------------------------------------- revive and retire

  /** dm.character.revive: Revivify / Raise Dead (a caster seat, a slot, a diamond) or a DM override (death.js revive). */
  #revive({ slotId, method, casterSlotId }, actor) {
    const c = this.#character(slotId);
    const settings = this.#settings();
    const caster = casterSlotId ? this.#character(casterSlotId) : null;
    if (method !== 'dm' && !caster) throw new RunIntentError('no-caster', `${method} needs casterSlotId`);
    const pool = method === 'dm' ? [] : this.store.listItems(this.#runId()).filter(i => i.ownerSlotId === null || i.ownerSlotId === casterSlotId || i.ownerSlotId === slotId);
    const since = this.progress.deathsAt[slotId] === undefined ? 0 : this.progress.entries - this.progress.deathsAt[slotId];
    const r = revive(c.state, {
      method, deathMode: settings.deathMode, lifeStatus: c.lifeStatus, betweensSinceDeath: since, items: pool,
      ...(caster ? { caster: { id: caster.slotId, sheet: caster.sheet, state: caster.state, lifeStatus: caster.lifeStatus } } : {})
    });
    this.#tx(() => {
      this.#write(c, { state: r.state, lifeStatus: r.lifeStatus });
      if (r.casterState && caster) this.#write(caster, { state: r.casterState });
      for (const s of r.spent.items) { const it = this.#item(s.id); this.#setQty(it, it.qty - s.qty); }
      this.#emit('character.revived', {
        slotId, method, lifeStatus: r.lifeStatus, casterSlotId: casterSlotId ?? null, spent: r.spent,
        before: { state: c.state, lifeStatus: c.lifeStatus, ...(caster ? { casterState: caster.state } : {}) },
        after: { state: r.state, lifeStatus: r.lifeStatus, ...(r.casterState ? { casterState: r.casterState } : {}) }
      }, { ...actor, override: r.override });
    });
    this.#afterChange();
    return { lifeStatus: r.lifeStatus };
  }

  /** Copy a seat's run row into the roster archive (always before the seat is reused). */
  #archive(c, reason) {
    return this.store.archiveSeat(this.#runId(), c.slotId, reason);
  }

  /** dm.character.retire: archive the character, return its items to the stash, empty the seat. */
  #retire({ slotId, reason = 'retired' }, actor) {
    const c = this.#character(slotId);
    this.#tx(() => {
      const archiveId = this.#archive(c, reason.slice(0, 64) || 'retired');
      for (const it of this.store.listItems(this.#runId(), { ownerSlotId: slotId })) {
        this.store.updateItem(this.#runId(), it.id, { ownerSlotId: null, equipped: false, attuned: false });
      }
      this.port.roomStore().deleteSeat(this.room.id, c.seat);
      this.#emit('character.retired', {
        slotId, archiveId, reason, seat: c.seat,
        before: { level: c.level, xp: c.xp, lifeStatus: c.lifeStatus, characterId: String(c.sheet?.id ?? '') }, after: null
      }, actor);
    });
    this.port.seatsChanged();
    this.#afterChange();
    return {};
  }

  /**
   * dm.seat.fill: seat a room character in a run seat. A run character
   * already there is archived first (upsertSeat nulls the row's sheet and
   * state); the newcomer joins as imported, and the DM may grant levels
   * up to the party's highest (queued level-ups).
   */
  #seatFill({ seat, characterId, controller, memberId = null, level }, actor) {
    if (characterId === null) throw new RunIntentError('E_INVALID_INTENT', 'a run seat needs a character');
    const rs = this.port.roomStore();
    const ch = rs.getRoomCharacter(this.room.id, characterId);
    if (!ch) throw new RunIntentError('E_INVALID_INTENT', 'import the character into this room first');
    let pid = null;
    if (controller === 'player') {
      const p = memberId ? rs.getParticipant(this.room.id, memberId) : null;
      if (!p || p.status !== 'active' || p.role !== 'player') throw new RunIntentError('E_INVALID_INTENT', 'name an active player to seat');
      const other = rs.listSeats(this.room.id).find(s => s.controllerParticipantId === p.id && s.seat !== seat);
      if (other) throw new RunIntentError('E_SEAT_TAKEN', 'that player already holds a seat');
      pid = p.id;
    }
    const sheet = clone(ch.parsed);
    const imported = sheetLevel(sheet);
    const partyMax = Math.max(imported, ...this.#characters().map(c => c.level ?? 1));
    const target = level ?? imported;
    if (target < imported || target > partyMax) throw new RunIntentError('E_INVALID_INTENT', `level must be ${imported}–${partyMax}`);
    const prev = rs.getSeat(this.room.id, seat);
    const prevChar = prev?.runId === this.#runId() ? this.store.getCharacter(prev.id) : null;
    let slotId;
    this.#tx(() => {
      let archiveId = null;
      if (prevChar) {
        archiveId = this.#archive(prevChar, 'replaced');
        for (const l of this.store.pendingLevelUps(prevChar.slotId)) {
          this.store.decideLevelUp(this.#runId(), l.id, { fromStatus: l.status, status: 'reverted', decidedBy: actor.actorId });
        }
        for (const it of this.store.listItems(this.#runId(), { ownerSlotId: prevChar.slotId })) {
          this.store.updateItem(this.#runId(), it.id, { ownerSlotId: null, equipped: false, attuned: false });
        }
      }
      slotId = prev?.id || newId('s_');
      rs.upsertSeat({ id: slotId, roomId: this.room.id, seat, characterRowId: ch.id, seedParsed: ch.parsed, controller: pid, archetype: 'auto' });
      const state = initialRunState(sheet);
      const xp = xpForLevel(imported);
      const row = this.store.resetSeat(this.#runId(), slotId, { sheet, state, level: imported, xp, lifeStatus: 'active' });
      this.#emit('seat.filled', {
        slotId, seat, controller,
        before: prevChar ? { characterId: String(prevChar.sheet?.id ?? ''), level: prevChar.level, archiveId } : null,
        after: { characterId: String(sheet.id), level: imported, memberId: pid }
      }, actor);
      const ev = this.#emit('character.joined', {
        slotId, characterId: String(sheet.id), level: imported, before: null,
        after: { state, xp, level: imported, lifeStatus: 'active' }
      }, actor);
      this.#seedItems(slotId, sheet, ev.seq);
      if (target > imported) this.#queueLevels(row, xp, xpForLevel(target), undefined, { mode: 'xp' });
      this.#autoLevels();
    });
    this.port.seatsChanged();
    this.#afterChange();
    return { slotId };
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
      this.#confirmXp({ actorKind: 'dm', actorId: DM_ACTOR });
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
      this.#setPending('rest', {});
    });
    this.#afterChange();
    this.log('info', 'run: ended', { roomId: this.room.id, runId: this.row.id, outcome });
    return { outcome };
  }

  // -------------------------------------------------------------- rests

  /**
   * rest.spend: declare the hit dice a seat spends at the next short rest
   * (validated, not yet rolled). The declaration is a non-mutating
   * `rest.declared` run event and persists in runs.pending_json, so it
   * survives a restart; dm.rest.grant's `rest.taken` is the mutation.
   */
  #restSpend(member, { slotId, hitDice }, actor) {
    const c = this.#ownSeat(member, slotId);
    // Dry run with a throwaway rng: the rules refuse an overspend before rolling.
    applyRest(c.sheet, c.state, 'short', { spend: hitDice, rng: createRng({ s: 1 }), lifeStatus: c.lifeStatus });
    this.#tx(() => {
      this.#setPending('rest', { ...this.pendingRest, [slotId]: hitDice });
      this.#emit('rest.declared', { slotId, hitDice }, actor);
    });
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
      const left = { ...this.pendingRest };
      for (const s of applied) delete left[s];
      this.#setPending('rest', left);
      if (nodeRest) this.#emit('node.completed', { nodeId: node.id, kind: node.kind });
    });
    this.#afterChange();
    return {};
  }
}
