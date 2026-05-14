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

const OPEN5E_HOST = 'https://api.open5e.com';

export async function searchOpen5eCreatures(query, { limit = 20, fetchImpl = fetch } = {}) {
  const q = String(query || '').trim();
  if (q.length === 0) return [];
  const url = new URL('/v2/creatures/', OPEN5E_HOST);
  url.searchParams.set('search', q);
  url.searchParams.set('limit', String(limit));
  const res = await fetchImpl(url.toString(), {
    headers: { 'Accept': 'application/json', 'User-Agent': 'character-forge/0.1' }
  });
  if (!res.ok) {
    const err = new Error(`Open5e search returned ${res.status}`);
    err.code = 'OPEN5E_HTTP';
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.map(toSummary);
}

export async function fetchOpen5eCreature(slug, { fetchImpl = fetch } = {}) {
  const cleaned = String(slug || '').trim();
  if (!cleaned) throw new Error('slug required');
  const url = `${OPEN5E_HOST}/v2/creatures/${encodeURIComponent(cleaned)}/`;
  const res = await fetchImpl(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'character-forge/0.1' }
  });
  if (res.status === 404) {
    const err = new Error(`Creature "${cleaned}" not in Open5e`);
    err.code = 'OPEN5E_NOT_FOUND';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Open5e returned ${res.status}`);
    err.code = 'OPEN5E_HTTP';
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  return body;
}

/**
 * Reduce a full creature record to the fields we actually surface in the
 * UI picker. Keeps payloads small in API responses; full records are
 * still cached server-side so they're available when needed later.
 */
export function toSummary(creature) {
  return {
    slug: creature.key || creature.slug || creature.id,
    name: creature.name || 'Unknown',
    cr:   typeof creature.cr === 'number'   ? creature.cr
        : typeof creature.challenge_rating === 'number' ? creature.challenge_rating
        : null,
    type: creature.type || creature.creature_type?.key || null,
    size: creature.size || creature.size?.key || null,
    hp:   creature.hit_points || creature.hp_average || creature.hp || null
  };
}
