/**
 * M64 E5 / M7 — CSS filter functions as pure pixel math (P0-11).
 *
 * `CanvasRenderingContext2D.filter` is disabled in Safari / iOS Safari, so
 * every recolour drawn through it (skin tone, hair colour, wounded/down,
 * poisoned/paralyzed/invisible tints) silently vanished on Apple devices.
 * This module implements the five filter functions the sprite pipeline
 * uses with the colour matrices from the W3C Filter Effects spec
 * (https://www.w3.org/TR/filter-effects-1/#ShorthandEquivalents):
 * hue-rotate, saturate, brightness, sepia, opacity. Each function is
 * applied in order on unpremultiplied sRGB values and clamped to [0, 1],
 * matching how browsers chain shorthand filters.
 *
 * Pure: the input array is never modified. Node-safe.
 */

/**
 * @typedef {{op: 'hue-rotate'|'saturate'|'brightness'|'sepia'|'opacity', amount: number}} FilterOp
 */

const SUPPORTED = new Set(['hue-rotate', 'saturate', 'brightness', 'sepia', 'opacity']);

function parseAmount(op, raw) {
  const s = String(raw).trim();
  if (op === 'hue-rotate') {
    const v = parseFloat(s);
    if (!Number.isFinite(v)) return 0;
    if (/turn$/.test(s)) return v * 360;
    if (/grad$/.test(s)) return v * 0.9;
    if (/rad$/.test(s)) return (v * 180) / Math.PI;
    return v;   // deg (or a bare number)
  }
  if (s === '') return 1;
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return 1;
  return s.endsWith('%') ? v / 100 : v;
}

/**
 * Parse a CSS filter string ('saturate(1.4) hue-rotate(-15deg) …') into
 * ops. Unsupported functions are skipped; null/'none' gives [].
 * @param {string|null|undefined} filter
 * @returns {FilterOp[]}
 */
export function parseCssFilter(filter) {
  if (!filter || filter === 'none') return [];
  const ops = [];
  for (const m of String(filter).matchAll(/([a-z-]+)\(([^)]*)\)/gi)) {
    const op = m[1].toLowerCase();
    if (!SUPPORTED.has(op)) continue;
    ops.push({ op, amount: parseAmount(op, m[2]) });
  }
  return ops;
}

/**
 * 3×3 RGB matrix (row-major) for a colour op, or null for alpha/linear ops.
 * @param {FilterOp} f
 * @returns {number[]|null}
 */
export function colorMatrixFor(f) {
  const a = f.amount;
  switch (f.op) {
    case 'saturate': {
      const s = Math.max(0, a);
      return [
        0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s
      ];
    }
    case 'hue-rotate': {
      const r = (a * Math.PI) / 180;
      const c = Math.cos(r), s = Math.sin(r);
      return [
        0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072
      ];
    }
    case 'sepia': {
      const k = 1 - Math.min(1, Math.max(0, a));
      return [
        0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k,
        0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k,
        0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k
      ];
    }
    default:
      return null;
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/**
 * Apply filter ops to RGBA pixels (ImageData.data layout).
 * @param {Uint8ClampedArray} data — unpremultiplied RGBA, as getImageData returns
 * @param {FilterOp[]|string} ops — parsed ops or a CSS filter string
 * @returns {Uint8ClampedArray} a new array
 */
export function applyFilterMatrix(data, ops) {
  const list = typeof ops === 'string' || ops == null ? parseCssFilter(ops) : ops;
  const out = new Uint8ClampedArray(data);
  if (list.length === 0) return out;
  const steps = list.map(f => ({ f, m: colorMatrixFor(f) }));
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue;
    let r = out[i] / 255, g = out[i + 1] / 255, b = out[i + 2] / 255, al = out[i + 3] / 255;
    for (const { f, m } of steps) {
      if (m) {
        const nr = m[0] * r + m[1] * g + m[2] * b;
        const ng = m[3] * r + m[4] * g + m[5] * b;
        const nb = m[6] * r + m[7] * g + m[8] * b;
        r = clamp01(nr); g = clamp01(ng); b = clamp01(nb);
      } else if (f.op === 'brightness') {
        const k = Math.max(0, f.amount);
        r = clamp01(r * k); g = clamp01(g * k); b = clamp01(b * k);
      } else if (f.op === 'opacity') {
        al = clamp01(al * clamp01(f.amount));
      }
    }
    out[i] = Math.round(r * 255);
    out[i + 1] = Math.round(g * 255);
    out[i + 2] = Math.round(b * 255);
    out[i + 3] = Math.round(al * 255);
  }
  return out;
}
