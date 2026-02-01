# FILM-081: Update CLAUDE.md

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Testing & Documentation (6 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Add "Film Engine" section to `/CLAUDE.md` under "Additional API Endpoints". Add endpoint table: `POST /film/projects` (Create project), `POST /film/projects/{id}/script` (Upload screenplay), `POST /film/shots` (Create shots from scene cards), `POST /film/projects/{id}/storyboard` (Generate storyboard), `POST /film/shots/{id}/generate` (Run full shot pipeline), `GET /film/projects/{id}/export` (Export project). Add "Scene Card Schema" subsection with YAML example showing camera, lighting, characters, style fields. Add Film Engine `just` commands if any are created. Add "Film Pipeline Streaming" code example showing SSE consumption for pipeline progress (mirror existing SSE pattern in CLAUDE.md). Add hardware requirements note: VideoGen needs 12-24GB VRAM, VoiceGen 2-4GB, LipSync 4-8GB, PostProcess 2GB (CPU ok). Add `FILM_MAX_PARALLEL_SHOTS`, `FILM_PRIMARY_GPU` env vars to Environment Variables table.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 12-24
- 2-4
- 4-8

## Notes

Part of the Film Engine — Full Production Pipeline epic.
