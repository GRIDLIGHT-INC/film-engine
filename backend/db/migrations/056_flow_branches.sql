-- Phase 3: variants.
--
-- Branches are ROWS rather than an in-memory fan-out for two reasons: a paused
-- tf.select has to survive a restart, and the budget ledger has to be able to
-- attribute cost per branch before the user picks one.

CREATE TABLE IF NOT EXISTS film_flow_branches (
    id               TEXT PRIMARY KEY,
    run_id           TEXT NOT NULL REFERENCES film_flow_runs(id) ON DELETE CASCADE,

    -- Nested fan-out: a branch can descend from another branch.
    parent_branch_id TEXT DEFAULT NULL,

    -- The tf.fanout node that produced this branch.
    origin_node_id   TEXT NOT NULL,

    -- Stable, human-readable key: "fan#2". It is what the canvas labels a
    -- variant with and what groups a node-run to its branch.
    branch_key       TEXT NOT NULL,

    -- What makes this variant different (seed, prompt suffix, provider).
    variant_config   TEXT NOT NULL DEFAULT '{}',

    -- Set when a tf.select gate resolves in this branch's favour.
    selected         INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),

    created_at       TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE (run_id, branch_key)
);

CREATE INDEX IF NOT EXISTS idx_flow_branches_run ON film_flow_branches(run_id);

-- film_flow_node_runs gains a branch, and loses UNIQUE(run_id, node_id).
--
-- That constraint was right when a node ran at most once per run, and is
-- exactly wrong now: fanning a generator across three branches means three
-- node-runs for one node id. SQLite cannot drop a constraint in place, so the
-- table is rebuilt — the standard 12-step dance, minus the steps that only
-- matter for tables with dependants.
PRAGMA foreign_keys = OFF;

CREATE TABLE film_flow_node_runs_new (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES film_flow_runs(id) ON DELETE CASCADE,
    node_id      TEXT NOT NULL,
    node_type    TEXT NOT NULL,

    -- NULL for an unbranched run, which is the common case.
    branch_id    TEXT DEFAULT NULL,

    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','complete','failed','skipped','cancelled')),
    outputs      TEXT NOT NULL DEFAULT '{}',
    provider_id  TEXT NOT NULL DEFAULT '',
    error        TEXT NOT NULL DEFAULT '',
    routing_note TEXT NOT NULL DEFAULT '',
    started_at   TEXT DEFAULT NULL,
    completed_at TEXT DEFAULT NULL,

    -- One run of a node PER BRANCH.
    UNIQUE (run_id, node_id, branch_id)
);

INSERT INTO film_flow_node_runs_new
    (id, run_id, node_id, node_type, branch_id, status, outputs, provider_id, error, routing_note, started_at, completed_at)
SELECT id, run_id, node_id, node_type, NULL, status, outputs, provider_id, error, routing_note, started_at, completed_at
FROM film_flow_node_runs;

DROP TABLE film_flow_node_runs;
ALTER TABLE film_flow_node_runs_new RENAME TO film_flow_node_runs;

CREATE INDEX IF NOT EXISTS idx_flow_node_runs_run    ON film_flow_node_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_flow_node_runs_branch ON film_flow_node_runs(branch_id);

PRAGMA foreign_keys = ON;
