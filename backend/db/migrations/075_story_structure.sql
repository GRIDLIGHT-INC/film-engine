-- Phase 2b: beat sheets, scene cards and writing directives.
--
-- Each of these was tested against the rule the whole screenplay plan rests on
-- — the Fountain document is the single source of truth, and anything wanting a
-- table has to argue why the format cannot hold it. They did not all answer the
-- same way, and the fourth feature of the phase (per-scene history) is absent
-- from this migration BECAUSE it answered no: every version of every scene is
-- already in film_scripts, one full Fountain per version, so history is derived
-- and a table would store what we can compute and then have to keep in step
-- with the documents it duplicates.

-- BEATS need a table. Fountain cannot say "this scene is the Midpoint" in any
-- form you can query, and the query IS the feature: what is not linked is where
-- the structure has a hole. A `[[note]]` could hold the words and would answer
-- nothing.
--
-- The beat carries its own name, guidance and position rather than pointing at
-- a framework definition, because a writer edits beats — renames them, moves
-- them, deletes the ones that do not apply — and a row that is only a pointer
-- into a constant cannot be edited without editing the constant for everyone.
CREATE TABLE IF NOT EXISTS film_beats (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    framework   TEXT NOT NULL DEFAULT 'three-act',
    name        TEXT NOT NULL,
    guidance    TEXT NOT NULL DEFAULT '',
    at_percent  REAL NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,

    -- ON DELETE SET NULL, not CASCADE. Deleting a scene must not delete the
    -- beat: the beat is the requirement and the scene was one attempt at it, so
    -- losing the scene should reopen the hole rather than pretend the structure
    -- never wanted that beat.
    scene_id    TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,

    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_film_beats_project ON film_beats(project_id, sort_order);

-- SCENE CARDS need columns rather than a table: they are one-to-one with a
-- scene and they are about that scene. Conflict and outcome cannot live in the
-- Fountain — a synopsis line is prose you cannot sort on, and these are fields
-- an outliner filters by.
--
-- They live on film_scenes, which is a PROJECTION of the screenplay, and that is
-- only safe because of two things established earlier: reconciliation rewrites
-- exactly int_ext, location, time_of_day, description and characters_present and
-- nothing else, and scene ids now survive a revision because matching is by
-- content rather than position. Without the second, every rewrite would orphan
-- these.
ALTER TABLE film_scenes ADD COLUMN pov_character TEXT DEFAULT '';
ALTER TABLE film_scenes ADD COLUMN conflict TEXT DEFAULT '';
ALTER TABLE film_scenes ADD COLUMN outcome TEXT DEFAULT '';

-- WRITING DIRECTIVES need one column. How a film should be WRITTEN is not part
-- of what is written, so the format has no home for it.
--
-- Deliberately NOT style_preset. That governs the image and is appended to every
-- image prompt; putting "present tense, no camera directions in action" there
-- would send screenwriting instructions to an image model on every frame. Two
-- fields because there are two audiences.
ALTER TABLE film_projects ADD COLUMN writing_directives TEXT DEFAULT '';
