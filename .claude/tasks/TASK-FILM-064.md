# FILM-064: `GET /film/projects/{id}/export` endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** NLE Export & Integration (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `film_export_package` handler in `gateway/src/handlers.rs`. Register route: `.route("/film/projects/:project_id/export", get(film_export_package).post(film_export_generate))`. `POST` triggers full export generation: encode all shots (FILM-062), generate FCPXML (FILM-059), EDL (FILM-060), Premiere XML (FILM-061), package audio (FILM-063). Create async job via `JobQueue` (from `gateway/src/job_queue.rs`) — return `{"job_id": "...", "status": "queued"}` since export may take minutes. Stream progress via SSE. `GET` returns export manifest if complete: `{"status": "complete", "files": {"fcpxml": "path", "edl": "path", "premiere_xml": "path", "media": [...], "audio_stems": [...], "subtitles": "path"}, "total_size_bytes": N}`. Generate `licenses.txt` listing all model licenses used (AnimateDiff Apache-2.0, Qwen3-TTS Apache-2.0, etc.). Optional: create zip archive via `tokio::process::Command::new("zip")` with all export files for single-file download. Return `Content-Type: application/json` for manifest, or `application/zip` with `Content-Disposition: attachment` for zip download.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-062
- FILM-059
- FILM-060
- FILM-061
- FILM-063

## Notes

Part of the Film Engine — Full Production Pipeline epic.
