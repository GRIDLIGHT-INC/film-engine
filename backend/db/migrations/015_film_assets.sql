-- Film assets table
-- Registry of all generated/uploaded media files
CREATE TABLE IF NOT EXISTS film_assets (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    shot_id         TEXT REFERENCES film_shots(id) ON DELETE SET NULL,
    character_id    TEXT REFERENCES film_characters(id) ON DELETE SET NULL,
    location_id     TEXT REFERENCES film_locations(id) ON DELETE SET NULL,
    asset_type      TEXT NOT NULL
                    CHECK (asset_type IN (
                        'keyframe', 'storyboard', 'video_raw', 'video_synced',
                        'video_final', 'audio_dialogue', 'audio_music', 'audio_sfx',
                        'audio_ambient', 'audio_mix', 'thumbnail', 'reference_image',
                        'character_sheet', 'lora_weights', 'voice_sample',
                        'subtitle', 'export_package', 'fcpxml', 'edl', 'premiere_xml',
                        'lut', 'other'
                    )),
    file_path       TEXT NOT NULL DEFAULT '',
    file_name       TEXT DEFAULT '',
    format          TEXT DEFAULT '',
    mime_type       TEXT DEFAULT '',
    size_bytes      INTEGER DEFAULT 0,
    duration_ms     INTEGER DEFAULT 0,
    width           INTEGER DEFAULT 0,
    height          INTEGER DEFAULT 0,
    metadata        TEXT DEFAULT '{}',
    version         INTEGER DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_film_assets_project ON film_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_film_assets_shot ON film_assets(shot_id);
CREATE INDEX IF NOT EXISTS idx_film_assets_type ON film_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_film_assets_character ON film_assets(character_id);
