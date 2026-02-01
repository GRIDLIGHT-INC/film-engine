# FILM-035: Video agent Docker + requirements

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Video Generation (7 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Create `agents/video_agent/Dockerfile`. Base: `FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04` (GPU required). Install Python 3.11 via `apt-get`. Create `agents/video_agent/requirements.txt`: pin `torch>=2.2.0`, `diffusers>=0.27.0`, `transformers>=4.40.0`, `accelerate>=0.27.0`, `safetensors`, `imageio[ffmpeg]>=2.34.0`, `controlnet-aux>=0.0.9`, `fastapi>=0.110.0`, `uvicorn[standard]>=0.29.0`, `numpy`, `pydantic>=2.0`, `Pillow>=10.0.0`. Add `HEALTHCHECK --interval=30s --timeout=10s --start-period=300s CMD curl -f http://localhost:${AGENT_PORT}/health` (longer start period for model loading). Add `video-agent` service to `docker-compose.yml` with `GATEWAY_HOST=gateway`, `AGENT_PORT=8004`, `VIDEO_MODEL_PATH=/data/models/video`, `NVIDIA_VISIBLE_DEVICES=all`, `deploy: resources: reservations: devices: - driver: nvidia count: 1 capabilities: [gpu]`. Volume mount: `/data/film:/data/film`, `/data/models:/data/models`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
