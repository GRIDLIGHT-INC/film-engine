# FILM-048: `render_ledger` PostgreSQL table

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Render Ledger & Reproducibility (4 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs` (append to `MIGRATIONS` array following existing `Migration { name, sql }` pattern): `CREATE TABLE IF NOT EXISTS render_ledger (id TEXT PRIMARY KEY, shot_id TEXT NOT NULL REFERENCES film_shots(id), seed INTEGER, sampler TEXT, steps INTEGER, guidance REAL, model_hash TEXT, lora_ids TEXT DEFAULT '[]', controlnets TEXT DEFAULT '[]', camera_params TEXT DEFAULT '{}', lighting_params TEXT DEFAULT '{}', negative_prompt TEXT, device TEXT, duration_ms INTEGER, mode TEXT NOT NULL DEFAULT 'creative', editor_pass TEXT, editor_notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`. `camera_params` and `lighting_params` stored as JSON text (SQLite) / JSONB (PostgreSQL). Add `RenderLedgerEntry` struct to `gateway/src/database.rs`. Implement `MetadataBackend` trait methods: `create_render_ledger_entry`, `get_ledger_by_shot`, `get_ledger_entry`. Implement in both `gateway/src/postgres_backend.rs` and `gateway/src/sqlite_backend.rs`. Add index: `CREATE INDEX idx_render_ledger_shot ON render_ledger(shot_id)`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
