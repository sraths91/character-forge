// Open5e SRD item / spell proxy (M65 B23), cached in items_cache.
//
//   GET /api/srd/items?q=<name>[&kind=item|magicitem]  → {results: [summary], source: 'cache'|'open5e'}
//   GET /api/srd/items/:key[?kind=item|magicitem]       → {item, kind, source}
//   GET /api/srd/spells?q=<name>                        → {results: [summary], source}
//   GET /api/srd/spells/:key                            → {spell, source}
//
// Only the SRD 5.1 document is ever served or cached. Every upstream list
// call filters with `document__key__in=srd-2014`: verified 2026-10-25,
// that narrows /v2/items/ to 237, /v2/magicitems/ to 499 and /v2/spells/
// to 319 records, while `document__key=srd-2014` is silently ignored on
// both item endpoints (440 / 2322, mostly srd-2024 and third-party
// books) and an unknown key returns 0. Every record is still checked
// (`document.key === 'srd-2014'`) before it is returned or cached; the
// table's CHECK is the backstop. Every fetch carries AbortSignal.timeout.

import { OPEN5E_DOCUMENT_KEY, OPEN5E_TIMEOUT_MS } from '../lib/open5e.js';
import { RoomError as ApiError } from '../rooms/service.js';

export const OPEN5E_HOST = 'https://api.open5e.com';
/** The one document admitted (items_cache.document_key CHECK). */
export const SRD_DOCUMENT_KEY = OPEN5E_DOCUMENT_KEY;
/** Endpoint per cache kind. */
export const SRD_ENDPOINTS = Object.freeze({ item: '/v2/items/', magicitem: '/v2/magicitems/', spell: '/v2/spells/' });
/** A search is served from the cache when it already holds this many name matches. */
export const CACHE_HIT_MIN = 8;
const SEARCH_LIMIT = 30;
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

const docKey = (rec) => (rec && typeof rec.document === 'object' ? rec.document?.key : rec?.document) ?? null;
/** True when an Open5e record belongs to the SRD 5.1 document. */
export const isSrdRecord = (rec) => !!rec && typeof rec.key === 'string' && KEY_RE.test(rec.key) && typeof rec.name === 'string' && docKey(rec) === SRD_DOCUMENT_KEY;

/**
 * The short form a picker needs.
 * @param {object} rec  Open5e v2 record
 * @param {'item'|'magicitem'|'spell'} kind
 */
export function srdSummary(rec, kind) {
  if (kind === 'spell') {
    return {
      key: rec.key, name: rec.name, kind, level: rec.level ?? null, school: rec.school?.name ?? null,
      ritual: rec.ritual === true, concentration: rec.concentration === true, castingTime: rec.casting_time ?? null
    };
  }
  return {
    key: rec.key, name: rec.name, kind, cost: rec.cost ?? null, category: rec.category?.name ?? null,
    rarity: rec.rarity?.name ?? null, weight: rec.weight ?? null, requiresAttunement: rec.requires_attunement === true,
    weapon: !!rec.weapon, armor: !!rec.armor
  };
}

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.conn
 * @param {typeof fetch} o.fetchImpl
 * @param {number} [o.timeoutMs]
 * @param {(name: string, extra?: object) => import('express').RequestHandler} o.limiter
 * @param {() => number} [o.now]
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 */
export function mountSrdRoutes(app, { conn, fetchImpl, timeoutMs = OPEN5E_TIMEOUT_MS, limiter, now = Date.now, log = () => {} }) {
  const q = {
    get: conn.prepare('SELECT * FROM items_cache WHERE key = ?'),
    search: conn.prepare(`SELECT kind, payload_json FROM items_cache
      WHERE kind IN (SELECT value FROM json_each(?)) AND LOWER(name) LIKE ? ORDER BY name LIMIT ?`),
    upsert: conn.prepare(`INSERT INTO items_cache (key, document_key, kind, name, payload_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET document_key = excluded.document_key, kind = excluded.kind, name = excluded.name,
        payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`)
  };

  /** Cache an SRD record; anything else is refused before it reaches SQL. */
  function cache(rec, kind) {
    if (!isSrdRecord(rec)) return false;
    try {
      q.upsert.run(rec.key, SRD_DOCUMENT_KEY, kind, rec.name, JSON.stringify(rec), now());
      return true;
    } catch (err) {
      log('warn', 'srd: cache write failed', { key: rec.key, error: err.message });
      return false;
    }
  }

  async function upstream(url) {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'character-forge/0.1' },
      signal: globalThis.AbortSignal.timeout(timeoutMs)
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(502, 'OPEN5E_HTTP', `Open5e returned ${res.status}`);
    return res.json();
  }
  function listUrl(kind, name) {
    const url = new URL(SRD_ENDPOINTS[kind], OPEN5E_HOST);
    url.searchParams.set('document__key__in', SRD_DOCUMENT_KEY);
    url.searchParams.set('name__icontains', name);
    url.searchParams.set('limit', String(SEARCH_LIMIT));
    return url.toString();
  }

  const term = (req) => String(req.query.q ?? '').trim().slice(0, 64);
  const itemKinds = (req) => {
    const k = req.query.kind;
    if (k === undefined) return ['item', 'magicitem'];
    if (k !== 'item' && k !== 'magicitem') throw new ApiError(400, 'BAD_KIND', 'kind must be item or magicitem');
    return [k];
  };
  const cachedSearch = (kinds, name) => q.search.all(JSON.stringify(kinds), `%${name.toLowerCase()}%`, SEARCH_LIMIT)
    .map(r => srdSummary(JSON.parse(r.payload_json), r.kind));
  const cachedOne = (key, kinds) => {
    const r = KEY_RE.test(key) ? q.get.get(key) : null;
    return r && kinds.includes(r.kind) && r.document_key === SRD_DOCUMENT_KEY ? { kind: r.kind, rec: JSON.parse(r.payload_json) } : null;
  };
  const safe = (fn) => { try { return fn(); } catch { return false; } };

  async function search(req, res, next, kinds) {
    try {
      const name = term(req);
      if (!name) return res.json({ results: [] });
      const cached = cachedSearch(kinds, name);
      if (cached.length >= CACHE_HIT_MIN) return res.json({ results: cached, source: 'cache' });
      const results = [];
      for (const kind of kinds) {
        const body = await upstream(listUrl(kind, name));
        for (const rec of Array.isArray(body?.results) ? body.results : []) {
          if (!isSrdRecord(rec)) continue;   // never served, never cached
          cache(rec, kind);
          results.push(srdSummary(rec, kind));
        }
      }
      results.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ results, source: 'open5e' });
    } catch (err) { next(err); }
  }

  async function getOne(req, res, next, kinds, field) {
    try {
      const key = String(req.params.key || '');
      if (!KEY_RE.test(key)) throw new ApiError(400, 'BAD_KEY', 'bad key');
      const hit = cachedOne(key, kinds);
      if (hit) return res.json({ [field]: hit.rec, kind: hit.kind, source: 'cache' });
      for (const kind of kinds) {
        const rec = await upstream(`${OPEN5E_HOST}${SRD_ENDPOINTS[kind]}${encodeURIComponent(key)}/`);
        if (!rec) continue;
        if (!isSrdRecord(rec)) throw new ApiError(404, 'NOT_SRD', `${key} is not SRD 5.1 content`);
        cache(rec, kind);
        return res.json({ [field]: rec, kind, source: 'open5e' });
      }
      throw new ApiError(404, 'NOT_FOUND', `${key} is not in the SRD`);
    } catch (err) { next(err); }
  }

  // Cache hits skip the limiter: only requests that will reach Open5e count.
  const searchLimiter = (kindsOf) => limiter('srd', { skip: (req) => safe(() => !term(req) || cachedSearch(kindsOf(req), term(req)).length >= CACHE_HIT_MIN) });
  const getLimiter = (kindsOf) => limiter('srd', { skip: (req) => safe(() => !!cachedOne(String(req.params.key || ''), kindsOf(req))) });
  const spellKinds = () => ['spell'];

  app.get('/api/srd/items', searchLimiter(itemKinds), (req, res, next) => {
    let kinds;
    try { kinds = itemKinds(req); } catch (err) { return next(err); }
    search(req, res, next, kinds);
  });
  app.get('/api/srd/items/:key', getLimiter(itemKinds), (req, res, next) => {
    let kinds;
    try { kinds = itemKinds(req); } catch (err) { return next(err); }
    getOne(req, res, next, kinds, 'item');
  });
  app.get('/api/srd/spells', searchLimiter(spellKinds), (req, res, next) => search(req, res, next, ['spell']));
  app.get('/api/srd/spells/:key', getLimiter(spellKinds), (req, res, next) => getOne(req, res, next, ['spell'], 'spell'));
}
