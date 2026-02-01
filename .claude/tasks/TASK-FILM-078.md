# FILM-078: Gateway integration tests

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Testing & Documentation (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add tests in `gateway/tests/film_integration.rs` (or add `#[cfg(test)] mod film_tests` in `gateway/src/handlers.rs`). Use `axum_test::TestServer` or build test app with `Router`. Mock agents with `wiremock::MockServer` returning fixed responses. Tests: `test_film_project_crud` (POST/GET/PUT/DELETE `/film/projects`, verify 201/200/200/204 status codes), `test_shot_creation_validates_yaml` (POST `/film/shots` with invalid YAML returns 400), `test_scene_card_validation` (reject cards with duration > 30s, missing fields), `test_shotlist_pagination` (verify offset/limit params), `test_storyboard_get_returns_frames` (verify storyboard response structure), `test_export_generates_fcpxml` (verify valid XML output with FCPXML schema), `test_render_ledger_populated` (verify ledger entry created after mock render). Follow existing test patterns in `gateway/src/agent_protocol.rs` `#[cfg(test)] mod tests` (line ~300+). Add `wiremock = "0.6"`, `axum-test = "15"` to `gateway/Cargo.toml` `[dev-dependencies]`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
