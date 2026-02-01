# FILM-070: Full shot pipeline orchestrator

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Shot Pipeline Orchestrator (3 tasks)
- **Size:** XL
- **Created:** 2026-02-01

## Summary

Create `gateway/src/film_pipeline.rs` module. Add `mod film_pipeline;` to `gateway/src/main.rs`. Implement `FilmPipelineOrchestrator` struct with `run_shot_pipeline(shot_id: &str, scene_card: &SceneCard, state: &Arc<AppState>) -> Result<()>`. Orchestrate the 7-step pipeline sequentially: (1) dispatch to ImageGen agent via `state.agent_registry.get_best_agent(&AgentRole::ImageGen, ...)` for keyframe, (2) dispatch to VideoGen for animation, (3) dispatch to VoiceGen for dialogue, (4) dispatch to LipSync for sync, (5) dispatch to AudioGen for music/SFX (via adapter), (6) dispatch to PostProcess for face restore/upscale/grade, (7) assemble final assets. Between steps, verify output exists via `tokio::fs::try_exists()`. On step failure, retry up to 3 times with `tokio::time::sleep(Duration::from_secs(5))` backoff, then mark shot as `Failed` via `MetadataBackend::update_shot_status()`. Report per-step progress via SSE: create `tokio::sync::mpsc::channel(32)`, send `Event::default().json_data(json!({"shot_id": sid, "step": N, "step_name": "video_gen", "status": "complete"}))`, return `Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))`. Cross-step artifact handoff via shared `/data/film/projects/{pid}/shots/{sid}/` volume. Record render ledger entry after each step (FILM-049). Add `film_generate_shot` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/generate", post(film_generate_shot))`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-049

## Notes

Part of the Film Engine — Full Production Pipeline epic.
