/**
 * M65 C23 — the client's run slice (protocol v1.6): a campaign run as this
 * viewer may see it, kept apart from the room store (client/store.js) so
 * the between-node screens never touch the encounter mirror.
 *
 * Inputs (the session hands every server message to both stores):
 *   run.snapshot   private — the viewer's projection: run row, nodes
 *                  (visited for players, all for the DM), the edges on
 *                  offer, characters, items, level-ups. Replaces the slice
 *                  and ends any resync wait.
 *   run.event      broadcast — one run event (run-events.js catalogue v1).
 *                  Ordered by the RUN seq (`p.seq`), not the room seq: a
 *                  duplicate or older run seq is ignored; a gap (or any
 *                  event before the first snapshot) asks for a resync and
 *                  drops run events until the next `run.snapshot`.
 *   run.updated    broadcast — status / current node / `runSeq`; a `runSeq`
 *                  ahead of this slice is a gap too.
 *   levelup.offer  private — a pending level-up for one of my seats.
 *
 * Visibility: `visitedIds` is what a player's run map may name. It comes
 * from `run.visitedNodeIds` when the snapshot carries it, else per-node
 * `visited` flags, else (players) every node the server sent; `node.entered`
 * events and the current node add to it. Views never render a title
 * outside it for players (views/run-map.js).
 *
 * Pure and Node-testable: no DOM, no timers. State objects are replaced,
 * never mutated, so selectors compare by identity.
 */

import { validateServerMessage } from '../shared/protocol.js';

const LOG_LIMIT = 200;
const RUN_TYPES = new Set(['run.snapshot', 'run.event', 'run.updated', 'levelup.offer']);

/**
 * @typedef {object} RunState
 * @property {boolean} synced          — a run.snapshot has been applied
 * @property {string|null} runId
 * @property {string|null} campaignId  — the run's campaign (snapshot `run.campaignId`, `run.started`)
 * @property {string|null} status      — run-state.js RUN_STATUSES
 * @property {string|null} outcome
 * @property {string|null} currentNodeId
 * @property {number} seq              — last applied run event seq
 * @property {object[]} nodes          — snapshot nodes ({id, kind, title, …})
 * @property {string[]} visitedIds     — in visit order
 * @property {object[]} edges          — edges on offer now ({to, label?, when?})
 * @property {object[]} characters     — {slotId, seat, level, xp, lifeStatus, state?}
 * @property {object[]} items
 * @property {object[]} levelUps       — {id, slotId, status, …}
 * @property {Record<string, object>} offers — levelup.offer payloads by levelUpId
 * @property {object[]} log            — recent run events (capped)
 */

/** @returns {RunState} */
export function initialRunState() {
  return {
    synced: false, runId: null, campaignId: null, status: null, outcome: null, currentNodeId: null, seq: 0,
    nodes: [], visitedIds: [], edges: [], characters: [], items: [], levelUps: [], offers: {}, log: []
  };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function addVisited(list, id) {
  return typeof id === 'string' && id && !list.includes(id) ? [...list, id] : list;
}

/**
 * The visited node ids a run.snapshot implies (see the module note).
 * @param {object} p — run.snapshot payload
 * @param {{dm?: boolean}} [opts]
 * @returns {string[]}
 */
export function visitedFromSnapshot(p, { dm = false } = {}) {
  const nodes = Array.isArray(p?.nodes) ? p.nodes : [];
  let ids;
  if (Array.isArray(p?.run?.visitedNodeIds)) ids = p.run.visitedNodeIds.filter(x => typeof x === 'string');
  else if (nodes.some(n => isObj(n) && typeof n.visited === 'boolean')) ids = nodes.filter(n => n.visited === true).map(n => n.id);
  else ids = dm ? [] : nodes.map(n => n.id);
  return addVisited([...new Set(ids)], p?.run?.currentNodeId ?? null);
}

function fromSnapshot(base, p, dm) {
  return {
    ...base,
    synced: true,
    runId: p.run.id,
    campaignId: typeof p.run.campaignId === 'string' ? p.run.campaignId : (p.run.id === base.runId ? base.campaignId : null),
    status: p.run.status,
    outcome: p.run.outcome ?? null,
    currentNodeId: p.run.currentNodeId ?? null,
    seq: p.run.seq,
    nodes: p.nodes,
    visitedIds: visitedFromSnapshot(p, { dm }),
    edges: p.edges,
    characters: p.characters,
    items: p.items,
    levelUps: p.levelUps
  };
}

function patchCharacter(chars, slotId, patch) {
  let hit = false;
  const out = chars.map((c) => {
    if (c.slotId !== slotId) return c;
    hit = true;
    return { ...c, ...patch };
  });
  return hit ? out : chars;
}

/** Fold a `{[slotId]: value}` map into the characters through `fn(value) → patch`. */
function patchEach(chars, map, fn) {
  if (!isObj(map)) return chars;
  let out = chars;
  for (const [slotId, v] of Object.entries(map)) {
    const patch = fn(v);
    if (patch) out = patchCharacter(out, slotId, patch);
  }
  return out;
}

/**
 * Apply one run event to the slice. Pure; unknown effects only log.
 * @param {RunState} s
 * @param {object} ev — run event (validated)
 * @returns {RunState}
 */
export function reduceRunEvent(s, ev) {
  const p = ev.payload || {};
  const log = [...s.log, ev];
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  let next = { ...s, seq: ev.seq, log };
  switch (ev.type) {
    case 'run.started':
      return { ...next, campaignId: p.campaignId ?? next.campaignId, status: 'in-node', currentNodeId: p.startNodeId, visitedIds: addVisited(next.visitedIds, p.startNodeId), edges: [] };
    case 'run.ended':
      return { ...next, status: 'ended', outcome: p.outcome, edges: [] };
    case 'node.entered':
      return { ...next, status: 'in-node', currentNodeId: p.nodeId, visitedIds: addVisited(next.visitedIds, p.nodeId), edges: [] };
    case 'node.completed':
      return { ...next, status: 'between' };
    case 'encounter.result':
    case 'rest.taken':
      return { ...next, characters: patchEach(next.characters, p.after, (st) => (isObj(st) ? { state: st } : null)) };
    case 'xp.awarded':
      return { ...next, characters: patchEach(next.characters, p.after, (xp) => (Number.isInteger(xp) ? { xp } : null)) };
    case 'level.queued':
      return next.levelUps.some(l => l.id === p.levelUpId)
        ? next
        : { ...next, levelUps: [...next.levelUps, { id: p.levelUpId, slotId: p.slotId, fromLevel: p.fromLevel, toLevel: p.toLevel, status: 'pending_player' }] };
    case 'level.applied':
    case 'level.reverted': {
      const applied = ev.type === 'level.applied';
      next = { ...next, characters: patchCharacter(next.characters, p.slotId, { level: applied ? p.toLevel : p.fromLevel }) };
      const levelUps = next.levelUps.map(l => (l.id === p.levelUpId ? { ...l, status: applied ? 'applied' : 'reverted' } : l));
      const offers = { ...next.offers };
      delete offers[p.levelUpId];
      return { ...next, levelUps, offers };
    }
    case 'character.died':
      return { ...next, characters: patchCharacter(next.characters, p.slotId, { lifeStatus: 'dead' }) };
    case 'character.revived':
      return { ...next, characters: patchCharacter(next.characters, p.slotId, { lifeStatus: p.lifeStatus }) };
    default:
      return next;
  }
}

/**
 * Create a run store.
 * @param {{isDm?: () => boolean}} [opts] — `isDm` tells the snapshot
 *   projection whether this viewer is the DM (a DM snapshot without
 *   visit marks implies only the current node is known visited)
 * @returns {{
 *   getState: () => RunState,
 *   getStats: () => {applied: number, invalid: number, duplicate: number, gap: number, dropped: number, resyncs: number},
 *   apply: (serverMessage: object|string) => ('applied'|'ignored'|'invalid'|'duplicate'|'gap'|'dropped'),
 *   handles: (type: string) => boolean,
 *   subscribe: (selector: (s: RunState) => unknown, fn: (next: unknown, prev: unknown) => void, equals?: (a: unknown, b: unknown) => boolean) => () => void,
 *   onResyncNeeded: (fn: (info: {reason: string, lastSeq: number, expected?: number, got?: number}) => void) => () => void
 * }}
 */
export function createRunStore({ isDm = () => false } = {}) {
  let state = initialRunState();
  let awaitingResync = false;
  const stats = { applied: 0, invalid: 0, duplicate: 0, gap: 0, dropped: 0, resyncs: 0 };
  const subs = new Set();
  const resyncListeners = new Set();

  function notify() {
    for (const sub of [...subs]) {
      if (!subs.has(sub)) continue;
      const v = sub.selector(state);
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
    const payload = { ...info, lastSeq: state.seq };
    for (const fn of [...resyncListeners]) fn(payload);
  }

  function applyEvent(ev) {
    if (!state.synced) {
      stats.dropped++;
      needResync({ reason: 'unsynced' });
      return 'dropped';
    }
    if (ev.seq <= state.seq) { stats.duplicate++; return 'duplicate'; }
    if (awaitingResync) { stats.dropped++; return 'dropped'; }
    if (ev.seq !== state.seq + 1) {
      stats.gap++;
      needResync({ reason: 'gap', expected: state.seq + 1, got: ev.seq });
      return 'gap';
    }
    state = reduceRunEvent(state, ev);
    stats.applied++;
    return 'applied';
  }

  function applyUpdated(p) {
    if (!state.synced) { stats.dropped++; return 'dropped'; }
    if (state.runId && p.runId !== state.runId) { needResync({ reason: 'run-changed' }); return 'gap'; }
    if (p.runSeq > state.seq) {
      stats.gap++;
      needResync({ reason: 'gap', expected: state.seq + 1, got: p.runSeq });
      return 'gap';
    }
    state = {
      ...state,
      status: p.status,
      currentNodeId: p.currentNodeId,
      visitedIds: addVisited(state.visitedIds, p.currentNodeId),
      ...(p.currentNodeId !== state.currentNodeId ? { edges: [] } : {})
    };
    stats.applied++;
    return 'applied';
  }

  return {
    getState: () => state,
    getStats: () => ({ ...stats }),
    handles: (type) => RUN_TYPES.has(type),

    apply(serverMessage) {
      let msg = serverMessage;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch { stats.invalid++; return 'invalid'; }
      }
      if (!msg || !RUN_TYPES.has(msg.t)) return 'ignored';
      if (!validateServerMessage(msg).ok) { stats.invalid++; return 'invalid'; }
      msg = clone(msg);
      let result;
      if (msg.t === 'run.snapshot') {
        if (state.synced && !awaitingResync && msg.p.run.id === state.runId && msg.p.run.seq < state.seq) {
          stats.duplicate++;
          return 'duplicate';
        }
        state = fromSnapshot(state, msg.p, !!isDm());
        awaitingResync = false;
        stats.applied++;
        result = 'applied';
      } else if (msg.t === 'run.event') {
        result = applyEvent(msg.p);
      } else if (msg.t === 'run.updated') {
        result = applyUpdated(msg.p);
      } else {
        state = { ...state, offers: { ...state.offers, [msg.p.levelUpId]: msg.p } };
        stats.applied++;
        result = 'applied';
      }
      if (result === 'applied') notify();
      return result;
    },

    subscribe(selector, fn, equals = Object.is) {
      const sub = { selector, fn, equals, last: selector(state) };
      subs.add(sub);
      return () => { subs.delete(sub); };
    },

    onResyncNeeded(fn) {
      resyncListeners.add(fn);
      return () => { resyncListeners.delete(fn); };
    }
  };
}
