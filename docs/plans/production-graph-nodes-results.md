# Production Graph Nodes — Task State

Epic: `docs/plans/production-graph-nodes-epic.md` · Jira GRD-4533 (children GRD-4534..GRD-4556, in PGN order).
Decisions recorded 2026-09-28: every generation gets a job row; collapse is per project; no live image previews for now; held nodes excluded from the budget total and listed. Still open: which coverage patterns ship first (PGN-020).

| Task | Jira | State | Note |
|------|------|-------|------|
| PGN-001 | GRD-4534 | DONE | Migration 117 (`117_generation_progress.sql`): percent, phase, started_at, heartbeat_at, collectable on film_generation_jobs. `lib/generation-progress.js` (start / attachHandle / report throttled to 1 write/s/job with the latest value kept / flush). `withJobRecording_` in `lib/providers/index.js` now opens a row for EVERY generation (sync and async, generate and generateStream; llm and refusals excluded); an async row becomes the handle on onHandle; settles completed/failed, stays pending+collectable when the provider still holds it. `pending()`/`recoverable()` skip collectable=0. `tests/generation-progress.test.js` (9, set-based over every adapter x capability; reverting to async-only fails 3). Hold moved to migration 118. |
| PGN-002 | GRD-4535 | TODO | Adapters report what they can |
| PGN-003 | GRD-4536 | TODO | Progress on the running node |
| PGN-004 | GRD-4537 | TODO | Node states from the impact report |
| PGN-005 | GRD-4538 | TODO | Draw states on nodes and edges |
| PGN-006 | GRD-4539 | TODO | Run what changed: plan |
| PGN-007 | GRD-4540 | TODO | Run what changed: run |
| PGN-008 | GRD-4541 | TODO | Run to here: plan |
| PGN-009 | GRD-4542 | TODO | Run to here: run and menu |
| PGN-010 | GRD-4543 | TODO | One queue read model |
| PGN-011 | GRD-4544 | TODO | Queue strip under the canvas |
| PGN-012 | GRD-4545 | TODO | Cancel, stated honestly |
| PGN-013 | GRD-4546 | TODO | Provenance read model |
| PGN-014 | GRD-4547 | TODO | How-was-this-made panel and compare |
| PGN-015 | GRD-4548 | TODO | Drop a file to find its recipe |
| PGN-016 | GRD-4549 | TODO | Hold on shots, sequences and cues |
| PGN-017 | GRD-4550 | TODO | Honour the hold in every batch run |
| PGN-018 | GRD-4551 | TODO | Collapse a sequence or scene |
| PGN-019 | GRD-4552 | TODO | Double-click to add |
| PGN-020 | GRD-4553 | TODO | Coverage patterns |
| PGN-021 | GRD-4554 | TODO | MCP tools for every new action |
| PGN-022 | GRD-4555 | TODO | Production graph tests and browser check |
| PGN-023 | GRD-4556 | TODO | CLAUDE.md and the agent guide |
