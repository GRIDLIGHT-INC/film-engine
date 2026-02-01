# FILM-092: Film Engine ambient adapter

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Music & Sound Design (4 tasks — adapter layer)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_shot_ambient` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/ambient", post(film_shot_ambient))`. Load shot's scene card, extract location and time_of_day from scene. Map location+time to ambient description: `{"forest" + "night" → "nighttime forest ambience, crickets, rustling leaves, distant owl"}`, `{"office" + "day" → "quiet office ambience, keyboard typing, air conditioning hum"}`. Maintain mapping table in `gateway/src/film_prompt.rs` as `AMBIENT_MAP: HashMap<(&str, &str), &str>`. Forward to AudioGen agent's `POST /v1/ambient/generate` endpoint (from MUSIC-043). Save to `/data/film/projects/{pid}/shots/{sid}/audio_music/ambient.wav`. Loop ambient audio to match shot duration using `pydub` or FFmpeg if generated clip is shorter. Return `{"audio_path": "...", "duration_ms": N, "looped": bool}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- MUSIC-043

## Notes

Part of the Film Engine — Full Production Pipeline epic.
