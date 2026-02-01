# FILM-033: Multi-clip stitching for longer shots

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Video Generation (7 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

In `agents/video_agent/animator.py`, create `generate_long_video(prompt, keyframe, total_duration_s, clip_duration_s=4.0, overlap_frames=8) -> str`. For shots > 5s: generate first clip from keyframe, extract last `overlap_frames` as conditioning for next clip, generate subsequent clips with shared start frames for temporal coherence. Add `POST /v1/video/generate-long` endpoint to `agents/video_agent/main.py`. Implement cross-dissolve stitching: blend overlapping frames using linear alpha ramp via `numpy` (`alpha = np.linspace(0, 1, overlap_frames)`). Concatenate clips using `imageio` writer. Handle transitions: `cut` (no blend), `dissolve` (alpha blend), `fade` (via black frames). Save final stitched video to `/data/film/projects/{pid}/shots/{sid}/video_raw/clip_stitched.mp4`. Return total `duration_ms` and `clip_count`. Gateway routes to this endpoint when scene card `duration_s > 5.0`. This is a long-running operation (2-5 min) — report per-clip progress via SSE events to gateway.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 2-5

## Notes

Part of the Film Engine — Full Production Pipeline epic.
