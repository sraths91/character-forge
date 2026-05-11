/**
 * Tier-1 item-sprite generator.
 *
 * Mutates a base LPC sprite based on item metadata (material, magical glow,
 * rarity aura). Runs unmodified in browser and Node 20+ via globalThis.crypto.
 *
 * The synthesise() / pngDataUrlToCanvas() helpers reference the DOM and only
 * run in the browser. computeItemHash + the classify helpers are DOM-free
 * and safe to call from Node tests.
 *
 * Hash input: [name, rarity, magical?'1':'0', damageType||'', slot, baseAsset].join('|')
 * If the input dimensions ever change, ALSO bump ITEM_GENERATOR_VERSION in
 * api/db/database.js so existing cache rows are filtered out.
 */

// Ordering matters: detectMaterial does a substring scan and returns the
// first match. Multi-word/compound entries first.
const MATERIAL_TABLE = {
  flame:      { hueShift:  10, satMul: 1.6, lightMul: 0.95, accent: '#dc2626' },
  shadow:     { hueShift: 270, satMul: 0.7, lightMul: 0.45, accent: '#1e1b4b' },
  ice:        { hueShift: 195, satMul: 0.8, lightMul: 1.15, accent: '#bae6fd' },
  adamantine: { hueShift: 230, satMul: 0.6, lightMul: 0.55, accent: '#2a2a3a' },
  mithral:    { hueShift: 210, satMul: 0.7, lightMul: 1.10, accent: '#c5d6e8' },
  silvered:   { hueShift:   0, satMul: 0.0, lightMul: 1.15, accent: '#d4d4d8' },
  silver:     { hueShift:   0, satMul: 0.0, lightMul: 1.15, accent: '#d4d4d8' },
  gold:       { hueShift:  45, satMul: 1.4, lightMul: 1.05, accent: '#fbbf24' },
  obsidian:   { hueShift:   0, satMul: 0.0, lightMul: 0.35, accent: '#0f0f0f' },
  dragonbone: { hueShift:  45, satMul: 0.4, lightMul: 1.20, accent: '#f5e8c8' },
  copper:     { hueShift:  20, satMul: 1.4, lightMul: 0.85, accent: '#c97142' },
  bronze:     { hueShift:  35, satMul: 1.0, lightMul: 0.85, accent: '#a16207' }
};

const MATERIAL_ALIASES = {
  frost: 'ice',
  fiery: 'flame',
  shadowed: 'shadow',
  'dragon bone': 'dragonbone'
};

const DAMAGE_GLOW = {
  fire:      '#ef4444',
  cold:      '#38bdf8',
  lightning: '#facc15',
  thunder:   '#6366f1',
  radiant:   '#fbbf24',
  necrotic:  '#7e22ce',
  psychic:   '#ec4899',
  poison:    '#16a34a',
  acid:      '#84cc16',
  force:     '#c084fc'
};

const RARITY_AURA = {
  common:    { color: null,      alpha: 0 },
  uncommon:  { color: '#60a5fa', alpha: 0.25 },
  rare:      { color: '#3b82f6', alpha: 0.40 },
  very_rare: { color: '#a855f7', alpha: 0.50 },
  legendary: { color: '#f59e0b', alpha: 0.55 },
  artifact:  { color: '#dc2626', alpha: 0.65 }
};

/** First-match substring scan, aliases first. Returns the canonical key or null. */
export function detectMaterial(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  for (const [alias, target] of Object.entries(MATERIAL_ALIASES)) {
    if (lower.includes(alias)) return target;
  }
  for (const key of Object.keys(MATERIAL_TABLE)) {
    if (lower.includes(key)) return key;
  }
  return null;
}

export function glowFromDamageType(dt, magical) {
  if (!magical) return null;
  const key = String(dt || '').toLowerCase();
  return DAMAGE_GLOW[key] || (magical ? '#a78bfa' : null);
}

export function rarityToAuraTier(rarity) {
  const key = String(rarity || 'common').toLowerCase().replace(/\s+/g, '_');
  return RARITY_AURA[key] || RARITY_AURA.common;
}

/** SHA-1 of a stable input string. Works in browser and Node 20+. */
export async function computeItemHash(item, baseAsset, slot) {
  const parts = [
    String(item?.name || ''),
    String(item?.rarity || 'common'),
    item?.magical ? '1' : '0',
    String(item?.damageType || ''),
    String(slot || ''),
    String(baseAsset || '')
  ];
  const input = parts.join('|');
  const bytes = new TextEncoder().encode(input);
  const buf = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  const view = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ----- Browser-only synthesis pipeline -----

/** Map<hash, Promise<{canvas, hash, mutated}>>. Module-scoped, lives for page lifetime. */
const itemCache = new Map();

/**
 * Generate a mutated sprite for the given item or return {mutated: false}
 * to signal the caller should use the base asset unchanged.
 */
export async function generateItemSprite(item, baseAsset, slot) {
  const materialKey = detectMaterial(item?.name);
  const glowColor = glowFromDamageType(item?.damageType, !!item?.magical);

  const hash = await computeItemHash(item, baseAsset, slot);

  // Aura is no longer baked into the per-item canvas — the compositor draws
  // a single backdrop aura from the highest-rarity item. So mutation here is
  // decided by material + glow only. Common-rarity magical items still mutate
  // (glow); plain mundane items still pass through.
  if (!materialKey && !glowColor) {
    return { canvas: null, hash, mutated: false };
  }

  if (itemCache.has(hash)) return itemCache.get(hash);

  const promise = (async () => {
    try {
      // Try server cache first
      const res = await fetch(`/api/items/${hash}`);
      if (res.ok) {
        const { png } = await res.json();
        const canvas = await pngDataUrlToCanvas(png);
        return { canvas, hash, mutated: true };
      }

      // Cache miss — synthesise locally
      const { loadImage } = await import('./image-cache.js');
      const { getFrame } = await import('./lpc-config.js');
      const baseImg = await loadImage(baseAsset);
      const frame = getFrame(baseAsset);
      const canvas = synthesise(baseImg, materialKey, glowColor, frame);

      // Fire-and-forget POST
      const png = canvas.toDataURL('image/png');
      fetch(`/api/items/${hash}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          png,
          itemName: String(item?.name || '').slice(0, 200),
          baseAsset: String(baseAsset || '').slice(0, 200)
        })
      }).catch(() => {});

      return { canvas, hash, mutated: true };
    } catch (err) {
      // Base PNG load failed or other unexpected error. Fall back to base asset
      // by signalling no mutation; the compositor will draw the unmodified
      // sprite (and itself fall through to a procedural rect if THAT fails).
      // eslint-disable-next-line no-console
      console.warn('[item-generator]', item?.name, err);
      return { canvas: null, hash, mutated: false };
    }
  })();

  itemCache.set(hash, promise);
  return promise;
}

function pngDataUrlToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { colorSpace: 'srgb' });
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('Failed to decode cached PNG'));
    img.src = dataUrl;
  });
}

function synthesise(baseImg, materialKey, glowColor, frame) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
  ctx.imageSmoothingEnabled = false;

  // 1) Item frame (per-asset frame from FRAME_OVERRIDES, defaults to
  //    south-idle). Aura is drawn by the compositor as a single backdrop
  //    from the highest-rarity item, not baked per-item.
  ctx.drawImage(baseImg, frame.sx, frame.sy, frame.sw, frame.sh, 0, 0, 64, 64);

  // 2) Material recolour on metallic pixels
  if (materialKey) {
    const m = MATERIAL_TABLE[materialKey];
    const data = ctx.getImageData(0, 0, 64, 64, { colorSpace: 'srgb' });
    recolourMetallic(data, m);
    ctx.putImageData(data, 0, 0);
  }

  // 3) Magical glow (additive, masked by item alpha)
  if (glowColor) {
    const overlay = document.createElement('canvas');
    overlay.width = 64;
    overlay.height = 64;
    const octx = overlay.getContext('2d', { colorSpace: 'srgb' });
    octx.fillStyle = glowColor;
    octx.fillRect(0, 0, 64, 64);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(baseImg, frame.sx, frame.sy, frame.sw, frame.sh, 0, 0, 64, 64);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35;
    ctx.drawImage(overlay, 0, 0);
    ctx.restore();
  }

  return canvas;
}

function recolourMetallic(data, material) {
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let s;
    if (max === min) s = 0;
    else if (l > 0.5) s = (max - min) / (2 - max - min);
    else s = (max - min) / (max + min);
    // Metallic = low saturation, mid lightness
    if (s >= 0.18 || l <= 0.18 || l >= 0.82) continue;
    const newL = clamp(l * material.lightMul, 0.05, 0.95);
    const newS = clamp(s * material.satMul, 0, 1);
    const newH = (material.hueShift % 360) / 360;
    const [nr, ng, nb] = hslToRgb(newH, newS, newL);
    px[i] = Math.round(nr * 255);
    px[i + 1] = Math.round(ng * 255);
    px[i + 2] = Math.round(nb * 255);
  }
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToRgb(p, q, h + 1 / 3),
    hueToRgb(p, q, h),
    hueToRgb(p, q, h - 1 / 3)
  ];
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
