/**
 * M64 E5 / M10 — fog of war as a per-cell revealed bitset.
 *
 * `fog = {revealed: base64}`: bit `row * cols + col` (LSB-first within each
 * byte) is 1 when the cell is revealed. 30×20 cells cost 75 bytes. No fog
 * object (null) means everything is visible.
 *
 * Rendering only hides pixels, which devtools can undo, so the server
 * must also strip what players may not know: `filterViewForFog(view)`
 * drops entities/tokens standing in unrevealed cells and clears terrain
 * flags there. It accepts a RenderView or an EncounterState projection
 * (the server calls it inside `viewFor` for player seats; the DM's view
 * is never filtered). Phase 1 ships the data path; the DM reveal brush
 * and LOS auto-reveal come later.
 *
 * Pure, Node-safe.
 */

import { bytesToBase64, base64ToBytes } from './base64.js';
import { asTerrain, encodeTerrain } from './terrain.js';

/**
 * @param {number} cols
 * @param {number} rows
 * @param {{revealed?: boolean}} [opts] — start fully revealed instead of hidden
 * @returns {{revealed: string}}
 */
export function createFog(cols, rows, { revealed = false } = {}) {
  const n = Math.max(1, cols * rows);
  const bytes = new Uint8Array(Math.ceil(n / 8));
  if (revealed) {
    bytes.fill(0xFF);
    const extra = bytes.length * 8 - n;
    if (extra > 0) bytes[bytes.length - 1] = 0xFF >> extra;
  }
  return { revealed: bytesToBase64(bytes) };
}

const memo = new WeakMap();
function bitsOf(fog) {
  if (!fog || typeof fog.revealed !== 'string') return null;
  let b = memo.get(fog);
  if (!b) { b = base64ToBytes(fog.revealed); memo.set(fog, b); }
  return b;
}

/**
 * Whether (col,row) is revealed. No fog ⇒ true; bits past the data ⇒ hidden.
 * @param {{revealed: string}|null} fog
 * @param {number} cols
 * @param {number} col
 * @param {number} row
 * @returns {boolean}
 */
export function isRevealed(fog, cols, col, row) {
  const bits = bitsOf(fog);
  if (!bits) return true;
  if (col < 0 || row < 0 || col >= cols) return false;
  const i = row * cols + col;
  const byte = bits[i >> 3];
  return byte !== undefined && ((byte >> (i & 7)) & 1) === 1;
}

/**
 * Reveal (or hide) cells; returns a new fog.
 * @param {{revealed: string}|null} fog — null starts fully hidden
 * @param {number} cols
 * @param {number} rows
 * @param {{col: number, row: number}[]} cells
 * @param {boolean} [reveal]
 * @returns {{revealed: string}}
 */
export function revealCells(fog, cols, rows, cells, reveal = true) {
  const n = cols * rows;
  const bytes = new Uint8Array(Math.ceil(Math.max(1, n) / 8));
  const src = bitsOf(fog);
  if (src) bytes.set(src.subarray(0, bytes.length));
  for (const c of cells || []) {
    if (!c || c.col < 0 || c.row < 0 || c.col >= cols || c.row >= rows) continue;
    const i = c.row * cols + c.col;
    if (reveal) bytes[i >> 3] |= 1 << (i & 7);
    else bytes[i >> 3] &= ~(1 << (i & 7));
  }
  return { revealed: bytesToBase64(bytes) };
}

/** Count revealed cells (for tests and the DM panel). */
export function revealedCount(fog, cols, rows) {
  let n = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (isRevealed(fog, cols, c, r)) n++;
  return n;
}

function posOf(e) {
  if (!e) return null;
  if (e.pos) return e.pos;
  if (Number.isFinite(e.col) && Number.isFinite(e.row)) return { col: e.col, row: e.row };
  return e._position || e.position || null;
}

/**
 * Remove what a player must not receive: entities / tokens in unrevealed
 * cells, and terrain flags under fog. Returns a new object (the input is
 * untouched); a view without fog is returned as-is.
 *
 * For an EncounterState projection it also drops the hidden entities'
 * initiative rows (remapping turnIndex) and their ids from other
 * entities' concentration targets, so the result still validates.
 *
 * @param {object} view — RenderView (`tokens[]`) or EncounterState (`entities{}`)
 * @returns {object}
 */
export function filterViewForFog(view) {
  const fog = view?.fog;
  if (!fog || typeof fog.revealed !== 'string') return view;
  const cols = view.grid?.cols;
  const visible = (e) => { const p = posOf(e); return !!p && isRevealed(fog, cols, p.col, p.row); };
  const out = { ...view };

  if (Array.isArray(view.tokens)) out.tokens = view.tokens.filter(visible);

  if (view.entities && typeof view.entities === 'object' && !Array.isArray(view.entities)) {
    const kept = {};
    for (const [id, e] of Object.entries(view.entities)) if (visible(e)) kept[id] = e;
    for (const [id, e] of Object.entries(kept)) {
      if (e.concentration?.targetIds?.some(t => !(t in kept))) {
        kept[id] = { ...e, concentration: { ...e.concentration, targetIds: e.concentration.targetIds.filter(t => t in kept) } };
      }
    }
    out.entities = kept;
    if (Array.isArray(view.initiative)) {
      const before = view.initiative.slice(0, view.turnIndex || 0).filter(r => r.entityId in kept).length;
      out.initiative = view.initiative.filter(r => r.entityId in kept);
      out.turnIndex = out.initiative.length ? Math.min(before, out.initiative.length - 1) : 0;
    }
  }

  // Terrain under fog is unknown to players.
  const gridTerrain = view.grid?.terrain ?? null;
  const viewTerrain = view.terrain ?? null;
  const mask = (wire) => {
    const t = asTerrain(wire);
    if (!t) return wire;
    const cells = new Uint8Array(t.cells);
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
      if (!isRevealed(fog, t.cols, c, r)) cells[r * t.cols + c] = 0;
    }
    return encodeTerrain({ v: t.v, cols: t.cols, rows: t.rows, cells });
  };
  if (gridTerrain) out.grid = { ...view.grid, terrain: mask(gridTerrain) };
  if (viewTerrain) out.terrain = mask(viewTerrain);
  return out;
}
