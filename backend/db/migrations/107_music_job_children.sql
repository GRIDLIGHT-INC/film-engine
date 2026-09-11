-- MUS-013: one parent operation, ordered child outputs.
--
-- A generation or a separation is a PARENT operation; each output is a CHILD
-- row pointing at it through group_id. group_id is not parent_id: parent_id is
-- already the lineage of a retry or a supersession ("this attempt retries
-- that one"), and a child is "one output of that operation" — two different
-- relations that one column would conflate.
--
-- CASCADE on group_id: a child is meaningless without its parent. SET NULL on
-- output_clip_id: deleting a take must not delete the record that it was made.
-- Every column is additive with a default, so every existing row is unchanged
-- and reads as a parent of attempt 1.
ALTER TABLE film_music_operations ADD COLUMN group_id TEXT REFERENCES film_music_operations(id) ON DELETE CASCADE;
ALTER TABLE film_music_operations ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE film_music_operations ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE film_music_operations ADD COLUMN take_number INTEGER;
ALTER TABLE film_music_operations ADD COLUMN output_clip_id TEXT REFERENCES film_music_clips(id) ON DELETE SET NULL;
ALTER TABLE film_music_operations ADD COLUMN source_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE film_music_operations ADD COLUMN context_fingerprint TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_film_music_operations_group ON film_music_operations(group_id, seq);
CREATE INDEX IF NOT EXISTS idx_film_music_operations_output_clip ON film_music_operations(output_clip_id);
