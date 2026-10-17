/**
 * M64 E5 / phase 1.5 — DM fog-of-war reveal brush.
 *
 * `attachFogBrush(canvas, camera, grid, onPaint, opts)` turns a pointer
 * stroke over the battle canvas into ONE payload per stroke:
 *   { cells: [{col, row}], op: 'reveal'|'hide' }
 * which E2 sends as the `dm.fog.paint` intent; the server applies it to
 * `state.fog` with `applyFogPaint(fog, payload, grid)` (map/fog.js). The
 * brush never edits the fog itself.
 *
 *   - Primary button paints `opts.op` (default 'reveal').
 *   - Right button, or Shift held at stroke start, hides (`op: 'hide'`).
 *   - Gap filling, panning pointers and live previews behave exactly like
 *     the terrain brush (shared `attachCellBrush`).
 *   - `opts` is read at the start of each stroke (palette buttons may
 *     mutate it).
 */

import { attachCellBrush } from './terrain-brush.js';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import('./camera.js').Camera} camera
 * @param {{cols: number, rows: number}|(() => {cols: number, rows: number})} grid — bounds (or a getter)
 * @param {(paint: {cells: {col: number, row: number}[], op: 'reveal'|'hide'}) => void} onPaint
 * @param {{op?: 'reveal'|'hide', cellPx?: number, enabled?: boolean,
 *          shouldPan?: (e: PointerEvent) => boolean,
 *          onPreview?: (cells: {col: number, row: number}[], op: string) => void}} [opts]
 * @returns {() => void} detach
 */
export function attachFogBrush(canvas, camera, grid, onPaint, opts = {}) {
  const bounds = () => {
    const g = typeof grid === 'function' ? grid() : grid;
    return { cols: g?.cols ?? Infinity, rows: g?.rows ?? Infinity };
  };
  return attachCellBrush(canvas, camera, bounds, {
    begin: (erase) => ({ op: erase || opts.op === 'hide' ? 'hide' : 'reveal' }),
    end: (meta, cells) => onPaint({ cells, op: meta.op })
  }, opts);
}
