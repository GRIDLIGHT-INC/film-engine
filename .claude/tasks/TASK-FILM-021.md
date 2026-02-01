# FILM-021: Style consistency across storyboard

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Storyboard Generation (5 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

In `gateway/src/film_prompt.rs` (from FILM-018), add `StyleLockParams` struct: `base_seed: u64, ip_adapter_path: Option<String>, style_reference_image: Option<String>, consistency_weight: f32`. Implement `apply_style_lock(prompt: &str, params: &StyleLockParams) -> GenerationParams` — when `style_lock=true` in scene card, use same `base_seed + shot_index` for all shots in a scene (deterministic variation per shot while maintaining coherence). If IP-Adapter is available on ImageGen agent (check via agent capabilities metadata), include `ip_adapter_image` pointing to first shot's keyframe as style reference. Add `style_lock: Option<bool>` field to `SceneCard` struct in `gateway/src/film_scene_card.rs`. In storyboard generation handler (FILM-017), when processing shots within a scene, pass `StyleLockParams` to prompt builder. Expose `consistency_weight` (0.0-1.0) controlling IP-Adapter influence strength. Default `style_lock=true` for all shots within the same scene.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-018
- FILM-017
- 0-1

## Notes

Part of the Film Engine — Full Production Pipeline epic.
