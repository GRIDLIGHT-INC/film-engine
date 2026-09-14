-- The notes a track plays.
--
-- "The score should be where this all happens." A score session is the place
-- with the tracks, the ruler and the mixer, so a track carries what it plays:
-- its notes here, and the instrument that plays them (instrument_id, migration
-- 110). Rendering turns the two into a take in that track's own lane.
--
-- Nullable: every track that exists today plays audio somebody else made, and
-- none of them has notes.
ALTER TABLE film_music_tracks ADD COLUMN notes_json TEXT;
