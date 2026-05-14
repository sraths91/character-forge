import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  upsertCharacter, getCharacterByDdbId, listRecent,
  getItemSprite, putItemSprite, ITEM_GENERATOR_VERSION,
  getMonsterBySlug, searchMonsters, upsertMonster,
  closeDb
} from './db/database.js';
import { extractCharacterId, fetchDdbCharacter } from './lib/ddb-fetch.js';
import { parseCharacter } from './lib/ddb-parser.js';
import { searchOpen5eCreatures, fetchOpen5eCreature, toSummary } from './lib/open5e.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3101;
const PROD = process.env.NODE_ENV === 'production';

const app = express();
// Railway (and most PaaS hosts) put one HTTPS-terminating proxy in front of
// the app, so req.ip would be the proxy's loopback address without this.
// express-rate-limit also refuses to start when it sees X-Forwarded-For
// without trust proxy configured, so this both enables correct IP-based
// rate limiting AND lets the rate limiter middleware run cleanly.
// '1' = trust one hop (the Railway edge); avoid 'true' which trusts
// arbitrarily-spoofed chains.
if (PROD) app.set('trust proxy', 1);

// CORS: in production, restrict to the explicit allow-list passed via
// ALLOWED_ORIGINS (comma-separated). In dev, reflect any origin to keep
// the Vite proxy + cross-port calls frictionless.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (PROD && ALLOWED_ORIGINS.length === 0) {
  console.warn('[startup] PROD with no ALLOWED_ORIGINS set — falling back to "no origin" (same-origin only)');
}
app.use(cors({
  origin: PROD ? (ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false) : true,
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const importLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

/**
 * POST /api/import
 * Body: { url?: string, characterId?: string, json?: object }
 * Resolves a character from one of three sources, in order of preference:
 *   1. Pre-fetched JSON pasted by the user (private characters)
 *   2. A character id
 *   3. A D&D Beyond share URL (we extract the id)
 */
app.post('/api/import', importLimiter, async (req, res) => {
  const { url, characterId, json } = req.body || {};
  try {
    let raw;
    let source = 'url';
    if (json && typeof json === 'object') {
      raw = json.data ? json.data : json;
      source = 'paste';
    } else {
      const id = characterId || extractCharacterId(url);
      if (!id) {
        return res.status(400).json({
          error: 'Provide a D&D Beyond share URL, character id, or JSON paste.'
        });
      }
      raw = await fetchDdbCharacter(id);
    }

    const parsed = parseCharacter(raw);
    if (!parsed.id) parsed.id = String(raw.id ?? Date.now());

    upsertCharacter({
      ddbId: parsed.id,
      name: parsed.name,
      rawJson: raw,
      parsedJson: parsed,
      source
    });

    res.json({ character: parsed, source });
  } catch (err) {
    const status = err.status || (err.code === 'CHAR_NOT_FOUND' ? 404 : 500);
    res.status(status).json({
      error: err.message,
      code: err.code || 'IMPORT_FAILED'
    });
  }
});

app.get('/api/characters/:ddbId', (req, res) => {
  const row = getCharacterByDdbId(req.params.ddbId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ character: row.parsed });
});

app.get('/api/characters', (_req, res) => {
  res.json({ characters: listRecent(20) });
});

const itemLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});

const HASH_RE = /^[a-f0-9]{40}$/;
const MAX_NAME = 200;

app.get('/api/items/:hash', itemLimiter, (req, res) => {
  if (!HASH_RE.test(req.params.hash)) return res.status(400).json({ error: 'bad hash' });
  const row = getItemSprite(req.params.hash);
  if (!row) return res.status(404).json({ error: 'not cached' });
  res.json({ png: row.png, version: row.version });
});

app.post('/api/items/:hash', itemLimiter, (req, res) => {
  if (!HASH_RE.test(req.params.hash)) return res.status(400).json({ error: 'bad hash' });
  const { png, itemName, baseAsset } = req.body || {};
  if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'png must be a data URL' });
  }
  if (png.length > 200_000) return res.status(413).json({ error: 'png too large' });
  if (typeof itemName !== 'string' || itemName.length > MAX_NAME) {
    return res.status(400).json({ error: 'itemName must be a string ≤200 chars' });
  }
  if (typeof baseAsset !== 'string' || baseAsset.length > MAX_NAME) {
    return res.status(400).json({ error: 'baseAsset must be a string ≤200 chars' });
  }
  putItemSprite({ hash: req.params.hash, pngBase64: png, itemName, baseAsset });
  res.json({ ok: true });
});

app.get('/api/items-version', itemLimiter, (_req, res) => {
  res.json({ version: ITEM_GENERATOR_VERSION });
});

// M3 — Open5e monster search. Cache-first: local DB rows are returned
// instantly; if the cache is empty for this query we fall through to
// Open5e, populate the cache, and return the live results. Rate-limited
// via importLimiter (D&DB import shares the bucket; monster search is
// a similar "outbound fetch" workload).
app.get('/api/monsters/search', importLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length === 0) return res.json({ results: [] });
  try {
    const cached = searchMonsters(q, 20);
    if (cached.length >= 5) {
      // Healthy cache hit — return without going to Open5e
      return res.json({ results: cached.map(r => ({
        slug: r.slug, name: r.name, cr: r.cr, type: r.type, size: r.size, hp: r.hp_average
      })), source: 'cache' });
    }
    const live = await searchOpen5eCreatures(q);
    // Open5e's full-text search returns matches against ANY field, so a
    // query like "goblin" surfaces dozens of creatures whose description
    // happens to mention goblins. Filter client-side to require the
    // query in the name. Fall back to the full list only when nothing
    // matches on name (so esoteric queries like "shapeshifter" still
    // work via flavour-text fallback).
    const ql = q.toLowerCase();
    const nameMatches = live.filter(r => String(r.name || '').toLowerCase().includes(ql));
    const final = nameMatches.length > 0 ? nameMatches : live;
    for (const r of final) {
      try { upsertMonster({ ...r, hp_average: r.hp, payload: r }); } catch { /* ignore */ }
    }
    res.json({ results: final, source: 'open5e' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// M3 — Get a single creature by slug. Cache-first; live fetch fills it.
app.get('/api/monsters/:slug', importLimiter, async (req, res) => {
  const slug = String(req.params.slug || '').trim();
  if (!slug) return res.status(400).json({ error: 'slug required' });
  try {
    const cached = getMonsterBySlug(slug);
    if (cached?.payload) {
      return res.json({ creature: cached.payload, source: 'cache' });
    }
    const creature = await fetchOpen5eCreature(slug);
    const summary = toSummary(creature);
    upsertMonster({ ...summary, hp_average: summary.hp, payload: creature });
    res.json({ creature, source: 'open5e' });
  } catch (err) {
    const code = err.code === 'OPEN5E_NOT_FOUND' ? 404 : 502;
    res.status(code).json({ error: err.message });
  }
});

if (PROD) {
  const distPath = join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => res.sendFile(join(distPath, 'index.html')));
}

const server = app.listen(PORT, () => {
  console.log(`character-forge API listening on http://localhost:${PORT}`);
});

// Graceful shutdown: Railway sends SIGTERM when redeploying. Stop accepting
// new connections, let in-flight requests finish, checkpoint+close the
// SQLite WAL, then exit. Hard-exit after 20s if anything hangs — Railway's
// drainingSeconds budget is 30s so we leave a 10s margin for the platform.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', msg: `${signal} received — graceful shutdown` }));
  // Stop accepting new connections; existing ones drain
  server.close((err) => {
    if (err) console.error('server.close error', err);
    try { closeDb(); } catch (e) { console.error('closeDb error', e); }
    console.log(JSON.stringify({ level: 'info', msg: 'shutdown complete' }));
    process.exit(0);
  });
  // Safety net — if a long-lived connection refuses to close, force exit
  // before Railway delivers SIGKILL at drainingSeconds=30.
  setTimeout(() => {
    console.error(JSON.stringify({ level: 'error', msg: 'shutdown timed out after 20s, forcing exit' }));
    process.exit(1);
  }, 20_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
