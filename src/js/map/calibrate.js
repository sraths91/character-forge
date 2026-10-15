/**
 * M64 E5 / M9 — DM grid-calibration panel for an uploaded battle map.
 *
 * `mountCalibrator(root, {image, filename, onConfirm, onCancel})` builds the
 * panel inside `root` and returns `unmount()`. E2 mounts it in the DM's
 * encounter-setup modal (C9). All math lives in `calibration.js`; this
 * file is only DOM and drawing.
 *
 * Modes (Roll20 / Foundry / Owlbear conventions, R4 R1):
 *   - Known size — cols × rows, prefilled from an `NxM` filename; the
 *     image is the grid edge to edge.
 *   - Two-click — click the top-left corner of a cell, then the
 *     bottom-right corner of the cell N cells right and down (N = 3 by
 *     default). A 4× loupe follows the pointer.
 * Refine: arrows nudge the offset 1 px (Shift: 0.1 cell), `[` / `]`
 * change the cell size by 0.1 px. "Check drift" outlines the far-corner
 * cell; while it is on, clicking that cell's top-left corner re-fits the
 * cell size across the whole map. Confirm is disabled until the result
 * passes `finalizeCalibration` (cells ≥ 24 image px).
 *
 * Output: onConfirm({calib: {cellPx, offsetX, offsetY}, cols, rows}).
 */

import {
  MIN_CELL_PX, SKEW_WARN, parseGridFromFilename, calibFromKnownSize, calibFromTwoClicks,
  refineWithFarCorner, nudgeCalib, farCornerCell, finalizeCalibration, normalizeCalib
} from './calibration.js';

const LOUPE_ZOOM = 4;
const LOUPE_PX = 128;
const MAX_VIEW_W = 960;
const MAX_VIEW_H = 640;

/**
 * @param {HTMLElement} root
 * @param {{image: HTMLImageElement|HTMLCanvasElement|ImageBitmap, filename?: string, n?: number,
 *          initial?: {calib: {cellPx: number, offsetX: number, offsetY: number}},
 *          onConfirm: (result: {calib: {cellPx: number, offsetX: number, offsetY: number}, cols: number, rows: number}) => void,
 *          onCancel?: () => void}} opts
 * @returns {() => void} unmount
 */
export function mountCalibrator(root, { image, filename = '', n = 3, initial = null, onConfirm, onCancel } = {}) {
  const doc = root.ownerDocument || globalThis.document;
  const imgW = image.naturalWidth || image.width;
  const imgH = image.naturalHeight || image.height;
  const fromName = parseGridFromFilename(filename);
  const state = {
    mode: fromName && !initial ? 'known' : 'two-click',
    calib: initial?.calib ? normalizeCalib(initial.calib) : null,
    clicks: [],
    n: Math.max(1, Math.round(n)),
    drift: false,
    skew: 0,
    hover: null
  };
  if (fromName && !initial) {
    const r = calibFromKnownSize(imgW, imgH, fromName.cols, fromName.rows);
    state.calib = r.calib;
    state.skew = r.skew;
  }

  const el = (tag, props = {}, children = []) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') Object.assign(e.style, v);
      else if (k === 'text') e.textContent = v;
      else e[k] = v;
    }
    for (const c of children) e.appendChild(c);
    return e;
  };

  // ---- DOM ----------------------------------------------------------------
  const scale = Math.min(1, MAX_VIEW_W / imgW, MAX_VIEW_H / imgH);
  const view = el('canvas', { width: Math.round(imgW * scale), height: Math.round(imgH * scale), className: 'cf-calib-view',
    style: { cursor: 'crosshair', maxWidth: '100%', display: 'block' } });
  const loupe = el('canvas', { width: LOUPE_PX, height: LOUPE_PX, className: 'cf-calib-loupe',
    style: { border: '1px solid #64748b', imageRendering: 'pixelated' } });
  const tabKnown = el('button', { type: 'button', text: 'Known size', className: 'cf-calib-tab' });
  const tabTwo = el('button', { type: 'button', text: 'Two-click', className: 'cf-calib-tab' });
  const colsIn = el('input', { type: 'number', min: '1', max: '500', value: String(fromName?.cols || ''), className: 'cf-calib-cols', style: { width: '4em' } });
  const rowsIn = el('input', { type: 'number', min: '1', max: '500', value: String(fromName?.rows || ''), className: 'cf-calib-rows', style: { width: '4em' } });
  const applyKnown = el('button', { type: 'button', text: 'Apply', className: 'cf-calib-apply' });
  const knownRow = el('div', { className: 'cf-calib-known' }, [
    el('span', { text: 'Columns ' }), colsIn, el('span', { text: ' × rows ' }), rowsIn, applyKnown
  ]);
  const nIn = el('input', { type: 'number', min: '1', max: '20', value: String(state.n), className: 'cf-calib-n', style: { width: '3em' } });
  const twoHelp = el('span', { className: 'cf-calib-help' });
  const twoRow = el('div', { className: 'cf-calib-two' }, [el('span', { text: 'Cells apart ' }), nIn, el('span', { text: ' ' }), twoHelp]);
  const driftBtn = el('button', { type: 'button', text: 'Check drift', className: 'cf-calib-drift' });
  const readout = el('div', { className: 'cf-calib-readout', style: { fontFamily: 'ui-monospace, monospace' } });
  const warn = el('div', { className: 'cf-calib-warn', style: { color: '#f59e0b' } });
  const confirmBtn = el('button', { type: 'button', text: 'Use this grid', className: 'cf-calib-confirm' });
  const cancelBtn = el('button', { type: 'button', text: 'Cancel', className: 'cf-calib-cancel' });
  const panel = el('div', { className: 'cf-calibrator', tabIndex: 0, style: { outline: 'none' } }, [
    el('div', { className: 'cf-calib-tabs' }, [tabKnown, tabTwo]),
    knownRow, twoRow,
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } }, [view, el('div', {}, [loupe, driftBtn])]),
    readout, warn,
    el('div', { className: 'cf-calib-actions' }, [confirmBtn, cancelBtn]),
    el('div', { className: 'cf-calib-keys', text: 'Arrows: nudge 1 px · Shift+arrows: 0.1 cell · [ ]: cell size ±0.1 px · Esc: cancel' })
  ]);
  root.appendChild(panel);

  // ---- drawing ------------------------------------------------------------
  const vctx = view.getContext('2d');
  const lctx = loupe.getContext('2d');

  function render() {
    const result = state.calib ? finalizeCalibration(state.calib, imgW, imgH) : null;
    knownRow.style.display = state.mode === 'known' ? '' : 'none';
    twoRow.style.display = state.mode === 'two-click' ? '' : 'none';
    tabKnown.disabled = state.mode === 'known';
    tabTwo.disabled = state.mode === 'two-click';
    twoHelp.textContent = state.clicks.length === 0
      ? 'Click the top-left corner of a cell.'
      : `Now click the bottom-right corner of the cell ${state.n} right and ${state.n} down.`;
    driftBtn.textContent = state.drift ? 'Drift check: on (click the far cell’s top-left corner to refit)' : 'Check drift';

    if (vctx) {
      vctx.setTransform?.(1, 0, 0, 1, 0, 0);
      vctx.clearRect(0, 0, view.width, view.height);
      vctx.imageSmoothingEnabled = true;
      vctx.drawImage(image, 0, 0, view.width, view.height);
      vctx.setTransform?.(scale, 0, 0, scale, 0, 0);
      if (state.calib && state.calib.cellPx > 0) drawGrid(vctx, state.calib);
      if (state.drift && state.calib) {
        const far = farCornerCell(imgW, imgH, state.calib);
        if (far) {
          vctx.strokeStyle = '#f97316';
          vctx.lineWidth = 3 / scale;
          vctx.strokeRect(far.rect.x, far.rect.y, far.rect.w, far.rect.h);
        }
      }
      vctx.fillStyle = '#22d3ee';
      for (const c of state.clicks) {
        vctx.beginPath();
        vctx.arc(c.x, c.y, 4 / scale, 0, Math.PI * 2);
        vctx.fill();
      }
    }

    if (result) {
      const c = result.calib;
      readout.textContent = `cell ${c.cellPx.toFixed(2)} px · offset (${c.offsetX.toFixed(1)}, ${c.offsetY.toFixed(1)}) · ${result.cols} × ${result.rows} cells`;
    } else {
      readout.textContent = 'No grid yet.';
    }
    const warnings = [];
    if (result && result.reason === 'cell-too-small') warnings.push(`Cells are under ${MIN_CELL_PX} px in this image — too small to read. Use a larger image or fewer cells.`);
    else if (result && !result.ok) warnings.push(`Not usable yet (${result.reason}).`);
    if (state.skew > SKEW_WARN) warnings.push(`Width and height disagree by ${(state.skew * 100).toFixed(1)}% — check the clicks or the size.`);
    warn.textContent = warnings.join(' ');
    confirmBtn.disabled = !result || !result.ok;
  }

  function drawGrid(ctx, calib) {
    const k = calib.cellPx;
    ctx.save();
    ctx.strokeStyle = 'rgba(34,211,238,0.85)';
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    for (let x = calib.offsetX; x <= imgW + 0.01; x += k) { ctx.moveTo(x, 0); ctx.lineTo(x, imgH); }
    for (let y = calib.offsetY; y <= imgH + 0.01; y += k) { ctx.moveTo(0, y); ctx.lineTo(imgW, y); }
    ctx.stroke();
    ctx.restore();
  }

  function drawLoupe(p) {
    if (!lctx) return;
    const src = LOUPE_PX / LOUPE_ZOOM;
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = '#0f172a';
    lctx.fillRect(0, 0, LOUPE_PX, LOUPE_PX);
    lctx.drawImage(image, p.x - src / 2, p.y - src / 2, src, src, 0, 0, LOUPE_PX, LOUPE_PX);
    lctx.strokeStyle = '#f43f5e';
    lctx.lineWidth = 1;
    lctx.beginPath();
    lctx.moveTo(LOUPE_PX / 2 + 0.5, 0); lctx.lineTo(LOUPE_PX / 2 + 0.5, LOUPE_PX);
    lctx.moveTo(0, LOUPE_PX / 2 + 0.5); lctx.lineTo(LOUPE_PX, LOUPE_PX / 2 + 0.5);
    lctx.stroke();
  }

  // ---- input ---------------------------------------------------------------
  const toImage = (e) => {
    const r = view.getBoundingClientRect();
    const sx = r.width ? imgW / r.width : 1 / scale;
    const sy = r.height ? imgH / r.height : 1 / scale;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  };

  const onViewClick = (e) => {
    const p = toImage(e);
    if (state.drift && state.calib) {
      const far = farCornerCell(imgW, imgH, state.calib);
      if (far) state.calib = normalizeCalib(refineWithFarCorner(state.calib, p, far.col, far.row));
      render();
      return;
    }
    if (state.mode !== 'two-click') return;
    state.clicks.push(p);
    if (state.clicks.length === 2) {
      const r = calibFromTwoClicks(state.clicks[0], state.clicks[1], state.n);
      if (r) { state.calib = r.calib; state.skew = r.skew; }
      state.clicks = [];
    }
    render();
  };
  const onViewMove = (e) => { state.hover = toImage(e); drawLoupe(state.hover); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault?.(); onCancel?.(); return; }
    if (!state.calib) return;
    const next = nudgeCalib(state.calib, e.key, { shift: !!e.shiftKey });
    if (!next) return;
    e.preventDefault?.();
    state.calib = next;
    render();
  };
  const onApplyKnown = () => {
    const cols = Number(colsIn.value), rows = Number(rowsIn.value);
    if (!(cols > 0) || !(rows > 0)) return;
    const r = calibFromKnownSize(imgW, imgH, cols, rows);
    state.calib = r.calib;
    state.skew = r.skew;
    render();
  };
  const onN = () => { state.n = Math.max(1, Math.round(Number(nIn.value) || 3)); state.clicks = []; render(); };
  const onTabKnown = () => { state.mode = 'known'; state.clicks = []; render(); };
  const onTabTwo = () => { state.mode = 'two-click'; state.clicks = []; render(); };
  const onDrift = () => { state.drift = !state.drift; render(); };
  const onConfirmClick = () => {
    if (!state.calib) return;
    const r = finalizeCalibration(state.calib, imgW, imgH);
    if (!r.ok) { render(); return; }
    onConfirm?.({ calib: r.calib, cols: r.cols, rows: r.rows });
  };
  const onCancelClick = () => onCancel?.();

  const bindings = [
    [view, 'click', onViewClick], [view, 'pointermove', onViewMove], [panel, 'keydown', onKey],
    [applyKnown, 'click', onApplyKnown], [nIn, 'change', onN], [tabKnown, 'click', onTabKnown],
    [tabTwo, 'click', onTabTwo], [driftBtn, 'click', onDrift], [confirmBtn, 'click', onConfirmClick],
    [cancelBtn, 'click', onCancelClick]
  ];
  for (const [t, ev, fn] of bindings) t.addEventListener(ev, fn);
  render();
  panel.focus?.();

  return function unmount() {
    for (const [t, ev, fn] of bindings) t.removeEventListener(ev, fn);
    panel.parentNode?.removeChild(panel);
  };
}
