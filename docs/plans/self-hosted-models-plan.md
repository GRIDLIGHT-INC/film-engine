# How GRD-4453 is worked — Self-Hosted Models & AWS Daily Batch Rendering

*Operating note agreed by the two sessions working this epic (film-engine and gl-dev-media), 2026-09-28. It says how each task is worked. It holds **no task status**. Held by `backend/tests/self-hosted-models-plan.test.js`.*

## Where state lives

**Task state lives in Jira and nowhere else**: epic [GRD-4453](https://gridlight-team.atlassian.net/browse/GRD-4453), children GRD-4565…GRD-4578 (FEM-001…FEM-014). The loop reads the next child that is not Done, in FEM order, with its prerequisites below done first.

A task is closed in Jira in one step: move the child to **Done** and add a comment saying what shipped, the commit hash in each repository it touched, and the test command it ran with its real result. A copy of the status kept anywhere else would come to disagree with Jira, so this note has none.

**The prerequisites column is a hint, not state.** It is inferred from the epic's own delivery sequence and is not recorded in Jira. Where a Jira issue link says otherwise, the link wins. No issue links are created without the user.

## Roots

| Repo | Root | Branch | Remote |
|---|---|---|---|
| film-engine | `/Users/mannyhenri/code/film-engine` | `production-graph` (shipped to `main`) | `github` |
| gridlight | `/Users/mannyhenri/code/gl-dev-media` | `media` (integration branch `dev`) | `Github` |

## Test commands

Every command in the Tests column carries the repository it runs in: `[fe]` runs from the film-engine root, `[gl]` from the gridlight root. Commands are separated by `;`, and each must be one of these exactly:

- `[fe] cd backend && npm test`: the film-engine suite, the same as `node --test --test-concurrency=4 tests/*.test.js`.
- `[gl] cd gateway && cargo test --lib --bins`: the gateway, including the model manifest (`gateway/src/media_capabilities.rs` against `docs/contracts/media-capabilities-fixture.json`, drift-tested).
- `[gl] cd gateway && cargo nextest run -E 'kind(test)'`: the gateway's integration tests.
- `[gl] python3 -m pytest -q tests/contract`: the media contracts. `test_media_session_registry.py` already enforces the licence region and the instance region for every box.
- `[gl] python3 -m pytest -q agents/audio_agent/tests`, `agents/voice_agent/tests`, `agents/image_agent/tests`: the agent suites.
  **Each runs in that agent's own environment**: `python3 -m venv agents/<a>/.venv && agents/<a>/.venv/bin/pip install -r agents/<a>/requirements*.txt`. The system `python3` has no numpy, and this checkout has no per-agent venvs.
  **They are not green at baseline.** At gl `0d9a93658`: audio has 6 import errors, voice 12 failed of 119, image 10 failed of 66 (stale tests: registration and heartbeat, `main.MAX_LOADED_LORAS`, MagicMock comparisons). A task must not ADD failures against that baseline; check with the change stashed. It may fix them, and the first task that touches an agent gets that agent's suite to green.
- `[gl] python3 scripts/media_lab/serve.py up --box <box> --model <model> --region ca-central-1 --dry-run --yes`: the infrastructure rehearsal. It launches nothing and spends nothing; `--yes` is required, or it waits for the typed confirmation even in rehearsal. There is no media Terraform in gl-dev-media (its only Terraform is `control-plane/terraform`, for ECS, and unrelated); the foundation extends `serve.py` and `registry.py`.
  **Until FEM-005 lands, this rehearsal is a false pass.** It exits 0 while planning `aws ec2 run-instances --region ca-central-1` on g6e.xlarge, which ca-central-1 does not offer: `serve.py` never consults `registry.py`'s `INSTANCE_AVAILABILITY`, and only the registry's tests read it.
- `[gl] cd agent && cargo nextest run`: the Neon agent, only when a task touches it.

A **both** row runs at least one command in each repository.

## Who does what

The film-engine session drafts each task. The gl-dev-media session reviews it and owns the gateway-side edits under the same FEM key. One commit per task per repository, with the test written first.

## The AWS gate

**No AWS resource, compute or storage, is provisioned or started without the user's explicit yes for that run.** A task is gated when its acceptance provisions or starts an AWS resource: an instance, or an S3 bucket (FEM-007 stores inputs and outputs in S3 under project-scoped prefixes). A gated task is built and dry-run tested locally: the `serve.py … --dry-run` rehearsal, contract tests against a local or stub worker, and a local or stub object store in place of S3.

A gated child moves to **Done** when its dry-run half ships, and its Jira comment says "real ca-central-1 run pending the user's yes". That keeps FEM-013, which touches no AWS, from stalling behind a run nobody has approved. FEM-014's comment reads "live benchmark + end-to-end day pending the user's yes"; FEM-007's reads "real S3 bucket pending the user's yes". The real run, when approved, is recorded as a further comment on the same child.

## Region per worker

**This changes the epic's cost plan, and it needs the user's decision before FEM-009 and FEM-011 are built.**

The epic places every worker in ca-central-1. The measured offerings in gl-dev-media's `scripts/media_lab/registry.py` (`INSTANCE_AVAILABILITY`, from `aws ec2 describe-instance-type-offerings`, 2026-09-22) say ca-central-1 offers g4dn, g5 (A10G), g6 (L4), p4d (8× A100) and p5.48xlarge (8× H100), and **no g6e (L40S)** and no single-H100 type.

- **MiniMax H3 (FEM-012)** must run in ca-central-1: its licence excludes the US, EU and KR regions (`EXCLUDED_REGIONS`).
- **The L40S voice and music worker (FEM-009)** cannot run in ca-central-1 as written. The options are g6e in us-east-2, g6 (L4) in ca-central-1, or p4d in ca-central-1.
- **FLUX.2 on an H100 (FEM-011)** means the 8-GPU p5.48xlarge in ca-central-1, or a smaller type elsewhere.
- **LatentSync (FEM-010)** runs on an L4, which ca-central-1 offers as g6.

FEM-005 records the decision. FEM-009 and FEM-011 depend on it through FEM-006, which depends on FEM-005.

## Tasks

| Task | Jira | Title | Repo | Extends | Tests | Prerequisites | AWS |
|---|---|---|---|---|---|---|---|
| FEM-001 | GRD-4565 | Create the model, license, capability, and region catalog | both | gridlight's `scripts/media_lab/registry.py` and `GET /media/capabilities`; Film Engine consumes them and does not re-declare licence or region | [fe] cd backend && npm test; [gl] cd gateway && cargo test --lib --bins; [gl] python3 -m pytest -q tests/contract | None | — |
| FEM-002 | GRD-4566 | Bind every generate action to an immutable cost plan and approval | film-engine | `lib/approval-envelope.js`, `lib/approval-guard.js` | [fe] cd backend && npm test | FEM-001 | — |
| FEM-003 | GRD-4567 | Implement the Gridlight worker provider and gateway contract | both | `lib/providers/gridlight-adapter.js`, `lib/gridlight-video.js`, `gateway/src/media_capabilities.rs` | [fe] cd backend && npm test; [gl] cd gateway && cargo test --lib --bins; [gl] python3 -m pytest -q tests/contract | FEM-001, FEM-002 | — |
| FEM-004 | GRD-4568 | Build durable generation jobs, leases, retries, and reconciliation | gridlight | the gateway | [gl] cd gateway && cargo test --lib --bins; [gl] cd gateway && cargo nextest run -E 'kind(test)' | FEM-003 | — |
| FEM-005 | GRD-4569 | Provision the private ca-central-1 media generation foundation | gridlight | `scripts/media_lab/serve.py`, `scripts/media_lab/registry.py`; records the region-per-worker decision. Its own ca-central-1 box entry (the H3 box): the kept video box is in us-east-1, and `serve.py` rightly refuses to move it. **First test:** `serve.py` refuses an instance type `INSTANCE_AVAILABILITY` does not offer in the target region | [gl] python3 -m pytest -q tests/contract; [gl] python3 scripts/media_lab/serve.py up --box <box> --model <model> --region ca-central-1 --dry-run --yes | FEM-001 | gated |
| FEM-006 | GRD-4570 | Orchestrate 1–3 hour daily GPU batch windows and automatic shutdown | gridlight | `scripts/media_lab/serve.py` (stop and terminate), the gateway's jobs | [gl] cd gateway && cargo test --lib --bins; [gl] python3 -m pytest -q tests/contract | FEM-002, FEM-004, FEM-005 | gated |
| FEM-007 | GRD-4571 | Add portable asset storage, manifests, and generation provenance | both | `lib/asset-recipe.js`, `lib/provenance.js`, the gateway | [fe] cd backend && npm test; [gl] cd gateway && cargo test --lib --bins | FEM-003, FEM-004 | gated (storage) |
| FEM-008 | GRD-4572 | Deliver Stable Audio 3 Small SFX as the first local end-to-end worker | both | `agents/audio_agent/stable_audio3.py`, `stable_audio.py`, `backend_specs.py`; brings `agents/audio_agent/tests` to green in its own venv, the first task to touch that agent | [fe] cd backend && npm test; [gl] cd gateway && cargo test --lib --bins; [gl] python3 -m pytest -q tests/contract; [gl] python3 -m pytest -q agents/audio_agent/tests | FEM-003, FEM-004, FEM-007 | — |
| FEM-009 | GRD-4573 | Build the shared L40S voice and music worker | both | `agents/audio_agent/minimax_music3.py`, `backend_specs.py`; Fish Audio S2 Pro in `agents/voice_agent` is new | [fe] cd backend && npm test; [gl] cd gateway && cargo test --lib --bins; [gl] python3 -m pytest -q tests/contract; [gl] python3 -m pytest -q agents/audio_agent/tests; [gl] python3 -m pytest -q agents/voice_agent/tests | FEM-006, FEM-008 | gated |
| FEM-010 | GRD-4574 | Integrate LatentSync 1.6 lip sync and speaker/face mapping | both | new; the video it syncs comes from the existing LTX-2.5 box, so it does not wait for FEM-012 | [fe] cd backend && npm test; [gl] cd gateway && cargo test --lib --bins; [gl] python3 -m pytest -q tests/contract | FEM-006, FEM-009 | gated |
| FEM-011 | GRD-4575 | Integrate FLUX.2 [dev] for production reference imagery | both | new, in `agents/image_agent`; follows FEM-008 because that task sets the worker pattern | [fe] cd backend && npm test; [gl] cd gateway && cargo test --lib --bins; [gl] python3 -m pytest -q tests/contract; [gl] python3 -m pytest -q agents/image_agent/tests | FEM-006, FEM-008 | gated |
| FEM-012 | GRD-4576 | Integrate MiniMax H3 multi-GPU video generation in Canada Central | both | `agents/video_agent/minimax_h3.py` (`tests/contract/test_video_h3_adapter.py`) | [fe] cd backend && npm test; [gl] cd gateway && cargo test --lib --bins; [gl] python3 -m pytest -q tests/contract | FEM-006, FEM-008 | gated |
| FEM-013 | GRD-4577 | Add schema-driven Production controls, lip-sync nodes, and job operations | film-engine | the production graph (`lib/production-graph.js`, `src/index.html`) | [fe] cd backend && npm test | FEM-001, FEM-002, FEM-003, FEM-010 | — |
| FEM-014 | GRD-4578 | Add the daily shot batch planner, verification suite, and operator runbook | both | `lib/run-plan.js`, `lib/e2e-preflight.js`, `scripts/media_lab/serve.py` | [fe] cd backend && npm test; [gl] cd gateway && cargo test --lib --bins; [gl] python3 -m pytest -q tests/contract | FEM-006, FEM-013 | gated |

## Repo split, and why

- **film-engine** holds what the director and the provider registry see: the cost plan and approval (FEM-002), the Production controls and lip-sync node (FEM-013), and the Film Engine half of every **both** row (the catalog reader, the `gridlight-worker` adapter, the asset linkage, the SFX, voice, music, image and video nodes, and the batch planner UI).
- **gridlight** (gl-dev-media) holds what runs the work: the licence, region and capability facts (FEM-001's source), the gateway contract and durable jobs (FEM-004), the ca-central-1 foundation (FEM-005, built on the existing `scripts/media_lab` / `serve.py` box tooling) and batch windows (FEM-006), and the model workers. A second catalog in Film Engine would drift from the one the gateway serves, so FEM-001 consumes it.
- **Every new model in FEM-008..012 is added to the gateway manifest**, which is why each of those rows runs the gateway tests.
- **FEM-014** is **both** and gated. GRD-4578 asks for each worker benchmarked on its chosen ca-central-1 instance (cold and warm throughput, quality, cost), a final end-to-end report, a runbook that operates a full day, and all GPU compute stopped: none of that can be met without live instances. The planner, verification suite and runbook are built and tested locally first; the live benchmark and the end-to-end day wait for the user's yes.
