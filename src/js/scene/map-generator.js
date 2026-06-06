/**
 * Procedural battle-map model generator.
 *
 * Pure, deterministic, headless — turns a (biome, cols, rows, seed) into
 * a structured map model the renderer (map-render.js) paints top-down.
 * No canvas, no DOM. The same inputs always produce the same model, so
 * a scene persists as just { biome, seed } and regenerates identically
 * on load.
 *
 * VISUAL ONLY: the features here carry no game-rule meaning. A "tree" is
 * a canopy blob to draw, not difficult terrain. Movement and combat
 * never read this model.
 *
 * Coherence: an fBm field (noise.js) acts as a combined
 * elevation/moisture map. Water clusters in the low/wet band, vegetation
 * in the mid band, bare rock on the high/dry band — so a generated map
 * reads as terrain rather than uniform scatter. Feature placement is
 * seeded per cell, biased away from cell centers (corner jitter) so
 * tokens dropped on a cell stay readable, and capped per-biome by
 * `maxCoverage` so the field never hides the grid.
 */

import { makeValueNoise2D, fbm2D, hash2 } from './noise.js';

/**
 * Per-biome art direction. Each entry defines the base ground palette
 * (light → dark for the fBm mottle), the feature mix with placement
 * bands, and a density / coverage budget. The eight slugs mirror
 * SCENE_PRESETS so the cinema backdrop + grid color stay in sync.
 *
 * Feature `band`: which elevation/moisture range (0..1) the feature
 * prefers. `chance`: per-eligible-cell probability. `r`: radius as a
 * fraction of a cell (capped ≤ 0.42 so blockers don't bleed across
 * cell lines). `palette`: fill colors, picked by `variant`.
 */
export const BIOME_FEATURES = {
  grass: {
    ground: { base: '#3d5a3d', light: '#4a6b46', dark: '#2f4831' },
    maxCoverage: 0.5,
    features: [
      { type: 'tuft',  band: [0.30, 1.00], chance: 0.40, r: 0.16, palette: ['#5a7d4e', '#456b3a', '#6b8f57'] },
      { type: 'dirt',  band: [0.00, 0.34], chance: 0.30, r: 0.30, palette: ['#5c5038', '#6b5d44'] },
      { type: 'rock',  band: [0.70, 1.00], chance: 0.08, r: 0.22, palette: ['#7d7d72', '#8c8c80'] }
    ]
  },
  forest: {
    ground: { base: '#1e3a23', light: '#27482c', dark: '#152c19' },
    maxCoverage: 0.6,
    features: [
      { type: 'tree',   band: [0.35, 1.00], chance: 0.34, r: 0.40, palette: ['#2f5d36', '#274d2d', '#386b40'] },
      { type: 'tuft',   band: [0.20, 0.80], chance: 0.30, r: 0.16, palette: ['#3a6b40', '#2d5733'] },
      { type: 'water',  band: [0.00, 0.20], chance: 0.30, r: 0.36, palette: ['#2c4a52', '#33555e'] }
    ]
  },
  dungeon: {
    ground: { base: '#2a2a2e', light: '#34343a', dark: '#202024' },
    maxCoverage: 0.45,
    features: [
      { type: 'rock',   band: [0.55, 1.00], chance: 0.20, r: 0.34, palette: ['#3a3a40', '#45454c', '#303036'] },
      { type: 'rubble', band: [0.00, 0.55], chance: 0.28, r: 0.12, palette: ['#3d3d42', '#4a4a50'] }
    ]
  },
  cave: {
    ground: { base: '#1a1820', light: '#23212c', dark: '#121017' },
    maxCoverage: 0.5,
    features: [
      { type: 'rock',   band: [0.50, 1.00], chance: 0.26, r: 0.38, palette: ['#2a2833', '#33303d', '#211f29'] },
      { type: 'rubble', band: [0.00, 0.50], chance: 0.30, r: 0.12, palette: ['#2d2b36', '#38353f'] },
      { type: 'water',  band: [0.00, 0.12], chance: 0.40, r: 0.34, palette: ['#1f3540', '#27414d'] }
    ]
  },
  tavern: {
    ground: { base: '#6b3f1a', light: '#7d4d22', dark: '#5a3415' },
    maxCoverage: 0.35,
    features: [
      { type: 'plank',  band: [0.00, 1.00], chance: 0.22, r: 0.30, palette: ['#5e3716', '#7a4a20'] },
      { type: 'rug',    band: [0.40, 0.65], chance: 0.10, r: 0.40, palette: ['#7a2d2d', '#8c3a2a'] }
    ]
  },
  desert: {
    ground: { base: '#c8a665', light: '#d8b878', dark: '#b3914f' },
    maxCoverage: 0.35,
    features: [
      { type: 'dune',   band: [0.45, 1.00], chance: 0.30, r: 0.40, palette: ['#d2b06f', '#c19a55'] },
      { type: 'rock',   band: [0.80, 1.00], chance: 0.07, r: 0.24, palette: ['#9c8456', '#8a7448'] },
      { type: 'scrub',  band: [0.00, 0.25], chance: 0.10, r: 0.14, palette: ['#8a8a4a', '#76763e'] }
    ]
  },
  snow: {
    ground: { base: '#dfe7ea', light: '#eef3f5', dark: '#c8d4d8' },
    maxCoverage: 0.4,
    features: [
      { type: 'drift',  band: [0.45, 1.00], chance: 0.32, r: 0.40, palette: ['#eef4f6', '#ffffff'] },
      { type: 'rock',   band: [0.78, 1.00], chance: 0.08, r: 0.22, palette: ['#9aa6ac', '#879499'] },
      { type: 'water',  band: [0.00, 0.14], chance: 0.30, r: 0.34, palette: ['#9fc0cf', '#b3d0db'] }
    ]
  },
  swamp: {
    ground: { base: '#3b4a2e', light: '#475838', dark: '#2f3c25' },
    maxCoverage: 0.6,
    features: [
      { type: 'water',  band: [0.00, 0.40], chance: 0.45, r: 0.40, palette: ['#3a4a3a', '#445244', '#33433a'] },
      { type: 'reed',   band: [0.30, 0.70], chance: 0.26, r: 0.14, palette: ['#5a6b3a', '#4a5a30'] },
      { type: 'tree',   band: [0.65, 1.00], chance: 0.16, r: 0.38, palette: ['#2f4a2c', '#3a5734'] }
    ]
  }
};

/** Fallback biome when an unknown slug is requested. */
const FALLBACK_BIOME = 'grass';

/** Is `biome` a known generator biome? */
export function isBiome(biome) {
  return Object.prototype.hasOwnProperty.call(BIOME_FEATURES, biome);
}

/** All generator biome slugs (mirror SCENE_PRESETS). */
export function listBiomes() {
  return Object.keys(BIOME_FEATURES);
}

/**
 * Generate the map model for a scene.
 *
 * @param {object} args
 * @param {string} args.biome
 * @param {number} args.cols
 * @param {number} args.rows
 * @param {number} args.seed
 * @returns {{
 *   biome: string,
 *   cols: number,
 *   rows: number,
 *   seed: number,
 *   ground: { base:string, light:string, dark:string },
 *   field: (col:number,row:number)=>number,   // elevation/moisture 0..1
 *   features: Array<{type,col,row,x,y,r,variant,color}>
 * }}
 */
export function generateMapModel({ biome, cols, rows, seed } = {}) {
  const slug = isBiome(biome) ? biome : FALLBACK_BIOME;
  const spec = BIOME_FEATURES[slug];
  const sd = (seed >>> 0) || 1;
  const C = Math.max(1, cols | 0);
  const R = Math.max(1, rows | 0);

  // fBm elevation/moisture field. Low frequency so terrain bands span
  // several cells. A second seeded sampler decorrelates the texture
  // mottle from the placement field.
  const placeNoise = makeValueNoise2D(sd ^ 0x9e3779b9);
  const field = (col, row) =>
    fbm2D(placeNoise, col * 0.28, row * 0.28, { octaves: 3, frequency: 1, persistence: 0.55 });

  const features = [];
  let covered = 0;
  const budget = spec.maxCoverage * C * R;

  for (let row = 0; row < R; row++) {
    for (let col = 0; col < C; col++) {
      if (covered >= budget) break;
      const e = field(col, row);
      // Walk the biome's feature list; first eligible roll that passes
      // claims the cell (one feature per cell keeps it readable).
      for (let i = 0; i < spec.features.length; i++) {
        const f = spec.features[i];
        if (e < f.band[0] || e > f.band[1]) continue;
        // Per-(cell, feature) deterministic roll.
        const roll = hash2(sd + i * 101, col, row);
        if (roll > f.chance) continue;
        // Jitter the center toward a corner so tokens (drawn at cell
        // center) stay legible. Two more hashes give x/y offsets.
        const jx = hash2(sd + 7, col, row) - 0.5;
        const jy = hash2(sd + 13, col, row) - 0.5;
        const variant = Math.floor(hash2(sd + 3, col, row) * f.palette.length);
        features.push({
          type: f.type,
          col, row,
          x: col + 0.5 + jx * 0.5,   // cell-space center, ±0.25 jitter
          y: row + 0.5 + jy * 0.5,
          r: Math.min(0.42, f.r),
          variant,
          color: f.palette[variant] || f.palette[0]
        });
        covered += 1;
        break;
      }
    }
  }

  return {
    biome: slug,
    cols: C, rows: R, seed: sd,
    ground: spec.ground,
    field,
    features
  };
}
