/**
 * M44 — LPC sprite integration for the cinema.
 *
 * The cinema renderer (M43.2) draws sprites via a swappable `drawSprite`
 * callback. By default it paints a stylized silhouette so the module
 * works headless / in tests. The versus integration wants the real
 * LPC sprite — same look as the grid view, but rendered into the
 * pixel-space cinema scene.
 *
 * `renderSprite` is async (image-cache + composition), so we cannot
 * call it during the rAF draw loop. Instead we pre-render each actor
 * into an off-screen canvas ONCE when actors change, then the draw
 * callback paints that bitmap synchronously each frame.
 *
 * Buffer cache keyed by actor id + a snapshot of the visual fields
 * the LPC compositor reads. Stale buffers are dropped when an actor
 * is replaced (a new round with a different monster).
 *
 * Monsters use buildMonsterCharacter() to produce an LPC-compatible
 * character record; PCs pass through directly.
 */

import { renderSprite } from '../sprite/compositor.js';
import { MONSTER_PRESETS, buildMonsterCharacter } from '../scene/monster-presets.js';

// M44.1 — Per-actor frame cycle. We pre-render four poses sampled
// from the LPC walk sheet:
//   IDLE_A / IDLE_B   alternating low-amplitude bob (alive feel)
//   WINDUP            mid-stride frame; reads as a pulled-back stance
//   STRIKE            extreme stride; reads as a committed lunge
// These map to LPC walk.png column indices below.
const FRAME_IDLE_A = 0;
const FRAME_IDLE_B = 1;
const FRAME_WINDUP = 2;
const FRAME_STRIKE = 6;
const ACTOR_FRAMES = [FRAME_IDLE_A, FRAME_IDLE_B, FRAME_WINDUP, FRAME_STRIKE];

// Idle bob period in ms — alternation between IDLE_A and IDLE_B.
const IDLE_BOB_MS = 280;

// id → { frames: Map<frameIdx, Canvas>, scale, direction }
const cache = new Map();

/**
 * Normalize an attacker/defender entity into a character record the
 * LPC compositor can render. PCs pass through; monsters get wrapped.
 * Returns null if no renderable record can be built.
 */
export function toLpcCharacter(entity) {
  if (!entity) return null;
  if (entity._isMonster || entity.presetSlug) {
    const preset = MONSTER_PRESETS[entity.presetSlug] || null;
    if (!preset) return null;
    return buildMonsterCharacter(preset, entity.id);
  }
  return entity;
}

/**
 * Pre-render `entity` into off-screen canvases — one per pose frame
 * (idle-a, idle-b, windup, strike). The draw loop then synchronously
 * picks a frame each tick based on the swing phase.
 *
 * Subsequent calls for the same entity (by id) reuse the cached
 * buffers unless scale/direction changed. `scale` controls the LPC
 * render scale; the cinema typically renders at 3-4 so the 64×64
 * sprite fills a decent portion of the scene.
 */
export async function preloadActorSprite(entity, { scale = 3, direction = 'south' } = {}) {
  const character = toLpcCharacter(entity);
  if (!character || !character.id) return null;
  const key = String(character.id);
  const cached = cache.get(key);
  if (cached && cached.scale === scale && cached.direction === direction) {
    return cached;
  }
  const frames = new Map();
  for (const idx of ACTOR_FRAMES) {
    const off = makeOffscreenCanvas();
    if (!off) continue;
    await renderSprite(off, character, { scale, direction, frameIdx: idx });
    frames.set(idx, off);
  }
  if (frames.size === 0) return null;
  const entry = { frames, scale, direction };
  cache.set(key, entry);
  return entry;
}

/**
 * Pick the right LPC frame index for the current swing phase. Pure —
 * snapshot._phase is one of 'idle'|'windup'|'strike'|'recover'; _t is
 * the timeline ms so the idle bob alternates frame A/B on a slow loop.
 * `actor` distinguishes attacker (cycles through windup/strike) from
 * defender (stays in idle unless an explicit hurt phase is supplied).
 */
export function pickActorFrame(snapshot = {}, actor = 'attacker') {
  const phase = snapshot._phase || 'idle';
  const t = Number.isFinite(snapshot._t) ? snapshot._t : 0;
  if (actor === 'attacker') {
    if (phase === 'windup') return FRAME_WINDUP;
    if (phase === 'strike') return FRAME_STRIKE;
  }
  // Idle / recover / defender most phases — bob between A and B
  const half = Math.floor(t / IDLE_BOB_MS) % 2;
  return half === 0 ? FRAME_IDLE_A : FRAME_IDLE_B;
}

/** Build a drawSprite(ctx, actor, anchor, snapshot, refInfo) callback
 *  that paints the pre-rendered LPC bitmap for each actor. `lookup`
 *  is a function id → cache entry (defaults to the module cache). */
export function makeLpcDrawSprite({ lookup = defaultLookup } = {}) {
  return function drawSprite(ctx, actor, anchor, snapshot, refInfo) {
    const id = refInfo?.id ?? null;
    const entry = id != null ? lookup(id) : null;
    const frameIdx = pickActorFrame(snapshot, actor);
    const buf = entry?.frames?.get(frameIdx)
             || entry?.frames?.get(FRAME_IDLE_A)
             || null;
    if (!buf) {
      // Fallback — a faint label so the missing sprite is debuggable
      ctx.save();
      ctx.translate(anchor.x, anchor.y);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(refInfo?.name || actor, 0, 0);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(anchor.x, anchor.y);
    ctx.rotate(snapshot.rotation || 0);
    const s = snapshot.scale || 1;
    // Mirror defender so they face the attacker
    ctx.scale(actor === 'defender' ? -s : s, s);
    ctx.globalAlpha = snapshot.alpha ?? 1;
    ctx.imageSmoothingEnabled = false;
    // Anchor the sprite by its feet so the floor line passes through
    // the bottom edge. The LPC sheet is 64×64 logical, scaled up.
    const w = buf.width, h = buf.height;
    ctx.drawImage(buf, -w / 2, -h);
    ctx.restore();
    // Name label — un-rotate, un-mirror so text stays readable
    ctx.save();
    ctx.translate(anchor.x, anchor.y + 14);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(refInfo?.name || actor, 0, 0);
    ctx.restore();
  };
}

function defaultLookup(id) {
  return cache.get(String(id)) || null;
}

/** Drop a single actor's cached buffer (e.g. when an actor swaps out). */
export function invalidateActorSprite(id) {
  if (id != null) cache.delete(String(id));
}

/** Drop every cached buffer. */
export function clearActorSpriteCache() {
  cache.clear();
}

function makeOffscreenCanvas() {
  if (typeof document !== 'undefined' && document.createElement) {
    return document.createElement('canvas');
  }
  const OffCanvas = globalThis.OffscreenCanvas;
  if (typeof OffCanvas === 'function') return new OffCanvas(64, 64);
  return null;
}
