-- Gap 4: timecoded review
-- Notes could only attach to a shot, never to a moment inside it. "The hand is
-- wrong at 0:03" is the atomic unit of film feedback and was inexpressible.
--
-- timecode_ms is NULL for shot-level notes (every existing note stays valid and
-- keeps its current meaning) and an offset in milliseconds from the start of the
-- shot for timecoded notes. Shot-relative, not timeline-relative, so a note
-- survives reordering shots on the timeline.

ALTER TABLE film_shot_notes ADD COLUMN timecode_ms INTEGER DEFAULT NULL;

-- Notes at a moment are read in playback order, so index shot + timecode.
CREATE INDEX IF NOT EXISTS idx_film_shot_notes_timecode
    ON film_shot_notes(shot_id, timecode_ms);
