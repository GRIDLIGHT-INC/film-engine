# FILM-024: Per-character voice synthesis

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Voice & Dialogue Pipeline (7 tasks)
- **Size:** happy
- **Created:** 2026-02-01

## Summary

Add `POST /v1/voice/synthesize` to `agents/voice_agent/main.py` (or reuse `/v1/tts/synthesize` from EPIC-voice-tts TTS-007 with film-specific parameters). Accept `{text, character_id, voice_id, emotion, speed}`. Create `agents/voice_agent/film_synthesizer.py`: load character's voice embedding from `/data/voices/cloned/{voice_id}/embedding.pt` via `torch.load()`. Run Qwen3-TTS `model.generate()` with speaker embedding conditioning. Apply emotion control via Qwen3-TTS style tokens (map `emotion` to `<

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- TTS-007

## Notes

Part of the Film Engine — Full Production Pipeline epic.
