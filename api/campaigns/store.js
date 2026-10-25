// SQLite access for campaign authoring (M65 B22): campaigns,
// campaign_nodes, encounter_templates, campaign_assets (migration 0006).
// Every statement is prepared once, when the store is built.

import { hashToken } from '../rooms/tokens.js';

const parse = (s, dflt = null) => (s == null ? dflt : JSON.parse(s));

/**
 * A node row as node v1 (src/js/shared/campaign.js).
 * @param {object} r
 * @returns {{id: string, kind: string, title: string, ord: number, start?: true, payload: object, next: object[]}}
 */
export function nodeFromRow(r) {
  return {
    id: r.id, kind: r.kind, title: r.title, ord: r.ord,
    ...(r.is_start ? { start: true } : {}),
    payload: parse(r.payload_json, {}), next: parse(r.next_json, [])
  };
}

/**
 * @param {import('better-sqlite3').Database} conn  migrated to >= 0006
 * @param {{now?: () => number}} [opts]
 */
export function createCampaignStore(conn, { now = Date.now } = {}) {
  const q = {
    insertCampaign: conn.prepare(`INSERT INTO campaigns (id, name, owner_key_hash, ruleset, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    byKey: conn.prepare('SELECT * FROM campaigns WHERE owner_key_hash = ?'),
    byId: conn.prepare('SELECT * FROM campaigns WHERE id = ?'),
    updateCampaign: conn.prepare('UPDATE campaigns SET name = ?, settings_json = ?, archived_at = ?, updated_at = ? WHERE id = ?'),
    touch: conn.prepare('UPDATE campaigns SET updated_at = ? WHERE id = ?'),
    deleteCampaign: conn.prepare('DELETE FROM campaigns WHERE id = ?'),

    nodes: conn.prepare('SELECT * FROM campaign_nodes WHERE campaign_id = ? ORDER BY ord, id'),
    node: conn.prepare('SELECT * FROM campaign_nodes WHERE campaign_id = ? AND id = ?'),
    upsertNode: conn.prepare(`INSERT INTO campaign_nodes (campaign_id, id, ord, kind, title, is_start, payload_json, next_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id, id) DO UPDATE SET ord = excluded.ord, kind = excluded.kind, title = excluded.title,
        is_start = excluded.is_start, payload_json = excluded.payload_json, next_json = excluded.next_json, updated_at = excluded.updated_at`),
    deleteNode: conn.prepare('DELETE FROM campaign_nodes WHERE campaign_id = ? AND id = ?'),
    deleteNodes: conn.prepare('DELETE FROM campaign_nodes WHERE campaign_id = ?'),
    clearStart: conn.prepare('UPDATE campaign_nodes SET is_start = 0 WHERE campaign_id = ? AND is_start = 1'),

    templates: conn.prepare('SELECT * FROM encounter_templates WHERE campaign_id = ? ORDER BY created_at, id'),
    template: conn.prepare('SELECT * FROM encounter_templates WHERE campaign_id = ? AND id = ?'),
    insertTemplate: conn.prepare(`INSERT INTO encounter_templates (id, campaign_id, name, setup_json, setup_v, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    updateTemplate: conn.prepare('UPDATE encounter_templates SET name = ?, setup_json = ?, setup_v = ?, updated_at = ? WHERE campaign_id = ? AND id = ?'),
    deleteTemplate: conn.prepare('DELETE FROM encounter_templates WHERE campaign_id = ? AND id = ?'),
    countTemplates: conn.prepare('SELECT COUNT(*) AS n FROM encounter_templates WHERE campaign_id = ?'),
    templatesUsingAsset: conn.prepare(`SELECT COUNT(*) AS n FROM encounter_templates
      WHERE campaign_id = ? AND instr(setup_json, ?) > 0`),

    assets: conn.prepare('SELECT * FROM campaign_assets WHERE campaign_id = ? ORDER BY created_at, id'),
    asset: conn.prepare('SELECT * FROM campaign_assets WHERE campaign_id = ? AND id = ?'),
    assetBySha: conn.prepare('SELECT * FROM campaign_assets WHERE campaign_id = ? AND sha256 = ?'),
    assetUsage: conn.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM campaign_assets WHERE campaign_id = ?'),
    insertAsset: conn.prepare(`INSERT INTO campaign_assets (id, campaign_id, kind, rel_path, mime, bytes, sha256, width, height, grid_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteAsset: conn.prepare('DELETE FROM campaign_assets WHERE campaign_id = ? AND id = ?')
  };

  const campaignRow = (r) => r && ({
    id: r.id, name: r.name, ruleset: r.ruleset, ownerUserId: r.owner_user_id,
    settings: parse(r.settings_json, {}), createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at
  });
  const templateRow = (r) => r && ({
    id: r.id, name: r.name, setup: parse(r.setup_json, {}), setupV: r.setup_v, createdAt: r.created_at, updatedAt: r.updated_at
  });
  const assetRow = (r) => r && ({
    id: r.id, kind: r.kind, relPath: r.rel_path, mime: r.mime, bytes: r.bytes, sha256: r.sha256,
    width: r.width, height: r.height, grid: parse(r.grid_json), createdAt: r.created_at
  });

  /** Insert or update one node (node v1) at `ord`. */
  function putNode(campaignId, n, ord) {
    q.upsertNode.run(campaignId, n.id, ord, n.kind, n.title, n.start === true ? 1 : 0,
      JSON.stringify(n.payload ?? {}), JSON.stringify(n.next ?? []), now());
  }

  return {
    tx: (fn) => conn.transaction(fn),
    /**
     * The campaign a bearer key owns, or null.
     * @param {string|null} key
     */
    byKey: (key) => (key ? campaignRow(q.byKey.get(hashToken(key))) : null),
    get: (id) => campaignRow(q.byId.get(id)),
    insert: ({ id, name, keyHash, ruleset = 'srd-5.1', settings = {} }) =>
      q.insertCampaign.run(id, name, keyHash, ruleset, JSON.stringify(settings), now(), now()),
    update: (id, { name, settings, archivedAt }) => q.updateCampaign.run(name, JSON.stringify(settings), archivedAt ?? null, now(), id),
    touch: (id) => q.touch.run(now(), id),
    remove: (id) => q.deleteCampaign.run(id).changes > 0,

    listNodes: (campaignId) => q.nodes.all(campaignId).map(nodeFromRow),
    getNode: (campaignId, id) => { const r = q.node.get(campaignId, id); return r ? nodeFromRow(r) : null; },
    putNode,
    /** Replace the whole graph with `nodes` (ord defaults to list position). */
    replaceNodes(campaignId, nodes) {
      q.deleteNodes.run(campaignId);
      nodes.forEach((n, i) => putNode(campaignId, n, Number.isInteger(n.ord) ? n.ord : i));
    },
    clearStart: (campaignId) => q.clearStart.run(campaignId),
    deleteNode: (campaignId, id) => q.deleteNode.run(campaignId, id).changes > 0,

    listTemplates: (campaignId) => q.templates.all(campaignId).map(templateRow),
    getTemplate: (campaignId, id) => templateRow(q.template.get(campaignId, id)),
    insertTemplate: ({ id, campaignId, name, setup, setupV = 1 }) =>
      q.insertTemplate.run(id, campaignId, name, JSON.stringify(setup), setupV, now(), now()),
    updateTemplate: ({ id, campaignId, name, setup, setupV = 1 }) =>
      q.updateTemplate.run(name, JSON.stringify(setup), setupV, now(), campaignId, id).changes > 0,
    deleteTemplate: (campaignId, id) => q.deleteTemplate.run(campaignId, id).changes > 0,
    countTemplates: (campaignId) => q.countTemplates.get(campaignId).n,
    /** Templates whose setup mentions `assetId` (assets in use cannot be deleted). */
    templatesUsingAsset: (campaignId, assetId) => q.templatesUsingAsset.get(campaignId, JSON.stringify(assetId)).n,

    listAssets: (campaignId) => q.assets.all(campaignId).map(assetRow),
    getAsset: (campaignId, id) => assetRow(q.asset.get(campaignId, id)),
    getAssetBySha: (campaignId, sha) => assetRow(q.assetBySha.get(campaignId, sha)),
    assetUsage: (campaignId) => q.assetUsage.get(campaignId),
    insertAsset: (a) => q.insertAsset.run(a.id, a.campaignId, a.kind, a.relPath, a.mime, a.bytes, a.sha256, a.width, a.height,
      a.grid == null ? null : JSON.stringify(a.grid), now()),
    deleteAsset: (campaignId, id) => q.deleteAsset.run(campaignId, id).changes > 0
  };
}
