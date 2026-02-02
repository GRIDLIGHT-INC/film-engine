-- FILM-062-064: Export Packages
-- Track unified export jobs (video + audio + NLE)
CREATE TABLE IF NOT EXISTS film_export_packages (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    package_type    TEXT NOT NULL DEFAULT 'unified'
                    CHECK (package_type IN ('unified', 'video_only', 'audio_only', 'stems')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'assembling', 'encoding', 'complete', 'failed')),
    output_path     TEXT DEFAULT '',
    codec           TEXT DEFAULT 'h264',
    resolution      TEXT DEFAULT '1920x1080',
    fps             INTEGER DEFAULT 24,
    bitrate         TEXT DEFAULT '10M',
    audio_codec     TEXT DEFAULT 'aac',
    audio_bitrate   TEXT DEFAULT '320k',
    total_duration_ms INTEGER DEFAULT 0,
    file_size_bytes INTEGER DEFAULT 0,
    error_message   TEXT DEFAULT '',
    params          TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_export_packages_project ON film_export_packages(project_id);
