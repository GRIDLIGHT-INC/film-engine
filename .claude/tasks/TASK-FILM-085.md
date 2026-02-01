# FILM-085: Production notes & revisions

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** B: Production Management (8 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs`: `CREATE TABLE IF NOT EXISTS film_shot_notes (id TEXT PRIMARY KEY, shot_id TEXT NOT NULL REFERENCES film_shots(id), author TEXT, note_type TEXT NOT NULL DEFAULT 'direction', content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`. Valid `note_type` values: `direction`, `revision`, `approval`, `rejection`. Add `FilmShotNote` struct to `gateway/src/database.rs`. Implement `MetadataBackend` trait methods: `create_shot_note`, `get_notes_by_shot`. Add `film_shot_note_create` and `film_shot_notes_list` handlers in `gateway/src/handlers.rs`. Register routes: `.route("/film/shots/:shot_id/notes", post(film_shot_note_create).get(film_shot_notes_list))`. Support query param `?note_type=revision` for filtering. Return `Json<Vec<FilmShotNote>>` sorted by `created_at` descending. On `approval` note, auto-update shot status to `Approved` via `MetadataBackend::update_shot_status()`. On `rejection` note, set status back to `Pending`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
