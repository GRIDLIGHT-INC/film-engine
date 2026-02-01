# FILM-004: Script upload/versioning endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** EXT\.)\s+(.+?)(?:\s*[-–—]\s*(.+))?$")`. On successful parse, populate `film_scenes` table (FILM-005). Write file to `/data/film/projects/{id}/script/v{version}.txt` via `tokio::fs::write()`. Return `Json<FilmScript>` with `scenes_extracted: usize` count. Add `regex = "1"` to `gateway/Cargo.toml` if not present.
- **Created:** 2026-02-01

## Summary

Add `film_script_upload` handler in `gateway/src/handlers.rs`. Register route in `gateway/src/main.rs`: `.route("/film/projects/:project_id/script", post(film_script_upload).get(film_script_list))`. Accept `multipart/form-data` with `file` field (screenplay text) via `axum::extract::Multipart` (same pattern as `upload_structured_file` handler at ~line 2100). Auto-increment version by querying `SELECT MAX(version) FROM film_scripts WHERE project_id = $1`. Parse screenplay into scenes using regex for `INT.`/`EXT.` markers: `regex::Regex::new(r"(?m)^(INT\.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
