import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runMigrations } from './migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.CF_DB_PATH || join(__dirname, '..', '..', 'character-forge.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

await runMigrations(db);

// v2: aura no longer baked into per-item PNGs — drawn once by compositor as
// a single backdrop. Old v1 PNGs have stale auras and must not be served.
// v2: aura no longer baked per-item (compositor draws single backdrop).
// v3: FRAME_OVERRIDES applied — bow.png extracts from (0,320,64,64) instead
// of (0,128,64,64). Pre-v3 bow-derived PNGs are stale and must be re-synthesised.
export const ITEM_GENERATOR_VERSION = 3;

/**
 * Build the query functions for a migrated connection. Each statement is
 * prepared once, on first use, and reused for the life of the connection.
 *
 * @param {import('better-sqlite3').Database} conn
 * @returns {object} upsertCharacter, getCharacterByDdbId, listRecent,
 *   getItemSprite, putItemSprite, getMonsterBySlug, searchMonsters, upsertMonster
 */
export function createQueries(conn) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = conn.prepare(sql); cache.set(sql, s); }
    return s;
  };

  const SQL = {
    upsertCharacter: `
      INSERT INTO characters (ddb_id, name, raw_json, parsed_json, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ddb_id) DO UPDATE SET
        name = excluded.name,
        raw_json = excluded.raw_json,
        parsed_json = excluded.parsed_json,
        source = excluded.source,
        updated_at = excluded.updated_at
      RETURNING id`,
    getCharacter: 'SELECT * FROM characters WHERE ddb_id = ?',
    listRecent: `
      SELECT ddb_id, name, source, updated_at
      FROM characters
      ORDER BY updated_at DESC
      LIMIT ?`,
    getItemSprite: 'SELECT png_base64, item_name, base_asset, generator_version FROM item_sprites WHERE hash = ? AND generator_version = ?',
    bumpItemHits: 'UPDATE item_sprites SET hits = hits + 1 WHERE hash = ?',
    putItemSprite: `
      INSERT INTO item_sprites (hash, png_base64, item_name, base_asset, generator_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        png_base64 = excluded.png_base64,
        item_name = excluded.item_name,
        base_asset = excluded.base_asset,
        generator_version = excluded.generator_version,
        created_at = excluded.created_at`,
    getMonster: 'SELECT * FROM monsters WHERE slug = ?',
    searchMonsters: `
      SELECT slug, name, cr, type, size, hp_average
      FROM monsters
      WHERE LOWER(name) LIKE ?
      ORDER BY (cr IS NULL), cr, name
      LIMIT ?`,
    upsertMonster: `
      INSERT INTO monsters (slug, name, cr, type, size, hp_average, payload_json, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        cr = excluded.cr,
        type = excluded.type,
        size = excluded.size,
        hp_average = excluded.hp_average,
        payload_json = excluded.payload_json,
        fetched_at = excluded.fetched_at`
  };

  function upsertCharacter({ ddbId, name, rawJson, parsedJson, source }) {
    const now = Date.now();
    return stmt(SQL.upsertCharacter).get(
      String(ddbId),
      name,
      JSON.stringify(rawJson),
      JSON.stringify(parsedJson),
      source,
      now,
      now
    );
  }

  function getCharacterByDdbId(ddbId) {
    const row = stmt(SQL.getCharacter).get(String(ddbId));
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

  function listRecent(limit = 20) {
    return stmt(SQL.listRecent).all(limit).map(r => ({
      ddbId: r.ddb_id,
      name: r.name,
      source: r.source,
      updatedAt: r.updated_at
    }));
  }

  function getItemSprite(hash) {
    const row = stmt(SQL.getItemSprite).get(hash, ITEM_GENERATOR_VERSION);
    if (!row) return null;
    stmt(SQL.bumpItemHits).run(hash);
    return {
      png: row.png_base64,
      name: row.item_name,
      baseAsset: row.base_asset,
      version: row.generator_version
    };
  }

  function putItemSprite({ hash, pngBase64, itemName, baseAsset }) {
    stmt(SQL.putItemSprite).run(hash, pngBase64, itemName, baseAsset, ITEM_GENERATOR_VERSION, Date.now());
  }

  // M3 — Open5e monster cache. Read-through: callers look up by slug, and
  // only call Open5e on miss. The full creature payload is stored as JSON
  // so future endpoints (full stat block) can use it without re-fetching.
  function getMonsterBySlug(slug) {
    const row = stmt(SQL.getMonster).get(String(slug));
    if (!row) return null;
    return { ...row, payload: tryParseJson(row.payload_json) };
  }

  function searchMonsters(query, limit = 20) {
    const q = `%${String(query).toLowerCase()}%`;
    return stmt(SQL.searchMonsters).all(q, limit);
  }

  function upsertMonster({ slug, name, cr, type, size, hp_average, payload }) {
    stmt(SQL.upsertMonster).run(
      String(slug), String(name || ''), cr ?? null, type ?? null, size ?? null,
      hp_average ?? null, JSON.stringify(payload || {}), Date.now()
    );
  }

  return {
    upsertCharacter, getCharacterByDdbId, listRecent,
    getItemSprite, putItemSprite,
    getMonsterBySlug, searchMonsters, upsertMonster
  };
}

function tryParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

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

export const {
  upsertCharacter, getCharacterByDdbId, listRecent,
  getItemSprite, putItemSprite,
  getMonsterBySlug, searchMonsters, upsertMonster
} = createQueries(db);

export default db;
