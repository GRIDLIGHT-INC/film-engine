# FILM-060: EDL export generator

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** NLE Export & Integration (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

In `gateway/src/film_export.rs`, implement `generate_edl(project: &FilmProject, shots: &[FilmShot]) -> String`. Generate CMX 3600 format EDL. Header: `TITLE: {project.title}` + `FCM: NON-DROP FRAME`. Per shot: event number (sequential), reel name (shot_code truncated to 8 chars), transition type (C = cut, D = dissolve), source/record timecodes calculated from cumulative `duration_ms` converted to `HH:MM:SS:FF` at 24fps using `timecode = (total_frames / fps)`. Format: `{event:03} {reel:8} V C {src_in} {src_out} {rec_in} {rec_out}`. Write to `/data/film/projects/{pid}/export/timeline.edl`. Add `film_export_edl` handler in `gateway/src/handlers.rs`, route: `.route("/film/projects/:project_id/export/edl", get(film_export_edl))`. Return `Content-Type: text/plain` with `Content-Disposition: attachment; filename="timeline.edl"`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
