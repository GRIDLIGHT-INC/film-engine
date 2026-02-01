# FILM-053: Post-processing agent scaffold

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Post-Production Pipeline (7 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `agents/postprocess_agent/main.py` using FastAPI + uvicorn. Implement `/health` returning `{"status": "ok", "device": device, "models": ["codeformer", "realesrgan"], "vram_used_mb": N}`. On startup, register with gateway via `POST http://{GATEWAY_HOST}:8080/agents/register` with `roles: ["postprocess"]`, report `backend` (cuda/mps/cpu) and `vram_gb`. Create `agents/postprocess_agent/config.py` with env vars: `GATEWAY_HOST`, `AGENT_PORT=8006`, `POST_MODEL_PATH`, `AGENT_TOKEN`. Load CodeFormer model and Real-ESRGAN model at startup into `ModelManager` class (similar pattern to voice agent TTS-010). Create `agents/postprocess_agent/__init__.py`. Background heartbeat every 30s. Support both GPU and CPU inference — auto-select via `torch.cuda.is_available()`.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- TTS-010

## Notes

Part of the Film Engine — Full Production Pipeline epic.
