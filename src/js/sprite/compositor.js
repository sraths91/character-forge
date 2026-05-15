import { FRAME, SLOT_COLORS, SLOT_BOXES, buildRenderPlan, getFrame } from './lpc-config.js';
import { loadImage } from './image-cache.js';
import { generateItemSprite, rarityToAuraTier } from './item-generator.js';

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
export async function renderSprite(canvas, character, { scale = 6, direction = 'south', frameIdx = 0 } = {}) {
  const outW = FRAME * scale;
  const outH = FRAME * scale;
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, outW, outH);
  const result = await drawCharacterAt(ctx, character, { x: 0, y: 0, scale, direction, frameIdx });
  return { canvas, plan: result.plan, generatedCount: result.generatedCount };
}

/**
 * M2 — Render a battle scene: background + grid + party positioned per
 * the scene's positions map. Canvas auto-resizes to the scene's grid
 * dimensions × cellSize × scale.
 *
 * The scene argument is the shape produced by scene-state.js. We use
 * scene.cellSize × scene.scale as the pixel-per-cell unit and place
 * each character into their saved (col, row) — or a default linear
 * position when unsaved.
 *
 * `positionOf` is passed in so this module doesn't depend on scene-state
 * directly (cleaner separation; scene-state owns the position-resolution
 * logic, compositor owns the pixel-pushing).
 */
export async function renderBattleScene(canvas, characters, scene, opts = {}) {
  const {
    direction = 'south',
    frameIdx = 0,
    positionOf,
    monsterCharacters = [],
    // M4 — combat overlays
    selectedAttackerId = null,   // glowing outline on this entity's cell
    activeTurnId = null,         // turn-order indicator
    animations = null,           // Map<entityId, { kind, startedAt, duration }>
    popups = null                // array of { targetId, amount, startedAt, duration }
  } = opts;
  const list = (characters || []).filter(Boolean);
  const cellPx = scene.cellSize * scene.scale;
  const totalW = scene.cols * cellPx;
  const totalH = scene.rows * cellPx;
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, totalW, totalH);

  // 1. Background fill
  if (scene.map?.kind === 'color') {
    ctx.fillStyle = scene.map.color || '#3d5a3d';
    ctx.fillRect(0, 0, totalW, totalH);
  }

  // 2. Grid overlay (drawn UNDER characters so cell lines show through gaps)
  if (scene.grid?.visible) {
    ctx.save();
    ctx.strokeStyle = scene.grid.color || 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= scene.cols; c++) {
      const x = c * cellPx + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, totalH);
      ctx.stroke();
    }
    for (let r = 0; r <= scene.rows; r++) {
      const y = r * cellPx + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(totalW, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 3. Characters (PCs)
  let totalGenerated = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    const pos = positionOf ? positionOf(scene, ch.id, i) : { col: i, row: 0 };
    const x = pos.col * cellPx;
    const y = pos.row * cellPx;
    const r = await drawCharacterAt(ctx, ch, {
      x, y, scale: scene.scale, direction, frameIdx
    });
    totalGenerated += r.generatedCount;
  }

  // 4. Monsters — same render pipeline, position comes from the
  // monster instance's own (col,row). Each monsterCharacters entry is
  // a buildMonsterCharacter() result with HP/conditions copied from
  // the live instance, so on-screen state (e.g. wounded) reflects play.
  for (const mc of monsterCharacters) {
    const pos = mc._position;
    if (!pos) continue;
    const x = pos.col * cellPx;
    const y = pos.row * cellPx;
    const r = await drawCharacterAt(ctx, mc, {
      x, y, scale: scene.scale, direction, frameIdx
    });
    totalGenerated += r.generatedCount;
  }

  // 5. M4 — Combat overlays drawn LAST so they sit above sprites.
  //    Helpers below pull entity positions via locateEntity().
  const locateEntity = (entityId) => {
    for (let i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(entityId)) {
        return { ...positionOf(scene, list[i].id, i) };
      }
    }
    for (const mc of monsterCharacters) {
      if (String(mc.id) === String(entityId)) return { ...mc._position };
    }
    return null;
  };

  // 5a. Selection outline for the chosen attacker
  if (selectedAttackerId) {
    const pos = locateEntity(selectedAttackerId);
    if (pos) drawCellOutline(ctx, pos.col * cellPx, pos.row * cellPx, cellPx, '#22d3ee', 4);
  }
  // 5b. Current-turn outline
  if (activeTurnId && activeTurnId !== selectedAttackerId) {
    const pos = locateEntity(activeTurnId);
    if (pos) drawCellOutline(ctx, pos.col * cellPx, pos.row * cellPx, cellPx, '#fbbf24', 3);
  }

  // 5c. Active animations (attack lunge glow / hurt flash)
  if (animations) {
    const now = performance.now();
    for (const [id, anim] of animations) {
      const elapsed = now - anim.startedAt;
      if (elapsed < 0 || elapsed > anim.duration) continue;
      const t = elapsed / anim.duration;
      const pos = locateEntity(id);
      if (!pos) continue;
      const x = pos.col * cellPx;
      const y = pos.row * cellPx;
      if (anim.kind === 'attack') {
        // Orange flash that pulses then fades
        const alpha = Math.sin(t * Math.PI) * 0.55;
        drawCellGlow(ctx, x, y, cellPx, '#fb923c', alpha);
      } else if (anim.kind === 'hurt') {
        // Red flash that decays linearly
        const alpha = (1 - t) * 0.75;
        drawCellGlow(ctx, x, y, cellPx, '#dc2626', alpha);
      }
    }
  }

  // 5d. Floating damage popups
  if (popups && popups.length > 0) {
    const now = performance.now();
    for (const p of popups) {
      const elapsed = now - p.startedAt;
      if (elapsed < 0 || elapsed > p.duration) continue;
      const t = elapsed / p.duration;
      const pos = locateEntity(p.targetId);
      if (!pos) continue;
      const x = pos.col * cellPx + cellPx / 2;
      // Float upward over the cell, fade out
      const y = pos.row * cellPx + cellPx * 0.2 - t * cellPx * 0.55;
      const alpha = 1 - t * 0.85;
      drawDamageNumber(ctx, x, y, p.amount, alpha, Math.max(18, cellPx * 0.22));
    }
  }

  return { canvas, generatedCount: totalGenerated, cellCount: list.length + monsterCharacters.length };
}

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
function drawDamageNumber(ctx, cx, cy, amount, alpha, fontSize) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = amount > 0 ? `-${amount}` : `+${-amount}`;
  ctx.lineWidth = Math.max(2, fontSize / 8);
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

/**
 * Draw a single character at canvas position (x, y). Used by both
 * renderSprite (single, x=y=0) and renderPartyCanvas (offset per slot).
 *
 * Doesn't clear or resize the canvas — the caller owns that. Per-character
 * auras and the body-silhouette scale transform are bounded to a single
 * cell so multi-character canvases compose cleanly.
 */
async function drawCharacterAt(ctx, character, opts) {
  const { x, y, scale, direction, frameIdx } = opts;
  const plan = buildRenderPlan(character, { direction });
  const cellW = FRAME * scale;
  const cellH = FRAME * scale;

  // Pre-pass: kick off item-generator calls in parallel so the main loop
  // doesn't serialise N HTTP round-trips.
  const itemResults = new Map();
  const itemPromises = [];
  plan.layers.forEach((layer, idx) => {
    if (layer.kind === 'item' || layer.kind === 'derived-item') {
      itemPromises.push(
        generateItemSprite(layer.item, layer.src, layer.slot)
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

  for (let idx = 0; idx < plan.layers.length; idx++) {
    const layer = plan.layers[idx];
    if (layer.kind === 'lpc') {
      try {
        const img = await loadImage(layer.src);
        const f0 = getFrame(layer.src, direction, 0);
        const frameCount = Math.max(1, Math.floor(img.width / f0.sw));
        const f = getFrame(layer.src, direction, frameIdx % frameCount);
        const prevFilter = ctx.filter;
        if (layer.filter) ctx.filter = layer.filter;
        ctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, x, y, cellW, cellH);
        if (layer.filter) ctx.filter = prevFilter || 'none';
      } catch {
        drawProceduralSlotAt(ctx, layer.slot, scale, x, y);
      }
    } else if (layer.kind === 'item') {
      const result = itemResults.get(idx);
      const prevFilter = ctx.filter;
      ctx.filter = 'none';
      try {
        if (result && result.mutated && result.canvas) {
          ctx.drawImage(result.canvas, x, y, cellW, cellH);
          generatedCount++;
        } else {
          const img = await loadImage(layer.src);
          const f0 = getFrame(layer.src, direction, 0);
          const frameCount = Math.max(1, Math.floor(img.width / f0.sw));
          const f = getFrame(layer.src, direction, frameIdx % frameCount);
          ctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, x, y, cellW, cellH);
        }
      } catch {
        drawProceduralSlotAt(ctx, layer.slot, scale, x, y);
      } finally {
        ctx.filter = prevFilter;
      }
    } else if (layer.kind === 'derived-item') {
      const result = itemResults.get(idx);
      const prevFilter = ctx.filter;
      ctx.filter = 'none';
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
      } finally {
        ctx.filter = prevFilter;
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
  return { plan, generatedCount };
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
