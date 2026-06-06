/**
 * Top-down renderer for procedurally generated battle maps.
 *
 * Paints a `generateMapModel` result (map-generator.js) onto a 2D
 * canvas context: a base ground fill, an fBm mottle texture for
 * organic color variation, then the scattered biome features (trees,
 * rocks, water, etc.) drawn as simple stylized shapes.
 *
 * Synchronous canvas ops only — no image decode, no async. The
 * compositor pre-renders this once to an offscreen canvas keyed by
 * (biome, seed, dimensions) and blits it each frame, so this code runs
 * once per map change, not once per animation frame.
 *
 * Pure-ish: it only draws to the ctx it's handed. Headless-testable
 * with a mock ctx (see map-render.test.js), the same pattern as
 * anim-cinema-backgrounds.test.js.
 */

import { generateMapModel } from './map-generator.js';

/**
 * Paint a full generated map for `scene` onto `ctx`. Resolves the
 * model from scene.map.{biome,seed} and scene.{cols,rows}, then paints
 * ground + mottle + features at `cellPx` pixels per cell.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} scene — needs cols, rows, map.{biome,seed}
 * @param {number} cellPx — pixels per cell (cellSize * scale)
 */
export function paintGeneratedBackground(ctx, scene, cellPx) {
  if (!ctx || !scene) return;
  const model = generateMapModel({
    biome: scene.map?.biome,
    cols: scene.cols,
    rows: scene.rows,
    seed: scene.map?.seed
  });
  paintMapModel(ctx, model, { cellPx });
}

/**
 * Paint a resolved map model. Split out so tests can feed a model
 * directly and the compositor can reuse a cached model if desired.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} model — from generateMapModel
 * @param {object} opts
 * @param {number} opts.cellPx
 */
export function paintMapModel(ctx, model, { cellPx } = {}) {
  if (!ctx || !model) return;
  const px = cellPx || 64;
  const W = model.cols * px;
  const H = model.rows * px;

  // 1. Base ground fill.
  ctx.save();
  ctx.fillStyle = model.ground.base;
  ctx.fillRect(0, 0, W, H);

  // 2. fBm mottle — coarse tiles tint toward light/dark by the field
  //    value, giving organic variation without per-pixel cost. Tile
  //    size ~ a third of a cell reads as ground texture, not blocks.
  const tile = Math.max(6, Math.round(px / 3));
  const colsT = Math.ceil(W / tile);
  const rowsT = Math.ceil(H / tile);
  for (let ty = 0; ty < rowsT; ty++) {
    for (let tx = 0; tx < colsT; tx++) {
      // Sample the model's elevation/moisture field in cell space.
      const cx = (tx * tile) / px;
      const cy = (ty * tile) / px;
      const e = model.field(cx, cy);
      // Map field 0..1 → dark..light blend over the base.
      if (e < 0.4) {
        ctx.fillStyle = model.ground.dark;
        ctx.globalAlpha = (0.4 - e) * 0.7;
      } else if (e > 0.6) {
        ctx.fillStyle = model.ground.light;
        ctx.globalAlpha = (e - 0.6) * 0.7;
      } else {
        continue;
      }
      ctx.fillRect(tx * tile, ty * tile, tile, tile);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // 3. Features.
  for (const f of model.features) {
    drawFeature(ctx, f, px);
  }
}

/* =====================================================================
 * Feature painters — each takes the feature, the pixel center, and the
 * radius in pixels. Stylized top-down silhouettes; deliberately simple
 * so they read at a glance and never fight the tokens drawn on top.
 * ===================================================================== */

function drawFeature(ctx, f, px) {
  const x = f.x * px;
  const y = f.y * px;
  const r = f.r * px;
  switch (f.type) {
    case 'tree':   return drawTree(ctx, x, y, r, f.color);
    case 'water':  return drawWater(ctx, x, y, r, f.color);
    case 'rock':   return drawRock(ctx, x, y, r, f.color);
    case 'rubble': return drawRubble(ctx, x, y, r, f.color);
    case 'drift':  return drawBlob(ctx, x, y, r, f.color, 0.5);
    case 'dune':   return drawBlob(ctx, x, y, r, f.color, 0.35);
    case 'reed':   return drawReed(ctx, x, y, r, f.color);
    case 'scrub':  return drawTuft(ctx, x, y, r, f.color);
    case 'tuft':   return drawTuft(ctx, x, y, r, f.color);
    case 'dirt':   return drawBlob(ctx, x, y, r, f.color, 0.45);
    case 'plank':  return drawPlank(ctx, x, y, r, f.color);
    case 'rug':    return drawRug(ctx, x, y, r, f.color);
    default:       return drawBlob(ctx, x, y, r, f.color, 0.5);
  }
}

/** Soft filled circle with adjustable alpha — the workhorse. */
function drawBlob(ctx, x, y, r, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Tree — layered canopy: a darker shadow disc + a lighter top disc. */
function drawTree(ctx, x, y, r, color) {
  ctx.save();
  // Shadow
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(x + r * 0.18, y + r * 0.18, r, 0, Math.PI * 2);
  ctx.fill();
  // Canopy
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // Highlight
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Water — translucent pool with a lighter ripple arc. */
function drawWater(ctx, x, y, r, color) {
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  // Ripple
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.55, r * 0.4, 0, Math.PI * 0.1, Math.PI * 0.9);
  ctx.stroke();
  ctx.restore();
}

/** Rock — angular polygon lump with a shadow + highlight facet. */
function drawRock(ctx, x, y, r, color) {
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(x + r * 0.2, y + r * 0.2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - r, y + r * 0.3);
  ctx.lineTo(x - r * 0.4, y - r * 0.8);
  ctx.lineTo(x + r * 0.5, y - r * 0.6);
  ctx.lineTo(x + r, y + r * 0.4);
  ctx.lineTo(x + r * 0.2, y + r);
  ctx.closePath();
  ctx.fill();
  // Facet highlight
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(x - r * 0.4, y - r * 0.8);
  ctx.lineTo(x + r * 0.5, y - r * 0.6);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Rubble — a few small specks clustered around the point. */
function drawRubble(ctx, x, y, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  const pts = [
    [0, 0, 1], [-0.7, 0.4, 0.6], [0.6, -0.5, 0.7], [0.5, 0.6, 0.5], [-0.5, -0.6, 0.5]
  ];
  for (const [dx, dy, s] of pts) {
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, r * 0.4 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Tuft — three short grass blades fanning up. */
function drawTuft(ctx, x, y, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.85;
  for (const a of [-0.5, 0, 0.5]) {
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.6);
    ctx.lineTo(x + Math.sin(a) * r, y - r * 0.7);
    ctx.stroke();
  }
  ctx.restore();
}

/** Reed — taller, thinner blades for swamp edges. */
function drawReed(ctx, x, y, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, r * 0.18);
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.8;
  for (const dx of [-0.4, 0, 0.4]) {
    ctx.beginPath();
    ctx.moveTo(x + dx * r, y + r);
    ctx.lineTo(x + dx * r * 0.6, y - r * 1.1);
    ctx.stroke();
  }
  ctx.restore();
}

/** Plank — a wood board rectangle (tavern flooring detail). */
function drawPlank(ctx, x, y, r, color) {
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = color;
  ctx.fillRect(x - r, y - r * 0.5, r * 2, r);
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - r, y - r * 0.5, r * 2, r);
  ctx.restore();
}

/** Rug — a soft rounded rectangle accent. */
function drawRug(ctx, x, y, r, color) {
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.7, r * 0.5, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
