/**
 * M44.2 — Terrain-keyed cinema backgrounds.
 *
 * The cinema renderer (M43.2) accepts a `drawBackground(ctx, {W, H, t})`
 * callback. The default is a neutral dark vignette. This module ships
 * eight cinematic backgrounds keyed to the eight built-in scene presets
 * (grass, dungeon, tavern, forest, desert, snow, swamp, cave) so the
 * cinema reflects the encounter's setting.
 *
 * Each painter is pure-canvas — no images, no async loads. They render
 * a layered horizon (sky tint → distant silhouette → ground gradient →
 * floor line) so the actors stand on something readable rather than a
 * flat color.
 *
 * Detection:
 *   1. scene.map.preset (explicit slug) takes precedence
 *   2. fall back to a reverse color map (matches SCENE_PRESETS colours)
 *   3. ultimate fallback is 'grass'
 */

import { SCENE_PRESETS } from '../scene/scene-state.js';

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
 * Background painters — pure (ctx, {W, H, t}) → void
 * Each paints sky → distant silhouette → ground → floor.
 * ===================================================================== */

function paintLinear(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [pos, color] of stops) g.addColorStop(pos, color);
  return g;
}

function floorLine(ctx, W, H, color = 'rgba(255,255,255,0.10)') {
  const y = H * 0.62 + 20;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
}

/** Grass field — green ground, blue-grey overcast sky. */
export const BG_GRASS = (ctx, { W, H }) => {
  ctx.fillStyle = paintLinear(ctx, 0, 0, 0, H, [
    [0,    '#5e7b8a'],
    [0.55, '#7a8b78'],
    [0.56, '#3d5a3d'],
    [1,    '#22381f']
  ]);
  ctx.fillRect(0, 0, W, H);
  // A few darker grass tufts at floor line
  ctx.fillStyle = 'rgba(20,40,20,0.45)';
  for (let i = 0; i < 12; i++) {
    const x = (i * (W / 12)) + ((i * 37) % 40);
    ctx.fillRect(x, H * 0.62 + 18, 6, 4);
  }
  floorLine(ctx, W, H);
};

/** Dungeon — grey stone with torchlit warm haze. */
export const BG_DUNGEON = (ctx, { W, H }) => {
  ctx.fillStyle = paintLinear(ctx, 0, 0, 0, H, [
    [0,    '#1a1418'],
    [0.45, '#2a2226'],
    [0.55, '#332a26'],
    [1,    '#1a1612']
  ]);
  ctx.fillRect(0, 0, W, H);
  // Brick suggestion — staggered horizontal bands above the floor
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let r = 0; r < 5; r++) {
    const y = H * 0.18 + r * (H * 0.08);
    const shift = (r % 2) * 24;
    for (let x = -shift; x < W; x += 64) {
      ctx.strokeRect(x, y, 60, H * 0.07);
    }
  }
  // Warm torch haze radial near top
  const torch = ctx.createRadialGradient(W * 0.5, H * 0.15, 0, W * 0.5, H * 0.15, W * 0.55);
  torch.addColorStop(0, 'rgba(248,166,76,0.22)');
  torch.addColorStop(1, 'rgba(248,166,76,0)');
  ctx.fillStyle = torch;
  ctx.fillRect(0, 0, W, H);
  floorLine(ctx, W, H, 'rgba(255,255,255,0.06)');
};

/** Tavern — warm wood tones, fireplace glow. */
export const BG_TAVERN = (ctx, { W, H }) => {
  ctx.fillStyle = paintLinear(ctx, 0, 0, 0, H, [
    [0,    '#2a1f12'],
    [0.5,  '#3a2a18'],
    [0.6,  '#5a3d20'],
    [1,    '#2d1c10']
  ]);
  ctx.fillRect(0, 0, W, H);
  // Wood plank lines on the floor
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const y = H * 0.62 + i * 14;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  // Fireplace glow from the right
  const fire = ctx.createRadialGradient(W * 0.82, H * 0.4, 0, W * 0.82, H * 0.4, W * 0.45);
  fire.addColorStop(0, 'rgba(255,140,40,0.30)');
  fire.addColorStop(1, 'rgba(255,140,40,0)');
  ctx.fillStyle = fire;
  ctx.fillRect(0, 0, W, H);
  floorLine(ctx, W, H, 'rgba(255,200,140,0.10)');
};

/** Forest — dense trees, dappled green light. */
export const BG_FOREST = (ctx, { W, H }) => {
  ctx.fillStyle = paintLinear(ctx, 0, 0, 0, H, [
    [0,    '#1c2a1e'],
    [0.55, '#2a4030'],
    [0.56, '#1e3a23'],
    [1,    '#10240f']
  ]);
  ctx.fillRect(0, 0, W, H);
  // Tree trunks in the mid-ground (silhouettes)
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (let i = 0; i < 7; i++) {
    const x = (i * (W / 7)) + (i % 2 === 0 ? 30 : 60);
    const trunkW = 14 + (i * 13) % 10;
    const top = H * 0.18 + ((i * 31) % 30);
    ctx.fillRect(x, top, trunkW, H * 0.45);
  }
  // Canopy gradient overlay
  const canopy = ctx.createLinearGradient(0, 0, 0, H * 0.4);
  canopy.addColorStop(0, 'rgba(80,140,60,0.25)');
  canopy.addColorStop(1, 'rgba(80,140,60,0)');
  ctx.fillStyle = canopy;
  ctx.fillRect(0, 0, W, H * 0.4);
  floorLine(ctx, W, H, 'rgba(180,220,140,0.12)');
};

/** Desert — sand dunes, hot amber sky. */
export const BG_DESERT = (ctx, { W, H }) => {
  ctx.fillStyle = paintLinear(ctx, 0, 0, 0, H, [
    [0,    '#f4c277'],
    [0.5,  '#e6a45c'],
    [0.55, '#c8a665'],
    [1,    '#8a6e3e']
  ]);
  ctx.fillRect(0, 0, W, H);
  // Distant dune silhouette
  ctx.fillStyle = 'rgba(120,80,40,0.5)';
  ctx.beginPath();
  ctx.moveTo(0, H * 0.55);
  ctx.bezierCurveTo(W * 0.25, H * 0.5, W * 0.6, H * 0.58, W, H * 0.5);
  ctx.lineTo(W, H * 0.62);
  ctx.lineTo(0, H * 0.62);
  ctx.closePath();
  ctx.fill();
  floorLine(ctx, W, H, 'rgba(255,255,255,0.18)');
};

/** Snowfield — pale gradient + distant mountain silhouettes. */
export const BG_SNOW = (ctx, { W, H }) => {
  ctx.fillStyle = paintLinear(ctx, 0, 0, 0, H, [
    [0,    '#a8c4d4'],
    [0.5,  '#cad9e0'],
    [0.55, '#e6edef'],
    [1,    '#aab8be']
  ]);
  ctx.fillRect(0, 0, W, H);
  // Mountain silhouettes
  ctx.fillStyle = 'rgba(70,100,120,0.45)';
  ctx.beginPath();
  ctx.moveTo(0, H * 0.55);
  ctx.lineTo(W * 0.18, H * 0.32);
  ctx.lineTo(W * 0.32, H * 0.5);
  ctx.lineTo(W * 0.5,  H * 0.28);
  ctx.lineTo(W * 0.7,  H * 0.48);
  ctx.lineTo(W * 0.88, H * 0.30);
  ctx.lineTo(W,        H * 0.5);
  ctx.lineTo(W,        H * 0.62);
  ctx.lineTo(0,        H * 0.62);
  ctx.closePath();
  ctx.fill();
  // Light snow fall — animated specks
  floorLine(ctx, W, H, 'rgba(0,0,0,0.10)');
};

/** Swamp — murky green water + low fog. */
export const BG_SWAMP = (ctx, { W, H }) => {
  ctx.fillStyle = paintLinear(ctx, 0, 0, 0, H, [
    [0,    '#2a3a2a'],
    [0.5,  '#3a4a32'],
    [0.55, '#3b4a2e'],
    [1,    '#1e2818']
  ]);
  ctx.fillRect(0, 0, W, H);
  // Bent trees / reeds
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    const x = (i * (W / 9)) + 20;
    ctx.beginPath();
    ctx.moveTo(x, H * 0.62);
    ctx.quadraticCurveTo(x + 8, H * 0.4, x + 4, H * 0.2);
    ctx.stroke();
  }
  // Low fog band
  const fog = ctx.createLinearGradient(0, H * 0.55, 0, H * 0.75);
  fog.addColorStop(0, 'rgba(200,210,180,0)');
  fog.addColorStop(0.5, 'rgba(200,210,180,0.22)');
  fog.addColorStop(1, 'rgba(200,210,180,0)');
  ctx.fillStyle = fog;
  ctx.fillRect(0, H * 0.55, W, H * 0.2);
  floorLine(ctx, W, H, 'rgba(180,200,140,0.12)');
};

/** Cave — deep blue stone + stalagmite silhouettes. */
export const BG_CAVE = (ctx, { W, H }) => {
  ctx.fillStyle = paintLinear(ctx, 0, 0, 0, H, [
    [0,    '#0a0a14'],
    [0.5,  '#181830'],
    [0.55, '#1a1820'],
    [1,    '#080810']
  ]);
  ctx.fillRect(0, 0, W, H);
  // Stalactites from ceiling
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  for (let i = 0; i < 8; i++) {
    const x = (i * (W / 8)) + ((i * 23) % 30);
    const w = 18 + ((i * 11) % 12);
    const h = 28 + ((i * 19) % 30);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + w, 0);
    ctx.lineTo(x + w / 2, h);
    ctx.closePath();
    ctx.fill();
  }
  // Stalagmites from floor
  for (let i = 0; i < 6; i++) {
    const x = (i * (W / 6)) + 30;
    const w = 22 + ((i * 13) % 14);
    const h = 22 + ((i * 17) % 18);
    const y = H * 0.62 + 20;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w / 2, y - h);
    ctx.closePath();
    ctx.fill();
  }
  // Cool blue glow
  const glow = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, W * 0.6);
  glow.addColorStop(0, 'rgba(80,120,200,0.10)');
  glow.addColorStop(1, 'rgba(80,120,200,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  floorLine(ctx, W, H, 'rgba(180,200,255,0.10)');
};

export const BACKGROUNDS = {
  grass:   BG_GRASS,
  dungeon: BG_DUNGEON,
  tavern:  BG_TAVERN,
  forest:  BG_FOREST,
  desert:  BG_DESERT,
  snow:    BG_SNOW,
  swamp:   BG_SWAMP,
  cave:    BG_CAVE
};
