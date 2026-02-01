# FILM-073: Automated QA checks per render

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** QA & Quality Gates (3 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

Create `agents/postprocess_agent/qa_checker.py`. Implement `run_qa_checks(video_path: str, audio_path: Optional[str]) -> QAReport`. Checks: (1) face detection via `facexlib.detection.RetinaFace` — verify faces present in expected frames, (2) SSIM ≥ 0.92 between consecutive frames via `skimage.metrics.structural_similarity()` — detect temporal artifacts/flicker, (3) LPIPS ≤ 0.25 perceptual quality via `lpips` library, (4) motion-blur spike detection — compute frame-to-frame optical flow magnitude, flag spikes > 3 std devs, (5) lip-sync drift < 80ms — cross-correlate audio energy envelope with mouth-region pixel changes, (6) frame integrity — verify no black/corrupt frames via `frame.mean() > 10`. Add `POST /v1/post/qa-check` endpoint to `agents/postprocess_agent/main.py`. Gateway handler `film_qa_check` in `gateway/src/handlers.rs`, route: `.route("/film/shots/:shot_id/qa", post(film_qa_check))`. On failure, auto-requeue shot for re-render via `MetadataBackend::update_shot_status(shot_id, "pending")`. Return `{"passed": bool, "checks": {"ssim": 0.95, "lpips": 0.18, ...}, "issues": [...]}`. Add `lpips>=0.1.4` to `requirements.txt`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
