# FILM-008: `POST /film/shots` — create shots from scene cards

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_shots_create` handler in `gateway/src/handlers.rs`. Register route in `gateway/src/main.rs`: `.route("/film/shots", post(film_shots_create))`. Accept `Json<CreateShotsRequest>` with `scene_id: String, shots: Vec<ShotInput>` where `ShotInput` contains `shot_code: String, scene_card_yaml: String`. Add `CreateShotsRequest` and `ShotInput` to `gateway/src/types.rs`. For each shot: parse YAML via `serde_yaml::from_str::<SceneCard>()`, call `SceneCard::validate()` (from FILM-007), generate UUID via `Uuid::new_v4()`, insert into `film_shots` table via `MetadataBackend::create_film_shot()`. Support batch creation (up to 50 shots per request). Return `Json<Vec<FilmShot>>` with generated IDs. On validation failure for any shot, return `StatusCode::BAD_REQUEST` with `{"invalid_shots": [{"index": 0, "errors": [...]}]}` — reject entire batch (atomic).

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-007

## Notes

Part of the Film Engine — Full Production Pipeline epic.
