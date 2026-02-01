# FILM-031: AnimateDiff integration

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Video Generation (7 tasks)
- **Size:** XL
- **Created:** 2026-02-01

## Summary

Create `agents/video_agent/animator.py`. Load AnimateDiff + SDXL pipeline via `diffusers`: `from diffusers import AnimateDiffPipeline, MotionAdapter`. Initialize: `adapter = MotionAdapter.from_pretrained("guoyww/animatediff-motion-adapter-sdxl-beta")`, `pipe = AnimateDiffPipeline.from_pretrained("stabilityai/stable-diffusion-xl-base-1.0", motion_adapter=adapter)`. Add `POST /v1/video/generate` endpoint to `agents/video_agent/main.py`. Accept: `{"keyframe_path": str, "prompt": str, "negative_prompt": str, "duration_s": float, "fps": int, "width": int, "height": int, "seed": int, "num_inference_steps": int, "guidance_scale": float}`. Use keyframe as `image` input with `pipe(prompt, image=keyframe, num_frames=int(duration*fps), num_inference_steps=steps)`. Export frames to MP4 using `imageio.get_writer(output_path, fps=fps, codec='libx264')`. Save to `/data/film/projects/{pid}/shots/{sid}/video_raw/clip.mp4`. Add `diffusers>=0.27.0`, `accelerate>=0.27.0`, `imageio[ffmpeg]>=2.34.0`, `safetensors` to `agents/video_agent/requirements.txt`. Return `{"video_path": "...", "duration_ms": N, "fps": 24, "resolution": "1024x576"}`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
