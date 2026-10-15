/**
 * M64 E5 / M4 — viewport camera for the battle canvas.
 *
 * World space: one grid cell = WORLD_CELL_PX (64, the LPC frame) world
 * units, origin at the top-left of cell (0,0). Screen space: CSS pixels
 * relative to the canvas's top-left. The camera is `{x, y, zoom}` where
 * (x, y) is the world point at the screen's top-left:
 *
 *   screen = (world - camera.xy) * zoom
 *   device = screen * pixelRatio,   pixelRatio = min(devicePixelRatio, 2)
 *
 * The canvas backing store is the viewport size × pixelRatio (never the
 * whole map), capped at MAX_CANVAS_PIXELS so iOS Safari never refuses it.
 * Zoom and pan are a ctx transform, which replaces the old CSS
 * `--bf-zoom` scaling of an oversized canvas.
 *
 * Every helper here is pure (returns a new camera) except
 * `sizeCanvasToViewport` (writes canvas.width/height when they change)
 * and `attachCameraControls` (DOM listeners that mutate the camera
 * object in place and notify).
 */

/** World units per grid cell (the LPC frame size). */
export const WORLD_CELL_PX = 64;
/** iOS Safari's per-canvas area limit (4096²). */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Device-pixel-ratio cap; beyond 2× costs fill rate for no visible gain on pixel art. */
export const MAX_PIXEL_RATIO = 2;

const DEFAULT_MIN_ZOOM = 0.25;
const DEFAULT_MAX_ZOOM = 4;

/**
 * @typedef {object} Camera
 * @property {number} x        — world x at the screen's left edge
 * @property {number} y        — world y at the screen's top edge
 * @property {number} zoom     — screen px per world unit
 * @property {number} minZoom
 * @property {number} maxZoom
 * @property {number} viewW    — viewport width in CSS px (0 = size the canvas to the world)
 * @property {number} viewH    — viewport height in CSS px
 * @property {number} dpr      — window.devicePixelRatio at last resize
 */

/**
 * @param {Partial<Camera>} [init]
 * @returns {Camera}
 */
export function createCamera({
  x = 0, y = 0, zoom = 1, minZoom = DEFAULT_MIN_ZOOM, maxZoom = DEFAULT_MAX_ZOOM,
  viewW = 0, viewH = 0, dpr = 1
} = {}) {
  const lo = Math.min(minZoom, maxZoom);
  const hi = Math.max(minZoom, maxZoom);
  return { x, y, zoom: clamp(zoom, lo, hi), minZoom: lo, maxZoom: hi, viewW, viewH, dpr };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * World → screen (CSS px relative to the canvas).
 * @param {Camera} camera
 * @param {number} wx
 * @param {number} wy
 * @returns {{x: number, y: number}}
 */
export function worldToScreen(camera, wx, wy) {
  return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
}

/**
 * Screen (CSS px relative to the canvas) → world.
 * @param {Camera} camera
 * @param {number} sx
 * @param {number} sy
 * @returns {{x: number, y: number}}
 */
export function screenToWorld(camera, sx, sy) {
  return { x: sx / camera.zoom + camera.x, y: sy / camera.zoom + camera.y };
}

/**
 * Grid cell under a pointer. The result may lie outside the grid; the
 * caller bounds-checks against cols/rows.
 * @param {number} clientX — event.clientX
 * @param {number} clientY — event.clientY
 * @param {Camera} camera
 * @param {number} [cellPx] — world units per cell
 * @param {{left: number, top: number}} [rect] — canvas.getBoundingClientRect(); defaults to the origin
 * @returns {{col: number, row: number}}
 */
export function pickCell(clientX, clientY, camera, cellPx = WORLD_CELL_PX, rect = null) {
  const left = rect?.left || 0;
  const top = rect?.top || 0;
  const w = screenToWorld(camera, clientX - left, clientY - top);
  return { col: Math.floor(w.x / cellPx), row: Math.floor(w.y / cellPx) };
}

/**
 * Zoom by `factor` keeping the world point under (sx, sy) fixed.
 * @param {Camera} camera
 * @param {number} sx — screen x (CSS px)
 * @param {number} sy
 * @param {number} factor — >1 zooms in
 * @returns {Camera}
 */
export function zoomAt(camera, sx, sy, factor) {
  const zoom = clamp(camera.zoom * factor, camera.minZoom, camera.maxZoom);
  const anchor = screenToWorld(camera, sx, sy);
  return { ...camera, zoom, x: anchor.x - sx / zoom, y: anchor.y - sy / zoom };
}

/**
 * Pan by a screen-space delta (drag right ⇒ the map moves right).
 * @param {Camera} camera
 * @param {number} dx — CSS px
 * @param {number} dy
 * @returns {Camera}
 */
export function panBy(camera, dx, dy) {
  return { ...camera, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom };
}

/**
 * Keep the map reachable: zoom inside [minZoom, maxZoom]; a world smaller
 * than the viewport is centred; otherwise a map edge may come no further
 * than the viewport centre.
 * @param {Camera} camera
 * @param {number} worldW — cols * cellPx
 * @param {number} worldH — rows * cellPx
 * @returns {Camera}
 */
export function clampCamera(camera, worldW, worldH) {
  const zoom = clamp(camera.zoom, camera.minZoom, camera.maxZoom);
  const out = { ...camera, zoom };
  if (!(camera.viewW > 0) || !(camera.viewH > 0)) return out;
  const visW = camera.viewW / zoom;
  const visH = camera.viewH / zoom;
  out.x = visW >= worldW ? (worldW - visW) / 2 : clamp(camera.x, -visW / 2, worldW - visW / 2);
  out.y = visH >= worldH ? (worldH - visH) / 2 : clamp(camera.y, -visH / 2, worldH - visH / 2);
  return out;
}

/**
 * Zoom and centre so the whole grid fits the viewport.
 * @param {Camera} camera — needs viewW/viewH
 * @param {number} cols
 * @param {number} rows
 * @param {number} [cellPx]
 * @param {{padding?: number}} [opts] — CSS px kept free on each side
 * @returns {Camera}
 */
export function fitToGrid(camera, cols, rows, cellPx = WORLD_CELL_PX, { padding = 0 } = {}) {
  const worldW = cols * cellPx;
  const worldH = rows * cellPx;
  const availW = Math.max(1, (camera.viewW || worldW) - 2 * padding);
  const availH = Math.max(1, (camera.viewH || worldH) - 2 * padding);
  const zoom = clamp(Math.min(availW / worldW, availH / worldH), camera.minZoom, camera.maxZoom);
  const viewW = camera.viewW || worldW * zoom;
  const viewH = camera.viewH || worldH * zoom;
  return { ...camera, zoom, x: worldW / 2 - viewW / zoom / 2, y: worldH / 2 - viewH / zoom / 2 };
}

/**
 * Backing-store pixel ratio for a CSS-size canvas: devicePixelRatio
 * capped at 2 and at the iOS area limit.
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} [dpr]
 * @returns {number}
 */
export function canvasPixelRatio(cssW, cssH, dpr = 1) {
  const area = Math.max(1, cssW * cssH);
  const areaCap = Math.sqrt(MAX_CANVAS_PIXELS / area);
  return Math.max(0.01, Math.min(Number(dpr) || 1, MAX_PIXEL_RATIO, areaCap));
}

/**
 * Size a canvas backing store to cssW × cssH × pixelRatio. Writes
 * width/height only when they change (writing them clears and
 * reallocates the buffer, so doing it every frame is wasteful).
 * @param {{width: number, height: number}} canvas
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} [dpr]
 * @returns {{pixelRatio: number, width: number, height: number, resized: boolean}}
 */
export function sizeCanvasToViewport(canvas, cssW, cssH, dpr = 1) {
  const pixelRatio = canvasPixelRatio(cssW, cssH, dpr);
  const width = Math.max(1, Math.round(cssW * pixelRatio));
  const height = Math.max(1, Math.round(cssH * pixelRatio));
  let resized = false;
  if (canvas.width !== width) { canvas.width = width; resized = true; }
  if (canvas.height !== height) { canvas.height = height; resized = true; }
  return { pixelRatio, width, height, resized };
}

/**
 * The ctx.setTransform(a, b, c, d, e, f) arguments that map world units
 * to device pixels.
 * @param {Camera} camera
 * @param {number} [pixelRatio]
 * @returns {[number, number, number, number, number, number]}
 */
export function cameraTransform(camera, pixelRatio = 1) {
  const s = camera.zoom * pixelRatio;
  return [s, 0, 0, s, -camera.x * s, -camera.y * s];
}

/**
 * Inclusive cell range visible through the camera (for culling).
 * @param {Camera} camera
 * @param {number} cols
 * @param {number} rows
 * @param {number} [cellPx]
 * @returns {{c0: number, c1: number, r0: number, r1: number}}
 */
export function visibleCellRange(camera, cols, rows, cellPx = WORLD_CELL_PX) {
  if (!(camera.viewW > 0) || !(camera.viewH > 0)) return { c0: 0, c1: cols - 1, r0: 0, r1: rows - 1 };
  const tl = screenToWorld(camera, 0, 0);
  const br = screenToWorld(camera, camera.viewW, camera.viewH);
  return {
    c0: clamp(Math.floor(tl.x / cellPx), 0, cols - 1),
    c1: clamp(Math.floor(br.x / cellPx), 0, cols - 1),
    r0: clamp(Math.floor(tl.y / cellPx), 0, rows - 1),
    r1: clamp(Math.floor(br.y / cellPx), 0, rows - 1)
  };
}

/**
 * Wheel zoom (about the cursor), drag pan and two-finger pinch/pan on a
 * canvas. Mutates `camera` in place (Object.assign with the pure helpers'
 * result) and calls `onChange(camera)` after each change.
 *
 * Mouse drags pan only when `shouldPan(event)` says so — by default the
 * middle or right button, or the primary button with Alt or Space held —
 * so a plain left drag stays free for token moves. Touch: two fingers
 * pinch and pan; a single finger pans only if `shouldPan` allows it.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Camera} camera
 * @param {(camera: Camera) => void} onChange
 * @param {{shouldPan?: (e: PointerEvent) => boolean,
 *          worldSize?: () => {w: number, h: number},
 *          wheelSpeed?: number}} [opts] — `worldSize` enables clamping
 * @returns {() => void} detach
 */
export function attachCameraControls(canvas, camera, onChange, opts = {}) {
  const win = canvas.ownerDocument?.defaultView || globalThis;
  const wheelSpeed = opts.wheelSpeed ?? 0.0015;
  const pointers = new Map();
  let panId = null;
  let spaceHeld = false;
  let pinch = null;

  const defaultShouldPan = (e) =>
    e.pointerType !== 'touch' && (e.button === 1 || e.button === 2 || (e.button === 0 && (e.altKey || spaceHeld)));
  const shouldPan = opts.shouldPan || defaultShouldPan;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const commit = (next) => {
    const ws = opts.worldSize?.();
    Object.assign(camera, ws ? clampCamera(next, ws.w, ws.h) : next);
    onChange?.(camera);
  };

  const onWheel = (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const p = local(e);
    commit(zoomAt(camera, p.x, p.y, Math.exp(-e.deltaY * unit * wheelSpeed)));
  };

  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };

  const onDown = (e) => {
    const p = local(e);
    if (e.pointerType === 'touch') {
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        pinch = pinchState();
        panId = null;
        e.preventDefault();
      } else if (pointers.size === 1 && shouldPan(e)) {
        panId = e.pointerId;
      }
      return;
    }
    if (!shouldPan(e)) return;
    e.preventDefault();
    pointers.set(e.pointerId, p);
    panId = e.pointerId;
    canvas.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const now = pinchState();
      let next = zoomAt(camera, now.cx, now.cy, now.dist / pinch.dist);
      next = panBy(next, now.cx - pinch.cx, now.cy - pinch.cy);
      pinch = now;
      commit(next);
      return;
    }
    if (panId === e.pointerId) commit(panBy(camera, p.x - prev.x, p.y - prev.y));
  };

  const onUp = (e) => {
    pointers.delete(e.pointerId);
    if (panId === e.pointerId) panId = null;
    if (pointers.size < 2) pinch = null;
    canvas.releasePointerCapture?.(e.pointerId);
  };

  const onContextMenu = (e) => { e.preventDefault(); };
  const onKeyDown = (e) => { if (e.code === 'Space') spaceHeld = true; };
  const onKeyUp = (e) => { if (e.code === 'Space') spaceHeld = false; };

  const prevTouchAction = canvas.style?.touchAction;
  if (canvas.style) canvas.style.touchAction = 'none';
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', onContextMenu);
  win.addEventListener?.('keydown', onKeyDown);
  win.addEventListener?.('keyup', onKeyUp);

  return function detach() {
    canvas.removeEventListener('wheel', onWheel, { passive: false });
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('contextmenu', onContextMenu);
    win.removeEventListener?.('keydown', onKeyDown);
    win.removeEventListener?.('keyup', onKeyUp);
    if (canvas.style) canvas.style.touchAction = prevTouchAction || '';
    pointers.clear();
  };
}
