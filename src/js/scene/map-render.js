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
  for (const bridge of (model.bridges || [])) drawBridge(ctx, bridge, px);
  for (const s of (model.structures || [])) drawStructure(ctx, s, px);
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

/** River — layered for depth: wet/foam bank → shallow edge → deep
 *  centre → drifting surface ripples. Reads as real water, not paint. */
function drawRiver(ctx, river, px, model) {
  const pts = river.points;
  if (!pts || pts.length < 2) return;
  const deep = model.structure?.river || model.zoneFill('water')[1];
  const shallow = lighten(deep, 30);
  const foam = lighten(deep, 58);
  const w = (river.width || 0.42) * px;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Damp bank / foam halo (widest, soft).
  ribbonPath(ctx, pts, px);
  ctx.strokeStyle = foam; ctx.globalAlpha = 0.45; ctx.lineWidth = w * 1.55; ctx.stroke();
  // Shallow water (lighter, fills most of the channel).
  ribbonPath(ctx, pts, px);
  ctx.strokeStyle = shallow; ctx.globalAlpha = 0.96; ctx.lineWidth = w * 1.12; ctx.stroke();
  // Deep channel (darker, narrow core) → depth read.
  ribbonPath(ctx, pts, px);
  ctx.strokeStyle = deep; ctx.globalAlpha = 1; ctx.lineWidth = w * 0.62; ctx.stroke();
  // Surface ripples — short cross-current arcs catching light.
  ctx.strokeStyle = foam; ctx.globalAlpha = 0.4;
  ctx.lineWidth = Math.max(1, w * 0.07);
  for (let i = 1; i < pts.length - 1; i += 2) {
    const p = pts[i];
    const dx = pts[i + 1].x - pts[i - 1].x;
    const dy = pts[i + 1].y - pts[i - 1].y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;   // perpendicular (cross-flow)
    const cxp = p.x * px, cyp = p.y * px;
    const rw = w * 0.32;
    ctx.beginPath();
    ctx.moveTo(cxp - nx * rw, cyp - ny * rw);
    ctx.quadraticCurveTo(cxp + dx / len * rw * 0.6, cyp + dy / len * rw * 0.6, cxp + nx * rw, cyp + ny * rw);
    ctx.stroke();
  }
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
function drawBridge(ctx, bridge, px) {
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

// Per-biome ground texture family for the detail pass.
const GROUND_TEXTURE = {
  grass: 'grass', forest: 'grass', swamp: 'grass',
  desert: 'sand', snow: 'snow', cave: 'stone', dungeon: 'stone', tavern: 'wood'
};

function paintGround(ctx, model, px) {
  const W = model.cols * px;
  const H = model.rows * px;
  const ramp = buildRamp(model);
  // High-fidelity path: render the smooth colour field into a small
  // offscreen buffer, then upscale with bilinear smoothing → buttery
  // gradients with NO blocky stair-steps at zone edges. A full-res
  // detail pass then stamps material texture (grass blades, sand grain,
  // stone speckle) so the ground reads as a surface, not a wash.
  const ds = 7;   // field downscale: 1 buffer texel per ~7 screen px
  const bw = Math.max(2, Math.ceil(W / ds));
  const bh = Math.max(2, Math.ceil(H / ds));
  const buf = makeBuffer(bw, bh);
  if (buf && buf.getContext) {
    const bctx = buf.getContext('2d');
    const img = bctx.createImageData(bw, bh);
    const d = img.data;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const cx = (x / bw) * model.cols;
        const cy = (y / bh) * model.rows;
        const e = model.elevation(cx, cy);
        const m = model.moisture(cx, cy);
        const rgb = tintByMoisture(sampleRamp(ramp, e), m);
        const i = (y * bw + x) * 4;
        d[i] = rgb.r; d[i + 1] = rgb.g; d[i + 2] = rgb.b; d[i + 3] = 255;
      }
    }
    bctx.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buf, 0, 0, bw, bh, 0, 0, W, H);
    ctx.restore();
    paintGroundDetail(ctx, model, px, W, H);
    return;
  }
  // Coarse fallback (headless/tests): tiled fills, no buffer needed.
  const grain = makeValueNoise2D((model.seed ^ 0x1b56c4f9) >>> 0);
  const tile = Math.max(3, Math.round(px / 8));
  ctx.save();
  for (let ty = 0; ty * tile < H; ty++) {
    for (let tx = 0; tx * tile < W; tx++) {
      const cx = (tx * tile + tile / 2) / px;
      const cy = (ty * tile + tile / 2) / px;
      const rgb = tintByMoisture(sampleRamp(ramp, model.elevation(cx, cy)), model.moisture(cx, cy));
      const g = (fbm2D(grain, cx * 5.3, cy * 5.3, { octaves: 2 }) - 0.5) * 11;
      ctx.fillStyle = rgbStr(addLum(rgb, g));
      ctx.fillRect(tx * tile, ty * tile, tile + 1, tile + 1);
    }
  }
  ctx.restore();
}

/**
 * Full-res material texture stamped over the smooth field: short grass
 * blades on grassland, grain on sand, speckle on stone, board lines on
 * wood. Low-alpha, seeded, jittered off the grid so it reads as a
 * surface rather than a pattern. Skipped on water (the river owns it).
 */
function paintGroundDetail(ctx, model, px, W, H) {
  const fam = GROUND_TEXTURE[model.biome] || 'grass';
  const seed = model.seed >>> 0;
  const step = Math.max(6, px * 0.22);
  ctx.save();
  ctx.lineCap = 'round';
  for (let yy = 0; yy < H; yy += step) {
    for (let xx = 0; xx < W; xx += step) {
      const jx = (hashFloat(seed, xx, yy) - 0.5) * step * 1.1;
      const jy = (hashFloat(seed + 1, xx, yy) - 0.5) * step * 1.1;
      const x = xx + jx, y = yy + jy;
      const cx = x / px, cy = y / px;
      const zone = model.zoneAt(cx, cy);
      if (zone === 'water') continue;
      const base = sampleRamp(buildRampCache(model), model.elevation(cx, cy));
      const v = hashFloat(seed + 2, xx, yy);
      if (fam === 'grass' && (zone === 'low' || zone === 'mid' || zone === 'shore')) {
        stampBlade(ctx, x, y, px * 0.16, v < 0.5 ? lightenRgb(base, 26) : darkenRgb(base, 22), hashFloat(seed + 3, xx, yy));
      } else if (fam === 'sand') {
        stampSpeck(ctx, x, y, px * (0.04 + v * 0.05), v < 0.5 ? lightenRgb(base, 16) : darkenRgb(base, 14), 0.5);
      } else if (fam === 'snow') {
        if (v > 0.55) stampSpeck(ctx, x, y, px * 0.05, lightenRgb(base, 30), 0.6);
      } else if (fam === 'stone') {
        stampSpeck(ctx, x, y, px * (0.05 + v * 0.06), v < 0.5 ? darkenRgb(base, 16) : lightenRgb(base, 12), 0.45);
      } else if (fam === 'wood') {
        // faint horizontal board grain
        ctx.globalAlpha = 0.12;
        ctx.strokeStyle = rgbStr(darkenRgb(base, 18));
        ctx.lineWidth = Math.max(1, px * 0.03);
        ctx.beginPath();
        ctx.moveTo(x - step * 0.5, y); ctx.lineTo(x + step * 0.5, y);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/** A short curved grass blade pair. */
function stampBlade(ctx, x, y, r, rgb, rot) {
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = rgbStr(rgb);
  ctx.lineWidth = Math.max(1, r * 0.5);
  const lean = (rot - 0.5) * r;
  ctx.beginPath();
  ctx.moveTo(x, y + r);
  ctx.quadraticCurveTo(x + lean * 0.5, y, x + lean, y - r);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + r * 0.4, y + r);
  ctx.quadraticCurveTo(x + lean * 0.5 + r * 0.3, y, x + lean + r * 0.3, y - r * 0.8);
  ctx.stroke();
}

/** A small soft speck (sand grain / pebble / snow sparkle). */
function stampSpeck(ctx, x, y, r, rgb, alpha) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = rgbStr(rgb);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// Cache the ramp per model so the detail pass doesn't rebuild it per stamp.
let _rampCacheModel = null, _rampCache = null;
function buildRampCache(model) {
  if (_rampCacheModel === model && _rampCache) return _rampCache;
  _rampCacheModel = model; _rampCache = buildRamp(model);
  return _rampCache;
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

/** Atmosphere pass: a gentle directional light wash (cool→warm) for
 *  cohesion + a soft, subtle edge vignette. Kept light so it reads as
 *  ambiance, not a heavy frame. */
function paintVignette(ctx, model, px) {
  const W = model.cols * px, H = model.rows * px;
  if (!ctx.createRadialGradient || !ctx.createLinearGradient) return;
  ctx.save();
  // Directional light — slightly brighter/warmer top-left, cooler
  // bottom-right — unifies the per-object top-left lighting.
  const lin = ctx.createLinearGradient(0, 0, W, H);
  lin.addColorStop(0, 'rgba(255,244,214,0.07)');
  lin.addColorStop(0.5, 'rgba(255,255,255,0)');
  lin.addColorStop(1, 'rgba(10,16,30,0.10)');
  ctx.fillStyle = lin;
  ctx.fillRect(0, 0, W, H);
  // Subtle edge darkening.
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(8,10,16,0.13)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/* =====================================================================
 * Structures (Phase 3) — multi-cell buildings / ruins / camps
 * ===================================================================== */

function drawStructure(ctx, s, px) {
  const x = (s.col + s.w / 2) * px;
  const y = (s.row + s.h / 2) * px;
  const w = s.w * px, h = s.h * px;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(s.angle || 0);
  // Cast shadow under every structure for grounding.
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#000';
  roundRectPath(ctx, -w / 2 + px * 0.1, -h / 2 + px * 0.14, w * 0.92, h * 0.92, px * 0.15);
  ctx.fill();
  ctx.globalAlpha = 1;
  switch (s.type) {
    case 'hut':       drawHut(ctx, w, h, s.variant); break;
    case 'cabin':     drawHut(ctx, w, h, s.variant); break;
    case 'ruin':      drawRuin(ctx, w, h, s.variant); break;
    case 'campfire':  drawCampfire(ctx, w, h); break;
    case 'pillars':   drawPillars(ctx, w, h, s); break;
    case 'altar':     drawAltar(ctx, w, h); break;
    case 'tent':      drawTent(ctx, w, h, s.variant); break;
    case 'furniture': drawFurniture(ctx, w, h, s.variant); break;
    default:          drawRuin(ctx, w, h, s.variant);
  }
  ctx.restore();
}

/**
 * Hut/cabin — a top-down pitched roof: stone/timber walls peeking at the
 * eaves, two shaded roof slopes meeting at a ridge along the long axis,
 * plank/shingle lines down each slope, an eaves shadow, and a chimney.
 * Reads as a building, not a flat box.
 */
function drawHut(ctx, w, h, variant) {
  const roofLit = ['#9a5a30', '#8a6a3e', '#a05a34'][variant % 3];
  const roofShade = darken(roofLit, 30);
  const ridgeRunsVertical = h >= w;   // ridge along the longer side
  const wallC = '#b89a72';
  // Walls (the eaves the roof overhangs) — slightly larger, with a soft
  // drop shadow below to lift the building off the ground.
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  roundRectPath(ctx, -w / 2 + 3, -h / 2 + 7, w - 6, h - 6, 4);
  ctx.fill();
  ctx.fillStyle = wallC;
  roundRectPath(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 4);
  ctx.fill();
  // Roof inset over the walls.
  const rx = -w / 2 + 8, ry = -h / 2 + 8, rw = w - 16, rh = h - 16;
  ctx.save();
  roundRectPath(ctx, rx, ry, rw, rh, 3);
  ctx.clip();
  if (ridgeRunsVertical) {
    // Ridge vertical at x=0; left slope lit, right slope shaded.
    paintSlope(ctx, rx, ry, rw / 2, rh, roofLit, lighten(roofLit, 14), true);
    paintSlope(ctx, 0, ry, rw / 2 + (rx + rw), rh, roofShade, roofLit, true);
    ctx.fillStyle = roofShade; ctx.fillRect(0, ry, rx + rw, rh);
    paintSlope(ctx, 0, ry, rx + rw, rh, roofShade, roofLit, true);
    // shingle rows (horizontal lines)
    shingleLines(ctx, rx, ry, rw, rh, false);
  } else {
    paintSlope(ctx, rx, ry, rw, rh / 2, roofLit, lighten(roofLit, 14), false);
    ctx.fillStyle = roofShade; ctx.fillRect(rx, 0, rw, ry + rh);
    paintSlope(ctx, rx, 0, rw, ry + rh, roofShade, roofLit, false);
    shingleLines(ctx, rx, ry, rw, rh, true);
  }
  ctx.restore();
  // Ridge line.
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = Math.max(1.5, w * 0.025);
  ctx.beginPath();
  if (ridgeRunsVertical) { ctx.moveTo(0, ry); ctx.lineTo(0, ry + rh); }
  else { ctx.moveTo(rx, 0); ctx.lineTo(rx + rw, 0); }
  ctx.stroke();
  // Ridge highlight.
  ctx.strokeStyle = 'rgba(255,240,210,0.25)';
  ctx.lineWidth = Math.max(1, w * 0.012);
  ctx.beginPath();
  if (ridgeRunsVertical) { ctx.moveTo(-1.5, ry); ctx.lineTo(-1.5, ry + rh); }
  else { ctx.moveTo(rx, -1.5); ctx.lineTo(rx + rw, -1.5); }
  ctx.stroke();
  // Chimney with a hint of smoke shadow.
  const chx = rx + rw * 0.72, chy = ry + rh * 0.22;
  ctx.fillStyle = '#5a4636';
  ctx.fillRect(chx - w * 0.05, chy - w * 0.05, w * 0.1, w * 0.1);
  ctx.fillStyle = '#3a2c20';
  ctx.fillRect(chx - w * 0.035, chy - w * 0.035, w * 0.07, w * 0.07);
}

/** Fill a roof-slope rect with a ridge→eave gradient (ridge brighter). */
function paintSlope(ctx, x, y, w, h, eaveColor, ridgeColor, vertical) {
  if (!ctx.createLinearGradient) { ctx.fillStyle = eaveColor; ctx.fillRect(x, y, w, h); return; }
  const g = vertical
    ? ctx.createLinearGradient(x, 0, x + w, 0)
    : ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, ridgeColor);
  g.addColorStop(1, eaveColor);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

/** Faint shingle/plank rows across a roof rect. */
function shingleLines(ctx, x, y, w, h, vertical) {
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  const n = 6;
  ctx.beginPath();
  for (let i = 1; i < n; i++) {
    if (vertical) { const lx = x + (w / n) * i; ctx.moveTo(lx, y); ctx.lineTo(lx, y + h); }
    else { const ly = y + (h / n) * i; ctx.moveTo(x, ly); ctx.lineTo(x + w, ly); }
  }
  ctx.stroke();
}

/** Ruin — broken stone walls forming a partial enclosure with gaps. */
function drawRuin(ctx, w, h, variant) {
  const stone = '#8c8c84';
  const t = Math.max(3, w * 0.09);   // wall thickness
  ctx.fillStyle = stone;
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1;
  // Four walls, each with a random missing chunk → ruined look.
  const L = -w / 2 + 6, Rr = w / 2 - 6, T = -h / 2 + 6, B = h / 2 - 6;
  const segs = [
    // top wall (with gap on the right third for variant 0)
    [L, T, Rr - (variant === 0 ? (Rr - L) * 0.4 : 0), T, t, 'h'],
    // left wall
    [L, T, L, B - (variant === 1 ? (B - T) * 0.35 : 0), t, 'v'],
    // bottom wall (gap on left for variant 2)
    [L + (variant === 2 ? (Rr - L) * 0.35 : 0), B, Rr, B, t, 'h'],
    // right wall
    [Rr, T + (variant === 0 ? (B - T) * 0.3 : 0), Rr, B, t, 'v']
  ];
  for (const [x1, y1, x2, y2, th, dir] of segs) {
    if (dir === 'h') ctx.fillRect(Math.min(x1, x2), y1 - th / 2, Math.abs(x2 - x1), th);
    else ctx.fillRect(x1 - th / 2, Math.min(y1, y2), th, Math.abs(y2 - y1));
  }
  // Highlight tops
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  for (const [x1, y1, x2, y2, th, dir] of segs) {
    if (dir === 'h') ctx.fillRect(Math.min(x1, x2), y1 - th / 2, Math.abs(x2 - x1), th * 0.4);
    else ctx.fillRect(x1 - th / 2, Math.min(y1, y2), th * 0.4, Math.abs(y2 - y1));
  }
  // A few fallen blocks inside.
  ctx.fillStyle = '#787870';
  for (const [dx, dy] of [[-0.18, 0.1], [0.2, -0.12], [0.05, 0.22]]) {
    ctx.fillRect(dx * w, dy * h, t * 0.9, t * 0.9);
  }
}

/** Campfire — stone ring + glowing fire + a couple of logs. */
function drawCampfire(ctx, w, h) {
  const r = Math.min(w, h) * 0.28;
  // Fire glow
  if (ctx.createRadialGradient) {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.2);
    g.addColorStop(0, 'rgba(255,170,60,0.6)');
    g.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2); ctx.fill();
  }
  // Logs (cross)
  ctx.strokeStyle = '#5a3a1f';
  ctx.lineWidth = Math.max(2, r * 0.3);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-r * 0.7, -r * 0.4); ctx.lineTo(r * 0.7, r * 0.4);
  ctx.moveTo(-r * 0.7, r * 0.4); ctx.lineTo(r * 0.7, -r * 0.4);
  ctx.stroke();
  // Flame
  ctx.fillStyle = '#ffb13b';
  ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffe08a';
  ctx.beginPath(); ctx.arc(0, -r * 0.1, r * 0.25, 0, Math.PI * 2); ctx.fill();
  // Stone ring
  ctx.fillStyle = '#9a948a';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r, Math.sin(a) * r, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Pillars — a grid of stone columns (dungeon/cave hall). */
function drawPillars(ctx, w, h, s) {
  const cols = s.w, rows = s.h;
  const r = Math.min(w / cols, h / rows) * 0.3;
  ctx.fillStyle = '#4a4a52';
  for (let c = 0; c < cols; c++) {
    for (let rr = 0; rr < rows; rr++) {
      const cx = -w / 2 + (c + 0.5) * (w / cols);
      const cy = -h / 2 + (rr + 0.5) * (h / rows);
      ctx.beginPath(); ctx.arc(cx + r * 0.18, cy + r * 0.2, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#56565e'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fill();
    }
  }
}

/** Altar — a raised stone block with a rune top. */
function drawAltar(ctx, w, h) {
  const bw = w * 0.5, bh = h * 0.5;
  ctx.fillStyle = '#5a5660';
  roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, 3);
  ctx.fill();
  ctx.fillStyle = '#6a6672';
  roundRectPath(ctx, -bw / 2 + 4, -bh / 2 + 4, bw - 8, bh - 8, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,120,220,0.7)';
  ctx.lineWidth = Math.max(1, w * 0.02);
  ctx.beginPath();
  ctx.arc(0, 0, Math.min(bw, bh) * 0.22, 0, Math.PI * 2);
  ctx.stroke();
}

/** Tent — a triangular canvas with a center pole + entrance. */
function drawTent(ctx, w, h, variant) {
  const canvasC = ['#9c7a4a', '#8a6b5a', '#6b7a8a'][variant % 3];
  ctx.fillStyle = canvasC;
  ctx.beginPath();
  ctx.moveTo(0, -h / 2 + 6);
  ctx.lineTo(w / 2 - 6, h / 2 - 6);
  ctx.lineTo(-w / 2 + 6, h / 2 - 6);
  ctx.closePath();
  ctx.fill();
  // Shaded right half
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.moveTo(0, -h / 2 + 6);
  ctx.lineTo(w / 2 - 6, h / 2 - 6);
  ctx.lineTo(0, h / 2 - 6);
  ctx.closePath();
  ctx.fill();
  // Entrance slit
  ctx.strokeStyle = '#2a1f14';
  ctx.lineWidth = Math.max(1, w * 0.03);
  ctx.beginPath();
  ctx.moveTo(0, -h / 2 + 8); ctx.lineTo(0, h / 2 - 8);
  ctx.stroke();
}

/** Furniture — tavern tables (a couple of rounded tables + benches). */
function drawFurniture(ctx, w, h, variant) {
  const tableC = '#6e4a26';
  const n = 1 + (variant % 2);
  for (let i = 0; i < n; i++) {
    const ox = (i - (n - 1) / 2) * w * 0.4;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(ox + 3, 4, w * 0.16, h * 0.16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = tableC;
    ctx.beginPath(); ctx.ellipse(ox, 0, w * 0.16, h * 0.16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(ox, 0, w * 0.1, h * 0.1, 0, 0, Math.PI * 2); ctx.stroke();
  }
}

/** Rounded-rectangle path helper. */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
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

/**
 * Tree — a volumetric canopy built from many overlapping foliage lobes
 * with directional lighting (light top-left, shade bottom-right) and a
 * soft cast shadow. Per-tree variation is hashed from position so each
 * tree is unique but stable. Reads as real foliage from above rather
 * than a flat disc.
 */
function drawTree(ctx, x, y, r, color) {
  const dark = darken(color, 32);
  const mid = color;
  const light = lighten(color, 30);
  ctx.save();
  // Soft cast shadow, offset down-right (light from top-left).
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#0a140c';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.3, y + r * 0.34, r * 1.04, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // Build foliage lobes around the centre.
  const N = 16;
  const lobes = [];
  for (let i = 0; i < N; i++) {
    const a = hashFloat(i * 13 + 1, x, y) * Math.PI * 2;
    const rad = 0.25 + 0.7 * hashFloat(i * 7 + 3, x, y);
    const lr = r * (0.30 + 0.18 * hashFloat(i * 5 + 9, x, y));
    lobes.push({ lx: x + Math.cos(a) * r * 0.6 * rad, ly: y + Math.sin(a) * r * 0.6 * rad, lr });
  }
  // Dark base mass.
  ctx.fillStyle = dark;
  for (const L of lobes) { ctx.beginPath(); ctx.arc(L.lx, L.ly, L.lr, 0, Math.PI * 2); ctx.fill(); }
  // Mid tone, nudged toward the light.
  ctx.fillStyle = mid;
  for (const L of lobes) { ctx.beginPath(); ctx.arc(L.lx - r * 0.07, L.ly - r * 0.07, L.lr * 0.82, 0, Math.PI * 2); ctx.fill(); }
  // Lit highlights on the upper-left lobes only.
  ctx.fillStyle = light;
  ctx.globalAlpha = 0.85;
  for (const L of lobes) {
    if ((L.lx - x) + (L.ly - y) < -r * 0.1) {
      ctx.beginPath();
      ctx.arc(L.lx - r * 0.13, L.ly - r * 0.13, L.lr * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // A couple of dark gaps for depth.
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = dark;
  for (let i = 0; i < 2; i++) {
    const a = hashFloat(i * 29 + 5, x, y) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.4, r * 0.16, 0, Math.PI * 2);
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

/** Tuft — a small clump of curved grass blades (denser, organic) with
 *  a faint shadow at the base so it sits on the ground. */
function drawTuft(ctx, x, y, r, color) {
  ctx.save();
  ctx.lineCap = 'round';
  // Base shadow.
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#0a140a';
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.55, r * 0.7, r * 0.25, 0, 0, Math.PI * 2);
  ctx.fill();
  const blades = 6;
  for (let i = 0; i < blades; i++) {
    const t = i / (blades - 1) - 0.5;        // -0.5..0.5
    const lean = t * r * 1.4 + (hashFloat(i * 17 + 2, x, y) - 0.5) * r * 0.4;
    const tall = r * (0.8 + 0.4 * hashFloat(i * 11 + 5, x, y));
    ctx.strokeStyle = i % 2 ? lighten(color, 14) : darken(color, 12);
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath();
    ctx.moveTo(x + t * r * 0.5, y + r * 0.5);
    ctx.quadraticCurveTo(x + lean * 0.5, y - tall * 0.3, x + lean, y - tall);
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
/** Lighten/darken an {r,g,b} directly (used by the texture pass). */
function lightenRgb(c, amt) { return addLum(c, amt); }
function darkenRgb(c, amt) { return addLum(c, -amt); }

/**
 * Make an offscreen canvas for the smooth-field upscale. Returns null
 * in headless/test environments (no DOM, no OffscreenCanvas) so the
 * caller falls back to coarse tile fills.
 */
function makeBuffer(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  const Off = globalThis.OffscreenCanvas;
  if (typeof Off === 'function') return new Off(w, h);
  return null;
}

/** Deterministic hash → [0,1) from a seed + two floats. Used for
 *  per-feature/per-stamp variation (foliage lobes, blade lean). */
function hashFloat(seed, x, y) {
  let s = (Math.floor(x * 131.7) ^ Math.floor(y * 97.3) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}
