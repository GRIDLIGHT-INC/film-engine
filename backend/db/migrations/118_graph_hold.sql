-- PGN-016: hold a node. A held shot, sequence or cue is skipped by every batch
-- run (PGN-017) and stays in the film: conform and export never read this.
-- NULL means not held; a timestamp says since when.
ALTER TABLE film_shots ADD COLUMN held_at TEXT;
ALTER TABLE film_sequences ADD COLUMN held_at TEXT;
ALTER TABLE film_music_cues ADD COLUMN held_at TEXT;
