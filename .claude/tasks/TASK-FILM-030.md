# FILM-030: Video generation agent scaffold

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Video Generation (7 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `agents/video_agent/main.py` using FastAPI + uvicorn. Implement `/health` returning `{"status": "ok", "device": device, "model": "animatediff-sdxl", "vram_used_mb": N, "vram_total_mb": N}`. On startup, register with gateway via `POST http://{GATEWAY_HOST}:8080/agents/register` with `{"agent_id": "video-agent-1", "host": hostname, "port": AGENT_PORT, "roles": ["videogen"], "backend": "cuda", "vram_gb": N, "models_cached": ["animatediff-sdxl"]}` matching `AgentCapabilities` struct shape. Background heartbeat every 30s to `POST /agents/heartbeat`. Create `agents/video_agent/config.py` with env vars: `GATEWAY_HOST`, `AGENT_PORT=8004`, `VIDEO_MODEL_PATH`, `AGENT_TOKEN`. Create `agents/video_agent/__init__.py`. Require GPU — fail startup with clear error if `torch.cuda.is_available()` is False. Report VRAM via `torch.cuda.get_device_properties(0).total_mem / (1024**3)`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
