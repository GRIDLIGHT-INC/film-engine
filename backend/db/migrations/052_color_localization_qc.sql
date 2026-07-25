-- Delivery metadata: ACES/CDL color pipeline, dubbing packages, and broadcast QC.

CREATE TABLE IF NOT EXISTS film_color_pipelines (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    name                TEXT NOT NULL DEFAULT 'Primary delivery color pipeline',
    aces_version        TEXT DEFAULT 'ACES 1.3',
    input_transform     TEXT DEFAULT '',
    working_space       TEXT DEFAULT 'ACEScct',
    output_transform    TEXT DEFAULT 'Rec.709',
    target_color_space  TEXT DEFAULT 'Rec.709',
    target_nits         INTEGER DEFAULT 100,
    cdl_slope           TEXT DEFAULT '[1,1,1]',
    cdl_offset          TEXT DEFAULT '[0,0,0]',
    cdl_power           TEXT DEFAULT '[1,1,1]',
    cdl_saturation      REAL DEFAULT 1.0,
    lut_asset_id        TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    notes               TEXT DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_color_pipeline_project ON film_color_pipelines(project_id);

CREATE TABLE IF NOT EXISTS film_dubbing_jobs (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    source_language     TEXT NOT NULL DEFAULT 'en',
    target_language     TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned', 'queued', 'generating', 'complete', 'failed')),
    voice_strategy      TEXT NOT NULL DEFAULT 'preserve_character'
                        CHECK (voice_strategy IN ('preserve_character', 'new_cast', 'subtitles_only')),
    provider            TEXT DEFAULT '',
    cue_count           INTEGER DEFAULT 0,
    package_json        TEXT NOT NULL DEFAULT '{}',
    output_asset_id     TEXT REFERENCES film_assets(id) ON DELETE SET NULL,
    error_message       TEXT DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dubbing_project ON film_dubbing_jobs(project_id, target_language, status);

CREATE TABLE IF NOT EXISTS film_broadcast_qc_reports (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES film_projects(id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'warning'
                        CHECK (status IN ('pass', 'warning', 'fail')),
    target_spec         TEXT NOT NULL DEFAULT 'streaming_rec709',
    checks_json         TEXT NOT NULL DEFAULT '[]',
    summary             TEXT DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_broadcast_qc_project ON film_broadcast_qc_reports(project_id, created_at DESC);
