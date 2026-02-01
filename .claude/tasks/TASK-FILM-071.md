# FILM-071: Batch shot generation

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Shot Pipeline Orchestrator (3 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add `film_generate_scene` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/scenes/:scene_id/generate-all", post(film_generate_scene))`. Load all shots for scene via `MetadataBackend::get_shots_by_scene(scene_id)`. Create master `JobQueue` job (from `gateway/src/job_queue.rs`) with `JobPhase` tracking per-shot. Use `tokio::spawn` to run `FilmPipelineOrchestrator::run_shot_pipeline()` for each shot sequentially (to avoid GPU contention). Report progress via SSE with per-shot status: `{"total_shots": N, "current_shot": i, "shot_id": "...", "step": 3, "step_name": "voice_gen"}`. On individual shot failure, log error and continue to next shot (don't fail entire batch). Collect results: `{"completed": [shot_ids], "failed": [{"shot_id": "...", "error": "..."}], "total_duration_ms": N}`. Update scene status to `ShotsGenerated` when all shots complete (FILM-083 state machine). Respect `FILM_MAX_PARALLEL_SHOTS` env var (default 1) for future multi-GPU parallel generation.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-083

## Notes

Part of the Film Engine — Full Production Pipeline epic.
