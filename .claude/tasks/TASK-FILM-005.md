# FILM-005: `film_scenes` table + auto-extraction

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs`: `CREATE TABLE IF NOT EXISTS film_scenes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES film_projects(id), scene_number INTEGER NOT NULL, int_ext TEXT, location TEXT, time_of_day TEXT, description TEXT, characters_present TEXT DEFAULT '[]', estimated_duration INTEGER, status TEXT NOT NULL DEFAULT 'written', created_at TEXT NOT NULL DEFAULT (datetime('now')))`. Add `FilmScene` struct to `gateway/src/database.rs` with `characters_present: Vec<String>` (stored as JSON text in SQLite, `JSONB` in PostgreSQL). Implement `MetadataBackend` trait methods: `create_film_scene`, `get_scenes_by_project`, `update_film_scene`. Create scene extraction function `extract_scenes_from_screenplay(text: &str) -> Vec<ParsedScene>` in `gateway/src/handlers.rs` — parse INT/EXT, location, time-of-day, character names (ALL CAPS lines per screenplay format), dialogue blocks. Call from `film_script_upload` handler (FILM-004) after file write. Return ordered scenes with auto-assigned scene numbers.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-004

## Notes

Part of the Film Engine — Full Production Pipeline epic.
