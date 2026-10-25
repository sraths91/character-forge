// Encounter-template setups (M65 B22): the `dm.encounter.setup` payload
// (views/setup.js setupPayload) made portable between rooms. In a stored
// template an image map names a campaign asset (`map.assetId`) instead of
// a room upload (`map.imageId` / `map.url`), and a monster's token image
// names one too (`tokenAssetId` instead of `imageUrl`).

import { validateClientMessage, PROTOCOL_VERSION } from '../../src/js/shared/protocol.js';
import { RoomError as ApiError } from '../rooms/service.js';

/** Largest stored setup (JSON characters). */
export const MAX_SETUP_CHARS = 512 * 1024;

const clone = (v) => JSON.parse(JSON.stringify(v));
const ROOM_MAP_URL = /^\/api\/maps\/([A-Za-z0-9_-]+)\/([a-f0-9]{64}\.(?:png|jpg|webp))$/;

/**
 * Check a setup against the protocol's `dm.encounter.setup` payload spec.
 * @param {unknown} setup
 * @throws {ApiError} 422 INVALID_SETUP
 */
export function assertSetup(setup) {
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) throw new ApiError(422, 'INVALID_SETUP', 'setup is a dm.encounter.setup payload object');
  if (JSON.stringify(setup).length > MAX_SETUP_CHARS) throw new ApiError(413, 'TOO_LARGE', 'setup is too large');
  const v = validateClientMessage({ v: PROTOCOL_VERSION, t: 'dm.encounter.setup', cid: 'template', p: setup });
  if (!v.ok) {
    const e = v.errors[0];
    throw new ApiError(422, 'INVALID_SETUP', `setup${e.path.replace(/^p/, '')}: ${e.message}`);
  }
}

/**
 * A setup ready to store in `campaignId`: room uploads become campaign
 * assets (copied when `roomId` is the room that holds them), and image
 * maps must end up naming an asset of this campaign.
 * @param {object} setup
 * @param {object} ctx
 * @param {string} ctx.campaignId
 * @param {string|null} [ctx.roomId]   the room the setup was taken from (from-room only)
 * @param {ReturnType<import('./store.js').createCampaignStore>} ctx.store
 * @param {ReturnType<import('./assets.js').createCampaignAssets>} ctx.assets
 * @returns {object}
 */
export function portableSetup(setup, { campaignId, roomId = null, store, assets }) {
  assertSetup(setup);
  const out = clone(setup);
  const map = out.map;
  if (map && map.kind === 'image') {
    if (typeof map.assetId === 'string') {
      if (!store.getAsset(campaignId, map.assetId)) throw new ApiError(422, 'ASSET_NOT_FOUND', `map.assetId ${map.assetId} is not an asset of this campaign`);
    } else if (roomId && (typeof map.imageId === 'string' || ROOM_MAP_URL.exec(map.url || '')?.[1] === roomId)) {
      const m = ROOM_MAP_URL.exec(map.url || '');
      const asset = typeof map.imageId === 'string'
        ? assets.importRoomMap(campaignId, roomId, { mapId: map.imageId })
        : assets.importRoomMap(campaignId, roomId, { relPath: `maps/${roomId}/${m[2]}` });
      map.assetId = asset.id;
    } else {
      throw new ApiError(422, 'MAP_NOT_PORTABLE', 'An image map must name a campaign asset (map.assetId); upload it to the campaign or save the template from the room');
    }
    delete map.imageId;
    delete map.url;
  }
  for (const m of Array.isArray(out.monsters) ? out.monsters : []) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.tokenAssetId === 'string') {
      if (!store.getAsset(campaignId, m.tokenAssetId)) throw new ApiError(422, 'ASSET_NOT_FOUND', `tokenAssetId ${m.tokenAssetId} is not an asset of this campaign`);
      delete m.imageUrl;
    } else if (typeof m.imageUrl === 'string') {
      const hit = ROOM_MAP_URL.exec(m.imageUrl);
      if (roomId && hit && hit[1] === roomId) m.tokenAssetId = assets.importRoomMap(campaignId, roomId, { relPath: `maps/${roomId}/${hit[2]}` }).id;
      delete m.imageUrl;   // another room's upload is not portable
    }
  }
  return out;
}

/**
 * A stored template's setup for `roomId`: every campaign asset it names is
 * materialised into the room's uploaded_maps and referenced the way the
 * room's own uploads are (`map.imageId` + `map.url`, `imageUrl`).
 * @returns {object} a `dm.encounter.setup` payload for that room
 */
export function setupForRoom(setup, { campaignId, roomId, assets }) {
  const out = clone(setup);
  if (out.map && typeof out.map.assetId === 'string') {
    const m = assets.materialize(campaignId, out.map.assetId, roomId);
    out.map.imageId = m.mapId;
    out.map.url = m.url;
    delete out.map.assetId;
  }
  for (const mon of Array.isArray(out.monsters) ? out.monsters : []) {
    if (mon && typeof mon.tokenAssetId === 'string') {
      mon.imageUrl = assets.materialize(campaignId, mon.tokenAssetId, roomId).url;
      delete mon.tokenAssetId;
    }
  }
  assertSetup(out);
  return out;
}
