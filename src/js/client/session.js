/**
 * M64 C9 — one room connection: ws client (C7) → store (C6) → playback
 * (C8 render adapter, when a battle view is mounted).
 *
 * Every sequenced broadcast the store applies is handed to the playback
 * queue, which decides when it reaches `presented`; with no playback
 * mounted (lobby, setup) broadcasts present immediately. A store resync
 * request becomes a ws `resync`.
 *
 * The client-side `turn.ended.stateHash` check is ON (M64 phase 1.5):
 * the store's mirror (mirror.js) replays the engine's resource ledgers,
 * turn flags and turn order from the events, so its shared `stateHash`
 * equals the one the server stamps. A mismatch asks for a resync; seq
 * gaps and every (re)connect still bring a full snapshot.
 *
 * M65 (E6's restart finding): when `room.status` flips paused →
 * in-encounter and no `turn.started` follows within `resumeGraceMs`, the
 * session re-requests a snapshot (store.js resume watch), so a turn that a
 * restarted server resumed silently still reaches this client.
 *
 * M65 C23: run messages (`run.snapshot`, `run.event`, `run.updated`,
 * `levelup.offer`) also go to the run store (client/run-store.js), which
 * orders run events by their own run seq; its resync request is a ws
 * `resync` too (the server answers with both snapshots).
 */

import { createWsClient } from './ws-client.js';
import { createStore } from './store.js';
import { createRunStore } from './run-store.js';
import { EVENT_TYPES } from '../shared/events.js';

const EVENT_SET = new Set(EVENT_TYPES);

/**
 * @param {object} opts
 * @param {string} opts.url — ws URL
 * @param {string|(() => string)} opts.token
 * @param {Function} [opts.WebSocketCtor]
 * @param {object} [opts.store] — defaults to createStore() (hash check on)
 * @param {object} [opts.runStore] — defaults to createRunStore() (DM-ness from the room store)
 * @param {object} [opts.wsOptions] — extra createWsClient options (timers, now, random, logger)
 * @param {number} [opts.resumeGraceMs=1500] — how long a resumed room may go without a turn.started
 *   before the session asks for a snapshot (timers: wsOptions.timers, else the global ones)
 * @returns {{
 *   store: object, runStore: object, ws: object,
 *   connect: () => Promise<object>,
 *   send: (intent: {t: string, p?: object}) => Promise<object>,
 *   setPlayback: (playback: {play: (events: object[]) => Promise<void>}|null) => () => void,
 *   serverNow: () => number,
 *   onError: (fn: (err: {code: string, message: string}) => void) => () => void,
 *   close: () => void
 * }}
 */
export function createSession({ url, token, WebSocketCtor, store = createStore(), runStore = null, wsOptions = {}, resumeGraceMs = 1500 }) {
  const run = runStore || createRunStore({ isDm: () => store.getState().me?.role === 'dm' });
  const ws = createWsClient({
    url, token, WebSocketCtor,
    getLastSeq: () => (store.getState().synced ? store.getState().seq : null),
    ...wsOptions
  });
  let playback = null;
  const errorListeners = new Set();

  ws.on('message', (msg) => {
    if (!msg || typeof msg.t !== 'string' || msg.t === 'ack') return;
    if (msg.t === 'error' && !msg.p?.cid) {
      for (const fn of [...errorListeners]) fn({ code: msg.p.code, message: msg.p.message });
      return;
    }
    if (run.handles(msg.t)) run.apply(msg);
    const r = store.apply(msg);
    if (r !== 'applied' || !Number.isInteger(msg.seq)) return;
    const item = EVENT_SET.has(msg.t) ? msg.p : { seq: msg.seq, type: msg.t };
    if (playback) playback.play([item]);
    else store.presentUpTo(msg.seq);
  });
  store.onResyncNeeded(() => { ws.resync(store.getState().seq); });
  run.onResyncNeeded(() => { ws.resync(store.getState().seq); });
  const timers = wsOptions.timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const resumeTimers = new Set();
  store.onResumeWatch?.(({ seq }) => {
    const id = timers.setTimeout(() => {
      resumeTimers.delete(id);
      if (store.checkResume(seq)) {
        globalThis.console?.info?.(JSON.stringify({ event: 'session.resume_resync', seq }));
      }
    }, resumeGraceMs);
    resumeTimers.add(id);
  });

  return {
    store,
    runStore: run,
    ws,
    connect: () => ws.connect(),
    send: (intent) => {
      try {
        return ws.send(intent);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    setPlayback(pb) {
      playback = pb || null;
      if (!playback) store.presentUpTo(store.getState().seq);
      return () => {
        if (playback === pb) {
          playback = null;
          store.presentUpTo(store.getState().seq);
        }
      };
    },
    serverNow: () => ws.serverNow(),
    onError(fn) { errorListeners.add(fn); return () => { errorListeners.delete(fn); }; },
    close: () => {
      for (const id of resumeTimers) timers.clearTimeout(id);
      resumeTimers.clear();
      ws.close();
    }
  };
}
