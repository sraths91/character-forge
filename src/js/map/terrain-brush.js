/**
 * M64 E5 / M6 — DM terrain paint brush.
 *
 * `attachTerrainBrush(canvas, camera, terrain, onPaint, opts)` turns a
 * pointer stroke over the battle canvas into ONE paint payload per stroke:
 *   { cells: [{col, row}], flag, op: 'set'|'clear' }
 * which E2 sends as the `dm.terrain.paint` intent; the server applies it
 * with `applyTerrainPaint` (map/terrain.js). The brush never edits the
 * terrain itself.
 *
 *   - Primary button paints `opts.flag` with `opts.op` (default 'set').
 *   - Right button, or Shift held at stroke start, erases (`op: 'clear'`).
 *   - Fast drags are filled in along a supercover line so no cell is skipped.
 *   - `opts` is read at the start of each stroke, so the host can switch
 *     the flag/op (palette buttons) by mutating the same object.
 *   - Strokes ignore pointers that the camera pans with (`opts.shouldPan`).
 *
 * DOM only through the canvas passed in; geometry comes from camera.js.
 */

import { pickCell, WORLD_CELL_PX } from './camera.js';
import { supercoverBetween } from '../scene/grid-legality.js';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import('./camera.js').Camera} camera — read live (the camera object may be mutated by the controls)
 * @param {object|(() => object)} terrain — terrain (either form) or a getter; used for bounds
 * @param {(paint: {cells: {col: number, row: number}[], flag: number, op: 'set'|'clear'}) => void} onPaint
 * @param {{flag?: number, op?: 'set'|'clear', cellPx?: number, enabled?: boolean,
 *          shouldPan?: (e: PointerEvent) => boolean,
 *          onPreview?: (cells: {col: number, row: number}[], op: string) => void}} [opts]
 * @returns {() => void} detach
 */
export function attachTerrainBrush(canvas, camera, terrain, onPaint, opts = {}) {
  let stroke = null;   // {pointerId, flag, op, cells: Map<key, cell>, last}

  const bounds = () => {
    const t = typeof terrain === 'function' ? terrain() : terrain;
    return { cols: t?.cols ?? Infinity, rows: t?.rows ?? Infinity };
  };
  const cellAt = (e) => pickCell(e.clientX, e.clientY, camera, opts.cellPx || WORLD_CELL_PX, canvas.getBoundingClientRect());
  const addCell = (cell) => {
    const b = bounds();
    if (cell.col < 0 || cell.row < 0 || cell.col >= b.cols || cell.row >= b.rows) return;
    const k = `${cell.col},${cell.row}`;
    if (!stroke.cells.has(k)) stroke.cells.set(k, { col: cell.col, row: cell.row });
  };
  const addSegment = (from, to) => {
    if (from) {
      for (const group of supercoverBetween(from, to)) for (const c of group) addCell(c);
    }
    addCell(to);
  };
  const preview = () => opts.onPreview?.([...stroke.cells.values()], stroke.op);

  const onDown = (e) => {
    if (opts.enabled === false || stroke) return;
    if (opts.shouldPan?.(e)) return;
    const erase = e.button === 2 || e.shiftKey;
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    stroke = {
      pointerId: e.pointerId,
      flag: (opts.flag ?? 1) | 0,
      op: erase ? 'clear' : (opts.op === 'clear' ? 'clear' : 'set'),
      cells: new Map(),
      last: null
    };
    const c = cellAt(e);
    addSegment(null, c);
    stroke.last = c;
    canvas.setPointerCapture?.(e.pointerId);
    preview();
  };
  const onMove = (e) => {
    if (!stroke || e.pointerId !== stroke.pointerId) return;
    const c = cellAt(e);
    if (stroke.last && c.col === stroke.last.col && c.row === stroke.last.row) return;
    addSegment(stroke.last, c);
    stroke.last = c;
    preview();
  };
  const finish = (e, cancelled) => {
    if (!stroke || e.pointerId !== stroke.pointerId) return;
    const done = stroke;
    stroke = null;
    canvas.releasePointerCapture?.(e.pointerId);
    opts.onPreview?.([], done.op);
    if (cancelled || done.cells.size === 0 || !done.flag) return;
    onPaint({ cells: [...done.cells.values()], flag: done.flag, op: done.op });
  };
  const onUp = (e) => finish(e, false);
  const onCancel = (e) => finish(e, true);
  const onContextMenu = (e) => { if (opts.enabled !== false) e.preventDefault(); };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('contextmenu', onContextMenu);
  return function detach() {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    stroke = null;
  };
}
