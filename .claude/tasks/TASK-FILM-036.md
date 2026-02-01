# FILM-036: Add `LipSync` agent role

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Lip-Sync & Performance (5 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

In `gateway/src/agent_protocol.rs`, add `LipSync` variant to `AgentRole` enum (line ~46-51). Update `as_str()` to return `"lipsync"`. Add VRAM scoring branch in `score_for_task()` (line ~131-139): `AgentRole::LipSync => { score += (vram / 32.0) * 15.0; }` — moderate VRAM (4-8GB), can time-share GPU with VoiceGen. Allow CPU fallback (don't return 0.0 for CPU backend, unlike VideoGen). Update exhaustive `match` on `AgentRole` in `gateway/src/handlers.rs` and `gateway/src/pipeline_scheduler.rs`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 46-51
- 131-139
- 4-8

## Notes

Part of the Film Engine — Full Production Pipeline epic.
