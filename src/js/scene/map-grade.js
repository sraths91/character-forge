/**
 * M50 Phase A — Atmospheric color-grade + bloom.
 *
 * A cinematic finishing pass over a fully-painted generated map. Run as
 * the final step of paintMapModel (map-render.js), it unifies the image
 * the way a graded photo or a hand-painted VTT map reads as one cohesive
 * scene rather than a pile of separately-drawn elements:
 *
 *   1. Grade — a per-biome tone pass (getImageData): shadows pulled
 *      toward the biome's shadow hue, gentle contrast, saturation lift.
 *   2. Sun  — an additive warm light gradient from the top-left light
 *      direction, matching the per-object lighting used elsewhere.
 *   3. Bloom — a bright-pass → blur → additive composite, so highlights
 *      (fire, crystals, water foam, snow, sand) softly glow.
 *
 * This is a ONE-TIME pass: it runs inside the cached offscreen paint, so
 * the per-frame combat blit is unaffected.
 *
 * Real-canvas only. With a headless mock ctx (no getImageData / no
 * offscreen buffer) the whole pass is a safe no-op, so node tests are
 * unaffected and the map simply renders ungraded.
 */

/**
 * Per-biome grade. `shadow`/`ambient` tint the dark end; `sun` is the
 * additive highlight colour; `sat`/`contrast` shape the tone curve;
 * `sunStrength`/`bloom` scale the light + glow passes.
 */
export const GRADE = {
  grass:   { shadow: '#16281a', sun: '#fff3c8', sat: 1.12, contrast: 0.06, shadowStrength: 0.20, sunStrength: 0.16, bloom: 0.16 },
  forest:  { shadow: '#0e2018', sun: '#ffe9b0', sat: 1.14, contrast: 0.08, shadowStrength: 0.26, sunStrength: 0.16, bloom: 0.14 },
  dungeon: { shadow: '#0a0c14', sun: '#9fb4d6', sat: 0.92, contrast: 0.10, shadowStrength: 0.30, sunStrength: 0.10, bloom: 0.22 },
  cave:    { shadow: '#080a16', sun: '#88a6d8', sat: 0.88, contrast: 0.10, shadowStrength: 0.32, sunStrength: 0.10, bloom: 0.26 },
  tavern:  { shadow: '#241208', sun: '#ffd089', sat: 1.10, contrast: 0.07, shadowStrength: 0.24, sunStrength: 0.20, bloom: 0.22 },
  desert:  { shadow: '#7a5a2e', sun: '#fff0c2', sat: 1.06, contrast: 0.05, shadowStrength: 0.14, sunStrength: 0.22, bloom: 0.20 },
  snow:    { shadow: '#9fb4c4', sun: '#ffffff', sat: 0.96, contrast: 0.06, shadowStrength: 0.12, sunStrength: 0.20, bloom: 0.30 },
  swamp:   { shadow: '#16201a', sun: '#e8e3a0', sat: 1.02, contrast: 0.07, shadowStrength: 0.28, sunStrength: 0.12, bloom: 0.14 }
};

/**
 * Apply the atmosphere pass in place. No-op when the ctx can't support
 * a true grade (headless mock).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} model — generateMapModel result (reads model.biome)
 * @param {number} W — canvas width px
 * @param {number} H — canvas height px
 */
export function applyAtmosphere(ctx, model, W, H) {
  if (!ctx || !model) return;
  // Gate: a real grade needs pixel access + offscreen buffers.
  if (typeof ctx.getImageData !== 'function' || typeof ctx.putImageData !== 'function') return;
  const grade = GRADE[model.biome] || GRADE.grass;
  try {
    gradeTone(ctx, W, H, grade);
    sunLight(ctx, W, H, grade);
    bloom(ctx, W, H, grade);
  } catch {
    /* canvas may be tainted / unsupported — leave the map ungraded. */
  }
}

/* =====================================================================
 * Passes
 * ===================================================================== */

/** Tone grade: shadow tint + contrast + saturation, one getImageData. */
function gradeTone(ctx, W, H, grade) {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const sh = hexToRgb(grade.shadow);
  const c = 1 + (grade.contrast || 0);
  const sat = grade.sat ?? 1;
  const ss = grade.shadowStrength || 0;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    // Shadow tint — darker pixels pull toward the biome shadow hue.
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const mix = (1 - luma / 255) * ss;
    r = r + (sh.r - r) * mix;
    g = g + (sh.g - g) * mix;
    b = b + (sh.b - b) * mix;
    // Contrast around mid grey.
    r = (r - 128) * c + 128;
    g = (g - 128) * c + 128;
    b = (b - 128) * c + 128;
    // Saturation around luma.
    const l2 = 0.299 * r + 0.587 * g + 0.114 * b;
    r = l2 + (r - l2) * sat;
    g = l2 + (g - l2) * sat;
    b = l2 + (b - l2) * sat;
    d[i] = clamp255(r); d[i + 1] = clamp255(g); d[i + 2] = clamp255(b);
  }
  ctx.putImageData(img, 0, 0);
}

/** Additive warm sun gradient from the top-left light direction. */
function sunLight(ctx, W, H, grade) {
  if (!ctx.createRadialGradient) return;
  const g = ctx.createRadialGradient(W * 0.22, H * 0.18, 0, W * 0.22, H * 0.18, Math.hypot(W, H) * 0.9);
  g.addColorStop(0, withAlpha(grade.sun, grade.sunStrength || 0.15));
  g.addColorStop(0.5, withAlpha(grade.sun, (grade.sunStrength || 0.15) * 0.35));
  g.addColorStop(1, withAlpha(grade.sun, 0));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/**
 * Bloom — bright-pass the graded image into a small buffer, blur it by
 * downscale→upscale, and additively composite it back so highlights
 * glow. Strength is per-biome (snow/cave glow most).
 */
function bloom(ctx, W, H, grade) {
  const strength = grade.bloom || 0;
  if (strength <= 0) return;
  const small = makeBuffer(Math.max(2, Math.round(W / 6)), Math.max(2, Math.round(H / 6)));
  if (!small) return;
  const sctx = small.getContext('2d');
  if (!sctx || typeof sctx.createImageData !== 'function') return;
  // Bright pass at low res (sample the full image down into the buffer).
  const src = ctx.getImageData(0, 0, W, H).data;
  const bw = small.width, bh = small.height;
  const out = sctx.createImageData(bw, bh);
  const od = out.data;
  const T = 165;   // luma threshold
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const sx = Math.min(W - 1, Math.floor((x / bw) * W));
      const sy = Math.min(H - 1, Math.floor((y / bh) * H));
      const si = (sy * W + sx) * 4;
      const r = src[si], g = src[si + 1], b = src[si + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const k = luma > T ? (luma - T) / (255 - T) : 0;
      const oi = (y * bw + x) * 4;
      od[oi] = r; od[oi + 1] = g; od[oi + 2] = b; od[oi + 3] = Math.round(255 * k);
    }
  }
  sctx.putImageData(out, 0, 0);
  // Blur: bounce through an even smaller buffer for a soft spread.
  const tiny = makeBuffer(Math.max(1, bw >> 1), Math.max(1, bh >> 1));
  if (tiny) {
    const tctx = tiny.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(small, 0, 0, tiny.width, tiny.height);
    sctx.clearRect(0, 0, bw, bh);
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(tiny, 0, 0, bw, bh);
  }
  // Composite the blurred highlights back, additively.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = strength;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, bw, bh, 0, 0, W, H);
  ctx.restore();
}

/* =====================================================================
 * Helpers (self-contained so this module has no map-render dependency)
 * ===================================================================== */

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
  if (!m) return { r: 128, g: 128, b: 128 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function withAlpha(hex, a) {
  const c = hexToRgb(hex);
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}
function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
