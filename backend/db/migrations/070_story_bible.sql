-- The material a production is written from, and which entity read which part.
--
-- A story bible is prose: who these people are, how the world works, what the
-- rules of the thing are. None of it reaches an image model. Only four fields
-- do — a character's appearance_prompt, a location's description, a prop's
-- visual_prompt and the project's style_preset — and everything else in this
-- database is decoration as far as a generated frame is concerned.
--
-- So this is NOT a notes field. Pasting a bible somewhere it is merely stored
-- would repeat the mood board's first mistake: a place that collects writing
-- nobody reads is a form. It is a SOURCE, in the same sense the screenplay is
-- one, and the point of keeping it here is the link back — an entity records
-- which section its description was written from, so revising that section
-- flags the entity, and the plates generated from it, as worth re-reading.
--
-- Sectioned rather than one blob, because the flagging has to be precise. A
-- single fingerprint over the whole bible would mark every character in the
-- film stale the moment someone fixed a typo in the world rules, and a warning
-- that fires on work nobody needs to redo is one people learn to dismiss.
--
-- NULL means "not written from the bible", never "stale" — the same rule every
-- other fingerprint here follows, and what keeps this from retroactively
-- flagging every entity that predates it.

CREATE TABLE IF NOT EXISTS film_story_bible (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,

    -- The heading it lives under: a character's name, a place, "World", "Tone".
    -- UNIQUE per project so a section has one body and writing it twice is an
    -- update rather than a second copy nobody notices.
    section      TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',

    -- Of the body alone. What an entity compares itself against.
    fingerprint  TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(project_id, section)
);

CREATE INDEX IF NOT EXISTS idx_story_bible_project ON film_story_bible(project_id);

ALTER TABLE film_characters ADD COLUMN bible_section     TEXT DEFAULT NULL;
ALTER TABLE film_characters ADD COLUMN bible_fingerprint TEXT DEFAULT NULL;
ALTER TABLE film_locations  ADD COLUMN bible_section     TEXT DEFAULT NULL;
ALTER TABLE film_locations  ADD COLUMN bible_fingerprint TEXT DEFAULT NULL;
ALTER TABLE film_props      ADD COLUMN bible_section     TEXT DEFAULT NULL;
ALTER TABLE film_props      ADD COLUMN bible_fingerprint TEXT DEFAULT NULL;
