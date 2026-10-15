/**
 * Fetch a public D&D Beyond character via the unofficial character-service endpoint.
 *
 * The endpoint is undocumented; we expose this risk in the UI. The endpoint only
 * returns data for characters whose privacy is set to "Public" on dndbeyond.com.
 */

const DDB_HOST = 'character-service.dndbeyond.com';
const DDB_TEMPLATE = `https://${DDB_HOST}/character/v5/character`;

const URL_PATTERNS = [
  /dndbeyond\.com\/profile\/[^/]+\/characters\/(\d+)/i,
  /dndbeyond\.com\/characters\/(\d+)/i
];

/**
 * Pull a numeric character id out of a share URL or a bare id.
 * @param {unknown} input
 * @returns {string|null}
 */
export function extractCharacterId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  for (const pattern of URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** Upstream request budget (M64 B4); a stalled upstream fails fast. */
export const UPSTREAM_TIMEOUT_MS = 8000;

/**
 * Fetch a public character's JSON from D&D Beyond.
 * @param {string|number} characterId
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<object>} the character `data` object
 * @throws {Error} code CHAR_NOT_FOUND / DDB_HTTP_ERROR / BAD_ID, or a
 *   TimeoutError (DOMException) after `timeoutMs`
 */
export async function fetchDdbCharacter(characterId, { fetchImpl = fetch, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  if (!/^\d+$/.test(String(characterId))) {
    const err = new Error(`Invalid character id: ${characterId}`);
    err.code = 'BAD_ID';
    err.status = 400;
    throw err;
  }
  const url = `${DDB_TEMPLATE}/${characterId}`;
  const res = await fetchImpl(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'character-forge/0.1 (research project)'
    },
    signal: globalThis.AbortSignal.timeout(timeoutMs)
  });
  if (res.status === 404) {
    const err = new Error('Character not found or not public on D&D Beyond');
    err.code = 'CHAR_NOT_FOUND';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`D&D Beyond returned HTTP ${res.status}`);
    err.code = 'DDB_HTTP_ERROR';
    // Keep DDB's 4xx (403 = private character) visible; 5xx becomes 502.
    err.status = res.status >= 500 ? 502 : res.status;
    err.upstreamStatus = res.status;
    throw err;
  }
  const body = await res.json();
  if (!body || !body.data) {
    const err = new Error('Unexpected response shape from D&D Beyond');
    err.code = 'DDB_BAD_RESPONSE';
    err.status = 502;
    throw err;
  }
  return body.data;
}
