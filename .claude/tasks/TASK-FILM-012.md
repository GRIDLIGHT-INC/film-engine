# FILM-012: Character CRUD endpoints

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Character & Asset Registry (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_character_create`, `film_character_get`, `film_character_update`, `film_character_delete`, `film_character_list` handlers in `gateway/src/handlers.rs`. Register routes in `gateway/src/main.rs`: `.route("/film/projects/:project_id/characters", post(film_character_create).get(film_character_list))` and `.route("/film/characters/:character_id", get(film_character_get).put(film_character_update).delete(film_character_delete))`. Add `CreateCharacterRequest` to `gateway/src/types.rs`: `name: String, description: Option<String>, appearance_prompt: Option<String>, lora_id: Option<String>, ti_token: Option<String>, voice_id: Option<String>, default_costume: Option<String>, personality_notes: Option<String>`. Apply `check_auth()`. On create, generate UUID via `Uuid::new_v4()`, insert via `MetadataBackend::create_film_character()`. Create character directory at `/data/film/projects/{pid}/characters/{cid}/` via `tokio::fs::create_dir_all()`. Return `Json<FilmCharacter>`. On delete, verify no shots reference this character before allowing deletion.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
