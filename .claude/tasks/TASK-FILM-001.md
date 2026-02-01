# FILM-001: Film project CRUD endpoints

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_project_create`, `film_project_get`, `film_project_update`, `film_project_delete` handlers in `gateway/src/handlers.rs`. Register routes in `gateway/src/main.rs` (after line ~1908, near existing POST endpoints): `.route("/film/projects", post(film_project_create).get(film_project_list))` and `.route("/film/projects/:project_id", get(film_project_get).put(film_project_update).delete(film_project_delete))`. Apply `check_auth()` middleware (existing pattern at `handlers.rs:67-80`). Query via `MetadataBackend` trait methods (`create_film_project`, `get_film_project`, `update_film_project`, `delete_film_project`) implemented in both `gateway/src/postgres_backend.rs` and `gateway/src/sqlite_backend.rs`. Add `FilmProject` struct to `gateway/src/types.rs` with `id: Uuid, title: String, logline: Option<String>, genre: Option<String>, status: FilmProjectStatus, style_preset: Option<String>, created_at: DateTime<Utc>, updated_at: DateTime<Utc>`. Add `FilmProjectStatus` enum with Serialize/Deserialize. Return `Json<FilmProject>` on create with `StatusCode::CREATED`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 67-80

## Notes

Part of the Film Engine — Full Production Pipeline epic.
