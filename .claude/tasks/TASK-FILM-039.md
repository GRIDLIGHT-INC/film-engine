# FILM-039: Viseme-guided sync enhancement

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Lip-Sync & Performance (5 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

In `agents/lipsync_agent/sadtalker_wrapper.py`, create `apply_viseme_refinement(video_frames: List[np.ndarray], visemes: List[VisemeEvent], fps: int) -> List[np.ndarray]`. Load viseme track JSON (from FILM-027). For each frame, look up active viseme at `frame_time_ms = (frame_idx / fps) * 1000`. Apply viseme-specific mouth shape corrections: strengthen lip closure on `closed` visemes (B, M, P plosives), widen mouth on `open` visemes, add dental visibility on `dental_labial` (F, V). Implement via SadTalker coefficient adjustment: modify `exp_coeff` and `pose_coeff` arrays based on viseme type. Reduce temporal jitter by applying Gaussian smoothing (`scipy.ndimage.gaussian_filter1d(coefficients, sigma=2)`) to mouth landmark trajectories. Add `scipy>=1.12.0` to `agents/lipsync_agent/requirements.txt`. This is an enhancement pass — applied after base SadTalker sync if viseme track is available.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- FILM-027

## Notes

Part of the Film Engine — Full Production Pipeline epic.
