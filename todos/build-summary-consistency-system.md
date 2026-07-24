# Build Summary: Consistency System

Feature: Film Engine Consistency System
Plan: docs/plans/consistency-system.md
Branch: fix/sse-client-disconnect-hardening
Date: 2026-07-22

## Scope Built

- Added consistency profile storage for character, location, prop, style, and voice identity locks.
- Added profile/reference/audit API routes under `/film/projects/:id/consistency`, `/film/consistency`, and `/film/shots/:id/consistency/audit`.
- Added helper logic to build locked generation context, audit readiness, and apply consistency to image and voice payloads.
- Integrated locked references/prompt contracts into storyboard, video, and voice generation.
- Added strict consistency gating for shot pipeline runs.
- Added frontend Consistency page for locking subjects and reviewing readiness.
- Added provider support for carrying local reference images into OpenAI image edits and Artlist MCP tool arguments.
- Added `recordConsistencyCheck` writer support using the existing `film_consistency_checks` columns only.
- Persisted Verify-compatible check details as `details.subjects`, `details.scorer`, and `details.thresholds` after storyboard and video asset generation.
- Added deterministic role-aware multi-reference ordering plus `references_by_role` and `reference_groups` payloads.
- Added `required_roles` readiness auditing and a locked-seed conflict guard.
- Extended consistency check writes to voice generation output assets.
- Documented the writer/read contract and reference ordering in `docs/plans/consistency-system.md`.
- Converged on one exported 10-role reference vocabulary: canonical, face, front, side, back, full_body, expression, wide, detail, color.
- Fixed locked seed application for unset and `-1` sentinel seeds while preserving explicit seed `0`.
- Made `recordConsistencyCheck` best-effort internally so Verify writes cannot fail successful generation.

## Verification

- `node --test tests/consistency-context.test.js`: 14 passing, 0 failing.
- `node --test tests/consistency-routes.test.js`: 15 passing, 0 failing.
- `node --test tests/consistency-verify.test.js tests/consistency-routes.test.js tests/pipeline-readiness.test.js`: 28 passing, 0 failing.
- `node --test tests/video-gen.test.js`: 11 passing, 0 failing.
- `node --test tests/storyboard-prompt.test.js tests/video-prompt.test.js`: 47 passing, 0 failing.
- `node --test tests/providers-openai-image.test.js tests/providers-artlist-mcp.test.js`: 25 passing, 0 failing.
- `node --test tests/video-gen.test.js tests/providers-elevenlabs.test.js`: 21 passing, 0 failing.
- `node --test tests/*.test.js`: 666 passing, 0 failing.

## Coverage

No coverage percentage is configured for this Node test suite. The build adds focused unit/integration tests for helper behavior, route validation, project isolation, lock/unlock behavior, voice locks, provider reference handling, generation payload contracts, persisted consistency-check JSON shape, required reference roles, unified role vocabulary, face-priority multi-ref ordering/grouping, seed conflict handling, seed sentinel replacement, and best-effort Verify writes.

## Linting

No lint script is defined in `backend/package.json`.

## Deviations From Plan

- No worktree was created for this milestone because the repository was already on the active implementation branch and contained the built consistency system.
- Pipeline execution currently gates readiness and generation routes carry full consistency payloads. The generic orchestrator step dispatcher still sends minimal step payloads to the selected provider; preserving route-level generation as the detailed payload path kept this build scoped and testable.
