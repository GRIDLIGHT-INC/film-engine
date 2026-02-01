# FILM-056: Film grain & LUT application

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Post-Production Pipeline (7 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `POST /v1/post/grade` to `agents/postprocess_agent/main.py`. Accept `{"video_path": str, "grain_intensity": float, "grain_size": float, "lut_preset": str, "lut_file_path": Optional[str]}`. Create `agents/postprocess_agent/color_grade.py`: implement procedural film grain via `numpy` noise generation (`np.random.normal(0, intensity, frame.shape)` with Gaussian blur for grain size), applied per frame. LUT application: load `.cube` LUT files using `colour.io.read_LUT()` from `colour-science` library, apply via `colour.apply_LUT(frame, lut)`. Built-in presets: `cinematic_warm` (orange-teal), `noir` (desaturated high contrast), `vintage` (faded blacks, warm highlights), `sci_fi` (cool blue-green). Store preset LUT files in `/data/film/cache/luts/`. Gateway handler `film_color_grade` in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/grade", post(film_color_grade))`. Save to `/data/film/projects/{pid}/shots/{sid}/video_final/graded.mp4`. Add `colour-science>=0.4.4` to `requirements.txt`. Return `{"video_path": "...", "preset": "cinematic_warm", "grain_applied": true}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
