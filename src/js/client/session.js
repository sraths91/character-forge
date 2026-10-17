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
 */

import { createWsClient } from './ws-client.js';
import { createStore } from './store.js';
import { EVENT_TYPES } from '../shared/events.js';

const EVENT_SET = new Set(EVENT_TYPES);

/**
 * @param {object} opts
 * @param {string} opts.url — ws URL
 * @param {string|(() => string)} opts.token
 * @param {Function} [opts.WebSocketCtor]
 * @param {object} [opts.store] — defaults to createStore() (hash check on)
 * @param {object} [opts.wsOptions] — extra createWsClient options (timers, now, random, logger)
 * @returns {{
 *   store: object, ws: object,
 *   connect: () => Promise<object>,
 *   send: (intent: {t: string, p?: object}) => Promise<object>,
 *   setPlayback: (playback: {play: (events: object[]) => Promise<void>}|null) => () => void,
 *   serverNow: () => number,
 *   onError: (fn: (err: {code: string, message: string}) => void) => () => void,
 *   close: () => void
 * }}
 */
export function createSession({ url, token, WebSocketCtor, store = createStore(), wsOptions = {} }) {
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
    const r = store.apply(msg);
    if (r !== 'applied' || !Number.isInteger(msg.seq)) return;
    const item = EVENT_SET.has(msg.t) ? msg.p : { seq: msg.seq, type: msg.t };
    if (playback) playback.play([item]);
    else store.presentUpTo(msg.seq);
  });
  store.onResyncNeeded(() => { ws.resync(store.getState().seq); });

  return {
    store,
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
    close: () => ws.close()
  };
}
