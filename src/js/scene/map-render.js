/**
 * Painterly top-down renderer for structured procedural battle maps (M49).
 *
 * Paints a `generateMapModel` result onto a 2D context:
 *   1. Painterly ground — per sub-cell tile, the colour is interpolated
 *      across the biome's elevation ramp with soft zone-boundary blends
 *      and a moisture tint, so terrain reads as smooth gradients with
 *      organic region edges (no flat fills, no hard cell borders).
 *   2. Rivers + paths (Phase 2) — drawn as smooth ribbons.
 *   3. Structures (Phase 3).
 *   4. Detail features — region-aware scatter with shadows, gradients,
 *      and highlights.
 *
 * Synchronous canvas ops only. The compositor pre-renders this once to
 * an offscreen canvas keyed by (biome, seed, dims) and blits it each
 * frame, so it runs once per map change, not once per animation frame.
 *
 * Headless-testable with a mock ctx (map-render.test.js).
 */

import { generateMapModel } from './map-generator.js';
import { makeValueNoise2D, fbm2D } from './noise.js';

/**
 * Paint a full generated map for `scene` onto `ctx`.
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
 * Paint a resolved map model.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} model — from generateMapModel
 * @param {object} opts
 * @param {number} opts.cellPx
 */
export function paintMapModel(ctx, model, { cellPx } = {}) {
  if (!ctx || !model) return;
  const px = cellPx || 64;

  paintGround(ctx, model, px);
  // Paths under rivers so a bridge reads as crossing over the water.
  for (const path of (model.paths || [])) drawPath(ctx, path, px, model);
  for (const river of (model.rivers || [])) drawRiver(ctx, river, px, model);
  for (const bridge of (model.bridges || [])) drawBridge(ctx, bridge, px, model);
  // Phase 3 will paint model.structures here.
  for (const f of model.features) {
    drawFeature(ctx, f, px);
  }
  paintVignette(ctx, model, px);
}

/* =====================================================================
 * Waterways + roads (Phase 2)
 * ===================================================================== */

/** Trace a smoothed path through the polyline using quadratic curves
 *  through segment midpoints — no corners. */
function ribbonPath(ctx, pts, px) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x * px, pts[0].y * px);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2 * px;
    const my = (pts[i].y + pts[i + 1].y) / 2 * px;
    ctx.quadraticCurveTo(pts[i].x * px, pts[i].y * px, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x * px, last.y * px);
}

/** River — dark bank stroke, water body, lighter centre highlight. */
function drawRiver(ctx, river, px, model) {
  const pts = river.points;
  if (!pts || pts.length < 2) return;
  const color = model.structure?.river || model.zoneFill('water')[1];
  const w = (river.width || 0.42) * px;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Bank (slightly wider, darker, soft).
  ribbonPath(ctx, pts, px);
  ctx.strokeStyle = darken(color, 18);
  ctx.lineWidth = w * 1.35;
  ctx.globalAlpha = 0.85;
  ctx.stroke();
  // Water body.
  ribbonPath(ctx, pts, px);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.globalAlpha = 0.95;
  ctx.stroke();
  // Centre highlight (current).
  ribbonPath(ctx, pts, px);
  ctx.strokeStyle = lighten(color, 24);
  ctx.lineWidth = Math.max(1, w * 0.3);
  ctx.globalAlpha = 0.4;
  ctx.stroke();
  ctx.restore();
}

/** Path/road — soft dirt or stone ribbon with a faint darker edge. */
function drawPath(ctx, path, px, model) {
  const pts = path.points;
  if (!pts || pts.length < 2) return;
  const color = model.structure?.path || '#7d6b48';
  const w = (path.width || 0.3) * px;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Edge.
  ribbonPath(ctx, pts, px);
  ctx.strokeStyle = darken(color, 16);
  ctx.lineWidth = w * 1.3;
  ctx.globalAlpha = 0.6;
  ctx.stroke();
  // Surface.
  ribbonPath(ctx, pts, px);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.globalAlpha = 0.8;
  ctx.stroke();
  // Trodden centre.
  ribbonPath(ctx, pts, px);
  ctx.strokeStyle = lighten(color, 12);
  ctx.lineWidth = Math.max(1, w * 0.4);
  ctx.globalAlpha = 0.45;
  ctx.stroke();
  ctx.restore();
}

/** Bridge — wooden planks spanning the water where a path crosses. */
function drawBridge(ctx, bridge, px, model) {
  const x = bridge.x * px, y = bridge.y * px;
  const ang = bridge.angle || 0;
  const len = px * 1.4, half = px * 0.55;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  // Deck.
  ctx.fillStyle = '#6b4a26';
  ctx.fillRect(-len / 2, -half, len, half * 2);
  // Plank lines across the span.
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, px * 0.04);
  const planks = 6;
  for (let i = 1; i < planks; i++) {
    const lx = -len / 2 + (len / planks) * i;
    ctx.beginPath();
    ctx.moveTo(lx, -half); ctx.lineTo(lx, half);
    ctx.stroke();
  }
  // Rails.
  ctx.strokeStyle = '#7d5630';
  ctx.lineWidth = Math.max(1, px * 0.06);
  ctx.beginPath();
  ctx.moveTo(-len / 2, -half); ctx.lineTo(len / 2, -half);
  ctx.moveTo(-len / 2, half);  ctx.lineTo(len / 2, half);
  ctx.stroke();
  ctx.restore();
}

/* =====================================================================
 * Painterly ground
 * ===================================================================== */

function paintGround(ctx, model, px) {
  const W = model.cols * px;
  const H = model.rows * px;
  // Build the biome's continuous elevation→colour ramp once.
  const ramp = buildRamp(model);
  // A fine grain texture sampler for per-tile jitter.
  const grain = makeValueNoise2D((model.seed ^ 0x1b56c4f9) >>> 0);

  // Sub-cell tile resolution. Smaller tiles = smoother gradient. px/8
  // reads as a smooth wash on a one-time paint while staying bounded
  // (~6k tiles on a 12x8 map at 64px cells).
  const tile = Math.max(3, Math.round(px / 8));
  const cols = Math.ceil(W / tile);
  const rows = Math.ceil(H / tile);

  ctx.save();
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const cx = (tx * tile + tile / 2) / px;
      const cy = (ty * tile + tile / 2) / px;
      const e = model.elevation(cx, cy);
      const m = model.moisture(cx, cy);
      let rgb = sampleRamp(ramp, e);
      // Moisture tint: wetter → cooler/greener, drier → warmer/paler.
      rgb = tintByMoisture(rgb, m);
      // Fine grain — subtle ±brightness so flat areas aren't dead-flat.
      // Sampled at higher frequency than the tile grid so it reads as
      // texture, not blocks.
      const g = (fbm2D(grain, cx * 5.3, cy * 5.3, { octaves: 2 }) - 0.5) * 11;
      ctx.fillStyle = rgbStr(addLum(rgb, g));
      ctx.fillRect(tx * tile, ty * tile, tile + 1, tile + 1);
    }
  }
  ctx.restore();
}

/** Build elevation stops from the biome zone fills. Each zone spans
 *  [lo,hi] in elevation; we stop dark at lo and light at hi, then the
 *  sampler linearly blends — producing soft cross-zone transitions. */
function buildRamp(model) {
  const lv = model.levels;
  const bounds = [
    ['water', 0,        lv.water],
    ['shore', lv.water, lv.shore],
    ['low',   lv.shore, lv.low],
    ['mid',   lv.low,   lv.mid],
    ['high',  lv.mid,   1]
  ];
  const stops = [];
  for (const [zone, lo, hi] of bounds) {
    const [light, dark] = model.zoneFill(zone);
    const lor = hexToRgb(dark);
    const hir = hexToRgb(light);
    // Nudge endpoints inward a hair so adjacent zones blend over the
    // seam rather than stacking two stops on the exact same elevation.
    stops.push({ e: lo + 0.001, rgb: lor });
    stops.push({ e: hi - 0.001, rgb: hir });
  }
  stops.sort((a, b) => a.e - b.e);
  return stops;
}

function sampleRamp(stops, e) {
  if (e <= stops[0].e) return stops[0].rgb;
  if (e >= stops[stops.length - 1].e) return stops[stops.length - 1].rgb;
  for (let i = 1; i < stops.length; i++) {
    if (e <= stops[i].e) {
      const a = stops[i - 1], b = stops[i];
      const t = (e - a.e) / Math.max(1e-6, b.e - a.e);
      return lerpRgb(a.rgb, b.rgb, t);
    }
  }
  return stops[stops.length - 1].rgb;
}

/** Soft vignette so the play area draws the eye to center; very subtle. */
function paintVignette(ctx, model, px) {
  const W = model.cols * px, H = model.rows * px;
  if (!ctx.createRadialGradient) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/* =====================================================================
 * Feature painters
 * ===================================================================== */

function drawFeature(ctx, f, px) {
  const x = f.x * px;
  const y = f.y * px;
  const r = f.r * px;
  switch (f.type) {
    case 'tree':    return drawTree(ctx, x, y, r, f.color);
    case 'bush':    return drawBush(ctx, x, y, r, f.color);
    case 'water':   return drawWater(ctx, x, y, r, f.color);
    case 'lily':    return drawLily(ctx, x, y, r, f.color);
    case 'rock':    return drawRock(ctx, x, y, r, f.color);
    case 'rubble':  return drawRubble(ctx, x, y, r, f.color);
    case 'crack':   return drawCrack(ctx, x, y, r, f.color);
    case 'crystal': return drawCrystal(ctx, x, y, r, f.color);
    case 'crate':   return drawCrate(ctx, x, y, r, f.color);
    case 'drift':   return drawSoftBlob(ctx, x, y, r, f.color, 0.55);
    case 'dune':    return drawSoftBlob(ctx, x, y, r, f.color, 0.32);
    case 'dirt':    return drawSoftBlob(ctx, x, y, r, f.color, 0.4);
    case 'reed':    return drawReed(ctx, x, y, r, f.color);
    case 'scrub':   return drawTuft(ctx, x, y, r, f.color);
    case 'tuft':    return drawTuft(ctx, x, y, r, f.color);
    case 'plank':   return drawPlank(ctx, x, y, r, f.color);
    case 'rug':     return drawRug(ctx, x, y, r, f.color);
    default:        return drawSoftBlob(ctx, x, y, r, f.color, 0.5);
  }
}

/** Soft radial blob — gradient center→transparent. The painterly base. */
function drawSoftBlob(ctx, x, y, r, color, alpha = 1) {
  ctx.save();
  if (ctx.createRadialGradient) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, withAlpha(color, alpha));
    g.addColorStop(0.7, withAlpha(color, alpha * 0.7));
    g.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = g;
  } else {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Tree — cast shadow + radial-gradient canopy + rim highlight. */
function drawTree(ctx, x, y, r, color) {
  ctx.save();
  // Cast shadow (offset, soft)
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.22, y + r * 0.28, r * 1.02, r * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // Canopy with volume
  if (ctx.createRadialGradient) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
    g.addColorStop(0, lighten(color, 28));
    g.addColorStop(0.6, color);
    g.addColorStop(1, darken(color, 24));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = color;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // Clustered lobes for a less perfectly-round canopy
  ctx.fillStyle = lighten(color, 12);
  ctx.globalAlpha = 0.7;
  for (const [dx, dy] of [[-0.45, -0.2], [0.4, -0.35], [0.15, 0.4]]) {
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Bush — smaller clustered canopy, no shadow. */
function drawBush(ctx, x, y, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  for (const [dx, dy, s] of [[0, 0, 1], [-0.5, 0.1, 0.7], [0.5, 0.05, 0.7], [0, -0.4, 0.6]]) {
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, r * 0.6 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = lighten(color, 20);
  ctx.beginPath();
  ctx.arc(x - r * 0.2, y - r * 0.2, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Water pool — gradient body + rim + ripple. */
function drawWater(ctx, x, y, r, color) {
  ctx.save();
  if (ctx.createRadialGradient) {
    const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
    g.addColorStop(0, lighten(color, 14));
    g.addColorStop(1, darken(color, 12));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = color;
  }
  ctx.globalAlpha = 0.78;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.82, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, r * 0.07);
  ctx.beginPath();
  ctx.ellipse(x, y - r * 0.1, r * 0.55, r * 0.36, 0, Math.PI * 0.1, Math.PI * 0.9);
  ctx.stroke();
  ctx.restore();
}

/** Lily pad — small green disc with a notch, floats on water. */
function drawLily(ctx, x, y, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(x, y, r, 0.4, Math.PI * 2 + 0.0);
  ctx.lineTo(x, y);
  ctx.fill();
  ctx.restore();
}

/** Rock — faceted polygon with gradient + shadow + highlight facet. */
function drawRock(ctx, x, y, r, color) {
  ctx.save();
  ctx.globalAlpha = 0.36;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.2, y + r * 0.24, r, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  if (ctx.createLinearGradient) {
    const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    g.addColorStop(0, lighten(color, 22));
    g.addColorStop(1, darken(color, 20));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = color;
  }
  ctx.beginPath();
  ctx.moveTo(x - r, y + r * 0.3);
  ctx.lineTo(x - r * 0.4, y - r * 0.8);
  ctx.lineTo(x + r * 0.5, y - r * 0.6);
  ctx.lineTo(x + r, y + r * 0.4);
  ctx.lineTo(x + r * 0.2, y + r);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(x - r * 0.4, y - r * 0.8);
  ctx.lineTo(x + r * 0.5, y - r * 0.6);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Rubble — speck cluster. */
function drawRubble(ctx, x, y, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  for (const [dx, dy, s] of [[0, 0, 1], [-0.7, 0.4, 0.6], [0.6, -0.5, 0.7], [0.5, 0.6, 0.5], [-0.5, -0.6, 0.5]]) {
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, r * 0.4 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Crack — a dark jagged fissure in the floor. */
function drawCrack(ctx, x, y, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - r, y - r * 0.4);
  ctx.lineTo(x - r * 0.3, y);
  ctx.lineTo(x + r * 0.2, y - r * 0.3);
  ctx.lineTo(x + r, y + r * 0.5);
  ctx.stroke();
  ctx.restore();
}

/** Crystal — a small glowing gem cluster (cave accent). */
function drawCrystal(ctx, x, y, r, color) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = r;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  for (const [dx, h] of [[-0.3, 1], [0.2, 1.3], [0.5, 0.8]]) {
    ctx.beginPath();
    ctx.moveTo(x + dx * r, y + r * 0.5);
    ctx.lineTo(x + dx * r - r * 0.18, y + r * 0.5);
    ctx.lineTo(x + dx * r, y - r * h);
    ctx.lineTo(x + dx * r + r * 0.18, y + r * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Crate — a wooden box (tavern/dungeon prop). */
function drawCrate(ctx, x, y, r, color) {
  ctx.save();
  ctx.globalAlpha = 0.36;
  ctx.fillStyle = '#000';
  ctx.fillRect(x - r * 0.85 + r * 0.18, y - r * 0.85 + r * 0.2, r * 1.7, r * 1.7);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillRect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
  ctx.strokeStyle = darken(color, 30);
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.strokeRect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
  ctx.beginPath();
  ctx.moveTo(x - r * 0.85, y - r * 0.85); ctx.lineTo(x + r * 0.85, y + r * 0.85);
  ctx.moveTo(x + r * 0.85, y - r * 0.85); ctx.lineTo(x - r * 0.85, y + r * 0.85);
  ctx.stroke();
  ctx.restore();
}

/** Tuft — three short grass blades. */
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

/** Reed — taller thin blades for water edges. */
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

/** Plank — wood board (tavern flooring). */
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

/** Rug — soft rounded accent. */
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

/* =====================================================================
 * Colour helpers
 * ===================================================================== */

function hexToRgb(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
  if (!m) return { r: 128, g: 128, b: 128 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function rgbStr(c) { return `rgb(${c.r | 0},${c.g | 0},${c.b | 0})`; }
function lerpRgb(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
function addLum(c, d) {
  return { r: clampByte(c.r + d), g: clampByte(c.g + d), b: clampByte(c.b + d) };
}
function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/** Shift an rgb toward green (wet) or warm-pale (dry). Subtle. */
function tintByMoisture(c, m) {
  const d = (m - 0.5);                       // -0.5..0.5
  return {
    r: clampByte(c.r - d * 10),
    g: clampByte(c.g + d * 8),
    b: clampByte(c.b - d * 4)
  };
}

function lighten(hex, amt) {
  const c = hexToRgb(hex);
  return rgbStr(addLum(c, amt));
}
function darken(hex, amt) {
  const c = hexToRgb(hex);
  return rgbStr(addLum(c, -amt));
}
function withAlpha(hex, a) {
  const c = hexToRgb(hex);
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}
