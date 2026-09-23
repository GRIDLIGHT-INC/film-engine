-- AN EDIT MADE OUTSIDE FILM ENGINE, KEPT BY VERSION.
--
-- A cut finished in Premiere (or Resolve) is exported as a picture file and,
-- optionally, the XML or EDL it was cut from. Each import is a new VERSION:
-- v1, v2, v3 — never overwritten, because a score written against v2 has to
-- stay honest about which cut it was timed to.
--
-- `cut_json` is the parsed cut: every event on the timeline with its start and
-- length in the EDIT's time, and which Film Engine shot it is (or that it is
-- none). It is what lets a score follow the edit rather than the assembly.
CREATE TABLE IF NOT EXISTS film_edits (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL CHECK (version >= 1),
    name          TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    -- The picture file. SET NULL: a deleted asset leaves the record saying so,
    -- rather than taking the cut list and every score's pointer with it.
    asset_id      TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    duration_ms   INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    frame_rate    REAL,
    width         INTEGER,
    height        INTEGER,
    has_audio     INTEGER NOT NULL DEFAULT 0 CHECK (has_audio IN (0, 1)),
    cut_json      TEXT NOT NULL DEFAULT '',
    cut_format    TEXT CHECK (cut_format IS NULL OR cut_format IN ('xmeml', 'edl')),
    cut_asset_id  TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    cut_imported_at TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_film_edits_project ON film_edits(project_id, version);

-- A score session can be written against an edit: its picture is the cut, its
-- length is the edit's, and its stems line up with the edit's first frame.
-- SET NULL, never CASCADE: deleting an edit must not delete the music.
ALTER TABLE film_music_sessions ADD COLUMN edit_id TEXT REFERENCES film_edits(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_film_music_sessions_edit ON film_music_sessions(edit_id);
