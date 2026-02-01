# FILM-076: Voice agent unit tests

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Testing & Documentation (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `agents/voice_agent/tests/` directory (if not already created by EPIC-voice-tts TTS-048) with `test_film_synthesizer.py`, `test_dialogue.py`, `test_viseme.py`. Use `pytest` + `pytest-asyncio`. Mock Qwen3-TTS model with `unittest.mock.MagicMock` returning fixed-size tensor for CI (no GPU). Tests: `test_character_voice_synthesis` (verify correct voice embedding loaded for character_id), `test_emotion_token_mapping` (verify each emotion maps to correct control token), `test_dialogue_batch_ordering` (verify multi-line batch returns results in correct index order), `test_viseme_mapping_completeness` (verify all ARPAbet phonemes map to a viseme), `test_viseme_timing_monotonic` (verify timestamps are non-decreasing). Add `conftest.py` with fixtures for mock models and sample audio. Add `pytest>=8.0.0`, `pytest-asyncio>=0.23.0` to `requirements.txt`. Run with `pytest agents/voice_agent/tests/`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- TTS-048

## Notes

Part of the Film Engine — Full Production Pipeline epic.
