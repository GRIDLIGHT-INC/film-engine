# FILM-093: Per-shot audio mix for Film Engine

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Music & Sound Design (4 tasks — adapter layer)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add `film_shot_audio_mix` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/audio-mix", post(film_shot_audio_mix))`. Collect all audio files from shot directory: dialogue tracks from `/audio_dialogue/`, music from `/audio_music/score.wav`, SFX from `/audio_music/sfx_*.wav`, ambient from `/audio_music/ambient.wav`. Forward to AudioGen agent's `POST /v1/mix` endpoint (from MUSIC-061) or implement mixing in gateway using FFmpeg via `tokio::process::Command::new("ffmpeg")` with filter_complex for multi-track mixing: `ffmpeg -i dialogue.wav -i score.wav -i sfx.wav -i ambient.wav -filter_complex "[0:a]volume=1.0[d];[1:a]volume=0.3[m];[2:a]volume=0.7[s];[3:a]volume=0.2[a];[d][m][s][a]amix=inputs=4" output.wav`. Normalize levels to -23 LUFS via `loudnorm` filter. Export separate stems alongside temp-mix for NLE flexibility. Save to `/data/film/projects/{pid}/shots/{sid}/audio_music/tempmix.wav`. Return `{"mix_path": "...", "stems": ["dialogue.wav", "score.wav", "sfx.wav", "ambient.wav"], "duration_ms": N, "lufs": -23.0}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- MUSIC-061

## Notes

Part of the Film Engine — Full Production Pipeline epic.
