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

export async function fetchDdbCharacter(characterId, { fetchImpl = fetch } = {}) {
  if (!/^\d+$/.test(String(characterId))) {
    throw new Error(`Invalid character id: ${characterId}`);
  }
  const url = `${DDB_TEMPLATE}/${characterId}`;
  const res = await fetchImpl(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'character-forge/0.1 (research project)'
    }
  });
  if (res.status === 404) {
    const err = new Error('Character not found or not public on D&D Beyond');
    err.code = 'CHAR_NOT_FOUND';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`D&D Beyond returned HTTP ${res.status}`);
    err.code = 'DDB_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  if (!body || !body.data) {
    throw new Error('Unexpected response shape from D&D Beyond');
  }
  return body.data;
}
