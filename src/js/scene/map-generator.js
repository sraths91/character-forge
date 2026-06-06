/**
 * Structured procedural battle-map generator (M49).
 *
 * Pure, deterministic, headless. Produces a layered map model the
 * painterly renderer (map-render.js) draws top-down. The same inputs
 * always yield the same model, so a scene persists as just { biome,
 * seed } and regenerates identically.
 *
 * VISUAL ONLY — nothing here affects movement or combat.
 *
 * Unlike the original per-cell scatter, this is a multi-pass pipeline
 * that gives maps *structure*:
 *
 *   1. Fields    — continuous elevation + moisture fBm (domain-warped
 *                  for organic, non-grid edges).
 *   2. Regions   — each cell classified into a zone (water/shore/low/
 *                  mid/high) from elevation bands. Because the field is
 *                  smooth, same-zone cells cluster spatially → coherent
 *                  groves, clearings, ponds, rocky patches for free.
 *   3. Rivers    — (Phase 2) flowing water polylines.
 *   4. Paths     — (Phase 2) roads/trails.
 *   5. Structures— (Phase 3) multi-cell buildings/ruins/camps.
 *   6. Scatter   — region-aware detail features, density modulated by
 *                  moisture (dense groves vs open clearings), kept clear
 *                  of water centers / paths / structures.
 */

import { makeValueNoise2D, fbm2D, domainWarp } from './noise.js';

/**
 * Per-biome art direction. Each biome defines:
 *   levels  — elevation thresholds separating the five zones.
 *   moist   — base moisture bias (-/+) shifting the whole biome wet/dry.
 *   zones   — per-zone { fill:[light,dark], edge, features:[...] }.
 *             `fill` drives the painterly ground gradient; `edge` tints
 *             the soft boundary into the next-lower zone.
 *   feature `chance` is per eligible cell; `r` is radius in cells (≤0.46);
 *   `moist`: 'wet' scales chance up with moisture, 'dry' scales it down.
 *
 * The eight slugs mirror SCENE_PRESETS so the cinema backdrop + grid
 * colour stay in sync.
 */
export const BIOMES = {
  grass: {
    levels: { water: 0.20, shore: 0.27, low: 0.66, mid: 0.84 },
    moist: 0.05,
    zones: {
      water: { fill: ['#3f5e63', '#314a4f'], edge: '#56756b',
        features: [{ type: 'lily', chance: 0.20, r: 0.16, palette: ['#4a7d52'] }] },
      shore: { fill: ['#7a7148', '#665b38'], edge: '#8a8054',
        features: [{ type: 'reed', chance: 0.30, r: 0.14, palette: ['#7c8a4a', '#6a7740'], moist: 'wet' }] },
      low:   { fill: ['#4f6f48', '#3d5a3a'], edge: '#5c7d50',
        features: [{ type: 'tuft', chance: 0.34, r: 0.16, palette: ['#5d8150', '#4a6b3c', '#6e9359'], moist: 'wet' },
                   { type: 'bush', chance: 0.10, r: 0.26, palette: ['#3f6638', '#365a31'] }] },
      mid:   { fill: ['#6a5e3e', '#564a30'], edge: '#776a48',
        features: [{ type: 'dirt', chance: 0.26, r: 0.32, palette: ['#5c5038', '#6b5d44'], moist: 'dry' },
                   { type: 'rock', chance: 0.08, r: 0.22, palette: ['#7d7d72', '#8c8c80'] }] },
      high:  { fill: ['#8a8478', '#6e695f'], edge: '#9a9486',
        features: [{ type: 'rock', chance: 0.22, r: 0.30, palette: ['#7d7d72', '#8c8c80', '#6b6b62'] }] }
    }
  },
  forest: {
    levels: { water: 0.22, shore: 0.28, low: 0.70, mid: 0.86 },
    moist: 0.18,
    zones: {
      water: { fill: ['#2c4a52', '#22363c'], edge: '#3a5d5a',
        features: [{ type: 'lily', chance: 0.24, r: 0.16, palette: ['#356b3c'] }] },
      shore: { fill: ['#5a5436', '#48422a'], edge: '#6a6240',
        features: [{ type: 'reed', chance: 0.34, r: 0.14, palette: ['#5a6b3a', '#4a5a30'], moist: 'wet' }] },
      low:   { fill: ['#27482c', '#1c3a22'], edge: '#315237',
        features: [{ type: 'tree', chance: 0.40, r: 0.44, palette: ['#2f5d36', '#274d2d', '#386b40'], moist: 'wet' },
                   { type: 'tuft', chance: 0.26, r: 0.16, palette: ['#3a6b40', '#2d5733'] }] },
      mid:   { fill: ['#3a4a2c', '#2c3a22'], edge: '#46583a',
        features: [{ type: 'tree', chance: 0.22, r: 0.40, palette: ['#345a32', '#2b4a2a'] },
                   { type: 'bush', chance: 0.16, r: 0.26, palette: ['#3f6638', '#365a31'] }] },
      high:  { fill: ['#6e695a', '#565247'], edge: '#7c776a',
        features: [{ type: 'rock', chance: 0.24, r: 0.32, palette: ['#5a5750', '#666256'] }] }
    }
  },
  dungeon: {
    levels: { water: 0.16, shore: 0.22, low: 0.60, mid: 0.82 },
    moist: -0.1,
    zones: {
      water: { fill: ['#243038', '#1a242a'], edge: '#30414a',
        features: [] },
      shore: { fill: ['#32323a', '#28282e'], edge: '#3c3c44',
        features: [{ type: 'rubble', chance: 0.30, r: 0.12, palette: ['#3d3d42', '#4a4a50'] }] },
      low:   { fill: ['#2c2c32', '#242428'], edge: '#36363c',
        features: [{ type: 'rubble', chance: 0.26, r: 0.12, palette: ['#3d3d42', '#4a4a50'] },
                   { type: 'crack', chance: 0.14, r: 0.34, palette: ['#1f1f24'] }] },
      mid:   { fill: ['#34343a', '#2a2a30'], edge: '#404048',
        features: [{ type: 'rock', chance: 0.18, r: 0.32, palette: ['#3a3a40', '#45454c', '#303036'] }] },
      high:  { fill: ['#42424a', '#36363c'], edge: '#4e4e56',
        features: [{ type: 'rock', chance: 0.30, r: 0.36, palette: ['#3a3a40', '#45454c', '#303036'] }] }
    }
  },
  cave: {
    levels: { water: 0.20, shore: 0.26, low: 0.58, mid: 0.80 },
    moist: 0.1,
    zones: {
      water: { fill: ['#1f3540', '#152530'], edge: '#2a4450',
        features: [] },
      shore: { fill: ['#26242e', '#1e1c26'], edge: '#302e3a',
        features: [{ type: 'rubble', chance: 0.30, r: 0.12, palette: ['#2d2b36', '#38353f'] }] },
      low:   { fill: ['#1f1d28', '#181620'], edge: '#272532',
        features: [{ type: 'rubble', chance: 0.28, r: 0.12, palette: ['#2d2b36', '#38353f'] },
                   { type: 'crystal', chance: 0.06, r: 0.18, palette: ['#5a7fae', '#6f93c4'], moist: 'wet' }] },
      mid:   { fill: ['#262430', '#1d1b26'], edge: '#322f3e',
        features: [{ type: 'rock', chance: 0.24, r: 0.34, palette: ['#2a2833', '#33303d', '#211f29'] }] },
      high:  { fill: ['#322f3e', '#262430'], edge: '#403c4e',
        features: [{ type: 'rock', chance: 0.34, r: 0.38, palette: ['#2a2833', '#33303d', '#211f29'] }] }
    }
  },
  tavern: {
    levels: { water: 0.05, shore: 0.10, low: 0.62, mid: 0.84 },
    moist: -0.2,
    zones: {
      water: { fill: ['#3a2418', '#2c1b12'], edge: '#46301f', features: [] },
      shore: { fill: ['#5e3716', '#4c2d12'], edge: '#6e4520',
        features: [{ type: 'plank', chance: 0.22, r: 0.30, palette: ['#5e3716', '#7a4a20'] }] },
      low:   { fill: ['#6b3f1a', '#583414'], edge: '#7a4a22',
        features: [{ type: 'plank', chance: 0.24, r: 0.30, palette: ['#5e3716', '#7a4a20'] },
                   { type: 'rug', chance: 0.07, r: 0.42, palette: ['#7a2d2d', '#8c3a2a'] }] },
      mid:   { fill: ['#7a4a20', '#643c19'], edge: '#8a5828',
        features: [{ type: 'plank', chance: 0.20, r: 0.30, palette: ['#6e4420', '#86541f'] }] },
      high:  { fill: ['#86541f', '#6e4519'], edge: '#946027',
        features: [{ type: 'crate', chance: 0.14, r: 0.32, palette: ['#7a5224', '#6a471f'] }] }
    }
  },
  desert: {
    levels: { water: 0.08, shore: 0.14, low: 0.58, mid: 0.82 },
    moist: -0.3,
    zones: {
      water: { fill: ['#5fa0a8', '#4d8890'], edge: '#7ab8bf',   // rare oasis
        features: [{ type: 'lily', chance: 0.2, r: 0.16, palette: ['#4a7d52'] }] },
      shore: { fill: ['#b39a64', '#9c8454'], edge: '#c2aa72',
        features: [{ type: 'scrub', chance: 0.14, r: 0.14, palette: ['#8a8a4a', '#76763e'], moist: 'wet' }] },
      low:   { fill: ['#cda968', '#bb9656'], edge: '#d8b878',
        features: [{ type: 'scrub', chance: 0.08, r: 0.14, palette: ['#8a8a4a', '#76763e'], moist: 'wet' },
                   { type: 'dune', chance: 0.30, r: 0.44, palette: ['#d2b06f', '#c19a55'] }] },
      mid:   { fill: ['#d6b673', '#c4a25b'], edge: '#e0c485',
        features: [{ type: 'dune', chance: 0.34, r: 0.44, palette: ['#d8b878', '#c8a665'] }] },
      high:  { fill: ['#b39256', '#9c7e48'], edge: '#c2a062',
        features: [{ type: 'rock', chance: 0.16, r: 0.30, palette: ['#9c8456', '#8a7448'] }] }
    }
  },
  snow: {
    levels: { water: 0.14, shore: 0.20, low: 0.64, mid: 0.84 },
    moist: 0.05,
    zones: {
      water: { fill: ['#9fc0cf', '#86abbd'], edge: '#b8d4df',
        features: [] },
      shore: { fill: ['#c4d2d6', '#aebcc2'], edge: '#d4e0e3',
        features: [{ type: 'rock', chance: 0.10, r: 0.20, palette: ['#9aa6ac', '#879499'] }] },
      low:   { fill: ['#e6eef0', '#cfdbdf'], edge: '#f2f7f8',
        features: [{ type: 'drift', chance: 0.30, r: 0.44, palette: ['#eef4f6', '#ffffff'] },
                   { type: 'tree', chance: 0.10, r: 0.40, palette: ['#3a5540', '#2f4a36'], moist: 'wet' }] },
      mid:   { fill: ['#d8e2e5', '#bfcdd1'], edge: '#e6eef0',
        features: [{ type: 'drift', chance: 0.34, r: 0.44, palette: ['#eef4f6', '#ffffff'] }] },
      high:  { fill: ['#aab8be', '#94a3a9'], edge: '#bcc8cd',
        features: [{ type: 'rock', chance: 0.24, r: 0.32, palette: ['#9aa6ac', '#879499'] }] }
    }
  },
  swamp: {
    levels: { water: 0.34, shore: 0.42, low: 0.74, mid: 0.88 },
    moist: 0.35,
    zones: {
      water: { fill: ['#39483a', '#2c3a2e'], edge: '#475845',
        features: [{ type: 'lily', chance: 0.26, r: 0.16, palette: ['#4a6b3a', '#3f5e32'] }] },
      shore: { fill: ['#4a5436', '#3c452c'], edge: '#5a6440',
        features: [{ type: 'reed', chance: 0.36, r: 0.14, palette: ['#5a6b3a', '#4a5a30'], moist: 'wet' }] },
      low:   { fill: ['#3b4a2e', '#2f3c25'], edge: '#475838',
        features: [{ type: 'reed', chance: 0.22, r: 0.14, palette: ['#5a6b3a', '#4a5a30'] },
                   { type: 'tree', chance: 0.18, r: 0.40, palette: ['#2f4a2c', '#3a5734'], moist: 'wet' }] },
      mid:   { fill: ['#46512f', '#3a4327'], edge: '#525e38',
        features: [{ type: 'tree', chance: 0.16, r: 0.38, palette: ['#324c2e', '#3d5734'] },
                   { type: 'bush', chance: 0.14, r: 0.24, palette: ['#445229', '#4f5e30'] }] },
      high:  { fill: ['#5a6240', '#4a5234'], edge: '#666e4a',
        features: [{ type: 'rock', chance: 0.14, r: 0.28, palette: ['#6b6b56', '#5a5a48'] }] }
    }
  }
};

const FALLBACK_BIOME = 'grass';
const ZONE_ORDER = ['water', 'shore', 'low', 'mid', 'high'];

/**
 * Per-biome structural budget (M49 Phase 2): how many rivers + paths a
 * map of this biome gets, and the colours for the path ribbon (river
 * colour derives from the biome's water-zone fill). Indoor biomes
 * (tavern) get neither; dungeon gets a corridor-style path but no
 * river; desert is arid so rivers are rare.
 */
export const BIOME_STRUCTURE = {
  grass:   { rivers: 1, paths: 1, river: '#41707a', path: '#7d6b48',
             structures: { count: 2, types: ['cottage', 'house', 'ruin', 'campfire', 'well'] } },
  forest:  { rivers: 1, paths: 1, river: '#2f5560', path: '#6e5a3a',
             structures: { count: 1, types: ['cottage', 'ruin', 'campfire', 'tower'] } },
  dungeon: { rivers: 0, paths: 1, river: '#26323a', path: '#3a3a42',
             structures: { count: 2, types: ['pillars', 'ruin', 'altar'] } },
  cave:    { rivers: 1, paths: 0, river: '#214049', path: '#34303c',
             structures: { count: 1, types: ['pillars', 'ruin'] } },
  tavern:  { rivers: 0, paths: 0, river: '#3a2418', path: '#5e3716',
             structures: { count: 2, types: ['furniture'] } },
  desert:  { rivers: 0, paths: 1, river: '#5fa0a8', path: '#a98c54',
             structures: { count: 1, types: ['ruin', 'tent', 'courtyard'] } },
  snow:    { rivers: 1, paths: 1, river: '#86abbd', path: '#aebcc2',
             structures: { count: 1, types: ['cottage', 'ruin', 'tower'] } },
  swamp:   { rivers: 2, paths: 0, river: '#33463a', path: '#4a5436',
             structures: { count: 1, types: ['cottage', 'ruin', 'tent'] } }
};

/**
 * Footprint sizes per structure type (cells). Larger types (house,
 * courtyard) get a roomier lot; the placer caps any footprint to leave
 * combat room on the map.
 */
const STRUCT_SIZE = {
  cottage:   [3, 3], house: [4, 4], courtyard: [5, 5], tower: [3, 3],
  well: [2, 2], hut: [3, 3], ruin: [3, 3], campfire: [3, 3],
  tent: [2, 2], pillars: [3, 3], altar: [2, 2], furniture: [3, 3]
};

/** Is `biome` a known generator biome? */
export function isBiome(biome) {
  return Object.prototype.hasOwnProperty.call(BIOMES, biome);
}

/** All generator biome slugs (mirror SCENE_PRESETS). */
export function listBiomes() {
  return Object.keys(BIOMES);
}

/**
 * Generate the layered map model for a scene.
 *
 * @param {object} args
 * @param {string} args.biome
 * @param {number} args.cols
 * @param {number} args.rows
 * @param {number} args.seed
 * @returns {object} layered map model (see module header)
 */
export function generateMapModel({ biome, cols, rows, seed } = {}) {
  const slug = isBiome(biome) ? biome : FALLBACK_BIOME;
  const spec = BIOMES[slug];
  const sd = (seed >>> 0) || 1;
  const C = Math.max(1, cols | 0);
  const R = Math.max(1, rows | 0);

  // --- Pass 1: continuous fields ----------------------------------
  // Elevation drives zoning; moisture modulates feature density. Both
  // are domain-warped so zone edges meander organically.
  const elevNoise  = makeValueNoise2D(sd ^ 0x9e3779b9);
  const moistNoise = makeValueNoise2D(sd ^ 0x85ebca6b);
  const warpNoise  = makeValueNoise2D(sd ^ 0xc2b2ae35);

  const elevation = (col, row) => {
    const w = domainWarp(warpNoise, col, row, { strength: 1.4, frequency: 0.35 });
    return clamp01(fbm2D(elevNoise, w.x * 0.18, w.y * 0.18, { octaves: 4, persistence: 0.55 }));
  };
  const moisture = (col, row) => {
    const m = fbm2D(moistNoise, col * 0.16, row * 0.16, { octaves: 3, persistence: 0.6 });
    return clamp01(m + spec.moist);
  };

  const lv = spec.levels;
  const zoneAt = (col, row) => {
    const e = elevation(col, row);
    if (e < lv.water) return 'water';
    if (e < lv.shore) return 'shore';
    if (e < lv.low)   return 'low';
    if (e < lv.mid)   return 'mid';
    return 'high';
  };

  // --- Pass 3: rivers (gradient descent downhill) -----------------
  const struct = BIOME_STRUCTURE[slug] || BIOME_STRUCTURE.grass;
  const rivers = [];
  for (let i = 0; i < struct.rivers; i++) {
    const poly = traceRiver(elevation, C, R, sd, i);
    if (poly.length >= 2) rivers.push({ points: poly, width: 0.42 + 0.12 * i });
  }

  // --- Pass 4: paths (edge-to-edge meander) -----------------------
  const paths = [];
  for (let i = 0; i < struct.paths; i++) {
    const poly = tracePath(C, R, sd, i);
    if (poly.length >= 2) paths.push({ points: poly, width: 0.30 });
  }

  // --- Pass 4b: bridges where a path crosses a river --------------
  const bridges = [];
  for (const path of paths) {
    for (const river of rivers) {
      const hit = polylineCrossing(path.points, river.points);
      if (hit) bridges.push(hit);
    }
  }

  // --- Pass 5: multi-cell structures ------------------------------
  const structures = placeStructures(elevation, C, R, sd, struct, rivers, paths, lv);

  // --- Pass 6: region-aware detail scatter ------------------------
  // Scatter, then drop anything sitting on a river/path so water and
  // roads stay clear (no trees growing mid-stream).
  const features = [];
  for (let row = 0; row < R; row++) {
    for (let col = 0; col < C; col++) {
      const zone = zoneAt(col, row);
      const zspec = spec.zones[zone];
      if (!zspec || !zspec.features.length) continue;
      const m = moisture(col, row);
      for (let i = 0; i < zspec.features.length; i++) {
        const f = zspec.features[i];
        let chance = f.chance;
        if (f.moist === 'wet') chance *= 0.45 + 0.85 * m;
        else if (f.moist === 'dry') chance *= 0.45 + 0.85 * (1 - m);
        const roll = hashCell(sd + i * 101 + zoneIndex(zone) * 17, col, row);
        if (roll > chance) continue;
        const jx = hashCell(sd + 7, col, row) - 0.5;
        const jy = hashCell(sd + 13, col, row) - 0.5;
        const fx = col + 0.5 + jx * 0.5;
        const fy = row + 0.5 + jy * 0.5;
        // Keep clear of rivers (1 cell) + paths (0.7 cell) + structures.
        if (nearPolylines(rivers, fx, fy, 1.0) || nearPolylines(paths, fx, fy, 0.7)) break;
        if (insideStructure(structures, col, row)) break;
        const variant = Math.floor(hashCell(sd + 3, col, row) * f.palette.length);
        features.push({
          type: f.type, zone,
          col, row, x: fx, y: fy,
          r: Math.min(0.46, f.r),
          variant,
          color: f.palette[variant] || f.palette[0]
        });
        break;   // one feature per cell — readability
      }
    }
  }

  return {
    biome: slug,
    cols: C, rows: R, seed: sd,
    levels: lv,
    zones: spec.zones,
    structure: struct,
    elevation, moisture, zoneAt,
    zoneFill: (zone) => spec.zones[zone]?.fill || spec.zones.low.fill,
    zoneEdge: (zone) => spec.zones[zone]?.edge || spec.zones.low.edge,
    rivers,
    paths,
    bridges,
    structures,
    features
  };
}

/* =====================================================================
 * River + path tracing (Phase 2)
 * ===================================================================== */

/**
 * Trace one river by gradient descent on the elevation field: start at
 * the highest of several sampled candidate points, then step downhill
 * (negative gradient) with meander + momentum until reaching an edge or
 * running out of steps. Returns a polyline in cell space.
 */
function traceRiver(elevation, C, R, sd, idx) {
  // Source: sample candidate points, pick the highest (rivers spring
  // from high ground).
  let best = null, bestE = -1;
  for (let k = 0; k < 28; k++) {
    const x = 0.5 + hashCell(sd + idx * 97 + k, k, 3) * (C - 1);
    const y = 0.5 + hashCell(sd + idx * 131 + k, 5, k) * (R - 1);
    const e = elevation(x, y);
    if (e > bestE) { bestE = e; best = { x, y }; }
  }
  const pts = [best];
  let heading = null;
  const maxSteps = C + R + 24;
  const h = 0.6, stepLen = 0.7;
  for (let s = 0; s < maxSteps; s++) {
    const p = pts[pts.length - 1];
    // Steepest-descent direction (central difference).
    const gx = elevation(p.x + h, p.y) - elevation(p.x - h, p.y);
    const gy = elevation(p.x, p.y + h) - elevation(p.x, p.y - h);
    let dx = -gx, dy = -gy;
    let mag = Math.hypot(dx, dy);
    if (mag < 1e-4) { dx = (hashCell(sd, s, idx) - 0.5); dy = (hashCell(sd, idx, s) - 0.5); mag = Math.hypot(dx, dy) || 1; }
    dx /= mag; dy /= mag;
    // Meander: perpendicular wobble from noise.
    const wob = (hashCell(sd + idx * 7, Math.floor(p.x * 2.5), Math.floor(p.y * 2.5)) - 0.5) * 0.9;
    dx += -dy * wob; dy += dx * wob;
    // Momentum so the channel curves rather than zig-zags.
    if (heading) { dx = dx * 0.55 + heading.x * 0.45; dy = dy * 0.55 + heading.y * 0.45; }
    const mm = Math.hypot(dx, dy) || 1; dx /= mm; dy /= mm;
    heading = { x: dx, y: dy };
    const np = { x: p.x + dx * stepLen, y: p.y + dy * stepLen };
    if (np.x <= 0 || np.x >= C || np.y <= 0 || np.y >= R) {
      pts.push({ x: clamp(np.x, 0, C), y: clamp(np.y, 0, R) });
      break;
    }
    pts.push(np);
  }
  return pts;
}

/**
 * Trace one path edge-to-edge as a smooth meander. Picks opposite edges
 * (left↔right or top↔bottom by parity) and jittered waypoints between,
 * then samples the Catmull-Rom-ish curve into a dense polyline.
 */
function tracePath(C, R, sd, idx) {
  const horizontal = hashCell(sd + idx * 53, 1, idx) < 0.6;   // mostly L→R roads
  const ctrl = [];
  const N = 4;   // waypoints incl. endpoints
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    if (horizontal) {
      const x = t * C;
      const y = R * (0.25 + 0.5 * hashCell(sd + idx * 61, i, 7));
      ctrl.push({ x, y });
    } else {
      const y = t * R;
      const x = C * (0.25 + 0.5 * hashCell(sd + idx * 61, 9, i));
      ctrl.push({ x, y });
    }
  }
  // Sample a smooth curve through the control points.
  const pts = [];
  const steps = Math.max(8, (horizontal ? C : R) * 2);
  for (let s = 0; s <= steps; s++) {
    const u = (s / steps) * (ctrl.length - 1);
    const i = Math.min(ctrl.length - 2, Math.floor(u));
    const f = u - i;
    pts.push({ x: smoothPt(ctrl, i, f, 'x'), y: smoothPt(ctrl, i, f, 'y') });
  }
  return pts;
}

/** Catmull-Rom interpolation of one axis between control points i,i+1. */
function smoothPt(ctrl, i, f, axis) {
  const p0 = ctrl[Math.max(0, i - 1)][axis];
  const p1 = ctrl[i][axis];
  const p2 = ctrl[i + 1][axis];
  const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)][axis];
  const f2 = f * f, f3 = f2 * f;
  return 0.5 * ((2 * p1) + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
}

/** First crossing point between two polylines, or null. */
function polylineCrossing(a, b) {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const p = segIntersect(a[i], a[i + 1], b[j], b[j + 1]);
      if (p) {
        const ang = Math.atan2(a[i + 1].y - a[i].y, a[i + 1].x - a[i].x);
        return { x: p.x, y: p.y, angle: ang };
      }
    }
  }
  return null;
}

function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/* =====================================================================
 * Structure placement (Phase 3)
 * ===================================================================== */

/**
 * Place up to `count` multi-cell structures on dry land, clear of water
 * and rivers, not overlapping each other, biased toward roadside spots.
 * Each is { type, col, row, w, h, variant } where (col,row) is the
 * top-left cell of a w×h footprint. Deterministic from the seed.
 */
function placeStructures(elevation, C, R, sd, struct, rivers, paths, lv) {
  const cfg = struct.structures;
  const out = [];
  if (!cfg || !cfg.count || C < 5 || R < 5) return out;
  const types = cfg.types || ['ruin'];
  // Cap any footprint to ~⅓ of the map so combat space remains.
  const maxW = Math.max(2, Math.floor(C / 3));
  const maxH = Math.max(2, Math.floor(R / 3));
  for (let i = 0; i < cfg.count; i++) {
    const type = types[Math.floor(hashCell(sd + i * 211, 1, i) * types.length)] || 'ruin';
    const size = STRUCT_SIZE[type] || [3, 3];
    const w = Math.min(maxW, size[0]);
    const h = Math.min(maxH, size[1]);
    if (C - w - 2 < 1 || R - h - 2 < 1) continue;
    let best = null, bestScore = -1;
    for (let k = 0; k < 48; k++) {
      const col = 1 + Math.floor(hashCell(sd + i * 97 + k, k, 4) * (C - w - 2));
      const row = 1 + Math.floor(hashCell(sd + i * 131 + k, 5, k) * (R - h - 2));
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const cx = col + dx + 0.5, cy = row + dy + 0.5;
          if (elevation(cx, cy) < lv.shore) { ok = false; break; }     // off water/shore
          if (nearPolylines(rivers, cx, cy, 0.6)) { ok = false; break; }
        }
      }
      if (!ok || overlapsRect(out, col, row, w, h)) continue;
      // Prefer roadside lots (a building by the path reads as a scene).
      const cc = col + w / 2, cr = row + h / 2;
      const score = 1 + (nearPolylines(paths, cc, cr, 1.6) ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = { col, row }; }
    }
    if (!best) continue;
    // Door faces the nearest path if one is close, else faces down
    // (toward the viewer) — a believable approach side.
    const cc = best.col + w / 2, cr = best.row + h / 2;
    const doorSide = nearPolylines(paths, cc, cr, 2.2) ? pathSide(paths, cc, cr) : 'S';
    const s = {
      type, col: best.col, row: best.row, w, h,
      variant: Math.floor(hashCell(sd + i * 3, 7, i) * 3),
      angle: isCutaway(type) ? 0 : (hashCell(sd + i * 17, 8, i) - 0.5) * 0.16,
      doorSide
    };
    // Interior layout for cutaway buildings (rooms + door + furniture).
    if (isCutaway(type)) s.layout = computeBuildingLayout(type, w, h, sd + i * 53, doorSide);
    out.push(s);
  }
  return out;
}

/** Cutaway = roofless interior shown (cottage/house/courtyard/tower). */
function isCutaway(type) {
  return type === 'cottage' || type === 'house' || type === 'courtyard' || type === 'tower';
}

/** Which side of (cc,cr) the nearest path lies on → door faces it. */
function pathSide(paths, cc, cr) {
  let bestD = Infinity, bestPt = null;
  for (const ln of paths) {
    for (const p of ln.points) {
      const d = (p.x - cc) * (p.x - cc) + (p.y - cr) * (p.y - cr);
      if (d < bestD) { bestD = d; bestPt = p; }
    }
  }
  if (!bestPt) return 'S';
  const dx = bestPt.x - cc, dy = bestPt.y - cr;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'E' : 'W';
  return dy > 0 ? 'S' : 'N';
}

/**
 * Deterministic interior layout in cell-local coordinates (0..w, 0..h).
 * Returns { rooms:[{x,y,w,h}], door:{side,x,y}, furniture:[{type,x,y}] }.
 * Rooms come from one binary split (1–2 rooms); furniture is chosen per
 * room from a small palette. Pure — same inputs, same layout.
 */
function computeBuildingLayout(type, w, h, sd, doorSide) {
  if (type === 'courtyard') {
    // Open yard: no interior rooms; a well or garden at the centre.
    return {
      rooms: [{ x: 0.5, y: 0.5, w: w - 1, h: h - 1 }],
      door: doorPoint(doorSide, w, h),
      furniture: [{ type: 'well', x: w / 2, y: h / 2 }],
      open: true
    };
  }
  if (type === 'tower') {
    return {
      rooms: [{ x: 0.4, y: 0.4, w: w - 0.8, h: h - 0.8 }],
      door: doorPoint(doorSide, w, h),
      furniture: [{ type: 'stair', x: w / 2, y: h / 2 }],
      round: true
    };
  }
  // cottage / house — split into rooms.
  const rooms = [];
  const splitV = hashCell(sd, 1, 1) < 0.5;
  const nRooms = type === 'house' ? 2 : (hashCell(sd, 2, 2) < 0.5 ? 2 : 1);
  if (nRooms === 1) {
    rooms.push({ x: 0.45, y: 0.45, w: w - 0.9, h: h - 0.9 });
  } else if (splitV) {
    const cut = w * (0.4 + 0.2 * hashCell(sd, 3, 3));
    rooms.push({ x: 0.45, y: 0.45, w: cut - 0.45, h: h - 0.9 });
    rooms.push({ x: cut + 0.05, y: 0.45, w: w - cut - 0.5, h: h - 0.9 });
  } else {
    const cut = h * (0.4 + 0.2 * hashCell(sd, 3, 3));
    rooms.push({ x: 0.45, y: 0.45, w: w - 0.9, h: cut - 0.45 });
    rooms.push({ x: 0.45, y: cut + 0.05, w: w - 0.9, h: h - cut - 0.5 });
  }
  // Furniture: room 0 gets a hearth + table; room 1 (if any) a bed.
  const furniture = [];
  const palette = [['hearth', 'table'], ['bed', 'barrel']];
  rooms.forEach((rm, ri) => {
    const set = palette[Math.min(ri, palette.length - 1)];
    set.forEach((ft, fi) => {
      const fx = rm.x + rm.w * (0.3 + 0.4 * hashCell(sd + ri * 7 + fi * 3, fi, ri));
      const fy = rm.y + rm.h * (0.3 + 0.4 * hashCell(sd + ri * 11 + fi * 5, ri, fi));
      furniture.push({ type: ft, x: fx, y: fy });
    });
  });
  return { rooms, door: doorPoint(doorSide, w, h), furniture };
}

function doorPoint(side, w, h) {
  switch (side) {
    case 'N': return { side, x: w / 2, y: 0.3 };
    case 'E': return { side, x: w - 0.3, y: h / 2 };
    case 'W': return { side, x: 0.3, y: h / 2 };
    default:  return { side: 'S', x: w / 2, y: h - 0.3 };
  }
}

function overlapsRect(rects, col, row, w, h) {
  for (const s of rects) {
    if (col < s.col + s.w + 1 && col + w + 1 > s.col &&
        row < s.row + s.h + 1 && row + h + 1 > s.row) return true;
  }
  return false;
}

/** Is cell (col,row) inside any structure footprint? */
function insideStructure(structures, col, row) {
  for (const s of structures) {
    if (col >= s.col && col < s.col + s.w && row >= s.row && row < s.row + s.h) return true;
  }
  return false;
}

/** Is (x,y) within `dist` cells of any point on any polyline? */
function nearPolylines(lines, x, y, dist) {
  const d2 = dist * dist;
  for (const ln of lines) {
    const pts = ln.points;
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSeg2(x, y, pts[i], pts[i + 1]) <= d2) return true;
    }
  }
  return false;
}

function distToSeg2(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* ----- helpers ----- */

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function zoneIndex(zone) { return ZONE_ORDER.indexOf(zone); }

/** Deterministic per-(seed,cell) roll in [0,1). Inlined mulberry mix so
 *  this module doesn't depend on noise's internal hash export. */
function hashCell(seed, x, y) {
  let s = (seed >>> 0);
  s = (s + Math.imul(x | 0, 0x27d4eb2d)) >>> 0;
  s = (s + Math.imul(y | 0, 0x165667b1)) >>> 0;
  s = (s + 0x6D2B79F5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
