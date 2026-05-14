/**
 * M2 — Battle scene state model.
 *
 * A "scene" bundles the battlefield (background + grid) with per-entity
 * positions. Persisted as a single localStorage object so the user can
 * return to the same scene after a reload.
 *
 * Scene shape:
 * {
 *   cols: 10, rows: 7,                      // grid dimensions in cells
 *   cellSize: 64,                           // logical px per cell (pre-scale)
 *   scale: 3,                               // pixels per logical px in render
 *   map: {
 *     kind: 'color',                        // 'color' (M2). 'image' / 'tiles' = M3+
 *     color: '#3d5a3d'                     // tarmac green default
 *   },
 *   grid: {
 *     visible: true,
 *     snap:    true,
 *     color:   'rgba(255,255,255,0.18)'
 *   },
 *   positions: { [characterId]: { col, row } }
 * }
 *
 * `positions` is keyed by D&DB character id. Members without a saved
 * position fall back to a default linear row at render time.
 */

const SCENE_KEY = 'cf_scene';

export const DEFAULT_SCENE = Object.freeze({
  cols: 10,
  rows: 7,
  cellSize: 64,
  scale: 3,
  map: { kind: 'color', color: '#3d5a3d' },
  grid: { visible: true, snap: true, color: 'rgba(255,255,255,0.18)' },
  positions: {}
});

export function loadScene() {
  try {
    const raw = localStorage.getItem(SCENE_KEY);
    if (!raw) return cloneDefault();
    const parsed = JSON.parse(raw);
    // Defensive merge — old saves missing newer fields fall back to defaults
    return mergeWithDefault(parsed);
  } catch {
    return cloneDefault();
  }
}

export function saveScene(scene) {
  try {
    localStorage.setItem(SCENE_KEY, JSON.stringify(scene));
  } catch { /* quota or private-mode — ignore */ }
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_SCENE));
}

function mergeWithDefault(saved) {
  const base = cloneDefault();
  return {
    ...base,
    ...saved,
    map:  { ...base.map,  ...(saved.map  || {}) },
    grid: { ...base.grid, ...(saved.grid || {}) },
    positions: saved.positions && typeof saved.positions === 'object' ? saved.positions : {}
  };
}

/**
 * Default placement for members without a saved (col, row). Drops them
 * in a horizontal row centred vertically, starting at col 1 to leave the
 * left edge for the DM's view.
 *
 *   member index 0 → (1, midRow)
 *   member index 1 → (2, midRow)
 *   ...
 *
 * Wraps to a second row if the party exceeds available width.
 */
export function defaultPosition(scene, indexInParty) {
  const midRow = Math.floor(scene.rows / 2);
  const cap = Math.max(1, scene.cols - 2);
  const col = 1 + (indexInParty % cap);
  const row = midRow + Math.floor(indexInParty / cap);
  return { col, row };
}

/** Get a character's resolved position (saved or defaulted). */
export function positionOf(scene, characterId, indexInParty) {
  const saved = scene.positions?.[String(characterId)];
  if (saved && Number.isFinite(saved.col) && Number.isFinite(saved.row)) {
    return clampPosition(scene, saved);
  }
  return clampPosition(scene, defaultPosition(scene, indexInParty));
}

export function clampPosition(scene, { col, row }) {
  return {
    col: Math.max(0, Math.min(scene.cols - 1, col)),
    row: Math.max(0, Math.min(scene.rows - 1, row))
  };
}

/**
 * Convert mouse/touch event coords (already adjusted for canvas client
 * rect) into (col, row). Optionally snaps to the nearest cell, else
 * returns a fractional position for fluid drag.
 */
export function pointToCell(scene, px, py, { snap = true } = {}) {
  const cellPx = scene.cellSize * scene.scale;
  const col = px / cellPx;
  const row = py / cellPx;
  if (snap) return clampPosition(scene, { col: Math.floor(col), row: Math.floor(row) });
  return clampPosition(scene, { col: Math.floor(col), row: Math.floor(row) });
}

/**
 * Find which character (by D&DB id) is under the given canvas-relative
 * pixel coordinate. Returns null if no character occupies that cell.
 */
export function characterAt(scene, characters, px, py) {
  const cellPx = scene.cellSize * scene.scale;
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    const pos = positionOf(scene, ch.id, i);
    const x = pos.col * cellPx;
    const y = pos.row * cellPx;
    if (px >= x && px < x + cellPx && py >= y && py < y + cellPx) return ch;
  }
  return null;
}

export function setPosition(scene, characterId, col, row) {
  scene.positions = { ...(scene.positions || {}), [String(characterId)]: { col, row } };
}

export function clearPositions(scene) {
  scene.positions = {};
}
