-- Gap 5: take / select management
-- Versions existed and could be A/B compared, but there was no "circle take" —
-- no way to mark the chosen take, keep alternates, or assemble a selects reel.
-- With generation, takes are effectively unlimited, which makes selection more
-- important than in traditional production, not less.
--
-- Modelled on film_shot_versions rather than a new table: a take IS a version,
-- and duplicating them would immediately drift.
--
-- NOTE: "at most one select per shot" cannot be a UNIQUE constraint here —
-- SQLite cannot add constraints via ALTER TABLE, and a partial unique index on
-- (shot_id, is_select) would need shot_id, which lives on this table but would
-- still allow multiple is_select=0 rows only. It is enforced transactionally in
-- routes/takes.js instead: selecting a take clears the prior select in the same
-- transaction.

ALTER TABLE film_shot_versions ADD COLUMN is_select INTEGER NOT NULL DEFAULT 0;
ALTER TABLE film_shot_versions ADD COLUMN select_note TEXT DEFAULT '';
ALTER TABLE film_shot_versions ADD COLUMN selected_at TEXT DEFAULT NULL;

-- The selects reel query is "every selected take in this project", so index the
-- select flag alongside the shot it belongs to.
CREATE INDEX IF NOT EXISTS idx_film_shot_versions_select
    ON film_shot_versions(shot_id, is_select);
