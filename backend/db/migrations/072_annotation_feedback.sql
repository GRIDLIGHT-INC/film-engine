-- PAR-026: does markup drive the next generation, or only inform a human?
--
-- Storyboard markup shipped as notation: stored, drawn, kept with the shot, and
-- read by nothing in generation. Feeding it into the prompt is the
-- differentiating version and it is also the one that can quietly ruin a board
-- — a stale arrow from three revisions ago is a standing instruction on every
-- frame generated afterwards, and nothing on the page said so.
--
-- So it is a per-project choice and it is OFF. Default 0 is the whole safety
-- argument: every project that exists today, and every project created without
-- an opinion about this, generates byte-identically to before. A feature that
-- changes what an existing board produces the moment it ships is one nobody can
-- adopt deliberately.
--
-- Per PROJECT rather than per install, because it is a decision about how a
-- particular film is being directed; and overridable per request, because
-- "generate this one with my notes applied" is a thing to try before committing
-- the whole production to it.

ALTER TABLE film_projects ADD COLUMN annotation_feedback INTEGER DEFAULT 0;
