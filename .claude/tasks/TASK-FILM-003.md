# FILM-003: `film_scripts` table + screenplay storage

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs`: `CREATE TABLE IF NOT EXISTS film_scripts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES film_projects(id), version INTEGER NOT NULL DEFAULT 1, content_path TEXT NOT NULL, word_count INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`. Add `FilmScript` struct to `gateway/src/database.rs`. Implement `MetadataBackend` trait methods (`create_film_script`, `get_film_scripts_by_project`) in `gateway/src/postgres_backend.rs` and `gateway/src/sqlite_backend.rs`. Create project script directory at `/data/film/projects/{id}/script/` using `tokio::fs::create_dir_all()` on project creation. Store screenplay text files as `v{version}.txt` in the script directory. Use `gateway/src/paths.rs` `DataPaths` pattern for path construction (existing centralized path management from GRID-016).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- GRID-016

## Notes

Part of the Film Engine — Full Production Pipeline epic.
