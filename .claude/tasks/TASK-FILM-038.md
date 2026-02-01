# FILM-038: Audio-driven lip-sync endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Lip-Sync & Performance (5 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add `POST /v1/lipsync/sync` to `agents/lipsync_agent/main.py`. Accept `multipart/form-data` with `video` (.mp4 binary), `audio` (.wav binary), `viseme_track` (optional JSON file). In `agents/lipsync_agent/sadtalker_wrapper.py`: save uploaded files to temp dir via `tempfile.mkdtemp()`, run SadTalker inference (`sadtalker.generate(source_image=first_frame, driven_audio=audio_path, result_dir=temp_dir)`). For video input (not just image), extract frames, run SadTalker per-frame with audio segments, reassemble. If `viseme_track` provided, use viseme keypoints to guide mouth shape refinement (FILM-039). Output synced video to `/data/film/projects/{pid}/shots/{sid}/video_synced/synced.mp4`. Gateway handler `film_lipsync` in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/lipsync", post(film_lipsync))`. Route to LipSync agent via `state.agent_registry.get_best_agent(&AgentRole::LipSync, "sadtalker", None)`. Forward video + audio from shot directory. Return `{"video_path": "...", "sync_quality": float, "processing_ms": N}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-039

## Notes

Part of the Film Engine — Full Production Pipeline epic.
