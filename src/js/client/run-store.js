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
 * Status (E3's note, M65 C24): `run.started` does NOT mean the start node
 * was entered — the run waits in 'lobby' until `node.entered` (with the
 * seated party, at start, or after the DM's `dm.node.begin`). Status comes
 * from `node.entered` (an encounter node is 'in-node', any other kind
 * 'between'), `node.completed` ('between') and `run.updated`.
 *
 * Coin (v1.7): `currency.changed` (a `dm.stash.split` / `stash.take` move,
 * one per seat) sets the seat's purse and the stash coin from its `after`
 * at once, and `loot.granted` sets the stash coin — the purses move live,
 * before the snapshot that follows.
 *
 * `run.updated` also carries `completed` and `pendingRest` (the hit dice
 * declared with `rest.spend`, which changes nothing else and sends no
 * snapshot); the snapshot carries settings, stash, the node result, shop
 * purchases this visit and (DM) pending seat reclaims.
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
 * @property {object} settings         — campaign settings frozen into the run
 * @property {object} stash            — party stash ({currency})
 * @property {boolean} completed       — the current node is done
 * @property {object} result           — the current node's result ({outcome?, choice?})
 * @property {Record<string, number>} bought — shop purchases this visit (refKey → qty)
 * @property {Record<string, Record<string, number>>} pendingRest — declared hit dice per slotId
 * @property {object[]} reclaims       — pending seat.reclaim requests (DM only)
 */

/** @returns {RunState} */
export function initialRunState() {
  return {
    synced: false, runId: null, campaignId: null, status: null, outcome: null, currentNodeId: null, seq: 0,
    nodes: [], visitedIds: [], edges: [], characters: [], items: [], levelUps: [], offers: {}, log: [],
    settings: {}, stash: { currency: {} }, completed: false, result: {}, bought: {}, pendingRest: {}, reclaims: []
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

/** Offers still worth showing: their level-up is pending in `levelUps`. */
function liveOffers(offers, levelUps) {
  const pending = new Set((levelUps || []).filter(l => l.status === 'pending_player' || l.status === 'pending_dm').map(l => l.id));
  return Object.fromEntries(Object.entries(offers || {}).filter(([id]) => pending.has(id)));
}

function fromSnapshot(base, p, dm) {
  const sameRun = p.run.id === base.runId;
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
    levelUps: p.levelUps,
    offers: sameRun ? liveOffers(base.offers, p.levelUps) : {},
    log: sameRun ? base.log : [],
    settings: isObj(p.run.settings) ? p.run.settings : {},
    stash: isObj(p.run.stash) ? p.run.stash : { currency: {} },
    completed: p.run.completed === true,
    result: isObj(p.run.result) ? p.run.result : {},
    bought: isObj(p.run.bought) ? p.run.bought : {},
    pendingRest: isObj(p.pendingRest) ? p.pendingRest : {},
    reclaims: Array.isArray(p.reclaims) ? p.reclaims : []
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

/** Replace one character's state through `fn(state) → state` (no-op for an unknown seat). */
function patchState(chars, slotId, fn) {
  const c = chars.find(x => x.slotId === slotId);
  return c ? patchCharacter(chars, slotId, { state: fn(isObj(c.state) ? c.state : {}) }) : chars;
}

/** The slice's stash with its coin from a payload's `{stash}` (a coin map, or a stash object with `currency`). */
function stashWith(stash, coin) {
  const currency = isObj(coin?.currency) ? coin.currency : coin;
  return isObj(currency) ? { ...(isObj(stash) ? stash : {}), currency } : stash;
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
      // The run exists; the start node is entered only by a later node.entered.
      return { ...next, campaignId: p.campaignId ?? next.campaignId, status: 'lobby' };
    case 'run.ended':
      return { ...next, status: 'ended', outcome: p.outcome, edges: [] };
    case 'node.entered':
      return {
        ...next, status: p.kind === 'encounter' ? 'in-node' : 'between', currentNodeId: p.nodeId,
        visitedIds: addVisited(next.visitedIds, p.nodeId), edges: [], completed: false, result: {}, bought: {}, pendingRest: {}
      };
    case 'node.completed':
      return { ...next, status: 'between', completed: true };
    case 'encounter.result':
      // after: {slotId: {state, lifeStatus}}
      return {
        ...next, result: { outcome: p.outcome },
        characters: patchEach(next.characters, p.after, (a) => (isObj(a) && isObj(a.state) ? { state: a.state, ...(a.lifeStatus ? { lifeStatus: a.lifeStatus } : {}) } : null))
      };
    case 'rest.taken':
      // after: {slotId: state}
      return { ...next, characters: patchEach(next.characters, p.after, (st) => (isObj(st) ? { state: st } : null)) };
    case 'story.chosen':
      return { ...next, result: { ...next.result, choice: p.choiceId } };
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
    case 'currency.changed':
      // v1.7: after {currency, stash} — the seat's purse and (stash moves) the stash coin.
      return {
        ...next,
        characters: isObj(p.after?.currency) ? patchState(next.characters, p.slotId, (st) => ({ ...st, currency: p.after.currency })) : next.characters,
        stash: p.after && 'stash' in p.after ? stashWith(next.stash, p.after.stash) : next.stash
      };
    case 'loot.granted':
      return p.after && 'stash' in p.after ? { ...next, stash: stashWith(next.stash, p.after.stash) } : next;
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
      ...(p.currentNodeId !== state.currentNodeId ? { edges: [] } : {}),
      ...(typeof p.completed === 'boolean' ? { completed: p.completed } : {}),
      ...(isObj(p.pendingRest) ? { pendingRest: p.pendingRest } : {})
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
