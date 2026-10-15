// Versioned SQLite migration runner (M64 B1).
//
// Migrations live in `api/db/migrations/NNNN_name.sql` and are applied in
// version order. Each pending file runs inside `db.transaction`, together
// with its `schema_migrations` row and the `user_version` bump, so a broken
// migration leaves no partial tables and no record. better-sqlite3's
// `db.exec` stops on the first error without rolling back; the transaction
// wrapper is what makes the rollback automatic.
//
// Rules for migration files:
//   - Never edit a file once it has shipped: its sha256 is recorded and a
//     mismatch refuses to boot. Add a new numbered file instead.
//   - No BEGIN/COMMIT/ROLLBACK and no `PRAGMA foreign_keys` — they are
//     no-ops or errors inside the wrapping transaction. A table rebuild
//     that needs them requires a new runner feature, not a workaround.
//   - Additive changes only in phase 1.

import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding the shipped migration files. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** How many `.pre-NNNN.bak` files to keep next to a file-backed DB. */
export const BACKUPS_TO_KEEP = 3;

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const FORBIDDEN_RE = /^\s*(BEGIN|COMMIT|END\s+TRANSACTION|ROLLBACK|PRAGMA\s+foreign_keys)\b/im;

const BOOTSTRAP_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

/**
 * @typedef {object} Migration
 * @property {number} version  Numeric prefix of the file name.
 * @property {string} name     File name, e.g. `0001_baseline.sql`.
 * @property {string} sql      File contents (CRLF normalised to LF).
 * @property {string} checksum sha256 hex of `sql`.
 */

/**
 * Read and validate every migration file in `dir`, sorted by version.
 * Throws on a malformed `.sql` file name, a duplicated version number, or
 * a file that contains transaction-control statements.
 *
 * @param {string} [dir=MIGRATIONS_DIR]
 * @returns {Migration[]}
 */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  const seen = new Map();
  const out = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`migrate: bad migration file name "${file}" (expected NNNN_lower_snake.sql)`);
    const version = Number(m[1]);
    if (seen.has(version)) {
      throw new Error(`migrate: duplicate migration version ${m[1]} ("${seen.get(version)}" and "${file}")`);
    }
    seen.set(version, file);
    const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    if (FORBIDDEN_RE.test(sql)) {
      throw new Error(`migrate: ${file} contains transaction control or PRAGMA foreign_keys; the runner wraps each file in a transaction`);
    }
    out.push({ version, name: file, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

/**
 * Highest applied migration version, or 0 when none is recorded (including
 * a DB that predates the runner and has no `schema_migrations` table).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number}
 */
export function getMigrationVersion(db) {
  const hasTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
  ).get();
  if (!hasTable) return 0;
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get().v;
}

/**
 * Take an online backup of a file-backed DB to `<path>.pre-NNNN.bak` and
 * prune older `.pre-*.bak` files beyond `keep`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} version  First pending version (names the backup).
 * @param {number} keep
 * @returns {Promise<string>} Path of the backup written.
 */
async function backupBeforeMigrating(db, version, keep) {
  const target = `${db.name}.pre-${String(version).padStart(4, '0')}.bak`;
  await db.backup(target);
  const dir = dirname(db.name);
  const prefix = `${basename(db.name)}.pre-`;
  const backups = readdirSync(dir)
    .filter(f => f.startsWith(prefix) && /\.pre-\d{4}\.bak$/.test(f))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    unlinkSync(join(dir, old));
  }
  return target;
}

/** Default structured logger: one JSON line per event. */
function defaultLog(level, msg, extra = {}) {
  const line = JSON.stringify({ level, msg, ...extra });
  if (level === 'error') console.error(line); else console.log(line);
}

/**
 * Bring `db` up to the newest migration in `dir`.
 *
 * - Creates `schema_migrations(version, name, checksum, applied_at)`.
 * - Throws when an applied migration's checksum differs from its file, when
 *   an applied version has no file, or when the DB is newer than the code.
 * - Before applying anything to a file-backed DB that already holds tables,
 *   writes `<db>.pre-NNNN.bak` via `db.backup` and keeps the last
 *   {@link BACKUPS_TO_KEEP}. In-memory and brand-new DBs are not backed up.
 * - Each pending file runs in its own transaction with its bookkeeping row
 *   and `PRAGMA user_version = NNNN`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {string} [opts.dir=MIGRATIONS_DIR] Directory of `NNNN_name.sql` files.
 * @param {boolean} [opts.backup=true]       Take the pre-migration backup.
 * @param {number} [opts.keepBackups=BACKUPS_TO_KEEP]
 * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
 * @param {() => number} [opts.now=Date.now]
 * @returns {Promise<{ applied: string[], version: number, backupPath: string|null }>}
 */
export async function runMigrations(db, {
  dir = MIGRATIONS_DIR,
  backup = true,
  keepBackups = BACKUPS_TO_KEEP,
  log = defaultLog,
  now = Date.now
} = {}) {
  const migrations = loadMigrations(dir);
  const codeVersion = migrations.length ? migrations[migrations.length - 1].version : 0;
  const hadTables = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).get().n > 0;

  db.exec(BOOTSTRAP_SQL);
  const applied = new Map(
    db.prepare('SELECT version, name, checksum FROM schema_migrations').all().map(r => [r.version, r])
  );

  const dbVersion = applied.size ? Math.max(...applied.keys()) : 0;
  if (dbVersion > codeVersion) {
    throw new Error(`migrate: database is at version ${dbVersion} but this code only knows up to ${codeVersion}; refusing to boot an older build against a newer database`);
  }
  const byVersion = new Map(migrations.map(m => [m.version, m]));
  for (const [version, row] of applied) {
    const file = byVersion.get(version);
    if (!file) throw new Error(`migrate: applied migration ${row.name} is missing from ${dir}`);
    if (file.checksum !== row.checksum) {
      throw new Error(`migrate: ${file.name} was edited after it was applied (checksum mismatch); add a new migration instead`);
    }
  }

  const pending = migrations.filter(m => !applied.has(m.version));
  if (pending.length === 0) return { applied: [], version: dbVersion, backupPath: null };

  let backupPath = null;
  if (backup && hadTables && !db.memory) {
    backupPath = await backupBeforeMigrating(db, pending[0].version, keepBackups);
    log('info', 'migrate: pre-migration backup written', { backupPath });
  }

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
  );
  const appliedNames = [];
  for (const m of pending) {
    try {
      db.transaction(() => {
        db.exec(m.sql);
        record.run(m.version, m.name, m.checksum, now());
        db.pragma(`user_version = ${m.version}`);
      })();
    } catch (err) {
      log('error', 'migrate: migration failed and was rolled back', { migration: m.name, error: err.message });
      throw new Error(`migrate: ${m.name} failed and was rolled back: ${err.message}`, { cause: err });
    }
    appliedNames.push(m.name);
    log('info', 'migrate: applied', { migration: m.name });
  }
  return { applied: appliedNames, version: pending[pending.length - 1].version, backupPath };
}
