-- character-forge SQLite schema

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ddb_id TEXT UNIQUE NOT NULL,
  name TEXT,
  raw_json TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'url',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_characters_ddb_id ON characters(ddb_id);
CREATE INDEX IF NOT EXISTS idx_characters_updated ON characters(updated_at DESC);

CREATE TABLE IF NOT EXISTS item_sprites (
  hash TEXT PRIMARY KEY,
  png_base64 TEXT NOT NULL,
  item_name TEXT NOT NULL,
  base_asset TEXT NOT NULL,
  generator_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_item_sprites_recent ON item_sprites(created_at DESC);

-- M3 — Open5e monster cache. Each row is a single creature's stat block
-- pulled from open5e.com/api/v2/creatures/<slug>/. Cached indefinitely
-- since SRD content rarely changes; refresh by deleting + re-fetching.
CREATE TABLE IF NOT EXISTS monsters (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cr REAL,
  type TEXT,
  size TEXT,
  hp_average INTEGER,
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monsters_name ON monsters(name);
CREATE INDEX IF NOT EXISTS idx_monsters_cr   ON monsters(cr);
