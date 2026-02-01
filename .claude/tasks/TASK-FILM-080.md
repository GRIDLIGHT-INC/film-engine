# FILM-080: API documentation

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Testing & Documentation (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `docs/api-film.md` documenting all `/film/*` endpoints. For each endpoint: HTTP method, URL, request schema (JSON), response schema, status codes, example `curl` command. Sections: **Projects** (`CRUD /film/projects`), **Scripts** (`POST /film/projects/{id}/script`), **Scenes** (`GET /film/projects/{id}/status-board`, `GET /film/scenes/{id}/breakdown`), **Shots** (`POST /film/shots`, `GET /film/projects/{id}/shotlist`, `POST /film/shots/{id}/generate`), **Characters** (`CRUD /film/projects/{id}/characters`), **Storyboard** (`POST/GET /film/projects/{id}/storyboard`), **Voice** (`POST /film/shots/{id}/dialogue`), **Video** (pipeline generation), **Post-Production** (face-restore, upscale, grade), **Export** (`GET /film/projects/{id}/export`). Include scene card YAML schema with full field reference and examples. Document SSE streaming format for pipeline progress. Document error codes: 400 (invalid scene card), 404 (project/shot not found), 429 (agent busy). Include hardware requirement notes per agent type.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
