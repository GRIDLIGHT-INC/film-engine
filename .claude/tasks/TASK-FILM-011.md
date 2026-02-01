# FILM-011: `film_characters` table

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Character & Asset Registry (6 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs` (append to `MIGRATIONS` array): `CREATE TABLE IF NOT EXISTS film_characters (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES film_projects(id), name TEXT NOT NULL, description TEXT, appearance_prompt TEXT, lora_id TEXT, ti_token TEXT, voice_id TEXT, default_costume TEXT, personality_notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`. Add `FilmCharacter` struct to `gateway/src/database.rs` with all fields. Add corresponding PostgreSQL migration in `gateway/src/migration.rs`. Implement `MetadataBackend` trait methods in `gateway/src/metadata_backend.rs`: `async fn create_film_character(&self, ...) -> Result<FilmCharacter>`, `async fn get_film_character(&self, id: Uuid) -> Result<Option<FilmCharacter>>`, `async fn get_characters_by_project(&self, project_id: Uuid) -> Result<Vec<FilmCharacter>>`, `async fn update_film_character(...)`, `async fn delete_film_character(...)`. Implement in `gateway/src/postgres_backend.rs` and `gateway/src/sqlite_backend.rs`. Add index: `CREATE INDEX idx_film_characters_project ON film_characters(project_id)`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
