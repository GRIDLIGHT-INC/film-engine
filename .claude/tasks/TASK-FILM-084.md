# FILM-084: Shot status dashboard endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** B: Production Management (8 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_dashboard` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/projects/:project_id/dashboard", get(film_dashboard))`. Query all shots across all scenes for the project via `MetadataBackend::get_scenes_by_project()` then `get_shots_by_scene()` for each. Aggregate stats: `total_shots`, `by_status: HashMap<FilmShotStatus, usize>` (pending/generating/complete/failed/approved), `by_scene: Vec<{scene_number, total, complete, failed}>`. Add department breakdown by checking asset existence in `/data/film/projects/{pid}/shots/{sid}/` subdirectories via `tokio::fs::try_exists()`: `video_done` (video_raw exists), `audio_done` (audio_dialogue exists), `lipsync_done` (video_synced exists), `post_done` (video_final exists). Return `Json<DashboardResponse>` with all aggregates. Add `DashboardResponse` struct to `gateway/src/types.rs`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
