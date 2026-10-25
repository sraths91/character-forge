/**
 * M64 C9 — the online-table client (play.html).
 *
 * Routes between the five screens from the room state:
 *   no room            → lobby (create / join)
 *   in a room, lobby   → lobby (code, seats, members) + claim (S2)
 *   DM, setting up     → setup (S3); players see "the DM is preparing"
 *   encounter running  → battle (S5), plus the DM panel (S4) for the DM
 *
 * This page stays independent of main.js: it shares only pure modules
 * with the forge and never installs document-level listeners — every
 * view listens on its own root. `?fake=1` runs against the in-browser
 * fake server (client/fake-transport.js) as a single-tab demo (DM with
 * AI-run seats); `?code=XXXXXX` prefills the join form.
 *
 * Credentials (room id + token) live in sessionStorage for reconnects;
 * the token goes only into `Authorization: Bearer` and the ws `hello`.
 */

import { createApi } from './client/api.js';
import { createSession } from './client/session.js';
import { createFakeServer, demoCharacter } from './client/fake-transport.js';
import { screenFor, isDm, seatsOf, tokenUploads } from './client/selectors.js';
import { createAppearanceCache } from './map/view.js';
import { mount as mountLobby } from './client/views/lobby.js';
import { mount as mountClaim } from './client/views/claim.js';
import { mount as mountSetup } from './client/views/setup.js';
import { mount as mountBattle } from './client/views/battle.js';
import { mount as mountDmPanel, createDmBridge } from './client/views/dm-panel.js';
import { h, clear } from './client/views/dom.js';

const CREDS_KEY = 'cf-play-creds';

function readCreds(storage) {
  try {
    const raw = storage?.getItem?.(CREDS_KEY);
    const c = raw ? JSON.parse(raw) : null;
    return c && typeof c.token === 'string' && typeof c.roomId === 'string' ? c : null;
  } catch { return null; }
}

function writeCreds(storage, creds) {
  try {
    if (creds) storage?.setItem?.(CREDS_KEY, JSON.stringify(creds));
    else storage?.removeItem?.(CREDS_KEY);
  } catch { /* private mode: reconnect-on-reload just won't work */ }
}

/**
 * Build the play app.
 * @param {object} opts
 * @param {HTMLElement} opts.root
 * @param {Function} opts.fetch
 * @param {Function} opts.WebSocketCtor
 * @param {string} opts.wsUrl
 * @param {Storage|null} [opts.storage]
 * @param {object} [opts.deps] — view dependencies (render, promptReaction, calibrateEncounter, mountCalibrator, loadImage, readFile, objectUrl, copyText, timers, raf, caf, cinema, cinemaOptions, wsOptions)
 * @param {string} [opts.prefillCode]
 * @param {string} [opts.origin] — for the copy-link URL
 * @returns {{start: () => Promise<void>, dispose: () => void, readonly screen: string|null,
 *            readonly session: object|null, actions: object, api: object,
 *            appearanceCache: object, loadTokenImages: () => Promise<object[]|null>}}
 */
export function createPlayApp({ root, fetch, WebSocketCtor, wsUrl, storage = null, deps = {}, prefillCode = '', origin = '' }) {
  const doc = root.ownerDocument;
  let creds = readCreds(storage);
  let session = null;
  let unsubRoute = null;
  let unsubSeats = null;
  let screen = null;
  let unmounts = [];
  let wantSetup = false;
  const sheetCache = new Map();
  const sheetLoads = new Map();
  const sheetListeners = new Set();
  const tokenImageListeners = new Set();
  let unsubTokens = null;
  let tokenLoad = 0;
  const appearanceCache = createAppearanceCache();
  const dmBridge = createDmBridge();
  const api = createApi({ fetch, token: () => creds?.token ?? null });

  const bar = h(doc, 'header', { class: 'play-bar' });
  const banner = h(doc, 'p', { class: 'play-banner', hidden: true, attrs: { role: 'alert' } });
  const mainEl = h(doc, 'div', { class: 'play-main' });
  const sideEl = h(doc, 'div', { class: 'play-side' });
  const layout = h(doc, 'div', { class: 'play-layout' }, [mainEl, sideEl]);
  root.appendChild(bar);
  root.appendChild(banner);
  root.appendChild(layout);

  function showBanner(msg) { banner.textContent = msg || ''; banner.hidden = !msg; }

  function loadSheet(id) {
    if (!id) return Promise.resolve(null);
    if (sheetCache.has(id)) return Promise.resolve(sheetCache.get(id));
    if (!sheetLoads.has(id)) {
      sheetLoads.set(id, api.getCharacter(id).then((res) => {
        const sheet = res?.character || null;
        if (sheet) {
          sheetCache.set(id, sheet);
          appearanceCache.put(id, sheet);
          for (const fn of [...sheetListeners]) fn(id);
        }
        return sheet;
      }).catch(() => { sheetLoads.delete(id); return null; }));
    }
    return sheetLoads.get(id);
  }

  /**
   * M65 1.5 leftover A: the room's `kind: 'token'` uploads (campaign
   * tokens materialised on node entry) → the appearance cache's index,
   * so `statBlock.tokenImageId` resolves. Refreshed per encounter.
   */
  function loadTokenImages() {
    const roomId = creds?.roomId;
    if (!roomId || typeof api.listMaps !== 'function') return Promise.resolve(null);
    const n = ++tokenLoad;
    return api.listMaps(roomId).then((res) => {
      if (n !== tokenLoad) return null;
      const rows = tokenUploads(res?.maps).filter(r => r.kind === 'token');
      appearanceCache.putTokenImages(rows);
      for (const fn of [...tokenImageListeners]) fn(rows);
      return rows;
    }).catch(() => null);   // an older server, or not a member yet: tokens keep their LPC look
  }

  const actions = {
    async createRoom(name = null) {
      const r = await api.createRoom(name);
      creds = { roomId: r.roomId, code: r.code, token: r.dmToken, role: 'dm' };
      writeCreds(storage, creds);
      await connect();
    },
    async joinRoom(code, displayName) {
      const r = await api.joinRoom(code, displayName);
      creds = { roomId: r.roomId, code, token: r.token, role: 'player' };
      writeCreds(storage, creds);
      await connect();
    },
    leave() {
      disconnect();
      creds = null;
      writeCreds(storage, null);
      route(true);
    },
    openSetup() { wantSetup = true; route(true); },
    copyLink(code) { return deps.copyText?.(`${origin}/play.html?code=${encodeURIComponent(code || '')}`); }
  };

  function ctx(extra = {}) {
    return {
      store: session?.store || null,
      send: (intent) => (session ? session.send(intent) : Promise.reject(new Error('not connected'))),
      session,
      api,
      room: creds ? { roomId: creds.roomId, code: creds.code, role: creds.role } : null,
      loadSheet,
      sheets: () => Object.fromEntries(sheetCache),
      onSheet: (fn) => { sheetListeners.add(fn); return () => sheetListeners.delete(fn); },
      onTokenImages: (fn) => { tokenImageListeners.add(fn); return () => tokenImageListeners.delete(fn); },
      appearanceCache,
      dmBridge,
      actions,
      deps,
      prefillCode,
      ...extra
    };
  }

  function renderBar() {
    clear(bar);
    bar.appendChild(h(doc, 'strong', { class: 'play-title', text: 'character-forge table' }));
    if (creds) {
      bar.appendChild(h(doc, 'span', { class: 'play-bar-code', text: `Room ${creds.code || ''}` }));
      const leave = h(doc, 'button', { type: 'button', class: 'play-btn small', text: 'Leave' });
      bar.appendChild(leave);
      const onLeave = () => actions.leave();
      leave.addEventListener('click', onLeave);
      unmounts.push(() => leave.removeEventListener('click', onLeave));
    }
  }

  function currentScreen() {
    if (!creds) return 'lobby';
    if (!session) return 'connecting';
    const s = session.store.getState();
    return screenFor(s, { wantSetup });
  }

  function route(force = false) {
    const next = currentScreen();
    if (next === screen && !force) return;
    for (const off of unmounts.splice(0).reverse()) { try { off(); } catch { /* keep going */ } }
    clear(mainEl);
    clear(sideEl);
    screen = next;
    renderBar();
    const c = ctx();
    if (next === 'connecting') {
      mainEl.appendChild(h(doc, 'p', { class: 'play-waiting', text: 'Connecting to the table…' }));
    } else if (next === 'lobby') {
      unmounts.push(mountLobby(mainEl, c));
      if (creds && session) unmounts.push(mountClaim(sideEl, c));
    } else if (next === 'waiting-setup') {
      unmounts.push(mountLobby(mainEl, { ...c, waitingForSetup: true }));
    } else if (next === 'setup') {
      unmounts.push(mountSetup(mainEl, c));
    } else if (next === 'battle') {
      unmounts.push(mountBattle(mainEl, c));
      if (isDm(session.store.getState())) unmounts.push(mountDmPanel(sideEl, c));
    }
  }

  function disconnect() {
    unsubRoute?.(); unsubRoute = null;
    unsubSeats?.(); unsubSeats = null;
    unsubTokens?.(); unsubTokens = null;
    session?.close();
    session = null;
  }

  async function connect() {
    disconnect();
    showBanner('');
    const s = createSession({ url: wsUrl, token: () => creds?.token || '', WebSocketCtor, wsOptions: deps.wsOptions || {} });
    session = s;
    s.ws.on('terminated', (info) => {
      if (session !== s) return;
      showBanner(info.code === 'E_REVOKED' ? 'The DM removed you from the table.' : info.code === 'E_SUPERSEDED' ? 'This room is open in another tab.' : `Disconnected: ${info.message}`);
      if (info.code === 'E_REVOKED' || info.code === 'E_UNAUTHENTICATED') { creds = null; writeCreds(storage, null); }
    });
    s.ws.on('reconnecting', ({ delayMs }) => { if (session === s) showBanner(`Connection lost — retrying in ${Math.round(delayMs / 1000)} s…`); });
    s.ws.on('open', () => { if (session === s) showBanner(''); });
    s.onError((e) => showBanner(e.message));
    unsubRoute = s.store.subscribe((a) => screenFor(a, { wantSetup }), () => route());
    unsubSeats = s.store.subscribe((a) => a, (a) => { for (const seat of seatsOf(a)) if (seat.characterId) loadSheet(seat.characterId); });
    unsubTokens = s.store.subscribe((a) => (a.synced ? `${a.room?.encounterId ?? ''}|${a.room?.status ?? ''}` : null), (k) => { if (k !== null) loadTokenImages(); });
    route(true);
    await s.connect();
    route(true);
  }

  return {
    async start() {
      route(true);
      if (creds) await connect().catch((err) => showBanner(`Could not reconnect: ${err.message}`));
    },
    dispose() {
      for (const off of unmounts.splice(0).reverse()) { try { off(); } catch { /* keep going */ } }
      disconnect();
      clear(root);
    },
    get screen() { return screen; },
    get session() { return session; },
    actions,
    api,
    appearanceCache,
    loadTokenImages
  };
}

/** Demo party for `?fake=1`. */
export const DEMO_CHARACTERS = Object.freeze([
  demoCharacter('demo-fighter', 'Brakka', { cls: 'Fighter', level: 3, hp: 30, weapon: 'Longsword', dice: '1d8' }),
  demoCharacter('demo-wizard', 'Ilsa', { cls: 'Wizard', level: 3, hp: 18, weapon: 'Quarterstaff', dice: '1d6', armor: 12, spellSlots: { 1: 4, 2: 2 } }),
  demoCharacter('demo-cleric', 'Dorn', { cls: 'Cleric', level: 3, hp: 24, weapon: 'Mace', dice: '1d6', armor: 18, spellSlots: { 1: 4, 2: 2 } })
]);

async function browserDeps() {
  const [{ promptReaction }, { calibrateEncounter }, { mountCalibrator }, sprites] = await Promise.all([
    import('./scene/reaction-prompt.js'),
    import('./scene/calibrator.js'),
    import('./map/calibrate.js'),
    import('./anim/cinema-sprites.js')
  ]);
  return {
    promptReaction,
    calibrateEncounter,
    mountCalibrator,
    loadImage: (url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('the map image did not load'));
      img.src = url;
    }),
    readFile: (file) => file.arrayBuffer(),
    objectUrl: (file) => URL.createObjectURL(file),
    copyText: (text) => navigator.clipboard?.writeText?.(text),
    cinemaOptions: {
      drawSprite: sprites.makeLpcDrawSprite(),
      drawWeapon: sprites.drawWeaponOverlay,
      onActorsChanged: async ({ attacker, defender }) => {
        await Promise.all([
          sprites.preloadActorSprite(attacker, { direction: 'south' }),
          sprites.preloadActorSprite(defender, { direction: 'south' })
        ]);
      }
    }
  };
}

/**
 * Boot play.html.
 * @param {Document} doc
 * @returns {Promise<object|null>} the app
 */
export async function boot(doc) {
  const root = doc.getElementById('play-root');
  if (!root) return null;
  const win = doc.defaultView;
  const params = new URLSearchParams(win.location.search);
  const fake = params.get('fake') === '1';
  const server = fake ? createFakeServer({ characters: DEMO_CHARACTERS, shareLibrary: true }) : null;
  let storage = null;
  try { storage = fake ? null : win.sessionStorage; } catch { storage = null; }
  const app = createPlayApp({
    root,
    fetch: fake ? server.fetch : win.fetch.bind(win),
    WebSocketCtor: fake ? server.WebSocket : win.WebSocket,
    wsUrl: fake ? 'ws://fake.local/ws' : `${win.location.protocol === 'https:' ? 'wss' : 'ws'}://${win.location.host}/ws`,
    storage,
    deps: await browserDeps(),
    prefillCode: (params.get('code') || '').toUpperCase().slice(0, 6),
    origin: win.location.origin
  });
  await app.start();
  return app;
}

if (typeof document !== 'undefined' && document.getElementById?.('play-root')) {
  boot(document).catch((err) => {
    globalThis.console?.error?.(JSON.stringify({ event: 'play.boot_failed', error: String(err?.stack || err) }));
  });
}
