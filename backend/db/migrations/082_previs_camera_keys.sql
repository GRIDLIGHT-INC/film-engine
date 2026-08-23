-- Authored camera keys are the director's source; path_json remains the sampled
-- path that was previewed and approved.
ALTER TABLE film_previs_blocking ADD COLUMN camera_keys_json TEXT NOT NULL DEFAULT '[]';
