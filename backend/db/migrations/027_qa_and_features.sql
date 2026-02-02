-- FILM-014: Character reference sheet jobs
CREATE TABLE IF NOT EXISTS film_refsheet_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    views TEXT DEFAULT '["front","side","back"]',
    model TEXT DEFAULT 'sdxl',
    seed INTEGER,
    output_paths TEXT,
    error_message TEXT,
    params TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES film_projects(id),
    FOREIGN KEY (character_id) REFERENCES film_characters(id)
);

-- FILM-027: Viseme tracks
CREATE TABLE IF NOT EXISTS film_viseme_tracks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    character_id TEXT,
    dialogue_text TEXT,
    viseme_data TEXT,
    duration_ms INTEGER,
    phoneme_count INTEGER,
    audio_aligned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES film_projects(id),
    FOREIGN KEY (shot_id) REFERENCES film_shots(id)
);

-- FILM-033: Stitch jobs for multi-clip videos
CREATE TABLE IF NOT EXISTS film_stitch_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    clip_count INTEGER DEFAULT 0,
    transition_type TEXT DEFAULT 'cross-dissolve',
    output_path TEXT,
    total_duration_ms INTEGER,
    error_message TEXT,
    params TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES film_projects(id),
    FOREIGN KEY (shot_id) REFERENCES film_shots(id)
);

-- FILM-073-075: QA check runs
CREATE TABLE IF NOT EXISTS film_qa_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    scene_id TEXT,
    shot_id TEXT,
    scope TEXT NOT NULL DEFAULT 'project',
    status TEXT NOT NULL DEFAULT 'running',
    total_checks INTEGER DEFAULT 0,
    passed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    warnings INTEGER DEFAULT 0,
    results TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES film_projects(id)
);

-- FILM-093: Audio mix jobs
CREATE TABLE IF NOT EXISTS film_audio_mix_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    shot_id TEXT,
    scene_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    track_count INTEGER DEFAULT 0,
    lufs_target REAL,
    ducking_enabled INTEGER DEFAULT 1,
    output_path TEXT,
    duration_ms INTEGER,
    error_message TEXT,
    params TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES film_projects(id)
);

-- FILM-072: Scheduling runs
CREATE TABLE IF NOT EXISTS film_schedule_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    phase_count INTEGER DEFAULT 0,
    estimated_load_time_s REAL DEFAULT 0,
    estimated_swaps INTEGER DEFAULT 0,
    schedule_data TEXT,
    residency_data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES film_projects(id)
);
