# FILM-057: Shot-to-shot color matching

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Post-Production Pipeline (7 tasks)
- **Size:** "mean_std"}`. Create `agents/postprocess_agent/color_match.py`: extract representative frames from both clips (first, middle, last). For `histogram` method: compute per-channel histograms of reference, apply histogram matching to target frames via `skimage.exposure.match_histograms()`. For `mean_std` method: compute mean/std per channel for reference, normalize target to match using `(target - target_mean) * (ref_std / target_std) + ref_mean`. Apply same transform to all target frames for consistency. Gateway handler `film_color_match` in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/match-color", post(film_color_match))`. Accept `reference_shot_id` to load reference video from another shot's directory. Save to `/data/film/projects/{pid}/shots/{sid}/video_final/color_matched.mp4`. Add `scikit-image>=0.22.0` to `requirements.txt`. Return `{"video_path": "...", "reference_shot_id": "...", "method": "histogram"}`.
- **Created:** 2026-02-01

## Summary

Add `POST /v1/post/match-color` to `agents/postprocess_agent/main.py`. Accept `{"target_video_path": str, "reference_video_path": str, "method": "histogram"

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
