# FILM-019: Storyboard viewer endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Storyboard Generation (5 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add `film_storyboard_get` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/projects/:project_id/storyboard", get(film_storyboard_get))`. Query all shots ordered by `scene_number` then `shot_code` via `MetadataBackend::get_scenes_by_project()` and `get_shots_by_scene()`. For each shot, check if storyboard image exists at `/data/film/projects/{pid}/storyboard/{shot_code}.png` via `tokio::fs::try_exists()`. Return `Json<StoryboardResponse>` with `frames: Vec<StoryboardFrame>` where each frame has `shot_id`, `shot_code`, `scene_number`, `description` (from scene card), `duration_s`, `image_url` (path to PNG or null if not generated), `dialogue` (extracted from scene card characters). Add `StoryboardResponse` and `StoryboardFrame` structs to `gateway/src/types.rs`. Desktop app renders this as visual grid (FILM-067).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-067

## Notes

Part of the Film Engine — Full Production Pipeline epic.
