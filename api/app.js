import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { ITEM_GENERATOR_VERSION } from './db/database.js';
import { extractCharacterId, fetchDdbCharacter, UPSTREAM_TIMEOUT_MS } from './lib/ddb-fetch.js';
import { parseCharacter } from './lib/ddb-parser.js';
import { searchOpen5eCreatures, fetchOpen5eCreature, toSummary } from './lib/open5e.js';
import { createRoomStore } from './rooms/store.js';
import { bearerToken } from './rooms/tokens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default structured logger: one JSON line per event. */
function defaultLog(level, msg, extra = {}) {
  const line = JSON.stringify({ level, msg, ...extra });
  if (level === 'error') console.error(line); else console.log(line);
}

/**
 * Per-route rate limits (windowMs, max). Each route has its own bucket so a
 * DM building an encounter does not starve a player's import (F6).
 */
export const DEFAULT_LIMITS = Object.freeze({
  import: { windowMs: 60_000, max: 20 },
  monsterSearch: { windowMs: 60_000, max: 60 },
  monsterGet: { windowMs: 60_000, max: 120 },
  items: { windowMs: 60_000, max: 200 },
  roomCreate: { windowMs: 3_600_000, max: 5 },
  roomJoin: { windowMs: 60_000, max: 10 }
});

/**
 * An HTTP error carrying a status and a machine-readable code; the JSON
 * error middleware renders it as `{error, code}`.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const REQ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_RE = /^[a-f0-9]{40}$/;
const MAX_NAME = 200;

/**
 * Content-Security-Policy, report-only in phase 1 (M64 B12). The SPA loads
 * one same-origin module script; images may be canvas-generated data/blob
 * URLs; the ws gateway is same-origin.
 */
export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:"
].join('; ');

/**
 * Build the Express app with every route and middleware. No listening, no
 * DB opening, no process hooks — the caller owns those (see start.js).
 *
 * @param {object} opts
 * @param {import('./db/database.js').DbHandle} opts.db  Handle from `openDb`.
 * @param {Record<string, string|undefined>} [opts.env=process.env]
 *   Reads NODE_ENV, ALLOWED_ORIGINS and CF_MULTIPLAYER.
 * @param {string|null} [opts.dataDir]  Reported by /api/health; defaults to
 *   the DB file's directory, or null for an in-memory DB.
 * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
 * @param {typeof fetch} [opts.fetchImpl=fetch]  Upstream fetch (DDB, Open5e); tests inject.
 * @param {number} [opts.upstreamTimeoutMs=8000]
 * @param {Partial<typeof DEFAULT_LIMITS>} [opts.limits]  Override rate limits (tests).
 * @param {(app: import('express').Express, ctx: object) => void} [opts.mount]
 *   Mounts extra `/api` routers (rooms, maps) before the JSON 404.
 * @param {string} [opts.distPath]  Built SPA directory served in production.
 * @returns {import('express').Express}
 */
export function createApp({
  db, env = process.env, dataDir, log = defaultLog,
  fetchImpl = (...a) => fetch(...a), upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
  limits = {}, mount, distPath = join(__dirname, '..', 'dist')
} = {}) {
  if (!db) throw new Error('createApp: db handle (from openDb) is required');
  const healthDataDir = dataDir !== undefined
    ? dataDir
    : (db.path && db.path !== ':memory:' ? dirname(resolve(db.path)) : null);
  const {
    upsertCharacter, getCharacterByDdbId, listRecent,
    getItemSprite, putItemSprite,
    getMonsterBySlug, searchMonsters, upsertMonster
  } = db;
  const PROD = env.NODE_ENV === 'production';
  const MULTIPLAYER = env.CF_MULTIPLAYER === '1';
  const roomStore = createRoomStore(db.db);
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const limiter = (name, extra = {}) => rateLimit({
    ...lim[name], standardHeaders: true, legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' }),
    ...extra
  });

  const app = express();
  app.disable('x-powered-by');
  // Railway (and most PaaS hosts) put one HTTPS-terminating proxy in front of
  // the app, so req.ip would be the proxy's loopback address without this.
  // '1' = trust one hop (the Railway edge); avoid 'true' which trusts
  // arbitrarily-spoofed chains.
  if (PROD) app.set('trust proxy', 1);

  // JSON-line request log with a request id (echoed as X-Request-Id). Only
  // the path is logged — never the query string or headers.
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    const reqId = incoming && REQ_ID_RE.test(incoming) ? incoming : randomUUID();
    req.id = reqId;
    res.setHeader('X-Request-Id', reqId);
    res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (!req.path.startsWith('/api') && req.method === 'GET' && res.statusCode < 400) return; // static assets
      log('info', 'request', {
        reqId, method: req.method, path: req.path, status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1000n) / 1000
      });
    });
    next();
  });

  // CORS: in production, restrict to the explicit allow-list passed via
  // ALLOWED_ORIGINS (comma-separated). In dev, reflect any origin to keep
  // the Vite proxy + cross-port calls frictionless.
  const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (PROD && ALLOWED_ORIGINS.length === 0) {
    log('warn', 'PROD with no ALLOWED_ORIGINS set — falling back to "no origin" (same-origin only)');
  }
  app.use(cors({
    origin: PROD ? (ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false) : true,
    credentials: true
  }));
  app.use('/api', express.json({ limit: '2mb' }));
  app.use(cookieParser());

  /** Resolve the bearer token to a member, optionally of a specific room. */
  function memberOf(req, roomId) {
    const m = roomStore.authenticate(bearerToken(req));
    if (!m) return null;
    if (roomId && m.roomId !== roomId) return null;
    return m;
  }

  // Railway's healthcheck. Touches the DB so a broken or missing volume
  // fails the check instead of passing on a process that cannot persist.
  app.get('/api/health', (_req, res) => {
    try {
      db.db.prepare('SELECT 1').get();
      res.json({
        ok: true,
        time: Date.now(),
        migrationVersion: db.migrationVersion(),
        dataDir: healthDataDir,
        ...(app.locals.health ? app.locals.health() : {})
      });
    } catch (err) {
      log('error', 'health check failed', { error: err.message });
      res.status(503).json({ ok: false, error: 'database unavailable' });
    }
  });

  /**
   * POST /api/import[?room=<roomId>]  (Authorization: Bearer <member token> with ?room)
   * Body: { url?: string, characterId?: string, json?: object }
   * Resolves a character from one of three sources, in order of preference:
   *   1. Pre-fetched JSON pasted by the user (private characters)
   *   2. A character id
   *   3. A D&D Beyond share URL (we extract the id)
   *
   * P0-10: a paste is stored under `paste:<id>` — or `paste:<roomId>:<id>`
   * when imported into a room — so it can never collide with (let alone
   * overwrite) a `source='url'` row, and one room's paste cannot replace
   * another room's. The DB guard refuses any paste over a url row too.
   */
  app.post('/api/import', limiter('import'), async (req, res, next) => {
    const { url, characterId, json } = req.body || {};
    const roomId = typeof req.query.room === 'string' ? req.query.room : null;
    try {
      const member = roomId ? memberOf(req, roomId) : null;
      if (roomId && !member) throw new HttpError(401, 'UNAUTHENTICATED', 'A member token for this room is required');

      let raw;
      let source = 'url';
      if (json && typeof json === 'object') {
        raw = json.data ? json.data : json;
        source = 'paste';
      } else {
        const id = characterId || extractCharacterId(url);
        if (!id) {
          throw new HttpError(400, 'BAD_REQUEST', 'Provide a D&D Beyond share URL, character id, or JSON paste.');
        }
        raw = await fetchDdbCharacter(id, { fetchImpl, timeoutMs: upstreamTimeoutMs });
      }

      const parsed = parseCharacter(raw);
      if (!parsed.id) parsed.id = String(raw.id ?? Date.now());
      if (source === 'paste') {
        parsed.id = member ? `paste:${member.roomId}:${parsed.id}` : `paste:${parsed.id}`;
      }

      // M23 — capture the previous parsed_json BEFORE overwriting so the
      // client can diff and render a "what changed" banner. Falsy when
      // this is the character's first import (no prior row).
      const before = getCharacterByDdbId(parsed.id);
      const previous = before?.parsed || null;

      const row = upsertCharacter({
        ddbId: parsed.id,
        name: parsed.name,
        rawJson: raw,
        parsedJson: parsed,
        source
      });
      if (!row) throw new HttpError(409, 'IMPORT_CONFLICT', 'A character imported from D&D Beyond already uses this id');
      if (member) roomStore.addRoomCharacter({ roomId: member.roomId, characterId: row.id, participantId: member.participantId });

      res.json({ character: parsed, previous, source });
    } catch (err) {
      if (err.code === 'CHAR_NOT_FOUND') return next(new HttpError(404, err.code, err.message));
      next(err);
    }
  });

  app.get('/api/characters/:ddbId', (req, res) => {
    const row = getCharacterByDdbId(req.params.ddbId);
    if (!row) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    res.json({ character: row.parsed });
  });

  // P0-10 / F2: the global "recent imports" list leaks every table's
  // characters. `?room=<roomId>` + a member token scopes it to that room;
  // with CF_MULTIPLAYER=1 the unscoped list is disabled.
  app.get('/api/characters', (req, res, next) => {
    const roomId = typeof req.query.room === 'string' ? req.query.room : null;
    if (roomId) {
      if (!memberOf(req, roomId)) return next(new HttpError(401, 'UNAUTHENTICATED', 'A member token for this room is required'));
      return res.json({ characters: roomStore.listRoomCharacters(roomId) });
    }
    if (MULTIPLAYER) return next(new HttpError(403, 'LIST_DISABLED', 'The global character list is disabled; pass ?room='));
    res.json({ characters: listRecent(20) });
  });

  const itemLimiter = limiter('items');

  app.get('/api/items/:hash', itemLimiter, (req, res) => {
    if (!HASH_RE.test(req.params.hash)) return res.status(400).json({ error: 'bad hash', code: 'BAD_REQUEST' });
    const row = getItemSprite(req.params.hash);
    if (!row) return res.status(404).json({ error: 'not cached', code: 'NOT_FOUND' });
    res.json({ png: row.png, version: row.version });
  });

  // P0-10 / F3: the sprite cache is shared, so writes are first-write-wins
  // (an existing current-version hash is never overwritten) and, in
  // multiplayer mode, only room members may write.
  app.post('/api/items/:hash', itemLimiter, (req, res) => {
    if (MULTIPLAYER && !memberOf(req)) {
      return res.status(401).json({ error: 'A room member token is required', code: 'UNAUTHENTICATED' });
    }
    if (!HASH_RE.test(req.params.hash)) return res.status(400).json({ error: 'bad hash', code: 'BAD_REQUEST' });
    const { png, itemName, baseAsset } = req.body || {};
    if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) {
      return res.status(400).json({ error: 'png must be a data URL', code: 'BAD_REQUEST' });
    }
    if (png.length > 200_000) return res.status(413).json({ error: 'png too large', code: 'TOO_LARGE' });
    if (typeof itemName !== 'string' || itemName.length > MAX_NAME) {
      return res.status(400).json({ error: 'itemName must be a string ≤200 chars', code: 'BAD_REQUEST' });
    }
    if (typeof baseAsset !== 'string' || baseAsset.length > MAX_NAME) {
      return res.status(400).json({ error: 'baseAsset must be a string ≤200 chars', code: 'BAD_REQUEST' });
    }
    const stored = putItemSprite({ hash: req.params.hash, pngBase64: png, itemName, baseAsset });
    res.json({ ok: true, stored });
  });

  app.get('/api/items-version', itemLimiter, (_req, res) => {
    res.json({ version: ITEM_GENERATOR_VERSION });
  });

  // Cache hits skip the limiter: only queries that will reach Open5e count.
  const CACHE_HIT_MIN = 8;
  const searchQuery = (req) => String(req.query.q || '').trim();
  const monsterSearchLimiter = limiter('monsterSearch', {
    skip: (req) => searchQuery(req).length === 0 || searchMonsters(searchQuery(req), 20).length >= CACHE_HIT_MIN
  });
  const monsterGetLimiter = limiter('monsterGet', {
    skip: (req) => !!getMonsterBySlug(String(req.params.slug || '').trim())?.payload
  });

  // M3 — Open5e monster search (SRD 5.1 only). Cache-first: local DB rows
  // are returned instantly; if the cache is thin for this query we fall
  // through to Open5e, populate the cache, and return the live results.
  app.get('/api/monsters/search', monsterSearchLimiter, async (req, res, next) => {
    const q = searchQuery(req);
    if (q.length === 0) return res.json({ results: [] });
    try {
      // Cache lookup MUST itself only return name-matches (LIKE %q%) so
      // pre-existing pollution from older queries can't poison newer
      // searches; require a higher hit bar before short-circuiting Open5e.
      const cached = searchMonsters(q, 20);
      if (cached.length >= CACHE_HIT_MIN) {
        return res.json({ results: cached.map(r => ({
          slug: r.slug, name: r.name, cr: r.cr, type: r.type, size: r.size, hp: r.hp_average
        })), source: 'cache' });
      }
      const live = await searchOpen5eCreatures(q, { fetchImpl, timeoutMs: upstreamTimeoutMs });
      // Require the query in the name; fall back to the full list only when
      // nothing matches on name (esoteric queries still work).
      const ql = q.toLowerCase();
      const nameMatches = live.filter(r => String(r.name || '').toLowerCase().includes(ql));
      const final = nameMatches.length > 0 ? nameMatches : live;
      for (const r of final) {
        try { upsertMonster({ ...r, hp_average: r.hp, payload: r }); } catch { /* ignore */ }
      }
      res.json({ results: final, source: 'open5e' });
    } catch (err) {
      next(err);
    }
  });

  // M3 — Get a single creature by slug. Cache-first; live fetch fills it.
  app.get('/api/monsters/:slug', monsterGetLimiter, async (req, res, next) => {
    const slug = String(req.params.slug || '').trim();
    try {
      const cached = getMonsterBySlug(slug);
      if (cached?.payload) {
        return res.json({ creature: cached.payload, source: 'cache' });
      }
      const creature = await fetchOpen5eCreature(slug, { fetchImpl, timeoutMs: upstreamTimeoutMs });
      const summary = toSummary(creature);
      upsertMonster({ ...summary, hp_average: summary.hp, payload: creature });
      res.json({ creature, source: 'open5e' });
    } catch (err) {
      next(err);
    }
  });

  if (mount) mount(app, { roomStore, limiter, memberOf, HttpError, PROD, MULTIPLAYER });

  // Unknown /api routes are a JSON 404, never the SPA's index.html (F7).
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }));

  if (PROD) {
    app.use(express.static(distPath));
    // M64 C0 — the multiplayer table client, before the SPA catch-all.
    app.get('/play', (_req, res) => res.sendFile(join(distPath, 'play.html')));
    app.get('*', (_req, res) => res.sendFile(join(distPath, 'index.html')));
  }

  // JSON error middleware: `{error, code}`, never a stack; 5xx messages are
  // generic in production. Upstream timeouts become 504.
  app.use((err, req, res, _next) => {
    let status = Number(err.status || err.statusCode) || 500;
    let code = typeof err.code === 'string' ? err.code : 'INTERNAL';
    let message = err.message || 'Error';
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      status = 504; code = 'UPSTREAM_TIMEOUT'; message = 'Upstream service timed out';
    } else if (err.type === 'entity.parse.failed') {
      status = 400; code = 'BAD_JSON'; message = 'Malformed JSON body';
    } else if (err.type === 'entity.too.large') {
      status = 413; code = 'TOO_LARGE'; message = 'Request body too large';
    } else if (status === 404 && code === 'INTERNAL') {
      code = 'NOT_FOUND';
    }
    if (status < 400 || status > 599) status = 500;
    if (status >= 500) {
      log('error', 'request failed', { reqId: req.id, path: req.path, status, code, error: err.message });
      if (PROD && status === 500) { message = 'Internal server error'; code = 'INTERNAL'; }
    }
    if (res.headersSent) return;
    res.status(status).json({ error: message, code });
  });

  return app;
}
