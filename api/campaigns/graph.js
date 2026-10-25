// Campaign graph validation for the authoring API (M65 B22), over E6's
// shared validators (H21, src/js/shared/campaign.js):
//   validateCampaignGraph(nodes)  → {ok, errors: [{path, code, message}]}
//   validateCampaignSettings(s)   → same shape
// Node v1: {id, kind, title, ord?, start?: true, payload, next: [{to, label?, when?}]}.
//
// TODO(architect, M65 H21): campaign.js is on E6's branch, not yet on
// main. Until it merges this module imports it behind a guard and falls
// back to the structural subset below (kinds, ids, edges, one start,
// reachability) with the same error codes. Delete FALLBACK and the guard
// once H21 is on main; the routes do not change.

import { VALIDATION_CODES as C } from '../../src/js/shared/check.js';

let shared = null;
try {
  shared = await import('../../src/js/shared/campaign.js');
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !String(err.message).includes('campaign.js')) throw err;
}

/** True when E6's shared validators (H21) are loaded. */
export const SHARED_VALIDATORS = !!shared?.validateCampaignGraph;

/** Node kinds (campaign_nodes.kind). */
export const NODE_KINDS = Object.freeze(shared?.NODE_KINDS ? [...shared.NODE_KINDS] : ['encounter', 'rest', 'loot', 'shop', 'story']);

const NODE_KEYS = new Set(['id', 'kind', 'title', 'ord', 'start', 'payload', 'next']);
const EDGE_KEYS = new Set(['to', 'label', 'when']);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The structural subset of H21, used only while campaign.js is absent. */
function fallbackGraph(input) {
  const nodes = Array.isArray(input) ? input : input?.nodes;
  const errors = [];
  const add = (path, code, message) => errors.push({ path, code, message });
  if (!Array.isArray(nodes)) {
    add('', C.TYPE, 'nodes must be an array');
    return { ok: false, errors };
  }
  const ids = new Map();
  nodes.forEach((n, i) => {
    const p = `[${i}]`;
    if (!isObj(n)) return add(p, C.TYPE, 'a node is an object');
    for (const k of Object.keys(n)) if (!NODE_KEYS.has(k)) add(`${p}.${k}`, C.UNKNOWN_FIELD, `unknown field "${k}"`);
    if (typeof n.id !== 'string' || n.id.length < 1 || n.id.length > 64) add(`${p}.id`, C.REQUIRED, 'id is a 1-64 character string');
    else if (ids.has(n.id)) add(`${p}.id`, C.DUPLICATE, `duplicate node id "${n.id}"`);
    else ids.set(n.id, i);
    if (!NODE_KINDS.includes(n.kind)) add(`${p}.kind`, C.ENUM, `kind must be one of ${NODE_KINDS.join(', ')}`);
    if (typeof n.title !== 'string' || n.title.length < 1 || n.title.length > 200) add(`${p}.title`, C.REQUIRED, 'title is a 1-200 character string');
    if (n.ord !== undefined && !(Number.isInteger(n.ord) && n.ord >= 0)) add(`${p}.ord`, C.RANGE, 'ord is an integer >= 0');
    if (n.start !== undefined && n.start !== true) add(`${p}.start`, C.TYPE, 'start is true or absent');
    if (!isObj(n.payload)) add(`${p}.payload`, C.TYPE, 'payload is an object');
    if (!Array.isArray(n.next)) add(`${p}.next`, C.TYPE, 'next is an array');
    else n.next.forEach((e, j) => {
      if (!isObj(e)) return add(`${p}.next[${j}]`, C.TYPE, 'an edge is an object');
      for (const k of Object.keys(e)) if (!EDGE_KEYS.has(k)) add(`${p}.next[${j}].${k}`, C.UNKNOWN_FIELD, `unknown field "${k}"`);
      if (typeof e.to !== 'string') add(`${p}.next[${j}].to`, C.REQUIRED, 'to is a node id');
    });
  });
  nodes.forEach((n, i) => {
    if (!isObj(n) || !Array.isArray(n.next)) return;
    n.next.forEach((e, j) => {
      if (isObj(e) && typeof e.to === 'string' && !ids.has(e.to)) add(`[${i}].next[${j}].to`, C.REF, `edge to unknown node "${e.to}"`);
    });
  });
  if (errors.length || nodes.length === 0) return { ok: errors.length === 0, errors };
  const starts = nodes.filter(n => n.start === true);
  starts.slice(1).forEach(n => add(`[${ids.get(n.id)}].start`, C.DUPLICATE, 'more than one start node'));
  let start = starts[0]?.id;
  if (!start) {
    const incoming = new Set(nodes.flatMap(n => n.next.map(e => e.to)));
    const roots = nodes.filter(n => !incoming.has(n.id));
    if (roots.length === 1) start = roots[0].id;
    else if (roots.length > 1) add('', C.DUPLICATE, 'several root nodes: flag the start with start: true');
    else add('', C.REQUIRED, 'no start node: flag one with start: true');
  }
  if (start) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      for (const e of nodes[ids.get(queue.shift())].next) if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
    nodes.forEach((n, i) => { if (!seen.has(n.id)) add(`[${i}]`, 'unreachable', `node "${n.id}" is unreachable from the start`); });
  }
  return { ok: errors.length === 0, errors };
}

/** Root-path codes from validateCampaignGraph that describe an unfinished graph (H21, per E6). */
const ROOT_WARNINGS = new Set([C.REQUIRED, C.DUPLICATE, C.RANGE]);   // no start / ambiguous start / no nodes

/**
 * Graph-shape findings that are normal while a DM is still authoring
 * (a node not yet linked, no start yet, an empty graph). They block
 * "Start run", not a save. Two start flags (`[i].start` duplicate) stay errors.
 * @param {{path: string, code: string}} e
 */
function isAuthoringWarning(e) {
  return e.code === 'unreachable' || (e.path === '' && ROOT_WARNINGS.has(e.code));
}

/**
 * Validate a node list for saving.
 * @param {object[]} nodes  node v1 objects
 * @returns {{ok: boolean, ready: boolean, errors: object[], warnings: object[], shared: boolean}}
 *   ok: savable (no hard errors: dangling edge, unknown kind, bad payload, duplicate id ...);
 *   ready: also a playable graph (one start, everything reachable).
 */
export function checkGraph(nodes) {
  const res = shared?.validateCampaignGraph ? shared.validateCampaignGraph(nodes) : fallbackGraph(nodes);
  const all = Array.isArray(res?.errors) ? res.errors : [];
  const errors = all.filter(e => !isAuthoringWarning(e));
  const warnings = all.filter(isAuthoringWarning);
  return { ok: errors.length === 0, ready: all.length === 0 && nodes.length > 0, errors, warnings, shared: SHARED_VALIDATORS };
}

/**
 * Validate campaign settings (H21 `validateCampaignSettings` when present;
 * otherwise any plain object of at most 4 KB).
 * @param {unknown} settings
 * @returns {{ok: boolean, errors: object[]}}
 */
export function checkSettings(settings) {
  if (shared?.validateCampaignSettings) return shared.validateCampaignSettings(settings);
  if (!isObj(settings)) return { ok: false, errors: [{ path: '', code: C.TYPE, message: 'settings is an object' }] };
  if (JSON.stringify(settings).length > 4096) return { ok: false, errors: [{ path: '', code: C.RANGE, message: 'settings is at most 4 KB' }] };
  return { ok: true, errors: [] };
}

/** H21's default campaign settings, or {} until it lands. */
export const DEFAULT_CAMPAIGN_SETTINGS = Object.freeze({ ...(shared?.DEFAULT_CAMPAIGN_SETTINGS || {}) });
