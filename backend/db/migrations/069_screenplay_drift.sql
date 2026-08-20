-- A shot has to know which draft it was written from.
--
-- Artefact staleness answers "does this frame still match its scene card". It
-- does not answer the question a rewrite actually raises: does the CARD still
-- match the screenplay? Nothing recorded the link, so revising scene 3 updated
-- film_scenes.description and left every shot in that scene describing the
-- previous story — valid cards, correctly fingerprinted, quietly about a
-- different film. The only signal was a director reading them.
--
-- Two halves of one fact. The scene stores a fingerprint of the text a card
-- would be built from; the shot stores the fingerprint it WAS built from. They
-- differ exactly when the screenplay moved on without the shot.
--
-- Fingerprint rather than a timestamp comparison: an edit that changes nothing
-- a card is built from — a typo in a character cue, a reformatted transition —
-- would otherwise flag every shot in the scene, and a warning that fires on
-- work nobody needs to redo is a warning people learn to dismiss.
--
-- NULL DEFAULT, and NULL means "outside this workflow" rather than "stale".
-- Every shot that exists today predates this column, and flagging all of them
-- on the first run would make the feature's debut a wall of false alarms.

ALTER TABLE film_scenes ADD COLUMN source_fingerprint TEXT DEFAULT NULL;
ALTER TABLE film_scenes ADD COLUMN source_changed_at  TEXT DEFAULT NULL;
ALTER TABLE film_shots  ADD COLUMN scene_fingerprint  TEXT DEFAULT NULL;
