-- FEM-001 (GRD-4565): an organisation's own licence for a self-hosted model —
-- a paid FLUX licence, a Fish commercial agreement, Stability Enterprise. The
-- catalog says what the public licence allows; a grant is what THIS
-- organisation was granted on top of it, and production enablement reads both.
-- Append-only: a grant is revoked, never deleted, so the record of who enabled
-- production and on what authority survives the revocation.
CREATE TABLE IF NOT EXISTS film_model_licence_grants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id    TEXT NOT NULL,
    licence_ref TEXT NOT NULL,
    scope       TEXT,
    granted_by  TEXT NOT NULL,
    granted_on  TEXT NOT NULL,
    expires_at  TEXT,
    revoked_at  TEXT,
    revoked_by  TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_model_licence_grants_model ON film_model_licence_grants(model_id);
