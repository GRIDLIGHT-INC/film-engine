# FILM-029: Add `VideoGen` agent role

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Video Generation (7 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

In `gateway/src/agent_protocol.rs`, add `VideoGen` variant to `AgentRole` enum (line ~46-51). Update `as_str()` to return `"videogen"`. Add VRAM scoring branch in `score_for_task()` (line ~131-139): `AgentRole::VideoGen => { score += (vram / 32.0) * 35.0; }` — highest VRAM preference (35 points max, above Infer's 30) since video diffusion requires 12-24GB. VideoGen agents require GPU — add `if self.backend == Backend::Cpu { return 0.0; }` check for VideoGen role. Update any exhaustive `match` statements on `AgentRole` in `gateway/src/handlers.rs` and `gateway/src/pipeline_scheduler.rs`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 46-51
- 131-139
- 12-24

## Notes

Part of the Film Engine — Full Production Pipeline epic.
