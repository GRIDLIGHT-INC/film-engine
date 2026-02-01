# FILM-037: Lip-sync agent scaffold

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Lip-Sync & Performance (5 tasks)
- **Size:** M
- **Created:** 2026-02-01

## Summary

Create `agents/lipsync_agent/main.py` using FastAPI + uvicorn. Implement `/health` returning `{"status": "ok", "device": device, "model": "sadtalker", "vram_used_mb": N}`. On startup, register with gateway via `POST http://{GATEWAY_HOST}:8080/agents/register` with `roles: ["lipsync"]`, `backend`, `vram_gb`. Create `agents/lipsync_agent/config.py` with env vars: `GATEWAY_HOST`, `AGENT_PORT=8005`, `LIPSYNC_MODEL_PATH`, `AGENT_TOKEN`, `LIPSYNC_MODEL=sadtalker` (primary) or `wav2lip` (fallback). Create `agents/lipsync_agent/__init__.py`. Load SadTalker model at startup: download checkpoints to `/data/models/lipsync/sadtalker/` if not present. Create `agents/lipsync_agent/sadtalker_wrapper.py`: wrap SadTalker inference as `def sync(video_path: str, audio_path: str, viseme_path: Optional[str]) -> str` returning output video path. Create `agents/lipsync_agent/wav2lip_wrapper.py` as fallback with same interface. Background heartbeat every 30s.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
