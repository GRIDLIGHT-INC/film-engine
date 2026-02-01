# FILM-055: Upscale endpoint

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Post-Production Pipeline (7 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Add `POST /v1/post/upscale` to `agents/postprocess_agent/main.py`. Accept `multipart/form-data` with `video` (.mp4 binary) and `scale` (2 or 4, default 2). Create `agents/postprocess_agent/upscaler.py`: load Real-ESRGAN model via `from realesrgan import RealESRGANer`. Extract frames, upscale each via `model.enhance(frame, outscale=scale)`, reassemble. For large scale factors (4x), process frames in batches to manage VRAM: `batch_size = max(1, int(available_vram_gb / 2))`. Gateway handler `film_upscale` in `gateway/src/handlers.rs`. Register route: `.route("/film/shots/:shot_id/upscale", post(film_upscale))`. Route to PostProcess agent. Save to `/data/film/projects/{pid}/shots/{sid}/video_final/upscaled.mp4`. Return `{"video_path": "...", "original_resolution": "1024x576", "upscaled_resolution": "2048x1152", "scale": 2}`. Add `realesrgan>=0.3.0`, `basicsr>=1.4.2` to `requirements.txt`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
