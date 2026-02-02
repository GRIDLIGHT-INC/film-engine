# ADR-003: Server-Sent Events over WebSockets

## Status
Accepted

## Context
Several features require real-time server-to-client communication: screenplay AI streaming, storyboard generation progress, pipeline run monitoring, and scene breakdown streaming.

## Decision
Use Server-Sent Events (SSE) via `EventSource` instead of WebSockets.

## Rationale
- **Simplicity**: SSE uses standard HTTP. The server writes to `res.write()` with `text/event-stream` content type. No upgrade handshake, no frame protocol, no ping/pong.
- **Unidirectional fit**: All streaming use cases are server-to-client. The client initiates via POST, the server streams progress events. No bidirectional communication needed.
- **Browser native**: `EventSource` is built into every modern browser. No client library needed.
- **HTTP/2 compatible**: SSE works naturally with HTTP/2 multiplexing, unlike WebSockets which require a separate connection.
- **Automatic reconnection**: `EventSource` handles reconnection automatically with Last-Event-ID tracking.

## Consequences
- No client-to-server streaming. Client actions use regular POST/PUT requests.
- SSE connections count against browser's per-domain connection limit (6 in HTTP/1.1). HTTP/2 mitigates this.
- Multi-user collaboration (future) would likely need WebSockets or WebRTC for bidirectional real-time sync.
