-- FEM-001 (GRD-4565): the self-hosted model catalog, as Film Engine last read it,
-- and every change to it. The catalog is authored in gridlight
-- (gateway/assets/model-catalog.json); these tables record what this install
-- saw, when, and what moved, so a licence or region change is never silent.
CREATE TABLE IF NOT EXISTS film_model_catalogs (
    catalog_version INTEGER PRIMARY KEY,
    fingerprint     TEXT NOT NULL,
    body_json       TEXT NOT NULL,
    source          TEXT NOT NULL,
    recorded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS film_model_catalog_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_version    INTEGER,
    to_version      INTEGER NOT NULL,
    from_fingerprint TEXT,
    to_fingerprint  TEXT NOT NULL,
    changes_json    TEXT NOT NULL,
    source          TEXT NOT NULL,
    recorded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
