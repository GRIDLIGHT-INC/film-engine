# FILM-010: `GET /film/projects/{id}/shotlist`

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add `film_shotlist` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/projects/:project_id/shotlist", get(film_shotlist))`. Query all scenes for project via `MetadataBackend::get_scenes_by_project(project_id)`, then for each scene query `MetadataBackend::get_shots_by_scene(scene_id)`. Aggregate into ordered list sorted by `scene_number`, then `shot_code`. Support pagination via `Query<PaginationParams>` (add `PaginationParams { offset: Option<usize>, limit: Option<usize> }` to `gateway/src/types.rs`). Include per-shot: `status`, `duration_ms`, `thumbnail_url` (constructed from `/data/film/projects/{pid}/shots/{sid}/keyframes/thumb.jpg` if exists, null otherwise — check via `tokio::fs::try_exists()`). Return `Json<ShotListResponse>` with `total_count`, `shots: Vec<ShotListItem>`, `page_offset`, `page_limit`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
