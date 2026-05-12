import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.CF_DB_PATH || join(__dirname, '..', '..', 'character-forge.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// v2: aura no longer baked into per-item PNGs — drawn once by compositor as
// a single backdrop. Old v1 PNGs have stale auras and must not be served.
// v2: aura no longer baked per-item (compositor draws single backdrop).
// v3: FRAME_OVERRIDES applied — bow.png extracts from (0,320,64,64) instead
// of (0,128,64,64). Pre-v3 bow-derived PNGs are stale and must be re-synthesised.
export const ITEM_GENERATOR_VERSION = 3;

/**
 * Close the SQLite connection cleanly. Called from the server's SIGTERM
 * handler so WAL checkpoints flush and the WAL/SHM sidecars are released
 * before the container exits. Safe to call multiple times.
 */
export function closeDb() {
  if (db.open) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch { /* DB already partially closed; ignore */ }
    db.close();
  }
}

export function upsertCharacter({ ddbId, name, rawJson, parsedJson, source }) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO characters (ddb_id, name, raw_json, parsed_json, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ddb_id) DO UPDATE SET
      name = excluded.name,
      raw_json = excluded.raw_json,
      parsed_json = excluded.parsed_json,
      source = excluded.source,
      updated_at = excluded.updated_at
    RETURNING id
  `);
  return stmt.get(
    String(ddbId),
    name,
    JSON.stringify(rawJson),
    JSON.stringify(parsedJson),
    source,
    now,
    now
  );
}

export function getCharacterByDdbId(ddbId) {
  const row = db.prepare('SELECT * FROM characters WHERE ddb_id = ?').get(String(ddbId));
  if (!row) return null;
  return {
    id: row.id,
    ddbId: row.ddb_id,
    name: row.name,
    parsed: JSON.parse(row.parsed_json),
    source: row.source,
    updatedAt: row.updated_at
  };
}

export function listRecent(limit = 20) {
  return db.prepare(`
    SELECT ddb_id, name, source, updated_at
    FROM characters
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit).map(r => ({
    ddbId: r.ddb_id,
    name: r.name,
    source: r.source,
    updatedAt: r.updated_at
  }));
}

export function getItemSprite(hash) {
  const row = db.prepare(
    'SELECT png_base64, item_name, base_asset, generator_version FROM item_sprites WHERE hash = ? AND generator_version = ?'
  ).get(hash, ITEM_GENERATOR_VERSION);
  if (!row) return null;
  db.prepare('UPDATE item_sprites SET hits = hits + 1 WHERE hash = ?').run(hash);
  return {
    png: row.png_base64,
    name: row.item_name,
    baseAsset: row.base_asset,
    version: row.generator_version
  };
}

export function putItemSprite({ hash, pngBase64, itemName, baseAsset }) {
  db.prepare(`
    INSERT INTO item_sprites (hash, png_base64, item_name, base_asset, generator_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      png_base64 = excluded.png_base64,
      item_name = excluded.item_name,
      base_asset = excluded.base_asset,
      generator_version = excluded.generator_version,
      created_at = excluded.created_at
  `).run(hash, pngBase64, itemName, baseAsset, ITEM_GENERATOR_VERSION, Date.now());
}

export default db;
