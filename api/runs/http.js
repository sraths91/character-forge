// Runs HTTP API (M65 B24, B26, B27). Mounted by multiplayer.js (it needs
// the live room registry). The campaign key travels in
// `Authorization: Bearer`; a room's DM token, where a route also touches
// a room, in `X-Room-Token` (the campaigns API's convention).
//
//   POST /api/campaigns/:cid/runs   (campaign key; X-Room-Token: DM of an existing room, optional)
//        {seed?, xp?: {slotId: n}, importLiveState?, roomName?}
//        → 201 {runId, roomId, code, dmToken, status, currentNodeId}
//        Freezes the campaign (nodes + templates) into runs.campaign_json
//        and starts the run in that room with its seated party (entering
//        the start node), or — with no X-Room-Token — creates a room for
//        it (the DM token is returned once) where the run waits in the
//        lobby until the party is seated and the DM sends dm.node.begin.

import { bearerToken } from '../rooms/tokens.js';
import { RoomError as ApiError } from '../rooms/service.js';
import { validateCampaign } from '../../src/js/shared/campaign.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The campaign v1 a run freezes (src/js/shared/campaign.js): settings,
 * every node and every template, as stored now.
 * @param {ReturnType<import('../campaigns/store.js').createCampaignStore>} store
 * @param {object} c  campaign row
 * @returns {object}
 */
export function frozenCampaign(store, c) {
  return {
    v: 1, id: c.id, name: c.name, ruleset: c.ruleset, settings: c.settings || {},
    nodes: store.listNodes(c.id),
    templates: store.listTemplates(c.id).map(t => ({ id: t.id, name: t.name, setup: t.setup }))
  };
}

/**
 * Mount the run routes.
 * @param {import('express').Express} app
 * @param {object} o
 * @param {{get: (roomId: string) => import('../rooms/room.js').Room|null}} o.registry
 * @param {{authenticate: (token: string|null) => object|null}} o.rooms  room service
 * @param {ReturnType<import('../campaigns/store.js').createCampaignStore>} o.campaigns
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 */
export function mountRunRoutes(app, { registry, rooms, campaigns, log = () => {} }) {
  const wrap = (fn) => (req, res, next) => {
    Promise.resolve().then(() => fn(req, res)).catch(next);
  };
  const body = (req) => (isObj(req.body) ? req.body : {});

  /** The campaign the bearer key owns, which must be :cid. */
  function owned(req) {
    const c = campaigns.byKey(bearerToken(req));
    if (!c || c.id !== req.params.cid) throw new ApiError(401, 'UNAUTHENTICATED', 'The campaign key for this campaign is required');
    return c;
  }
  /** The DM of the room named by X-Room-Token. */
  function roomDm(req) {
    const h = req.get('x-room-token');
    const a = typeof h === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(h) ? rooms.authenticate(h) : null;
    if (!a) throw new ApiError(401, 'UNAUTHENTICATED', 'X-Room-Token must be the room\'s DM token');
    if (a.role !== 'dm') throw new ApiError(403, 'E_FORBIDDEN', 'Only the room\'s DM can do that');
    return a;
  }
  /** A run-controller refusal as an HTTP error. */
  function asHttp(err) {
    if (!err?.runIntentError) return err;
    const status = err.code === 'E_FORBIDDEN' ? 403 : err.code === 'E_NO_RUN' ? 404 : 409;
    return Object.assign(new ApiError(status, err.code, err.message), { details: err.details });
  }

  app.post('/api/campaigns/:cid/runs', wrap((req, res) => {
    const c = owned(req);
    const b = body(req);
    const campaign = frozenCampaign(campaigns, c);
    const v = validateCampaign(campaign);
    if (!v.ok) throw Object.assign(new ApiError(422, 'INVALID_GRAPH', `The campaign is not playable: ${v.errors[0].path} ${v.errors[0].message}`), { errors: v.errors });
    let dm;
    let dmToken;
    if (req.get('x-room-token') !== undefined) {
      dm = roomDm(req);
      dmToken = req.get('x-room-token');
    } else {
      const made = rooms.createRoom({ name: typeof b.roomName === 'string' ? b.roomName : c.name.slice(0, 32) });
      dm = { roomId: made.roomId };
      dmToken = made.dmToken;
    }
    const room = registry.get(dm.roomId);
    if (!room?.run) throw new ApiError(503, 'RUNS_UNAVAILABLE', 'This server does not host runs');
    const xp = isObj(b.xp) ? Object.fromEntries(Object.entries(b.xp).filter(([, n]) => Number.isInteger(n) && n >= 0)) : {};
    let out;
    try {
      out = room.run.start({
        campaign, campaignId: c.id, xp,
        ...(Number.isInteger(b.seed) ? { seed: b.seed } : {}),
        ...(typeof b.importLiveState === 'boolean' ? { importLiveState: b.importLiveState } : {})
      });
    } catch (err) {
      throw asHttp(err);
    }
    log('info', 'runs: started over HTTP', { campaignId: c.id, roomId: dm.roomId, runId: out.runId });
    res.status(201).json({ ...out, roomId: dm.roomId, code: rooms.store.getRoom(dm.roomId).code, dmToken });
  }));
}
