-- 0005 — M64 phase 1.5 W6 (E3): token images share the map upload table.
-- Additive only: one new column with a default, so every existing row is
-- a 'map'. Never edit this file after it ships (the runner checksums it);
-- add 0006.

-- PUT /api/rooms/:id/maps?kind=token stores a DM token image (≤ 1024 px
-- per side) next to the room's maps, served from the same static path.
-- Per-room counts are kept per kind; the byte quota is shared.
ALTER TABLE uploaded_maps ADD COLUMN kind TEXT NOT NULL DEFAULT 'map' CHECK (kind IN ('map', 'token'));
