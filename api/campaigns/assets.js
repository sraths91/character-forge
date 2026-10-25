// Campaign asset files (M65 B22): maps and token images under
// `<dataDir>/campaigns/<campaignId>/<sha256>.<ext>`, with the room-map
// caps (lib/image-sniff.js checkImageUpload) and a per-campaign quota.
// Also the two copies between a room and a campaign: a room's uploaded
// map saved into a template, and a template's asset materialised into a
// room's uploaded_maps (ux_uploaded_maps_room_sha dedupes).

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

import { checkImageUpload, IMAGE_TYPES } from '../lib/image-sniff.js';
import { MAP_QUOTA } from '../rooms/maps.js';
import { newId } from '../rooms/tokens.js';
import { RoomError as ApiError } from '../rooms/service.js';

/** Per-campaign asset quota; the per-file cap is the room maps' 10 MB. */
export const CAMPAIGN_ASSET_QUOTA = Object.freeze({
  maxBytes: MAP_QUOTA.maxBytes, maxAssets: 40, maxCampaignBytes: 200 * 1024 * 1024, maxVolumeUse: MAP_QUOTA.maxVolumeUse
});
/** Asset kinds (campaign_assets.kind). */
export const ASSET_KINDS = Object.freeze(['map', 'token']);

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** The static URL of a campaign asset (rel_path 'campaigns/<cid>/<file>'). */
export const assetUrl = (a) => `/api/campaign-assets/${a.relPath.replace(/^campaigns\//, '')}`;

/** An asset as the API returns it. */
export function publicAsset(a) {
  return {
    assetId: a.id, kind: a.kind, url: assetUrl(a), mime: a.mime, width: a.width, height: a.height,
    bytes: a.bytes, sha256: a.sha256, grid: a.grid ?? null, createdAt: a.createdAt
  };
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.conn
 * @param {ReturnType<import('./store.js').createCampaignStore>} o.store
 * @param {string|null} o.dataDir
 * @param {typeof CAMPAIGN_ASSET_QUOTA} [o.quota]
 * @param {typeof MAP_QUOTA} [o.roomQuota]
 * @param {(path: string) => {blocks: number, bavail: number}} [o.statfs]
 * @param {() => number} [o.now]
 */
export function createCampaignAssets({ conn, store, dataDir, quota = CAMPAIGN_ASSET_QUOTA, roomQuota = MAP_QUOTA, statfs = statfsSync, now = Date.now }) {
  const root = dataDir ? join(dataDir, 'campaigns') : null;
  const q = {
    roomMap: conn.prepare('SELECT * FROM uploaded_maps WHERE room_id = ? AND id = ?'),
    roomMapByPath: conn.prepare('SELECT * FROM uploaded_maps WHERE room_id = ? AND rel_path = ?'),
    roomMapBySha: conn.prepare('SELECT * FROM uploaded_maps WHERE room_id = ? AND sha256 = ?'),
    roomUsage: conn.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM uploaded_maps WHERE room_id = ?'),
    roomKindCount: conn.prepare('SELECT COUNT(*) AS n FROM uploaded_maps WHERE room_id = ? AND kind = ?'),
    insertRoomMap: conn.prepare(`INSERT INTO uploaded_maps (id, room_id, rel_path, mime, bytes, sha256, width, height, grid_json, uploaded_by_participant_id, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
  };

  function requireStorage() {
    if (!root) throw new ApiError(503, 'NO_STORAGE', 'Asset storage is not configured');
  }
  function volumeCheck() {
    const fs = statfs(dataDir);
    if (fs.blocks > 0 && 1 - fs.bavail / fs.blocks > quota.maxVolumeUse) throw new ApiError(507, 'VOLUME_FULL', 'The server is low on storage');
  }
  /** Write `bytes` to `dir/name` via a temp file and an atomic rename. */
  function writeAtomic(dir, name, bytes) {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
    writeFileSync(tmp, bytes, { flag: 'wx' });
    const final = join(dir, name);
    renameSync(tmp, final);
    return final;
  }

  /**
   * Validate and store an image as a campaign asset. The same bytes twice
   * return the first row (200, `created: false`).
   * @param {string} campaignId
   * @param {Buffer} body
   * @param {{kind?: 'map'|'token', declaredType?: string, filename?: string, grid?: object|null}} [opts]
   * @returns {{asset: object, created: boolean}}
   */
  function storeAsset(campaignId, body, { kind = 'map', declaredType = '', filename = '', grid = null } = {}) {
    requireStorage();
    if (!ASSET_KINDS.includes(kind)) throw new ApiError(400, 'BAD_KIND', `kind must be ${ASSET_KINDS.join(' or ')}`);
    if (!SAFE_ID.test(campaignId)) throw new ApiError(400, 'BAD_REQUEST', 'bad campaign id');
    if (body.length > quota.maxBytes) throw new ApiError(413, 'TOO_LARGE', `An asset is at most ${quota.maxBytes} bytes`);
    const checked = checkImageUpload(body, { kind, declaredType, filename });
    if (!checked.ok) throw new ApiError(checked.status, checked.code, checked.message);
    const { sniff } = checked;
    const sha256 = createHash('sha256').update(body).digest('hex');
    const existing = store.getAssetBySha(campaignId, sha256);
    if (existing) return { asset: existing, created: false };
    const use = store.assetUsage(campaignId);
    if (use.n >= quota.maxAssets) throw new ApiError(409, 'QUOTA', `A campaign holds at most ${quota.maxAssets} assets`);
    if (use.bytes + body.length > quota.maxCampaignBytes) throw new ApiError(409, 'QUOTA', 'This campaign is out of asset storage');
    volumeCheck();
    const fileName = `${sha256}.${IMAGE_TYPES[sniff.mime]}`;
    const relPath = `campaigns/${campaignId}/${fileName}`;
    const final = writeAtomic(join(root, campaignId), fileName, body);
    const id = newId('ca_');
    try {
      store.insertAsset({ id, campaignId, kind, relPath, mime: sniff.mime, bytes: body.length, sha256, width: sniff.width, height: sniff.height, grid });
    } catch (err) {
      try { unlinkSync(final); } catch { /* already gone */ }
      throw err;
    }
    return { asset: store.getAsset(campaignId, id), created: true };
  }

  /**
   * Copy one of a room's uploaded maps (by uploaded_maps.id, or by its
   * `maps/<roomId>/<file>` path) into the campaign.
   * @returns {object} the campaign asset
   */
  function importRoomMap(campaignId, roomId, { mapId = null, relPath = null } = {}) {
    requireStorage();
    const row = mapId ? q.roomMap.get(roomId, mapId) : q.roomMapByPath.get(roomId, relPath);
    if (!row) throw new ApiError(422, 'MAP_NOT_IN_ROOM', 'The setup names a map this room does not hold');
    let bytes;
    try { bytes = readFileSync(join(dataDir, row.rel_path)); } catch {
      throw new ApiError(422, 'MAP_FILE_MISSING', 'The room map file is gone; upload it again');
    }
    const grid = row.grid_json ? JSON.parse(row.grid_json) : null;
    return storeAsset(campaignId, bytes, { kind: row.kind || 'map', grid }).asset;
  }

  /**
   * Materialise a campaign asset into a room's uploaded_maps (same bytes,
   * same room path layout), within the room quota.
   * @returns {{mapId: string, url: string, kind: string, width: number, height: number}}
   */
  function materialize(campaignId, assetId, roomId) {
    requireStorage();
    const a = store.getAsset(campaignId, assetId);
    if (!a) throw new ApiError(422, 'ASSET_NOT_FOUND', `The template names asset ${assetId}, which this campaign does not hold`);
    if (!SAFE_ID.test(roomId)) throw new ApiError(400, 'BAD_REQUEST', 'bad room id');
    const pub = (r) => ({ mapId: r.id, url: `/api/${r.rel_path}`, kind: r.kind || 'map', width: r.width, height: r.height });
    const existing = q.roomMapBySha.get(roomId, a.sha256);
    if (existing) return pub(existing);
    const use = q.roomUsage.get(roomId);
    if (q.roomKindCount.get(roomId, a.kind).n >= roomQuota.maxMaps) throw new ApiError(409, 'QUOTA', `A room holds at most ${roomQuota.maxMaps} ${a.kind}s`);
    if (use.bytes + a.bytes > roomQuota.maxRoomBytes) throw new ApiError(409, 'QUOTA', 'This room is out of map storage');
    volumeCheck();
    const bytes = readFileSync(join(dataDir, a.relPath));
    const fileName = `${a.sha256}.${IMAGE_TYPES[a.mime]}`;
    const relPath = `maps/${roomId}/${fileName}`;
    const final = writeAtomic(join(dataDir, 'maps', roomId), fileName, bytes);
    const id = newId('map_');
    try {
      q.insertRoomMap.run(id, roomId, relPath, a.mime, a.bytes, a.sha256, a.width, a.height,
        a.grid == null ? null : JSON.stringify(a.grid), now(), a.kind);
    } catch (err) {
      try { unlinkSync(final); } catch { /* already gone */ }
      throw err;
    }
    return pub(q.roomMap.get(roomId, id));
  }

  /** Delete an asset's file (its row is the caller's). */
  function removeFile(a) {
    if (root) rmSync(join(dataDir, a.relPath), { force: true });
  }
  /** Delete every file of a campaign. */
  function removeCampaignFiles(campaignId) {
    if (root && SAFE_ID.test(campaignId)) rmSync(join(root, campaignId), { recursive: true, force: true });
  }
  /** An asset's bytes (export). */
  const readBytes = (a) => readFileSync(join(dataDir, a.relPath));

  return { root, storeAsset, importRoomMap, materialize, removeFile, removeCampaignFiles, readBytes };
}
