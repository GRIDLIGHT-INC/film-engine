# FILM-032: Camera motion controls

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Video Generation (7 tasks)
- **Size:** L
- **Created:** 2026-02-01

## Summary

In `agents/video_agent/animator.py`, create `CameraMotion` enum: `Static`, `DollyIn`, `DollyOut`, `PanLeft`, `PanRight`, `TiltUp`, `TiltDown`, `ZoomIn`, `ZoomOut`, `Tracking`. Implement `apply_camera_motion(motion: CameraMotion, num_frames: int) -> torch.Tensor` returning per-frame affine transforms. For AnimateDiff, map to motion LoRA modules: `motion_lora = {"dolly_in": "guoyww/animatediff-motion-lora-zoom-in", "pan_left": "guoyww/animatediff-motion-lora-pan-left", ...}`. Load motion LoRA via `pipe.load_lora_weights(motion_lora[motion])`. For ControlNet camera guidance (if available), generate depth maps per frame with controlled camera transforms using `controlnet_aux.MidasDetector`. Add `camera_motion: str` and `camera_speed: float` (0.1-2.0) to `/v1/video/generate` request schema. Map from scene card `camera.movement` field. Gateway passes camera params from parsed `SceneCard.camera` to video agent request body.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- 1-2

## Notes

Part of the Film Engine — Full Production Pipeline epic.
