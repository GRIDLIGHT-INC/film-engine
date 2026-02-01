# FILM-079: Pipeline end-to-end test

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Testing & Documentation (6 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Create `tests/e2e/test_film_pipeline.py` using `pytest` + `httpx`. Full pipeline test: (1) `POST /film/projects` to create project, (2) `POST /film/projects/{id}/script` to upload test screenplay, (3) verify scenes auto-extracted via `GET /film/projects/{id}/shotlist`, (4) `POST /film/shots` with test scene cards, (5) `POST /film/projects/{id}/storyboard` to generate storyboard (mock ImageGen agent), (6) `POST /film/shots/{id}/generate` to run full pipeline (mock all agents), (7) `GET /film/projects/{id}/export/fcpxml` to verify FCPXML output, (8) validate exported `.mov` playback via `imageio.get_reader()` frame count check. Mock agents using `pytest-httpserver` or `respx` — return pre-generated test media files. GPU test variant: tag with `@pytest.mark.gpu` for CI with GPU runners using real agents. Assert total pipeline time < 300s for single 5s shot (mocked). Add `httpx>=0.27.0`, `pytest-httpserver>=1.0.0` to test dependencies.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
