/**
 * M64 — Tiny validation kit shared by the three wire/state contracts
 * (`encounter-state.js`, `events.js`, `protocol.js`).
 *
 * Constraints (the contracts are imported by Vite in the browser AND by
 * Node on the server):
 *   - no dependencies, no Node built-ins, no DOM, no `import.meta`;
 *   - pure functions; nothing here throws on bad input — every problem is
 *     reported as a named error so callers can log, reject, or assert.
 *
 * A spec is plain data built with the helpers below (`str()`, `int()`,
 * `shape({...})`, …). `checkSpec(collector, value, spec, path)` walks a
 * value against a spec and records `{path, code, message}` errors.
 */

/**
 * @typedef {object} ValidationError
 * @property {string} path    — dotted path to the offending value ('' = root)
 * @property {string} code    — one of VALIDATION_CODES
 * @property {string} message — human-readable detail
 */

/**
 * @typedef {object} ValidationResult
 * @property {boolean} ok
 * @property {ValidationError[]} errors
 */

/** Stable error codes. Tests and callers match on these, not on messages. */
export const VALIDATION_CODES = Object.freeze({
  REQUIRED: 'required',
  TYPE: 'type',
  ENUM: 'enum',
  RANGE: 'range',
  UNKNOWN_FIELD: 'unknown_field',
  FORBIDDEN_FIELD: 'forbidden_field',
  REF: 'ref',
  DUPLICATE: 'duplicate',
  ORDER: 'order',
  VERSION: 'version',
  NOT_JSON_SAFE: 'not_json_safe',
  // M65 H21 (additive): a campaign node no path from the start node reaches.
  UNREACHABLE: 'unreachable'
});

const C = VALIDATION_CODES;

/**
 * Create an error collector.
 * @returns {{errors: ValidationError[], add: (path: string, code: string, message: string) => void, result: () => ValidationResult}}
 */
export function createCollector() {
  const errors = [];
  return {
    errors,
    add(path, code, message) { errors.push({ path, code, message }); },
    result() { return { ok: errors.length === 0, errors }; }
  };
}

/**
 * Join a parent path and a key into a dotted path.
 * @param {string} base
 * @param {string|number} key
 * @returns {string}
 */
export function joinPath(base, key) {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : String(key);
}

/**
 * True for `{}`-literal style objects (prototype Object.prototype or null).
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------
// Spec builders. Each returns a frozen plain object describing a value.
// ---------------------------------------------------------------------

/** @typedef {object} Spec */

/**
 * Non-empty string (or any string when `allowEmpty`).
 * @param {{maxLength?: number, pattern?: RegExp, allowEmpty?: boolean}} [opts]
 * @returns {Spec}
 */
export function str(opts = {}) {
  return Object.freeze({ kind: 'str', ...opts });
}

/**
 * Integer within [min, max].
 * @param {number} [min]
 * @param {number} [max]
 * @returns {Spec}
 */
export function int(min = -Infinity, max = Infinity) {
  return Object.freeze({ kind: 'int', min, max });
}

/**
 * Finite number within [min, max]; `exclusiveMin` makes the lower bound strict.
 * @param {number} [min]
 * @param {number} [max]
 * @param {{exclusiveMin?: boolean}} [opts]
 * @returns {Spec}
 */
export function num(min = -Infinity, max = Infinity, opts = {}) {
  return Object.freeze({ kind: 'num', min, max, ...opts });
}

/** @returns {Spec} boolean */
export function bool() {
  return Object.freeze({ kind: 'bool' });
}

/**
 * One of a fixed list of primitive values.
 * @param {readonly (string|number|boolean)[]} values
 * @returns {Spec}
 */
export function oneOf(values) {
  return Object.freeze({ kind: 'enum', values });
}

/**
 * Array whose items all match `item`.
 * @param {Spec} item
 * @param {{min?: number, max?: number, unique?: boolean}} [opts]
 * @returns {Spec}
 */
export function arrayOf(item, opts = {}) {
  return Object.freeze({ kind: 'array', item, ...opts });
}

/**
 * Plain object with named fields. `strict` (default) rejects unknown keys.
 * @param {Record<string, Spec>} fields
 * @param {{strict?: boolean}} [opts]
 * @returns {Spec}
 */
export function shape(fields, opts = {}) {
  return Object.freeze({ kind: 'shape', fields, strict: opts.strict !== false });
}

/**
 * Plain object used as a dictionary: every value matches `value`, and
 * every key matches `keyPattern` when given.
 * @param {Spec} value
 * @param {{keyPattern?: RegExp}} [opts]
 * @returns {Spec}
 */
export function mapOf(value, opts = {}) {
  return Object.freeze({ kind: 'map', value, ...opts });
}

/**
 * Accept the value if ANY of the specs accepts it.
 * @param {...Spec} specs
 * @returns {Spec}
 */
export function union(...specs) {
  return Object.freeze({ kind: 'union', specs });
}

/** @returns {Spec} any JSON-safe value (checked separately by checkJsonSafe) */
export function anyJson() {
  return Object.freeze({ kind: 'json' });
}

/**
 * Mark a spec optional (key may be absent / undefined).
 * @param {Spec} spec
 * @returns {Spec}
 */
export function optional(spec) {
  return Object.freeze({ ...spec, optional: true });
}

/**
 * Mark a spec nullable (value may be null).
 * @param {Spec} spec
 * @returns {Spec}
 */
export function nullable(spec) {
  return Object.freeze({ ...spec, nullable: true });
}

// ---------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Check `value` against `spec`, recording errors under `path`.
 * @param {ReturnType<typeof createCollector>} c
 * @param {unknown} value
 * @param {Spec} spec
 * @param {string} path
 */
export function checkSpec(c, value, spec, path) {
  if (value === undefined) {
    if (!spec.optional) c.add(path, C.REQUIRED, 'is required');
    return;
  }
  if (value === null) {
    if (!spec.nullable && spec.kind !== 'json') c.add(path, C.TYPE, 'must not be null');
    return;
  }
  switch (spec.kind) {
    case 'str': {
      if (typeof value !== 'string') { c.add(path, C.TYPE, `expected string, got ${describe(value)}`); return; }
      if (!spec.allowEmpty && value.length === 0) { c.add(path, C.RANGE, 'must be a non-empty string'); return; }
      if (spec.maxLength != null && value.length > spec.maxLength) {
        c.add(path, C.RANGE, `must be at most ${spec.maxLength} characters`);
        return;
      }
      if (spec.pattern && !spec.pattern.test(value)) c.add(path, C.RANGE, `must match ${spec.pattern}`);
      return;
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        c.add(path, C.TYPE, `expected integer, got ${describe(value)}`);
        return;
      }
      if (value < spec.min || value > spec.max) c.add(path, C.RANGE, `must be in [${spec.min}, ${spec.max}]`);
      return;
    }
    case 'num': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        c.add(path, C.TYPE, `expected finite number, got ${describe(value)}`);
        return;
      }
      const lowOk = spec.exclusiveMin ? value > spec.min : value >= spec.min;
      if (!lowOk || value > spec.max) c.add(path, C.RANGE, `must be in ${spec.exclusiveMin ? '(' : '['}${spec.min}, ${spec.max}]`);
      return;
    }
    case 'bool': {
      if (typeof value !== 'boolean') c.add(path, C.TYPE, `expected boolean, got ${describe(value)}`);
      return;
    }
    case 'enum': {
      if (!spec.values.includes(value)) c.add(path, C.ENUM, `must be one of ${spec.values.join(', ')}`);
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) { c.add(path, C.TYPE, `expected array, got ${describe(value)}`); return; }
      if (spec.min != null && value.length < spec.min) c.add(path, C.RANGE, `must have at least ${spec.min} items`);
      if (spec.max != null && value.length > spec.max) c.add(path, C.RANGE, `must have at most ${spec.max} items`);
      value.forEach((item, i) => checkSpec(c, item, spec.item, joinPath(path, i)));
      if (spec.unique) {
        const seen = new Set();
        value.forEach((item, i) => {
          if (seen.has(item)) c.add(joinPath(path, i), C.DUPLICATE, `duplicate value ${JSON.stringify(item)}`);
          seen.add(item);
        });
      }
      return;
    }
    case 'shape': {
      if (!isPlainObject(value)) { c.add(path, C.TYPE, `expected object, got ${describe(value)}`); return; }
      for (const [key, fieldSpec] of Object.entries(spec.fields)) {
        checkSpec(c, value[key], fieldSpec, joinPath(path, key));
      }
      if (spec.strict) {
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) {
            c.add(joinPath(path, key), C.UNKNOWN_FIELD, 'is not part of the contract');
          }
        }
      }
      return;
    }
    case 'map': {
      if (!isPlainObject(value)) { c.add(path, C.TYPE, `expected object, got ${describe(value)}`); return; }
      for (const [key, v] of Object.entries(value)) {
        if (spec.keyPattern && !spec.keyPattern.test(key)) {
          c.add(joinPath(path, key), C.RANGE, `key must match ${spec.keyPattern}`);
        }
        checkSpec(c, v, spec.value, joinPath(path, key));
      }
      return;
    }
    case 'union': {
      for (const s of spec.specs) {
        const scratch = createCollector();
        checkSpec(scratch, value, s, path);
        if (scratch.errors.length === 0) return;
      }
      c.add(path, C.TYPE, 'matches none of the allowed forms');
      return;
    }
    case 'json':
      return;
    default:
      c.add(path, C.TYPE, `unknown spec kind ${spec.kind}`);
  }
}

/**
 * Validate a value against a spec and return a ValidationResult.
 * @param {unknown} value
 * @param {Spec} spec
 * @returns {ValidationResult}
 */
export function validateSpec(value, spec) {
  const c = createCollector();
  checkSpec(c, value, spec, '');
  return c.result();
}

/**
 * Record an error for anything that would not survive
 * `JSON.parse(JSON.stringify(v))` unchanged: undefined values, functions,
 * symbols, bigints, non-finite numbers, class instances (Date, Map, …),
 * sparse arrays, and cycles.
 * @param {ReturnType<typeof createCollector>} c
 * @param {unknown} value
 * @param {string} [path]
 */
export function checkJsonSafe(c, value, path = '') {
  const stack = new Set();
  const walk = (v, p) => {
    if (v === null) return;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return;
    if (t === 'number') {
      if (!Number.isFinite(v)) c.add(p, C.NOT_JSON_SAFE, `non-finite number ${v}`);
      return;
    }
    if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
      c.add(p, C.NOT_JSON_SAFE, `${t} does not survive JSON`);
      return;
    }
    if (stack.has(v)) { c.add(p, C.NOT_JSON_SAFE, 'cycle'); return; }
    if (Array.isArray(v)) {
      stack.add(v);
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) c.add(joinPath(p, i), C.NOT_JSON_SAFE, 'sparse array hole');
        else walk(v[i], joinPath(p, i));
      }
      stack.delete(v);
      return;
    }
    if (!isPlainObject(v)) {
      c.add(p, C.NOT_JSON_SAFE, `instance of ${v?.constructor?.name || 'unknown'} is not plain JSON`);
      return;
    }
    stack.add(v);
    for (const [k, child] of Object.entries(v)) walk(child, joinPath(p, k));
    stack.delete(v);
  };
  walk(value, path);
}

/**
 * Convenience wrapper: is `value` pure JSON?
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateJsonSafe(value) {
  const c = createCollector();
  checkJsonSafe(c, value, '');
  return c.result();
}
