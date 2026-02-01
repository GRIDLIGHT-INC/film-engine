# FILM-083: Scene status tracking

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** B: Production Management (8 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `status` column to `film_scenes` table (already in FILM-005 migration). Define `FilmSceneStatus` enum in `gateway/src/film_status.rs`: `Written`, `BrokenDown`, `Storyboarded`, `Cast`, `VoicesRecorded`, `ShotsGenerated`, `PostProcessed`, `Approved`. Implement auto-advancement: when all shots in a scene reach `Complete`, advance scene to `ShotsGenerated`; when all shots reach post-processed, advance to `PostProcessed`. Add `film_status_board` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/projects/:project_id/status-board", get(film_status_board))`. Query all scenes with their status via `MetadataBackend::get_scenes_by_project()`, aggregate counts per status. Return `Json<StatusBoardResponse>` with `scenes: Vec<{scene_number, status, shot_count, shots_complete}>`, `summary: {total_scenes, by_status: HashMap<String, usize>}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-005

## Notes

Part of the Film Engine — Full Production Pipeline epic.
