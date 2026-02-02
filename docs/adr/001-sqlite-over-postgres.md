# ADR-001: SQLite over PostgreSQL

## Status
Accepted

## Context
Film Engine needs a relational database for project data, scripts, scenes, shots, renders, and asset metadata. The application targets single-node deployment as part of the Gridlight desktop application.

## Decision
Use SQLite (via better-sqlite3) instead of PostgreSQL.

## Rationale
- **Zero configuration**: SQLite requires no server process, no connection string, no credentials. The database is a single file that auto-initializes on first run.
- **Single dependency**: `better-sqlite3` is the only npm dependency. No ORM, no connection pool, no driver abstraction needed.
- **Deployment simplicity**: The entire application ships as a single directory. No database server to install, configure, or maintain.
- **Performance**: For single-user workloads with <100K rows, SQLite with WAL mode provides excellent read performance. Synchronous API avoids callback/promise overhead.
- **Portability**: The database file can be copied, backed up, or moved between machines trivially.

## Consequences
- No concurrent write scaling. This is acceptable for a single-user desktop application.
- No built-in replication or clustering. Multi-user collaboration would require a different approach.
- Schema migrations run synchronously on startup, which keeps the migration system simple.
