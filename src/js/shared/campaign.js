/**
 * M65 H21 — campaign / node contract v1.
 *
 * A campaign is a graph of nodes a party plays as a run. The DM authors
 * it over HTTP (`campaign_nodes` rows: `payload_json`, `next_json`), the
 * run freezes it into `runs.campaign_json` at start, and the run
 * controller walks it with `nextNodes`. This module is the one place the
 * node shapes are defined:
 *
 *   Node v1  { id, kind, title, ord?, start?, payload, next }
 *     kind     'encounter' | 'rest' | 'loot' | 'shop' | 'story'
 *     payload  per kind, NODE_PAYLOAD_SPECS (strict)
 *     next     [{ to, label?, when?: { outcome?, choice? } }]  (`next_json`)
 *
 *   Campaign v1  { v: 1, id, name, ruleset: 'srd-5.1', settings, nodes,
 *                  templates? }  — the frozen `runs.campaign_json` /
 *                  the JSON export
 *
 * Per-kind payloads (docs/M65-CAMPAIGN-LOOP-PLAN.md "Node kinds"):
 *   encounter  exactly one of `templateId` / `setup` (the exact
 *              `dm.encounter.setup` intent payload, protocol.js), plus
 *              `partyPlacement?` {seat '1'..'6': {col,row}}, `xpOverride?`,
 *              `loot?` {items, currency?} granted on victory
 *   rest       { type: 'short' | 'long' | 'choice' }
 *   loot       { items: [LootItem], currency?, assign: 'free' | 'dm' }
 *   shop       { stock: [{ref, qty, price?}], buyback? (default 0.5) }
 *   story      { text, choices?: [{id, label}] } — the choice picks the edge
 *
 * Edges: `when.outcome` (an events.js ENCOUNTER_OUTCOMES value) only on
 * encounter nodes; `when.choice` only on story nodes and must name one of
 * the node's `payload.choices[].id`. An edge without `when` is the
 * fallback: `nextNodes` offers it only when no conditional edge matches.
 *
 * Graph rules (`validateCampaignGraph`): unique node ids, no dangling
 * edge, exactly one start node, every node reachable from it. The start
 * node is the one flagged `start: true`; with no flag, it is the single
 * node no other node points at (so a hub you return to needs the flag).
 *
 * Imported by both Vite and Node: no DOM, no Node built-ins. Pure.
 */

import {
  createCollector, checkSpec, checkJsonSafe, joinPath, isPlainObject,
  str, int, num, bool, oneOf, arrayOf, shape, mapOf, anyJson, optional,
  VALIDATION_CODES
} from './check.js';
import { ENCOUNTER_OUTCOMES } from './events.js';
import { INTENT_PAYLOAD_SPECS } from './protocol.js';

const C = VALIDATION_CODES;

/** Contract version; `campaign.v` must equal this. */
export const CAMPAIGN_VERSION = 1;
/** Node kinds (`campaign_nodes.kind` CHECK). */
export const NODE_KINDS = Object.freeze(['encounter', 'rest', 'loot', 'shop', 'story']);
/** A rest node's `type`: the DM's fixed choice, or the party picks. */
export const REST_NODE_TYPES = Object.freeze(['short', 'long', 'choice']);
/** Who hands out a loot node's items. */
export const LOOT_ASSIGN_MODES = Object.freeze(['free', 'dm']);
/** Where an item comes from (`run_items.origin` CHECK). */
export const ITEM_ORIGINS = Object.freeze(['ddb', 'open5e', 'dm']);
/** Rulesets a campaign may name. */
export const RULESETS = Object.freeze(['srd-5.1']);
/** Coin denominations, smallest first. */
export const CURRENCY_KEYS = Object.freeze(['cp', 'sp', 'ep', 'gp', 'pp']);
/** Sell-back fraction when a shop node does not set `buyback`. */
export const SHOP_BUYBACK_DEFAULT = 0.5;
/** Most outgoing edges a node may carry. */
export const MAX_NODE_EDGES = 16;

/** Campaign settings (`campaigns.settings_json`) enums. */
export const XP_MODES = Object.freeze(['xp', 'milestone']);
export const HP_ON_LEVEL_MODES = Object.freeze(['average', 'roll']);
export const DEATH_MODES = Object.freeze(['standard', 'permadeath', 'lenient']);
export const LEVEL_UP_MODES = Object.freeze(['auto', 'choose', 'reconcile']);
export const XP_AWARD_MODES = Object.freeze(['auto', 'confirm']);

/** The owner-approved defaults (M65 owner questions 1–4, 2026-10-25). */
export const DEFAULT_CAMPAIGN_SETTINGS = Object.freeze({
  xpMode: 'xp',
  hpOnLevel: 'average',
  deathMode: 'standard',
  levelUpMode: 'choose',
  dawnIsLongRest: true,
  xpAward: 'auto'
});

const ID = str({ maxLength: 128 });
const POS = shape({ col: int(0), row: int(0) });
const COIN = int(0, 1e9);

/** Coin purse: every denomination optional, non-negative integers. */
export const CURRENCY_SPEC = shape(Object.fromEntries(CURRENCY_KEYS.map(k => [k, optional(COIN)])));

const LOOT_ITEM = shape({
  origin: oneOf(['open5e', 'dm']),
  ref: optional(str({ maxLength: 128 })),     // Open5e SRD key (origin 'open5e')
  name: optional(str({ maxLength: 128 })),    // display name (required for origin 'dm')
  qty: optional(int(1, 999)),                 // default 1
  data: optional(anyJson())                   // DM-authored item fields (opaque in v1)
});

const LOOT = shape({
  items: arrayOf(LOOT_ITEM, { max: 64 }),
  currency: optional(CURRENCY_SPEC)
});

const SETTINGS_SPEC = shape({
  xpMode: optional(oneOf(XP_MODES)),
  hpOnLevel: optional(oneOf(HP_ON_LEVEL_MODES)),
  deathMode: optional(oneOf(DEATH_MODES)),
  levelUpMode: optional(oneOf(LEVEL_UP_MODES)),
  dawnIsLongRest: optional(bool()),
  xpAward: optional(oneOf(XP_AWARD_MODES))
});

/** Payload spec per node kind (strict). */
export const NODE_PAYLOAD_SPECS = Object.freeze({
  encounter: shape({
    templateId: optional(ID),
    setup: optional(INTENT_PAYLOAD_SPECS['dm.encounter.setup']),
    partyPlacement: optional(mapOf(POS, { keyPattern: /^[1-6]$/ })),
    xpOverride: optional(int(0, 1e6)),
    loot: optional(LOOT)
  }),
  rest: shape({ type: oneOf(REST_NODE_TYPES) }),
  loot: shape({
    items: arrayOf(LOOT_ITEM, { max: 64 }),
    currency: optional(CURRENCY_SPEC),
    assign: oneOf(LOOT_ASSIGN_MODES)
  }),
  shop: shape({
    stock: arrayOf(shape({
      ref: str({ maxLength: 128 }),
      qty: int(0, 999),
      price: optional(CURRENCY_SPEC)   // absent = the Open5e cost (or DM-priced)
    }), { max: 128 }),
    buyback: optional(num(0, 1))
  }),
  story: shape({
    text: str({ maxLength: 20000, allowEmpty: true }),
    choices: optional(arrayOf(shape({ id: ID, label: str({ maxLength: 200 }) }), { max: MAX_NODE_EDGES }))
  })
});

const EDGE = shape({
  to: ID,
  label: optional(str({ maxLength: 128 })),
  when: optional(shape({
    outcome: optional(oneOf(ENCOUNTER_OUTCOMES)),
    choice: optional(ID)
  }))
});

const NODE = shape({
  id: ID,
  kind: oneOf(NODE_KINDS),
  title: str({ maxLength: 200 }),
  ord: optional(int(0)),
  start: optional(oneOf([true])),
  payload: anyJson(),   // checked per kind below
  next: arrayOf(EDGE, { max: MAX_NODE_EDGES })
});

const TEMPLATE = shape({
  id: ID,
  name: str({ maxLength: 128 }),
  setup: INTENT_PAYLOAD_SPECS['dm.encounter.setup']
});

const CAMPAIGN = shape({
  v: anyJson(),   // checked explicitly (VERSION code)
  id: ID,
  name: str({ maxLength: 128 }),
  ruleset: oneOf(RULESETS),
  settings: SETTINGS_SPEC,
  nodes: anyJson(),   // checked by checkGraph
  templates: optional(arrayOf(TEMPLATE, { max: 256 }))
});

/**
 * Settings with the defaults filled in for every absent key.
 * @param {object} [partial]
 * @returns {{xpMode: string, hpOnLevel: string, deathMode: string, levelUpMode: string, dawnIsLongRest: boolean, xpAward: string}}
 */
export function campaignSettings(partial = {}) {
  const out = { ...DEFAULT_CAMPAIGN_SETTINGS };
  if (isPlainObject(partial)) {
    for (const k of Object.keys(DEFAULT_CAMPAIGN_SETTINGS)) if (partial[k] !== undefined) out[k] = partial[k];
  }
  return out;
}

/**
 * Validate `campaigns.settings_json` (every key optional; unknown keys rejected).
 * @param {unknown} settings
 * @returns {import('./check.js').ValidationResult}
 */
export function validateCampaignSettings(settings) {
  const c = createCollector();
  checkJsonSafe(c, settings, '');
  checkSpec(c, settings, SETTINGS_SPEC, '');
  return c.result();
}

function checkNode(c, node, base) {
  checkSpec(c, node, NODE, base);
  if (!isPlainObject(node)) return;
  const at = (k) => joinPath(base, k);
  const payloadSpec = NODE_PAYLOAD_SPECS[node.kind];
  if (payloadSpec) checkSpec(c, node.payload, payloadSpec, at('payload'));
  const p = isPlainObject(node.payload) ? node.payload : null;

  if (node.kind === 'encounter' && p) {
    const n = ['templateId', 'setup'].filter(k => p[k] !== undefined).length;
    if (n === 0) c.add(at('payload'), C.REQUIRED, 'an encounter node needs templateId or setup');
    if (n === 2) c.add(at('payload.setup'), C.FORBIDDEN_FIELD, 'templateId and setup are exclusive');
  }
  for (const [path, items] of [
    [at('payload.items'), p && (node.kind === 'loot' ? p.items : null)],
    [at('payload.loot.items'), p && node.kind === 'encounter' ? p.loot?.items : null]
  ]) {
    if (!Array.isArray(items)) continue;
    items.forEach((it, i) => {
      if (!isPlainObject(it)) return;
      if (it.origin === 'open5e' && !it.ref) c.add(joinPath(joinPath(path, i), 'ref'), C.REQUIRED, 'an open5e item needs its SRD ref');
      if (it.origin === 'dm' && !it.name) c.add(joinPath(joinPath(path, i), 'name'), C.REQUIRED, 'a DM item needs a name');
    });
  }
  const choiceIds = new Set();
  if (node.kind === 'story' && p && Array.isArray(p.choices)) {
    p.choices.forEach((ch, i) => {
      if (!isPlainObject(ch) || typeof ch.id !== 'string') return;
      if (choiceIds.has(ch.id)) c.add(at(`payload.choices[${i}].id`), C.DUPLICATE, `choice "${ch.id}" appears twice`);
      choiceIds.add(ch.id);
    });
  }
  (Array.isArray(node.next) ? node.next : []).forEach((e, i) => {
    if (!isPlainObject(e) || !isPlainObject(e.when)) return;
    const wp = joinPath(joinPath(at('next'), i), 'when');
    if (e.when.outcome === undefined && e.when.choice === undefined) {
      c.add(wp, C.RANGE, 'when needs an outcome or a choice (omit it for an unconditional edge)');
    }
    if (e.when.outcome !== undefined && node.kind !== 'encounter') {
      c.add(joinPath(wp, 'outcome'), C.FORBIDDEN_FIELD, 'only encounter nodes branch on an outcome');
    }
    if (e.when.choice !== undefined) {
      if (node.kind !== 'story') c.add(joinPath(wp, 'choice'), C.FORBIDDEN_FIELD, 'only story nodes branch on a choice');
      else if (!choiceIds.has(e.when.choice)) c.add(joinPath(wp, 'choice'), C.REF, `unknown choice "${e.when.choice}"`);
    }
  });
}

/**
 * Validate one node (shape, per-kind payload, edge conditions). Graph
 * rules (targets exist, reachability) need every node: validateCampaignGraph.
 * @param {unknown} node
 * @returns {import('./check.js').ValidationResult}
 */
export function validateCampaignNode(node) {
  const c = createCollector();
  checkJsonSafe(c, node, '');
  checkNode(c, node, '');
  return c.result();
}

function edgeTargets(node) {
  return (Array.isArray(node?.next) ? node.next : [])
    .filter(e => isPlainObject(e) && typeof e.to === 'string')
    .map(e => e.to);
}

/**
 * The start node's id: the one node flagged `start: true`, else the
 * single node no other node points at. Null when that is ambiguous or
 * missing.
 * @param {object[]} nodes
 * @returns {string|null}
 */
export function startNodeId(nodes) {
  const list = (Array.isArray(nodes) ? nodes : []).filter(n => isPlainObject(n) && typeof n.id === 'string');
  const flagged = list.filter(n => n.start === true);
  if (flagged.length === 1) return flagged[0].id;
  if (flagged.length > 1) return null;
  const roots = rootIds(list);
  return roots.length === 1 ? roots[0] : null;
}

/** Ids of nodes no OTHER node points at (self-loops ignored). */
function rootIds(list) {
  const pointedAt = new Set();
  for (const n of list) for (const to of edgeTargets(n)) if (to !== n.id) pointedAt.add(to);
  return list.filter(n => !pointedAt.has(n.id)).map(n => n.id);
}

function checkGraph(c, nodes, base) {
  if (!Array.isArray(nodes)) { c.add(base, C.TYPE, 'expected an array of nodes'); return; }
  if (nodes.length === 0) { c.add(base, C.RANGE, 'a campaign needs at least one node'); return; }
  const ids = new Map();
  nodes.forEach((n, i) => {
    const p = joinPath(base, i);
    checkNode(c, n, p);
    if (!isPlainObject(n) || typeof n.id !== 'string') return;
    if (ids.has(n.id)) c.add(joinPath(p, 'id'), C.DUPLICATE, `node "${n.id}" appears twice`);
    else ids.set(n.id, n);
  });
  nodes.forEach((n, i) => {
    if (!isPlainObject(n) || !Array.isArray(n.next)) return;
    n.next.forEach((e, j) => {
      if (isPlainObject(e) && typeof e.to === 'string' && !ids.has(e.to)) {
        c.add(joinPath(joinPath(joinPath(joinPath(base, i), 'next'), j), 'to'), C.REF, `edge points at unknown node "${e.to}"`);
      }
    });
  });

  const flagged = nodes.map((n, i) => [n, i]).filter(([n]) => isPlainObject(n) && n.start === true);
  if (flagged.length > 1) {
    for (const [, i] of flagged.slice(1)) c.add(joinPath(joinPath(base, i), 'start'), C.DUPLICATE, 'only one node may be the start');
    return;
  }
  const start = startNodeId(nodes);
  if (start === null) {
    const roots = rootIds([...ids.values()]);
    if (roots.length > 1) c.add(base, C.DUPLICATE, `several start candidates (${roots.join(', ')}): flag one node \`start: true\``);
    else c.add(base, C.REQUIRED, 'no start node: every node has an incoming edge; flag one node `start: true`');
    return;
  }
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift();
    for (const to of edgeTargets(ids.get(id))) {
      if (ids.has(to) && !seen.has(to)) { seen.add(to); queue.push(to); }
    }
  }
  nodes.forEach((n, i) => {
    if (isPlainObject(n) && typeof n.id === 'string' && ids.get(n.id) === n && !seen.has(n.id)) {
      c.add(joinPath(base, i), C.UNREACHABLE, `node "${n.id}" is not reachable from the start node "${start}"`);
    }
  });
}

/**
 * Validate a campaign's node list as a graph: every node valid, unique
 * ids, no dangling edges, exactly one start node, every node reachable.
 * Accepts the nodes array, or `{nodes}` (other keys ignored).
 * @param {unknown} nodes
 * @returns {import('./check.js').ValidationResult} errors pathed `[i].next[j].to` etc.
 */
export function validateCampaignGraph(nodes) {
  const list = isPlainObject(nodes) && Array.isArray(nodes.nodes) ? nodes.nodes : nodes;
  const c = createCollector();
  checkJsonSafe(c, list, '');
  checkGraph(c, list, '');
  return c.result();
}

/**
 * Validate a whole campaign v1 (`runs.campaign_json`, exports): envelope,
 * settings, the node graph, and `templateId` references when the
 * campaign carries its templates.
 * @param {unknown} campaign
 * @returns {import('./check.js').ValidationResult}
 */
export function validateCampaign(campaign) {
  const c = createCollector();
  checkJsonSafe(c, campaign, '');
  checkSpec(c, campaign, CAMPAIGN, '');
  if (!isPlainObject(campaign)) return c.result();
  if (campaign.v !== CAMPAIGN_VERSION) {
    c.add('v', C.VERSION, `expected ${CAMPAIGN_VERSION}, got ${JSON.stringify(campaign.v)}`);
  }
  checkGraph(c, campaign.nodes, 'nodes');
  if (Array.isArray(campaign.templates) && Array.isArray(campaign.nodes)) {
    const tids = new Set();
    campaign.templates.forEach((t, i) => {
      if (!isPlainObject(t) || typeof t.id !== 'string') return;
      if (tids.has(t.id)) c.add(`templates[${i}].id`, C.DUPLICATE, `template "${t.id}" appears twice`);
      tids.add(t.id);
    });
    campaign.nodes.forEach((n, i) => {
      const tid = isPlainObject(n) && n.kind === 'encounter' && isPlainObject(n.payload) ? n.payload.templateId : undefined;
      if (typeof tid === 'string' && !tids.has(tid)) c.add(`nodes[${i}].payload.templateId`, C.REF, `unknown template "${tid}"`);
    });
  }
  return c.result();
}

function whenMatches(when, { outcome, choice }) {
  if (when.outcome !== undefined && when.outcome !== outcome) return false;
  if (when.choice !== undefined && when.choice !== choice) return false;
  return true;
}

/**
 * The edges a node offers after it resolves. Conditional edges whose
 * `when` matches win; when none matches, the unconditional edges are the
 * fallback. Declared order is kept; the DM confirms one (or overrides).
 * @param {{next?: object[]}} node
 * @param {{outcome?: string, choice?: string}} [result]
 * @returns {{to: string, label?: string, when?: object}[]} copies
 */
export function nextNodes(node, result = {}) {
  const edges = (Array.isArray(node?.next) ? node.next : []).filter(e => isPlainObject(e) && typeof e.to === 'string');
  const r = isPlainObject(result) ? result : {};
  const conditional = edges.filter(e => isPlainObject(e.when) && whenMatches(e.when, r));
  const picked = conditional.length ? conditional : edges.filter(e => e.when === undefined);
  return picked.map(e => JSON.parse(JSON.stringify(e)));
}
