-- MUS-010: emotion proposals.
--
-- A proposal is a range the model wrote; a director accepts or edits it. Two
-- things the range table did not carry: WHY the model proposed it (a rationale
-- a person reads before accepting — a number with no reason is one nobody can
-- argue with), and WHICH proposal it belongs to, so a batch can be accepted,
-- edited or superseded together. Both default to empty so every existing row
-- is unchanged, and neither is constrained: a rationale is prose and a
-- proposal id is lineage, not a lifecycle.
ALTER TABLE film_music_emotion_ranges ADD COLUMN rationale TEXT NOT NULL DEFAULT '';
ALTER TABLE film_music_emotion_ranges ADD COLUMN proposal_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_film_music_emotion_proposal ON film_music_emotion_ranges(session_id, proposal_id);
