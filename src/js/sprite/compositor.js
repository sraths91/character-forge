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
export async function renderSprite(canvas, character, { scale = 6, direction = 'south' } = {}) {
  const plan = buildRenderPlan(character, { direction });
  const ctx = canvas.getContext('2d');
  const outW = FRAME * scale;
  const outH = FRAME * scale;
  canvas.width = outW;
  canvas.height = outH;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, outW, outH);

  let generatedCount = 0;

  // Pre-pass: kick off item-generator calls in parallel so the main loop
  // doesn't serialise N HTTP round-trips. Both 'item' and 'derived-item'
  // layers route through the same generator pipeline so material/glow/aura
  // mutations apply to derived sheathed sprites too.
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

  // Phase F1 — Subclass backdrop aura. Drawn FIRST so the rarity aura
  // (drawn second) sits on top when both apply. Mid-strength alpha keeps
  // it readable but not overwhelming.
  if (plan.subclassAura) {
    drawSolidAura(ctx, plan.subclassAura, 0.30, outW, outH);
  }

  // Phase H — concentration aura overlays the subclass aura at higher
  // alpha so it reads as "this spell is currently active".
  if (plan.concentrationAura) {
    drawSolidAura(ctx, plan.concentrationAura, 0.45, outW, outH);
  }

  // Phase E2 — temp HP shimmer (blue halo) drawn before the rarity aura
  // so high-rarity items can still dominate visually.
  if (plan.tempHpAura) {
    drawSolidAura(ctx, plan.tempHpAura, 0.25, outW, outH);
  }

  // Backdrop aura — pick the highest-rarity item, draw a single radial
  // gradient behind everything. Avoids the per-item-aura stacking problem
  // where 3 magical items produced 3 overlapping glows.
  drawBackdropAura(ctx, plan.layers, outW, outH);

  // Phase E1 — bodyWidth comes from the plan (parsed appearance / visualHints).
  // Falls back to legacy character.visualHints for callers not yet emitting it.
  const hints = {
    ...(character.visualHints || {}),
    bodyWidth: plan.bodyWidth || character.visualHints?.bodyWidth || 'normal'
  };
  applyBodySilhouette(ctx, hints, outW, outH);

  for (let idx = 0; idx < plan.layers.length; idx++) {
    const layer = plan.layers[idx];
    if (layer.kind === 'lpc') {
      try {
        const img = await loadImage(layer.src);
        const f = getFrame(layer.src, direction);
        const prevFilter = ctx.filter;
        if (layer.filter) ctx.filter = layer.filter;
        ctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, 0, 0, outW, outH);
        if (layer.filter) ctx.filter = prevFilter || 'none';
      } catch {
        drawProceduralSlot(ctx, layer.slot, scale);
      }
    } else if (layer.kind === 'item') {
      const result = itemResults.get(idx);
      const prevFilter = ctx.filter;
      ctx.filter = 'none';
      try {
        if (result && result.mutated && result.canvas) {
          ctx.drawImage(result.canvas, 0, 0, outW, outH);
          generatedCount++;
        } else {
          // Fall through to base asset (mutated:false or no result)
          const img = await loadImage(layer.src);
          const f = getFrame(layer.src, direction);
          ctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, 0, 0, outW, outH);
        }
      } catch {
        drawProceduralSlot(ctx, layer.slot, scale);
      } finally {
        ctx.filter = prevFilter;
      }
    } else if (layer.kind === 'derived-item') {
      const result = itemResults.get(idx);
      const prevFilter = ctx.filter;
      ctx.filter = 'none';
      try {
        // Use the mutated canvas if the item-generator produced one,
        // otherwise extract the south-idle frame from the source PNG.
        let sourceCanvas;
        if (result && result.mutated && result.canvas) {
          sourceCanvas = result.canvas;
          generatedCount++;
        } else {
          sourceCanvas = await extractIdleFrame(layer.src, direction);
        }
        drawDerivedItem(ctx, sourceCanvas, layer.pose, scale);
      } catch {
        drawProceduralSlot(ctx, layer.slot, scale);
      } finally {
        ctx.filter = prevFilter;
      }
    } else if (layer.kind === 'rect') {
      drawProceduralSlot(ctx, layer.slot, scale, layer.overrideColor);
    } else if (layer.kind === 'effect') {
      drawGlow(ctx, layer.tint, scale);
    } else if (layer.kind === 'glyph') {
      // Phase E4 — small symbolic overlay (inspiration star, etc.)
      drawGlyph(ctx, layer.glyph, layer.color, layer.position, scale);
    }
  }

  ctx.restore();

  if (hints.palette === 'saturated') {
    applySaturationBoost(ctx, outW, outH);
  }
  return { canvas, plan, generatedCount };
}

/**
 * Phase F1 — solid radial aura at a given color and alpha. Used by the
 * subclass-accent system to tint the backdrop based on the character's
 * subclass (paladin oath, wizard school, warlock patron, etc.).
 */
function drawSolidAura(ctx, color, alpha, outW, outH) {
  const cx = outW / 2;
  const cy = outH * 0.55;
  const r  = outW * 0.55;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, hexWithAlpha(color, alpha));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, outW, outH);
  ctx.restore();
}

function drawBackdropAura(ctx, layers, outW, outH) {
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
  const cx = outW / 2;
  const cy = outH * 0.55;       // slightly below centre — figure's centre of mass
  const r  = outW * 0.55;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, hexWithAlpha(bestTier.color, bestTier.alpha));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, outW, outH);
  ctx.restore();
}

function hexWithAlpha(hex, alpha) {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return hex;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function applyBodySilhouette(ctx, hints, outW, outH) {
  ctx.save();
  if (hints.bodyWidth === 'broad') {
    ctx.translate(outW / 2, 0);
    ctx.scale(1.06, 1);
    ctx.translate(-outW / 2, 0);
  } else if (hints.bodyWidth === 'thin') {
    ctx.translate(outW / 2, 0);
    ctx.scale(0.94, 1);
    ctx.translate(-outW / 2, 0);
  }
}

function drawProceduralSlot(ctx, slot, scale, overrideColor) {
  const box = SLOT_BOXES[slot];
  if (!box) return;
  const color = overrideColor || SLOT_COLORS[slot] || '#94a3b8';
  ctx.fillStyle = color;
  ctx.fillRect(box.x * scale, box.y * scale, box.w * scale, box.h * scale);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = Math.max(1, scale / 3);
  ctx.strokeRect(box.x * scale + 0.5, box.y * scale + 0.5, box.w * scale - 1, box.h * scale - 1);
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
function drawGlyph(ctx, glyph, color, position, scale) {
  const cx = (position?.x ?? 32) * scale;
  const cy = (position?.y ?? 4) * scale;
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
  ctx.lineWidth = Math.max(1, scale / 4);
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

function drawGlow(ctx, tint, scale) {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const x = 16 * scale;
  const y = 30 * scale;
  const r = 12 * scale;
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, tint);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}

function applySaturationBoost(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h);
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
  ctx.putImageData(data, 0, 0);
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
  const bbox = findOpaqueBoundingBox(sourceCanvas);
  if (!bbox) return;

  const rotated = rotateImageNearestNeighbor(sourceCanvas, bbox, pose.rotate || 0);

  const targetW = rotated.width * pose.scale * scale;
  const targetH = rotated.height * pose.scale * scale;
  const anchorX = pose.anchor.x * scale;
  const anchorY = pose.anchor.y * scale;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    rotated,
    0, 0, rotated.width, rotated.height,
    anchorX - targetW / 2, anchorY - targetH / 2, targetW, targetH
  );
  ctx.restore();
}
