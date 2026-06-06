/**
 * M44.2 — Terrain-keyed cinema backgrounds.
 * M48 — Split into far / near parallax layers.
 * M52 — High-end baked backdrops.
 *
 * The cinema renderer (M43.2) accepts a `drawBackground` callback exposing
 * `paintFar` / `paintNear` for the M48 two-layer parallax. Pre-M52 those
 * painted a flat vertical gradient plus a handful of silhouette rectangles
 * — far below the textured, atmospheric look of the M49/M50 generated
 * maps. The maps are top-down so they can't be blitted into this side-view
 * scene; instead M52 brings the same *toolkit* here:
 *
 *   - value-noise texturing            (scene/noise.js)
 *   - baked hero-sprite props          (scene/hero-sprites.js — trees/rocks/bushes)
 *   - atmospheric colour-grade + bloom (scene/map-grade.js — GRADE/applyAtmosphere)
 *
 * Each terrain bakes TWO offscreen buffers ONCE per (terrain, W×H):
 *   - FAR  — graded sky + distant silhouette band + mid hero-sprite props.
 *            Blitted by paintFar at the slow parallax factor.
 *   - NEAR — a noise-textured ground band + a few foreground props + the
 *            floor line, alpha above the horizon. Blitted by paintNear at
 *            the fast parallax factor (on top of far).
 * The per-frame cost stays one drawImage per layer — all the expensive
 * work is baked. Headless (node tests / no canvas) → bake returns null and
 * the painters fall back to the original lightweight gradient.
 */

import { SCENE_PRESETS } from '../scene/scene-state.js';
import { makeValueNoise2D, fbm2D } from '../scene/noise.js';
import { getHeroSprite, HERO_CONTENT_FRACTION } from '../scene/hero-sprites.js';
import { applyAtmosphere } from '../scene/map-grade.js';

/**
 * Resolve a scene's terrain slug. Returns one of the known background ids
 * or 'grass' as a safe default. Pure — no DOM, no side effects.
 */
export function terrainFromScene(scene) {
  if (!scene) return 'grass';
  const explicit = scene.map?.preset;
  if (explicit && BACKGROUNDS[explicit]) return explicit;
  const color = String(scene.map?.color || '').toLowerCase();
  if (!color) return 'grass';
  for (const [slug, p] of Object.entries(SCENE_PRESETS)) {
    if (String(p.map?.color || '').toLowerCase() === color && BACKGROUNDS[slug]) return slug;
  }
  return 'grass';
}

/** Get the drawBackground callback for a terrain slug. */
export function backgroundFor(terrainSlug) {
  return BACKGROUNDS[terrainSlug] || BACKGROUNDS.grass;
}

/* =====================================================================
 * Per-biome palettes
 *   sky      — gradient stops for the upper backdrop
 *   haze     — horizon glow colour (atmospheric depth)
 *   silo     — distant silhouette band colour
 *   ground   — [light, mid, dark] for the noise-textured ground band
 *   props    — mid-layer hero props: { type, color }  (null = architectural)
 *   fg       — foreground prop type for the near layer (null = none)
 *   accent   — optional radial light { x, y, color } (torch / fire / cool glow)
 *   silShape — far silhouette style: 'treeline'|'mountains'|'dunes'|'bricks'|
 *              'planks'|'stalactites'
 * ===================================================================== */
const HORIZON = 0.60;        // ground starts this far down the frame

const PALETTE = {
  grass: {
    sky: [[0, '#6f93a6'], [0.45, '#88a892'], [1, '#6d8f74']],
    haze: 'rgba(220,235,210,0.30)', silo: '#3f5d40', silShape: 'treeline',
    ground: ['#4a6b43', '#33502f', '#21381d'],
    props: [{ type: 'tree', color: '#2f5d36' }, { type: 'bush', color: '#3f6638' }],
    fg: 'bush', accent: null
  },
  forest: {
    sky: [[0, '#33503c'], [0.45, '#3c5a42'], [1, '#26402c']],
    haze: 'rgba(150,200,140,0.22)', silo: '#16301d', silShape: 'treeline',
    ground: ['#33502f', '#22401f', '#15280f'],
    props: [{ type: 'pine', color: '#234a2b' }, { type: 'tree', color: '#2c5230' }],
    fg: 'bush', accent: { x: 0.3, y: 0.15, color: 'rgba(120,180,90,0.18)' }
  },
  tavern: {
    sky: [[0, '#2a1f12'], [0.5, '#3a2a18'], [1, '#3a2814']],
    haze: 'rgba(255,180,90,0.16)', silo: '#241608', silShape: 'planks',
    ground: ['#6a4a26', '#4d351b', '#311f10'],
    props: null, fg: null, accent: { x: 0.82, y: 0.4, color: 'rgba(255,140,40,0.32)' }
  },
  dungeon: {
    sky: [[0, '#1a1418'], [0.5, '#2a2226'], [1, '#2c2420']],
    haze: 'rgba(248,166,76,0.16)', silo: '#0f0c12', silShape: 'bricks',
    ground: ['#39322e', '#2a2420', '#171311'],
    props: null, fg: null, accent: { x: 0.5, y: 0.12, color: 'rgba(248,166,76,0.22)' }
  },
  desert: {
    sky: [[0, '#f4cf86'], [0.5, '#e9ad60'], [1, '#cda564']],
    haze: 'rgba(255,235,180,0.34)', silo: '#9a6b38', silShape: 'dunes',
    ground: ['#d9b06a', '#bd8f4e', '#8a6334'],
    props: [{ type: 'rock', color: '#b98f52' }], fg: 'rock', accent: null
  },
  snow: {
    sky: [[0, '#9fbcd0'], [0.5, '#ccdde6'], [1, '#dfeaef']],
    haze: 'rgba(255,255,255,0.40)', silo: '#5e7c92', silShape: 'mountains',
    ground: ['#e6edf0', '#cdd9de', '#9fb2bb'],
    props: [{ type: 'pine', color: '#3a5a48' }], fg: 'rock', accent: null
  },
  swamp: {
    sky: [[0, '#2e3e2c'], [0.5, '#3a4a32'], [1, '#2a3a24']],
    haze: 'rgba(190,200,150,0.24)', silo: '#16241a', silShape: 'treeline',
    ground: ['#3b4a2e', '#2c3a22', '#1a2614'],
    props: [{ type: 'tree', color: '#314a2d' }, { type: 'bush', color: '#3a4f2c' }],
    fg: 'bush', accent: { x: 0.5, y: 0.62, color: 'rgba(150,170,120,0.18)' }
  },
  cave: {
    sky: [[0, '#0a0a14'], [0.5, '#171a30'], [1, '#1a1820']],
    haze: 'rgba(90,130,210,0.16)', silo: '#05060e', silShape: 'stalactites',
    ground: ['#2a2838', '#1c1b28', '#0d0c16'],
    props: [{ type: 'rock', color: '#2c2a40' }], fg: 'rock',
    accent: { x: 0.5, y: 0.5, color: 'rgba(80,120,200,0.14)' }
  }
};

/* =====================================================================
 * Baking — one offscreen FAR + NEAR per (terrain, W×H)
 * ===================================================================== */
const _bgCache = new Map();
const _BG_MAX = 12;

function makeOffscreen(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  const OC = globalThis.OffscreenCanvas;
  if (typeof OC === 'function') return new OC(w, h);
  return null;
}

/** Deterministic per-terrain PRNG for prop scatter (no Math.random — keeps
 *  the bake reproducible). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function terrainSeed(terrain) {
  let h = 2166136261;
  for (let i = 0; i < terrain.length; i++) { h ^= terrain.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Get (or bake) the { far, near } buffers for a terrain at W×H. Returns
 *  null when no offscreen canvas is available (headless). */
function getBaked(terrain, W, H) {
  const key = `${terrain}|${W}x${H}`;
  if (_bgCache.has(key)) return _bgCache.get(key);
  const far = makeOffscreen(W, H);
  const near = makeOffscreen(W, H);
  if (!far || !near) { _bgCache.set(key, null); return null; }
  const fctx = far.getContext('2d');
  const nctx = near.getContext('2d');
  if (!fctx || !nctx) { _bgCache.set(key, null); return null; }
  const P = PALETTE[terrain] || PALETTE.grass;
  try {
    bakeFar(fctx, terrain, W, H, P);
    bakeNear(nctx, terrain, W, H, P);
  } catch {
    _bgCache.set(key, null); return null;
  }
  if (_bgCache.size >= _BG_MAX) _bgCache.delete(_bgCache.keys().next().value);
  const entry = { far, near };
  _bgCache.set(key, entry);
  return entry;
}

/** Drop the bake cache (test hygiene / resize). */
export function clearCinemaBackgroundCache() { _bgCache.clear(); }

/* ---- FAR layer: graded sky + distant silhouette + mid hero props ---- */
function bakeFar(ctx, terrain, W, H, P) {
  const horizonY = H * HORIZON;
  // Sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  for (const [pos, col] of P.sky) sky.addColorStop(pos, col);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

  // Subtle sky value-noise (cloud/air variation), cheap coarse grid.
  const noise = makeValueNoise2D(terrainSeed(terrain));
  ctx.save();
  ctx.globalAlpha = 0.06;
  const step = Math.max(8, Math.round(W / 64));
  for (let y = 0; y < horizonY; y += step) {
    for (let x = 0; x < W; x += step) {
      const n = fbm2D(noise, x / 90, y / 90, { octaves: 3 });
      ctx.fillStyle = n > 0.5 ? '#ffffff' : '#000000';
      ctx.globalAlpha = Math.abs(n - 0.5) * 0.14;
      ctx.fillRect(x, y, step, step);
    }
  }
  ctx.restore();

  // Distant silhouette band along the horizon.
  drawSilhouette(ctx, P.silShape, W, H, horizonY, P.silo);

  // Atmospheric haze at the horizon.
  const haze = ctx.createLinearGradient(0, horizonY - H * 0.18, 0, horizonY + H * 0.04);
  haze.addColorStop(0, 'rgba(0,0,0,0)');
  haze.addColorStop(0.7, P.haze);
  haze.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = haze; ctx.fillRect(0, horizonY - H * 0.18, W, H * 0.22);

  // Mid hero-sprite props standing along the horizon (parallax-far).
  if (P.props) {
    const rnd = mulberry32(terrainSeed(terrain) ^ 0x9e3779b9);
    const count = 7;
    for (let i = 0; i < count; i++) {
      const spec = P.props[i % P.props.length];
      const sprite = getHeroSprite(spec.type, (i * 2 + 1), spec.color);
      if (!sprite) continue;
      const size = H * (0.16 + rnd() * 0.12);
      const x = (i + 0.5) * (W / count) + (rnd() - 0.5) * (W / count) * 0.6;
      // base of the sprite content sits just above the horizon
      const baseFrac = 0.5 + HERO_CONTENT_FRACTION;   // ~0.90
      const dy = horizonY - size * baseFrac;
      ctx.save();
      ctx.globalAlpha = 0.55;                          // recede into distance
      ctx.drawImage(sprite, x - size / 2, dy, size, size);
      // darken for depth
      ctx.globalCompositeOperation = 'source-atop';
      ctx.restore();
    }
  }

  // Accent light (torch / fire / cool glow).
  if (P.accent) paintAccent(ctx, W, H, P.accent);

  // One-time cinematic grade (tone + sun + bloom) — biome-keyed.
  applyAtmosphere(ctx, { biome: terrain }, W, H);
}

/* ---- NEAR layer: noise-textured ground + foreground props + floor ---- */
function bakeNear(ctx, terrain, W, H, P) {
  const horizonY = H * HORIZON;
  ctx.clearRect(0, 0, W, H);
  const noise = makeValueNoise2D(terrainSeed(terrain) ^ 0x5151);
  const [c0, c1, c2] = P.ground.map(hexToRgb);

  // Textured ground band: fbm noise blends the three ground tones, with a
  // soft dither so it reads painterly rather than banded. Coarse cells for
  // speed; this is baked once.
  const cell = Math.max(3, Math.round(W / 220));
  for (let y = horizonY; y < H; y += cell) {
    const depth = (y - horizonY) / (H - horizonY);    // 0 at horizon → 1 bottom
    for (let x = 0; x < W; x += cell) {
      const n = fbm2D(noise, x / 70, y / 50, { octaves: 4 });
      // darker with depth + noise
      const t1 = Math.min(1, depth * 0.9 + n * 0.3);
      const a = mix(c0, c1, Math.min(1, n * 1.2));
      const col = mix(a, c2, t1 * 0.7);
      ctx.fillStyle = `rgb(${col.r | 0},${col.g | 0},${col.b | 0})`;
      ctx.fillRect(x, y, cell, cell);
    }
  }

  // Soft top edge so the ground meets the far layer without a hard seam.
  const edge = ctx.createLinearGradient(0, horizonY - H * 0.04, 0, horizonY + H * 0.05);
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(1, `rgba(${c0.r | 0},${c0.g | 0},${c0.b | 0},0.0)`);
  // (kept transparent; the noise already feathers — edge reserved for tuning)
  void edge;

  // Foreground detail props (rocks / bushes) — larger, fully lit.
  if (P.fg) {
    const rnd = mulberry32(terrainSeed(terrain) ^ 0x1234);
    const count = 4;
    for (let i = 0; i < count; i++) {
      const sprite = getHeroSprite(P.fg, i * 3 + 2, (P.props?.[0]?.color) || P.ground[1]);
      if (!sprite) continue;
      const size = H * (0.10 + rnd() * 0.06);
      const x = (i + 0.5) * (W / count) + (rnd() - 0.5) * 60;
      const dy = (H - H * 0.04) - size * (0.5 + HERO_CONTENT_FRACTION);
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.drawImage(sprite, x - size / 2, dy, size, size);
      ctx.restore();
    }
  }

  // Bottom vignette for grounding.
  const vg = ctx.createLinearGradient(0, H * 0.82, 0, H);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = vg; ctx.fillRect(0, H * 0.82, W, H * 0.18);

  // Floor line (kept from the original for a crisp ground plane).
  const y = horizonY + 20;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
}

/* ---- silhouette shapes ---- */
function drawSilhouette(ctx, shape, W, H, horizonY, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (shape === 'mountains') {
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    const peaks = [[0.18, 0.34], [0.32, 0.5], [0.5, 0.28], [0.7, 0.48], [0.88, 0.30]];
    for (const [px, py] of peaks) ctx.lineTo(W * px, H * py);
    ctx.lineTo(W, horizonY * 0.92); ctx.lineTo(W, horizonY); ctx.closePath(); ctx.fill();
  } else if (shape === 'dunes') {
    ctx.beginPath();
    ctx.moveTo(0, horizonY - 8);
    ctx.bezierCurveTo(W * 0.25, horizonY - 26, W * 0.6, horizonY - 2, W, horizonY - 18);
    ctx.lineTo(W, horizonY); ctx.lineTo(0, horizonY); ctx.closePath(); ctx.fill();
  } else if (shape === 'bricks') {
    ctx.save(); ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    for (let r = 0; r < 6; r++) {
      const y = H * 0.14 + r * (horizonY * 0.13);
      const shift = (r % 2) * 26;
      for (let x = -shift; x < W; x += 66) ctx.strokeRect(x, y, 62, horizonY * 0.12);
    }
    ctx.restore();
  } else if (shape === 'planks') {
    ctx.save(); ctx.globalAlpha = 0.4; ctx.lineWidth = 2;
    for (let x = 0; x < W; x += 72) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, horizonY); ctx.stroke(); }
    ctx.restore();
  } else if (shape === 'stalactites') {
    for (let i = 0; i < 9; i++) {
      const x = (i * (W / 9)) + ((i * 23) % 30);
      const w = 18 + ((i * 11) % 16), h = 30 + ((i * 19) % 40);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + w, 0); ctx.lineTo(x + w / 2, h); ctx.closePath(); ctx.fill();
    }
  } else {
    // treeline — a bumpy canopy band
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * W;
      const y = horizonY - (H * 0.10) * (0.5 + 0.5 * Math.sin(i * 1.7));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, horizonY); ctx.closePath(); ctx.fill();
  }
}

function paintAccent(ctx, W, H, accent) {
  const g = ctx.createRadialGradient(W * accent.x, H * accent.y, 0, W * accent.x, H * accent.y, W * 0.5);
  g.addColorStop(0, accent.color);
  g.addColorStop(1, accent.color.replace(/[\d.]+\)$/, '0)'));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

/* ---- small colour helpers ---- */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

/* =====================================================================
 * Public backgrounds — paintFar / paintNear blit the baked buffers, with
 * a lightweight gradient fallback when no offscreen canvas exists.
 * ===================================================================== */
function makeBackground(terrain) {
  const paintFar = (ctx, { W, H }) => {
    const baked = getBaked(terrain, W, H);
    if (baked && baked.far) { ctx.drawImage(baked.far, 0, 0); return; }
    fallbackFar(ctx, W, H, PALETTE[terrain] || PALETTE.grass);
  };
  const paintNear = (ctx, { W, H }) => {
    const baked = getBaked(terrain, W, H);
    if (baked && baked.near) { ctx.drawImage(baked.near, 0, 0); return; }
    fallbackNear(ctx, W, H);
  };
  const combined = (ctx, opts) => { paintFar(ctx, opts); paintNear(ctx, opts); };
  combined.paintFar = paintFar;
  combined.paintNear = paintNear;
  return combined;
}

/** Headless / no-canvas fallback — the original cheap gradient. */
function fallbackFar(ctx, W, H, P) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  for (const [pos, col] of P.sky) g.addColorStop(pos, col);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
function fallbackNear(ctx, W, H) {
  const y = H * HORIZON + 20;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
}

export const BG_GRASS = makeBackground('grass');
export const BG_DUNGEON = makeBackground('dungeon');
export const BG_TAVERN = makeBackground('tavern');
export const BG_FOREST = makeBackground('forest');
export const BG_DESERT = makeBackground('desert');
export const BG_SNOW = makeBackground('snow');
export const BG_SWAMP = makeBackground('swamp');
export const BG_CAVE = makeBackground('cave');

export const BACKGROUNDS = {
  grass: BG_GRASS,
  dungeon: BG_DUNGEON,
  tavern: BG_TAVERN,
  forest: BG_FOREST,
  desert: BG_DESERT,
  snow: BG_SNOW,
  swamp: BG_SWAMP,
  cave: BG_CAVE
};
