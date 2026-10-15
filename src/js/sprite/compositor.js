import { FRAME, SLOT_COLORS, SLOT_BOXES, buildRenderPlan, getFrame } from './lpc-config.js';
import { loadImage } from './image-cache.js';
import { generateItemSprite, rarityToAuraTier } from './item-generator.js';
import { paintGeneratedBackground, drawMapImage, drawGridLines, paintTerrainOverlay } from '../scene/map-render.js';
import { asTerrain } from '../map/terrain.js';
import { WORLD_CELL_PX, MAX_CANVAS_PIXELS, createCamera, cameraTransform, sizeCanvasToViewport, visibleCellRange } from '../map/camera.js';
import { legacySceneToView, characterForToken } from '../map/view.js';
import { MONSTER_PRESETS, buildMonsterCharacter } from '../scene/monster-presets.js';
import { createTokenCache } from '../map/token-cache.js';
import { applyFilterMatrix, parseCssFilter } from './filter-matrix.js';

// Tier ranks: higher beats lower. Used to pick the single character-level aura.
const RARITY_RANK = {
  common: 0, uncommon: 1, rare: 2, very_rare: 3, legendary: 4, artifact: 5
};

/**
 * Render a sprite for a normalized character into the given canvas.
 * Output is rendered at integer scale to preserve pixel-art crispness.
 *
 * `direction` (Phase D) is one of 'north'|'west'|'south'|'east' and selects
 * which row of every layer's source sheet is sampled. Defaults to 'south'
 * (front-facing) to preserve all pre-D1 callers without changes. Derived-
 * item poses are tuned for south only — non-south directions skip them.
 */
/**
 * `frameIdx` (Phase L — animation): when non-zero, samples that frame
 * from each layer's south-row strip. Per-layer frame count is computed
 * from the loaded image dimensions (img.width / sw), so a 2-frame idle
 * sheet bobs 0→1, a 9-frame walk strides 0→8, etc. Each layer wraps
 * independently — they desync slightly because sheets have different
 * frame counts, which reads as "alive" rather than "marching in step".
 */
export async function renderSprite(canvas, character, { scale = 6, direction = 'south', frameIdx = 0, excludeSlots = null, includeSlots = null, animation = null } = {}) {
  const outW = FRAME * scale;
  const outH = FRAME * scale;
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, outW, outH);
  const result = await drawCharacterAt(ctx, character, { x: 0, y: 0, scale, direction, frameIdx, excludeSlots, includeSlots, animation });
  return { canvas, plan: result.plan, generatedCount: result.generatedCount };
}

/**
 * M2 / M64 M5 — render the battle grid.
 *
 * Two call shapes:
 *
 *   renderBattleScene(canvas, view, local)            — M64
 *     `view`  is the read-only RenderView (map/view.js, built by
 *             projectBattleView). It is never mutated; a deep-frozen
 *             view is fine.
 *     `local` is per-viewer presentation state, also never mutated:
 *       { camera,        // map/camera.js; absent ⇒ canvas sized to the world at zoom 1
 *         ownEntityId,   // ring under the viewer's own token
 *         hover,         // {col,row} cell highlight
 *         pathPreview,   // {cells:[{col,row}], legal, costFt}
 *         aoePreview,    // {cells:[{col,row}], color?, strokeColor?}
 *         selectionId,   // cyan outline
 *         animations,    // Map<entityId, {kind:'attack'|'hurt', startedAt, duration}>
 *         popups,        // [{targetId, amount, startedAt, duration}]
 *         effects,       // scene/effects.js descriptors
 *         dm: {showTerrain, showHidden, showFogMask},
 *         showTerrain,   // players: blocked/difficult overlay
 *         grid: {visible, color},
 *         direction, frameIdx,                 // sprite facing + animation frame
 *         appearances,   // Map<appearanceKey, character record>
 *         resolveAppearance(key, token),       // optional; default handles monster:<slug>
 *         requestRedraw(),                     // called when an async asset becomes ready
 *         now }          // timestamp for overlays (defaults to performance.now())
 *
 *   renderBattleScene(canvas, characters, scene, opts) — legacy (main.js
 *     today); adapted through legacySceneToView, output unchanged.
 *
 * Draw order: background → grid → terrain overlay → AoE / path previews →
 * tokens → (fog) → selection / turn / hover / flashes / popups / effects.
 * The renderer imports no scene-state mutator (asserted by a test).
 *
 * @returns {Promise<{canvas, generatedCount: number, cellCount: number, needsRedraw: boolean}>}
 */
export function renderBattleScene(canvas, viewOrCharacters, localOrScene, legacyOpts) {
  if (Array.isArray(viewOrCharacters)) {
    const { view, local } = legacySceneToView(viewOrCharacters, localOrScene, legacyOpts || {});
    // The legacy caller expects a complete frame: bake first, then draw.
    return prepareBattleView(view, local).then(() => renderBattleView(canvas, view, local));
  }
  return renderBattleView(canvas, viewOrCharacters, localOrScene || {});
}

/**
 * M64 M7 — warm every asset a frame of `view` needs (background image,
 * one token bake per visible token) so the next renderBattleScene call
 * draws a complete frame. Useful before exports / screenshots; the live
 * loop does not need it (misses bake in the background and call
 * local.requestRedraw when ready).
 * @param {object} view — RenderView
 * @param {object} [local]
 * @returns {Promise<void>}
 */
export async function prepareBattleView(view, local = {}) {
  const jobs = [];
  const src = view.map?.kind === 'image' ? (view.map.url || view.map.image) : null;
  if (src) jobs.push(loadCachedImage(src).catch(() => null));
  const cache = local.tokenCache || defaultTokenCache;
  const frameOpts = tokenFrameOpts(local);
  for (const token of view.tokens) {
    if (token.hidden && !local.dm?.showHidden) continue;
    const base = resolveTokenCharacter(token, local);
    if (!base) continue;
    const key = cache.keyFor(token, frameOpts);
    if (cache.get(key)) continue;
    jobs.push(cache.ensure(key, characterForToken(base, token), frameOpts).then(async (canvas) => {
      // The first bake teaches the cache the look's frame cycle, which can
      // change the key; make sure the frame we will draw is baked too.
      const k2 = cache.keyFor(token, frameOpts);
      if (canvas && k2 !== key && !cache.get(k2)) await cache.ensure(k2, characterForToken(base, token), frameOpts);
    }));
  }
  await Promise.all(jobs);
}

function tokenFrameOpts(local) {
  return { direction: local.direction || 'south', anim: local.anim || null, frameIdx: local.frameIdx || 0 };
}

const W = WORLD_CELL_PX;

/** Size the canvas for the camera; returns the backing-store pixel ratio. */
function sizeBattleCanvas(canvas, camera, worldW, worldH) {
  if (camera.viewW > 0 && camera.viewH > 0) {
    return sizeCanvasToViewport(canvas, camera.viewW, camera.viewH, camera.dpr || 1).pixelRatio;
  }
  const w = Math.max(1, Math.round(worldW * camera.zoom));
  const h = Math.max(1, Math.round(worldH * camera.zoom));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return 1;
}

/** Resolve a token's character record (look) for drawing. */
function resolveTokenCharacter(token, local) {
  const key = token.appearanceKey;
  const fromLocal = local.resolveAppearance?.(key, token);
  if (fromLocal !== undefined) return fromLocal;
  const known = local.appearances?.get?.(key);
  if (known) return known;
  if (typeof key === 'string' && key.startsWith('monster:')) {
    const preset = MONSTER_PRESETS[key.slice(8)];
    if (preset) return buildMonsterCharacter(preset, token.id);
  }
  return null;
}

function renderBattleView(canvas, view, local) {
  const cols = view.grid.cols;
  const rows = view.grid.rows;
  const worldW = cols * W;
  const worldH = rows * W;
  const camera = local.camera || createCamera({ zoom: local.legacyZoom || 1, minZoom: 0.01, maxZoom: 100 });
  const ctx = canvas.getContext('2d');
  const pixelRatio = sizeBattleCanvas(canvas, camera, worldW, worldH);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(...cameraTransform(camera, pixelRatio));
  ctx.imageSmoothingEnabled = false;
  const px = 1 / camera.zoom;                 // one CSS pixel in world units
  _shadowScale = camera.zoom * pixelRatio;    // shadowBlur ignores the transform
  const now = Number.isFinite(local.now) ? local.now : performance.now();

  // 1. Background (an image still decoding shows the fill colour and asks
  //    for a redraw when ready).
  drawBattleBackground(ctx, view.map, cols, rows, camera.zoom * pixelRatio, local.requestRedraw);

  // 2. Grid lines, one CSS pixel wide at any zoom.
  if (local.grid?.visible !== false) {
    drawGridLines(ctx, cols, rows, W, { color: local.grid?.color || 'rgba(255,255,255,0.18)', lineWidth: px });
  }

  // 2.5 M64 M6 — terrain overlay: every flag for the DM, movement flags
  //     for players who toggle it on.
  const terrainMode = local.dm?.showTerrain ? 'dm' : local.showTerrain ? 'player' : null;
  if (terrainMode && view.terrain) {
    paintTerrainOverlay(ctx, asTerrain(view.terrain), W, {
      mode: terrainMode, lineWidth: px, range: visibleCellRange(camera, cols, rows, W)
    });
  }

  // 3. Previews under the tokens.
  if (local.aoePreview?.cells?.length) drawCellSetOutline(ctx, local.aoePreview, px);
  if (local.pathPreview?.cells?.length) drawPathPreview(ctx, local.pathPreview, px);

  // 4. Tokens. Lunge / recoil displacement first.
  const displacementById = effectDisplacements(local.effects, now);
  const showHidden = !!local.dm?.showHidden;
  const drawnPos = new Map();
  const cache = local.tokenCache || defaultTokenCache;
  const frameOpts = tokenFrameOpts(local);
  const bakesBefore = cache.stats.bakes;
  let pendingBakes = 0;
  let drawn = 0;
  for (const token of view.tokens) {
    if (token.hidden && !showHidden) continue;
    const disp = displacementById.get(token.id) || { x: 0, y: 0 };
    const x = token.col * W + disp.x;
    const y = token.row * W + disp.y;
    drawnPos.set(token.id, { col: token.col, row: token.row });
    if (local.ownEntityId != null && String(local.ownEntityId) === token.id) drawOwnMarker(ctx, x, y, px);
    // M64 M7 — one drawImage of a baked 64×64 bitmap per token. A miss
    // bakes in the background and keeps showing the previous bitmap.
    const key = cache.keyFor(token, frameOpts);
    let bmp = cache.get(key);
    if (bmp) {
      cache.setLast(token.id, bmp);
    } else {
      const base = resolveTokenCharacter(token, local);
      if (base) {
        pendingBakes++;
        if (!cache.isPending(key)) {
          cache.ensure(key, characterForToken(base, token), frameOpts)
            .then(c => { if (c) local.requestRedraw?.(); });
        }
      }
      bmp = cache.lastFor(token.id);
    }
    if (token.hidden) { ctx.save(); ctx.globalAlpha = 0.5; }
    if (bmp) ctx.drawImage(bmp, x, y, W, W);
    else drawTokenPlaceholder(ctx, token, x, y, px);
    if (token.hidden) ctx.restore();
    drawn++;
  }

  // 5. Overlays above the tokens.
  const at = (id) => drawnPos.get(String(id)) || null;
  if (local.selectionId != null) {
    const pos = at(local.selectionId);
    if (pos) drawCellOutline(ctx, pos.col * W, pos.row * W, W, '#22d3ee', 4 * px);
  }
  if (view.activeId != null && view.activeId !== local.selectionId) {
    const pos = at(view.activeId);
    if (pos) drawCellOutline(ctx, pos.col * W, pos.row * W, W, '#fbbf24', 3 * px);
  }
  if (local.hover && Number.isFinite(local.hover.col)) {
    drawCellOutline(ctx, local.hover.col * W, local.hover.row * W, W, 'rgba(255,255,255,0.6)', 2 * px);
  }
  let live = false;
  if (local.animations) {
    for (const [id, anim] of local.animations) {
      const elapsed = now - anim.startedAt;
      if (elapsed < 0 || elapsed > anim.duration) continue;
      live = true;
      const t = elapsed / anim.duration;
      const pos = at(id);
      if (!pos) continue;
      if (anim.kind === 'attack') drawCellGlow(ctx, pos.col * W, pos.row * W, W, '#fb923c', Math.sin(t * Math.PI) * 0.55);
      else if (anim.kind === 'hurt') drawCellGlow(ctx, pos.col * W, pos.row * W, W, '#dc2626', (1 - t) * 0.75);
    }
  }
  if (local.popups && local.popups.length > 0) {
    for (const p of local.popups) {
      const elapsed = now - p.startedAt;
      if (elapsed < 0 || elapsed > p.duration) continue;
      live = true;
      const t = elapsed / p.duration;
      const pos = at(p.targetId);
      if (!pos) continue;
      const fontSize = Math.max(18 * px, W * 0.22);
      drawDamageNumber(ctx, pos.col * W + W / 2, pos.row * W + W * 0.2 - t * W * 0.55, p.amount, 1 - t * 0.85, fontSize, px);
    }
  }
  if (Array.isArray(local.effects) && local.effects.length > 0) {
    for (const e of local.effects) {
      const elapsed = now - e.startedAt;
      if (elapsed < 0 || elapsed > e.duration) continue;
      live = true;
      renderEffect(ctx, e, elapsed / e.duration, W);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, generatedCount: cache.stats.bakes - bakesBefore, cellCount: drawn, needsRedraw: live, pendingBakes };
}

/** Background for every map kind, in world units. Synchronous. */
function drawBattleBackground(ctx, map, cols, rows, deviceScale, requestRedraw) {
  const worldW = cols * W;
  const worldH = rows * W;
  ctx.fillStyle = map?.color || '#3d5a3d';
  ctx.fillRect(0, 0, worldW, worldH);
  if (map?.kind === 'image') {
    const src = map.url || map.image;
    if (!src) return;
    const img = loadedImage(src);
    if (img) drawMapImage(ctx, img, map, cols, rows, W);
    else if (!imageFailed(src)) loadCachedImage(src).then(() => requestRedraw?.(), () => {});
  } else if (map?.kind === 'generated') {
    // Painted once per (biome, seed, dims, cell size) and blitted. The
    // paint resolution follows the device cell size, capped so the
    // offscreen canvas stays under the iOS area limit.
    const areaCap = Math.floor(Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, cols * rows)));
    const cellPx = Math.max(16, Math.min(192, areaCap, Math.ceil((W * deviceScale) / 32) * 32));
    const off = getGeneratedMapCanvas({ cols, rows, map }, cols * cellPx, rows * cellPx, cellPx);
    if (off) ctx.drawImage(off, 0, 0, worldW, worldH);
  }
}

/** Lunge / recoil sprite offsets (world units) keyed by entity id. */
function effectDisplacements(effects, now) {
  const out = new Map();
  if (!Array.isArray(effects)) return out;
  for (const e of effects) {
    if (e.kind !== 'lunge' && e.kind !== 'recoil') continue;
    const elapsed = now - e.startedAt;
    if (elapsed < 0 || elapsed > e.duration) continue;
    const magnitude = Math.sin((elapsed / e.duration) * Math.PI) * W * 0.28;
    const dir = DIR_VEC[e.direction] || DIR_VEC.east;
    const id = String(e.entityId);
    const cur = out.get(id) || { x: 0, y: 0 };
    out.set(id, { x: cur.x + dir.dc * magnitude, y: cur.y + dir.dr * magnitude });
  }
  return out;
}

/** Translucent fill + outside-edge outline for a set of cells (AoE). */
function drawCellSetOutline(ctx, shape, px) {
  const cellSet = new Set(shape.cells.map(c => `${c.col},${c.row}`));
  ctx.save();
  ctx.fillStyle = shape.color || 'rgba(96,165,250,0.30)';
  for (const { col, row } of shape.cells) ctx.fillRect(col * W, row * W, W, W);
  ctx.strokeStyle = shape.strokeColor || 'rgba(96,165,250,0.90)';
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  for (const { col, row } of shape.cells) {
    const x = col * W, y = row * W;
    if (!cellSet.has(`${col},${row - 1}`)) { ctx.moveTo(x, y); ctx.lineTo(x + W, y); }
    if (!cellSet.has(`${col},${row + 1}`)) { ctx.moveTo(x, y + W); ctx.lineTo(x + W, y + W); }
    if (!cellSet.has(`${col - 1},${row}`)) { ctx.moveTo(x, y); ctx.lineTo(x, y + W); }
    if (!cellSet.has(`${col + 1},${row}`)) { ctx.moveTo(x + W, y); ctx.lineTo(x + W, y + W); }
  }
  ctx.stroke();
  ctx.restore();
}

/** Planned move: tinted cells, a polyline through the centres, the cost. */
function drawPathPreview(ctx, preview, px) {
  const ok = preview.legal !== false;
  const fill = ok ? 'rgba(74,222,128,0.22)' : 'rgba(248,113,113,0.25)';
  const stroke = ok ? 'rgba(74,222,128,0.95)' : 'rgba(248,113,113,0.95)';
  ctx.save();
  ctx.fillStyle = fill;
  for (const c of preview.cells) ctx.fillRect(c.col * W, c.row * W, W, W);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 3 * px;
  ctx.beginPath();
  preview.cells.forEach((c, i) => {
    const x = c.col * W + W / 2, y = c.row * W + W / 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  if (Number.isFinite(preview.costFt)) {
    const last = preview.cells[preview.cells.length - 1];
    const fontSize = Math.max(12 * px, W * 0.2);
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2 * px, fontSize / 6);
    ctx.strokeStyle = '#000';
    const label = `${preview.costFt} ft`;
    ctx.strokeText(label, last.col * W + W / 2, last.row * W + W * 0.15);
    ctx.fillStyle = stroke;
    ctx.fillText(label, last.col * W + W / 2, last.row * W + W * 0.15);
  }
  ctx.restore();
}

/** Soft ring under the viewer's own token. */
function drawOwnMarker(ctx, x, y, px) {
  ctx.save();
  ctx.strokeStyle = 'rgba(250,204,21,0.85)';
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  ctx.ellipse(x + W / 2, y + W * 0.86, W * 0.32, W * 0.1, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Coloured disc + initial for a token whose look is not available yet. */
function drawTokenPlaceholder(ctx, token, x, y, px) {
  ctx.save();
  ctx.fillStyle = token.side === 'hostile' ? '#b91c1c' : '#2563eb';
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  ctx.arc(x + W / 2, y + W / 2, W * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(W * 0.34)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((token.name || '?').slice(0, 1).toUpperCase(), x + W / 2, y + W / 2);
  ctx.restore();
}

// Multiplier for shadowBlur, which (unlike every other size) is in device
// pixels and ignores the camera transform.
let _shadowScale = 1;

// M27 — Direction unit vectors for sprite displacement.
const DIR_VEC = {
  north: { dc: 0,  dr: -1 },
  south: { dc: 0,  dr: 1  },
  east:  { dc: 1,  dr: 0  },
  west:  { dc: -1, dr: 0  }
};

// M27 — Render a single effect descriptor at progress `t` (0..1).
// Each primitive has its own visual signature; colors come from the
// effect record (set per damage type by the effects module).
function renderEffect(ctx, e, t, cellPx) {
  switch (e.kind) {
    case 'slash-arc':     return renderSlashArc(ctx, e, t, cellPx);
    case 'thrust':        return renderThrust(ctx, e, t, cellPx);
    case 'bash':          return renderBash(ctx, e, t, cellPx);
    case 'projectile':    return renderProjectile(ctx, e, t, cellPx);
    case 'beam':          return renderBeam(ctx, e, t, cellPx);
    case 'burst':         return renderBurst(ctx, e, t, cellPx);
    case 'aoe-fill':      return renderAoeFill(ctx, e, t, cellPx);
    case 'divine-glow':   return renderDivineGlow(ctx, e, t, cellPx);
    case 'shadow-strike': return renderShadowStrike(ctx, e, t, cellPx);
    case 'glyph-rise':    return renderGlyphRise(ctx, e, t, cellPx);
    // lunge / recoil handled as sprite displacement, no overlay
    default: return;
  }
}

function cellCenter(pos, cellPx) {
  return { x: pos.col * cellPx + cellPx / 2, y: pos.row * cellPx + cellPx / 2 };
}

function renderSlashArc(ctx, e, t, cellPx) {
  const a = cellCenter(e.from, cellPx);
  const b = cellCenter(e.to, cellPx);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;     // unit perpendicular
  // M54b — the chosen swing varies the arc: a wider/narrower bow, the
  // reverse side, or (spin) a full loop around the target.
  const bow = SWING_GRID_BOW[e.swing] ?? 0.4;
  const alpha = Math.sin(t * Math.PI) * 0.85;
  ctx.save();
  ctx.strokeStyle = e.color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(3, cellPx * 0.08);
  ctx.shadowColor = e.color;
  ctx.shadowBlur = cellPx * 0.25 * _shadowScale;
  ctx.beginPath();
  if (e.swing === 'spin') {
    // a whirling loop centred on the target cell
    ctx.ellipse(b.x, b.y, cellPx * 0.55, cellPx * 0.42, Math.atan2(dy, dx), 0, Math.PI * 2);
  } else {
    const mid = { x: (a.x + b.x) / 2 + nx * cellPx * bow, y: (a.y + b.y) / 2 + ny * cellPx * bow };
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mid.x, mid.y, b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}

// Per-swing perpendicular bow for the top-down grid swoosh. Positive bows
// one way, negative the other (backslash/rising), small = flat (horizontal),
// large = deep (overhead). spin is handled separately (a loop).
const SWING_GRID_BOW = {
  diagonal: 0.4, overhead: 0.62, horizontal: 0.16,
  rising: -0.4, backslash: -0.55, thrust: 0.1
};

function renderThrust(ctx, e, t, cellPx) {
  const a = cellCenter(e.from, cellPx);
  const b = cellCenter(e.to, cellPx);
  // Extend halfway out then retract; peak extension at t=0.5
  const phase = t < 0.5 ? t * 2 : (1 - t) * 2;
  const tipX = a.x + (b.x - a.x) * phase;
  const tipY = a.y + (b.y - a.y) * phase;
  const alpha = 0.9 - Math.abs(0.5 - t) * 0.4;
  ctx.save();
  ctx.strokeStyle = e.color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(4, cellPx * 0.1);
  ctx.shadowColor = e.color;
  ctx.shadowBlur = cellPx * 0.3 * _shadowScale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.restore();
}

function renderBash(ctx, e, t, cellPx) {
  // Expanding ring at target position
  const c = cellCenter(e.to, cellPx);
  const radius = cellPx * 0.2 + t * cellPx * 0.45;
  const alpha = (1 - t) * 0.85;
  ctx.save();
  ctx.strokeStyle = e.color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(2, cellPx * 0.06) * (1 - t * 0.5);
  ctx.shadowColor = e.color;
  ctx.shadowBlur = cellPx * 0.2 * _shadowScale;
  ctx.beginPath();
  ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function renderProjectile(ctx, e, t, cellPx) {
  const a = cellCenter(e.from, cellPx);
  const b = cellCenter(e.to, cellPx);
  // Projectile head travels from a→b across t. Trail behind it.
  const hx = a.x + (b.x - a.x) * t;
  const hy = a.y + (b.y - a.y) * t;
  ctx.save();
  // Trail
  ctx.strokeStyle = e.color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(3, cellPx * 0.07);
  ctx.lineCap = 'round';
  ctx.shadowColor = e.color;
  ctx.shadowBlur = cellPx * 0.2 * _shadowScale;
  ctx.beginPath();
  // Trail tail at slightly behind position (15% of full trip)
  const tx = a.x + (b.x - a.x) * Math.max(0, t - 0.18);
  const ty = a.y + (b.y - a.y) * Math.max(0, t - 0.18);
  ctx.moveTo(tx, ty);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  // Head (bright dot)
  ctx.fillStyle = e.color;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(hx, hy, cellPx * 0.10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderBeam(ctx, e, t, cellPx) {
  const a = cellCenter(e.from, cellPx);
  const b = cellCenter(e.to, cellPx);
  // Beam fades in then out; thicker mid-animation
  const alpha = Math.sin(t * Math.PI) * 0.95;
  const thickness = Math.max(3, cellPx * 0.06) + Math.sin(t * Math.PI) * cellPx * 0.04;
  ctx.save();
  ctx.strokeStyle = e.color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = thickness;
  ctx.lineCap = 'round';
  ctx.shadowColor = e.color;
  ctx.shadowBlur = cellPx * 0.4 * _shadowScale;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

function renderBurst(ctx, e, t, cellPx) {
  // Two expanding rings + bright core
  const c = cellCenter(e.to, cellPx);
  ctx.save();
  ctx.shadowColor = e.color;
  ctx.shadowBlur = cellPx * 0.3 * _shadowScale;
  // Outer ring
  ctx.strokeStyle = e.color;
  ctx.globalAlpha = (1 - t) * 0.7;
  ctx.lineWidth = Math.max(2, cellPx * 0.05);
  ctx.beginPath();
  ctx.arc(c.x, c.y, cellPx * 0.15 + t * cellPx * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  // Inner core (filled)
  ctx.fillStyle = e.color;
  ctx.globalAlpha = (1 - t) * 0.85;
  ctx.beginPath();
  ctx.arc(c.x, c.y, cellPx * 0.18 * (1 - t * 0.6), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderAoeFill(ctx, e, t, cellPx) {
  if (!Array.isArray(e.cells)) return;
  // Pulse: fade in fast, hold, fade out
  const alpha = t < 0.2 ? t * 5 * 0.5 : 0.5 * (1 - (t - 0.2) / 0.8);
  ctx.save();
  ctx.fillStyle = e.color;
  ctx.globalAlpha = Math.max(0, alpha);
  for (const c of e.cells) {
    ctx.fillRect(c.col * cellPx, c.row * cellPx, cellPx, cellPx);
  }
  ctx.restore();
}

function renderDivineGlow(ctx, e, t, cellPx) {
  // Halo: bright ring that pulses outward + inward
  const c = cellCenter(e.to, cellPx);
  ctx.save();
  ctx.shadowColor = e.color;
  ctx.shadowBlur = cellPx * 0.5 * _shadowScale;
  ctx.strokeStyle = e.color;
  ctx.globalAlpha = Math.sin(t * Math.PI) * 0.9;
  ctx.lineWidth = Math.max(2, cellPx * 0.06);
  ctx.beginPath();
  ctx.arc(c.x, c.y, cellPx * 0.4 * (1 + Math.sin(t * Math.PI * 2) * 0.15), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function renderShadowStrike(ctx, e, t, cellPx) {
  // Dark vignette + red slash flash
  const c = cellCenter(e.to, cellPx);
  ctx.save();
  // Dark vignette
  const grd = ctx.createRadialGradient(c.x, c.y, cellPx * 0.1, c.x, c.y, cellPx * 0.7);
  grd.addColorStop(0, `rgba(0,0,0,${0.7 * (1 - t)})`);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(c.x - cellPx, c.y - cellPx, cellPx * 2, cellPx * 2);
  // Red flash on top
  ctx.strokeStyle = e.color || '#dc2626';
  ctx.globalAlpha = Math.sin(t * Math.PI) * 0.85;
  ctx.lineWidth = Math.max(3, cellPx * 0.08);
  ctx.beginPath();
  ctx.moveTo(c.x - cellPx * 0.35, c.y - cellPx * 0.25);
  ctx.lineTo(c.x + cellPx * 0.35, c.y + cellPx * 0.25);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(c.x - cellPx * 0.25, c.y + cellPx * 0.35);
  ctx.lineTo(c.x + cellPx * 0.25, c.y - cellPx * 0.35);
  ctx.stroke();
  ctx.restore();
}

function renderGlyphRise(ctx, e, t, cellPx) {
  const c = cellCenter(e.to, cellPx);
  const y = c.y - t * cellPx * 0.9;
  ctx.save();
  ctx.font = `${Math.floor(cellPx * 0.45)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = e.color;
  ctx.shadowBlur = cellPx * 0.3 * _shadowScale;
  ctx.globalAlpha = 1 - t * 0.85;
  ctx.fillStyle = e.color;
  ctx.fillText(e.glyph || '✨', c.x, y);
  ctx.restore();
}

// Procedural map cache. The generated terrain is painted ONCE to an
// offscreen canvas keyed by the inputs that change pixels (biome, seed,
// dimensions, cell size); the per-frame render loop then blits it with
// a single drawImage. Reroll → new seed → new key → one repaint. LRU
// capped so memory stays bounded across many scenes / rerolls.
const _genMapCache = new Map();
const _GEN_MAP_CACHE_MAX = 8;

/**
 * Return a cached offscreen canvas holding the painted generated map
 * for `scene`, building it on a miss. Returns null if a canvas can't be
 * created (no DOM) so the caller falls back to the flat colour fill.
 */
function getGeneratedMapCanvas(scene, totalW, totalH, cellPx) {
  const biome = scene.map?.biome || 'grass';
  const seed = scene.map?.seed >>> 0;
  const key = `${biome}|${seed}|${scene.cols}x${scene.rows}|${cellPx}`;
  const hit = _genMapCache.get(key);
  if (hit) {
    // Refresh LRU recency.
    _genMapCache.delete(key);
    _genMapCache.set(key, hit);
    return hit;
  }
  let off;
  const OffCanvas = globalThis.OffscreenCanvas;
  if (typeof document !== 'undefined' && document.createElement) {
    off = document.createElement('canvas');
  } else if (typeof OffCanvas === 'function') {
    off = new OffCanvas(totalW, totalH);
  } else {
    return null;
  }
  off.width = totalW;
  off.height = totalH;
  const offCtx = off.getContext('2d');
  if (!offCtx) return null;
  paintGeneratedBackground(offCtx, scene, cellPx);
  _genMapCache.set(key, off);
  // Evict oldest if over budget.
  if (_genMapCache.size > _GEN_MAP_CACHE_MAX) {
    const oldest = _genMapCache.keys().next().value;
    _genMapCache.delete(oldest);
  }
  return off;
}

// M2.5 — Image cache. Decoded HTMLImageElements keyed by data-url so
// continuous-render loops don't pay decode cost every frame.
const _bgImageCache = new Map();   // src → {promise, img, failed}
function loadCachedImage(src) {
  const cached = _bgImageCache.get(src);
  if (cached) return cached.promise;
  const rec = { promise: null, img: null, failed: false };
  rec.promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => { rec.img = img; resolve(img); };
    img.onerror = () => { rec.failed = true; reject(new Error('image decode failed')); };
    img.src = src;
  });
  rec.promise.catch(() => { rec.failed = true; });
  _bgImageCache.set(src, rec);
  return rec.promise;
}
/** The decoded image for `src`, or null while loading / after failure. */
function loadedImage(src) { return _bgImageCache.get(src)?.img || null; }
function imageFailed(src) { return !!_bgImageCache.get(src)?.failed; }

/** Draw a hollow rectangle outline at (x,y) of size sz, in the given color. */
function drawCellOutline(ctx, x, y, sz, color, width = 3) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.strokeRect(x + width / 2, y + width / 2, sz - width, sz - width);
  ctx.restore();
}

/** Fill a cell with a semi-transparent color (used for hit-flash + attack-glow). */
function drawCellGlow(ctx, x, y, sz, color, alpha) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.fillStyle = color;
  ctx.fillRect(x, y, sz, sz);
  ctx.restore();
}

/** Floating "-N" damage popup centred at (cx, cy). */
function drawDamageNumber(ctx, cx, cy, amount, alpha, fontSize, px = 1) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = amount > 0 ? `-${amount}` : `+${-amount}`;
  ctx.lineWidth = Math.max(2 * px, fontSize / 8);
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, cx, cy);
  ctx.fillStyle = amount > 0 ? '#fca5a5' : '#86efac';   // red for damage, green for heal
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

/**
 * M1 (Party Canvas) — render multiple characters horizontally on one
 * canvas. Each character keeps its own customizations / overrides /
 * subclass aura etc. — auras and silhouette transforms are bounded to
 * the cell so they don't bleed into neighbours.
 *
 * Canvas auto-resizes to (FRAME × N + gap × (N-1)) × scale by FRAME × scale.
 */
export async function renderPartyCanvas(canvas, characters, opts = {}) {
  const { scale = 6, direction = 'south', frameIdx = 0, cellGap = 8 } = opts;
  const list = (characters || []).filter(Boolean);
  const cellW = FRAME * scale;
  const cellH = FRAME * scale;
  const gapPx = cellGap * scale;
  const N = list.length;
  const totalW = N === 0 ? cellW : (cellW * N + gapPx * Math.max(0, N - 1));
  canvas.width = totalW;
  canvas.height = cellH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, totalW, cellH);
  let totalGenerated = 0;
  let x = 0;
  for (const ch of list) {
    const r = await drawCharacterAt(ctx, ch, { x, y: 0, scale, direction, frameIdx });
    totalGenerated += r.generatedCount;
    x += cellW + gapPx;
  }
  return { canvas, generatedCount: totalGenerated, cellCount: N };
}

// ---------------------------------------------------------------------
// M64 M7 — bake cache support
// ---------------------------------------------------------------------

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function lcm(a, b) { return (a / gcd(a, b)) * b; }

/** A scratch canvas (DOM or OffscreenCanvas); null when neither exists (Node). */
function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  const Off = globalThis.OffscreenCanvas;
  return typeof Off === 'function' ? new Off(w, h) : null;
}

// Recoloured LPC frames: (src, frame rect, filter) → canvas. Built once
// with getImageData + applyFilterMatrix, then plain drawImage forever.
const _recolourCache = new Map();
const _RECOLOUR_MAX = 512;
function recolouredFrame(img, f, srcKey, filter) {
  const key = `${srcKey}|${f.sx},${f.sy},${f.sw},${f.sh}|${filter}`;
  if (_recolourCache.has(key)) return _recolourCache.get(key);
  let out = null;
  const c = makeCanvas(f.sw, f.sh);
  const cctx = c?.getContext('2d', { willReadFrequently: true });
  if (cctx) {
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, 0, 0, f.sw, f.sh);
    const data = cctx.getImageData(0, 0, f.sw, f.sh);
    data.data.set(applyFilterMatrix(data.data, parseCssFilter(filter)));
    cctx.putImageData(data, 0, 0);
    out = c;
  }
  _recolourCache.set(key, out);
  if (_recolourCache.size > _RECOLOUR_MAX) _recolourCache.delete(_recolourCache.keys().next().value);
  return out;
}

// Item sprites memoised on the same inputs computeItemHash digests, so a
// cached item costs no SHA-1 (crypto.subtle.digest) per call.
const _itemSpriteMemo = new Map();
const _ITEM_MEMO_MAX = 256;
function memoItemSprite(item, src, slot) {
  const key = [item?.name || '', item?.rarity || 'common', item?.magical ? 1 : 0, item?.damageType || '', slot || '', src || ''].join('|');
  let p = _itemSpriteMemo.get(key);
  if (!p) {
    p = generateItemSprite(item, src, slot);
    _itemSpriteMemo.set(key, p);
    if (_itemSpriteMemo.size > _ITEM_MEMO_MAX) _itemSpriteMemo.delete(_itemSpriteMemo.keys().next().value);
  }
  return p;
}

/**
 * Default token baker: one 64×64 composite of `character`.
 * @param {object} character — render-ready (characterForToken)
 * @param {{direction?: string, frameIdx?: number, animation?: string|null}} opts
 * @returns {Promise<{canvas: any, frameCycle: number}>}
 */
export async function bakeTokenCanvas(character, { direction = 'south', frameIdx = 0, animation = null } = {}) {
  const canvas = makeCanvas(FRAME, FRAME);
  const ctx = canvas?.getContext('2d');
  if (!ctx) return { canvas: null, frameCycle: 1 };
  ctx.imageSmoothingEnabled = false;
  const r = await drawCharacterAt(ctx, character, { x: 0, y: 0, scale: 1, direction, frameIdx, animation });
  return { canvas, frameCycle: r.frameCycle || 1 };
}

/** The shared token bake cache used when local.tokenCache is not given. */
export const defaultTokenCache = createTokenCache({ bake: bakeTokenCanvas });

/**
 * Draw a single character at canvas position (x, y). Used by both
 * renderSprite (single, x=y=0) and renderPartyCanvas (offset per slot).
 *
 * Doesn't clear or resize the canvas — the caller owns that. Per-character
 * auras and the body-silhouette scale transform are bounded to a single
 * cell so multi-character canvases compose cleanly.
 */
async function drawCharacterAt(ctx, character, opts) {
  const { x, y, scale, direction, frameIdx, excludeSlots, includeSlots, animation } = opts;
  const plan = buildRenderPlan(character, { direction, animation });
  // M51 — Optionally drop layers by slot (e.g. the cinema renders the
  // body WITHOUT the baked weapon so it can swing the weapon separately).
  if (excludeSlots && excludeSlots.length) {
    const skip = new Set(excludeSlots);
    plan.layers = plan.layers.filter(l => !skip.has(l.slot));
  }
  // Path A — the complement: bake ONLY these slots (the idle bakes the loose
  // "follow-through" group — hair/cape/strapped weapons — on its own buffer
  // so secondary motion can lag it behind the body core).
  if (includeSlots && includeSlots.length) {
    const keep = new Set(includeSlots);
    plan.layers = plan.layers.filter(l => keep.has(l.slot));
  }
  const cellW = FRAME * scale;
  const cellH = FRAME * scale;

  // Pre-pass: kick off item-generator calls in parallel so the main loop
  // doesn't serialise N HTTP round-trips.
  const itemResults = new Map();
  const itemPromises = [];
  plan.layers.forEach((layer, idx) => {
    if (layer.kind === 'item' || layer.kind === 'derived-item') {
      itemPromises.push(
        memoItemSprite(layer.item, layer.src, layer.slot)
          .then(r => { itemResults.set(idx, r); })
          .catch(() => { itemResults.set(idx, { canvas: null, mutated: false }); })
      );
    }
  });
  await Promise.all(itemPromises);

  // Phase F1/H/E2 — backdrop auras, drawn into THIS cell only
  if (plan.subclassAura)      drawSolidAuraInBox(ctx, plan.subclassAura, 0.30, x, y, cellW, cellH);
  if (plan.concentrationAura) drawSolidAuraInBox(ctx, plan.concentrationAura, 0.45, x, y, cellW, cellH);
  if (plan.tempHpAura)        drawSolidAuraInBox(ctx, plan.tempHpAura, 0.25, x, y, cellW, cellH);

  // Rarity aura — bound to this character's cell
  drawBackdropAuraInBox(ctx, plan.layers, x, y, cellW, cellH);

  // Phase E1 — bodyWidth scale transform, pivoted on THIS cell's centre.
  const hints = {
    ...(character.visualHints || {}),
    bodyWidth: plan.bodyWidth || character.visualHints?.bodyWidth || 'normal'
  };
  ctx.save();   // pop after layer loop
  applyBodySilhouetteAt(ctx, hints, x, y, cellW, cellH);

  let generatedCount = 0;
  let frameCycle = 1;

  for (let idx = 0; idx < plan.layers.length; idx++) {
    const layer = plan.layers[idx];
    // M63 — a layer may pin its own frame (equipment with no sheet for the
    // current attack anim holds frame 0 instead of flickering its idle frames).
    const lfi = layer.frameIdx != null ? layer.frameIdx : frameIdx;
    if (layer.kind === 'lpc') {
      try {
        const img = await loadImage(layer.src);
        const f0 = getFrame(layer.src, direction, 0);
        const frameCount = Math.max(1, Math.floor(img.width / f0.sw));
        if (layer.frameIdx == null) frameCycle = lcm(frameCycle, frameCount);
        const f = getFrame(layer.src, direction, lfi % frameCount);
        // M64 M7 (P0-11) — recolour with pixel math, not ctx.filter
        // (disabled in Safari / iOS, which dropped every tint).
        const src = layer.filter ? recolouredFrame(img, f, layer.src, layer.filter) : null;
        if (src) ctx.drawImage(src, 0, 0, f.sw, f.sh, x, y, cellW, cellH);
        else ctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, x, y, cellW, cellH);
      } catch {
        drawProceduralSlotAt(ctx, layer.slot, scale, x, y);
      }
    } else if (layer.kind === 'item') {
      const result = itemResults.get(idx);
      try {
        if (result && result.mutated && result.canvas) {
          ctx.drawImage(result.canvas, x, y, cellW, cellH);
          generatedCount++;
        } else {
          const img = await loadImage(layer.src);
          const f0 = getFrame(layer.src, direction, 0);
          const frameCount = Math.max(1, Math.floor(img.width / f0.sw));
          if (layer.frameIdx == null) frameCycle = lcm(frameCycle, frameCount);
          const f = getFrame(layer.src, direction, lfi % frameCount);
          ctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, x, y, cellW, cellH);
        }
      } catch {
        drawProceduralSlotAt(ctx, layer.slot, scale, x, y);
      }
    } else if (layer.kind === 'derived-item') {
      const result = itemResults.get(idx);
      try {
        let sourceCanvas;
        if (result && result.mutated && result.canvas) {
          sourceCanvas = result.canvas;
          generatedCount++;
        } else {
          sourceCanvas = await extractIdleFrame(layer.src, direction);
        }
        drawDerivedItemAt(ctx, sourceCanvas, layer.pose, scale, x, y);
      } catch {
        drawProceduralSlotAt(ctx, layer.slot, scale, x, y);
      }
    } else if (layer.kind === 'rect') {
      drawProceduralSlotAt(ctx, layer.slot, scale, x, y, layer.overrideColor);
    } else if (layer.kind === 'effect') {
      drawGlowAt(ctx, layer.tint, scale, x, y);
    } else if (layer.kind === 'glyph') {
      drawGlyphAt(ctx, layer.glyph, layer.color, layer.position, scale, x, y);
    }
  }

  ctx.restore();   // pop body-silhouette transform

  if (hints.palette === 'saturated') {
    applySaturationBoostAt(ctx, x, y, cellW, cellH);
  }
  return { plan, generatedCount, frameCycle };
}

/**
 * Phase F1 — solid radial aura at a given color and alpha, bounded to
 * a character cell. The cell is anchored at (x,y) with size (w,h).
 * Used by the subclass-accent / concentration / temp-HP systems.
 */
function drawSolidAuraInBox(ctx, color, alpha, x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h * 0.55;
  const r  = w * 0.55;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, hexWithAlpha(color, alpha));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function drawBackdropAuraInBox(ctx, layers, x, y, w, h) {
  let bestRank = -1;
  let bestTier = null;
  for (const layer of layers) {
    if (layer.kind !== 'item' || !layer.item) continue;
    const tier = rarityToAuraTier(layer.item.rarity);
    if (!tier.color) continue;
    const key = String(layer.item.rarity || 'common').toLowerCase().replace(/\s+/g, '_');
    const rank = RARITY_RANK[key] ?? 0;
    if (rank > bestRank) { bestRank = rank; bestTier = tier; }
  }
  if (!bestTier) return;
  drawSolidAuraInBox(ctx, bestTier.color, bestTier.alpha, x, y, w, h);
}

function hexWithAlpha(hex, alpha) {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return hex;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Apply the bodyWidth scale transform (broad/thin) pivoted on the cell's
 * centre. Caller MUST have ctx.save()'d before calling and ctx.restore()
 * after the layer draws — the transform is left active so subsequent
 * drawImage() destination params (in cell-relative coords) are scaled.
 */
function applyBodySilhouetteAt(ctx, hints, x, y, w, h) {
  if (hints.bodyWidth !== 'broad' && hints.bodyWidth !== 'thin') return;
  const cx = x + w / 2;
  const factor = hints.bodyWidth === 'broad' ? 1.06 : 0.94;
  ctx.translate(cx, 0);
  ctx.scale(factor, 1);
  ctx.translate(-cx, 0);
}

function drawProceduralSlotAt(ctx, slot, scale, x, y, overrideColor) {
  const box = SLOT_BOXES[slot];
  if (!box) return;
  const color = overrideColor || SLOT_COLORS[slot] || '#94a3b8';
  ctx.fillStyle = color;
  ctx.fillRect(x + box.x * scale, y + box.y * scale, box.w * scale, box.h * scale);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = Math.max(1, scale / 3);
  ctx.strokeRect(x + box.x * scale + 0.5, y + box.y * scale + 0.5, box.w * scale - 1, box.h * scale - 1);
}

/**
 * Phase E4 / E2 / E3 — draw a small symbolic glyph at frame coordinates.
 * Supported glyphs:
 *   star     — Inspiration (E4)
 *   skull    — HP=0 / dead (E2)
 *   scratch  — wounded HP (E2)
 *   drip     — poisoned (E3)
 *   sweat    — frightened (E3)
 *   heart    — charmed (E3)
 *   bolt     — paralyzed (E3)
 *   stars    — stunned (E3)
 *   cross_x  — unconscious (E3)
 * Position is in 64×64 frame coords; scale is the outer compositor scale.
 */
function drawGlyphAt(ctx, glyph, color, position, scale, x, y) {
  const cx = x + (position?.x ?? 32) * scale;
  const cy = y + (position?.y ?? 4) * scale;
  switch (glyph) {
    case 'star':    drawStar(ctx, cx, cy, 3.5 * scale, 1.5 * scale, color || '#fbbf24'); break;
    case 'skull':   drawSkull(ctx, cx, cy, scale, color || '#dc2626'); break;
    case 'scratch': drawScratch(ctx, cx, cy, scale, color || '#dc2626'); break;
    case 'drip':    drawDrip(ctx, cx, cy, scale, color || '#16a34a'); break;
    case 'sweat':   drawDrip(ctx, cx, cy, scale, color || '#7dd3fc'); break;
    case 'heart':   drawHeart(ctx, cx, cy, scale, color || '#ec4899'); break;
    case 'bolt':    drawBolt(ctx, cx, cy, scale, color || '#facc15'); break;
    case 'stars':   drawTinyStars(ctx, cx, cy, scale, color || '#fbbf24'); break;
    case 'cross_x': drawCrossX(ctx, cx, cy, scale, color || '#dc2626'); break;
  }
}

/** Five-point star with dark outline for visibility on any background. */
function drawStar(ctx, cx, cy, outerR, innerR, fill) {
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#7c2d12';
  // Stroke width scales with the star's outer radius (drawStar isn't passed
  // the compositor scale directly). Min 1px so outlines render crisply.
  ctx.lineWidth = Math.max(1, outerR / 6);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Skull: simple round head + two eye sockets + jaw line. */
function drawSkull(ctx, cx, cy, scale, fill) {
  const r = 3 * scale;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1, scale / 4);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Eye sockets
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(cx - r * 0.35, cy - r * 0.1, r * 0.22, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.35, cy - r * 0.1, r * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Three slash marks like a claw scratch. */
function drawScratch(ctx, cx, cy, scale, fill) {
  ctx.save();
  ctx.strokeStyle = fill;
  ctx.lineWidth = Math.max(1.5, scale / 2.5);
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * 1.5 * scale;
    ctx.beginPath();
    ctx.moveTo(cx + off - scale, cy - 2 * scale);
    ctx.lineTo(cx + off + scale, cy + 2 * scale);
    ctx.stroke();
  }
  ctx.restore();
}

/** Droplet shape (poison drip / sweat). */
function drawDrip(ctx, cx, cy, scale, fill) {
  const r = 2 * scale;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1, scale / 5);
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.bezierCurveTo(cx + r, cy - r * 0.3, cx + r * 0.7, cy + r, cx, cy + r);
  ctx.bezierCurveTo(cx - r * 0.7, cy + r, cx - r, cy - r * 0.3, cx, cy - r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Two arcs forming a heart shape. */
function drawHeart(ctx, cx, cy, scale, fill) {
  const r = 2 * scale;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1, scale / 5);
  ctx.beginPath();
  ctx.moveTo(cx, cy + r);
  ctx.bezierCurveTo(cx - r * 1.4, cy - r * 0.2, cx - r * 0.4, cy - r * 1.3, cx, cy - r * 0.4);
  ctx.bezierCurveTo(cx + r * 0.4, cy - r * 1.3, cx + r * 1.4, cy - r * 0.2, cx, cy + r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Zig-zag lightning bolt. */
function drawBolt(ctx, cx, cy, scale, fill) {
  const r = 2.5 * scale;
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1, scale / 5);
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.3, cy - r);
  ctx.lineTo(cx + r * 0.4, cy - r * 0.2);
  ctx.lineTo(cx - r * 0.1, cy);
  ctx.lineTo(cx + r * 0.3, cy + r);
  ctx.lineTo(cx - r * 0.4, cy + r * 0.1);
  ctx.lineTo(cx + r * 0.1, cy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Three tiny stars in a row (stunned). */
function drawTinyStars(ctx, cx, cy, scale, fill) {
  for (let i = -1; i <= 1; i++) {
    drawStar(ctx, cx + i * 2 * scale, cy, 1.2 * scale, 0.5 * scale, fill);
  }
}

/** Two diagonal lines forming an X (unconscious / dead eyes). */
function drawCrossX(ctx, cx, cy, scale, fill) {
  const r = 2 * scale;
  ctx.save();
  ctx.strokeStyle = fill;
  ctx.lineWidth = Math.max(1.5, scale / 2);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r);
  ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r);
  ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
  ctx.restore();
}

function drawGlowAt(ctx, tint, scale, ox, oy) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const cx = ox + 16 * scale;
  const cy = oy + 30 * scale;
  const r = 12 * scale;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, tint);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

function applySaturationBoostAt(ctx, x, y, w, h) {
  // getImageData ignores the current transform, so map the cell rect to
  // device pixels first (the M64 camera draws under a world transform).
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  if (m && (m.a !== 1 || m.d !== 1 || m.e !== 0 || m.f !== 0)) {
    const nx = Math.round(m.a * x + m.e), ny = Math.round(m.d * y + m.f);
    w = Math.round(m.a * w); h = Math.round(m.d * h); x = nx; y = ny;
    if (w <= 0 || h <= 0) return;
  }
  const data = ctx.getImageData(x, y, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const max = Math.max(px[i], px[i + 1], px[i + 2]);
    const min = Math.min(px[i], px[i + 1], px[i + 2]);
    if (max === min) continue;
    const factor = 1.12;
    const avg = (px[i] + px[i + 1] + px[i + 2]) / 3;
    px[i]     = clamp(avg + (px[i] - avg) * factor);
    px[i + 1] = clamp(avg + (px[i + 1] - avg) * factor);
    px[i + 2] = clamp(avg + (px[i + 2] - avg) * factor);
  }
  ctx.putImageData(data, x, y);
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/**
 * Load an LPC source PNG and extract the idle frame for the requested
 * direction into a fresh off-screen canvas. Used by the derived-item path
 * when the item-generator produced no mutated canvas.
 */
async function extractIdleFrame(src, direction = 'south') {
  const img = await loadImage(src);
  const f = getFrame(src, direction);
  const c = document.createElement('canvas');
  c.width = FRAME;
  c.height = FRAME;
  // Explicit srgb so a downstream rotateImageNearestNeighbor reads the
  // expected color space (canvas color space is locked at first getContext)
  const ctx = c.getContext('2d', { colorSpace: 'srgb' });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, 0, 0, FRAME, FRAME);
  return c;
}

/**
 * Compute the bounding box of non-transparent pixels in a canvas.
 * Returns null if everything is transparent.
 */
export function findOpaqueBoundingBox(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Rotate a sub-region of a canvas by an angle (degrees) using nearest-
 * neighbor sampling at SOURCE resolution. Output is a fresh canvas sized
 * to the rotated bbox. Pure pixel operations — produces deterministic,
 * crisp pixel-art rotation (no sub-pixel sampling artifacts).
 *
 *   srcCanvas:  source canvas (typically 64×64)
 *   srcBbox:    {x, y, w, h} sub-region within srcCanvas to rotate
 *   angleDeg:   rotation angle in degrees (negative = counter-clockwise)
 */
export function rotateImageNearestNeighbor(srcCanvas, srcBbox, angleDeg) {
  if (angleDeg === 0 || angleDeg % 360 === 0) {
    // No rotation — extract bbox to a fresh canvas as-is
    const c = document.createElement('canvas');
    c.width = srcBbox.w;
    c.height = srcBbox.h;
    const ctx = c.getContext('2d', { colorSpace: 'srgb' });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      srcCanvas, srcBbox.x, srcBbox.y, srcBbox.w, srcBbox.h, 0, 0, srcBbox.w, srcBbox.h
    );
    return c;
  }

  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const w = srcBbox.w, h = srcBbox.h;

  // Output bbox by rotating the four corners of input bbox about its centre
  const corners = [[0, 0], [w, 0], [0, h], [w, h]];
  const rotated = corners.map(([x, y]) => {
    const cx = x - w / 2, cy = y - h / 2;
    return [cos * cx - sin * cy, sin * cx + cos * cy];
  });
  const minX = Math.min(...rotated.map(p => p[0]));
  const maxX = Math.max(...rotated.map(p => p[0]));
  const minY = Math.min(...rotated.map(p => p[1]));
  const maxY = Math.max(...rotated.map(p => p[1]));
  const outW = Math.max(1, Math.ceil(maxX - minX));
  const outH = Math.max(1, Math.ceil(maxY - minY));

  // Pull source pixels for the bbox region (explicit colorSpace for cross-
  // browser determinism)
  const srcCtx = srcCanvas.getContext('2d', { colorSpace: 'srgb' });
  const srcData = srcCtx.getImageData(srcBbox.x, srcBbox.y, w, h, { colorSpace: 'srgb' }).data;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext('2d', { colorSpace: 'srgb' });
  const outImage = outCtx.createImageData(outW, outH);
  const outPx = outImage.data;

  // Inverse rotation: for each output pixel, find which source pixel maps to it
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const cx = ox + minX;
      const cy = oy + minY;
      // R(-θ): sx = cos·cx + sin·cy ; sy = -sin·cx + cos·cy
      const sx = Math.round(cos * cx + sin * cy + w / 2);
      const sy = Math.round(-sin * cx + cos * cy + h / 2);
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      const srcIdx = (sy * w + sx) * 4;
      const outIdx = (oy * outW + ox) * 4;
      outPx[outIdx]     = srcData[srcIdx];
      outPx[outIdx + 1] = srcData[srcIdx + 1];
      outPx[outIdx + 2] = srcData[srcIdx + 2];
      outPx[outIdx + 3] = srcData[srcIdx + 3];
    }
  }
  outCtx.putImageData(outImage, 0, 0);
  return out;
}

/**
 * Draw a derived item: crop the source canvas to its weapon-only bounding
 * box, rotate at source resolution (crisp pixel art), then upscale to the
 * pose anchor in output coords.
 *   pose.rotate — degrees (negative = counter-clockwise)
 *   pose.scale  — relative size (0..1)
 *   pose.anchor — { x, y } in 64×64 frame coords (centre of drawn weapon)
 *   scale       — outer compositor scale (frame-coord pixels → output pixels)
 */
export function drawDerivedItem(ctx, sourceCanvas, pose, scale) {
  return drawDerivedItemAt(ctx, sourceCanvas, pose, scale, 0, 0);
}

function drawDerivedItemAt(ctx, sourceCanvas, pose, scale, ox, oy) {
  const bbox = findOpaqueBoundingBox(sourceCanvas);
  if (!bbox) return;

  const rotated = rotateImageNearestNeighbor(sourceCanvas, bbox, pose.rotate || 0);

  const targetW = rotated.width * pose.scale * scale;
  const targetH = rotated.height * pose.scale * scale;
  const anchorX = ox + pose.anchor.x * scale;
  const anchorY = oy + pose.anchor.y * scale;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    rotated,
    0, 0, rotated.width, rotated.height,
    anchorX - targetW / 2, anchorY - targetH / 2, targetW, targetH
  );
  ctx.restore();
}
