# How GRD-4453 is worked — Self-Hosted Models & AWS Daily Batch Rendering

*Operating note agreed by the two sessions working this epic (film-engine and gl-dev-media), 2026-09-29. It says how each task is worked. It holds **no task status**. Held by `backend/tests/self-hosted-models-plan.test.js`.*

## Where state lives

**Task state lives in Jira and nowhere else**: epic [GRD-4453](https://gridlight-team.atlassian.net/browse/GRD-4453), children GRD-4565…GRD-4578 (FEM-001…FEM-014). The loop reads the next child that is not Done, in FEM order, with its prerequisites below done first.

A task is closed in Jira in one step: move the child to **Done** and add a comment saying what shipped, the commit hash in each repository it touched, and the test command it ran with its real result. A copy of the status kept anywhere else would come to disagree with Jira, so this note has none.

## Roots

| Repo | Root | Branch | Remote |
|---|---|---|---|
| film-engine | `/Users/mannyhenri/code/film-engine` | `production-graph` (shipped to `main`) | `github` |
| gridlight | `/Users/mannyhenri/code/gl-dev-media` | `media` (integration branch `dev`) | `Github` |

## Test commands

- **film-engine**: `cd backend && npm test`, the same as `node --test --test-concurrency=4 tests/*.test.js`.
- **gridlight gateway**: `cd gateway && cargo test --lib --bins`. For integration tests: `cd gateway && cargo nextest run -E 'kind(test)'`.
- **gridlight media agents / contracts**: `python3 -m pytest -q tests/contract`.
- **gridlight Neon agent** (only when a task touches it): `cd agent && cargo nextest run`.
- A **both** row runs both repositories' commands.

## Who does what

The film-engine session drafts each task. The gl-dev-media session reviews it and owns the gateway-side edits under the same FEM key. One commit per task per repository, with the test written first.

## The AWS gate

**No AWS instance is provisioned or started without the user's explicit yes for that run.** Gated tasks are built and dry-run tested locally (IaC plan, contract tests against a local or stub worker). The real ca-central-1 run waits for that yes, and the Jira comment says which half was done.

## Tasks

Prerequisites are inferred from the epic's own delivery sequence (governance, then jobs and the cloud foundation, then the workers, then Production controls, then the batch planner). They are not recorded in Jira.

| Task | Jira | Title | Repo | Tests | Prerequisites | AWS |
|---|---|---|---|---|---|---|
| FEM-001 | GRD-4565 | Create the model, license, capability, and region catalog | film-engine | cd backend && npm test | None | — |
| FEM-002 | GRD-4566 | Bind every generate action to an immutable cost plan and approval | film-engine | cd backend && npm test | FEM-001 | — |
| FEM-003 | GRD-4567 | Implement the Gridlight worker provider and gateway contract | both | cd backend && npm test; cd gateway && cargo test --lib --bins; python3 -m pytest -q tests/contract | FEM-001, FEM-002 | — |
| FEM-004 | GRD-4568 | Build durable generation jobs, leases, retries, and reconciliation | gridlight | cd gateway && cargo test --lib --bins; cd gateway && cargo nextest run -E 'kind(test)' | FEM-003 | — |
| FEM-005 | GRD-4569 | Provision the private ca-central-1 media generation foundation | gridlight | python3 -m pytest -q tests/contract | FEM-001 | gated |
| FEM-006 | GRD-4570 | Orchestrate 1–3 hour daily GPU batch windows and automatic shutdown | gridlight | cd gateway && cargo test --lib --bins; python3 -m pytest -q tests/contract | FEM-002, FEM-004, FEM-005 | gated |
| FEM-007 | GRD-4571 | Add portable asset storage, manifests, and generation provenance | both | cd backend && npm test; cd gateway && cargo test --lib --bins | FEM-003, FEM-004 | — |
| FEM-008 | GRD-4572 | Deliver Stable Audio 3 Small SFX as the first local end-to-end worker | both | cd backend && npm test; python3 -m pytest -q tests/contract | FEM-003, FEM-004, FEM-007 | — |
| FEM-009 | GRD-4573 | Build the shared L40S voice and music worker | both | cd backend && npm test; python3 -m pytest -q tests/contract | FEM-006, FEM-008 | gated |
| FEM-010 | GRD-4574 | Integrate LatentSync 1.6 lip sync and speaker/face mapping | both | cd backend && npm test; python3 -m pytest -q tests/contract | FEM-006, FEM-009 | gated |
| FEM-011 | GRD-4575 | Integrate FLUX.2 [dev] for production reference imagery | both | cd backend && npm test; python3 -m pytest -q tests/contract | FEM-006, FEM-008 | gated |
| FEM-012 | GRD-4576 | Integrate MiniMax H3 multi-GPU video generation in Canada Central | both | cd backend && npm test; python3 -m pytest -q tests/contract | FEM-006, FEM-008 | gated |
| FEM-013 | GRD-4577 | Add schema-driven Production controls, lip-sync nodes, and job operations | film-engine | cd backend && npm test | FEM-001, FEM-002, FEM-003, FEM-010 | — |
| FEM-014 | GRD-4578 | Add the daily shot batch planner, verification suite, and operator runbook | both | cd backend && npm test; cd gateway && cargo test --lib --bins; python3 -m pytest -q tests/contract | FEM-006, FEM-013 | — |

## Repo split, and why

- **film-engine** holds what the director and the provider registry see: the model catalog (FEM-001), the cost plan and approval (FEM-002), the Production controls and lip-sync node (FEM-013), and the Film Engine half of every **both** row (the `gridlight-worker` adapter, the asset linkage, the SFX, voice, music, image and video nodes, and the batch planner UI).
- **gridlight** (gl-dev-media) holds what runs the work: the gateway contract and durable jobs (FEM-004), the ca-central-1 foundation (FEM-005, built on the existing `scripts/media_lab` / `serve.py` box tooling) and batch windows (FEM-006), and the model workers.
- **FEM-014** is **both** but not gated. The planner, verification suite and runbook are built and tested without starting compute. The end-to-end GPU day it verifies is FEM-006's gated run.
