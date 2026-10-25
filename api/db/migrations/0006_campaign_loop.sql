-- 0006 — M65 phase 2 B21 (E3): the campaign loop. Additive only: eleven
-- new tables, one view, new columns on party_slots and encounters, no
-- table rebuilt (docs/M65-CAMPAIGN-LOOP-PLAN.md "Data model", 15 steps;
-- step 14, uploaded_maps.kind, already shipped in 0005).
-- Never edit this file after it ships (the runner checksums it); add 0007.
--
-- ADD COLUMN with REFERENCES / CHECK / NOT NULL DEFAULT on a STRICT table
-- inside the runner's transaction: verified on better-sqlite3 13 (SQLite
-- 3.5x). A REFERENCES column must default to NULL; every CHECK is
-- evaluated against the existing rows when the column is added.

-- 1. A DM's campaign. Ownership is a 256-bit bearer key, stored only as
-- its sha256 (decision 5); owner_user_id waits for Discord OAuth.
CREATE TABLE campaigns (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  owner_key_hash TEXT NOT NULL UNIQUE CHECK (length(owner_key_hash) BETWEEN 16 AND 128),
  owner_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  ruleset        TEXT NOT NULL DEFAULT 'srd-5.1' CHECK (length(ruleset) BETWEEN 1 AND 32),
  settings_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),   -- {xpMode, hpOnLevel, deathMode, levelUpMode, dawnIsLongRest, xpAward}
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  archived_at    INTEGER
) STRICT;

-- 2. The node graph (src/js/shared/campaign.js node v1). Node ids are the
-- DM's, unique per campaign, so `next_json` edges survive export/import.
-- is_start mirrors node v1 `start: true` (at most one per campaign).
CREATE TABLE campaign_nodes (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  id           TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  ord          INTEGER NOT NULL DEFAULT 0 CHECK (ord >= 0),
  kind         TEXT NOT NULL CHECK (kind IN ('encounter', 'rest', 'loot', 'shop', 'story')),
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  is_start     INTEGER NOT NULL DEFAULT 0 CHECK (is_start IN (0, 1)),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  next_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(next_json) AND json_type(next_json) = 'array'),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_campaign_nodes_ord ON campaign_nodes(campaign_id, ord);
CREATE UNIQUE INDEX ux_campaign_nodes_one_start ON campaign_nodes(campaign_id) WHERE is_start = 1;

-- 3. Saved `dm.encounter.setup` payloads (setupPayload(draft) shape); an
-- image map points at a campaign_assets row.
CREATE TABLE encounter_templates (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  setup_json  TEXT NOT NULL CHECK (json_valid(setup_json)),
  setup_v     INTEGER NOT NULL DEFAULT 1 CHECK (setup_v >= 1),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_encounter_templates_campaign ON encounter_templates(campaign_id);

-- 4. Campaign maps and token images ('campaigns/<id>/<sha>.<ext>' under
-- the data dir), the uploaded_maps caps; copied into a room's
-- uploaded_maps on node entry (ux_uploaded_maps_room_sha dedupes).
CREATE TABLE campaign_assets (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'map' CHECK (kind IN ('map', 'token')),
  rel_path    TEXT NOT NULL,
  mime        TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes       INTEGER NOT NULL CHECK (bytes > 0),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  width       INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height      INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
  grid_json   TEXT CHECK (grid_json IS NULL OR json_valid(grid_json)),
  created_at  INTEGER NOT NULL,
  CHECK (width * height <= 16777216)
) STRICT;
CREATE UNIQUE INDEX ux_campaign_assets_sha ON campaign_assets(campaign_id, sha256);

-- 5. A party playing a campaign. The run pins its room (decision 2):
-- room_id is UNIQUE and a plain FK, so deleting the room of a run fails.
-- campaign_json is the graph frozen at start (decision 4).
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  room_id         TEXT NOT NULL UNIQUE REFERENCES rooms(id),
  status          TEXT NOT NULL DEFAULT 'lobby'
                  CHECK (status IN ('lobby', 'in-node', 'between', 'paused', 'ended')),
  outcome         TEXT CHECK (outcome IS NULL OR outcome IN ('victory', 'defeat', 'abandoned')),
  current_node_id TEXT,
  campaign_json   TEXT NOT NULL CHECK (json_valid(campaign_json)),
  settings_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  stash_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stash_json)),
  rng_json        TEXT CHECK (rng_json IS NULL OR json_valid(rng_json)),
  seq             INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),       -- last run_events.seq
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK (status = 'ended' OR outcome IS NULL)
) STRICT;
CREATE INDEX idx_runs_campaign ON runs(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX idx_runs_ended ON runs(ended_at) WHERE status = 'ended';

-- 6. The run log (run event catalogue v1); mutating types carry
-- {before, after} in payload_json.
CREATE TABLE run_events (
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq >= 1),
  ts           INTEGER NOT NULL,
  node_id      TEXT,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('dm', 'player', 'system')),
  actor_id     TEXT,
  type         TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  override     INTEGER NOT NULL DEFAULT 0 CHECK (override IN (0, 1)),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  PRIMARY KEY (run_id, seq)
) STRICT, WITHOUT ROWID;

-- 7. Between-node save points.
CREATE TABLE run_snapshots (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  label      TEXT CHECK (label IS NULL OR length(label) <= 80),
  at_seq     INTEGER NOT NULL CHECK (at_seq >= 0),
  blob_json  TEXT NOT NULL CHECK (json_valid(blob_json)),
  created_by TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_run_snapshots_run ON run_snapshots(run_id, at_seq);

-- 8. Inventory: a seat's items, or the party stash (owner_slot_id NULL).
CREATE TABLE run_items (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  owner_slot_id TEXT REFERENCES party_slots(id) ON DELETE SET NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('ddb', 'open5e', 'dm')),
  ref_key       TEXT CHECK (ref_key IS NULL OR length(ref_key) <= 128),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  qty           INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 0),
  equipped      INTEGER NOT NULL DEFAULT 0 CHECK (equipped IN (0, 1)),
  attuned       INTEGER NOT NULL DEFAULT 0 CHECK (attuned IN (0, 1)),
  charges_spent INTEGER NOT NULL DEFAULT 0 CHECK (charges_spent >= 0),
  data_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_run_items_owner ON run_items(run_id, owner_slot_id);

-- 9. The level-up queue: one row per crossed threshold.
CREATE TABLE level_ups (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  slot_id      TEXT NOT NULL REFERENCES party_slots(id) ON DELETE CASCADE,
  from_level   INTEGER NOT NULL CHECK (from_level BETWEEN 1 AND 19),
  to_level     INTEGER NOT NULL CHECK (to_level BETWEEN 2 AND 20),
  class_name   TEXT CHECK (class_name IS NULL OR length(class_name) <= 64),
  mode         TEXT NOT NULL CHECK (mode IN ('auto', 'choose', 'reconcile')),
  status       TEXT NOT NULL DEFAULT 'pending_player'
               CHECK (status IN ('pending_player', 'pending_dm', 'applied', 'reverted')),
  auto_json    TEXT CHECK (auto_json IS NULL OR json_valid(auto_json)),
  choices_json TEXT CHECK (choices_json IS NULL OR json_valid(choices_json)),
  granted_json TEXT CHECK (granted_json IS NULL OR json_valid(granted_json)),
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT,
  CHECK (to_level = from_level + 1)
) STRICT;
CREATE INDEX idx_level_ups_run ON level_ups(run_id, status);
CREATE INDEX idx_level_ups_pending ON level_ups(slot_id) WHERE status IN ('pending_player', 'pending_dm');

-- 10. A retired or replaced character, copied out before its seat is
-- reused (UNIQUE(room_id, seat) on party_slots stays as it is).
CREATE TABLE run_roster_archive (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  slot_id      TEXT NOT NULL,
  seat         INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 6),
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  name         TEXT,
  sheet_json   TEXT CHECK (sheet_json IS NULL OR json_valid(sheet_json)),
  state_json   TEXT CHECK (state_json IS NULL OR json_valid(state_json)),
  level        INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 20),
  xp           INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  life_status  TEXT NOT NULL CHECK (life_status IN ('active', 'dying', 'stable', 'dead')),
  reason       TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
  archived_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_run_roster_archive_run ON run_roster_archive(run_id);

-- 11. Open5e SRD item / spell cache. Only the SRD 5.1 document is ever
-- admitted (licensing: non-SRD prose is never cached).
CREATE TABLE items_cache (
  key          TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 128),
  document_key TEXT NOT NULL CHECK (document_key = 'srd-2014'),
  kind         TEXT NOT NULL CHECK (kind IN ('item', 'magicitem', 'spell')),
  name         TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  fetched_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_items_cache_name ON items_cache(kind, name);

-- 12. run_characters is party_slots extended in place (decision 1).
ALTER TABLE party_slots ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE party_slots ADD COLUMN level INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 20);
ALTER TABLE party_slots ADD COLUMN xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0);
ALTER TABLE party_slots ADD COLUMN life_status TEXT NOT NULL DEFAULT 'active'
  CHECK (life_status IN ('active', 'dying', 'stable', 'dead'));
ALTER TABLE party_slots ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);   -- optimistic lock
ALTER TABLE party_slots ADD COLUMN seed_raw_sha TEXT CHECK (seed_raw_sha IS NULL OR length(seed_raw_sha) = 64);
CREATE INDEX idx_party_slots_run ON party_slots(run_id) WHERE run_id IS NOT NULL;

-- 13. The phase-2 name for a run's seats.
CREATE VIEW run_characters AS
  SELECT id, run_id, room_id, seat, character_id, seed_parsed_json, sheet_json, state_json,
         controller_participant_id, ai_archetype, level, xp, life_status, version, seed_raw_sha,
         claimed_at, updated_at
  FROM party_slots
  WHERE run_id IS NOT NULL;

-- 14. uploaded_maps.kind: shipped in 0005_map_kind.sql.

-- 15. Which run and node an encounter belongs to, and when its result was
-- written back to the run (once; boot recovery applies ended encounters
-- whose mark is still NULL).
ALTER TABLE encounters ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE encounters ADD COLUMN node_id TEXT;
ALTER TABLE encounters ADD COLUMN run_applied_at INTEGER;
CREATE INDEX idx_encounters_run_unapplied ON encounters(run_id)
  WHERE run_id IS NOT NULL AND run_applied_at IS NULL;
