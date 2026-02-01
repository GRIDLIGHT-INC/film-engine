# FILM-013: `film_locations` table + CRUD

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Character & Asset Registry (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs`: `CREATE TABLE IF NOT EXISTS film_locations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES film_projects(id), name TEXT NOT NULL, description TEXT, reference_prompt TEXT, reference_images TEXT DEFAULT '[]', lighting_defaults TEXT DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`. `reference_images` stored as JSON array of file paths, `lighting_defaults` as JSON object. Add `FilmLocation` struct to `gateway/src/database.rs`. Implement `MetadataBackend` trait methods: `create_film_location`, `get_film_location`, `get_locations_by_project`, `update_film_location`, `delete_film_location`. Add handlers in `gateway/src/handlers.rs`: `film_location_create`, `film_location_get`, `film_location_list`, `film_location_update`, `film_location_delete`. Register routes in `gateway/src/main.rs`: `.route("/film/projects/:project_id/locations", post(film_location_create).get(film_location_list))` and `.route("/film/locations/:location_id", get(film_location_get).put(film_location_update).delete(film_location_delete))`. Create location directory at `/data/film/projects/{pid}/locations/{lid}/`. Support reference image upload via multipart endpoint.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
