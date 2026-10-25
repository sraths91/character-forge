// Campaign authoring HTTP API (M65 B22). The campaign key (256-bit bearer,
// shown once, sha256 stored) travels in `Authorization: Bearer`; a room's
// DM token, where a route also touches a room, in `X-Room-Token`. A wrong
// or missing key is 401 for every campaign route.
//
//   POST   /api/campaigns                         {name, settings?}       → 201 {campaignId, campaignKey}
//   POST   /api/campaigns/import                  export document          → 201 {campaignId, campaignKey, counts}
//   GET    /api/campaigns/:cid                    → {campaign, nodes, templates, assets, validation}
//   PATCH  /api/campaigns/:cid                    {name?, settings?, archived?} → {campaign}
//   DELETE /api/campaigns/:cid                    → {ok}
//   GET    /api/campaigns/:cid/validate           → {validation}
//   GET    /api/campaigns/:cid/nodes              → {nodes}
//   POST   /api/campaigns/:cid/nodes              node v1 (id optional)   → 201 {node, validation}
//   PUT    /api/campaigns/:cid/nodes/:nodeId      node v1                  → {node, validation}
//   DELETE /api/campaigns/:cid/nodes/:nodeId      → {ok, validation}
//   PUT    /api/campaigns/:cid/graph              {nodes: [node v1]}       → {nodes, validation}
//   GET    /api/campaigns/:cid/templates          → {templates}
//   POST   /api/campaigns/:cid/templates          {name, setup}            → 201 {template}
//   POST   /api/campaigns/:cid/templates/from-room  (X-Room-Token: DM) {name, setup} → 201 {template}
//   GET    /api/campaigns/:cid/templates/:tid     → {template}
//   PUT    /api/campaigns/:cid/templates/:tid     {name?, setup?}          → {template}
//   DELETE /api/campaigns/:cid/templates/:tid     → {ok}
//   POST   /api/campaigns/:cid/templates/:tid/instantiate  (X-Room-Token: DM) → {setup}  (for that room)
//   PUT    /api/campaigns/:cid/assets[?kind=map|token][&filename=x.png]  raw image → 201 {asset} (200 when known)
//   GET    /api/campaigns/:cid/assets             → {assets}
//   DELETE /api/campaigns/:cid/assets/:aid        → {ok}   (409 while a template uses it)
//   GET    /api/campaigns/:cid/export[?assets=0]  → export document (attachment)
//   GET    /api/campaign-assets/<cid>/<sha256>.<ext>  immutable static file
//   GET    /api/licenses                          → {srd: {attribution}}
//
// Graph rule on every node write: the prospective graph goes through
// H21's validateCampaignGraph. Hard errors (dangling edge, unknown kind,
// bad payload, duplicate id) are 422 {code: 'INVALID_GRAPH', errors};
// authoring-time findings (unreachable node, no start yet) come back as
// `validation.warnings` with `ready: false` and block only "Start run".

import express from 'express';

import { bearerToken, generateToken, hashToken, newId } from '../rooms/tokens.js';
import { RoomError as ApiError } from '../rooms/service.js';
import { SRD_ATTRIBUTION } from '../lib/licensing.js';
import { createCampaignStore } from './store.js';
import { createCampaignAssets, publicAsset, CAMPAIGN_ASSET_QUOTA } from './assets.js';
import { checkGraph, checkSettings, DEFAULT_CAMPAIGN_SETTINGS } from './graph.js';
import { portableSetup, setupForRoom } from './setup.js';
import { exportCampaign, importCampaign } from './export.js';

/** Authoring caps per campaign. */
export const CAMPAIGN_LIMITS = Object.freeze({ maxNodes: 200, maxTemplates: 100, maxImportBytes: 64 * 1024 * 1024 });
/** The one path the app's 2 MB JSON parser skips (it parses its own, larger body). */
export const CAMPAIGN_IMPORT_PATH = '/api/campaigns/import';

const NAME_MAX = 80;

/**
 * Mount the campaign routes.
 * @param {import('express').Express} app
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.conn
 * @param {{authenticate: (token: string|null) => object|null}} o.rooms  room service (X-Room-Token)
 * @param {string|null} o.dataDir
 * @param {(name: string) => import('express').RequestHandler} o.limiter
 * @param {object} [o.assetQuota]
 * @param {object} [o.statfs]
 * @param {() => number} [o.now]
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 */
export function mountCampaignRoutes(app, { conn, rooms, dataDir, limiter, assetQuota = CAMPAIGN_ASSET_QUOTA, statfs, now = Date.now, log = () => {} }) {
  const store = createCampaignStore(conn, { now });
  const assets = createCampaignAssets({ conn, store, dataDir, quota: assetQuota, now, ...(statfs ? { statfs } : {}) });
  const ctx = { store, assets };

  const wrap = (fn) => (req, res, next) => {
    try { fn(req, res); } catch (err) { next(err); }
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  /** The campaign the bearer key owns, which must be :cid. */
  function owned(req) {
    const c = store.byKey(bearerToken(req));
    if (!c || c.id !== req.params.cid) throw new ApiError(401, 'UNAUTHENTICATED', 'The campaign key for this campaign is required');
    return c;
  }
  const requireKey = (req, _res, next) => {
    try { req.campaign = owned(req); next(); } catch (err) { next(err); }
  };
  /** The DM of the room named by X-Room-Token. */
  function roomDm(req) {
    const h = req.get('x-room-token');
    const a = typeof h === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(h) ? rooms.authenticate(h) : null;
    if (!a) throw new ApiError(401, 'UNAUTHENTICATED', 'X-Room-Token must be the room\'s DM token');
    if (a.role !== 'dm') throw new ApiError(403, 'E_FORBIDDEN', 'Only the room\'s DM can do that');
    return a;
  }
  function campaignName(v) {
    if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > NAME_MAX) throw new ApiError(400, 'BAD_NAME', `name is a 1-${NAME_MAX} character string`);
    return v.trim();
  }
  function settingsOrThrow(v) {
    const s = checkSettings(v);
    if (!s.ok) throw new ApiError(422, 'INVALID_SETTINGS', `settings${s.errors[0].path ? `.${s.errors[0].path}` : ''}: ${s.errors[0].message}`);
    return v;
  }
  const publicCampaign = (c) => ({ id: c.id, name: c.name, ruleset: c.ruleset, settings: c.settings, createdAt: c.createdAt, updatedAt: c.updatedAt, archivedAt: c.archivedAt });
  const publicTemplate = (t) => ({ id: t.id, name: t.name, setup: t.setup, setupV: t.setupV, createdAt: t.createdAt, updatedAt: t.updatedAt });

  /** A node v1 from a request body (only node v1 keys; the validator rejects bad values). */
  function nodeFrom(b, id) {
    const n = { id, kind: b.kind, title: typeof b.title === 'string' ? b.title.trim() : b.title, payload: b.payload ?? {}, next: b.next ?? [] };
    if (b.ord !== undefined) n.ord = b.ord;
    if (b.start !== undefined && b.start !== false) n.start = b.start;   // node v1: `start` is literal true or absent
    for (const k of Object.keys(b)) if (!['id', 'kind', 'title', 'ord', 'start', 'payload', 'next'].includes(k)) n[k] = b[k];   // the validator names unknown keys
    return n;
  }
  /** Validate the prospective graph; 422 with the errors when it has hard errors. */
  function graphOr422(res, nodes) {
    if (nodes.length > CAMPAIGN_LIMITS.maxNodes) throw new ApiError(409, 'QUOTA', `A campaign holds at most ${CAMPAIGN_LIMITS.maxNodes} nodes`);
    const v = checkGraph(nodes);
    if (!v.ok) {
      res.status(422).json({ error: `The campaign graph is invalid: ${v.errors[0].path} ${v.errors[0].message}`, code: 'INVALID_GRAPH', errors: v.errors, warnings: v.warnings });
      return null;
    }
    return v;
  }
  /** Replace or add `node` in the list; a new start node unflags the old one. */
  function withNode(list, node) {
    const out = list.map(n => (n.id === node.id ? node : (node.start === true && n.start ? (({ start: _s, ...rest }) => rest)(n) : n)));
    if (!list.some(n => n.id === node.id)) out.push(node);
    return out;
  }

  // ------------------------------------------------------------- campaigns

  app.post('/api/campaigns', limiter('campaignCreate'), wrap((req, res) => {
    const b = body(req);
    const name = campaignName(b.name);
    const settings = settingsOrThrow(b.settings ?? { ...DEFAULT_CAMPAIGN_SETTINGS });
    const campaignId = newId('c_');
    const campaignKey = generateToken();
    store.insert({ id: campaignId, name, keyHash: hashToken(campaignKey), settings });
    log('info', 'campaigns: created', { campaignId });
    res.status(201).json({ campaignId, campaignKey });
  }));

  app.post(CAMPAIGN_IMPORT_PATH, limiter('campaignCreate'), express.json({ limit: CAMPAIGN_LIMITS.maxImportBytes }), (req, res, next) => {
    try {
      const campaignId = newId('c_');
      const campaignKey = generateToken();
      const counts = importCampaign(ctx, req.body, { id: campaignId, keyHash: hashToken(campaignKey), ...CAMPAIGN_LIMITS });
      log('info', 'campaigns: imported', { campaignId, nodes: counts.nodes, templates: counts.templates, assets: counts.assets });
      res.status(201).json({ campaignId, campaignKey, counts: { nodes: counts.nodes, templates: counts.templates, assets: counts.assets } });
    } catch (err) {
      if (err.errors) return res.status(422).json({ error: err.message, code: err.code, errors: err.errors });
      next(err);
    }
  });

  app.get('/api/campaigns/:cid', requireKey, wrap((req, res) => {
    const id = req.campaign.id;
    const nodes = store.listNodes(id);
    res.json({
      campaign: publicCampaign(req.campaign), nodes,
      templates: store.listTemplates(id).map(publicTemplate),
      assets: store.listAssets(id).map(publicAsset),
      validation: checkGraph(nodes)
    });
  }));

  app.patch('/api/campaigns/:cid', requireKey, wrap((req, res) => {
    const b = body(req);
    const c = req.campaign;
    const name = b.name === undefined ? c.name : campaignName(b.name);
    const settings = b.settings === undefined ? c.settings : settingsOrThrow(b.settings);
    if (b.archived !== undefined && typeof b.archived !== 'boolean') throw new ApiError(400, 'BAD_REQUEST', 'archived is a boolean');
    const archivedAt = b.archived === undefined ? c.archivedAt : (b.archived ? (c.archivedAt ?? now()) : null);
    store.update(c.id, { name, settings, archivedAt });
    res.json({ campaign: publicCampaign(store.get(c.id)) });
  }));

  app.delete('/api/campaigns/:cid', requireKey, wrap((req, res) => {
    store.remove(req.campaign.id);
    assets.removeCampaignFiles(req.campaign.id);
    log('info', 'campaigns: deleted', { campaignId: req.campaign.id });
    res.json({ ok: true });
  }));

  app.get('/api/campaigns/:cid/validate', requireKey, wrap((req, res) => {
    res.json({ validation: checkGraph(store.listNodes(req.campaign.id)) });
  }));

  // ----------------------------------------------------------------- nodes

  app.get('/api/campaigns/:cid/nodes', requireKey, wrap((req, res) => {
    res.json({ nodes: store.listNodes(req.campaign.id) });
  }));

  app.post('/api/campaigns/:cid/nodes', requireKey, wrap((req, res) => {
    const cid = req.campaign.id;
    const b = body(req);
    const id = b.id === undefined ? newId('n_') : b.id;
    const list = store.listNodes(cid);
    if (list.some(n => n.id === id)) throw new ApiError(409, 'NODE_EXISTS', `Node ${id} already exists; PUT it to change it`);
    const node = nodeFrom(b, id);
    if (node.ord === undefined) node.ord = list.reduce((m, n) => Math.max(m, n.ord + 1), 0);
    const v = graphOr422(res, withNode(list, node));
    if (!v) return;
    store.tx(() => {
      if (node.start === true) store.clearStart(cid);
      store.putNode(cid, node, node.ord);
      store.touch(cid);
    })();
    res.status(201).json({ node: store.getNode(cid, id), validation: v });
  }));

  app.put('/api/campaigns/:cid/nodes/:nodeId', requireKey, wrap((req, res) => {
    const cid = req.campaign.id;
    const b = body(req);
    if (b.id !== undefined && b.id !== req.params.nodeId) throw new ApiError(400, 'BAD_REQUEST', 'The body id must match the path');
    const list = store.listNodes(cid);
    const old = list.find(n => n.id === req.params.nodeId);
    if (!old) throw new ApiError(404, 'NOT_FOUND', 'No such node');
    const node = nodeFrom(b, old.id);
    if (node.ord === undefined) node.ord = old.ord;
    const v = graphOr422(res, withNode(list, node));
    if (!v) return;
    store.tx(() => {
      if (node.start === true) store.clearStart(cid);
      store.putNode(cid, node, node.ord);
      store.touch(cid);
    })();
    res.json({ node: store.getNode(cid, old.id), validation: v });
  }));

  app.delete('/api/campaigns/:cid/nodes/:nodeId', requireKey, wrap((req, res) => {
    const cid = req.campaign.id;
    const list = store.listNodes(cid);
    if (!list.some(n => n.id === req.params.nodeId)) throw new ApiError(404, 'NOT_FOUND', 'No such node');
    const v = graphOr422(res, list.filter(n => n.id !== req.params.nodeId));
    if (!v) return;
    store.tx(() => { store.deleteNode(cid, req.params.nodeId); store.touch(cid); })();
    res.json({ ok: true, validation: v });
  }));

  app.put('/api/campaigns/:cid/graph', requireKey, wrap((req, res) => {
    const cid = req.campaign.id;
    const raw = body(req).nodes;
    if (!Array.isArray(raw)) throw new ApiError(400, 'BAD_REQUEST', 'nodes is an array of node v1');
    const nodes = raw.map((n, i) => {
      const b = n && typeof n === 'object' && !Array.isArray(n) ? n : {};
      const node = nodeFrom(b, b.id);
      if (node.ord === undefined) node.ord = i;
      return node;
    });
    const v = graphOr422(res, nodes);
    if (!v) return;
    store.tx(() => { store.replaceNodes(cid, nodes); store.touch(cid); })();
    res.json({ nodes: store.listNodes(cid), validation: v });
  }));

  // ------------------------------------------------------------- templates

  const templateName = (v) => {
    if (typeof v !== 'string' || v.trim().length < 1 || v.trim().length > NAME_MAX) throw new ApiError(400, 'BAD_NAME', `name is a 1-${NAME_MAX} character string`);
    return v.trim();
  };
  function createTemplate(req, res, roomId) {
    const cid = req.campaign.id;
    const b = body(req);
    const name = templateName(b.name);
    if (store.countTemplates(cid) >= CAMPAIGN_LIMITS.maxTemplates) throw new ApiError(409, 'QUOTA', `A campaign holds at most ${CAMPAIGN_LIMITS.maxTemplates} templates`);
    const setup = portableSetup(b.setup, { campaignId: cid, roomId, store, assets });
    const id = newId('tpl_');
    store.insertTemplate({ id, campaignId: cid, name, setup });
    store.touch(cid);
    res.status(201).json({ template: publicTemplate(store.getTemplate(cid, id)) });
  }
  const template = (req) => {
    const t = store.getTemplate(req.campaign.id, req.params.tid);
    if (!t) throw new ApiError(404, 'NOT_FOUND', 'No such template');
    return t;
  };

  app.get('/api/campaigns/:cid/templates', requireKey, wrap((req, res) => {
    res.json({ templates: store.listTemplates(req.campaign.id).map(publicTemplate) });
  }));
  app.post('/api/campaigns/:cid/templates', requireKey, wrap((req, res) => createTemplate(req, res, null)));
  app.post('/api/campaigns/:cid/templates/from-room', requireKey, wrap((req, res) => createTemplate(req, res, roomDm(req).roomId)));
  app.get('/api/campaigns/:cid/templates/:tid', requireKey, wrap((req, res) => {
    res.json({ template: publicTemplate(template(req)) });
  }));
  app.put('/api/campaigns/:cid/templates/:tid', requireKey, wrap((req, res) => {
    const t = template(req);
    const b = body(req);
    const name = b.name === undefined ? t.name : templateName(b.name);
    const setup = b.setup === undefined ? t.setup : portableSetup(b.setup, { campaignId: req.campaign.id, store, assets });
    store.updateTemplate({ id: t.id, campaignId: req.campaign.id, name, setup, setupV: t.setupV });
    res.json({ template: publicTemplate(store.getTemplate(req.campaign.id, t.id)) });
  }));
  app.delete('/api/campaigns/:cid/templates/:tid', requireKey, wrap((req, res) => {
    store.deleteTemplate(req.campaign.id, template(req).id);
    res.json({ ok: true });
  }));
  app.post('/api/campaigns/:cid/templates/:tid/instantiate', requireKey, wrap((req, res) => {
    const t = template(req);
    const dm = roomDm(req);
    res.json({ setup: setupForRoom(t.setup, { campaignId: req.campaign.id, roomId: dm.roomId, assets }) });
  }));

  // ---------------------------------------------------------------- assets

  const rawBody = express.raw({ type: () => true, limit: assetQuota.maxBytes });
  app.put('/api/campaigns/:cid/assets', requireKey, rawBody, wrap((req, res) => {
    const kind = req.query.kind === undefined ? 'map' : req.query.kind;
    const { asset, created } = assets.storeAsset(req.campaign.id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), {
      kind, declaredType: req.get('content-type'), filename: typeof req.query.filename === 'string' ? req.query.filename : ''
    });
    res.status(created ? 201 : 200).json({ asset: publicAsset(asset) });
  }));
  app.get('/api/campaigns/:cid/assets', requireKey, wrap((req, res) => {
    res.json({ assets: store.listAssets(req.campaign.id).map(publicAsset) });
  }));
  app.delete('/api/campaigns/:cid/assets/:aid', requireKey, wrap((req, res) => {
    const a = store.getAsset(req.campaign.id, req.params.aid);
    if (!a) throw new ApiError(404, 'NOT_FOUND', 'No such asset');
    if (store.templatesUsingAsset(req.campaign.id, a.id) > 0) throw new ApiError(409, 'IN_USE', 'A template uses this asset; change the template first');
    store.deleteAsset(req.campaign.id, a.id);
    assets.removeFile(a);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- export

  app.get('/api/campaigns/:cid/export', requireKey, wrap((req, res) => {
    const doc = exportCampaign(ctx, req.campaign.id, { withAssets: req.query.assets !== '0', now });
    const file = `${req.campaign.name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'campaign'}.campaign.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.json(doc);
  }));

  app.get('/api/licenses', (_req, res) => {
    res.json({ srd: { name: 'System Reference Document 5.1', license: 'CC-BY-4.0', attribution: SRD_ATTRIBUTION } });
  });

  if (assets.root) {
    app.use('/api/campaign-assets', express.static(assets.root, {
      index: false, dotfiles: 'deny', fallthrough: false, redirect: false, cacheControl: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'");
      }
    }));
  }
  return { store, assets };
}
