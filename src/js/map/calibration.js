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
