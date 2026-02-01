-- FILM-085: Production notes & revisions per shot
-- Director, editor, and department notes with review workflow
CREATE TABLE IF NOT EXISTS film_shot_notes (
    id              TEXT PRIMARY KEY,
    shot_id         TEXT NOT NULL REFERENCES film_shots(id) ON DELETE CASCADE,
    author          TEXT NOT NULL DEFAULT 'director',
    note_type       TEXT NOT NULL DEFAULT 'direction'
                    CHECK (note_type IN (
                        'direction', 'revision', 'approval', 'rejection',
                        'camera', 'lighting', 'performance', 'continuity',
                        'vfx', 'audio', 'color', 'general'
                    )),
    content         TEXT NOT NULL DEFAULT '',
    priority        TEXT DEFAULT 'normal'
                    CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    resolved        INTEGER NOT NULL DEFAULT 0,
    resolved_at     TEXT DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_shot_notes_shot ON film_shot_notes(shot_id);
CREATE INDEX IF NOT EXISTS idx_film_shot_notes_type ON film_shot_notes(note_type);
CREATE INDEX IF NOT EXISTS idx_film_shot_notes_unresolved ON film_shot_notes(shot_id) WHERE resolved = 0;
