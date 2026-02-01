# FILM-058: Post-process agent Docker

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Post-Production Pipeline (7 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Create `agents/postprocess_agent/Dockerfile`. Base: `FROM python:3.11-slim` (CPU-viable) with optional CUDA stage `FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04`. Create `agents/postprocess_agent/requirements.txt`: pin `torch>=2.2.0`, `fastapi>=0.110.0`, `uvicorn[standard]>=0.29.0`, `numpy`, `pydantic>=2.0`, `Pillow>=10.0.0`, `imageio[ffmpeg]>=2.34.0`, `opencv-python-headless>=4.9.0`, `codeformer-pip>=0.1.0`, `realesrgan>=0.3.0`, `basicsr>=1.4.2`, `facexlib>=0.3.0`, `gfpgan>=1.3.8`, `colour-science>=0.4.4`, `scikit-image>=0.22.0`. Add `HEALTHCHECK --interval=30s --timeout=10s --start-period=180s CMD curl -f http://localhost:${AGENT_PORT}/health`. Add `postprocess-agent` service to `docker-compose.yml` with `GATEWAY_HOST=gateway`, `AGENT_PORT=8006`, `POST_MODEL_PATH=/data/models/postprocess`. GPU optional: works on CPU for color/grain, prefers GPU for face restore and upscale. Volume: `/data/film:/data/film`, `/data/models:/data/models`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
