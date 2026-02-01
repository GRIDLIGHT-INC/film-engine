# FILM-052: Add `PostProcess` agent role

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Post-Production Pipeline (7 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

In `gateway/src/agent_protocol.rs`, add `PostProcess` variant to `AgentRole` enum (line ~46-51). Update `as_str()` to return `"postprocess"`. Add VRAM scoring branch in `score_for_task()`: `AgentRole::PostProcess => { score += (vram / 32.0) * 10.0; }` — low VRAM preference (2-4GB), CPU-viable for color grading and grain. Allow CPU backend (don't penalize CPU). Update exhaustive `match` on `AgentRole` in `gateway/src/handlers.rs` and `gateway/src/pipeline_scheduler.rs`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 46-51
- 2-4

## Notes

Part of the Film Engine — Full Production Pipeline epic.
