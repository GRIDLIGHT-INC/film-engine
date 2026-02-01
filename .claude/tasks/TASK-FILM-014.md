# FILM-014: Character reference sheet generation

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Character & Asset Registry (6 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add `film_character_reference_sheet` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/characters/:character_id/reference-sheet", post(film_character_reference_sheet))`. Load character from `MetadataBackend::get_film_character()`. Construct prompts for front/side/back views using `appearance_prompt` + standard suffixes ("front view, full body, character sheet", "side profile view", "back view"). Route to ImageGen agent via `state.agent_registry.get_best_agent(&AgentRole::ImageGen, "sdxl", None)`. Forward each prompt to agent's `POST /v1/image/generate` endpoint via `reqwest::Client`. Include LoRA/TI tokens (`lora_id`, `ti_token`) in generation params if present. Save generated images to `/data/film/projects/{pid}/characters/{cid}/ref_front.png`, `ref_side.png`, `ref_back.png` via `tokio::fs::write()`. This is async — return `job_id` immediately using `JobQueue` pattern from `gateway/src/job_queue.rs` (`JobStatus::Queued` → `Processing` → `Completed`). Send SSE progress events. Return `{"job_id": "...", "status": "queued"}`. Poll via `GET /film/jobs/:job_id`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
