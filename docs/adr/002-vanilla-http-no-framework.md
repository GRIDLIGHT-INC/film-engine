# ADR-002: Vanilla HTTP Server (No Framework)

## Status
Accepted

## Context
The backend needs an HTTP server to expose REST APIs. Common choices include Express, Fastify, Koa, or the built-in `node:http` module.

## Decision
Use Node.js built-in `http.createServer()` with manual routing in `server.js`.

## Rationale
- **Zero dependencies**: Combined with SQLite (ADR-001), the entire backend has exactly one npm dependency (`better-sqlite3`). No framework version conflicts, no security advisories for middleware.
- **Full control**: Route matching uses simple string splitting (`pathname.split('/')`). No middleware chain, no hidden behavior, no magic.
- **Startup speed**: The server starts in <100ms. No framework initialization overhead.
- **Learning curve**: Contributors read standard Node.js documentation, not framework-specific APIs.
- **Sufficient complexity**: The API has ~50 routes with uniform JSON request/response patterns. A framework would add abstraction without reducing complexity.

## Consequences
- Manual CORS header setup (4 lines in the request handler).
- Manual JSON body parsing via `readBody()` helper.
- No automatic request validation, parameter coercion, or OpenAPI generation.
- Route dispatch is a sequence of `if` statements, which scales linearly but is explicit and searchable.
