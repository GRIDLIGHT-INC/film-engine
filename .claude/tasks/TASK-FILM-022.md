# FILM-022: Add `VoiceGen` agent role

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Voice & Dialogue Pipeline (7 tasks)
- **Size:** AgentRole::Rerank` arm): `AgentRole::VoiceGen => { score += (vram / 32.0) * 20.0; }` — moderate VRAM preference between Infer (30) and Embed/Rerank (15). VoiceGen agents register with `roles: vec![AgentRole::VoiceGen]` and report `models_cached: vec!["qwen3-tts-0.6b"]`. In `gateway/src/agent_registry.rs`, `get_best_agent()` and `get_agents_by_role()` already work generically — no changes needed. Update any exhaustive `match` statements on `AgentRole` in `gateway/src/handlers.rs` and `gateway/src/pipeline_scheduler.rs`. Note: if EPIC-voice-tts TTS-005 is implemented first, this task is already complete — verify and skip.
- **Created:** 2026-02-01

## Summary

In `gateway/src/agent_protocol.rs`, add `VoiceGen` variant to `AgentRole` enum (line ~46-51, after `Verify`). Update `as_str()` match (line ~54-61) to return `"voicegen"`. Add VRAM scoring branch in `score_for_task()` (line ~131-139, after `AgentRole::Embed

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 46-51
- 54-61
- 131-139

## Notes

Part of the Film Engine — Full Production Pipeline epic.
