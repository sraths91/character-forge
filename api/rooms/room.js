// One live room (M64 B7/B8, R1 §3.1): members and their sockets, the
// room-monotonic seq, and two lanes.
//
//  - Turn lane: one async coroutine (#runLoop) drives the engine port turn
//    by turn. Prompts the engine awaits are answered by the PromptBroker,
//    the DM gates (plan review, armed rolls) and cinema pacing.
//  - Control lane: every inbound message, processed serially per room
//    (#control promise chain). Prompt answers resolve broker promises; DM
//    state edits apply now at a safe point (no turn in flight, or the turn
//    is waiting for an intent) and otherwise queue to the end of the turn.
//
// Persistence before broadcast: engine events are buffered, written by the
// journal in one transaction (with the snapshot at turn end), and only
// then delivered. Every outbound message is validated with
// shared/protocol.js and every broadcast passes through view.js.
//
// Fog (M64 W5): when the encounter has fog, every outbound event and
// per-entity room message is classified for player seats at emit time
// (view.js fogEventView: full, masked with HIDDEN_ENTITY_ID, or
// `redacted {type}` with the same seq). Player seats' `turn.ended` and
// snapshot hashes cover the fog-filtered projection; the DM's the full
// state. A creature crossing the fog edge re-baselines player seats with
// a fresh snapshot after the flush that delivered the crossing.

import { randomInt } from 'node:crypto';
import { createRng } from '../../src/js/scene/rng.js';
import { validateEvent } from '../../src/js/shared/events.js';
import { validateEncounterState } from '../../src/js/shared/encounter-state.js';
import { PROTOCOL_VERSION, INTENT_ROLES, CLOSE_CODES, validateServerMessage } from '../../src/js/shared/protocol.js';
import { PromptBroker } from './prompt-broker.js';
import { viewFor, publicView, canSeeEvent, stateHash, stateHashFor, fogEventView, fogVisibility } from './view.js';
import { newId } from './tokens.js';
import { publicSeat, RoomError, MAX_SEATS, normalizeRoomSettings } from './service.js';
import { RunController } from '../runs/run-controller.js';

/** Events kept in memory for `room.snapshot.history`. */
export const HISTORY_LIMIT = 50;
/** Remembered client message ids per member (cid de-dupe). */
export const CID_CACHE_SIZE = 256;
/** Extra cinema wait on top of the exchange's durationMs. */
export const CINEMA_SLACK_MS = 1500;
/** Cinema length assumed when an exchange carries durationMs 0 (engine cannot know it). */
export const FALLBACK_CINEMA_MS = 2500;
/** Cap on a DM roll-review prompt. */
export const ROLL_REVIEW_MS = 8000;

/** DM edits that may apply while a turn waits for its intent. */
const INTENT_SAFE = new Set(['dm.entity.patch', 'dm.entity.add', 'dm.entity.remove', 'dm.terrain.paint', 'dm.fog.paint', 'dm.seat.setController', 'dm.spell.adjudicate']);
/** DM edits handled as state commands (safe point or queued). */
const STATE_COMMANDS = new Set([...INTENT_SAFE, 'dm.initiative.roll', 'dm.initiative.set']);
/** Entity fields compared to produce `entity.updated` patches. */
const PATCH_FIELDS = [
  'name', 'controller', 'pos', 'hp', 'hpMax', 'hpTemp', 'ac', 'speedFt', 'conditions', 'concentration',
  // W6: the dying state (stored only while not 'active') and the DM's token image.
  'status', 'deathSaves', 'imageUrl'
];
/** A patch field's value with the storage defaults spelled out (absent status = 'active'). */
const patchValue = (e, f) => (f === 'status' ? (e.status ?? 'active') : (f === 'deathSaves' || f === 'imageUrl') ? (e[f] ?? null) : e[f]);

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A protocol-level rejection carried back to the sender as an `error` frame. */
class IntentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Divergence between a replayed turn and its event log. */
export class ReplayDivergence extends Error {}

/**
 * @typedef {object} Conn  — a gateway connection
 * @property {string} id
 * @property {(text: string) => void} sendRaw
 * @property {(code: number, reason?: string) => void} close
 */

export class Room {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {ReturnType<import('./service.js').createRoomService>} o.service
   * @param {import('./engine-port.js').EnginePort} o.engine
   * @param {object} o.journal  persistence (see persistence.js)
   * @param {(level: string, msg: string, extra?: object) => void} o.log
   * @param {() => number} [o.now]
   * @param {typeof setTimeout} [o.setTimer]
   * @param {typeof clearTimeout} [o.clearTimer]
   * @param {{store: object, materializeSetup?: Function}|null} [o.runs]  M65 run store (+ asset
   *   materializer): the room hosts a campaign run through api/runs/run-controller.js
   */
  constructor({ id, service, engine, journal, log, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, runs = null }) {
    this.id = id;
    this.service = service;
    this.store = service.store;
    this.engine = engine;
    this.journal = journal;
    this.log = log;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    const row = this.store.getRoom(id);
    if (!row) throw new Error(`room ${id} not found`);
    this.code = row.code;
    this.name = row.name;
    this.settings = normalizeRoomSettings(row.settings);
    this.seq = row.seq;
    this.status = 'lobby';
    /** @type {Map<string, {id: string, role: 'dm'|'player', displayName: string, conn: Conn|null, cids: Map<string, object>}>} */
    this.members = new Map();
    for (const p of this.store.listParticipants(id)) if (p.status === 'active') this.#addMember(p);
    this.seats = this.store.listSeats(id);

    this.enc = null;            // {id, state, status, liveState, history[], outcome}
    this.turn = null;           // in-flight turn
    this.recovery = null;       // {turnId, answers[], events[]} from the journal
    this.outbox = [];
    this.pendingEvents = [];
    this.turnEndBuffered = false;
    this.lastEventSeq = 0;
    this.dmQueue = [];
    this.review = { plans: false, rolls: false, monsterReactions: false };
    this.armedRolls = [];
    this.styles = new Map();
    this.cinemaWait = null;
    this.paused = false;
    this.closing = false;
    this.loopRunning = false;
    this.loopPromise = null;
    this.endRequested = null;
    this.control = Promise.resolve();
    this.flushTimer = null;
    /** stamped event → player-seat view under fog ({full} | {payload} | null = redacted). */
    this.fogViews = new WeakMap();
    /** A creature crossed the fog edge: snapshot player seats after the next flush. */
    this.fogResnap = false;
    /** DM edit in progress: {before, after} states the fog check reads instead of the turn's. */
    this.fogBasis = null;
    this.broker = new PromptBroker({
      send: (memberId, t, p) => { const m = this.members.get(memberId); if (m) this.#sendPrivate(m, t, p); },
      isOnline: (memberId) => !!this.members.get(memberId)?.conn,
      now, setTimer, clearTimer
    });

    const live = journal.loadLive(id);
    if (live) this.#restore(live);

    // M65 B24: the run this room hosts (its boot sweep applies any ended
    // encounter not yet written back).
    this.run = runs?.store ? new RunController({ room: this, port: this.#runPort(), store: runs.store, log, materializeSetup: runs.materializeSetup ?? null }) : null;
    if (this.run?.active && !this.#encounterLive()) this.status = 'between';
  }

  /** A setup / active encounter is in the room. */
  #encounterLive() {
    return !!this.enc && (this.enc.status === 'setup' || this.enc.status === 'active');
  }

  /** The room's private lane, as the run controller sees it. */
  #runPort() {
    return {
      broadcast: (t, p) => this.#broadcastRoom(t, p),
      sendPrivate: (m, t, p) => this.#sendPrivate(m, t, p),
      setStatus: (st) => this.#setStatus(st),
      members: () => this.members,
      encounterLive: () => this.#encounterLive(),
      seats: () => this.seats,
      roomStore: () => this.store,
      encounter: () => this.enc,
      seatsChanged: () => this.seatsChanged(),
      controllerFor: (seat) => this.#seatController(seat),
      setupEncounter: ({ encounterId, seed, setup, party, runId, nodeId }) => this.#setup(setup, { encounterId, seed, party, runId, nodeId }),
      startEncounter: () => this.#start({})
    };
  }

  /** How a seat's PC is driven: its player, else the AI (B28 extends this). */
  #seatController(seat) {
    return seat?.controllerParticipantId ? 'player' : 'ai';
  }

  /** The single run hook for both encounter-end paths (never throws into the turn lane). */
  #encounterEndedForRun(enc) {
    if (!this.run) return;
    try {
      this.run.onEncounterEnded(enc.id);
    } catch (err) {
      // The encounter row is ended and unmarked: the boot sweep retries it.
      this.log('error', 'room: run write-back failed', { roomId: this.id, encounterId: enc.id, error: err.message });
    }
  }

  // ---------------------------------------------------------------- members

  #addMember(p) {
    const m = { id: p.id, role: p.role, displayName: p.displayName, conn: null, cids: new Map() };
    this.members.set(p.id, m);
    return m;
  }

  /** Number of connected sockets. */
  get socketCount() {
    let n = 0;
    for (const m of this.members.values()) if (m.conn) n++;
    return n;
  }

  get dm() {
    for (const m of this.members.values()) if (m.role === 'dm') return m;
    return null;
  }

  /**
   * Bind an authenticated socket. A second socket for the same member
   * supersedes the first (closed 4409).
   * @param {Conn} conn
   * @param {import('./store.js').MemberAuth} auth
   * @param {string} helloCid
   */
  attach(conn, auth, helloCid) {
    let m = this.members.get(auth.participantId);
    if (!m) m = this.#addMember({ id: auth.participantId, role: auth.role, displayName: auth.displayName });
    const old = m.conn;
    m.conn = conn;
    if (old && old !== conn) old.close(CLOSE_CODES.SUPERSEDED, 'superseded by a newer connection');
    this.store.touchParticipant(m.id);
    if (!this.turnEndBuffered) this.#flush();   // the snapshot's seq must cover only delivered broadcasts
    this.#sendPrivate(m, 'hello.ok', {
      memberId: m.id, role: m.role, seats: this.seats.map(publicSeat), serverNow: this.now(),
      cfg: { protocol: PROTOCOL_VERSION, roomId: this.id, code: this.code, reactionTimeoutMs: this.settings.reactionTimeoutMs, helloCid }
    });
    this.#sendSnapshot(m);
    this.run?.sendSnapshot(m);
    if (!old) this.#broadcastRoom('member.presence', { memberId: m.id, online: true });
    // A prompt waiting on this member is re-sent by the snapshot (openPrompt).
  }

  /** Unbind a socket (closed or superseded). */
  detach(conn) {
    for (const m of this.members.values()) {
      if (m.conn !== conn) continue;
      m.conn = null;
      this.store.touchParticipant(m.id);
      this.broker.memberOffline(m.id);
      this.#cinemaDone(m.id, null);
      if (!this.closing) this.#broadcastRoom('member.presence', { memberId: m.id, online: false });
    }
  }

  /** Service event: a player joined over HTTP. */
  memberJoined({ participantId, displayName }) {
    if (this.members.has(participantId)) return;
    this.#addMember({ id: participantId, role: 'player', displayName });
    this.#broadcastRoom('member.joined', { memberId: participantId, displayName, role: 'player' });
  }

  /** Service event: a player was kicked (HTTP or dm.member.revoke). */
  memberKicked({ participantId }) {
    const m = this.members.get(participantId);
    if (!m) return;
    this.members.delete(participantId);
    this.broker.memberOffline(participantId);
    this.#cinemaDone(participantId, null);
    if (m.conn) m.conn.close(CLOSE_CODES.REVOKED, 'removed by the DM');
    m.conn = null;
    this.#broadcastRoom('member.left', { memberId: participantId, reason: 'kicked' });
  }

  /**
   * The DM token was replaced (campaign-key DM recovery, M65 B26): the
   * socket opened with the old token is closed; the DM reconnects with
   * the new one.
   */
  dmTokenRotated() {
    const m = this.dm;
    if (m?.conn) {
      const c = m.conn;
      m.conn = null;
      c.close(CLOSE_CODES.REVOKED, 'the DM token was replaced');
    }
  }

  /** Service event: seats changed; broadcast a `seat.updated` per changed seat. */
  seatsChanged() {
    const before = new Map(this.seats.map(s => [s.seat, s]));
    this.seats = this.store.listSeats(this.id);
    const after = new Map(this.seats.map(s => [s.seat, s]));
    for (let n = 1; n <= MAX_SEATS; n++) {
      const a = before.get(n);
      const b = after.get(n);
      if (!a && !b) continue;
      if (a && b && same(publicSeat(a), publicSeat(b))) continue;
      const s = b || a;
      this.#broadcastRoom('seat.updated', {
        characterId: String(s.characterId ?? s.id), memberId: b ? b.controllerParticipantId : null,
        controller: b?.controllerParticipantId ? 'player' : 'ai', seat: n, slotId: s.id, removed: !b
      });
    }
  }

  // ----------------------------------------------------------- outbound

  #message(t, p, seq) {
    const msg = seq === undefined ? { v: PROTOCOL_VERSION, t, ts: this.now(), p } : { v: PROTOCOL_VERSION, t, seq, ts: this.now(), p };
    const res = validateServerMessage(msg);
    if (!res.ok) {
      const detail = res.errors.slice(0, 3).map(e => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`invalid server message ${t}: ${detail}`);
    }
    return msg;
  }

  #sendPrivate(m, t, p) {
    if (!m.conn) return;
    try {
      m.conn.sendRaw(JSON.stringify(this.#message(t, p)));
    } catch (err) {
      this.log('error', 'room: private message dropped', { roomId: this.id, t, error: err.message });
    }
  }

  /**
   * Queue a sequenced room message (not an engine event).
   * @param {string} t
   * @param {object} p
   * @param {object|null} [player]  fog: what player seats get instead —
   *   a payload variant, or null for `redacted {type}`; undefined = same
   */
  #broadcastRoom(t, p, player) {
    const seq = this.seq + 1;
    const msg = this.#message(t, p, seq);   // throws before the seq is consumed
    const playerMsg = player === undefined ? undefined
      : player === null ? this.#message('redacted', { type: t }, seq) : this.#message(t, player, seq);
    this.seq = seq;
    this.outbox.push({ kind: 'room', msg, playerMsg });
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.pendingEvents.length === 0 && !this.turnEndBuffered) { this.#flush(); return; }
    if (this.flushTimer) return;
    this.flushTimer = setImmediate(() => { this.flushTimer = null; if (!this.turnEndBuffered) this.#flush(); });
  }

  /**
   * Persist buffered events (+ optional snapshot) in one transaction, then
   * deliver the outbox in seq order.
   * @param {{snapshot?: object, status?: string, outcome?: string|null}} [o]
   */
  #flush(o = {}) {
    if (this.closing && !o.final) return;
    if (this.turnEndBuffered && !o.snapshot) return;
    const events = this.pendingEvents;
    const hasWork = events.length || this.outbox.length || o.snapshot || o.status || this.turn?.logDirty;
    if (!hasWork) return;
    this.journal.flush({
      roomId: this.id,
      roomSeq: this.seq,
      encounterId: this.enc?.id ?? null,
      events,
      turnLog: this.turn ? { turnId: this.turn.turnId, actorId: this.turn.actorId, answers: this.turn.answers } : null,
      snapshot: o.snapshot ? { state: o.snapshot, seq: this.lastEventSeq } : null,
      status: o.status ?? null,
      outcome: o.outcome ?? null
    });
    if (this.turn) this.turn.logDirty = false;
    this.pendingEvents = [];
    this.turnEndBuffered = false;
    const out = this.outbox;
    this.outbox = [];
    for (const item of out) this.#deliver(item);
    if (this.fogResnap) {
      this.fogResnap = false;
      for (const m of this.members.values()) if (m.conn && m.role === 'player') this.#sendSnapshot(m);
    }
  }

  #deliver(item) {
    if (item.kind === 'room') {
      const text = JSON.stringify(item.msg);
      const playerText = item.playerMsg ? JSON.stringify(item.playerMsg) : text;
      for (const m of this.members.values()) if (m.conn) m.conn.sendRaw(m.role === 'player' ? playerText : text);
      return;
    }
    const ev = item.ev;
    const full = this.#message(ev.type, ev, ev.seq);
    const fullText = JSON.stringify(full);
    const fog = this.fogViews.get(ev);
    let redactedText = null;
    let maskedText = null;
    for (const m of this.members.values()) {
      if (!m.conn) continue;
      const seen = canSeeEvent(ev, m, this.settings);
      if (seen && (m.role !== 'player' || fog === undefined || fog?.full)) { m.conn.sendRaw(fullText); continue; }
      if (seen && fog) {
        maskedText ||= JSON.stringify(this.#message(ev.type, { ...ev, payload: fog.payload }, ev.seq));
        m.conn.sendRaw(maskedText);
        continue;
      }
      redactedText ||= JSON.stringify(this.#message('redacted', { type: ev.type }, ev.seq));
      m.conn.sendRaw(redactedText);
    }
  }

  /**
   * Classify a just-stamped event for player seats when the encounter has
   * fog (view.js fogEventView) and track creatures that moved this turn.
   */
  #fogMark(ev) {
    const basis = this.fogBasis;
    const st = basis ? basis.after : this.#currentState();
    if (!st?.fog) return;
    let vis;
    if (basis) {
      const a = fogVisibility(basis.before);
      const b = fogVisibility(basis.after);
      vis = { cellRevealed: b.cellRevealed, isKnown: (id) => a.isKnown(id) || b.isKnown(id), isVisible: (id) => a.isVisible(id) || b.isVisible(id) };
    } else {
      vis = fogVisibility(st, this.turn?.fogMoves);
    }
    const { view, crossed } = fogEventView(ev, vis);
    this.fogViews.set(ev, view);
    if (crossed) this.fogResnap = true;
    if (ev.type === 'move' && this.turn && !basis && ev.payload.to) this.turn.fogMoves.set(ev.payload.actorId, { col: ev.payload.to.col, row: ev.payload.to.row });
  }

  /** Player seats' turn.ended carries the hash of their fog-filtered projection. */
  #fogTurnEnded(ev, state) {
    if (!state.fog) return;
    const fv = this.fogViews.get(ev);
    const base = fv && !fv.full ? fv.payload : ev.payload;
    this.fogViews.set(ev, { payload: { ...base, stateHash: stateHashFor(state, { role: 'player' }) } });
  }

  /** Player-seat entity filter for room messages under fog (null = no fog). */
  #fogVisibleIn(state) {
    if (!state?.fog) return null;
    return fogVisibility(state).isVisible;
  }

  /** `encounter.initiative` for every seat; under fog players get the visible rows only. */
  #broadcastInitiative(state) {
    const order = state.initiative.map(r => ({ entityId: r.entityId, score: r.score }));
    const visible = this.#fogVisibleIn(state);
    this.#broadcastRoom('encounter.initiative', { order }, visible ? { order: order.filter(r => visible(r.entityId)) } : undefined);
  }

  #snapshotPayload(m) {
    const st = this.enc ? (this.enc.liveState || this.enc.state) : null;
    const fogged = m.role === 'player' && !!st?.fog;
    const history = (this.enc?.history || []).filter(ev => canSeeEvent(ev, m, this.settings)).flatMap((ev) => {
      if (!fogged) return [ev];
      const fv = this.fogViews.get(ev);   // undefined: restored from the journal, unclassified
      if (!fv) return [];
      return [fv.full ? ev : { ...ev, payload: fv.payload }];
    });
    return {
      seq: this.seq,
      room: {
        id: this.id, code: this.code, name: this.name, status: this.status, paused: this.paused,
        // dmOverrideVisibility: the pre-W5 name of fudgeVisibility, kept for old clients.
        settings: { ...this.settings, dmOverrideVisibility: this.settings.fudgeVisibility },
        members: [...this.members.values()].map(x => ({ id: x.id, displayName: x.displayName, role: x.role, online: !!x.conn })),
        seats: this.seats.map(publicSeat),
        encounterId: this.enc?.id ?? null,
        turn: this.turn ? { turnId: this.turn.turnId, actorId: this.turn.actorId, awaitingIntent: !!this.turn.awaiting } : null,
        ...(m.role === 'dm' ? { review: { ...this.review }, armedRolls: this.armedRolls.length } : {})
      },
      encounter: st ? viewFor(st, m) : null,
      openPrompt: this.broker.openPromptFor(m.id),
      history: history.slice(-HISTORY_LIMIT),
      stateHash: st ? stateHashFor(st, m) : null
    };
  }

  #sendSnapshot(m) {
    this.#sendPrivate(m, 'room.snapshot', this.#snapshotPayload(m));
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.#broadcastRoom('room.status', { status });
  }

  // ------------------------------------------------------------- events

  /** Stamp, validate and buffer one engine (or room-emitted) event. */
  #emit(ev) {
    const replay = this.turn?.replay;
    if (replay && replay.events.length) {
      let logged = replay.events.shift();
      while (logged && logged.type === 'turn.rejected' && ev.type !== 'turn.rejected') logged = replay.events.shift();
      if (!logged || logged.type !== ev.type || !same(stripVolatile(logged.payload), stripVolatile(ev.payload))) {
        throw new ReplayDivergence(`replay diverged at ${logged ? `seq ${logged.seq} (${logged.type})` : 'end of log'}: engine emitted ${ev.type}`);
      }
      this.lastEventSeq = logged.seq;
      return logged;
    }
    const stamped = {
      seq: this.seq + 1,
      type: ev.type,
      round: this.turn ? this.turn.round : (this.enc?.state.round ?? 0),
      turnId: this.turn ? this.turn.turnId : null,
      cinemaGroup: ev.cinemaGroup ?? null,
      payload: clone(ev.payload ?? {})
    };
    const res = validateEvent(stamped);
    if (!res.ok) {
      const detail = res.errors.slice(0, 3).map(e => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`engine emitted an invalid ${ev.type} event: ${detail}`);
    }
    this.seq = stamped.seq;
    this.lastEventSeq = stamped.seq;
    this.#fogMark(stamped);
    this.pendingEvents.push(stamped);
    this.outbox.push({ kind: 'event', ev: stamped });
    if (this.enc) {
      this.enc.history.push(stamped);
      if (this.enc.history.length > HISTORY_LIMIT * 2) this.enc.history.splice(0, this.enc.history.length - HISTORY_LIMIT);
    }
    if (stamped.type === 'turn.ended') this.turnEndBuffered = true;
    return stamped;
  }

  // -------------------------------------------------------- recovery (B8)

  #restore(live) {
    if (live.engineVersion !== this.engine.version) {
      this.journal.setStatus(live.encounterId, 'abandoned', null);
      this.store.setRoomStatus(this.id, 'lobby');
      this.log('warn', 'room: encounter abandoned (engine version changed)', {
        roomId: this.id, encounterId: live.encounterId, stored: live.engineVersion, running: this.engine.version
      });
      return;
    }
    this.enc = { id: live.encounterId, state: live.state, status: live.status, liveState: null, history: live.history, outcome: null };
    this.lastEventSeq = live.headSeq;
    this.seq = Math.max(this.seq, live.headSeq);
    if (live.status === 'setup') { this.status = 'setup'; return; }
    this.status = 'paused';
    this.paused = true;   // resumes on dm.resume, once the table has reconnected
    if (live.turnLog || live.tail.length) {
      this.recovery = {
        turnId: live.turnLog?.turnId ?? newId('t_'),
        answers: live.turnLog?.answers ?? [],
        events: live.tail
      };
    }
  }

  // ----------------------------------------------------------- turn lane

  #startLoop() {
    if (this.loopRunning || this.closing) return;
    this.loopRunning = true;
    this.loopPromise = this.#runLoop().finally(() => { this.loopRunning = false; });
  }

  async #runLoop() {
    try {
      while (this.enc && this.enc.status === 'active' && !this.paused && !this.closing) {
        await this.#runOneTurn();
        if (this.closing) return;
        this.#drainDmQueue();
        if (this.endRequested && this.enc?.status === 'active') this.#endEncounter(this.endRequested);
      }
    } catch (err) {
      if (this.closing) return;
      this.log('error', 'room: turn lane failed', { roomId: this.id, error: err.message, stack: err.stack });
      this.turn = null;
      this.pendingEvents = [];
      this.outbox = this.outbox.filter(i => i.kind === 'room');
      this.turnEndBuffered = false;
      if (this.enc) this.enc.liveState = null;
      this.#setStatus('error');
      // Dropped events consumed seqs: give every client a fresh baseline.
      for (const m of this.members.values()) if (m.conn) this.#sendSnapshot(m);
    }
  }

  async #runOneTurn() {
    const enc = this.enc;
    const state = enc.state;
    const rec = this.recovery;
    this.recovery = null;
    const rng = createRng(state.rng);
    this.turn = {
      turnId: rec?.turnId ?? newId('t_'),
      actorId: state.initiative[state.turnIndex]?.entityId,
      round: state.round,
      rng,
      answers: rec ? clone(rec.answers) : [],
      replay: rec ? { answers: clone(rec.answers), events: rec.events.slice(), headSeq: rec.events.at(-1)?.seq ?? 0 } : null,
      awaiting: null,
      logDirty: true,
      fogMoves: new Map()
    };
    const ctx = {
      turnId: this.turn.turnId,
      rng,
      emit: (ev) => this.#emit(ev),
      progress: (s) => { if (this.enc === enc) enc.liveState = clone(s); },
      prompts: this.#prompts(),
      // Which DM gates the engine should call (the real engine skips the
      // planReady / roll hooks otherwise). A replayed turn re-asks exactly
      // what its log answered, whatever the live flags are now.
      review: rec
        ? { plans: rec.answers.some(a => a.kind === 'plan'), rolls: rec.answers.some(a => a.kind === 'roll') }
        : { plans: this.review.plans, rolls: this.review.rolls || this.armedRolls.length > 0 },
      cinemaInputs: ({ attackerId }) => this.#cinemaInputs(attackerId)
    };
    const res = await this.engine.runTurn(clone(state), ctx);
    if (this.closing || this.enc !== enc) return;
    if (this.turn.replay && this.turn.replay.events.some(e => e.type !== 'turn.rejected')) {
      throw new ReplayDivergence('replay finished with unmatched logged events');
    }
    const next = clone(res.state);
    next.rng = rng.state();
    const hash = stateHash(next);
    let ended = this.pendingEvents.findLast(e => e.type === 'turn.ended');
    if (ended) ended.payload.stateHash = hash;
    else ended = this.#emit({ type: 'turn.ended', payload: { actorId: this.turn.actorId, stateHash: hash } });
    this.#fogTurnEnded(ended, next);
    next.lastEventSeq = this.lastEventSeq;
    const over = next.phase === 'ended';
    const outcome = over ? (this.pendingEvents.find(e => e.type === 'encounter.ended')?.payload.outcome ?? null) : null;
    enc.state = next;
    enc.liveState = null;
    this.turn = null;
    if (over) enc.status = 'ended';
    this.#flush({ snapshot: next, status: over ? 'ended' : null, outcome });
    if (over) {
      enc.outcome = outcome;
      this.broker.cancelAll();
      this.#setStatus('encounter-over');
      this.#encounterEndedForRun(enc);
    }
  }

  /** A seat's chosen cinema style / swing (char.setStyle) for an attacker, or {}. */
  #cinemaInputs(attackerId) {
    const e = this.#currentState()?.entities?.[attackerId];
    const seat = e?.controller?.seatId ? this.seats.find(s => s.id === e.controller.seatId) : null;
    const pick = (seat && this.styles.get(String(seat.characterId))) || (e?.sheetRef && this.styles.get(String(e.sheetRef.characterId)));
    return pick ? { style: pick.style, swing: pick.swing } : {};
  }

  /** The next logged answer during replay (kind must match), or undefined when live. */
  #replayAnswer(kind) {
    const r = this.turn?.replay;
    if (!r || r.answers.length === 0) return undefined;
    const a = r.answers.shift();
    if (a.kind !== kind) throw new ReplayDivergence(`replay expected a ${a.kind} answer, engine asked for ${kind}`);
    return a;
  }

  /** Log a live prompt answer for replay (persisted with the next flush). */
  #record(answer) {
    this.turn.answers.push(answer);
    this.turn.logDirty = true;
  }

  /** Who answers for an entity: a player member, the DM, or nobody (AI). */
  #ownerOf(entityId, state) {
    const e = state?.entities?.[entityId];
    if (!e) return { type: 'ai', member: null };
    if (e.controller.type === 'dm') return { type: 'dm', member: this.dm };
    if (e.controller.type === 'player') {
      const seat = this.seats.find(s => s.id === e.controller.seatId);
      const m = seat?.controllerParticipantId ? this.members.get(seat.controllerParticipantId) : null;
      return m ? { type: 'player', member: m } : { type: 'ai', member: null };
    }
    return { type: 'ai', member: null };
  }

  #currentState() {
    return this.turn?.awaiting?.state || this.enc?.liveState || this.enc?.state;
  }

  #prompts() {
    return {
      intent: async ({ actorId, state }) => {
        let s = clone(state);
        const logged = this.#replayAnswer('intent');
        if (logged) {
          for (const cmd of logged.dmCommands || []) s = this.#applyCommand(s, cmd, this.turn.rng, { broadcast: false });
          return { intent: logged.intent, state: s };
        }
        const owner = this.#ownerOf(actorId, s);
        if (!owner.member) {
          const intent = { kind: 'delegate' };
          this.#record({ kind: 'intent', intent, dmCommands: [] });
          return { intent, state: s };
        }
        this.enc.liveState = clone(s);
        const intent = await new Promise((resolve) => {
          this.turn.awaiting = { actorId, ownerId: owner.member.id, state: s, commands: [], resolve };
          this.#flush();
        });
        const aw = this.turn.awaiting;
        this.turn.awaiting = null;
        this.#record({ kind: 'intent', intent, dmCommands: aw.commands });
        this.#flush();
        return { intent, state: aw.state };
      },

      // The room emits `reaction.offered` (only it knows the broker's
      // deadline); the engine emits `reaction.resolved` after re-checking
      // eligibility, so its `used` is authoritative. The room returns the
      // raw answer and who gave it.
      reaction: async ({ kind, reactorId, autoAnswer, eligible, payload = {} }) => {
        if (!eligible) return { answer: false, by: 'auto' };
        const logged = this.#replayAnswer('reaction');
        if (logged) {
          this.#emit({ type: 'reaction.offered', payload: logged.offered });
          return { answer: logged.used === true, by: logged.by };
        }
        const st = this.#currentState();
        const owner = this.#ownerOf(reactorId, st);
        let addressee = owner.member?.id ?? null;
        if (!addressee && this.review.monsterReactions && st.entities[reactorId]?.kind === 'monster') addressee = this.dm?.id ?? null;
        const timeoutMs = this.settings.reactionTimeoutMs;
        const human = !!addressee && this.broker.isOnline(addressee);
        const offered = { reactorId, kind, autoAnswer: !!autoAnswer, deadlineMs: human ? timeoutMs : null };
        this.#emit({ type: 'reaction.offered', payload: offered });
        this.#flush();
        const { answer, by } = await this.broker.ask({ kind, addressee, autoAnswer: !!autoAnswer, payload: { ...clone(payload), reactorId }, timeoutMs });
        if (this.closing) return new Promise(() => {});   // shutting down: the turn re-runs on recovery
        const used = answer === true;   // the answer; the engine's re-check decides reaction.resolved.used
        this.#record({ kind: 'reaction', used, by, offered });
        this.#flush();
        return { answer: used, by };
      },

      planReady: async ({ actorId, plan, breakdown = [] }) => {
        const logged = this.#replayAnswer('plan');
        let out;
        if (logged) {
          out = logged.plan;
        } else {
          out = plan;
          const st = this.#currentState();
          if (this.review.plans && this.#ownerOf(actorId, st).type === 'ai' && this.dm?.conn) {
            this.#flush();
            this.#sendPrivate(this.dm, 'turn.planProposed', { entityId: actorId, plan: clone(plan), breakdown: clone(breakdown) });
            const r = await this.broker.ask({ kind: 'plan', addressee: this.dm.id, autoAnswer: clone(plan), payload: { entityId: actorId, plan: clone(plan) }, timeoutMs: this.settings.reactionTimeoutMs });
            if (this.closing) return new Promise(() => {});
            out = r.answer;
          }
          this.#record({ kind: 'plan', plan: clone(out) });
        }
        if (!same(out, plan)) this.#emit({ type: 'dm.override', payload: { kind: 'plan', entityId: actorId, before: clone(plan), after: clone(out) } });
        return clone(out);
      },

      roll: async ({ rollKind, actorId, targetId = null, result }) => {
        const logged = this.#replayAnswer('roll');
        let value;
        if (logged) {
          value = logged.value;
        } else {
          value = result;
          const st = this.#currentState();
          const e = st.entities[actorId];
          const editable = e && (e.kind === 'monster' || this.#ownerOf(actorId, st).type !== 'player');
          if (editable) {
            const i = this.armedRolls.findIndex(a => a.rollKind === rollKind && (a.entityId == null || a.entityId === actorId));
            if (i >= 0) {
              value = this.armedRolls[i].value;
              this.armedRolls.splice(i, 1);
            } else if (this.review.rolls && this.dm?.conn) {
              this.#flush();
              const r = await this.broker.ask({ kind: 'roll', addressee: this.dm.id, autoAnswer: result, payload: { rollKind, entityId: actorId, targetId, result }, timeoutMs: Math.min(ROLL_REVIEW_MS, this.settings.reactionTimeoutMs) });
              if (this.closing) return new Promise(() => {});
              value = r.answer;
            }
          }
          this.#record({ kind: 'roll', rollKind, value });
        }
        if (value !== result) this.#emit({ type: 'dm.override', payload: { kind: `roll.${rollKind}`, entityId: actorId, before: result, after: value } });
        return value;
      },

      cinema: async (exchange) => {
        const r = this.turn?.replay;
        if (r && exchange.seq <= r.headSeq) return;
        this.#flush();
        // Seats that got this exchange redacted (fog) have no cinema to finish.
        const hidden = this.fogViews.get(exchange) === null;
        const waiting = new Set([...this.members.values()].filter(m => m.conn && !(hidden && m.role === 'player')).map(m => m.id));
        if (waiting.size === 0) return;
        const d = Number(exchange.payload.cinema?.durationMs ?? exchange.payload.durationMs) || 0;
        const capMs = (d > 0 ? d : FALLBACK_CINEMA_MS) + CINEMA_SLACK_MS;
        await new Promise((resolve) => {
          this.cinemaWait = { exchangeId: exchange.payload.exchangeId, waiting, resolve, timer: this.setTimer(() => this.#endCinema(), capMs) };
        });
      }
    };
  }

  #cinemaDone(memberId, exchangeId) {
    const w = this.cinemaWait;
    if (!w || (exchangeId !== null && w.exchangeId !== exchangeId)) return;
    w.waiting.delete(memberId);
    if (w.waiting.size === 0) this.#endCinema();
  }

  #endCinema() {
    const w = this.cinemaWait;
    if (!w) return;
    this.cinemaWait = null;
    this.clearTimer(w.timer);
    w.resolve();
  }

  #endEncounter(outcome) {
    const enc = this.enc;
    this.endRequested = null;
    if (enc.status === 'setup') {
      this.journal.setStatus(enc.id, 'abandoned', null);
      this.enc = null;
      this.#setStatus(this.run?.idleRoomStatus ?? 'lobby');
      return;
    }
    this.#emit({ type: 'encounter.ended', payload: { outcome } });
    enc.state = { ...enc.state, phase: 'ended', lastEventSeq: this.lastEventSeq };
    enc.status = 'ended';
    enc.outcome = outcome;
    this.#flush({ snapshot: enc.state, status: 'ended', outcome });
    this.broker.cancelAll();
    this.#setStatus('encounter-over');
    this.#encounterEndedForRun(enc);
  }

  // ------------------------------------------------------ DM state edits

  /**
   * Apply one DM state command to `state` and broadcast what changed.
   * @returns {object} the new state
   */
  #applyCommand(state, cmd, rng, opts = {}) {
    try {
      return this.#applyCommandInner(state, cmd, rng, opts);
    } finally {
      this.fogBasis = null;
    }
  }

  #applyCommandInner(state, cmd, rng, { broadcast = true } = {}) {
    let next;
    this.fogBasis = { before: state, after: state };
    if (cmd.type === 'dm.seat.setController') {
      const p = cmd.payload;
      const e = state.entities[p.entityId];
      if (!e) throw new IntentError('E_INVALID_INTENT', 'unknown entity');
      let seatId = e.controller.seatId;
      if (p.controller === 'player') {
        const seat = this.seats.find(s => s.controllerParticipantId === p.memberId);
        if (!seat) throw new IntentError('E_INVALID_INTENT', 'that member holds no seat');
        seatId = seat.id;
      }
      next = clone(state);
      next.entities[p.entityId].controller = { type: p.controller, seatId };
    } else {
      try {
        next = this.engine.applyDmCommand(state, cmd, { emit: (ev) => this.#emit(ev), rng }).state;
      } catch (err) {
        if (err instanceof ReplayDivergence) throw err;
        throw new IntentError(err.code === 'E_INVALID_INTENT' ? 'E_INVALID_INTENT' : 'E_INTERNAL', err.message);
      }
    }
    const v = validateEncounterState(next);
    if (!v.ok) throw new IntentError('E_INVALID_INTENT', `edit would leave an invalid state: ${v.errors[0].path} ${v.errors[0].message}`);
    this.fogBasis = { before: state, after: next };
    const seenBefore = this.#fogVisibleIn(state);
    const seenAfter = this.#fogVisibleIn(next);
    let structural = false;
    // Every dm.override first, then every entity.updated (E2's client order).
    const updates = [];
    for (const id of new Set([...Object.keys(state.entities), ...Object.keys(next.entities)])) {
      const a = state.entities[id];
      const b = next.entities[id];
      if (!a || !b) { structural = true; continue; }
      const patch = {};
      const before = {};
      for (const f of PATCH_FIELDS) {
        if (same(patchValue(a, f), patchValue(b, f))) continue;
        patch[f] = clone(patchValue(b, f));
        before[f] = clone(patchValue(a, f)) ?? null;
      }
      if (Object.keys(patch).length) {
        this.#emit({ type: 'dm.override', payload: { kind: cmd.type.slice(3), entityId: id, before, after: patch } });
        if (broadcast) updates.push({ id, patch });
      }
    }
    for (const { id, patch } of updates) {
      let player;
      if (seenAfter) {
        const va = seenBefore(id);
        const vb = seenAfter(id);
        if (va !== vb) this.fogResnap = true;   // crossed the fog edge: re-baseline players
        if (!va || !vb) player = null;
      }
      this.#broadcastRoom('entity.updated', { entityId: id, patch, cause: 'dm' }, player);
    }
    if (structural) this.#emit({ type: 'dm.override', payload: { kind: cmd.type.slice(3), entityId: cmd.payload.entityId ?? null, before: null, after: null } });
    if (!same(state.initiative, next.initiative) && broadcast) this.#broadcastInitiative(next);
    if (!same(state.grid, next.grid)) structural = true;
    // Fog brush: every seat gets the new bitset; player seats' projections
    // (entities, initiative rows and terrain under fog) change, so they
    // re-baseline with a snapshot after the flush.
    if (next.fog && !same(state.fog ?? null, next.fog) && broadcast) {
      this.#broadcastRoom('encounter.fog', { fog: clone(next.fog) });
      this.fogResnap = true;
    }
    if (structural && broadcast) this.pushSnapshots = true;
    return next;
  }

  /** Between turns (or paused / setup): apply to the authoritative state and snapshot. */
  #applyNow(cmd) {
    const enc = this.enc;
    const rng = createRng(enc.state.rng);
    const next = this.#applyCommand(enc.state, cmd, rng);
    next.rng = rng.state();
    next.lastEventSeq = this.lastEventSeq;
    enc.state = next;
    this.#flush({ snapshot: next });
    this.#maybePushSnapshots();
  }

  #maybePushSnapshots() {
    if (!this.pushSnapshots) return;
    this.pushSnapshots = false;
    for (const m of this.members.values()) if (m.conn) this.#sendSnapshot(m);
  }

  #drainDmQueue() {
    const q = this.dmQueue;
    this.dmQueue = [];
    for (const { cmd, memberId } of q) {
      try {
        if (cmd.type === 'dm.turn.skip') continue;
        this.#applyNow(cmd);
      } catch (err) {
        const m = this.members.get(memberId);
        if (m) this.#sendPrivate(m, 'error', { cid: null, code: err.code || 'E_INTERNAL', message: `queued ${cmd.type} failed: ${err.message}` });
      }
    }
  }

  // ---------------------------------------------------------- control lane

  /**
   * Handle a validated, authenticated client message. Serialised per room;
   * replies (ack / error) go to the sending connection. Duplicate cids get
   * the cached reply and change nothing.
   * @param {Conn} conn
   * @param {string} memberId
   * @param {{t: string, cid: string, p: object}} msg
   * @returns {Promise<void>}
   */
  handle(conn, memberId, msg) {
    this.control = this.control.then(() => this.#process(conn, memberId, msg)).catch((err) => {
      this.log('error', 'room: control lane failure', { roomId: this.id, error: err.message });
    });
    return this.control;
  }

  async #process(conn, memberId, msg) {
    const m = this.members.get(memberId);
    if (!m) return;
    const cached = m.cids.get(msg.cid);
    if (cached) { conn.sendRaw(JSON.stringify(cached)); return; }
    let reply;
    try {
      const extra = await this.#dispatch(m, conn, msg);
      reply = this.#message('ack', { cid: msg.cid, ok: true, ...(extra || {}) });
    } catch (err) {
      const known = err instanceof IntentError || err instanceof RoomError || err?.runIntentError === true;
      if (!known) this.log('error', 'room: intent failed', { roomId: this.id, t: msg.t, error: err.message, stack: err.stack });
      const code = err instanceof RoomError ? mapRoomErrorCode(err.code) : (known ? err.code : 'E_INTERNAL');
      reply = this.#message('error', {
        cid: msg.cid, code, message: known ? err.message : 'internal error',
        ...(err?.runIntentError && err.details ? { details: err.details } : {})
      });
    }
    m.cids.set(msg.cid, reply);
    if (m.cids.size > CID_CACHE_SIZE) m.cids.delete(m.cids.keys().next().value);
    conn.sendRaw(JSON.stringify(reply));
  }

  async #dispatch(m, conn, msg) {
    const role = INTENT_ROLES[msg.t];
    if (role === 'dm' && m.role !== 'dm') throw new IntentError('E_FORBIDDEN', `${msg.t} is DM-only`);
    if (role === 'player' && m.role !== 'player') throw new IntentError('E_FORBIDDEN', `${msg.t} is for players`);
    if (this.closing) throw new IntentError('E_STALE', 'the server is restarting');
    const p = msg.p;
    const auth = { participantId: m.id, roomId: this.id, role: m.role, displayName: m.displayName };

    if (STATE_COMMANDS.has(msg.t)) return this.#stateCommand(m, { type: msg.t, payload: p });
    if (this.run?.handles(msg.t)) return this.run.handle(m, msg.t, p);

    switch (msg.t) {
      case 'hello': throw new IntentError('E_BAD_MESSAGE', 'already authenticated');
      case 'resync': this.#sendSnapshot(m); this.run?.sendSnapshot(m); return {};
      case 'cinema.done': this.#cinemaDone(m.id, p.exchangeId); return {};

      case 'seat.claim': {
        const mine = this.seats.find(s => s.characterId === p.characterId && (!s.controllerParticipantId || s.controllerParticipantId === m.id));
        let n = mine?.seat;
        if (!n) {
          const taken = new Set(this.seats.map(s => s.seat));
          for (let k = 1; k <= MAX_SEATS && !n; k++) if (!taken.has(k)) n = k;
        }
        if (!n) throw new IntentError('E_ROOM_FULL', 'no free seat');
        const seat = this.service.claimSeat(auth, this.id, n, { characterId: p.characterId });
        return { seat: seat.seat };
      }
      case 'seat.release': {
        const s = this.seats.find(x => x.characterId === p.characterId && x.controllerParticipantId === m.id);
        if (!s) throw new IntentError('E_INVALID_INTENT', 'you hold no seat with that character');
        this.service.releaseSeat(auth, this.id, s.seat);
        return {};
      }
      case 'char.setStyle': {
        if (!this.seats.some(s => s.characterId === p.characterId && s.controllerParticipantId === m.id)) {
          throw new IntentError('E_FORBIDDEN', 'not your character');
        }
        this.styles.set(p.characterId, { style: p.style, swing: p.swing });
        return {};
      }

      case 'turn.act':
      case 'turn.delegate': {
        const aw = this.turn?.awaiting;
        if (!aw || this.turn.turnId !== p.turnId) throw new IntentError('E_STALE', 'that turn is not waiting for an action');
        if (aw.ownerId !== m.id) throw new IntentError('E_NOT_YOUR_TURN', 'not your turn');
        if (msg.t === 'turn.delegate') { aw.resolve({ kind: 'delegate' }); return {}; }
        const v = this.engine.validateIntent(aw.state, { actorId: aw.actorId, plan: p.plan });
        if (!v.ok) {
          this.#emit({ type: 'turn.rejected', payload: { actorId: aw.actorId, reason: v.reason, code: v.code } });
          this.#flush();
          throw new IntentError('E_INVALID_INTENT', v.reason);
        }
        aw.resolve({ kind: 'plan', plan: clone(p.plan) });
        return {};
      }

      case 'prompt.answer': {
        const r = this.broker.answer(m.id, p.promptId, p.answer);
        if (r === 'ok') return {};
        if (r === 'stale') throw new IntentError('E_STALE', 'that prompt is closed');
        if (r === 'forbidden') throw new IntentError('E_FORBIDDEN', 'that prompt is not yours');
        throw new IntentError('E_INVALID_INTENT', 'bad answer for that prompt');
      }

      // In a run, setup / start act on the begun encounter node (dm.node.begin);
      // anywhere else in the run they are refused with E_NODE_NOT_BEGUN.
      case 'dm.encounter.setup':
        if (this.run?.active) return this.run.setupInRun(p);
        return this.#setup(p);
      case 'dm.encounter.start':
        if (this.run?.active) { this.run.assertBegun(); return this.#start({}); }
        return this.#start(p);
      case 'dm.encounter.end': {
        if (!this.enc || (this.enc.status !== 'setup' && this.enc.status !== 'active')) throw new IntentError('E_INVALID_INTENT', 'no live encounter');
        const outcome = p.outcome || 'dm-ended';
        if (!this.turn) { this.#endEncounter(outcome); return {}; }
        this.endRequested = outcome;
        this.turn.awaiting?.resolve({ kind: 'skip' });
        this.broker.cancelAll();
        this.#endCinema();
        return { queued: true };
      }
      case 'dm.pause':
        if (!this.enc || this.enc.status !== 'active') throw new IntentError('E_INVALID_INTENT', 'no running encounter');
        this.paused = true;
        this.#setStatus('paused');
        return {};
      case 'dm.resume':
        if (!this.enc || this.enc.status !== 'active') throw new IntentError('E_INVALID_INTENT', 'no running encounter');
        this.paused = false;
        this.#setStatus('in-encounter');
        this.#startLoop();
        return {};
      case 'dm.turn.skip': {
        const aw = this.turn?.awaiting;
        if (!aw || (p.entityId && p.entityId !== aw.actorId)) throw new IntentError('E_STALE', 'only a turn waiting for an action can be skipped');
        aw.resolve({ kind: 'skip' });
        return {};
      }
      case 'dm.roll.arm':
        if (this.armedRolls.length >= 16) throw new IntentError('E_INVALID_INTENT', 'too many armed rolls');
        this.armedRolls.push({ entityId: p.entityId ?? null, rollKind: p.rollKind, value: p.value });
        return { armed: this.armedRolls.length };
      case 'dm.review.set':
        for (const k of ['plans', 'rolls', 'monsterReactions']) if (typeof p[k] === 'boolean') this.review[k] = p[k];
        return { review: { ...this.review } };
      case 'dm.prompt.force': {
        const r = this.broker.force(p.promptId, p.answer);
        if (r === 'stale') throw new IntentError('E_STALE', 'that prompt is closed');
        if (r === 'invalid') throw new IntentError('E_INVALID_INTENT', 'bad answer for that prompt');
        return {};
      }
      case 'dm.member.revoke':
        this.service.kick(auth, this.id, p.memberId);
        return {};
      case 'dm.room.settings': return this.#updateSettings(p);
      default:
        throw new IntentError('E_UNKNOWN_TYPE', `unhandled ${msg.t}`);
    }
  }

  #stateCommand(m, cmd) {
    if (!this.enc || this.enc.status === 'ended') throw new IntentError('E_INVALID_INTENT', 'no live encounter');
    // Token images must be this room's uploads (PUT /api/rooms/:id/maps?kind=token).
    const img = cmd.type === 'dm.entity.patch' ? cmd.payload.imageUrl : null;
    if (typeof img === 'string' && !img.startsWith(`/api/maps/${this.id}/`)) throw new IntentError('E_INVALID_INTENT', 'imageUrl must be an image uploaded to this room');
    const aw = this.turn?.awaiting;
    if (!this.turn) {
      this.#applyNow(cmd);
      return {};
    }
    if (aw && INTENT_SAFE.has(cmd.type)) {
      aw.state = this.#applyCommand(aw.state, cmd, this.turn.rng);
      this.turn.fogMoves.clear();   // aw.state is current again
      aw.commands.push(clone(cmd));
      this.enc.liveState = clone(aw.state);
      this.#flush();
      this.#maybePushSnapshots();
      return {};
    }
    if (cmd.type.startsWith('dm.initiative.')) throw new IntentError('E_STALE', 'initiative can change only between turns');
    this.dmQueue.push({ cmd: clone(cmd), memberId: m.id });
    return { queued: true };
  }

  /**
   * dm.room.settings: merge, persist (rooms.settings_json), broadcast
   * `room.settings`. reactionTimeoutMs and fudgeVisibility apply at once;
   * importLiveState and diagonalRule on the next dm.encounter.setup.
   */
  #updateSettings(p) {
    if (Object.keys(p).length === 0) throw new IntentError('E_INVALID_INTENT', 'name at least one setting');
    const next = normalizeRoomSettings({ ...this.settings, ...p });
    this.store.setRoomSettings(this.id, next);
    this.settings = next;
    this.#broadcastRoom('room.settings', { settings: { ...next } });
    this.log('info', 'room: settings changed', { roomId: this.id, keys: Object.keys(p) });
    return { settings: { ...next } };
  }

  /**
   * Build an encounter in 'setup'. `run` (M65 B24, the run controller's
   * dm.node.begin) supplies the id, seed and run-state party, and links
   * the encounter row to its run and node.
   * @param {object} p  dm.encounter.setup payload
   * @param {{encounterId: string, seed: number, party: object[], runId: string, nodeId: string}|null} [run]
   */
  #setup(p, run = null) {
    if (this.enc && this.enc.status === 'active') throw new IntentError('E_INVALID_INTENT', 'an encounter is running; end it first');
    if (this.enc && this.enc.status === 'setup') this.journal.setStatus(this.enc.id, 'abandoned', null);
    const encounterId = run?.encounterId ?? newId('e_');
    const party = run?.party ?? this.seats.filter(s => s.characterId).map(s => ({
      slotId: s.id, seat: s.seat, characterId: s.characterId, characterName: s.characterName,
      controller: this.#seatController(s), aiArchetype: s.aiArchetype, seed: s.seed
    }));
    let state;
    try {
      const settings = { importLiveState: !run && this.settings.importLiveState === true, diagonalRule: this.settings.diagonalRule };
      state = this.engine.buildEncounter({ encounterId, seed: run?.seed ?? randomInt(0, 0x100000000), setup: clone(p), party, settings });
    } catch (err) {
      throw new IntentError('E_INVALID_INTENT', `setup rejected: ${err.message}`);
    }
    if (run) {
      state.runId = run.runId;
      state.nodeId = run.nodeId;
    }
    const v = validateEncounterState(state);
    if (!v.ok) throw new IntentError('E_INVALID_INTENT', `setup produced an invalid state: ${v.errors[0].path} ${v.errors[0].message}`);
    // The PC sheets ride with the encounter row (never with a broadcast) so
    // boot recovery does not depend on the seats or the character cache.
    const sheets = typeof this.engine.sheetsFor === 'function' ? this.engine.sheetsFor(state) : null;
    this.journal.createEncounter({ roomId: this.id, encounterId, state, engineVersion: this.engine.version, sheets, runId: run?.runId ?? null, nodeId: run?.nodeId ?? null });
    this.enc = { id: encounterId, state, status: 'setup', liveState: null, history: [], outcome: null };
    this.lastEventSeq = 0;
    this.store.setRoomStatus(this.id, 'active');
    // One broadcast for every seat, so it carries the player projection;
    // under fog the DM also gets its unfiltered snapshot.
    this.#broadcastRoom('encounter.created', { encounterId, encounter: publicView(state) });
    this.#setStatus('setup');
    if (state.fog && this.dm?.conn) this.#sendSnapshot(this.dm);
    // The builder's "fights as" line: the preset is the sprite; `source`
    // says whether the real (normalised SRD) stat block is in use.
    const monsters = Object.values(state.entities).filter(e => e.kind === 'monster').map(e => ({
      id: e.id, name: e.name, preset: e.statBlock?.slug ?? null, source: e.statBlock?.source ?? null,
      ac: e.ac, hpMax: e.hpMax, attacks: (e.statBlock?.attacks || []).map(a => ({ name: a.name, bonus: a.bonus, dice: a.dice }))
    }));
    return { encounterId, monsters };
  }

  async #start(p) {
    if (!this.enc || this.enc.status !== 'setup') throw new IntentError('E_INVALID_INTENT', 'set up an encounter first');
    const enc = this.enc;
    const base = clone(enc.state);
    if (p.seed !== undefined) base.rng = { algo: 'mulberry32', s: p.seed >>> 0 };
    const rng = createRng(base.rng);
    const res = await this.engine.startEncounter(base, { emit: (ev) => this.#emit(ev), rng });
    const next = clone(res.state);
    next.rng = rng.state();
    next.lastEventSeq = this.lastEventSeq;
    const v = validateEncounterState(next);
    if (!v.ok) throw new IntentError('E_INTERNAL', `engine start produced an invalid state: ${v.errors[0].path} ${v.errors[0].message}`);
    enc.state = next;
    enc.status = 'active';
    this.#broadcastInitiative(next);
    this.#broadcastRoom('round.started', { round: next.round });
    this.#flush({ snapshot: next, status: 'active' });
    this.paused = false;
    this.#setStatus('in-encounter');
    this.#startLoop();
    return {};
  }

  // ----------------------------------------------------------- lifecycle

  /** Resume a recovered (paused) room's turn lane without a DM (tests, tooling). */
  resume() {
    if (!this.enc || this.enc.status !== 'active') return;
    this.paused = false;
    this.#setStatus('in-encounter');
    this.#startLoop();
  }

  /**
   * Graceful shutdown (B9): stop intents, persist what is buffered, then
   * close every socket with `code`. An in-flight turn is left to boot
   * recovery (its events and answers are already durable).
   * @param {number} [code=1012]
   */
  shutdown(code = CLOSE_CODES.RESTARTING) {
    if (this.closing) return;
    try {
      if (this.socketCount) this.#broadcastRoom('room.closing', { reason: 'server restarting' });
      if (!this.turnEndBuffered) this.#flush({ final: true });
    } catch (err) {
      this.log('error', 'room: final flush failed', { roomId: this.id, error: err.message });
    }
    this.closing = true;
    if (this.flushTimer) { clearImmediate(this.flushTimer); this.flushTimer = null; }
    for (const e of this.broker.open.values()) this.clearTimer(e.timer);
    this.broker.open.clear();
    if (this.cinemaWait) { this.clearTimer(this.cinemaWait.timer); this.cinemaWait = null; }
    for (const m of this.members.values()) {
      if (m.conn) { const c = m.conn; m.conn = null; c.close(code, 'server restarting'); }
    }
  }
}

/**
 * Payload minus fields that legitimately differ on replay: the hash
 * (filled later), the prompt deadline, and the seat's cinema style /
 * swing (in-memory seat state, lost on restart).
 */
function stripVolatile(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const { stateHash: _h, deadlineMs: _d, ...rest } = payload;
  if (rest.cinema && typeof rest.cinema === 'object') {
    const { style: _s, swing: _w, ...cinema } = rest.cinema;
    rest.cinema = cinema;
  }
  return rest;
}

function mapRoomErrorCode(code) {
  if (code === 'E_SEAT_TAKEN' || code === 'E_ROOM_FULL' || code === 'E_FORBIDDEN') return code;
  if (code === 'UNAUTHENTICATED') return 'E_UNAUTHENTICATED';
  return 'E_INVALID_INTENT';
}
