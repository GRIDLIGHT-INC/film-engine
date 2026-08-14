-- Phase 2: executing a flow.
--
-- Mirrors film_pipeline_runs so the two orchestrators report the same shapes,
-- and borrows NeonCore's WorkflowStep persistence: per-node status, result and
-- routing note on the row.

CREATE TABLE IF NOT EXISTS film_flow_runs (
    id             TEXT PRIMARY KEY,
    flow_id        TEXT NOT NULL,
    project_id     TEXT REFERENCES film_projects(id) ON DELETE CASCADE,
    scene_id       TEXT REFERENCES film_scenes(id) ON DELETE SET NULL,
    shot_id        TEXT REFERENCES film_shots(id) ON DELETE SET NULL,

    -- The graph AS RUN. This is the reproducibility fix: render_ledger can point
    -- at an immutable copy, so editing a flow later cannot silently invalidate
    -- "recreate this exactly". graph_fingerprint indexes it cheaply.
    graph_snapshot    TEXT NOT NULL DEFAULT '{}',
    graph_fingerprint TEXT NOT NULL DEFAULT '',

    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','paused','complete','failed','cancelled')),
    progress_pct   REAL NOT NULL DEFAULT 0,
    error_message  TEXT NOT NULL DEFAULT '',
    params         TEXT NOT NULL DEFAULT '{}',

    started_at     TEXT DEFAULT NULL,
    completed_at   TEXT DEFAULT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS film_flow_node_runs (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES film_flow_runs(id) ON DELETE CASCADE,

    -- Short node id, as the canvas knows it.
    node_id      TEXT NOT NULL,
    node_type    TEXT NOT NULL,

    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','complete','failed','skipped','cancelled')),

    -- Port values this node produced, so a downstream node can read them and a
    -- resumed run does not have to regenerate.
    outputs      TEXT NOT NULL DEFAULT '{}',

    provider_id  TEXT NOT NULL DEFAULT '',
    error        TEXT NOT NULL DEFAULT '',

    -- Why a node ran somewhere other than where it was pinned. Borrowed
    -- verbatim from NeonCore: a provider fallback is NOT an error, and painting
    -- it as one trains users to ignore red.
    routing_note TEXT NOT NULL DEFAULT '',

    started_at   TEXT DEFAULT NULL,
    completed_at TEXT DEFAULT NULL,

    UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_flow_runs_flow     ON film_flow_runs(flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_project  ON film_flow_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_status   ON film_flow_runs(status);
CREATE INDEX IF NOT EXISTS idx_flow_node_runs_run ON film_flow_node_runs(run_id);
