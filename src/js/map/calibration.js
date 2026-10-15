/**
 * M64 E5 / M3 — calibrated image maps: pure geometry.
 *
 * A DM-uploaded battle map carries its own painted grid. Calibration
 * records where that grid sits in the image, in source-image pixels:
 *   map.calib = { cellPx, offsetX, offsetY }
 * Engine cell (c, r) covers the image rect
 *   (offsetX + c·cellPx, offsetY + r·cellPx, cellPx, cellPx).
 * The renderer draws one source rect covering cols × rows cells onto the
 * world grid, so the painted grid lines land on the game grid at any
 * zoom (replacing the old cover-fit, which cropped and never aligned).
 *
 * Pure, Node-safe. The DOM calibration modal lives in `calibrate.js`.
 */

/**
 * Image-space rect of one engine cell.
 * @param {{calib: {cellPx: number, offsetX: number, offsetY: number}}} map
 * @param {number} col
 * @param {number} row
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
export function cellRectInImage(map, col, row) {
  const k = map?.calib?.cellPx;
  if (!(k > 0)) return null;
  return {
    x: (map.calib.offsetX || 0) + col * k,
    y: (map.calib.offsetY || 0) + row * k,
    w: k,
    h: k
  };
}

/**
 * Inverse of cellRectInImage: which engine cell an image pixel falls in.
 * @param {{calib: {cellPx: number, offsetX: number, offsetY: number}}} map
 * @param {number} x — image px
 * @param {number} y — image px
 * @returns {{col: number, row: number}|null}
 */
export function imagePointToCell(map, x, y) {
  const k = map?.calib?.cellPx;
  if (!(k > 0)) return null;
  return {
    col: Math.floor((x - (map.calib.offsetX || 0)) / k),
    row: Math.floor((y - (map.calib.offsetY || 0)) / k)
  };
}

/**
 * The `drawImage` 9-argument rect pair that paints a calibrated image
 * under a cols × rows grid of `cellPx`-sized world cells. The source rect
 * is clipped to the image bounds (cells off the image edge stay
 * unpainted) and the destination is clipped by the same proportion, so
 * the mapping image-x → world-x is identical with or without clipping.
 *
 * @param {{calib: {cellPx: number, offsetX: number, offsetY: number}, imgW?: number, imgH?: number}} map
 * @param {number} cols
 * @param {number} rows
 * @param {number} cellPx — world units per cell
 * @param {{width?: number, height?: number}} [img] — falls back to map.imgW/imgH
 * @returns {{sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number}|null}
 */
export function imageSourceRect(map, cols, rows, cellPx, img = null) {
  const k = map?.calib?.cellPx;
  if (!(k > 0) || !(cellPx > 0) || !(cols > 0) || !(rows > 0)) return null;
  const imgW = Number(img?.naturalWidth || img?.width || map.imgW) || Infinity;
  const imgH = Number(img?.naturalHeight || img?.height || map.imgH) || Infinity;
  const ox = map.calib.offsetX || 0;
  const oy = map.calib.offsetY || 0;
  const scale = cellPx / k;                 // world units per image px
  const sx0 = Math.max(0, ox);
  const sy0 = Math.max(0, oy);
  const sx1 = Math.min(imgW, ox + cols * k);
  const sy1 = Math.min(imgH, oy + rows * k);
  if (!(sx1 > sx0) || !(sy1 > sy0)) return null;
  return {
    sx: sx0, sy: sy0, sw: sx1 - sx0, sh: sy1 - sy0,
    dx: (sx0 - ox) * scale, dy: (sy0 - oy) * scale,
    dw: (sx1 - sx0) * scale, dh: (sy1 - sy0) * scale
  };
}

/**
 * Shift the offset into [0, cellPx) so equivalent calibrations compare
 * equal (an offset of k + 3 is the same grid as 3).
 * @param {{cellPx: number, offsetX: number, offsetY: number}} calib
 * @returns {{cellPx: number, offsetX: number, offsetY: number}}
 */
export function normalizeCalib(calib) {
  const k = Number(calib?.cellPx);
  if (!(k > 0)) return { cellPx: k, offsetX: Number(calib?.offsetX) || 0, offsetY: Number(calib?.offsetY) || 0 };
  const mod = (v) => ((Number(v) || 0) % k + k) % k;
  return { cellPx: k, offsetX: mod(calib.offsetX), offsetY: mod(calib.offsetY) };
}

// ---------------------------------------------------------------------------
// M64 M9 — calibration math (the DOM modal is map/calibrate.js)
// ---------------------------------------------------------------------------

/** Smallest image cell size accepted: below it a cell is too blurry to read. */
export const MIN_CELL_PX = 24;
/** x/y cell-size disagreement (two-click) above which the UI warns. */
export const SKEW_WARN = 0.03;

/**
 * Owlbear convention: a filename containing `NxM` names the grid size.
 * @param {string} name — e.g. 'crypt_30x20_gridded.webp'
 * @returns {{cols: number, rows: number}|null}
 */
export function parseGridFromFilename(name) {
  const m = String(name || '').match(/(?:^|[^0-9])(\d{1,3})\s*[x×]\s*(\d{1,3})(?![0-9])/i);
  if (!m) return null;
  const cols = Number(m[1]), rows = Number(m[2]);
  return cols > 0 && rows > 0 && cols <= 500 && rows <= 500 ? { cols, rows } : null;
}

/**
 * Known-size mode: the image IS the grid, cols × rows cells edge to edge.
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} cols
 * @param {number} rows
 * @returns {{calib: {cellPx: number, offsetX: number, offsetY: number}, cols: number, rows: number, skew: number}}
 */
export function calibFromKnownSize(imgW, imgH, cols, rows) {
  const kx = imgW / cols;
  const ky = imgH / rows;
  return {
    calib: { cellPx: kx, offsetX: 0, offsetY: 0 },
    cols: Math.floor(cols),
    rows: Math.floor(rows),
    skew: Math.abs(kx - ky) / Math.max(kx, ky)
  };
}

/**
 * Two-click mode: `p1` is the top-left corner of a cell, `p2` the
 * bottom-right corner of the cell `n` cells right and `n` cells down
 * (so the two points are n cells apart on both axes). Image px.
 * @param {{x: number, y: number}} p1
 * @param {{x: number, y: number}} p2
 * @param {number} [n]
 * @returns {{calib: {cellPx: number, offsetX: number, offsetY: number}, skew: number}|null}
 */
export function calibFromTwoClicks(p1, p2, n = 3) {
  const cells = Math.max(1, Math.round(n));
  const kx = (p2.x - p1.x) / cells;
  const ky = (p2.y - p1.y) / cells;
  if (!(kx > 0) || !(ky > 0)) return null;
  const k = (kx + ky) / 2;
  return {
    calib: normalizeCalib({ cellPx: k, offsetX: p1.x, offsetY: p1.y }),
    skew: Math.abs(kx - ky) / Math.max(kx, ky)
  };
}

/**
 * Refine the cell size from a far corner: `point` is where the DM sees
 * the top-left corner of cell (col, row). Spreading the error over many
 * cells beats the two-click estimate (drift fix).
 * @param {{cellPx: number, offsetX: number, offsetY: number}} calib
 * @param {{x: number, y: number}} point
 * @param {number} col
 * @param {number} row
 * @returns {{cellPx: number, offsetX: number, offsetY: number}}
 */
export function refineWithFarCorner(calib, point, col, row) {
  const est = [];
  if (col > 0) est.push((point.x - calib.offsetX) / col);
  if (row > 0) est.push((point.y - calib.offsetY) / row);
  const good = est.filter(k => k > 0);
  if (good.length === 0) return { ...calib };
  return { ...calib, cellPx: good.reduce((a, b) => a + b, 0) / good.length };
}

/**
 * Whole cells that fit in the image from the offset.
 * @param {number} imgW
 * @param {number} imgH
 * @param {{cellPx: number, offsetX: number, offsetY: number}} calib
 * @returns {{cols: number, rows: number}}
 */
export function gridDimsFor(imgW, imgH, calib) {
  const k = calib.cellPx;
  if (!(k > 0)) return { cols: 0, rows: 0 };
  const eps = 0.02;   // tolerate a grid that ends a hair past the edge
  return {
    cols: Math.max(0, Math.floor((imgW - calib.offsetX) / k + eps)),
    rows: Math.max(0, Math.floor((imgH - calib.offsetY) / k + eps))
  };
}

/**
 * Keyboard nudges: arrows move the offset 1 px (Shift: 0.1 cell);
 * `[` / `]` shrink / grow the cell by 0.1 px. Unknown keys → null.
 * @param {{cellPx: number, offsetX: number, offsetY: number}} calib
 * @param {string} key — KeyboardEvent.key
 * @param {{shift?: boolean}} [mods]
 * @returns {{cellPx: number, offsetX: number, offsetY: number}|null}
 */
export function nudgeCalib(calib, key, { shift = false } = {}) {
  const step = shift ? calib.cellPx * 0.1 : 1;
  const out = { ...calib };
  switch (key) {
    case 'ArrowLeft': out.offsetX -= step; break;
    case 'ArrowRight': out.offsetX += step; break;
    case 'ArrowUp': out.offsetY -= step; break;
    case 'ArrowDown': out.offsetY += step; break;
    case '[': out.cellPx = Math.max(1, out.cellPx - 0.1); break;
    case ']': out.cellPx += 0.1; break;
    default: return null;
  }
  return normalizeCalib(out);
}

/**
 * The cell farthest from the origin, for the drift check.
 * @param {number} imgW
 * @param {number} imgH
 * @param {{cellPx: number, offsetX: number, offsetY: number}} calib
 * @returns {{col: number, row: number, rect: {x: number, y: number, w: number, h: number}}|null}
 */
export function farCornerCell(imgW, imgH, calib) {
  const { cols, rows } = gridDimsFor(imgW, imgH, calib);
  if (cols < 1 || rows < 1) return null;
  const col = cols - 1, row = rows - 1;
  return { col, row, rect: cellRectInImage({ calib }, col, row) };
}

/**
 * Validate and finish a calibration: offset normalised, dims computed,
 * cells under MIN_CELL_PX rejected.
 * @param {{cellPx: number, offsetX: number, offsetY: number}} calib
 * @param {number} imgW
 * @param {number} imgH
 * @returns {{ok: boolean, reason: string|null, calib: object, cols: number, rows: number}}
 */
export function finalizeCalibration(calib, imgW, imgH) {
  const c = normalizeCalib(calib || {});
  const { cols, rows } = gridDimsFor(imgW, imgH, c);
  let reason = null;
  if (!(c.cellPx > 0)) reason = 'no-cell-size';
  else if (c.cellPx < MIN_CELL_PX) reason = 'cell-too-small';
  else if (cols < 1 || rows < 1) reason = 'no-whole-cells';
  else if (cols > 500 || rows > 500) reason = 'grid-too-large';
  return { ok: reason === null, reason, calib: c, cols, rows };
}
