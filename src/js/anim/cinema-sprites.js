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
import { actorStateAt } from './fsm.js';

// M44.1 — Per-actor frame cycle. We pre-render five poses sampled
// from the LPC walk sheet:
//   IDLE_A / IDLE_B   alternating low-amplitude bob (alive feel)
//   WINDUP            mid-stride frame; reads as a pulled-back stance
//   STRIKE            extreme stride; reads as a committed lunge
//   HURT (M44.3)      off-balance stride; reads as a flinch / recoil
// These map to LPC walk.png column indices below.
const FRAME_IDLE_A = 0;
const FRAME_IDLE_B = 1;
const FRAME_WINDUP = 2;
const FRAME_STRIKE = 6;
const FRAME_HURT   = 4;
const ACTOR_FRAMES = [FRAME_IDLE_A, FRAME_IDLE_B, FRAME_WINDUP, FRAME_STRIKE, FRAME_HURT];

// Idle bob period in ms — alternation between IDLE_A and IDLE_B.
const IDLE_BOB_MS = 280;

// M44.5 — Cache keyed by `${id}|${direction}` so the same entity can
// be pre-rendered in both east-facing (attacker) and west-facing
// (defender) directions without one overwriting the other. The
// composite key also lets us swap an actor between rounds and have
// them re-face if their role changes.
// `${id}|${direction}` → { frames: Map<frameIdx, Canvas>, scale, direction }
const cache = new Map();
function cacheKey(id, direction) { return `${id}|${direction || 'south'}`; }

/**
 * M44.5 — Map cinema role → LPC sheet direction.
 *   attacker (left side, faces RIGHT)  → 'east'
 *   defender (right side, faces LEFT)  → 'west'
 */
export function directionForActor(actor) {
  if (actor === 'attacker') return 'east';
  if (actor === 'defender') return 'west';
  return 'south';
}

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
  const key = cacheKey(character.id, direction);
  const cached = cache.get(key);
  if (cached && cached.scale === scale) return cached;
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
 * Pick the right LPC frame index for the current swing phase. Pure.
 * `actor` distinguishes attacker (cycles through windup/strike) from
 * defender (stays in idle unless an explicit hurt phase is supplied).
 *
 * Returns just the current frame index. For the M46 cross-fade
 * renderer, use `pickActorFrameBlended` instead — it returns the
 * previous frame + blend factor alongside.
 */
export function pickActorFrame(snapshot = {}, actor = 'attacker') {
  const phase = snapshot._phase || 'idle';
  const t = Number.isFinite(snapshot._t) ? snapshot._t : 0;
  if (actor === 'attacker') {
    if (phase === 'windup') return FRAME_WINDUP;
    if (phase === 'strike') return FRAME_STRIKE;
  }
  if (actor === 'defender' && phase === 'hurt') return FRAME_HURT;
  // Idle / recover / defender non-hurt phases — bob between A and B
  const half = Math.floor(t / IDLE_BOB_MS) % 2;
  return half === 0 ? FRAME_IDLE_A : FRAME_IDLE_B;
}

/**
 * M46 — Frame interpolation: return the current frame, the previous
 * frame, and a 0..1 blend factor. The renderer cross-fades the two
 * sprite frames at the given blend, turning what was a 5fps pose
 * cycle into perceptually-smooth motion.
 *
 * Delegates to the actor FSM (src/js/anim/fsm.js). Snapshot must
 * carry _t and _impactAt so the FSM can classify the phase.
 */
export function pickActorFrameBlended(snapshot = {}, actor = 'attacker') {
  const t = Number.isFinite(snapshot._t) ? snapshot._t : 0;
  // Pass non-finite impactAt straight through so the FSM's phase
  // classifier can fall back to 'idle' instead of mis-computing a
  // recover/strike window relative to a zero impact moment.
  const impactAt = snapshot._impactAt;
  const state = actorStateAt(actor, t, impactAt);
  return {
    frame: state.pose,
    prevFrame: state.prevPose,
    blend: state.blend,
    phase: state.phase
  };
}

/** Build a drawSprite(ctx, actor, anchor, snapshot, refInfo) callback
 *  that paints the pre-rendered LPC bitmap for each actor. `lookup`
 *  is a function (id, direction) → cache entry (defaults to the
 *  module cache). M44.5 — direction is derived from `actor` (attacker
 *  → east, defender → west) so the LPC sheet handles facing
 *  directly instead of the previous x-mirror hack. */
export function makeLpcDrawSprite({ lookup = defaultLookup } = {}) {
  return function drawSprite(ctx, actor, anchor, snapshot, refInfo) {
    const id = refInfo?.id ?? null;
    const direction = directionForActor(actor);
    const entry = id != null ? lookup(id, direction) : null;
    // M46 — Frame interpolation. Pick BOTH the current pose and the
    // pose we're transitioning from, plus a 0..1 blend. Snap-cut
    // callers (legacy pickActorFrame) still work: blend=1 means
    // "fully on current frame" which renders identically to the
    // single-frame path.
    const blended = pickActorFrameBlended(snapshot, actor);
    const buf = entry?.frames?.get(blended.frame)
             || entry?.frames?.get(FRAME_IDLE_A)
             || null;
    const prevBuf = entry?.frames?.get(blended.prevFrame) || null;
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
    // M46 — Squash-stretch on defender impact. For the first 120ms
    // of hurt, scale Y down and X up briefly so the body compresses
    // on the hit (anticipation principle in reverse — the hit itself
    // is the squash) then bounces back. Subtle: 12% deformation at
    // peak. Attacker doesn't squash.
    let sx = s, sy = s;
    if (actor === 'defender' && snapshot._phase === 'hurt') {
      const t = Number.isFinite(snapshot._t) ? snapshot._t : 0;
      const impactAt = Number.isFinite(snapshot._impactAt) ? snapshot._impactAt : t;
      const age = Math.max(0, t - impactAt);
      if (age < 120) {
        const u = age / 120;
        // Triangle envelope — peak at u=0.5, zero at u=0 and u=1
        const env = u < 0.5 ? u * 2 : (1 - u) * 2;
        const squash = env * 0.12;
        sx = s * (1 + squash);
        sy = s * (1 - squash);
      }
    }
    // M44.5 — No x-mirror. East row faces right; west row faces left.
    ctx.scale(sx, sy);
    ctx.imageSmoothingEnabled = false;
    // Anchor the sprite by its feet so the floor line passes through
    // the bottom edge. The LPC sheet is 64×64 logical, scaled up.
    const w = buf.width, h = buf.height;
    const baseAlpha = snapshot.alpha ?? 1;
    // M46 — Cross-fade: draw the previous-pose frame first at
    // (1 - blend), then the current pose at blend. When blend = 1
    // (held pose) only the current pose draws; when blend = 0.5
    // (mid-transition) both render at half alpha and read as a
    // smooth tween between the two poses. prevBuf may be null
    // during the brief preload window — fall through to current
    // frame only.
    if (prevBuf && blended.blend < 1 && prevBuf !== buf) {
      ctx.globalAlpha = baseAlpha * (1 - blended.blend);
      ctx.drawImage(prevBuf, -w / 2, -h);
    }
    ctx.globalAlpha = baseAlpha * (prevBuf && prevBuf !== buf ? blended.blend : 1);
    ctx.drawImage(buf, -w / 2, -h);
    ctx.globalAlpha = baseAlpha;
    // M44.3 + M46 — Hurt overlay: two-stage tint on the defender's
    // silhouette during the hurt phase.
    //   t in [0, 60ms]   : WHITE silhouette flash — the "punch" frame
    //                       that emphasises the impact. Fast in/out.
    //   t in [40, 220ms] : red tint pulse (existing).
    // Both use source-atop so transparent background is left alone.
    // The windows overlap briefly at 40-60ms so the white→red
    // transition reads as a smooth shift rather than a snap-cut.
    if (snapshot._phase === 'hurt') {
      const t = Number.isFinite(snapshot._t) ? snapshot._t : 0;
      const impactAt = Number.isFinite(snapshot._impactAt) ? snapshot._impactAt : t;
      const age = Math.max(0, t - impactAt);
      const prev = ctx.globalCompositeOperation;
      // M46 — White punch frame
      if (age < 80) {
        const u = age / 80;
        const whiteAlpha = 0.85 * (1 - u) * (u < 0.5 ? u * 2 : 1);
        if (whiteAlpha > 0.02) {
          ctx.globalCompositeOperation = 'source-atop';
          ctx.globalAlpha = whiteAlpha;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(-w / 2, -h, w, h);
        }
      }
      // Red hurt pulse (kicks in around the time the white fades out).
      if (age > 30) {
        const u = Math.min(1, (age - 30) / 190);
        const alpha = 0.6 * Math.sin(u * Math.PI);
        if (alpha > 0.02) {
          ctx.globalCompositeOperation = 'source-atop';
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#ef4444';
          ctx.fillRect(-w / 2, -h, w, h);
        }
      }
      ctx.globalCompositeOperation = prev;
    }
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

function defaultLookup(id, direction) {
  if (id == null) return null;
  // M44.5 — Direction-aware lookup. Falls back to a south-facing
  // entry if a directional one isn't cached (preload should populate
  // east/west; this fallback keeps drawSprite functional during the
  // brief async preload window).
  const direct = cache.get(cacheKey(id, direction));
  if (direct) return direct;
  return cache.get(cacheKey(id, 'south'))
      || cache.get(cacheKey(id, 'east'))
      || cache.get(cacheKey(id, 'west'))
      || null;
}

/** Drop every cached entry for `id` (all directions). */
export function invalidateActorSprite(id) {
  if (id == null) return;
  const idStr = String(id);
  for (const key of [...cache.keys()]) {
    if (key.startsWith(idStr + '|')) cache.delete(key);
  }
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
