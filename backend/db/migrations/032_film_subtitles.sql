-- 032: Subtitle persistence for SRT/VTT export
-- Stores individual subtitle cues linked to shots and projects

CREATE TABLE IF NOT EXISTS film_subtitles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    shot_id TEXT,
    language TEXT NOT NULL DEFAULT 'en',
    start_ms INTEGER NOT NULL DEFAULT 0,
    end_ms INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL DEFAULT '',
    position TEXT DEFAULT 'bottom-center',
    style TEXT DEFAULT '{}',
    is_cc INTEGER DEFAULT 0,
    speaker TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES film_projects(id) ON DELETE CASCADE,
    FOREIGN KEY (shot_id) REFERENCES film_shots(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_subtitles_project ON film_subtitles (project_id, language, start_ms);
CREATE INDEX IF NOT EXISTS idx_subtitles_shot ON film_subtitles (shot_id);
