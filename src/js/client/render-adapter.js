/**
 * M64 C8 — 2D render adapter + playback queue for the play client.
 *
 *   const adapter = createRenderAdapter({ canvas, store, appearanceCache, cinemaCanvas });
 *   ws.on('message', (msg) => {
 *     if (store.apply(msg) === 'applied' && msg.seq) adapter.play([msg.t in events ? msg.p : {seq: msg.seq, type: msg.t}]);
 *   });
 *
 * The store (C6) applies every broadcast to `authoritative` on receipt;
 * this adapter decides WHEN each one reaches `presented` (what the screen
 * shows) by calling `store.presentUpTo(seq)`:
 *
 *   - ordinary events present as soon as the queue reaches them;
 *   - events of a cinema group (`cinemaGroup`, e.g. `attack.rolled`,
 *     `damage`, `entity.downed`) wait for the group's `exchange` event;
 *   - an `exchange` plays through `buildCinemaSequence` + the existing
 *     cinema (`createCinema`) when cinema is on, and presents its group
 *     at the Sequence's impact keyframe (the hit-pause), so HP bars move
 *     when the blow lands, not when the packet arrives. With cinema off
 *     it presents instantly.
 *   - Extra Attack / Multiattack (E1 wave 5): every swing of one Attack
 *     action shares a `cinemaGroup` and carries its own `exchange`
 *     (swing k >= 2 is `${group}.s${k}`). The swings play back to back
 *     as one cinema: the canvas stays up between them (a short linger
 *     waits for the next swing, which the server sends after this
 *     swing's cinema.done), the actors are kept unless the swing
 *     re-targets, and each swing presents its own HP at its impact.
 *   - `skip()` drops the backlog and jumps `presented` to `authoritative`.
 *
 * The battle map is drawn with E5's read-only `renderBattleScene(canvas,
 * view, local)` through one `createRenderScheduler` (single rAF, dirty
 * flag): presented-state changes and `redraw()` mark it dirty. No
 * setInterval anywhere; the only timer is the one-shot impact timeout
 * (injectable for tests).
 *
 * Token images (M65 1.5 leftover A): campaign monsters name their picture
 * by `statBlock.tokenImageId`; the view resolves it through the room's
 * `kind: 'token'` uploads (the snapshot's `room.tokenImages` / `room.maps`,
 * `tokenImagesOf`), then the `tokenImages` option, then the appearance
 * cache's `putTokenImages` index (play.js fills it from
 * `GET /api/rooms/:id/maps`). `invalidate()` re-projects after a refresh.
 *
 * Life-state badges (Dying / Stable / Dead, E1 wave 5; Down on older
 * servers) are drawn over the tokens after E5's renderer, from the
 * presented encounter (`tokenBadges`).
 *
 * `local` is the per-viewer presentation object E5's renderer reads
 * (camera, ownEntityId, hover, pathPreview, selectionId, dm …); views
 * mutate it and call `redraw()`.
 */

import { renderBattleScene } from '../sprite/compositor.js';
import { createRenderScheduler } from '../map/scheduler.js';
import { createCamera, cameraTransform, WORLD_CELL_PX } from '../map/camera.js';
import { projectBattleView } from '../map/view.js';
import { buildCinemaSequence } from '../anim/cinema-plan.js';
import { createCinema, findHitPauseAt } from '../anim/cinema.js';
import { MONSTER_PRESETS, buildMonsterCharacter } from '../scene/monster-presets.js';
import { statusBadge, tokenImagesOf, tokenImageResolver } from './selectors.js';

const DEFAULT_TIMERS = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id)
};

/**
 * The cinema actor record for an encounter entity: the look (sheet from
 * the appearance cache, or the monster preset) plus id / name / HP.
 * @param {object|null} entity — EncounterState entity
 * @param {object|null} appearanceCache — map/view.js createAppearanceCache()
 * @returns {object|null}
 */
export function cinemaActorFor(entity, appearanceCache = null) {
  if (!entity) return null;
  let look = null;
  if (entity.kind === 'monster') {
    const preset = MONSTER_PRESETS[entity.statBlock?.slug];
    look = preset ? buildMonsterCharacter(preset, entity.id) : null;
  } else {
    const key = appearanceCache?.keyFor?.(entity.sheetRef?.characterId ?? entity.id);
    look = key ? appearanceCache.characterFor(key) : null;
  }
  return {
    ...(look || {}),
    id: entity.id,
    name: entity.name,
    hpMax: entity.hpMax,
    hp: { current: entity.hp, max: entity.hpMax, temp: entity.hpTemp || 0 }
  };
}

/**
 * The life-state badge of every drawn token (hidden tokens only for a
 * viewer who sees them). Pure.
 * @param {object|null} view — RenderView (map/view.js)
 * @param {object|null} enc — presented EncounterState
 * @param {{dm?: {showHidden?: boolean}|null}} [local]
 * @returns {{id: string, col: number, row: number, status: string, short: string}[]}
 */
export function tokenBadges(view, enc, local = {}) {
  const out = [];
  for (const t of view?.tokens || []) {
    if (t.hidden && !local?.dm?.showHidden) continue;
    const b = statusBadge(enc?.entities?.[t.id]);
    if (b) out.push({ id: t.id, col: t.col, row: t.row, status: b.status, short: b.short });
  }
  return out;
}

const BADGE_COLORS = { down: '#9ca3af', downed: '#f87171', stable: '#60a5fa', dead: '#e5e7eb' };

/** Draw the badges over the rendered map (a real 2D canvas only). */
function drawTokenBadges(canvas, badges, camera) {
  if (!badges.length || typeof canvas?.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.fillText !== 'function' || typeof ctx.setTransform !== 'function') return;
  const pixelRatio = camera?.viewW > 0 ? canvas.width / camera.viewW : 1;
  const W = WORLD_CELL_PX;
  ctx.save();
  ctx.setTransform(...cameraTransform(camera, pixelRatio));
  ctx.font = `bold ${Math.round(W * 0.17)}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const b of badges) {
    const cx = b.col * W + W / 2;
    const cy = b.row * W + W * 0.9;
    const tw = Math.max(W * 0.5, (ctx.measureText?.(b.short)?.width || W * 0.5) + W * 0.12);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(cx - tw / 2, cy - W * 0.11, tw, W * 0.22);
    ctx.fillStyle = BADGE_COLORS[b.status] || '#fff';
    ctx.fillText(b.short, cx, cy);
  }
  ctx.restore();
}

/**
 * @param {object} opts
 * @param {HTMLCanvasElement|null} opts.canvas — battle map canvas (null = no map drawing)
 * @param {object} opts.store — client/store.js createStore()
 * @param {object} [opts.appearanceCache] — map/view.js createAppearanceCache()
 * @param {HTMLCanvasElement|null} [opts.cinemaCanvas] — creates the cinema when given
 * @param {object} [opts.cinema] — an existing cinema controller (tests / custom sprites)
 * @param {object} [opts.cinemaOptions] — extra createCinema options (drawSprite, drawWeapon, drawBackground)
 * @param {object} [opts.lookups] — buildCinemaSequence lookups
 * @param {boolean} [opts.cinemaEnabled=true]
 * @param {object} [opts.camera] — map/camera.js camera (default: created from the canvas size)
 * @param {Map<string, string>|Record<string, string>|((id: string) => string|null)|null} [opts.tokenImages]
 *   — extra token-image index (room uploads by id / sha256), after the snapshot's
 * @param {Function} [opts.render] — renderBattleScene override (tests)
 * @param {{raf?: Function, caf?: Function}} [opts.schedulerOpts]
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
 * @param {(exchangeId: string|null, info: {skipped: boolean}) => void} [opts.onExchangeDone]
 *   — called once per exchange (played, instant or skipped); the play
 *     client sends `cinema.done` from here
 * @param {(state: {playing: boolean, exchange: object|null}) => void} [opts.onCinemaState]
 * @param {number} [opts.swingLingerMs=700] — how long the cinema stays up after a
 *   swing, waiting for the next swing of the same cinemaGroup
 * @param {{warn: Function}} [opts.logger]
 * @returns {{
 *   play: (events: object[]) => Promise<void>,
 *   skip: () => void,
 *   dispose: () => void,
 *   redraw: () => void,
 *   invalidate: () => void,
 *   setCinemaEnabled: (on: boolean) => void,
 *   view: () => object|null,
 *   readonly busy: boolean,
 *   readonly queued: number,
 *   local: object
 * }}
 */
export function createRenderAdapter({
  canvas = null,
  store,
  appearanceCache = null,
  cinemaCanvas = null,
  cinema = null,
  cinemaOptions = {},
  lookups = {},
  tokenImages = null,
  cinemaEnabled = true,
  camera = null,
  render = renderBattleScene,
  schedulerOpts = {},
  timers = DEFAULT_TIMERS,
  onExchangeDone = null,
  onCinemaState = null,
  swingLingerMs = 700,
  logger = { warn: (...a) => globalThis.console?.warn?.(...a) }
} = {}) {
  if (!store || typeof store.presentUpTo !== 'function') throw new TypeError('createRenderAdapter: store is required');

  let cinemaOn = !!cinemaEnabled;
  let disposed = false;
  let pumping = false;
  let lastQueuedSeq = store.getPresented().seq || 0;
  const queue = [];      // {ev, done}
  const deferred = [];   // group members waiting for their exchange
  let skipGen = 0;       // bumps on skip(); in-flight exchanges compare it
  let skipWake = null;   // resolves the in-flight cinema race on skip()
  let lastRound = Promise.resolve();
  let currentExchange = null;
  let cinemaShown = false;
  let linger = null;     // {group, attackerId, defenderId, timer} — between swings of one group

  const cinemaCtl = cinema || (cinemaCanvas ? createCinema({ canvas: cinemaCanvas, ...cinemaOptions }) : null);

  const local = {
    camera: camera || createCamera({
      zoom: 1, minZoom: 0.1, maxZoom: 4,
      viewW: canvas?.clientWidth || 0, viewH: canvas?.clientHeight || 0,
      dpr: globalThis.devicePixelRatio || 1
    }),
    ownEntityId: null,
    hover: null,
    pathPreview: null,
    aoePreview: null,
    selectionId: null,
    dm: null,
    showTerrain: false,
    grid: { visible: true },
    resolveAppearance: (key) => (appearanceCache?.characterFor?.(key) || undefined),
    requestRedraw: () => scheduler.markDirty()
  };

  let viewMemo = { enc: undefined, idx: undefined, view: null };
  function currentView() {
    const p = store.getPresented();
    const enc = p.encounter;
    const idx = tokenImagesOf(p);
    if (enc !== viewMemo.enc || idx !== viewMemo.idx) {
      const resolve = tokenImageResolver(idx, tokenImages, appearanceCache);
      viewMemo = { enc, idx, view: enc ? projectBattleView(enc, appearanceCache, { tokenImages: resolve }) : null };
    }
    return viewMemo.view;
  }

  const scheduler = createRenderScheduler(async () => {
    if (disposed || !canvas) return false;
    const view = currentView();
    if (!view) return false;
    const res = await render(canvas, view, local);
    try {
      drawTokenBadges(canvas, tokenBadges(view, store.getPresented().encounter, local), local.camera);
    } catch (error) {
      logger.warn(JSON.stringify({ event: 'render_adapter.badges_failed', error: String(error?.message || error) }));
    }
    return !!res?.needsRedraw;
  }, schedulerOpts);

  const unsubscribe = store.subscribe((_a, p) => [p.encounter, tokenImagesOf(p)], () => scheduler.markDirty(), (x, y) => x[0] === y[0] && x[1] === y[1]);
  scheduler.markDirty();   // first frame

  function settle(item) { item.done(); }

  function present(seq) {
    if (Number.isInteger(seq)) store.presentUpTo(seq);
  }

  function flushDeferred(upToSeq) {
    for (let i = deferred.length - 1; i >= 0; i--) {
      if (deferred[i].ev.seq <= upToSeq) { settle(deferred[i]); deferred.splice(i, 1); }
    }
  }

  function setCinemaVisible(on, exchange) {
    currentExchange = on ? exchange : null;
    if (on === cinemaShown) return;   // a follow-up swing keeps the cinema up
    cinemaShown = on;
    if (cinemaCanvas) cinemaCanvas.hidden = !on;
    try { onCinemaState?.({ playing: on, exchange: on ? exchange : null }); } catch (error) {
      logger.warn(JSON.stringify({ event: 'render_adapter.cinema_state_listener_failed', error: String(error?.message || error) }));
    }
  }

  /** Close the cinema left up between swings. */
  function endLinger() {
    if (!linger) return;
    if (linger.timer !== null) timers.clearTimeout(linger.timer);
    linger = null;
    setCinemaVisible(false, null);
  }

  function exchangeDone(ev, skipped) {
    try { onExchangeDone?.(ev?.payload?.exchangeId ?? null, { skipped }); } catch (error) {
      logger.warn(JSON.stringify({ event: 'render_adapter.exchange_done_listener_failed', error: String(error?.message || error) }));
    }
  }

  async function playExchange(ev) {
    const gen = skipGen;
    if (!cinemaOn || !cinemaCtl) {
      present(ev.seq);
      exchangeDone(ev, false);
      return;
    }
    let plan;
    try {
      plan = buildCinemaSequence(ev, lookups);
    } catch (error) {
      logger.warn(JSON.stringify({ event: 'render_adapter.cinema_plan_failed', seq: ev.seq, error: String(error?.message || error) }));
      plan = null;
    }
    if (!plan?.seq) {
      present(ev.seq);
      exchangeDone(ev, false);
      return;
    }
    // A skipped cinema's rAF loop may still be drawing; never run two.
    await lastRound;
    if (gen !== skipGen || disposed) return;

    const p = ev.payload || {};
    const enc = store.getPresented().encounter;
    const att = enc?.entities?.[p.attackerId] || null;
    const def = p.defenderId ? (enc?.entities?.[p.defenderId] || null) : null;
    const defEffect = (p.effects || []).find(e => e.entityId === p.defenderId);
    // The next swing of the lingering group: same actors unless re-targeted.
    const followUp = linger && ev.cinemaGroup && linger.group === ev.cinemaGroup ? linger : null;
    if (linger) {
      if (linger.timer !== null) timers.clearTimeout(linger.timer);
      linger = null;
      if (!followUp) setCinemaVisible(false, null);
    }
    setCinemaVisible(true, ev);
    try {
      if (!followUp || followUp.attackerId !== p.attackerId || followUp.defenderId !== (p.defenderId ?? null)) {
        await cinemaCtl.setActors?.({
          attacker: cinemaActorFor(att, appearanceCache),
          defender: cinemaActorFor(def || att, appearanceCache)
        });
      }
      if (gen !== skipGen || disposed) return;
      cinemaCtl.resetHp?.({
        attHp: att?.hp ?? 1,
        defHp: defEffect?.hp?.before ?? def?.hp ?? 1
      });
      const impactAt = Math.max(0, findHitPauseAt(plan.seq) | 0);
      let impactTimer = timers.setTimeout(() => {
        impactTimer = null;
        if (gen === skipGen && !disposed) present(ev.seq);
      }, impactAt);
      const round = Promise.resolve(cinemaCtl.playRound(plan.seq, plan.verdict)).catch((error) => {
        logger.warn(JSON.stringify({ event: 'render_adapter.cinema_failed', seq: ev.seq, error: String(error?.message || error) }));
      });
      lastRound = round;
      const wake = new Promise((resolve) => { skipWake = resolve; });
      await Promise.race([round, wake]);
      skipWake = null;
      if (impactTimer !== null) { timers.clearTimeout(impactTimer); impactTimer = null; }
    } finally {
      if (gen === skipGen && !disposed) {
        present(ev.seq);
        if (ev.cinemaGroup) {
          // More swings of this Attack action may follow.
          currentExchange = null;
          linger = { group: ev.cinemaGroup, attackerId: p.attackerId, defenderId: p.defenderId ?? null, timer: null };
          const mine = linger;
          linger.timer = timers.setTimeout(() => { if (linger === mine) { linger.timer = null; endLinger(); } }, swingLingerMs);
        } else {
          setCinemaVisible(false, null);
        }
        exchangeDone(ev, false);
      }
    }
  }

  function groupHasExchange(group) {
    return queue.some(q => q.ev.type === 'exchange' && q.ev.cinemaGroup === group);
  }

  async function pump() {
    if (pumping || disposed) return;
    pumping = true;
    try {
      while (queue.length && !disposed) {
        const item = queue[0];
        const ev = item.ev;
        // Anything outside the swinging group ends the multi-swing cinema.
        if (linger && ev.cinemaGroup !== linger.group) endLinger();
        if (ev.type === 'exchange') {
          const gen = skipGen;
          await playExchange(ev);
          if (gen !== skipGen || disposed) continue;   // skip() already settled it; new items may follow
          queue.shift();
          flushDeferred(ev.seq);
          settle(item);
          continue;
        }
        if (cinemaOn && cinemaCtl && ev.cinemaGroup) {
          if (groupHasExchange(ev.cinemaGroup)) {
            queue.shift();
            deferred.push(item);
            continue;
          }
          // The group may still be arriving; wait unless something after it already came.
          if (queue.every(q => q.ev.cinemaGroup === ev.cinemaGroup)) break;
        }
        queue.shift();
        present(ev.seq);
        flushDeferred(ev.seq);
        settle(item);
      }
    } finally {
      pumping = false;
    }
  }

  /** Drop the backlog and show the authoritative state now. */
  function skip() {
    skipGen++;
    const seen = new Set();
    const pendingExchanges = [currentExchange, ...deferred.map(i => i.ev), ...queue.map(i => i.ev)]
      .filter(e => e && e.type === 'exchange' && !seen.has(e.seq) && seen.add(e.seq));
    const items = [...deferred.splice(0), ...queue.splice(0)];
    if (skipWake) { skipWake(); skipWake = null; }
    if (linger) { if (linger.timer !== null) timers.clearTimeout(linger.timer); linger = null; }
    store.presentUpTo(store.getState().seq);
    lastQueuedSeq = Math.max(lastQueuedSeq, store.getState().seq);
    setCinemaVisible(false, null);
    for (const ev of pendingExchanges) exchangeDone(ev, true);
    for (const item of items) settle(item);
    scheduler.markDirty();
  }

  return {
    local,

    play(events) {
      const list = Array.isArray(events) ? events : [events];
      const waits = [];
      for (const ev of list) {
        if (!ev || !Number.isInteger(ev.seq) || ev.seq <= lastQueuedSeq || disposed) continue;
        lastQueuedSeq = ev.seq;
        let done;
        const p = new Promise((resolve) => { done = resolve; });
        queue.push({ ev, done });
        waits.push(p);
      }
      pump();
      return Promise.all(waits).then(() => undefined);
    },

    skip,

    redraw() { scheduler.markDirty(); },

    /** Re-project the view (e.g. a character sheet arrived, so tokens get their look) and redraw. */
    invalidate() { viewMemo = { enc: undefined, idx: undefined, view: null }; scheduler.markDirty(); },

    setCinemaEnabled(on) {
      cinemaOn = !!on;
      if (!cinemaOn) skip();
    },

    view: currentView,

    get busy() { return queue.length > 0 || deferred.length > 0 || currentExchange !== null; },
    /** The cinema is up (playing, or lingering between swings). */
    get cinemaShown() { return cinemaShown; },
    get queued() { return queue.length + deferred.length; },

    dispose() {
      if (disposed) return;
      skip();
      disposed = true;
      unsubscribe();
      scheduler.stop();
    }
  };
}
