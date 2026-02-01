# FILM-009: AI screenplay breakdown assistant

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Project & Story Foundation (10 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add `film_breakdown` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/projects/:project_id/breakdown", post(film_breakdown))`. Load screenplay text from `film_scripts` table (latest version). Construct LLM prompt: system message with scene card YAML schema definition + few-shot examples, user message with screenplay text. Route to Infer agent via `state.agent_registry.get_best_agent(&AgentRole::Infer, "default", None)` (same pattern as `neon_query` handler which calls `state.pipeline_scheduler.generate_response()`). Forward prompt to agent via `reqwest::Client::post(format!("http://{}:{}/v1/chat/completions", agent.host, agent.port))`. Parse LLM response as YAML array of scene cards. Validate each via `SceneCard::validate()`. Return SSE stream for progress using `Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))` (pattern at `handlers.rs:4528`). Return `{"scenes": [{"scene_number": 1, "shots": [SceneCard]}]}`. This is a long-running task (30-120s) — use `tokio::spawn` and SSE progress events.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 30-120

## Notes

Part of the Film Engine — Full Production Pipeline epic.
