# FILM-006: `film_shots` table

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs`: `CREATE TABLE IF NOT EXISTS film_shots (id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES film_scenes(id), shot_code TEXT NOT NULL, scene_card_yaml TEXT, status TEXT NOT NULL DEFAULT 'pending', render_job_id TEXT, duration_ms INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`. Add `FilmShot` struct to `gateway/src/database.rs`. Add `FilmShotStatus` enum: `Pending`, `Generating`, `Complete`, `Failed`, `Approved`. Implement `MetadataBackend` trait methods: `create_film_shot`, `get_shot`, `get_shots_by_scene`, `update_shot_status`. Implement in both `gateway/src/postgres_backend.rs` and `gateway/src/sqlite_backend.rs` following existing `create_document` / `get_document_by_id` query patterns. Add index: `CREATE INDEX idx_film_shots_scene_id ON film_shots(scene_id)`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
