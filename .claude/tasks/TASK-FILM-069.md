# FILM-069: Tauri commands for film engine

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Desktop App Integration (5 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `desktop/src-tauri/src/commands/film.rs`. Add `pub mod film;` to `desktop/src-tauri/src/commands/mod.rs` (line ~21). Implement Tauri commands: `#[tauri::command] async fn film_list_projects() -> Result<Vec<FilmProject>, String>` (calls gateway `GET /film/projects`), `film_create_project(title, logline, genre)` (calls `POST /film/projects`), `film_get_dashboard(project_id)` (calls `GET /film/projects/{id}/dashboard`), `film_get_shotlist(project_id)` (calls `GET /film/projects/{id}/shotlist`), `film_get_storyboard(project_id)` (calls `GET /film/projects/{id}/storyboard`), `film_generate_storyboard(project_id)` (calls `POST /film/projects/{id}/storyboard`), `film_rerender_shot(shot_id)` (calls `POST /film/shots/{id}/re-render`), `film_export_project(project_id)` (calls `POST /film/projects/{id}/export`). Use `reqwest::Client` for HTTP calls to gateway (follow pattern from `desktop/src-tauri/src/commands/health.rs`). Add TypeScript types to `desktop/src/lib/types.ts`: `FilmProject`, `FilmShot`, `StoryboardFrame`, `DashboardResponse`. Add TypeScript wrappers in `desktop/src/lib/commands.ts` using `invoke()`. Register all commands in `desktop/src-tauri/src/lib.rs` `invoke_handler` (line ~95 area).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
