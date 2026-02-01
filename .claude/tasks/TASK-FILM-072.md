# FILM-072: Smart scheduling & model residency

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Shot Pipeline Orchestrator (3 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

In `gateway/src/film_pipeline.rs`, implement `FilmScheduler` struct. Add model residency tracking: maintain `HashMap<String, Vec<String>>` mapping agent_id → currently loaded models (populated from agent heartbeat `models_cached` field in `AgentCapabilities`). Implement `schedule_step(role: &AgentRole, preferred_model: &str, state: &AppState) -> Option<AgentCapabilities>`: prefer agents that already have the model loaded (check `models_cached`), fall back to `get_best_agent()`. Device routing strategy: `VideoGen` → primary GPU (highest VRAM), `VoiceGen` + `LipSync` → secondary GPU or time-share (prefer agents on same device to share VRAM), `AudioGen` → opportunistic (any available), `PostProcess` → CPU preferred (free GPU for generation). Implement pre-loading: before batch generation (FILM-071), call agents' `/v1/model/preload` endpoint to warm up models. Integrate with `PipelineScheduler` in `gateway/src/pipeline_scheduler.rs` — extend existing `new()` constructor to accept film scheduling config. Read `FILM_PRIMARY_GPU`, `FILM_SECONDARY_GPU` env vars for explicit device assignment.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-071

## Notes

Part of the Film Engine — Full Production Pipeline epic.
