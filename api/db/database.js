import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { runMigrations, getMigrationVersion } from './migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Local-dev fallback when neither CF_DB_PATH nor a data dir is configured. */
export const DEFAULT_DB_PATH = join(__dirname, '..', '..', 'character-forge.db');

/** File name used when the DB path is derived from a data directory. */
export const DB_FILE_NAME = 'character-forge.db';

function isUnder(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Resolve where persistent data lives (M64 B5).
 *
 * - `dataDir`: `CF_DATA_DIR` → `RAILWAY_VOLUME_MOUNT_PATH` → `dirname(dbPath)`.
 *   Uploaded maps and other files go here (Wave 3).
 * - `dbPath`: `CF_DB_PATH` → `<CF_DATA_DIR or volume>/character-forge.db`
 *   → {@link DEFAULT_DB_PATH} (repo root, local dev only).
 *
 * Volume guard: with `NODE_ENV=production` and `RAILWAY_VOLUME_MOUNT_PATH`
 * set (Railway injects it whenever a volume is attached), throws if the DB
 * path or the data dir is not under the mount — otherwise the DB would
 * silently land on the container's ephemeral disk and vanish on redeploy.
 * Production without any volume or path configured only warns, so a local
 * `npm start` still works.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{ dbPath: string, dataDir: string, volume: string|null, warnings: string[] }}
 * @throws {Error} When the production volume guard fails.
 */
export function resolveDataPaths(env = process.env) {
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH || null;
  const baseDir = env.CF_DATA_DIR || volume || null;
  const dbPath = env.CF_DB_PATH || (baseDir ? join(baseDir, DB_FILE_NAME) : DEFAULT_DB_PATH);
  const dataDir = resolve(baseDir || dirname(dbPath));
  const warnings = [];

  if (env.NODE_ENV === 'production') {
    if (volume) {
      if (dbPath === ':memory:' || !isUnder(dbPath, volume)) {
        throw new Error(
          `Refusing to boot: CF_DB_PATH "${dbPath}" is not on the Railway volume mounted at "${volume}". ` +
          'The database would be lost on the next deploy. Unset CF_DB_PATH or point it under the volume.'
        );
      }
      if (!isUnder(dataDir, volume)) {
        throw new Error(
          `Refusing to boot: CF_DATA_DIR "${dataDir}" is not on the Railway volume mounted at "${volume}". ` +
          'Uploaded files would be lost on the next deploy. Unset CF_DATA_DIR or point it under the volume.'
        );
      }
    } else if (!env.CF_DB_PATH && !env.CF_DATA_DIR) {
      warnings.push(`production with no volume, CF_DB_PATH or CF_DATA_DIR: using ${dbPath}, which is not persistent on a PaaS host`);
    }
  }
  return { dbPath, dataDir, volume, warnings };
}

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
      WHERE characters.source <> 'url' OR excluded.source = 'url'
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
        created_at = excluded.created_at,
        hits = 0
      WHERE item_sprites.generator_version < excluded.generator_version`,
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

  /**
   * Insert or update a character by ddb_id. P0-10: a row imported from a
   * D&D Beyond URL (`source='url'`) is never overwritten by a paste.
   * @returns {{id: number}|undefined} undefined when the guard refused the write
   */
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

  /**
   * First write wins (P0-10): a sprite already cached at the current
   * generator version is never overwritten; only stale versions are.
   * @returns {boolean} true when this call stored the sprite
   */
  function putItemSprite({ hash, pngBase64, itemName, baseAsset }) {
    return stmt(SQL.putItemSprite).run(hash, pngBase64, itemName, baseAsset, ITEM_GENERATOR_VERSION, Date.now()).changes > 0;
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
 * @typedef {ReturnType<typeof createQueries> & {
 *   db: import('better-sqlite3').Database,
 *   path: string,
 *   migrationVersion: () => number,
 *   close: () => void
 * }} DbHandle
 */

/**
 * Open (and by default migrate) a SQLite database. Nothing happens at
 * import time; every connection comes from here.
 *
 * WAL and foreign keys are switched on for every connection. When
 * `migrate` is true the migration runner brings the schema up to date
 * first (taking a pre-migration backup for file-backed DBs) and the
 * returned promise rejects if it refuses — the connection is closed in
 * that case.
 *
 * @param {string} path  File path, or ':memory:' for tests.
 * @param {object} [opts]
 * @param {boolean} [opts.migrate=true]     Run pending migrations.
 * @param {string} [opts.migrationsDir]     Override the migrations directory (tests).
 * @param {boolean} [opts.backup=true]      Pre-migration backup for file DBs.
 * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
 * @returns {Promise<DbHandle>} `{ db, path, ...queries, migrationVersion, close }`
 */
export async function openDb(path, { migrate = true, migrationsDir, backup = true, log } = {}) {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    if (migrate) {
      await runMigrations(db, {
        ...(migrationsDir ? { dir: migrationsDir } : {}),
        ...(log ? { log } : {}),
        backup
      });
    }
  } catch (err) {
    db.close();
    throw err;
  }

  /**
   * Checkpoint the WAL and close. Called on graceful shutdown so the
   * WAL/SHM sidecars are folded back before the container exits.
   * Safe to call more than once.
   */
  function close() {
    if (!db.open) return;
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch { /* DB already partially closed; ignore */ }
    db.close();
  }

  return {
    db,
    path,
    ...createQueries(db),
    migrationVersion: () => getMigrationVersion(db),
    close
  };
}
