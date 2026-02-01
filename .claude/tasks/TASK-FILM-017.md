# FILM-017: Storyboard generation endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Storyboard Generation (5 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add `film_storyboard_generate` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/projects/:project_id/storyboard", post(film_storyboard_generate))`. Load all scenes and shots for the project via `MetadataBackend`. For each shot, parse `scene_card_yaml` via `serde_yaml::from_str::<SceneCard>()`, construct image prompt via prompt template (FILM-018). Route each to ImageGen agent via `state.agent_registry.get_best_agent(&AgentRole::ImageGen, "sdxl", None)`. Forward to agent's `POST /v1/image/generate` via `reqwest::Client`. Save keyframes to `/data/film/projects/{pid}/storyboard/{shot_code}.png` via `tokio::fs::write()`. Also save to per-shot directory `/data/film/projects/{pid}/shots/{sid}/keyframes/`. This is a batch async operation — create `JobQueue` job (pattern from `gateway/src/job_queue.rs`) with `JobPhase` tracking per-shot progress. Return `{"job_id": "...", "total_shots": N}`. Stream progress via SSE using `Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))` (pattern at `handlers.rs:4528`). Generate shots sequentially (one at a time per agent) to avoid VRAM contention.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-018

## Notes

Part of the Film Engine — Full Production Pipeline epic.
