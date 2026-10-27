-- M65 phase 2 Wave 4 (E3): run state that waits on someone, persisted so
-- it survives a restart. runs.pending_json holds
--   { rest: { <slotId>: { <Class>: n } },   -- hit dice declared (rest.spend) for the next short rest
--     xp?:  { ... } }                       -- an XP award held for the DM (settings.xpAward 'confirm')
-- Additive only. Never edit this file after it ships (the runner checksums it); add 0008.

ALTER TABLE runs ADD COLUMN pending_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pending_json));
