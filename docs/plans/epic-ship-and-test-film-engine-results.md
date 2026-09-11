# Ship and Test Film Engine — Task State

| Task | State | Note |
|------|-------|------|
| SHIP-001 | DONE | ADR-007 records local FFmpeg as the sole conform executor (FFMPEG_PATH → system PATH → ffmpeg-static); `e2e-preflight.js` declares `assembly` as depending on `ffmpeg` and probes the runtime resolver via `checkConformDependency`; `tests/conform-contract.test.js` covers it. Full suite 4157/4157. |
| SHIP-002 | DONE | `POST /projects/:id/conform` runs `runConform`: shots in the timeline's running order, best cut per shot, the project mix as master audio, written under DATA_DIR where `/film/video/:project/:file` serves it, registered as `video_final` + `metadata.kind: project_master` with measured duration and size, replacing the previous master. `conform_plan` / `conform_run` MCP tools. `tests/project-master.test.js` (8, file-and-row based, fails 5/8 against HEAD). Pure-tree full suite 4158/4158. |
| SHIP-003 | DONE | `assembly` is project-scoped in `PIPELINE_STEPS`: a project run conforms the film ONCE after every shot; shot and scene runs skip it with a reason unless `include_project_steps`. `runStatus()` is the one rule for all three runners and a failed whole-film step makes the run `failed`. `CONFORM_STATES` classifies every conform/stitch state; only an encoder failure is retried, through the single `attemptStep` loop. Migration 103 stores `steps_skipped`. `tests/assembly-once.test.js` (7, set-based over project-scoped steps × 4 router-derived entry points × conform states; fails 6/7 against HEAD). Pure-tree full suite 4165/4165. |
| SHIP-004 | DONE | `PROJECT_DELIVERABLES` in `routes/qa.js`: `video_master` passes only on the conformed film, `audio_master` only on a project-level mix (an `audio_mix` with no shot) — per-shot pieces are counted in the detail, never toward the verdict. `findProjectMaster` / `findProjectMix` in `lib/conform.js` are the one rule, and `planConform` now reads the mix through it (a per-shot mix no longer becomes the whole film's audio). Found: `POST /projects/:id/music/mix` is a stub that produces nothing, so no real project has a project mix; audio_master WARNS rather than fails for that reason. `tests/qa-master-checks.test.js` (6, set-based over the registry; fails 6/6 against HEAD). Pure-tree full suite 4171/4171. |
| SHIP-005 | DONE | `DEPENDENCY_CHECKS` registry in `lib/e2e-preflight.js` (a declared dependency with no checker reads blocked); `preflight({ resolvers })` makes the blocked path exercisable; `checkStageDependency` is read by the runners, which answer 409 `PREFLIGHT_BLOCKED` before the run row exists whenever a run would execute a whole-film step (project run, or `include_project_steps`), overridable with `ignore_preflight`. `tests/e2e-readiness.test.js` extended set-based over dependent stages × the four run entry points (fails 4/4 against HEAD). Pure-tree full suite 4175/4175. |
| SHIP-006 | TODO | SHIP-002 is done; unblocked 2026-09-10. |
| SHIP-010 | BLOCKED | Set-based source scan fails for the required 3/3 gaps (`breakdown_run`, `screenplay_ai`, `text_to_screenplay`), as this task requires, but the dispatcher forbids committing a red suite. Full suite: 4151 pass, 3 fail (the intentional MCP gap plus the two pre-existing failures recorded on SHIP-001). No commit created. |
| SHIP-011 | WAITING ON SHIP-010 | SHIP-010 is blocked. |
| SHIP-012 | WAITING ON SHIP-010 | SHIP-010 is blocked. |
| SHIP-013 | WAITING ON SHIP-010 | SHIP-010 is blocked. |
| SHIP-014 | WAITING ON SHIP-011 | SHIP-011 cannot start until SHIP-010 is done. |
| SHIP-015 | WAITING ON SHIP-014 | SHIP-014 cannot start until its dependency chain is done. |
| SHIP-020 | BLOCKED | The requested previs→storyboard implementation and both named tests already landed in commit `dc42498`; 54 focused assertions pass, including byte-identical unblocked payloads. State cannot be committed because the mandatory full suite remains red (3 unrelated/intentional failures). |
| SHIP-021 | WAITING ON SHIP-001, SHIP-020 | Phase 1 includes blocked SHIP-001, and SHIP-020 cannot be marked done under the red-suite gate. |
| SHIP-022 | WAITING ON SHIP-021 | SHIP-021 is waiting. |
| SHIP-023 | WAITING ON SHIP-021 | SHIP-021 is waiting. |
| SHIP-024 | WAITING ON SHIP-010, SHIP-021 | Phase 2 includes blocked SHIP-010, and SHIP-021 is waiting. |
| SHIP-030 | BLOCKED | Removed the unimplemented stock capability from all runtime registries, cost/metering tables, flow-node contracts, callers, and documentation while preserving independent rights provenance. The set-based focused suite passes 119/119, but `cd backend && npm test` remains red after 3 attempts: 4155 pass, 3 fail (`docs-drift.test.js`, the pre-existing plate-camera title mismatch, and SHIP-010's intentional MCP-gap test). No commit created. |
| SHIP-031 | WAITING ON SHIP-021 | SHIP-021 is waiting. |
| SHIP-032 | WAITING ON SHIP-021 | SHIP-021 is waiting. |
| SHIP-033 | TODO | SHIP-002 is done; unblocked 2026-09-10. |
