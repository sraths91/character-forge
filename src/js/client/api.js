/**
 * M64 C9 — rooms HTTP client for the play page (E3's B6/B10 API).
 *
 *   POST   /api/rooms                        {name?, mode?}        → {roomId, code, dmToken, participantId, mode}
 *          (M65 B28: mode 'solo' — the DM drives the AI seats; the forge handoff, V21)
 *   POST   /api/rooms/join                   {code, displayName}   → {roomId, participantId, token, displayName}
 *   GET    /api/rooms/:id                                          → {room, me, members, seats}
 *   POST   /api/rooms/:id/kick               {participantId}       → {ok}
 *   POST   /api/rooms/:id/seats/:n/claim     {characterId}         → {seat}
 *   POST   /api/rooms/:id/seats/:n/ai        {characterId, archetype} → {seat}
 *   DELETE /api/rooms/:id/seats/:n                                 → {ok}
 *   POST   /api/import?room=<id>             {url | characterId | json} → {character}  (use character.id)
 *   GET    /api/characters?room=<id>                               → {characters: [{ddbId, name}]}
 *   GET    /api/characters/:ddbId (Bearer)                         → {character, prose?: 'stripped'}
 *   PUT    /api/rooms/:id/maps?filename=     raw image bytes       → {mapId, url, width, height, …}
 *   PUT    /api/rooms/:id/maps?kind=token&filename=  raw image bytes → {mapId, kind: 'token', url, …}
 *   GET    /api/rooms/:id/maps                                     → {maps: [{mapId, kind, url, sha256, …}]}
 *   GET    /api/monsters/search?q=                                 → {results: [{slug, name, type, cr, hp}]}
 *   GET    /api/rooms/:id/seats/:slotId/sheet (Bearer)             → {sheet, prose?}  (M65 B27: the run sheet)
 *
 * M65 campaign authoring (E3's B22, `api/campaigns/http.js`). The campaign
 * key goes in `Authorization: Bearer` per call (it is not the room token);
 * a room's DM token, where a route touches a room, in `X-Room-Token`:
 *   POST   /api/campaigns {name, settings?}            → {campaignId, campaignKey}
 *   POST   /api/campaigns/import  export document       → {campaignId, campaignKey, counts}
 *   GET/PATCH/DELETE /api/campaigns/:cid               → {campaign, nodes, templates, assets, validation}
 *   GET    /api/campaigns/:cid/validate                → {validation: {ok, ready, errors, warnings}}
 *   GET/POST /api/campaigns/:cid/nodes, PUT/DELETE …/nodes/:id, PUT …/graph {nodes}
 *          422 {code: 'INVALID_GRAPH', errors, warnings} → Error.errors / .warnings
 *   GET/POST /api/campaigns/:cid/templates, POST …/templates/from-room (X-Room-Token),
 *          GET/PUT/DELETE …/templates/:tid, POST …/templates/:tid/instantiate (X-Room-Token) → {setup}
 *   PUT    /api/campaigns/:cid/assets?kind=map|token&filename=  raw image → {asset}
 *   GET    /api/campaigns/:cid/assets, DELETE …/assets/:aid
 *   GET    /api/campaigns/:cid/export
 *   POST   /api/campaigns/:cid/runs (X-Room-Token optional) → {runId, roomId, code, dmToken}  (B24; assumed shape)
 *   GET    /api/licenses                               → {srd: {name, license, attribution}}
 *   GET    /api/srd/items?q=&kind=item|magicitem, GET /api/srd/spells?q=  → {results}
 *
 * Tokens travel only in `Authorization: Bearer` — never in a URL. Every
 * call resolves to the JSON body or rejects with an Error carrying
 * `status` and the server's `code`.
 */

import { tokenImageUploadPath } from '../map/token-picker.js';

/**
 * @param {{fetch?: Function, base?: string, token?: () => (string|null)}} [opts]
 * @returns {object} the API methods
 */
export function createApi({ fetch: fetchImpl = globalThis.fetch?.bind(globalThis), base = '', token = () => null } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createApi: fetch is required');

  async function call(method, path, { body, raw, contentType, auth = true, bearer = null, headers: extra = null } = {}) {
    const headers = { ...(extra || {}) };
    const t = bearer || (auth ? token() : null);
    if (t) headers.Authorization = `Bearer ${t}`;
    let payload;
    if (raw !== undefined) {
      payload = raw;
      if (contentType) headers['Content-Type'] = contentType;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error(data?.error || data?.message || `${method} ${path} failed (${res.status})`);
      err.status = res.status;
      err.code = data?.code || null;
      if (Array.isArray(data?.errors)) err.errors = data.errors;
      if (Array.isArray(data?.warnings)) err.warnings = data.warnings;
      throw err;
    }
    return data;
  }

  const enc = encodeURIComponent;
  const cpath = (cid, rest = '') => `/api/campaigns/${enc(cid)}${rest}`;
  const roomHeader = (roomToken) => (roomToken ? { 'X-Room-Token': roomToken } : null);
  const qs = (o) => {
    const parts = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${enc(k)}=${enc(v)}`);
    return parts.length ? `?${parts.join('&')}` : '';
  };
  return {
    createRoom: (name = null, { mode = null } = {}) =>
      call('POST', '/api/rooms', { body: { ...(name ? { name } : {}), ...(mode ? { mode } : {}) }, auth: false }),
    joinRoom: (code, displayName) => call('POST', '/api/rooms/join', { body: { code, displayName }, auth: false }),
    getRoom: (roomId) => call('GET', `/api/rooms/${enc(roomId)}`),
    kick: (roomId, participantId) => call('POST', `/api/rooms/${enc(roomId)}/kick`, { body: { participantId } }),
    claimSeat: (roomId, seat, characterId) => call('POST', `/api/rooms/${enc(roomId)}/seats/${enc(seat)}/claim`, { body: { characterId } }),
    aiSeat: (roomId, seat, characterId, archetype) => call('POST', `/api/rooms/${enc(roomId)}/seats/${enc(seat)}/ai`, { body: { characterId, archetype } }),
    releaseSeat: (roomId, seat) => call('DELETE', `/api/rooms/${enc(roomId)}/seats/${enc(seat)}`),
    importCharacter: (roomId, { url, json, characterId } = {}) =>
      call('POST', `/api/import?room=${enc(roomId)}`, { body: json ? { json } : characterId ? { characterId: String(characterId) } : { url } }),
    listCharacters: (roomId) => call('GET', `/api/characters?room=${enc(roomId)}`),
    // Authenticated since E3's leak fix: a member token sees characters in
    // its room (teammates get the prose-stripped sheet); without a token
    // the server serves only what this browser imported.
    getCharacter: (ddbId) => call('GET', `/api/characters/${enc(ddbId)}`),
    uploadMap: (roomId, bytes, { filename = '', mime = 'application/octet-stream' } = {}) =>
      call('PUT', `/api/rooms/${enc(roomId)}/maps${filename ? `?filename=${enc(filename)}` : ''}`, { raw: bytes, contentType: mime }),
    listMaps: (roomId) => call('GET', `/api/rooms/${enc(roomId)}/maps`),
    // E3 wave 6: a DM token image (E5's tokenImageUploadPath, kind=token).
    uploadTokenImage: (roomId, bytes, { filename = '', mime = 'application/octet-stream' } = {}) =>
      call('PUT', tokenImageUploadPath(roomId, { filename, kindSupported: true }), { raw: bytes, contentType: mime }),
    searchMonsters: (q) => call('GET', `/api/monsters/search?q=${enc(q)}`, { auth: false }),
    // M65 B27: a seat's run sheet (full for its controller and the DM, public otherwise).
    getSeatSheet: (roomId, slotId) => call('GET', `/api/rooms/${enc(roomId)}/seats/${enc(slotId)}/sheet`),

    // ---- M65 campaign authoring (campaign key per call) ----
    createCampaign: (name, settings = undefined) => call('POST', '/api/campaigns', { body: settings ? { name, settings } : { name }, auth: false }),
    importCampaign: (doc) => call('POST', '/api/campaigns/import', { body: doc, auth: false }),
    getCampaign: (cid, key) => call('GET', cpath(cid), { bearer: key, auth: false }),
    patchCampaign: (cid, key, patch) => call('PATCH', cpath(cid), { body: patch, bearer: key, auth: false }),
    deleteCampaign: (cid, key) => call('DELETE', cpath(cid), { bearer: key, auth: false }),
    validateCampaign: (cid, key) => call('GET', cpath(cid, '/validate'), { bearer: key, auth: false }),
    listNodes: (cid, key) => call('GET', cpath(cid, '/nodes'), { bearer: key, auth: false }),
    createNode: (cid, key, node) => call('POST', cpath(cid, '/nodes'), { body: node, bearer: key, auth: false }),
    putNode: (cid, key, nodeId, node) => call('PUT', cpath(cid, `/nodes/${enc(nodeId)}`), { body: node, bearer: key, auth: false }),
    deleteNode: (cid, key, nodeId) => call('DELETE', cpath(cid, `/nodes/${enc(nodeId)}`), { bearer: key, auth: false }),
    putGraph: (cid, key, nodes) => call('PUT', cpath(cid, '/graph'), { body: { nodes }, bearer: key, auth: false }),
    listTemplates: (cid, key) => call('GET', cpath(cid, '/templates'), { bearer: key, auth: false }),
    createTemplate: (cid, key, { name, setup }) => call('POST', cpath(cid, '/templates'), { body: { name, setup }, bearer: key, auth: false }),
    templateFromRoom: (cid, key, roomToken, { name, setup }) =>
      call('POST', cpath(cid, '/templates/from-room'), { body: { name, setup }, bearer: key, auth: false, headers: roomHeader(roomToken) }),
    getTemplate: (cid, key, tid) => call('GET', cpath(cid, `/templates/${enc(tid)}`), { bearer: key, auth: false }),
    putTemplate: (cid, key, tid, patch) => call('PUT', cpath(cid, `/templates/${enc(tid)}`), { body: patch, bearer: key, auth: false }),
    deleteTemplate: (cid, key, tid) => call('DELETE', cpath(cid, `/templates/${enc(tid)}`), { bearer: key, auth: false }),
    instantiateTemplate: (cid, key, tid, roomToken) =>
      call('POST', cpath(cid, `/templates/${enc(tid)}/instantiate`), { body: {}, bearer: key, auth: false, headers: roomHeader(roomToken) }),
    uploadAsset: (cid, key, bytes, { kind = 'map', filename = '', mime = 'application/octet-stream' } = {}) =>
      call('PUT', cpath(cid, `/assets${qs({ kind, filename })}`), { raw: bytes, contentType: mime, bearer: key, auth: false }),
    listAssets: (cid, key) => call('GET', cpath(cid, '/assets'), { bearer: key, auth: false }),
    deleteAsset: (cid, key, aid) => call('DELETE', cpath(cid, `/assets/${enc(aid)}`), { bearer: key, auth: false }),
    exportCampaign: (cid, key) => call('GET', cpath(cid, '/export'), { bearer: key, auth: false }),
    startRun: (cid, key, { roomToken = null, ...opts } = {}) =>
      call('POST', cpath(cid, '/runs'), { body: opts, bearer: key, auth: false, headers: roomHeader(roomToken) }),
    licenses: () => call('GET', '/api/licenses', { auth: false }),
    srdItems: (q, kind = null) => call('GET', `/api/srd/items${qs({ q, kind })}`, { auth: false }),
    srdItem: (key, kind = null) => call('GET', `/api/srd/items/${enc(key)}${qs({ kind })}`, { auth: false }),   // M65 C26: shop prices
    srdSpells: (q) => call('GET', `/api/srd/spells${qs({ q })}`, { auth: false })
  };
}
