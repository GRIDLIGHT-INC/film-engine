# FILM-027: Viseme track generation

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Voice & Dialogue Pipeline (7 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add `POST /v1/voice/visemes` to `agents/voice_agent/main.py`. Create `agents/voice_agent/viseme.py`: after synthesis, run Montreal Forced Aligner (`mfa align`) or Qwen3-TTS built-in phoneme timestamps to produce `[(phoneme, start_ms, end_ms), ...]`. Map phonemes to visemes using ARPAbet→Disney viseme mapping: `VISEME_MAP = {"AA": "open", "AE": "open", "B": "closed", "M": "closed", "F": "dental_labial", "TH": "dental_labial", ...}` (~15 viseme groups). Return `{"visemes": [{"viseme": "open", "start_ms": 0, "end_ms": 120}, ...], "phonemes": [...]}`. Save as JSON sidecar at `/data/film/projects/{pid}/shots/{sid}/metadata/{character}_{line}_visemes.json`. Gateway handler `film_viseme_generate` in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/visemes", post(film_viseme_generate))`. Add `montreal-forced-aligner>=3.0.0` to `agents/voice_agent/requirements.txt`. LipSync agent (Phase 6) consumes these sidecar files for improved sync quality.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
