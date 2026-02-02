-- 030: Shot sequencing and transition metadata
-- Adds sort_order and transition fields to film_shots for timeline sequencing

ALTER TABLE film_shots ADD COLUMN sort_order INTEGER DEFAULT 0;
ALTER TABLE film_shots ADD COLUMN transition_in_type TEXT DEFAULT 'cut';
ALTER TABLE film_shots ADD COLUMN transition_in_duration_ms INTEGER DEFAULT 0;
ALTER TABLE film_shots ADD COLUMN transition_out_type TEXT DEFAULT 'cut';
ALTER TABLE film_shots ADD COLUMN transition_out_duration_ms INTEGER DEFAULT 0;

-- Backfill sort_order from rowid so existing shots have a deterministic order
UPDATE film_shots SET sort_order = rowid;

-- Index for efficient ordering within a scene
CREATE INDEX IF NOT EXISTS idx_shots_scene_sort ON film_shots (scene_id, sort_order);
