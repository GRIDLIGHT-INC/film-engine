# FILM-007: Scene card YAML schema & validator

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `gateway/src/film_scene_card.rs` module. Add `mod film_scene_card;` to `gateway/src/main.rs` (line ~75 area with other module declarations). Define `SceneCard` struct with `#[derive(Debug, Serialize, Deserialize)]`: `camera: CameraParams` (lens, shot_type, movement), `lighting: LightingParams` (key_light, fill, color_temp), `characters: Vec<SceneCharacter>` (id, position, action, dialogue, emotion), `style: StyleParams` (preset, negative_prompt, lora_overrides), `duration_s: f32`, `generation_mode: GenerationMode` (locked/creative). Add `serde_yaml = "0.9"` to `gateway/Cargo.toml`. Implement `SceneCard::validate() -> Result<(), Vec<String>>` with checks: duration 0.5-30s, at least one character or description, valid camera movement enum, valid emotion tags. Add `jsonschema = "0.18"` for optional JSON Schema export via `SceneCard::json_schema() -> serde_json::Value`. Call `validate()` in handlers that accept scene cards — reject with `StatusCode::BAD_REQUEST` and validation errors.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 5-30

## Notes

Part of the Film Engine — Full Production Pipeline epic.
