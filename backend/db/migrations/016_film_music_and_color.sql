-- Music cues — per-scene or per-shot music direction
CREATE TABLE IF NOT EXISTS film_music_cues (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    scene_id        TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    shot_id         TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    cue_type        TEXT NOT NULL DEFAULT 'score'
                    CHECK (cue_type IN ('score', 'source', 'sfx', 'ambient', 'transition')),
    title           TEXT DEFAULT '',
    description     TEXT DEFAULT '',
    mood            TEXT DEFAULT '',
    genre           TEXT DEFAULT '',
    tempo_bpm       INTEGER DEFAULT 0,
    key_signature   TEXT DEFAULT '',
    instruments     TEXT DEFAULT '[]',
    reference_track TEXT DEFAULT '',
    start_ms        INTEGER DEFAULT 0,
    duration_ms     INTEGER DEFAULT 0,
    volume_db       REAL DEFAULT 0.0,
    fade_in_ms      INTEGER DEFAULT 0,
    fade_out_ms     INTEGER DEFAULT 0,
    generated_asset_id TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    notes           TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_music_cues_project ON film_music_cues(project_id);
CREATE INDEX IF NOT EXISTS idx_film_music_cues_scene ON film_music_cues(scene_id);
CREATE INDEX IF NOT EXISTS idx_film_music_cues_shot ON film_music_cues(shot_id);

-- Color/grade presets — LUTs, film grain, color grading per project or per scene
CREATE TABLE IF NOT EXISTS film_color_presets (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    preset_type     TEXT NOT NULL DEFAULT 'lut'
                    CHECK (preset_type IN ('lut', 'film_grain', 'color_grade', 'look', 'composite')),
    -- LUT
    lut_path        TEXT DEFAULT '',
    -- Film grain
    grain_intensity REAL DEFAULT 0.0,
    grain_size      REAL DEFAULT 1.0,
    -- Color grading
    temperature     REAL DEFAULT 0.0,
    tint            REAL DEFAULT 0.0,
    contrast        REAL DEFAULT 0.0,
    saturation      REAL DEFAULT 0.0,
    highlights      REAL DEFAULT 0.0,
    shadows         REAL DEFAULT 0.0,
    blacks          REAL DEFAULT 0.0,
    whites          REAL DEFAULT 0.0,
    -- Scope
    is_default      INTEGER NOT NULL DEFAULT 0,
    params          TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_color_presets_project ON film_color_presets(project_id);
