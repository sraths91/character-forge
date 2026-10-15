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
 * `room.snapshot` replaces both copies. Late joiners get the snapshot and
 * no cinema backlog. Every inbound message is validated with the shared
 * protocol contract; invalid ones are ignored and counted.
 *
 * Pure and Node-testable: no DOM, no timers, no storage. State objects
 * are replaced, never mutated, so selectors can compare by identity.
 */

import { validateServerMessage, SERVER_MESSAGE_SCOPE } from '../shared/protocol.js';
import { EVENT_TYPES } from '../shared/events.js';
import { validateEncounterState } from '../shared/encounter-state.js';

const EVENT_SET = new Set(EVENT_TYPES);
const HISTORY_LIMIT = 50;
/** Entity fields an `entity.updated` patch may replace. */
const PATCHABLE = new Set(['name', 'controller', 'pos', 'hp', 'hpMax', 'hpTemp', 'ac', 'speedFt', 'conditions', 'concentration']);

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

/** 32-bit FNV-1a over a string, as 8 lowercase hex chars. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const conditionId = (c) => (typeof c === 'string' ? c : c?.id);

/**
 * Hash of the client-visible encounter: per entity (sorted by id) its
 * hp, position and condition ids (sorted). Everything a client can track
 * from events alone. The server must emit the same function over the
 * projected state in `turn.ended.stateHash` for the check to hold.
 * @param {object|null} encounter — projected EncounterState
 * @returns {string} 8 hex chars
 */
export function viewStateHash(encounter) {
  const ents = Object.values(encounter?.entities || {})
    .map(e => [e.id, e.hp, e.pos?.col ?? null, e.pos?.row ?? null,
      (e.conditions || []).map(conditionId).sort()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return fnv1a(JSON.stringify(ents));
}

function patchEntity(enc, id, patch) {
  const e = enc?.entities?.[id];
  if (!e) return enc;
  return { ...enc, entities: { ...enc.entities, [id]: { ...e, ...patch } } };
}

/**
 * Apply one engine event to a projected EncounterState. Pure. Covers the
 * client-visible fields (hp, position, conditions, concentration, round,
 * turn, phase); resource ledgers refresh with the next snapshot.
 * @param {object|null} enc
 * @param {object} ev — events.js event
 * @returns {object|null}
 */
export function applyEventToEncounter(enc, ev) {
  if (!enc) return enc;
  const p = ev.payload || {};
  let next = enc;
  switch (ev.type) {
    case 'turn.started': {
      const idx = (next.initiative || []).findIndex(r => r.entityId === p.actorId);
      next = { ...next, phase: 'running', ...(idx >= 0 ? { turnIndex: idx } : {}) };
      break;
    }
    case 'move':
      next = patchEntity(next, p.actorId, { pos: { col: p.to.col, row: p.to.row } });
      break;
    case 'damage':
    case 'heal':
      next = patchEntity(next, p.targetId, { hp: p.hpAfter });
      break;
    case 'exchange':
      for (const eff of p.effects || []) next = patchEntity(next, eff.entityId, { hp: eff.hp.after });
      break;
    case 'condition.applied': {
      const e = next.entities?.[p.entityId];
      if (e && !(e.conditions || []).some(c => conditionId(c) === p.condition)) {
        next = patchEntity(next, p.entityId, { conditions: [...(e.conditions || []), p.condition] });
      }
      break;
    }
    case 'condition.removed': {
      const e = next.entities?.[p.entityId];
      if (e) next = patchEntity(next, p.entityId, { conditions: (e.conditions || []).filter(c => conditionId(c) !== p.condition) });
      break;
    }
    case 'concentration.started':
      next = patchEntity(next, p.casterId, {
        concentration: { spellId: p.spellId, targetIds: Array.isArray(p.targetIds) ? [...p.targetIds] : [] }
      });
      break;
    case 'concentration.broken':
      next = patchEntity(next, p.casterId, { concentration: null });
      break;
    case 'encounter.ended':
      next = { ...next, phase: 'ended' };
      break;
    default:
      break;
  }
  const round = ev.round > next.round ? ev.round : next.round;
  return { ...next, round, lastEventSeq: ev.seq };
}

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
    next = { ...next, history, encounter: applyEventToEncounter(s.encounter, p) };
    if (msg.t === 'exchange') next.lastExchange = p;
    return next;
  }
  switch (msg.t) {
    case 'member.joined':
      return { ...next, members: { ...s.members, [p.memberId]: { memberId: p.memberId, displayName: p.displayName, online: true } } };
    case 'member.left': {
      const members = { ...s.members };
      delete members[p.memberId];
      return { ...next, members };
    }
    case 'member.presence': {
      const m = s.members[p.memberId] || { memberId: p.memberId };
      return { ...next, members: { ...s.members, [p.memberId]: { ...m, online: p.online } } };
    }
    case 'seat.updated':
      return { ...next, seats: { ...s.seats, [p.characterId]: { memberId: p.memberId, controller: p.controller } } };
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
      return { ...next, encounter: { ...s.encounter, round: p.round } };
    case 'entity.updated': {
      const raw = { ...p.patch };
      if (raw.position && !raw.pos) raw.pos = raw.position;
      const patch = Object.fromEntries(Object.entries(raw).filter(([k]) => PATCHABLE.has(k)));
      return { ...next, encounter: patchEntity(s.encounter, p.entityId, patch) };
    }
    case 'room.status':
      return { ...next, room: { ...(s.room || {}), status: p.status } };
    case 'room.closing':
      return { ...next, room: { ...(s.room || {}), closing: p.reason } };
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
 *     check (default viewStateHash; null disables the check).
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
  const hashState = opts.hashState === undefined ? viewStateHash : opts.hashState;
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
