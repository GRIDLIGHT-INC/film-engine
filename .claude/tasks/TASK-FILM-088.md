# FILM-088: Revision history & shot versioning

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** B: Production Management (8 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add migration in `gateway/src/sqlite_migrations.rs`: `CREATE TABLE IF NOT EXISTS film_shot_versions (id TEXT PRIMARY KEY, shot_id TEXT NOT NULL REFERENCES film_shots(id), version INTEGER NOT NULL, render_ledger_id TEXT, thumbnail_path TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`. Add `FilmShotVersion` struct to `gateway/src/database.rs`. Implement `MetadataBackend` trait methods: `create_shot_version`, `get_versions_by_shot`, `get_latest_version`. On each re-render completion (FILM-051 handler), auto-create a new version entry with incremented version number. Copy final artifacts to versioned subdirectory `/data/film/projects/{pid}/shots/{sid}/versions/v{N}/` via `tokio::fs::copy()`. Add `film_shot_versions_list` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/versions", get(film_shot_versions_list))`. Add revert endpoint: `POST /film/shots/:shot_id/versions/:version/revert` — copies versioned artifacts back to active directories, creates new version entry pointing to reverted content. Return `Json<Vec<FilmShotVersion>>` with thumbnail URLs.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-051

## Notes

Part of the Film Engine — Full Production Pipeline epic.
