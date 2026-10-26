/**
 * M64 C9 — the online-table client (play.html).
 *
 * Routes between the five screens from the room state:
 *   no room            → lobby (create / join)
 *   in a room, lobby   → lobby (code, seats, members) + claim (S2)
 *   DM, setting up     → setup (S3); players see "the DM is preparing"
 *   encounter running  → battle (S5), plus the DM panel (S4) for the DM
 *   run between nodes  → the between hub (M65 C24: run map, rest, stash,
 *                        party gear, level-ups, shop, story; the DM's
 *                        run dashboard in the side panel, C27)
 *
 * This page stays independent of main.js: it shares only pure modules
 * with the forge and never installs document-level listeners — every
 * view listens on its own root. `?fake=1` runs against the in-browser
 * fake server (client/fake-transport.js) as a single-tab demo (DM with
 * AI-run seats); `?code=XXXXXX` prefills the join form.
 *
 * Credentials (room id + token) live in sessionStorage for reconnects,
 * and (M65 C28) in localStorage per room code (client/room-creds.js), so
 * closing the tab and joining the same code again resumes the same
 * participant and seat; "Forget this device" drops a code's entry. The
 * token goes only into `Authorization: Bearer` and the ws `hello`.
 *
 * M65 C28 also adds the SRD 5.1 attribution footer and the About dialog
 * (text from `GET /api/licenses`), and loads seat sheets from the run
 * sheet route (`GET /api/rooms/:id/seats/:slotId/sheet`, B27), falling
 * back to `GET /api/characters/:ddbId` only while a server lacks it. Run
 * views never call `api.getCharacter` (a test enforces it).
 *
 * M65 V21 — the forge's "Play at the table" lands here: it created a solo
 * room, seated the party and left the encounter setup in sessionStorage
 * (client/forge-handoff.js). The DM of that room opens straight on the
 * setup screen with the draft pre-filled once.
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
import { mount as mountBetween } from './client/views/between.js';
import { mount as mountRunDashboard } from './client/views/run-dashboard.js';
import { createRunSheets } from './client/run-model.js';
import { mount as mountCampaigns } from './client/views/campaigns.js';
import { mount as mountCampaignEditor } from './client/views/campaign-editor.js';
import { createCampaignKeys } from './client/campaign-keys.js';
import { createRoomCreds } from './client/room-creds.js';
import { readHandoff, clearHandoff } from './client/forge-handoff.js';
import { h, clear } from './client/views/dom.js';

/** Shown until (or if never) `GET /api/licenses` answers. */
export const SRD_ATTRIBUTION_FALLBACK = 'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC, licensed under the Creative Commons Attribution 4.0 International License.';

/**
 * Build the play app.
 * @param {object} opts
 * @param {HTMLElement} opts.root
 * @param {Function} opts.fetch
 * @param {Function} opts.WebSocketCtor
 * @param {string} opts.wsUrl
 * @param {Storage|null} [opts.storage] — sessionStorage (this tab's reconnect creds)
 * @param {Storage|null} [opts.durableStorage] — localStorage (campaign keys M65 C21, room creds per code C28)
 * @param {object} [opts.deps] — view dependencies (render, promptReaction, calibrateEncounter, mountCalibrator, loadImage, readFile, objectUrl, copyText, timers, raf, caf, cinema, cinemaOptions, wsOptions)
 * @param {string} [opts.prefillCode]
 * @param {string} [opts.origin] — for the copy-link URL
 * @returns {{start: () => Promise<void>, dispose: () => void, readonly screen: string|null,
 *            readonly session: object|null, actions: object, api: object,
 *            appearanceCache: object, loadTokenImages: () => Promise<object[]|null>}}
 */
export function createPlayApp({ root, fetch, WebSocketCtor, wsUrl, storage = null, durableStorage = null, deps = {}, prefillCode = '', origin = '' }) {
  const doc = root.ownerDocument;
  const roomCreds = createRoomCreds({ session: storage, durable: durableStorage });
  let creds = roomCreds.active();
  /** This tab's room → sessionStorage; every room → localStorage by code. */
  function persist(next) {
    creds = next;
    roomCreds.setActive(next);
    if (next) roomCreds.remember(next);
  }
  let licenseText = null;
  /** True once the run-sheet route answered 404 (an older server): use the character route. */
  let seatSheetMissing = false;
  let session = null;
  let unsubRoute = null;
  let unsubSeats = null;
  let screen = null;
  let unmounts = [];
  let wantSetup = false;
  /** M65 V21: the forge's pending setup for this room (applied once by the setup view). */
  let handoff = creds?.role === 'dm' ? readHandoff(storage, creds.code) : null;
  if (handoff) wantSetup = true;
  /** Local (room-less) screens: 'campaigns' or {editor: campaignId}. */
  let local = null;
  const campaignKeys = createCampaignKeys(durableStorage);
  const sheetCache = new Map();
  const sheetLoads = new Map();
  const sheetListeners = new Set();
  const tokenImageListeners = new Set();
  let unsubTokens = null;
  let tokenLoad = 0;
  const appearanceCache = createAppearanceCache();
  const dmBridge = createDmBridge();
  const api = createApi({ fetch, token: () => creds?.token ?? null });
  /** Run sheets by seat + version (M65 C24), shared by the between screens; reset per connection. */
  let runSheets = createRunSheets({ api, roomId: () => creds?.roomId ?? null });

  const bar = h(doc, 'header', { class: 'play-bar' });
  const banner = h(doc, 'p', { class: 'play-banner', hidden: true, attrs: { role: 'alert' } });
  const mainEl = h(doc, 'div', { class: 'play-main' });
  const sideEl = h(doc, 'div', { class: 'play-side' });
  const layout = h(doc, 'div', { class: 'play-layout' }, [mainEl, sideEl]);
  const footer = h(doc, 'footer', { class: 'play-footer' });
  const about = h(doc, 'div', { class: 'play-modal play-about', hidden: true, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'About' } });
  root.appendChild(bar);
  root.appendChild(banner);
  root.appendChild(layout);
  root.appendChild(footer);
  root.appendChild(about);
  const onAboutClick = (e) => { if (e.target?.closest?.('[data-action="about-close"]')) closeAbout(); };
  about.addEventListener('click', onAboutClick);

  function attribution() { return licenseText?.attribution || SRD_ATTRIBUTION_FALLBACK; }
  function renderFooter() {
    clear(footer);
    footer.appendChild(h(doc, 'small', { class: 'play-attribution', text: attribution() }));
  }
  function openAbout() {
    clear(about);
    about.appendChild(h(doc, 'div', { class: 'play-modal-body' }, [
      h(doc, 'h2', { text: 'About character-forge' }),
      h(doc, 'p', { text: 'A browser table for D&D 5e tactical play: the DM runs the room, players drive their own characters.' }),
      h(doc, 'h3', { text: licenseText?.name || 'System Reference Document 5.1' }),
      h(doc, 'p', { class: 'play-attribution', text: attribution() }),
      licenseText?.license ? h(doc, 'p', { class: 'hint-line', text: `License: ${licenseText.license}` }) : null,
      h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'about-close' }, text: 'Close' })
    ]));
    about.hidden = false;
  }
  function closeAbout() { about.hidden = true; clear(about); }
  function loadLicenses() {
    if (typeof api.licenses !== 'function') return Promise.resolve(null);
    return api.licenses().then((r) => {
      if (r?.srd?.attribution) { licenseText = r.srd; renderFooter(); if (!about.hidden) openAbout(); }
      return licenseText;
    }).catch(() => null);
  }
  renderFooter();

  function showBanner(msg) { banner.textContent = msg || ''; banner.hidden = !msg; }

  /** The seat (slot id) holding a character in the current room, if any. */
  function slotFor(characterId) {
    const st = session?.store?.getState?.();
    return st ? (seatsOf(st).find(x => x.characterId === characterId)?.slotId ?? null) : null;
  }

  /**
   * A seat's sheet: the run sheet route (B27: full for its controller and
   * the DM, prose-stripped otherwise), else, on a server without it, the
   * character route.
   */
  async function fetchSheet(id, slotId) {
    if (slotId && creds?.roomId && !seatSheetMissing) {
      try {
        const res = await api.getSeatSheet(creds.roomId, slotId);
        const sheet = res?.sheet || res?.character || null;
        if (sheet) return sheet;
      } catch (err) {
        if (err?.status !== 404) throw err;
        // The app's generic JSON 404 means the route itself is missing (an
        // older server): stop asking. Any other 404 falls back this once.
        if (err.code === 'NOT_FOUND' && err.message === 'Not found') seatSheetMissing = true;
      }
    }
    return (await api.getCharacter(id))?.character || null;
  }

  function loadSheet(id, slotId = slotFor(id)) {
    if (!id) return Promise.resolve(null);
    if (sheetCache.has(id)) return Promise.resolve(sheetCache.get(id));
    if (!sheetLoads.has(id)) {
      sheetLoads.set(id, fetchSheet(id, slotId).then((sheet) => {
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
      persist({ roomId: r.roomId, code: r.code, token: r.dmToken, role: 'dm' });
      await connect();
    },
    async joinRoom(code, displayName) {
      // M65 C28: a code this device already holds creds for is a rejoin
      // (same participant, same seat), not a new join.
      if (roomCreds.byCode(code)) { await actions.rejoin(code); return; }
      const r = await api.joinRoom(code, displayName);
      persist({ roomId: r.roomId, code, token: r.token, role: 'player', displayName });
      await connect();
    },
    async rejoin(code) {
      const saved = roomCreds.byCode(code);
      if (!saved) throw new Error('This device has no seat in that room.');
      persist(saved);
      await connect();
    },
    /** "Forget this device": drop the code's saved creds (and leave, when it is this room). */
    forgetRoom(code) {
      const c = String(code || '').toUpperCase();
      roomCreds.forget(c);
      if (creds && creds.code === c) actions.leave();
      else route(true);
    },
    rememberedRooms: () => roomCreds.remembered().map(r => ({ code: r.code, role: r.role, displayName: r.displayName || null, savedAt: r.savedAt })),
    leave() {
      disconnect();
      creds = null;
      roomCreds.setActive(null);
      route(true);
    },
    openAbout: () => openAbout(),
    closeAbout: () => closeAbout(),
    openSetup() { wantSetup = true; route(true); },
    // ---- M65 C21: campaign authoring (no room needed) ----
    openCampaigns() { local = 'campaigns'; route(true); },
    closeCampaigns() { local = null; route(true); },
    openCampaign(campaignId) { local = { editor: String(campaignId) }; route(true); },
    closeCampaign() { local = 'campaigns'; route(true); },
    async startRun({ campaignId, campaignKey }) {
      let r;
      try {
        r = await api.startRun(campaignId, campaignKey, { roomToken: creds?.role === 'dm' ? creds.token : null });
      } catch (err) {
        if (err?.status === 404 || err?.status === 405) throw new Error('This server cannot start campaign runs yet.');
        throw err;
      }
      persist({ roomId: r.roomId, code: r.code, token: r.dmToken || creds?.token, role: 'dm' });
      local = null;
      await connect();
      return r;
    },
    copyLink(code) { return deps.copyText?.(`${origin}/play.html?code=${encodeURIComponent(code || '')}`); }
  };

  function ctx(extra = {}) {
    return {
      store: session?.store || null,
      runStore: session?.runStore || null,
      send: (intent) => (session ? session.send(intent) : Promise.reject(new Error('not connected'))),
      session,
      api,
      room: creds ? { roomId: creds.roomId, code: creds.code, role: creds.role } : null,
      loadSheet,
      runSheets,
      sheets: () => Object.fromEntries(sheetCache),
      onSheet: (fn) => { sheetListeners.add(fn); return () => sheetListeners.delete(fn); },
      onTokenImages: (fn) => { tokenImageListeners.add(fn); return () => tokenImageListeners.delete(fn); },
      appearanceCache,
      dmBridge,
      actions,
      campaignKeys,
      roomToken: () => creds?.token ?? null,
      deps,
      prefillCode,
      handoff: handoff ? { setup: handoff.setup, warnings: handoff.warnings, consume: () => { handoff = null; clearHandoff(storage); } } : null,
      ...extra
    };
  }

  function renderBar() {
    clear(bar);
    bar.appendChild(h(doc, 'strong', { class: 'play-title', text: 'character-forge table' }));
    if (!local && (!creds || creds.role === 'dm')) {
      const camp = h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'open-campaigns' }, text: 'Campaigns' });
      bar.appendChild(camp);
      const onCamp = () => actions.openCampaigns();
      camp.addEventListener('click', onCamp);
      unmounts.push(() => camp.removeEventListener('click', onCamp));
    }
    const button = (text, action, fn) => {
      const b = h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action }, text });
      bar.appendChild(b);
      b.addEventListener('click', fn);
      unmounts.push(() => b.removeEventListener('click', fn));
    };
    if (creds) {
      bar.appendChild(h(doc, 'span', { class: 'play-bar-code', text: `Room ${creds.code || ''}` }));
      button('Leave', 'leave-room', () => actions.leave());
      button('Forget this device', 'forget-device', () => actions.forgetRoom(creds?.code));
    }
    button('About', 'about', () => openAbout());
  }

  function currentScreen() {
    if (local === 'campaigns') return 'campaigns';
    if (local?.editor) return `campaign-editor:${local.editor}`;
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
    if (next === 'campaigns') {
      unmounts.push(mountCampaigns(mainEl, c));
    } else if (next.startsWith('campaign-editor:')) {
      unmounts.push(mountCampaignEditor(mainEl, { ...c, campaignId: local.editor }));
    } else if (next === 'connecting') {
      mainEl.appendChild(h(doc, 'p', { class: 'play-waiting', text: 'Connecting to the table…' }));
    } else if (next === 'lobby') {
      unmounts.push(mountLobby(mainEl, c));
      if (creds && session) unmounts.push(mountClaim(sideEl, c));
      // A run waiting in its lobby: the DM begins it from the dashboard (hidden without a run).
      if (creds && session && isDm(session.store.getState())) unmounts.push(mountRunDashboard(sideEl, c));
    } else if (next === 'waiting-setup') {
      unmounts.push(mountLobby(mainEl, { ...c, waitingForSetup: true }));
    } else if (next === 'setup') {
      unmounts.push(mountSetup(mainEl, c));
    } else if (next === 'between') {
      unmounts.push(mountBetween(mainEl, c));
      if (isDm(session.store.getState())) unmounts.push(mountRunDashboard(sideEl, c));
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
    runSheets = createRunSheets({ api, roomId: () => creds?.roomId ?? null });
    showBanner('');
    const s = createSession({ url: wsUrl, token: () => creds?.token || '', WebSocketCtor, wsOptions: deps.wsOptions || {} });
    session = s;
    s.ws.on('terminated', (info) => {
      if (session !== s) return;
      showBanner(info.code === 'E_REVOKED' ? 'The DM removed you from the table.' : info.code === 'E_SUPERSEDED' ? 'This room is open in another tab.' : `Disconnected: ${info.message}`);
      if (info.code === 'E_REVOKED' || info.code === 'E_UNAUTHENTICATED') {
        if (creds?.code) roomCreds.forget(creds.code);
        creds = null;
        roomCreds.setActive(null);
      }
    });
    s.ws.on('reconnecting', ({ delayMs }) => { if (session === s) showBanner(`Connection lost — retrying in ${Math.round(delayMs / 1000)} s…`); });
    s.ws.on('open', () => { if (session === s) showBanner(''); });
    s.onError((e) => showBanner(e.message));
    unsubRoute = s.store.subscribe((a) => screenFor(a, { wantSetup }), () => route());
    unsubSeats = s.store.subscribe((a) => a, (a) => { for (const seat of seatsOf(a)) if (seat.characterId) loadSheet(seat.characterId, seat.slotId); });
    unsubTokens = s.store.subscribe((a) => (a.synced ? `${a.room?.encounterId ?? ''}|${a.room?.status ?? ''}` : null), (k) => { if (k !== null) loadTokenImages(); });
    route(true);
    await s.connect();
    route(true);
  }

  return {
    async start() {
      route(true);
      loadLicenses();
      if (creds) await connect().catch((err) => showBanner(`Could not reconnect: ${err.message}`));
    },
    dispose() {
      for (const off of unmounts.splice(0).reverse()) { try { off(); } catch { /* keep going */ } }
      about.removeEventListener('click', onAboutClick);
      disconnect();
      clear(root);
    },
    loadLicenses,
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
  const [{ promptReaction }, { calibrateEncounter }, { simulateEncounter }, { mountCalibrator }, sprites] = await Promise.all([
    import('./scene/reaction-prompt.js'),
    import('./scene/calibrator.js'),
    import('./scene/simulator.js'),
    import('./map/calibrate.js'),
    import('./anim/cinema-sprites.js')
  ]);
  return {
    promptReaction,
    calibrateEncounter,
    simulateEncounter,
    mountCalibrator,
    loadImage: (url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('the map image did not load'));
      img.src = url;
    }),
    readFile: (file) => file.arrayBuffer(),
    download: (filename, json) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
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
  let durableStorage = null;
  try { durableStorage = fake ? null : win.localStorage; } catch { durableStorage = null; }
  const app = createPlayApp({
    root,
    fetch: fake ? server.fetch : win.fetch.bind(win),
    WebSocketCtor: fake ? server.WebSocket : win.WebSocket,
    wsUrl: fake ? 'ws://fake.local/ws' : `${win.location.protocol === 'https:' ? 'wss' : 'ws'}://${win.location.host}/ws`,
    storage,
    durableStorage,
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
