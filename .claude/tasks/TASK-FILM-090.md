# FILM-090: Film Engine music adapter

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Music & Sound Design (4 tasks — adapter layer)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_shot_music` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/music", post(film_shot_music))`. Load shot's scene card from `MetadataBackend::get_shot()`, parse via `serde_yaml::from_str::<SceneCard>()`. Extract music params: `scene_card.style.music_mood`, `scene_card.style.music_genre`, `scene_card.duration_s`. Translate to Music Generation API call: construct `{"prompt": "{mood} {genre} instrumental soundtrack", "duration_s": N, "format": "wav"}` and forward to AudioGen agent via `state.agent_registry.get_best_agent(&AgentRole::AudioGen, "musicgen", None)` then `reqwest::Client::post(format!("http://{}:{}/v1/music/generate", agent.host, agent.port))`. Save output to `/data/film/projects/{pid}/shots/{sid}/audio_music/score.wav`. Add `music_mood: Option<String>` and `music_genre: Option<String>` fields to `StyleParams` in `gateway/src/film_scene_card.rs`. Return `{"audio_path": "...", "duration_ms": N}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
