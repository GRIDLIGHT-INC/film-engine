# FILM-040: Lip-sync agent Docker

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Lip-Sync & Performance (5 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Create `agents/lipsync_agent/Dockerfile`. Base: `FROM python:3.11-slim` with optional CUDA: `FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04` for GPU variant. Create `agents/lipsync_agent/requirements.txt`: pin `torch>=2.2.0`, `fastapi>=0.110.0`, `uvicorn[standard]>=0.29.0`, `numpy`, `pydantic>=2.0`, `Pillow>=10.0.0`, `opencv-python-headless>=4.9.0`, `scipy>=1.12.0`, `imageio[ffmpeg]>=2.34.0`. SadTalker dependencies: `face-alignment>=1.4.1`, `facexlib>=0.3.0`, `gfpgan>=1.3.8`. Wav2Lip dependencies (fallback): `librosa>=0.10.0`. Add `HEALTHCHECK --interval=30s --timeout=10s --start-period=180s CMD curl -f http://localhost:${AGENT_PORT}/health`. Add `lipsync-agent` service to `docker-compose.yml` with `GATEWAY_HOST=gateway`, `AGENT_PORT=8005`, `LIPSYNC_MODEL_PATH=/data/models/lipsync`. GPU preferred but CPU fallback: don't require `NVIDIA_VISIBLE_DEVICES`. Volume: `/data/film:/data/film`, `/data/models:/data/models`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
