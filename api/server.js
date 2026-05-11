import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  upsertCharacter, getCharacterByDdbId, listRecent,
  getItemSprite, putItemSprite, ITEM_GENERATOR_VERSION
} from './db/database.js';
import { extractCharacterId, fetchDdbCharacter } from './lib/ddb-fetch.js';
import { parseCharacter } from './lib/ddb-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3101;
const PROD = process.env.NODE_ENV === 'production';

const app = express();
app.use(cors({ origin: true, credentials: true }));
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

if (PROD) {
  const distPath = join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => res.sendFile(join(distPath, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`character-forge API listening on http://localhost:${PORT}`);
});
