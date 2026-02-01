# FILM-020: Storyboard regeneration (per-shot)

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Storyboard Generation (5 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add `film_storyboard_regenerate` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/storyboard/regenerate", post(film_storyboard_regenerate))`. Accept optional `Json<RegenerateRequest>` with `prompt_override: Option<String>`, `seed: Option<u64>`, `style_override: Option<String>`. Load shot and its scene card from `MetadataBackend::get_shot()`. If `prompt_override` provided, use it directly; otherwise rebuild prompt via `film_prompt::build_storyboard_prompt()` (FILM-018). Route to ImageGen agent via `state.agent_registry.get_best_agent(&AgentRole::ImageGen, "sdxl", None)`. Overwrite existing storyboard image at `/data/film/projects/{pid}/storyboard/{shot_code}.png`. Also update per-shot keyframe. Add `RegenerateRequest` to `gateway/src/types.rs`. Return `{"shot_id": "...", "status": "complete", "image_url": "..."}`. Log regeneration in render ledger (FILM-049) if ledger table exists.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-018
- FILM-049

## Notes

Part of the Film Engine — Full Production Pipeline epic.
