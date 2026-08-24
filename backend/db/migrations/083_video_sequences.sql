-- A SEQUENCE: several shots, ordered, generated as one continuous move.
--
-- Video generation took one picture per shot, so where a shot was GOING could
-- only be described in words. A sequence names the shots it travels between and
-- the description that is true of all of them.
--
-- Stored rather than transient because "enter details for the scene so it's as
-- accurate as possible" is something a director re-runs with adjusted wording;
-- a selection that vanished on generate would make that a retype every time.
CREATE TABLE IF NOT EXISTS film_sequences (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT '',
    -- The shots, IN PLAY ORDER, as a JSON array of ids. Order is the whole
    -- point, so it is stored as a list rather than as a join table that would
    -- need its own sort column to say the same thing.
    shot_ids        TEXT NOT NULL DEFAULT '[]',
    -- What the director typed: true of the whole sequence, carried by every
    -- segment.
    description     TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'draft',
    -- The finished clip, however it was obtained. ON DELETE SET NULL, because
    -- deleting a sequence must not silently unregister a file that exists on
    -- disk and cost money -- the rule film_assets.shot_id already follows.
    output_asset_id TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_sequences_project ON film_sequences(project_id);
