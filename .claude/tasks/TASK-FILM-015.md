# FILM-015: Voice profile registration

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Character & Asset Registry (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_character_voice` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/characters/:character_id/voice", post(film_character_voice))`. Accept `multipart/form-data` with `file` (.wav, 3-10s) via `axum::extract::Multipart`. Route voice sample to VoiceGen agent (from EPIC-voice-tts) via `state.agent_registry.get_best_agent(&AgentRole::VoiceGen, "qwen3-tts", None)`. Forward to agent's `POST /v1/tts/extract-embedding` endpoint with audio bytes. On success, save `sample.wav` and `embedding.pt` to `/data/film/projects/{pid}/characters/{cid}/voice/` via `tokio::fs::write()`. Create voice entry in `voices` table (from EPIC-voice-tts TTS-020) with `is_cloned=true`, link via `UPDATE film_characters SET voice_id = $1 WHERE id = $2` through `MetadataBackend::update_film_character()`. Return `{"voice_id": "uuid", "character_id": "uuid", "status": "ready"}`. Validate audio duration (3-10s) and format (.wav) before forwarding.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 3-10
- TTS-020
- 3-10

## Notes

Part of the Film Engine — Full Production Pipeline epic.
