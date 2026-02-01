# FILM-049: Auto-populate ledger on every render

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Render Ledger & Reproducibility (4 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

In each agent dispatch handler that triggers rendering — storyboard generation (FILM-017), video generation (film pipeline FILM-070), lip-sync (FILM-038), post-processing (FILM-054-057) — after successful agent response, call `MetadataBackend::create_render_ledger_entry()` with full parameters. Extract params from agent response: `seed`, `steps`, `guidance_scale`, `model_hash` (agent should include in response JSON). Capture `device` from agent's registered `AgentCapabilities.backend`. Record `camera_params` and `lighting_params` from parsed `SceneCard`. Record all `lora_ids` and `controlnets` used. Set `mode` from `SceneCard.generation_mode` (`locked` or `creative`). In `gateway/src/handlers.rs`, create helper function `record_render_ledger(state: &AppState, shot_id: &str, params: &RenderParams) -> Result<Uuid>` called after each successful render dispatch. Log `tracing::info!("Render ledger entry created for shot {}", shot_id)`. This ensures full reproducibility tracking for every generated asset.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-017
- FILM-070
- FILM-038
- FILM-054

## Notes

Part of the Film Engine — Full Production Pipeline epic.
