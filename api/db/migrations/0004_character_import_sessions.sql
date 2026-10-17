-- 0004 — M64 W5 (E3): which browser session imported which character.
-- Additive only: one new table.
-- Never edit this file after it ships (the runner checksums it); add 0005.

-- GET /api/characters/:ddbId serves a sheet's rules prose (D&D Beyond
-- feature / spell text, often non-SRD) only to the session that imported
-- it; everyone else gets the sheet with that prose stripped. The session
-- is an httpOnly cookie set by POST /api/import; only its sha256 is
-- stored. One row per (character, session): many browsers may import the
-- same public D&D Beyond character.
CREATE TABLE character_import_sessions (
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL CHECK (length(session_hash) BETWEEN 16 AND 128),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (character_id, session_hash)
) STRICT, WITHOUT ROWID;
