// M64 E5 — recording 2D canvas for renderer tests (Node has no canvas).
// Every method call is recorded as [name, ...args]; property writes are
// recorded as ['set:<name>', value] and read back. Unknown methods are
// accepted, so renderer changes do not need mock updates.

/**
 * @param {{width?: number, height?: number}} [size]
 * @returns {{canvas: object, ctx: object, calls: any[][], count: (name: string) => number, reset: () => void}}
 */
export function recordingCanvas({ width = 0, height = 0 } = {}) {
  const calls = [];
  const props = { globalAlpha: 1, filter: 'none' };
  let transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const special = {
    getTransform: () => ({ ...transform }),
    setTransform: (a, b, c, d, e, f) => { calls.push(['setTransform', a, b, c, d, e, f]); transform = { a, b, c, d, e, f }; },
    createRadialGradient: (...a) => { calls.push(['createRadialGradient', ...a]); return { addColorStop() {} }; },
    createLinearGradient: (...a) => { calls.push(['createLinearGradient', ...a]); return { addColorStop() {} }; },
    getImageData: (x, y, w, h) => {
      calls.push(['getImageData', x, y, w, h]);
      return { data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h };
    },
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    measureText: (t) => ({ width: String(t).length * 6 })
  };
  const ctx = new Proxy({}, {
    get(_t, k) {
      if (k === 'calls') return calls;
      if (k in special) return special[k];
      if (k in props) return props[k];
      if (typeof k === 'symbol') return undefined;
      return (...a) => { calls.push([k, ...a]); };
    },
    set(_t, k, v) { props[k] = v; calls.push([`set:${String(k)}`, v]); return true; }
  });
  const canvas = { width, height, style: {}, getContext: () => ctx };
  return {
    canvas,
    ctx,
    calls,
    count: (name) => calls.filter(c => c[0] === name).length,
    reset: () => { calls.length = 0; }
  };
}

/** Recursively freeze a JSON-ish value. */
export function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}
