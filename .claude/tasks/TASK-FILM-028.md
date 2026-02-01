# FILM-028: Voice agent Docker + requirements

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Voice & Dialogue Pipeline (7 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

Create `agents/voice_agent/Dockerfile` (if not already created by EPIC-voice-tts TTS-012). Base: `FROM python:3.11-slim` for CPU, multi-stage with `nvidia/cuda:12.1.0-runtime-ubuntu22.04` for GPU. Create `agents/voice_agent/requirements.txt`: pin `torch>=2.2.0`, `transformers>=4.40.0`, `qwen3-tts`, `TTS>=0.22.0` (Coqui XTTS fallback), `fastapi>=0.110.0`, `uvicorn[standard]>=0.29.0`, `soundfile>=0.12.1`, `pydub>=0.25.1`, `numpy`, `pydantic>=2.0`, `montreal-forced-aligner>=3.0.0`. Add `HEALTHCHECK --interval=30s --timeout=10s --start-period=180s CMD curl -f http://localhost:${AGENT_PORT}/health`. Add `voice-agent` service to `docker-compose.yml` with `GATEWAY_HOST=gateway`, `AGENT_PORT=8003`, `VOICE_MODEL_PATH=/data/voices/cache`, `NVIDIA_VISIBLE_DEVICES=all` for GPU passthrough. Volume mount: `/data/voices:/data/voices`. Note: if TTS-012 complete, verify Docker config includes film-specific endpoints and skip.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- TTS-012
- TTS-012

## Notes

Part of the Film Engine — Full Production Pipeline epic.
