// M64 E2 — a minimal fake DOM for the play-view tests (Node has none).
// Elements keep children, text, dataset, attributes and properties;
// listeners are counted globally so a test can assert that unmount
// removed everything a view added; events bubble through parentNode.
// Selectors: only the attribute forms the views use — `[data-x]`,
// `[data-x="v"]` — plus a bare tag name.
import { recordingCanvas } from './mock-canvas.js';

const camel = (s) => s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function parseSelector(sel) {
  const m = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/.exec(sel.trim());
  if (m) return { attr: m[1], value: m[2] };
  return { tag: sel.trim().toUpperCase() };
}

function matches(el, sel) {
  if (el.nodeType !== 1) return false;
  const p = parseSelector(sel);
  if (p.tag) return el.tagName === p.tag;
  const v = el.getAttribute(p.attr);
  return v !== null && (p.value === undefined || v === p.value);
}

export function createFakeDom({ width = 640, height = 420 } = {}) {
  const stats = { active: 0, added: 0, removed: 0 };
  const listenerOwners = new Set();

  class Listeners {
    constructor() { this.map = new Map(); }
    add(type, fn) {
      if (!this.map.has(type)) this.map.set(type, new Set());
      const set = this.map.get(type);
      if (set.has(fn)) return;
      set.add(fn);
      stats.active++; stats.added++;
    }
    remove(type, fn) {
      const set = this.map.get(type);
      if (set && set.delete(fn)) { stats.active--; stats.removed++; }
    }
    get(type) { return [...(this.map.get(type) || [])]; }
    count() { let n = 0; for (const s of this.map.values()) n += s.size; return n; }
  }

  class Node {
    constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    }
    insertBefore(c, ref) {
      if (!ref) return this.appendChild(c);
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = this.childNodes.indexOf(ref);
      c.parentNode = this;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
      return c;
    }
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    }
    remove() { this.parentNode?.removeChild(this); }
    get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
    set textContent(v) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = v === '' || v == null ? [] : [new Text(this.ownerDocument, String(v))];
    }
  }

  class Text extends Node {
    constructor(doc, data) { super(doc); this.nodeType = 3; this.data = data; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
  }

  class Element extends Node {
    constructor(doc, tag) {
      super(doc);
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.attrs = new Map();
      this.dataset = new Proxy({}, {
        set: (t, k, v) => { t[k] = String(v); this.attrs.set(`data-${kebab(String(k))}`, String(v)); return true; }
      });
      this.style = {};
      this.hidden = false;
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.files = null;
      this._listeners = new Listeners();
      listenerOwners.add(this);
      if (this.tagName === 'CANVAS') {
        this._rc = recordingCanvas({ width: 0, height: 0 });
        this.width = 0;
        this.height = 0;
      }
    }
    get className() { return this.attrs.get('class') || ''; }
    set className(v) { this.attrs.set('class', String(v)); }
    get clientWidth() { return this.tagName === 'CANVAS' ? width : 0; }
    get clientHeight() { return this.tagName === 'CANVAS' ? height : 0; }
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
      if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
    }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    addEventListener(type, fn) { this._listeners.add(type, fn); }
    removeEventListener(type, fn) { this._listeners.remove(type, fn); }
    listenerCount() { return this._listeners.count(); }
    closest(sel) {
      let n = this;
      while (n && n.nodeType === 1) { if (matches(n, sel)) return n; n = n.parentNode; }
      return null;
    }
    querySelector(sel) {
      for (const c of this.children) {
        if (matches(c, sel)) return c;
        const hit = c.querySelector(sel);
        if (hit) return hit;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    getContext() { return this._rc ? this._rc.ctx : null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    setPointerCapture() {}
    releasePointerCapture() {}
    focus() {}
    click() { return fire(this, 'click'); }
  }

  const win = {
    _listeners: new Listeners(),
    addEventListener(type, fn) { this._listeners.add(type, fn); },
    removeEventListener(type, fn) { this._listeners.remove(type, fn); },
    devicePixelRatio: 1
  };
  const doc = {
    defaultView: win,
    createElement: (tag) => new Element(doc, tag),
    createTextNode: (t) => new Text(doc, t),
    _listeners: new Listeners(),
    addEventListener(type, fn) { this._listeners.add(type, fn); },
    removeEventListener(type, fn) { this._listeners.remove(type, fn); }
  };

  /** Dispatch a bubbling event at `target`. */
  function fire(target, type, props = {}) {
    const ev = {
      type, target, currentTarget: null, defaultPrevented: false, _stop: false,
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0, key: '',
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this._stop = true; },
      ...props
    };
    let n = target;
    while (n && !ev._stop) {
      ev.currentTarget = n;
      for (const fn of n._listeners?.get(type) || []) fn(ev);
      n = n.parentNode;
    }
    return ev;
  }

  /** Every element under `root` (inclusive) whose text includes `text`. */
  function findAll(root, pred) {
    const out = [];
    const walk = (n) => { if (n.nodeType === 1) { if (pred(n)) out.push(n); n.children.forEach(walk); } };
    walk(root);
    return out;
  }
  const byText = (root, text, tag = null) => findAll(root, n => (!tag || n.tagName === tag.toUpperCase()) && n.textContent.includes(text));
  const byAction = (root, action) => findAll(root, n => n.dataset?.action === action);

  return {
    doc, win, stats, fire, findAll, byText, byAction,
    root() { return doc.createElement('div'); },
    /** Listeners still registered anywhere (elements, document, window). */
    activeListeners() { return stats.active; },
    docListeners() { return doc._listeners.count() + win._listeners.count(); }
  };
}
