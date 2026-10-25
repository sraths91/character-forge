// Campaign JSON export / import (M65 B22).
//
// Document v1:
//   {format: 'character-forge/campaign', v: 1, exportedAt, attribution,
//    campaign: {name, ruleset, settings},
//    nodes: [node v1], templates: [{id, name, setupV, setup}],
//    assets: [{id, kind, mime, sha256, width, height, grid, data?: base64}]}
//
// Licensing: `attribution` is the SRD 5.1 CC-BY-4.0 text, and anything
// that came from D&D Beyond loses its prose (lib/licensing.js
// stripDdbProse) on the way out and on the way in. Import re-validates
// everything (graph, setups, every asset's bytes and sha256) and gives
// templates and assets new ids, rewriting every reference.

import { createHash } from 'node:crypto';

import { SRD_ATTRIBUTION, stripDdbProse } from '../lib/licensing.js';
import { newId } from '../rooms/tokens.js';
import { RoomError as ApiError } from '../rooms/service.js';
import { checkGraph, checkSettings } from './graph.js';
import { assertSetup } from './setup.js';

export const EXPORT_FORMAT = 'character-forge/campaign';
export const EXPORT_VERSION = 1;
/** Ids an export may cross-reference; rewritten on import. */
const REF_KEYS = new Set(['templateId', 'assetId', 'tokenAssetId']);

/**
 * The export document for one campaign.
 * @param {object} ctx
 * @param {ReturnType<import('./store.js').createCampaignStore>} ctx.store
 * @param {ReturnType<import('./assets.js').createCampaignAssets>} ctx.assets
 * @param {string} campaignId
 * @param {{withAssets?: boolean, now?: () => number}} [opts]
 */
export function exportCampaign({ store, assets }, campaignId, { withAssets = true, now = Date.now } = {}) {
  const c = store.get(campaignId);
  return {
    format: EXPORT_FORMAT,
    v: EXPORT_VERSION,
    exportedAt: new Date(now()).toISOString(),
    attribution: SRD_ATTRIBUTION,
    campaign: { name: c.name, ruleset: c.ruleset, settings: c.settings },
    nodes: stripDdbProse(store.listNodes(campaignId)),
    templates: store.listTemplates(campaignId).map(t => ({ id: t.id, name: t.name, setupV: t.setupV, setup: stripDdbProse(t.setup) })),
    assets: store.listAssets(campaignId).map(a => ({
      id: a.id, kind: a.kind, mime: a.mime, sha256: a.sha256, width: a.width, height: a.height, grid: a.grid ?? null,
      ...(withAssets ? { data: assets.readBytes(a).toString('base64') } : {})
    }))
  };
}

/** Deep copy with every REF_KEYS string value mapped through `ids`. */
function remapRefs(v, ids) {
  if (Array.isArray(v)) return v.map(x => remapRefs(x, ids));
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = REF_KEYS.has(k) && typeof x === 'string' && ids.has(x) ? ids.get(x) : remapRefs(x, ids);
  return out;
}

const fail = (code, message) => { throw new ApiError(422, code, message); };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Create a new campaign from an export document.
 * @param {object} ctx
 * @param {ReturnType<import('./store.js').createCampaignStore>} ctx.store
 * @param {ReturnType<import('./assets.js').createCampaignAssets>} ctx.assets
 * @param {unknown} doc
 * @param {{id: string, keyHash: string, maxNodes: number, maxTemplates: number}} target
 * @returns {{campaignId: string, nodes: number, templates: number, assets: number}}
 */
export function importCampaign({ store, assets }, doc, { id, keyHash, maxNodes, maxTemplates }) {
  if (!isObj(doc) || doc.format !== EXPORT_FORMAT) fail('BAD_EXPORT', `not a ${EXPORT_FORMAT} document`);
  if (doc.v !== EXPORT_VERSION) fail('BAD_EXPORT', `unsupported export version ${doc.v}`);
  const c = isObj(doc.campaign) ? doc.campaign : fail('BAD_EXPORT', 'campaign is required');
  if (typeof c.name !== 'string' || c.name.trim().length < 1 || c.name.length > 80) fail('BAD_EXPORT', 'campaign.name is a 1-80 character string');
  if (c.ruleset !== undefined && c.ruleset !== 'srd-5.1') fail('BAD_EXPORT', 'only the srd-5.1 ruleset is supported');
  const settings = c.settings ?? {};
  const s = checkSettings(settings);
  if (!s.ok) fail('INVALID_SETTINGS', `settings${s.errors[0].path ? `.${s.errors[0].path}` : ''}: ${s.errors[0].message}`);
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : fail('BAD_EXPORT', 'nodes is an array');
  const templates = Array.isArray(doc.templates ?? []) ? (doc.templates ?? []) : fail('BAD_EXPORT', 'templates is an array');
  const assetList = Array.isArray(doc.assets ?? []) ? (doc.assets ?? []) : fail('BAD_EXPORT', 'assets is an array');
  if (nodes.length > maxNodes) fail('QUOTA', `at most ${maxNodes} nodes`);
  if (templates.length > maxTemplates) fail('QUOTA', `at most ${maxTemplates} templates`);

  // New ids for templates and assets; nodes keep theirs (they are per campaign).
  const ids = new Map();
  for (const t of templates) {
    if (!isObj(t) || typeof t.id !== 'string' || typeof t.name !== 'string') fail('BAD_EXPORT', 'a template is {id, name, setup}');
    ids.set(t.id, newId('tpl_'));
  }
  const decoded = assetList.map((a) => {
    if (!isObj(a) || typeof a.id !== 'string') fail('BAD_EXPORT', 'an asset is {id, kind, sha256, data}');
    if (typeof a.data !== 'string') fail('ASSET_DATA_MISSING', `asset ${a.id} has no data; export with assets included`);
    const bytes = Buffer.from(a.data, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== a.sha256) fail('ASSET_CORRUPT', `asset ${a.id}: the data does not match its sha256`);
    return { a, bytes };
  });

  const cleanNodes = remapRefs(stripDdbProse(nodes), ids);
  const graph = checkGraph(cleanNodes);
  if (!graph.ok) {
    const err = new ApiError(422, 'INVALID_GRAPH', 'The campaign graph is invalid');
    err.errors = graph.errors;
    throw err;
  }

  store.insert({ id, name: c.name.trim(), keyHash, settings });
  try {
    for (const { a, bytes } of decoded) {
      const { asset } = assets.storeAsset(id, bytes, { kind: a.kind ?? 'map', grid: isObj(a.grid) ? a.grid : null });
      ids.set(a.id, asset.id);
    }
    store.tx(() => {
      for (const t of templates) {
        const setup = remapRefs(stripDdbProse(t.setup), ids);
        assertSetup(setup);
        const refs = [setup.map?.assetId, ...(Array.isArray(setup.monsters) ? setup.monsters.map(m => m?.tokenAssetId) : [])];
        for (const ref of refs) {
          if (ref !== undefined && !store.getAsset(id, ref)) fail('ASSET_NOT_FOUND', `template ${t.id} names asset ${ref}, which the export does not carry`);
        }
        store.insertTemplate({ id: ids.get(t.id), campaignId: id, name: t.name.slice(0, 80) || 'Template', setup, setupV: Number.isInteger(t.setupV) && t.setupV >= 1 ? t.setupV : 1 });
      }
      // References resolved now that asset ids are known.
      store.replaceNodes(id, remapRefs(cleanNodes, ids));
    })();
  } catch (err) {
    store.remove(id);
    assets.removeCampaignFiles(id);
    throw err;
  }
  return { campaignId: id, nodes: nodes.length, templates: templates.length, assets: decoded.length };
}
