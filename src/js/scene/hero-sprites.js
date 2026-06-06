/**
 * M50 Phase C — Procedurally-baked hero-sprite atlas.
 *
 * The "hero" features of a map — trees, boulders, bushes — carry most of
 * its visual weight, but drawing high-detail foliage with dozens of
 * primitives *per feature per paint* is too costly to do inline. Instead
 * we bake each variant ONCE to an offscreen canvas at a generous fixed
 * resolution (far more detail than the per-call draw can afford — 40+
 * foliage lobes, leaf speckle, trunk, ambient occlusion, rim light),
 * cache it, and stamp it with rotation + scale variety via drawImage.
 *
 * The generator still decides WHERE features go (region-aware placement);
 * this module only upgrades how the hero items are RENDERED.
 *
 * Cache key is (type, variant, color) — independent of the map seed, so
 * the atlas is shared across every map and reroll. Pure offscreen canvas
 * draws; deterministic per (variant) via a seeded PRNG. Returns null in
 * headless/test environments (no canvas) so callers fall back to the
 * lightweight inline draws.
 */

const SPRITE_PX = 256;           // baked internal resolution
const _atlas = new Map();        // key → canvas | null
const _ATLAS_MAX = 96;

/**
 * Get (or bake) a hero sprite canvas for `type` + `variant` + base
 * `color`. Returns null if no canvas can be created.
 */
export function getHeroSprite(type, variant, color) {
  const key = `${type}|${variant}|${color}`;
  if (_atlas.has(key)) return _atlas.get(key);
  const cv = makeBuffer(SPRITE_PX, SPRITE_PX);
  if (!cv) { _atlas.set(key, null); return null; }
  const ctx = cv.getContext('2d');
  if (!ctx) { _atlas.set(key, null); return null; }
  ctx.translate(SPRITE_PX / 2, SPRITE_PX / 2);
  const r = SPRITE_PX * 0.40;
  switch (type) {
    case 'tree': (variant % 3 === 2 ? bakePine : bakeOak)(ctx, r, variant, color); break;
    case 'pine': bakePine(ctx, r, variant, color); break;
    case 'rock': bakeBoulder(ctx, r, variant, color); break;
    case 'bush': bakeBush(ctx, r, variant, color); break;
    default: _atlas.set(key, null); return null;
  }
  if (_atlas.size >= _ATLAS_MAX) _atlas.delete(_atlas.keys().next().value);
  _atlas.set(key, cv);
  return cv;
}

/** Fraction of the baked sprite radius that holds the canopy/body, so
 *  the caller can scale the stamp to match a feature's cell radius. */
export const HERO_CONTENT_FRACTION = 0.40;

/** Drop the cache (test hygiene / theme change). */
export function clearHeroAtlas() { _atlas.clear(); }

/* =====================================================================
 * Bakers — high-detail, one-time draws
 * ===================================================================== */

function bakeOak(ctx, r, variant, color) {
  const rnd = prng(variant * 2654435761 + 1013904223);
  const dark = darken(color, 36), mid = color, light = lighten(color, 32);
  // Cast shadow (offset down-right; light from top-left).
  ctx.save();
  ctx.globalAlpha = 0.3; ctx.fillStyle = '#0a140c';
  ctx.beginPath(); ctx.ellipse(r * 0.18, r * 0.24, r * 1.02, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // Trunk hint at the base.
  ctx.fillStyle = '#4a3522';
  ctx.fillRect(-r * 0.08, r * 0.18, r * 0.16, r * 0.5);
  // Foliage lobes.
  const N = 46;
  const lobes = [];
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2;
    const rad = Math.sqrt(rnd()) * r * 0.92;
    const lr = r * (0.16 + 0.16 * rnd());
    lobes.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad, lr });
  }
  ctx.fillStyle = dark;
  for (const L of lobes) { ctx.beginPath(); ctx.arc(L.x, L.y, L.lr, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = mid;
  for (const L of lobes) { ctx.beginPath(); ctx.arc(L.x - r * 0.05, L.y - r * 0.05, L.lr * 0.82, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = light; ctx.globalAlpha = 0.9;
  for (const L of lobes) {
    if (L.x + L.y < -r * 0.15) { ctx.beginPath(); ctx.arc(L.x - r * 0.1, L.y - r * 0.1, L.lr * 0.5, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  // Leaf speckle — fine highlight + shadow flecks for texture.
  for (let i = 0; i < 90; i++) {
    const a = rnd() * Math.PI * 2, rad = Math.sqrt(rnd()) * r * 0.9;
    const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    ctx.fillStyle = rnd() < 0.5 ? lighten(color, 18) : darken(color, 16);
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.arc(x, y, r * 0.035, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Dark canopy gaps for depth.
  ctx.fillStyle = darken(color, 30); ctx.globalAlpha = 0.5;
  for (let i = 0; i < 3; i++) {
    const a = rnd() * Math.PI * 2, rad = rnd() * r * 0.5;
    ctx.beginPath(); ctx.arc(Math.cos(a) * rad, Math.sin(a) * rad, r * 0.12, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function bakePine(ctx, r, variant, color) {
  const rnd = prng(variant * 40503 + 7);
  const dark = darken(color, 34), light = lighten(color, 26);
  // Shadow.
  ctx.save();
  ctx.globalAlpha = 0.3; ctx.fillStyle = '#0a140c';
  ctx.beginPath(); ctx.ellipse(r * 0.16, r * 0.3, r * 0.7, r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // Trunk.
  ctx.fillStyle = '#3f2c1a';
  ctx.fillRect(-r * 0.07, r * 0.4, r * 0.14, r * 0.5);
  // Stacked conifer tiers, wide at the bottom.
  const tiers = 4;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);             // 0 top .. 1 bottom
    const cy = -r * 0.7 + f * r * 1.3;
    const tw = r * (0.28 + f * 0.7);
    const th = r * 0.55;
    const jitter = (rnd() - 0.5) * r * 0.06;
    ctx.fillStyle = dark;
    triangle(ctx, jitter, cy + th, tw, th);
    ctx.fillStyle = color;
    triangle(ctx, jitter - r * 0.03, cy + th - r * 0.04, tw * 0.86, th * 0.9);
    ctx.fillStyle = light; ctx.globalAlpha = 0.6;
    triangle(ctx, jitter - tw * 0.2, cy + th - r * 0.06, tw * 0.4, th * 0.7);
    ctx.globalAlpha = 1;
  }
}

function bakeBoulder(ctx, r, variant, color) {
  const rnd = prng(variant * 19349663 + 97);
  // Shadow.
  ctx.save();
  ctx.globalAlpha = 0.34; ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(r * 0.2, r * 0.26, r * 0.95, r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // Irregular boulder silhouette (jittered polygon).
  const pts = [];
  const sides = 8;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const rad = r * (0.7 + 0.28 * rnd());
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad * 0.82]);
  }
  // Base fill with a light→dark facet gradient.
  if (ctx.createLinearGradient) {
    const g = ctx.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, lighten(color, 24));
    g.addColorStop(1, darken(color, 26));
    ctx.fillStyle = g;
  } else ctx.fillStyle = color;
  polygon(ctx, pts); ctx.fill();
  // Facet planes (a few darker/lighter triangles from centre).
  for (let i = 0; i < sides; i++) {
    const a = pts[i], b = pts[(i + 1) % sides];
    ctx.fillStyle = (i % 2 ? darken(color, 14) : lighten(color, 12));
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(0, -r * 0.1); ctx.lineTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Cracks.
  ctx.strokeStyle = darken(color, 34); ctx.lineWidth = r * 0.04; ctx.lineCap = 'round';
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    ctx.moveTo((rnd() - 0.5) * r, -r * 0.5);
    ctx.lineTo((rnd() - 0.5) * r * 0.6, r * 0.4);
    ctx.stroke();
  }
  // Top-left rim highlight.
  ctx.strokeStyle = lighten(color, 30); ctx.globalAlpha = 0.6; ctx.lineWidth = r * 0.05;
  ctx.beginPath();
  ctx.moveTo(pts[5][0], pts[5][1]); ctx.lineTo(pts[6][0], pts[6][1]); ctx.lineTo(pts[7][0], pts[7][1]);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // A little moss at the base.
  ctx.fillStyle = '#4a6b3a'; ctx.globalAlpha = 0.4;
  ctx.beginPath(); ctx.ellipse(-r * 0.1, r * 0.4, r * 0.5, r * 0.18, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

function bakeBush(ctx, r, variant, color) {
  const rnd = prng(variant * 374761393 + 11);
  const dark = darken(color, 28), light = lighten(color, 24);
  ctx.save();
  ctx.globalAlpha = 0.26; ctx.fillStyle = '#0a140c';
  ctx.beginPath(); ctx.ellipse(r * 0.1, r * 0.34, r * 0.85, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  const N = 24;
  const lobes = [];
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2, rad = Math.sqrt(rnd()) * r * 0.7;
    lobes.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad * 0.85, lr: r * (0.22 + 0.14 * rnd()) });
  }
  ctx.fillStyle = dark;
  for (const L of lobes) { ctx.beginPath(); ctx.arc(L.x, L.y, L.lr, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = color;
  for (const L of lobes) { ctx.beginPath(); ctx.arc(L.x - r * 0.04, L.y - r * 0.05, L.lr * 0.8, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = light; ctx.globalAlpha = 0.75;
  for (const L of lobes) {
    if (L.x + L.y < 0) { ctx.beginPath(); ctx.arc(L.x - r * 0.08, L.y - r * 0.08, L.lr * 0.45, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

function triangle(ctx, cx, baseY, halfW, h) {
  ctx.beginPath();
  ctx.moveTo(cx, baseY - h);
  ctx.lineTo(cx + halfW, baseY);
  ctx.lineTo(cx - halfW, baseY);
  ctx.closePath();
  ctx.fill();
}
function polygon(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/** Small deterministic PRNG (mulberry32) for stable per-variant bakes. */
function prng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBuffer(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
  }
  const Off = globalThis.OffscreenCanvas;
  if (typeof Off === 'function') return new Off(w, h);
  return null;
}

function hexToRgb(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
  if (!m) return { r: 90, g: 110, b: 70 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
function lighten(hex, a) { const c = hexToRgb(hex); return `rgb(${clamp255(c.r + a)},${clamp255(c.g + a)},${clamp255(c.b + a)})`; }
function darken(hex, a) { const c = hexToRgb(hex); return `rgb(${clamp255(c.r - a)},${clamp255(c.g - a)},${clamp255(c.b - a)})`; }
