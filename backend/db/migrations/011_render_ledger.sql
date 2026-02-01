-- FILM-048: Render ledger — full reproducibility tracking
-- Every render step captures all parameters for deterministic re-renders
CREATE TABLE IF NOT EXISTS render_ledger (
    id              TEXT PRIMARY KEY,
    shot_id         TEXT NOT NULL REFERENCES film_shots(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL DEFAULT 1,
    step            TEXT NOT NULL DEFAULT 'keyframe'
                    CHECK (step IN (
                        'keyframe', 'video', 'voice', 'lipsync',
                        'music', 'sfx', 'ambient', 'post', 'assembly'
                    )),
    -- Model parameters
    model_id        TEXT DEFAULT '',
    model_hash      TEXT DEFAULT '',
    seed            INTEGER DEFAULT -1,
    sampler         TEXT DEFAULT '',
    steps           INTEGER DEFAULT 0,
    guidance        REAL DEFAULT 7.5,
    -- LoRA/ControlNet
    lora_ids        TEXT DEFAULT '[]',
    controlnets     TEXT DEFAULT '[]',
    -- Prompt
    prompt          TEXT DEFAULT '',
    negative_prompt TEXT DEFAULT '',
    -- Camera & lighting (from scene card)
    camera_params   TEXT DEFAULT '{}',
    lighting_params TEXT DEFAULT '{}',
    -- Output
    output_path     TEXT DEFAULT '',
    duration_ms     INTEGER DEFAULT 0,
    resolution      TEXT DEFAULT '',
    fps             INTEGER DEFAULT 24,
    -- Execution
    device          TEXT DEFAULT '',
    inference_ms    INTEGER DEFAULT 0,
    mode            TEXT NOT NULL DEFAULT 'creative'
                    CHECK (mode IN ('locked', 'creative')),
    -- Editor review
    editor_pass     INTEGER DEFAULT NULL,
    editor_notes    TEXT DEFAULT '',
    -- Metadata
    extra_params    TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_render_ledger_shot ON render_ledger(shot_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_render_ledger_step ON render_ledger(step);
