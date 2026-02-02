-- 033: Audio deliverables for professional delivery
-- Stores audio specification documents and deliverable metadata

CREATE TABLE IF NOT EXISTS film_audio_deliverables (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'stereo_mix',
    name TEXT NOT NULL DEFAULT '',
    channel_layout TEXT DEFAULT '2.0',
    sample_rate INTEGER DEFAULT 48000,
    bit_depth INTEGER DEFAULT 24,
    lufs_target REAL DEFAULT -24.0,
    codec TEXT DEFAULT 'pcm_s24le',
    file_format TEXT DEFAULT 'wav',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'planned',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES film_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audio_deliverables_project ON film_audio_deliverables (project_id, type);
