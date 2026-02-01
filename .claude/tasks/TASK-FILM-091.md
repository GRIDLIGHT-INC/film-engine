# FILM-091: Film Engine SFX adapter

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Music & Sound Design (4 tasks — adapter layer)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_shot_sfx` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/sfx", post(film_shot_sfx))`. Load shot's scene card, extract SFX descriptions from character actions and scene description (e.g., "door slams", "footsteps on gravel", "glass breaking"). Translate each SFX description to Music Generation SFX API call: forward to AudioGen agent's `POST /v1/sfx/generate` endpoint (from MUSIC-041) with `{"prompt": sfx_description, "duration_s": N}`. Save each SFX to `/data/film/projects/{pid}/shots/{sid}/audio_music/sfx_{index}.wav`. Add `sfx_cues: Option<Vec<SfxCue>>` to `SceneCard` in `gateway/src/film_scene_card.rs` where `SfxCue { description: String, timestamp_s: f32, duration_s: f32 }`. Return `{"sfx_files": [{"description": "...", "path": "...", "duration_ms": N}]}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- MUSIC-041

## Notes

Part of the Film Engine — Full Production Pipeline epic.
