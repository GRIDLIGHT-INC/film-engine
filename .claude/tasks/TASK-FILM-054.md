# FILM-054: Face restoration endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Post-Production Pipeline (7 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Add `POST /v1/post/face-restore` to `agents/postprocess_agent/main.py`. Accept `multipart/form-data` with `video` (.mp4 binary) and `strength` (float 0.0-1.0, default 0.5). Create `agents/postprocess_agent/face_restore.py`: extract frames from video using `imageio.get_reader()`, run face detection per frame via `facexlib.detection.RetinaFace`, crop detected faces, run CodeFormer inference (`codeformer_net(cropped_face, w=strength)`), paste restored faces back, reassemble video via `imageio.get_writer()`. Handle multi-face frames (process each detected face). Skip frames with no detected faces. Gateway handler `film_face_restore` in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/face-restore", post(film_face_restore))`. Route to PostProcess agent via `state.agent_registry.get_best_agent(&AgentRole::PostProcess, "codeformer", None)`. Save output to `/data/film/projects/{pid}/shots/{sid}/video_final/face_restored.mp4`. Return `{"video_path": "...", "faces_processed": N, "frames_processed": N}`. Add `codeformer-pip>=0.1.0`, `facexlib>=0.3.0`, `gfpgan>=1.3.8` to `requirements.txt`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 0-1

## Notes

Part of the Film Engine — Full Production Pipeline epic.
