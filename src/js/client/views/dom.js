/**
 * M64 C9 — tiny DOM helpers for the play views. No framework, CSP-safe:
 * every string goes through `textContent` or a property, never
 * `innerHTML`, and every listener is registered through a scope so a
 * view's unmount removes exactly what it added. Listeners live on the
 * view's own root (delegated by `data-action`), never on `document`.
 */

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'hidden', 'type', 'name', 'placeholder', 'title', 'min', 'max', 'step', 'selected', 'multiple', 'rows', 'cols', 'accept', 'htmlFor', 'tabIndex', 'width', 'height']);

/**
 * Create an element.
 * @param {Document} doc
 * @param {string} tag
 * @param {object} [props] — `class`, `text`, `dataset`, `style` (object), `attrs`, or DOM properties
 * @param {Array<Node|string|null|false>|Node|string} [children]
 * @returns {HTMLElement}
 */
export function h(doc, tag, props = {}, children = []) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) { if (dv != null) el.dataset[dk] = String(dv); }
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'attrs') for (const [ak, av] of Object.entries(v)) { if (av != null) el.setAttribute(ak, String(av)); }
    else if (PROP_KEYS.has(k)) el[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(doc, el, children);
  return el;
}

/**
 * Append children (strings become text nodes; null/false are skipped).
 * @param {Document} doc
 * @param {HTMLElement} el
 * @param {Array<Node|string|null|false>|Node|string} children
 * @returns {HTMLElement}
 */
export function append(doc, el, children) {
  for (const c of [].concat(children ?? [])) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? doc.createTextNode(String(c)) : c);
  }
  return el;
}

/**
 * Remove every child.
 * @param {HTMLElement} el
 * @returns {HTMLElement}
 */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * Replace an element's children.
 * @param {Document} doc
 * @param {HTMLElement} el
 * @param {Array<Node|string|null|false>} children
 * @returns {HTMLElement}
 */
export function replace(doc, el, children) {
  clear(el);
  return append(doc, el, children);
}

/**
 * A listener / teardown scope. `on` registers a listener and remembers
 * how to remove it; `add` keeps any other teardown (store subscriptions,
 * camera / brush detach); `dispose` runs them all, last first.
 * @returns {{on: (target: EventTarget, type: string, fn: Function, opts?: object) => void,
 *            add: (off: () => void) => void, dispose: () => void, readonly size: number}}
 */
export function createScope() {
  const offs = [];
  return {
    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      offs.push(() => target.removeEventListener(type, fn, opts));
    },
    add(off) { if (typeof off === 'function') offs.push(off); },
    dispose() {
      while (offs.length) {
        const off = offs.pop();
        try { off(); } catch { /* keep tearing down */ }
      }
    },
    get size() { return offs.length; }
  };
}

/**
 * One delegated listener on `root`: events from a `[data-action]` element
 * call `handlers[action](el, event)`.
 * @param {ReturnType<typeof createScope>} scope
 * @param {HTMLElement} root
 * @param {string} type — 'click', 'change', 'input', 'keydown', …
 * @param {Record<string, (el: HTMLElement, e: Event) => void>} handlers
 */
export function delegate(scope, root, type, handlers) {
  scope.on(root, type, (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el) return;
    const fn = handlers[el.dataset.action];
    if (fn) fn(el, e);
  });
}

/**
 * Run `fn` and route a rejection to `onError` (intents that fail show a
 * message; they never throw into the event loop).
 * @param {() => Promise<unknown>|unknown} fn
 * @param {(err: Error) => void} onError
 * @returns {Promise<unknown>}
 */
export function attempt(fn, onError) {
  try {
    return Promise.resolve(fn()).catch((err) => { onError(err); return null; });
  } catch (err) {
    onError(err);
    return Promise.resolve(null);
  }
}

/**
 * <select> with options [{value, label}] (or strings).
 * @param {Document} doc
 * @param {object} props
 * @param {Array<string|{value: string, label: string}>} options
 * @param {string|null} [selected]
 * @returns {HTMLSelectElement}
 */
export function select(doc, props, options, selected = null) {
  const sel = h(doc, 'select', props);
  for (const o of options) {
    const value = typeof o === 'string' ? o : o.value;
    const label = typeof o === 'string' ? o : o.label;
    const opt = h(doc, 'option', { value, text: label });
    if (selected != null && String(selected) === String(value)) opt.selected = true;
    sel.appendChild(opt);
  }
  const first = options.length ? (typeof options[0] === 'string' ? options[0] : options[0].value) : '';
  sel.value = selected != null && options.some(o => String(typeof o === 'string' ? o : o.value) === String(selected)) ? String(selected) : String(first);
  return sel;
}

/**
 * Keep a camera's viewport in step with a canvas's CSS box (ResizeObserver
 * on the canvas itself; nothing global). Returns the teardown.
 * @param {HTMLCanvasElement} canvas
 * @param {{viewW: number, viewH: number, dpr?: number}} camera
 * @param {() => void} onResize
 * @returns {() => void}
 */
export function observeCanvasSize(canvas, camera, onResize) {
  const RO = canvas.ownerDocument?.defaultView?.ResizeObserver;
  if (typeof RO !== 'function') return () => {};
  const ro = new RO(() => {
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w || !hgt || (w === camera.viewW && hgt === camera.viewH)) return;
    camera.viewW = w;
    camera.viewH = hgt;
    camera.dpr = canvas.ownerDocument.defaultView.devicePixelRatio || 1;
    onResize();
  });
  ro.observe(canvas);
  return () => ro.disconnect();
}
