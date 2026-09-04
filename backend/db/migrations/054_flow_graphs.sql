-- Phase 1: the flow graph becomes data.
--
-- The pipeline was always a DAG; it was a module-level constant nobody could
-- edit. These tables let a user author one, while the built-in flow (seeded
-- from PIPELINE_STEPS) keeps the existing behaviour reproducible.

CREATE TABLE IF NOT EXISTS film_flows (
    id           TEXT PRIMARY KEY,

    -- NULLABLE on purpose. A null project means a LIBRARY flow, reusable across
    -- every project — "save it once, reuse it across every project". A flow is
    -- promoted to the library by clearing this column, not by being copied, so
    -- the two kinds never diverge into separate tables.
    project_id   TEXT REFERENCES film_projects(id) ON DELETE CASCADE,

    -- Ownership is recorded now while the app is single-user. It costs one
    -- column today and a backfill across every existing flow later.
    owner        TEXT NOT NULL DEFAULT '',

    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',

    -- Built-in flows are immutable through the API; the UI offers
    -- duplicate-to-edit. That keeps the PIPELINE_STEPS equivalence guarantee
    -- true permanently rather than until somebody edits the row.
    is_builtin   INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),

    version      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS film_flow_nodes (
    id          TEXT PRIMARY KEY,
    flow_id     TEXT NOT NULL REFERENCES film_flows(id) ON DELETE CASCADE,

    -- Validated against the runtime registry in lib/flow-node-types.js rather
    -- than a CHECK constraint: SQLite cannot alter a CHECK in place, and the
    -- node palette is expected to grow every phase.
    node_type   TEXT NOT NULL,

    label       TEXT NOT NULL DEFAULT '',
    config      TEXT NOT NULL DEFAULT '{}',

    -- Canvas coordinates live on the row, as a workflow step does elsewhere.
    -- Cosmetic: graphFingerprint deliberately ignores them, so dragging a node
    -- does not invalidate a render-ledger entry.
    position_x  REAL NOT NULL DEFAULT 0,
    position_y  REAL NOT NULL DEFAULT 0,

    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS film_flow_edges (
    id         TEXT PRIMARY KEY,
    flow_id    TEXT NOT NULL REFERENCES film_flows(id) ON DELETE CASCADE,

    from_node  TEXT NOT NULL REFERENCES film_flow_nodes(id) ON DELETE CASCADE,
    from_port  TEXT NOT NULL,
    to_node    TEXT NOT NULL REFERENCES film_flow_nodes(id) ON DELETE CASCADE,
    to_port    TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- The same edge twice is always a mistake. Note this is NOT a uniqueness
    -- constraint on (to_node, to_port): the plan wanted one, but the real
    -- pipeline converges music, sfx and ambient on assembly's audio input, so
    -- arity is declared per port in the node registry and enforced by
    -- validateGraph, which can also explain WHICH edge is the problem.
    UNIQUE (flow_id, from_node, from_port, to_node, to_port)
);

CREATE INDEX IF NOT EXISTS idx_flows_project    ON film_flows(project_id);
CREATE INDEX IF NOT EXISTS idx_flows_builtin    ON film_flows(is_builtin);
CREATE INDEX IF NOT EXISTS idx_flow_nodes_flow  ON film_flow_nodes(flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_edges_flow  ON film_flow_edges(flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_edges_to    ON film_flow_edges(to_node);
