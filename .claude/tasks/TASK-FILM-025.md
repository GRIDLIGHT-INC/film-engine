# FILM-025: Multi-character dialogue batch

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Voice & Dialogue Pipeline (7 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `POST /v1/voice/dialogue` to `agents/voice_agent/main.py`. Accept `{"lines": [{"character_id": "uuid", "voice_id": "uuid", "text": "Hello there", "emotion": "happy"}, ...]}`. Create `agents/voice_agent/dialogue.py`: iterate lines, load each character's voice embedding via `torch.load(f"/data/voices/{voice_id}/embedding.pt")`, synthesize each line sequentially (to avoid VRAM thrash from loading multiple embeddings). Return `[{"index": 0, "audio_base64": "...", "duration_ms": 1234, "voice_id": "...", "character_id": "..."}]` with per-line timing for film timeline sync. Gateway handler `film_dialogue_batch` in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/dialogue", post(film_dialogue_batch))`. Use longer `reqwest::Client::builder().timeout(Duration::from_secs(300))` since batch may process many lines. Save all dialogue files to `/data/film/projects/{pid}/shots/{sid}/audio_dialogue/`. Return aggregate timing data for NLE export.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
