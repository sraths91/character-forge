/**
 * M64 C9 — rooms HTTP client for the play page (E3's B6/B10 API).
 *
 *   POST   /api/rooms                        {name?}               → {roomId, code, dmToken, participantId}
 *   POST   /api/rooms/join                   {code, displayName}   → {roomId, participantId, token, displayName}
 *   GET    /api/rooms/:id                                          → {room, me, members, seats}
 *   POST   /api/rooms/:id/kick               {participantId}       → {ok}
 *   POST   /api/rooms/:id/seats/:n/claim     {characterId}         → {seat}
 *   POST   /api/rooms/:id/seats/:n/ai        {characterId, archetype} → {seat}
 *   DELETE /api/rooms/:id/seats/:n                                 → {ok}
 *   POST   /api/import?room=<id>             {url | json}          → {character}  (use character.id)
 *   GET    /api/characters?room=<id>                               → {characters: [{ddbId, name}]}
 *   GET    /api/characters/:ddbId (Bearer)                         → {character, prose?: 'stripped'}
 *   PUT    /api/rooms/:id/maps?filename=     raw image bytes       → {mapId, url, width, height, …}
 *   PUT    /api/rooms/:id/maps?kind=token&filename=  raw image bytes → {mapId, kind: 'token', url, …}
 *   GET    /api/monsters/search?q=                                 → {results: [{slug, name, type, cr, hp}]}
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

  async function call(method, path, { body, raw, contentType, auth = true } = {}) {
    const headers = {};
    const t = auth ? token() : null;
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
      throw err;
    }
    return data;
  }

  const enc = encodeURIComponent;
  return {
    createRoom: (name = null) => call('POST', '/api/rooms', { body: name ? { name } : {}, auth: false }),
    joinRoom: (code, displayName) => call('POST', '/api/rooms/join', { body: { code, displayName }, auth: false }),
    getRoom: (roomId) => call('GET', `/api/rooms/${enc(roomId)}`),
    kick: (roomId, participantId) => call('POST', `/api/rooms/${enc(roomId)}/kick`, { body: { participantId } }),
    claimSeat: (roomId, seat, characterId) => call('POST', `/api/rooms/${enc(roomId)}/seats/${enc(seat)}/claim`, { body: { characterId } }),
    aiSeat: (roomId, seat, characterId, archetype) => call('POST', `/api/rooms/${enc(roomId)}/seats/${enc(seat)}/ai`, { body: { characterId, archetype } }),
    releaseSeat: (roomId, seat) => call('DELETE', `/api/rooms/${enc(roomId)}/seats/${enc(seat)}`),
    importCharacter: (roomId, { url, json } = {}) => call('POST', `/api/import?room=${enc(roomId)}`, { body: json ? { json } : { url } }),
    listCharacters: (roomId) => call('GET', `/api/characters?room=${enc(roomId)}`),
    // Authenticated since E3's leak fix: a member token sees characters in
    // its room (teammates get the prose-stripped sheet); without a token
    // the server serves only what this browser imported.
    getCharacter: (ddbId) => call('GET', `/api/characters/${enc(ddbId)}`),
    uploadMap: (roomId, bytes, { filename = '', mime = 'application/octet-stream' } = {}) =>
      call('PUT', `/api/rooms/${enc(roomId)}/maps${filename ? `?filename=${enc(filename)}` : ''}`, { raw: bytes, contentType: mime }),
    // E3 wave 6: a DM token image (E5's tokenImageUploadPath, kind=token).
    uploadTokenImage: (roomId, bytes, { filename = '', mime = 'application/octet-stream' } = {}) =>
      call('PUT', tokenImageUploadPath(roomId, { filename, kindSupported: true }), { raw: bytes, contentType: mime }),
    searchMonsters: (q) => call('GET', `/api/monsters/search?q=${enc(q)}`, { auth: false })
  };
}
