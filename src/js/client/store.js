/**
 * M64 C6 — client state store (server-state mirror).
 *
 * Two copies of the room state:
 *   authoritative — the server's truth: the last `room.snapshot` plus
 *                   every sequenced broadcast applied in `seq` order.
 *   presented     — what the screen shows. It trails authoritative by
 *                   the broadcasts the playback queue (C8) has not yet
 *                   dramatized; `presentUpTo(seq)` advances it.
 *
 * Ordering (R1 §3.3): broadcasts carry a room-monotonic, gap-free `seq`
 * (a `redacted` broadcast fills any hole `viewFor` makes). A duplicate or
 * older `seq` is ignored; a gap, an unexpected encounter, or a
 * `turn.ended.stateHash` that does not match this model asks for a
 * resync (`onResyncNeeded`) and drops broadcasts until the next
 * `room.snapshot` replaces both copies. The mirror (mirror.js) replays
 * the engine's bookkeeping, so the shared `stateHash` check is ON by
 * default (M64 phase 1.5); a mismatch is a bug report, the resync the
 * safety net. Late joiners get the snapshot and
 * no cinema backlog. Every inbound message is validated with the shared
 * protocol contract; invalid ones are ignored and counted.
 *
 * Pure and Node-testable: no DOM, no timers, no storage. State objects
 * are replaced, never mutated, so selectors can compare by identity.
 */

import { validateServerMessage, SERVER_MESSAGE_SCOPE } from '../shared/protocol.js';
import { EVENT_TYPES } from '../shared/events.js';
import { validateEncounterState } from '../shared/encounter-state.js';
import { stateHash } from '../shared/state-hash.js';
import { applyEventToEncounter, applyEntityPatch } from './mirror.js';

const EVENT_SET = new Set(EVENT_TYPES);
const HISTORY_LIMIT = 50;

/**
 * @typedef {object} ClientState
 * @property {boolean} synced          — a room.snapshot has been applied
 * @property {number} seq              — last applied broadcast seq
 * @property {object|null} me          — hello.ok payload ({memberId, role, seats, serverNow, cfg})
 * @property {object|null} room
 * @property {object|null} encounter   — projected EncounterState (shared/encounter-state.js)
 * @property {Record<string, {memberId: string, displayName?: string, online: boolean}>} members
 * @property {Record<string, {memberId: string|null, controller: string}>} seats
 * @property {object|null} openPrompt  — the open prompt.open payload for this member
 * @property {object|null} planProposed — DM: the last turn.planProposed payload
 * @property {object|null} lastExchange — the last `exchange` event
 * @property {object[]} history        — recent engine events (capped)
 */

/** @returns {ClientState} */
export function initialClientState() {
  return {
    synced: false,
    seq: 0,
    me: null,
    room: null,
    encounter: null,
    members: {},
    seats: {},
    openPrompt: null,
    planProposed: null,
    lastExchange: null,
    history: []
  };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export { applyEventToEncounter };
/**
 * Apply one validated sequenced broadcast to a ClientState. Pure.
 * @param {ClientState} s
 * @param {object} msg — server message {t, seq, p}
 * @returns {ClientState}
 */
function reduceBroadcast(s, msg) {
  const p = msg.p;
  let next = { ...s, seq: msg.seq };
  if (EVENT_SET.has(msg.t)) {
    const history = [...s.history, p];
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    const prev = s.history.length ? s.history[s.history.length - 1] : null;
    next = { ...next, history, encounter: applyEventToEncounter(s.encounter, p, { prev }) };
    if (msg.t === 'exchange') next.lastExchange = p;
    return next;
  }
  switch (msg.t) {
    case 'member.joined':
      return { ...next, members: { ...s.members, [p.memberId]: { memberId: p.memberId, displayName: p.displayName, online: true, ...(p.role ? { role: p.role } : {}) } } };
    case 'member.left': {
      const members = { ...s.members };
      delete members[p.memberId];
      const room = s.room && Array.isArray(s.room.members)
        ? { ...s.room, members: s.room.members.filter(m => m.id !== p.memberId) }
        : s.room;
      return { ...next, members, room };
    }
    case 'member.presence': {
      const m = s.members[p.memberId] || { memberId: p.memberId };
      return { ...next, members: { ...s.members, [p.memberId]: { ...m, online: p.online } } };
    }
    case 'seat.updated': {
      // Extra fields (seat number, slot id, removed) are kept when the
      // server sends them, so selectors can overlay room.seats.
      const extra = {};
      if (Number.isInteger(p.seat)) extra.seat = p.seat;
      if (typeof p.slotId === 'string') extra.slotId = p.slotId;
      if (p.removed === true) extra.removed = true;
      return { ...next, seats: { ...s.seats, [p.characterId]: { memberId: p.memberId, controller: p.controller, ...extra } } };
    }
    case 'encounter.created':
      return {
        ...next,
        room: { ...(s.room || {}), encounterId: p.encounterId },
        encounter: p.encounter && validateEncounterState(p.encounter, { projected: true }).ok ? p.encounter : null,
        lastExchange: null,
        history: []
      };
    case 'encounter.initiative':
      if (!s.encounter) return next;
      return { ...next, encounter: { ...s.encounter, initiative: p.order.map(r => ({ entityId: r.entityId, score: r.score })) } };
    case 'round.started':
      if (!s.encounter) return next;
      // dm.encounter.start: round 1, first initiative slot, running.
      return {
        ...next,
        encounter: s.encounter.phase === 'setup'
          ? { ...s.encounter, round: p.round, turnIndex: 0, phase: 'running' }
          : { ...s.encounter, round: p.round }
      };
    case 'entity.updated':
      return { ...next, encounter: applyEntityPatch(s.encounter, p.entityId, p.patch) };
    case 'room.status':
      return { ...next, room: { ...(s.room || {}), status: p.status } };
    case 'room.closing':
      return { ...next, room: { ...(s.room || {}), closing: p.reason } };
    case 'room.settings':
      return { ...next, room: { ...(s.room || {}), settings: { ...(s.room?.settings || {}), ...p.settings } } };
    default:   // redacted and anything else: seq only
      return next;
  }
}

function reducePrivate(s, msg) {
  const p = msg.p;
  switch (msg.t) {
    case 'hello.ok': return { ...s, me: p };
    case 'prompt.open': return { ...s, openPrompt: p };
    case 'prompt.closed':
      return s.openPrompt && s.openPrompt.promptId === p.promptId ? { ...s, openPrompt: null } : s;
    case 'turn.planProposed': return { ...s, planProposed: p };
    default: return s;   // ack / error belong to the ws client
  }
}

function stateFromSnapshot(base, p) {
  return {
    ...base,
    synced: true,
    seq: p.seq,
    room: p.room,
    // The snapshot's room carries the full member and seat lists; the
    // incremental overlays restart from it.
    members: {},
    seats: {},
    encounter: p.encounter ?? null,
    openPrompt: p.openPrompt ?? null,
    lastExchange: null,
    history: p.history.slice(-HISTORY_LIMIT)
  };
}

/**
 * Create a client store.
 *
 * @param {{hashState?: ((encounter: object) => string)|null}} [opts]
 *   — `hashState` computes this model's hash for the `turn.ended`
 *     check (default: the shared `stateHash`, the function the server
 *     stamps; null disables the check).
 * @returns {{
 *   getState: () => ClientState,
 *   getPresented: () => ClientState,
 *   getPending: () => object[],
 *   getStats: () => {applied: number, invalid: number, duplicate: number, gap: number, dropped: number, hashMismatch: number, resyncs: number},
 *   apply: (serverMessage: object|string) => ('applied'|'ignored'|'invalid'|'duplicate'|'gap'|'dropped'),
 *   presentUpTo: (seq: number) => number,
 *   subscribe: (selector: (auth: ClientState, presented: ClientState) => unknown, fn: (next: unknown, prev: unknown) => void, equals?: (a: unknown, b: unknown) => boolean) => () => void,
 *   onResyncNeeded: (fn: (info: {reason: string, lastSeq: number, expected?: number, got?: number}) => void) => () => void
 * }}
 */
export function createStore(opts = {}) {
  const hashState = opts.hashState === undefined ? stateHash : opts.hashState;
  let auth = initialClientState();
  let presented = auth;
  let pending = [];          // broadcasts applied to auth but not yet presented
  let awaitingResync = false;
  const stats = { applied: 0, invalid: 0, duplicate: 0, gap: 0, dropped: 0, hashMismatch: 0, resyncs: 0 };
  const subs = new Set();
  const resyncListeners = new Set();

  function notify() {
    for (const sub of [...subs]) {
      if (!subs.has(sub)) continue;
      const v = sub.selector(auth, presented);
      if (sub.equals(v, sub.last)) continue;
      const prev = sub.last;
      sub.last = v;
      sub.fn(v, prev);
    }
  }

  function needResync(info) {
    if (awaitingResync) return;
    awaitingResync = true;
    stats.resyncs++;
    const payload = { ...info, lastSeq: auth.seq };
    for (const fn of [...resyncListeners]) fn(payload);
  }

  function applyBroadcast(msg) {
    if (!auth.synced) { stats.dropped++; return 'dropped'; }
    if (msg.seq <= auth.seq) { stats.duplicate++; return 'duplicate'; }
    if (awaitingResync) { stats.dropped++; return 'dropped'; }
    if (msg.seq !== auth.seq + 1) {
      stats.gap++;
      needResync({ reason: 'gap', expected: auth.seq + 1, got: msg.seq });
      return 'gap';
    }
    auth = reduceBroadcast(auth, msg);
    pending.push(msg);
    stats.applied++;
    if (msg.t === 'encounter.created' && !auth.encounter) {
      needResync({ reason: 'encounter-created' });
    } else if (msg.t === 'turn.ended' && hashState && auth.encounter &&
        typeof msg.p.payload.stateHash === 'string' &&
        hashState(auth.encounter) !== msg.p.payload.stateHash) {
      stats.hashMismatch++;
      needResync({ reason: 'state-hash' });
    }
    return 'applied';
  }

  return {
    getState: () => auth,
    getPresented: () => presented,
    getPending: () => pending.slice(),
    getStats: () => ({ ...stats }),

    apply(serverMessage) {
      let msg = serverMessage;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch { stats.invalid++; return 'invalid'; }
      }
      if (!validateServerMessage(msg).ok) { stats.invalid++; return 'invalid'; }
      msg = clone(msg);
      let result;
      if (msg.t === 'room.snapshot') {
        if (auth.synced && msg.p.seq < auth.seq && !awaitingResync) {
          stats.duplicate++;
          return 'duplicate';
        }
        auth = stateFromSnapshot(auth, msg.p);
        presented = stateFromSnapshot(presented, msg.p);
        pending = [];
        awaitingResync = false;
        stats.applied++;
        result = 'applied';
      } else if (SERVER_MESSAGE_SCOPE[msg.t] === 'broadcast') {
        result = applyBroadcast(msg);
      } else {
        const a = reducePrivate(auth, msg);
        if (a === auth) return 'ignored';
        auth = a;
        presented = reducePrivate(presented, msg);
        stats.applied++;
        result = 'applied';
      }
      if (result === 'applied') notify();
      return result;
    },

    presentUpTo(seq) {
      let n = 0;
      while (pending.length && pending[0].seq <= seq) {
        presented = reduceBroadcast(presented, pending.shift());
        n++;
      }
      if (n) notify();
      return n;
    },

    subscribe(selector, fn, equals = Object.is) {
      const sub = { selector, fn, equals, last: selector(auth, presented) };
      subs.add(sub);
      return () => { subs.delete(sub); };
    },

    onResyncNeeded(fn) {
      resyncListeners.add(fn);
      return () => { resyncListeners.delete(fn); };
    }
  };
}
