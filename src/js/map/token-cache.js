/**
 * M64 E5 / M7 — token bake cache.
 *
 * Compositing an LPC character costs ~17 layer draws, an item hash per
 * equipment layer and pixel readbacks for recolours. Doing that for every
 * token on every frame (pre-M64) made each frame expensive. Instead each
 * distinct look is baked ONCE into a 64×64 offscreen canvas and a frame
 * costs one drawImage per token.
 *
 * Key: (appearanceKey, direction, anim, frame, status) where status is
 * `tokenStatusKey(token)` — HP bucket, worst condition and the condition
 * set (glyphs), temp-HP and concentration auras. `frame` is reduced
 * modulo the look's animation cycle (learned from the first bake), so an
 * idle 2-frame body costs two bakes no matter how far the frame counter
 * runs.
 *
 * Baking is async and injected (`bake(character, {direction, frameIdx,
 * animation}) → Promise<{canvas, frameCycle?}>`); the default baker lives
 * in sprite/compositor.js. Lookups are synchronous so a frame never waits.
 */

import { tokenStatusKey } from './view.js';

const DEFAULT_MAX_ENTRIES = 512;
const FALLBACK_CYCLE = 72;   // lcm of the LPC strip lengths (2, 4, 6, 8, 9) until a bake reports the real one

/**
 * @param {{bake: (character: object, opts: {direction: string, frameIdx: number, animation: string|null}) => Promise<{canvas: any, frameCycle?: number}>,
 *          maxEntries?: number}} deps
 */
export function createTokenCache({ bake, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = new Map();     // key → canvas (LRU order)
  const pending = new Map();     // key → Promise<canvas|null>
  const cycles = new Map();      // `${appearanceKey}|${direction}|${anim}` → frame cycle
  const lastByEntity = new Map(); // entity id → last canvas drawn (avoids placeholder flicker)
  const stats = { bakes: 0, hits: 0, misses: 0, failures: 0 };

  function keyFor(token, { direction = 'south', anim = null, frameIdx = 0 } = {}) {
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
        if (!res?.canvas) return null;
        if (res.frameCycle > 0 && !cycles.has(base)) cycles.set(base, res.frameCycle);
        store(key, res.canvas);
        return res.canvas;
      } catch (err) {
        stats.failures++;
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
    /** True while `key` is baking. */
    isPending: (key) => pending.has(key),
    /** Last canvas drawn for an entity (shown while its new look bakes). */
    lastFor: (entityId) => lastByEntity.get(String(entityId)) || null,
    setLast: (entityId, canvas) => { lastByEntity.set(String(entityId), canvas); },
    /** Drop every bake of one look (equipment changed). */
    invalidate(appearanceKey) {
      for (const k of [...entries.keys()]) if (k.startsWith(`${appearanceKey}|`)) entries.delete(k);
      for (const k of [...cycles.keys()]) if (k.startsWith(`${appearanceKey}|`)) cycles.delete(k);
    },
    clear() { entries.clear(); cycles.clear(); lastByEntity.clear(); },
    get size() { return entries.size; },
    stats
  };
}
