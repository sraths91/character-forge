-- 0002 — M64 phase 1 multiplayer foundation (B2). Additive only: new
-- tables, no changes to characters / item_sprites / monsters.
-- Never edit this file after it ships (the runner checksums it); add 0003.

-- Forward-compat stub for real accounts. Never written in phase 1; Discord
-- OAuth later inserts rows and back-fills participants.user_id.
CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  display_name     TEXT,
  avatar_url       TEXT,
  created_at       INTEGER NOT NULL,
  UNIQUE (provider, provider_user_id)
) STRICT;

CREATE TABLE rooms (
  id             TEXT PRIMARY KEY,               -- 128-bit random, base64url; used in paths
  code           TEXT NOT NULL
                 CHECK (length(code) = 6 AND code NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  dm_token_hash  TEXT NOT NULL UNIQUE,           -- sha256(dm token), base64url; the token is never stored
  name           TEXT CHECK (name IS NULL OR length(name) <= 64),
  status         TEXT NOT NULL DEFAULT 'lobby'
                 CHECK (status IN ('lobby', 'active', 'closed')),
  settings_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  seq            INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),   -- room-monotonic broadcast seq
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  closed_at      INTEGER
) STRICT;
-- Codes are unique among open rooms only, so closed rooms free their code.
CREATE UNIQUE INDEX ux_rooms_code_open ON rooms(code) WHERE status <> 'closed';
CREATE INDEX idx_rooms_last_active ON rooms(last_active_at);

-- People at the table. The DM authenticates with rooms.dm_token_hash, so
-- token_hash is NULL for role='dm' and required for players.
CREATE TABLE participants (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,   -- NULL until accounts exist
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 32),
  role         TEXT NOT NULL CHECK (role IN ('dm', 'player')),
  token_hash   TEXT UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'kicked', 'left')),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  CHECK (role = 'dm' OR token_hash IS NOT NULL)
) STRICT;
CREATE INDEX idx_participants_room ON participants(room_id);
CREATE UNIQUE INDEX ux_participants_one_dm
  ON participants(room_id) WHERE role = 'dm' AND status = 'active';

-- Characters imported into a room (by any member, with the room token).
-- Scopes GET /api/characters and seat assignment in multiplayer mode.
CREATE TABLE room_characters (
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  character_id   INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  added_at       INTEGER NOT NULL,
  PRIMARY KEY (room_id, character_id)
) STRICT, WITHOUT ROWID;

-- Party seats (up to 6). A seat holds a character and is controlled by a
-- participant OR by the AI (controller_participant_id NULL). Own id so
-- phase 2's run_characters is a rename, not a rebuild. sheet/state split
-- per R3: seed_parsed_json is parsed_json frozen at claim, sheet_json the
-- derived sheet, state_json the mutable state v1 (hp, slots, resources...).
CREATE TABLE party_slots (
  id                        TEXT PRIMARY KEY,
  room_id                   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seat                      INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 6),
  character_id              INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  seed_parsed_json          TEXT CHECK (seed_parsed_json IS NULL OR json_valid(seed_parsed_json)),
  sheet_json                TEXT CHECK (sheet_json IS NULL OR json_valid(sheet_json)),
  state_json                TEXT CHECK (state_json IS NULL OR json_valid(state_json)),
  controller_participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,  -- NULL = AI
  ai_archetype              TEXT CHECK (ai_archetype IS NULL OR length(ai_archetype) BETWEEN 1 AND 64),
  claimed_at                INTEGER,
  updated_at                INTEGER NOT NULL,
  UNIQUE (room_id, seat),
  CHECK (controller_participant_id IS NULL OR character_id IS NOT NULL OR seed_parsed_json IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX ux_party_slots_one_per_player
  ON party_slots(room_id, controller_participant_id)
  WHERE controller_participant_id IS NOT NULL;

CREATE TABLE uploaded_maps (
  id                         TEXT PRIMARY KEY,   -- 128-bit random
  room_id                    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  rel_path                   TEXT NOT NULL,      -- 'maps/<room_id>/<sha256>.<ext>' relative to the data dir
  mime                       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes                      INTEGER NOT NULL CHECK (bytes > 0),
  sha256                     TEXT NOT NULL CHECK (length(sha256) = 64),
  width                      INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height                     INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
  grid_json                  TEXT CHECK (grid_json IS NULL OR json_valid(grid_json)),
  uploaded_by_participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  created_at                 INTEGER NOT NULL,
  CHECK (width * height <= 16777216)
) STRICT;
CREATE INDEX idx_uploaded_maps_room ON uploaded_maps(room_id);
CREATE UNIQUE INDEX ux_uploaded_maps_room_sha ON uploaded_maps(room_id, sha256);

CREATE TABLE encounters (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'setup'
                 CHECK (status IN ('setup', 'active', 'ended', 'abandoned')),
  engine_version INTEGER NOT NULL,      -- refuse replay across incompatible engine builds
  map_id         TEXT REFERENCES uploaded_maps(id) ON DELETE SET NULL,
  snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),  -- EncounterState v1 (incl. rng) as of snapshot_seq
  snapshot_seq   INTEGER NOT NULL DEFAULT 0,
  head_seq       INTEGER NOT NULL DEFAULT 0,
  turn_log_json  TEXT CHECK (turn_log_json IS NULL OR json_valid(turn_log_json)),  -- in-flight turn: id + prompt answers, for replay
  outcome        TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  CHECK (snapshot_seq >= 0 AND snapshot_seq <= head_seq)
) STRICT;
CREATE INDEX idx_encounters_room ON encounters(room_id);
CREATE UNIQUE INDEX ux_encounters_one_live
  ON encounters(room_id) WHERE status IN ('setup', 'active');

CREATE TABLE encounter_events (
  encounter_id TEXT NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq >= 1),
  type         TEXT NOT NULL,          -- events.js EVENT_TYPES
  event_json   TEXT NOT NULL CHECK (json_valid(event_json)),   -- the whole event {seq,type,round,turnId,cinemaGroup,payload}
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (encounter_id, seq)
) STRICT, WITHOUT ROWID;
