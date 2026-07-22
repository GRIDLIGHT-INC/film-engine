-- Add the missing scene_id column to film_assets.
--
-- A range of code assumes film_assets has a scene_id column — music score /
-- ambient generation writes (routes/music-gen.js), the scene-scoped music/
-- ambient reads there, and the QA scene checks (lib/qa-checker.js) — but the
-- column was never created (migration 015 only has shot_id / character_id /
-- location_id). With foreign_keys=ON those statements throw
-- "no such column: scene_id", so scene-level music/ambient generation and the
-- QA scene asset checks were effectively broken. Add it (nullable, ON DELETE
-- SET NULL) to bring the schema in line with the code.
ALTER TABLE film_assets ADD COLUMN scene_id TEXT REFERENCES film_scenes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_film_assets_scene ON film_assets(scene_id);
