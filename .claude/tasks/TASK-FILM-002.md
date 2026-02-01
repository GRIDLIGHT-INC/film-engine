# FILM-002: `film_projects` PostgreSQL table

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs` (append to `MIGRATIONS` array, following existing `Migration { name, sql }` pattern starting at line ~17). SQL: `CREATE TABLE IF NOT EXISTS film_projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, logline TEXT, genre TEXT, status TEXT NOT NULL DEFAULT 'draft', style_preset TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`. Add corresponding PostgreSQL migration in `gateway/src/migration.rs`. Add `FilmProject` struct to `gateway/src/database.rs` alongside existing `Tenant`, `Document`, `Chunk` structs. Add `MetadataBackend` trait methods in `gateway/src/metadata_backend.rs`: `async fn create_film_project(&self, ...) -> Result<FilmProject>`, `async fn get_film_project(&self, id: Uuid) -> Result<Option<FilmProject>>`, `async fn list_film_projects(&self) -> Result<Vec<FilmProject>>`. Implement in both `gateway/src/postgres_backend.rs` (using `sqlx::query_as!`) and `gateway/src/sqlite_backend.rs`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
