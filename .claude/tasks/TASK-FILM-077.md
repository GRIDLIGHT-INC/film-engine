# FILM-077: Video agent unit tests

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Testing & Documentation (6 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `agents/video_agent/tests/` directory with `test_animator.py`, `test_camera.py`, `test_stitcher.py`. Use `pytest` + `pytest-asyncio`. Mock AnimateDiff pipeline with `unittest.mock.MagicMock` returning fixed-shape tensor (no GPU). Tests: `test_generate_returns_valid_mp4` (verify output file has valid MP4 header bytes), `test_camera_motion_enum_coverage` (verify all CameraMotion variants produce valid transform tensors), `test_multi_clip_stitch_frame_count` (verify stitched video has expected total frames: `sum(clip_frames) - (num_clips-1)*overlap_frames`), `test_busy_returns_429` (verify concurrent request gets 429 status), `test_generation_params_recorded` (verify seed, steps, guidance returned in response). Add `conftest.py` with mock pipeline fixture. Run with `pytest agents/video_agent/tests/`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
