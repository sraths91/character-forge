/**
 * M3 — Open5e API client.
 *
 * Open5e (https://open5e.com) is a free, no-auth REST API serving the
 * D&D 5e SRD + OGL content. We use the V2 creatures endpoint for monster
 * stat blocks:
 *
 *   GET https://api.open5e.com/v2/creatures/?search=goblin
 *   GET https://api.open5e.com/v2/creatures/srd_goblin/
 *
 * Responses are cached server-side in the `monsters` SQLite table so we
 * don't hammer Open5e for every "Add monster" click. The cache is
 * read-through: first request for a slug hits Open5e, every subsequent
 * request reads from SQLite.
 */

// M64 R11 — the stat-block normaliser is shared with the browser.
export {
  normalizeCreature,
  engineAttacksFrom,
  withEngineFields,
  isNormalizedStatBlock,
  parseMultiattack,
  proficiencyForCr,
  OPEN5E_SOURCE
} from '../../src/js/scene/open5e-normalize.js';

const OPEN5E_HOST = 'https://api.open5e.com';

/** Upstream request budget (M64 B4). */
export const OPEN5E_TIMEOUT_MS = 8000;
/**
 * Only SRD 5.1 creatures (M64 B4). Verified 2026-10-15 against v2
 * creatures: `document__key=srd-2014` narrows "goblin" from 29 results
 * (A5e, Tome of Beasts, ...) to Goblin + Hobgoblin, and an unknown key
 * returns 0. Note the v2 *items* endpoints take `document__key__in`.
 */
export const OPEN5E_DOCUMENT_KEY = 'srd-2014';

function upstreamError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/**
 * Search SRD creatures whose name contains `query`.
 * @param {string} query
 * @param {{limit?: number, fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<ReturnType<typeof toSummary>[]>}
 */
export async function searchOpen5eCreatures(query, { limit = 30, fetchImpl = fetch, timeoutMs = OPEN5E_TIMEOUT_MS } = {}) {
  const q = String(query || '').trim();
  if (q.length === 0) return [];
  // Use Django REST framework's name__icontains filter — matches creatures
  // whose name contains the query (case-insensitive). The default
  // `search` param is full-text and includes flavour text, so "goblin"
  // surfaces unrelated creatures whose description mentions goblins.
  const url = new URL('/v2/creatures/', OPEN5E_HOST);
  url.searchParams.set('name__icontains', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('ordering', 'cr');   // weakest first — useful for encounter design
  url.searchParams.set('document__key', OPEN5E_DOCUMENT_KEY);
  const res = await fetchImpl(url.toString(), {
    headers: { 'Accept': 'application/json', 'User-Agent': 'character-forge/0.1' },
    signal: globalThis.AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw upstreamError(`Open5e search returned ${res.status}`, 'OPEN5E_HTTP', 502);
  const body = await res.json();
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.map(toSummary);
}

/**
 * Fetch one creature's full v2 record by key (e.g. `srd_goblin`).
 * @param {string} slug
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<object>}
 */
export async function fetchOpen5eCreature(slug, { fetchImpl = fetch, timeoutMs = OPEN5E_TIMEOUT_MS } = {}) {
  const cleaned = String(slug || '').trim();
  if (!cleaned) throw upstreamError('slug required', 'BAD_SLUG', 400);
  const url = `${OPEN5E_HOST}/v2/creatures/${encodeURIComponent(cleaned)}/`;
  const res = await fetchImpl(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'character-forge/0.1' },
    signal: globalThis.AbortSignal.timeout(timeoutMs)
  });
  if (res.status === 404) throw upstreamError(`Creature "${cleaned}" not in Open5e`, 'OPEN5E_NOT_FOUND', 404);
  if (!res.ok) throw upstreamError(`Open5e returned ${res.status}`, 'OPEN5E_HTTP', 502);
  const body = await res.json();
  return body;
}

/**
 * Reduce a full creature record to the fields we actually surface in the
 * UI picker. Keeps payloads small in API responses; full records are
 * still cached server-side so they're available when needed later.
 */
export function toSummary(creature) {
  creature = creature || {};
  // Open5e V2 returns type/size as nested { name, key } objects. Fall back
  // to string fields for V1-style or simpler responses.
  const typeName = typeof creature.type === 'object' && creature.type
    ? (creature.type.name || creature.type.key)
    : (typeof creature.type === 'string' ? creature.type : null);
  const sizeName = typeof creature.size === 'object' && creature.size
    ? (creature.size.name || creature.size.key)
    : (typeof creature.size === 'string' ? creature.size : null);
  return {
    slug: creature.key || creature.slug || creature.id,
    name: creature.name || 'Unknown',
    cr:   typeof creature.cr === 'number'   ? creature.cr
        : typeof creature.challenge_rating === 'number' ? creature.challenge_rating
        : null,
    type: typeName,
    size: sizeName,
    hp:   creature.hit_points || creature.hp_average || creature.hp || null
  };
}
