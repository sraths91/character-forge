/**
 * M64 E5 / M2 — per-cell terrain layer.
 *
 * One byte per cell, row-major (`index = row * cols + col`). Bits:
 *   1  blocked (impassable: wall, pit, deep water)
 *   2  difficult terrain (10 ft per cell)
 *   4  half cover (an obstacle in this cell grants half cover)
 *   8  three-quarters cover
 *   16 total cover; also blocks line of sight
 *
 * Two forms:
 *   - wire form `{v, cols, rows, flags}` where `flags` is base64 of the
 *     byte array. This is `EncounterState.grid.terrain` (see
 *     `shared/encounter-state.js`), validated by the shared contract.
 *   - working form `{v, cols, rows, cells: Uint8Array}` used by the
 *     legality and render code.
 * `asTerrain` accepts either and returns the working form.
 *
 * Every mutator returns a NEW working-form terrain; inputs are never
 * modified, so a frozen state or view can be passed in safely.
 * Pure, Node-safe, no DOM.
 */

import { bytesToBase64, base64ToBytes } from './base64.js';

/** Wire-format version (`terrain.v`). */
export const TERRAIN_VERSION = 1;

/** Flag bits. */
export const TERRAIN_FLAGS = Object.freeze({
  BLOCKED: 1,
  DIFFICULT: 2,
  HALF_COVER: 4,
  THREE_QUARTERS_COVER: 8,
  TOTAL_COVER: 16
});

/** Every defined bit. */
export const TERRAIN_FLAG_MASK = 31;

/**
 * @typedef {object} Terrain
 * @property {number} v
 * @property {number} cols
 * @property {number} rows
 * @property {Uint8Array} cells — length cols * rows
 */

/**
 * @typedef {object} TerrainWire
 * @property {number} v
 * @property {number} cols
 * @property {number} rows
 * @property {string} flags — base64 of the cell bytes
 */

function dim(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * An all-open terrain.
 * @param {number} cols
 * @param {number} rows
 * @returns {Terrain}
 */
export function createTerrain(cols, rows) {
  const c = dim(cols);
  const r = dim(rows);
  return { v: TERRAIN_VERSION, cols: c, rows: r, cells: new Uint8Array(c * r) };
}

/**
 * Working form → wire form.
 * @param {Terrain|TerrainWire} terrain
 * @returns {TerrainWire}
 */
export function encodeTerrain(terrain) {
  const t = asTerrain(terrain);
  if (!t) return null;
  return { v: TERRAIN_VERSION, cols: t.cols, rows: t.rows, flags: bytesToBase64(t.cells) };
}

/**
 * Wire form → working form. A flags string of the wrong length is padded
 * with open cells or truncated; undefined bits are masked off.
 * @param {TerrainWire} wire
 * @returns {Terrain|null}
 */
export function decodeTerrain(wire) {
  if (!wire || typeof wire !== 'object') return null;
  const t = createTerrain(wire.cols, wire.rows);
  const bytes = base64ToBytes(typeof wire.flags === 'string' ? wire.flags : '');
  const n = Math.min(bytes.length, t.cells.length);
  for (let i = 0; i < n; i++) t.cells[i] = bytes[i] & TERRAIN_FLAG_MASK;
  return t;
}

const decodedMemo = new WeakMap();

/**
 * Normalise either form to the working form. Wire-form objects are
 * decoded once and memoised by identity (frozen objects included).
 * @param {Terrain|TerrainWire|null|undefined} terrain
 * @returns {Terrain|null}
 */
export function asTerrain(terrain) {
  if (!terrain || typeof terrain !== 'object') return null;
  if (terrain.cells instanceof Uint8Array) return terrain;
  if (typeof terrain.flags === 'string') {
    const hit = decodedMemo.get(terrain);
    if (hit) return hit;
    const t = decodeTerrain(terrain);
    decodedMemo.set(terrain, t);
    return t;
  }
  return null;
}

/**
 * Whether (col,row) is inside the terrain.
 * @param {Terrain|TerrainWire} terrain
 * @param {number} col
 * @param {number} row
 * @returns {boolean}
 */
export function inBounds(terrain, col, row) {
  const t = asTerrain(terrain);
  if (!t) return false;
  return Number.isInteger(col) && Number.isInteger(row) &&
    col >= 0 && row >= 0 && col < t.cols && row < t.rows;
}

/**
 * Flag byte at (col,row); 0 when the terrain is absent or out of bounds.
 * @param {Terrain|TerrainWire|null} terrain
 * @param {number} col
 * @param {number} row
 * @returns {number}
 */
export function flagAt(terrain, col, row) {
  const t = asTerrain(terrain);
  if (!t || !inBounds(t, col, row)) return 0;
  return t.cells[row * t.cols + col];
}

/**
 * True when every bit of `flag` is set at (col,row).
 * @param {Terrain|TerrainWire|null} terrain
 * @param {number} col
 * @param {number} row
 * @param {number} flag
 * @returns {boolean}
 */
export function hasFlag(terrain, col, row, flag) {
  return (flagAt(terrain, col, row) & flag) === flag && flag !== 0;
}

function cloneTerrain(terrain) {
  const t = asTerrain(terrain);
  return { v: TERRAIN_VERSION, cols: t.cols, rows: t.rows, cells: new Uint8Array(t.cells) };
}

/**
 * Set bits at one cell. Out-of-bounds cells are ignored.
 * @param {Terrain|TerrainWire} terrain
 * @param {number} col
 * @param {number} row
 * @param {number} flag
 * @returns {Terrain} a new terrain
 */
export function setFlag(terrain, col, row, flag) {
  return applyTerrainPaint(terrain, { cells: [{ col, row }], flag, op: 'set' });
}

/**
 * Clear bits at one cell. Out-of-bounds cells are ignored.
 * @param {Terrain|TerrainWire} terrain
 * @param {number} col
 * @param {number} row
 * @param {number} flag
 * @returns {Terrain} a new terrain
 */
export function clearFlag(terrain, col, row, flag) {
  return applyTerrainPaint(terrain, { cells: [{ col, row }], flag, op: 'clear' });
}

/**
 * Apply a brush stroke (the payload of the `dm.terrain.paint` intent).
 * `op: 'set'` ORs the flag in, `'clear'` masks it out, `'replace'` writes
 * the flag byte exactly (0 erases the cell).
 * @param {Terrain|TerrainWire} terrain
 * @param {{cells: {col: number, row: number}[], flag: number, op?: 'set'|'clear'|'replace'}} paint
 * @returns {Terrain} a new terrain
 */
export function applyTerrainPaint(terrain, paint) {
  const t = cloneTerrain(terrain);
  const flag = (Number(paint?.flag) | 0) & TERRAIN_FLAG_MASK;
  const op = paint?.op || 'set';
  for (const cell of (paint?.cells || [])) {
    if (!cell || !inBounds(t, cell.col, cell.row)) continue;
    const i = cell.row * t.cols + cell.col;
    if (op === 'clear') t.cells[i] &= ~flag & TERRAIN_FLAG_MASK;
    else if (op === 'replace') t.cells[i] = flag;
    else t.cells[i] |= flag;
  }
  return t;
}

/**
 * Resize, preserving the overlapping top-left region. New cells are open.
 * @param {Terrain|TerrainWire} terrain
 * @param {number} cols
 * @param {number} rows
 * @returns {Terrain}
 */
export function resizeTerrain(terrain, cols, rows) {
  const src = asTerrain(terrain);
  const out = createTerrain(cols, rows);
  if (!src) return out;
  const w = Math.min(src.cols, out.cols);
  const h = Math.min(src.rows, out.rows);
  for (let r = 0; r < h; r++) {
    out.cells.set(src.cells.subarray(r * src.cols, r * src.cols + w), r * out.cols);
  }
  return out;
}

/**
 * Backfill for old saves and scenes: absent terrain means all open; a
 * terrain whose size disagrees with the grid is resized to match.
 * @param {Terrain|TerrainWire|null|undefined} terrain
 * @param {number} cols
 * @param {number} rows
 * @returns {Terrain}
 */
export function mergeWithDefault(terrain, cols, rows) {
  const t = asTerrain(terrain);
  if (!t) return createTerrain(cols, rows);
  if (t.cols === dim(cols) && t.rows === dim(rows)) return t;
  return resizeTerrain(t, cols, rows);
}

/**
 * True when no cell has any flag (lets callers skip terrain work).
 * @param {Terrain|TerrainWire|null} terrain
 * @returns {boolean}
 */
export function isTerrainEmpty(terrain) {
  const t = asTerrain(terrain);
  if (!t) return true;
  for (let i = 0; i < t.cells.length; i++) if (t.cells[i] !== 0) return false;
  return true;
}
