-- 0003 — M64 W5 (E3): PC sheets persisted with the encounter. Additive
-- only: one nullable column, no rewrite of existing rows.
-- Never edit this file after it ships (the runner checksums it); add 0004.

-- The parsed character sheets the encounter's PCs fight with, keyed by
-- sheetRef.characterId and frozen at dm.encounter.setup (AI archetype
-- included). Boot recovery reads them, so a restart never depends on
-- the seats or the character cache. Server-side only: never broadcast.
-- NULL for encounters built before 0003 (recovery falls back to seats).
ALTER TABLE encounters ADD COLUMN sheets_json TEXT
  CHECK (sheets_json IS NULL OR json_valid(sheets_json));
