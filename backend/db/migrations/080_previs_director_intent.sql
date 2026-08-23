-- Creative prose and view choices staged in Previs are not camera geometry.
-- Keeping them separate prevents a wording edit from invalidating approval of
-- an unchanged angle, whose fingerprint intentionally hashes camera_json.
ALTER TABLE film_previs_blocking ADD COLUMN director_json TEXT;
ALTER TABLE film_previs_blocking ADD COLUMN applied_fingerprint TEXT DEFAULT NULL;
ALTER TABLE film_previs_blocking ADD COLUMN applied_at TEXT DEFAULT NULL;
