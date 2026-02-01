# FILM-034: Busy/idle + 429 handling

## Task Details
- **Epic:** Film Engine — Full Production Pipeline
- **Phase:** Video Generation (7 tasks)
- **Size:** S
- **Created:** 2026-02-01

## Summary

In `agents/video_agent/main.py`, add `asyncio.Semaphore(1)` as `generation_lock` (video generation is single-threaded due to VRAM constraints). Wrap `/v1/video/generate` and `/v1/video/generate-long` handlers with `try: lock.acquire_nowait()` — on failure, return `HTTPException(status_code=429, detail={"error": "Agent busy", "queue_position": N, "estimated_wait_ms": avg_gen_time})`. Track rolling average generation time per resolution. Report `queue_depth` in heartbeat payload to gateway (matches `gateway/src/agent_registry.rs` `update_queue_depth()` method). Follow pattern from `gateway/src/upload_throttle.rs` `UploadThrottleManager` using `tokio::sync::Semaphore` (adapted to Python `asyncio.Semaphore`). In gateway, when receiving 429 from video agent, try next-best agent via `get_agents_by_role(&AgentRole::VideoGen)` sorted by score, or queue the request.

## Acceptance Criteria

- [ ] Implementation complete per description above
- [ ] Unit tests pass
- [ ] Integration with existing codebase verified
- [ ] Code follows existing patterns in the codebase

## Notes

Part of the Film Engine — Full Production Pipeline epic.
