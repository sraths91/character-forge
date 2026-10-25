/**
 * M64 E5 / M7 — token bake cache.
 *
 * Compositing an LPC character costs ~17 layer draws, an item hash per
 * equipment layer and pixel readbacks for recolours. Doing that for every
 * token on every frame (pre-M64) made each frame expensive. Instead each
 * distinct look is baked ONCE into a 64×64 offscreen canvas and a frame
 * costs one drawImage per token.
 *
 * Key: (appearanceKey, direction, anim, frame, status) where direction is
 * the token's own `facing` when it has one (`directionFor`), and status is
 * `tokenStatusKey(token)` — HP bucket, worst condition and the condition
 * set (glyphs), temp-HP and concentration auras. `frame` is reduced
 * modulo the look's animation cycle (learned from the first bake), so an
 * idle 2-frame body costs two bakes no matter how far the frame counter
 * runs.
 *
 * A token with a DM `imageUrl` uses the same cache under the key
 * `img:<url>|-|-|0|<hpState>` (`img:<imageId>@<url>|…` when the image
 * came from a campaign `statBlock.tokenImageId`, M65 M21): one bake
 * per image and HP bucket (facing,
 * animation and conditions do not change a static image). If that bake
 * fails (404, decode error) the key is remembered and `keyFor` falls back
 * to the token's LPC key, so a broken upload still shows the sprite.
 *
 * Baking is async and injected (`bake(character, {direction, frameIdx,
 * animation}) → Promise<{canvas, frameCycle?}>`); the default baker lives
 * in sprite/compositor.js. Lookups are synchronous so a frame never waits.
 */

import { tokenStatusKey } from './view.js';

const DEFAULT_MAX_ENTRIES = 512;

/**
 * The sprite row a token is baked and drawn with: its own `facing`, else
 * the frame-wide default (`local.direction`), else south.
 * @param {{facing?: string}} token
 * @param {{direction?: string}} [opts]
 * @returns {string}
 */
export function directionFor(token, opts = {}) {
  return token?.facing || opts?.direction || 'south';
}
const FALLBACK_CYCLE = 72;   // lcm of the LPC strip lengths (2, 4, 6, 8, 9) until a bake reports the real one

/**
 * Cache key of a DM token image bake. A campaign-authored image
 * (`token.imageId`, M65 M21) prefixes its id.
 * @param {{imageUrl: string, imageId?: string, hpState?: string}} token
 * @returns {string}
 */
export function imageKeyFor(token) {
  const id = token.imageId ? `${token.imageId}@` : '';
  return `img:${id}${token.imageUrl}|-|-|0|${token.hpState || 'healthy'}`;
}

/**
 * @param {{bake: (character: object, opts: {direction: string, frameIdx: number, animation: string|null}) => Promise<{canvas: any, frameCycle?: number}>,
 *          maxEntries?: number}} deps
 */
export function createTokenCache({ bake, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = new Map();     // key → canvas (LRU order)
  const pending = new Map();     // key → Promise<canvas|null>
  const cycles = new Map();      // `${appearanceKey}|${direction}|${anim}` → frame cycle
  const lastByEntity = new Map(); // entity id → last canvas drawn (avoids placeholder flicker)
  const deadSince = new Map();    // entity id → time its death fade started (-Infinity = no fade)
  const seenAlive = new Set();    // entity ids drawn while not dead
  const failed = new Set();      // keys whose bake failed (image tokens fall back on them)
  const stats = { bakes: 0, hits: 0, misses: 0, failures: 0 };

  function keyFor(token, opts = {}) {
    if (token?.imageUrl) {
      const imgKey = imageKeyFor(token);
      if (!failed.has(imgKey)) return imgKey;
    }
    const { anim = null, frameIdx = 0 } = opts;
    const direction = directionFor(token, opts);
    const base = `${token.appearanceKey}|${direction}|${anim || 'idle'}`;
    const cycle = cycles.get(base) || FALLBACK_CYCLE;
    const frame = ((Math.floor(frameIdx) % cycle) + cycle) % cycle;
    return `${base}|${frame}|${tokenStatusKey(token)}`;
  }

  function get(key) {
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key);
      entries.set(key, hit);
      stats.hits++;
      return hit;
    }
    stats.misses++;
    return null;
  }

  function store(key, canvas) {
    entries.set(key, canvas);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  /**
   * Bake `key` if it is not cached or in flight.
   * @returns {Promise<any|null>} the canvas (null when baking failed)
   */
  function ensure(key, character, { direction = 'south', anim = null, frameIdx = 0 } = {}) {
    if (entries.has(key)) return Promise.resolve(entries.get(key));
    if (pending.has(key)) return pending.get(key);
    const [appearanceKey] = key.split('|');
    const base = `${appearanceKey}|${direction}|${anim || 'idle'}`;
    const p = (async () => {
      try {
        stats.bakes++;
        const res = await bake(character, { direction, frameIdx, animation: anim });
        if (!res?.canvas) { failed.add(key); return null; }
        if (res.frameCycle > 0 && !cycles.has(base)) cycles.set(base, res.frameCycle);
        failed.delete(key);
        store(key, res.canvas);
        return res.canvas;
      } catch (err) {
        stats.failures++;
        failed.add(key);
        if (failed.size > maxEntries) failed.delete(failed.values().next().value);
        console.error(JSON.stringify({ event: 'battle.token.bake_failed', key, error: String(err?.message || err) }));
        return null;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, p);
    return p;
  }

  return {
    keyFor,
    get,
    ensure,
    /** True once a bake of `key` has failed. */
    hasFailed: (key) => failed.has(key),
    /** True while `key` is baking. */
    isPending: (key) => pending.has(key),
    /** Last canvas drawn for an entity (shown while its new look bakes). */
    lastFor: (entityId) => lastByEntity.get(String(entityId)) || null,
    setLast: (entityId, canvas) => { lastByEntity.set(String(entityId), canvas); },
    /**
     * Per-viewer death clock: when did `entityId`'s death fade start?
     * Call every frame with whether it is dead. A token first seen
     * already dead returns -Infinity (no fade); a revive resets it.
     * @param {string} entityId
     * @param {boolean} dead
     * @param {number} now
     * @returns {number|null} the fade start, or null when alive
     */
    deathStart(entityId, dead, now) {
      const id = String(entityId);
      if (!dead) { deadSince.delete(id); seenAlive.add(id); return null; }
      if (!deadSince.has(id)) deadSince.set(id, seenAlive.has(id) ? now : -Infinity);
      return deadSince.get(id);
    },
    /** Drop every bake of one look (equipment changed). */
    invalidate(appearanceKey) {
      for (const k of [...entries.keys()]) if (k.startsWith(`${appearanceKey}|`)) entries.delete(k);
      for (const k of [...cycles.keys()]) if (k.startsWith(`${appearanceKey}|`)) cycles.delete(k);
    },
    clear() { entries.clear(); cycles.clear(); lastByEntity.clear(); deadSince.clear(); seenAlive.clear(); failed.clear(); },
    get size() { return entries.size; },
    stats
  };
}
