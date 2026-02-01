# FILM-023: Voice generation agent scaffold

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Voice & Dialogue Pipeline (7 tasks)
- **Size:** "mps"
- **Created:** 2026-02-01

## Summary

Create `agents/voice_agent/main.py` using FastAPI + uvicorn (if not already created by EPIC-voice-tts TTS-006). Implement `/health` endpoint returning `{"status": "ok", "device": device, "model_size": "0.6b", "vram_used_mb": N}`. Implement `POST /v1/register`: on startup, call gateway `POST http://{GATEWAY_HOST}:8080/agents/register` with `{"agent_id": "voice-agent-1", "host": hostname, "port": AGENT_PORT, "roles": ["voicegen"], "backend": "cuda"

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Dependencies

- TTS-006

## Notes

Part of the Film Engine — Full Production Pipeline epic.
