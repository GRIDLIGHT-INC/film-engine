# ADR-004: Gridlight External Service Integration Pattern

## Status
Accepted

## Context
Film Engine integrates with external AI services (ImageGen, Voice-TTS, VideoGen, MusicGen) hosted on the Gridlight platform. These services may be unavailable, slow, or rate-limited.

## Decision
Use a proxy pattern where Film Engine routes act as intermediaries to external services, with configuration via environment variables.

## Rationale
- **Decoupling**: Route handlers contain the business logic (prompt engineering, parameter mapping). External service calls are isolated to specific functions. If a service is unavailable, the route returns a clear error.
- **Environment configuration**: Service URLs are configured via env vars (`IMAGEGEN_URL`, `VOICETTS_URL`, etc.) with sensible defaults pointing to `localhost`.
- **Graceful degradation**: Features that depend on unavailable services (storyboard generation without ImageGen, voice without TTS) fail gracefully with descriptive error messages. The rest of the application continues to work.
- **Prompt engineering layer**: Each service has a dedicated prompt builder (`storyboard-prompt.js`, `video-prompt.js`, `music-prompt.js`) that transforms scene card data into service-specific payloads. This keeps prompt engineering testable and separate from HTTP concerns.

## Consequences
- No automatic retries or circuit breakers (could be added in pipeline orchestrator).
- External services are assumed to accept JSON and return JSON or binary data.
- Service health is not monitored centrally. Each route checks availability on demand.
