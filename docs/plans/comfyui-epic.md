# Epic: ComfyUI as a Self-Hosted Provider

> **Status: closed 2026-09-28.** Jira GRD-4503 and its 27 tasks were marked Done and archived. Gridlight on AWS (GRD-4391) is the open-weight runtime, so a separate ComfyUI provider would duplicate it. The gaps named here belong in Gridlight agents; the editor ideas moved to [`production-graph-nodes-epic.md`](production-graph-nodes-epic.md).


*2026-09-28. Planned from [`docs/plans/comfyui-research-brief.md`](comfyui-research-brief.md). User direction at review: **"Go with recommendation"**. Held by `backend/tests/comfyui-epic.test.js`: its shape, its brief, and the code it names.*

## Overview
Film Engine turns a screenplay into a finished film, and it buys every generation from hosted providers: MuAPI, Runway, Seedance, ElevenLabs, Meshy and World Labs. Two stages have no working provider. **Lip-sync** is served only by the opt-in Gridlight gateway (`backend/lib/providers/gridlight-adapter.js`). **Post** has Seedance and Gridlight and nothing that runs locally. The engine also cannot do anything that needs open-weight model control: a character LoRA, ControlNet driven from previs geometry, or a seed-exact re-render. A column for each already exists and nothing fills it.

This epic adds ComfyUI as **one more provider behind the single funnel**. An opt-in `comfyui` adapter talks to a ComfyUI server over HTTP. That server runs on an AWS GPU instance which scales to zero, because this Mac Pro (Intel Xeon, AMD Vega II) cannot run PyTorch newer than 2.2. The adapter serves `lipsync`, `video` and `post` through versioned workflow contracts checked against the server's own `/object_info`. Each generation goes through the same paths as any other provider: the payload builders, the budget gate, the job handles that survive the 60-second MCP window, the render ledger and the asset registry. The director never sees a ComfyUI graph.

It delivers, in order:
1. a measured cost per clip, before any code depends on a guess;
2. the adapter core;
3. lip-sync, which closes the one pipeline stage with no provider;
4. keyframe-to-keyframe video on Wan 2.2 for sequences;
5. a SeedVR2 + RIFE finishing pass;
6. character identity (LoRA/PuLID) and previs-driven ControlNet.

Nothing changes for an existing project until the adapter is switched on.

## Business Goals
- **Close the lip-sync gap**: the screenplay-to-final-film acceptance criterion passes through lip-sync, and today only an optional local gateway can serve it.
- **Cheaper iteration on video**: Wan 2.2 FLF2V is Apache-2.0 and billed as GPU time rather than per second of output. The claim that it is cheaper is **measured** before it is made.
- **Finishing without a paid 4K pass**: a 480p draft reaches delivery size through SeedVR2 and RIFE on our own GPU.
- **Consistency the hosted models cannot give**: a character LoRA or PuLID reference, and previs depth and pose as ControlNet, instead of describing the camera in words.
- **Honest records**: the render ledger stores the real seed, sampler and model, and the budget gate sees what the GPU costs.
- **MCP stays the reasoning path**: generation goes through Film Engine's existing tools. Comfy.org's `comfy-mcp` is used for discovery and authoring beside it, never for spending.

## Current State
| Component | Current State |
|-----------|---------------|
| Providers | 13 adapters autoloaded from `backend/lib/providers/`. None speaks to ComfyUI; the string "comfy" appears nowhere in the code. |
| Lip-sync | `lipsync` is served only by Gridlight (`gridlight-adapter.js:43`), which is opt-in and off by default. |
| Post | Served by Seedance and Gridlight. There is no local upscale or frame interpolation. |
| Keyframe video | `backend/lib/video-sequence.js` buys first/last-frame video from Runway and Seedance. |
| Render ledger | `backend/db/migrations/011_render_ledger.sql` has seed, sampler, steps, guidance, lora_ids, controlnets and model_hash columns. The sampler is hard-coded to `euler_a` in `backend/routes/video-gen.js`, and `backend/routes/storyboard.js` never writes sampler, controlnets or model_hash. |
| GPU cost | `backend/lib/usage-meter.js` writes `gpu_seconds = 0`. Self-hosted calls create no cost entry, so an hourly GPU is invisible to the budget gate. |
| Character LoRA | `film_characters.lora_id` exists. Prompts carry `<lora:…>` text that no provider reads. |
| Image standard | `backend/lib/image-standard.js` together with `backend/lib/providers/index.js` makes Nano Banana Pro override every other image pin, and `backend/lib/image-fallback.js` filters the fallback chain the same way. |
| Compute | This machine cannot run current PyTorch. No GPU host is provisioned. |

## Target State
| Component | Target State |
|-----------|---------------|
| Provider | `backend/lib/providers/comfyui.js`: opt-in, keyless, with `base_url` as a connection field. It serves `lipsync`, `video` and `post`, and never `image` (the house standard is kept). |
| Workflows | Versioned API-format templates in the repo, registered by `backend/lib/comfyui-workflows.js`. Each declares its node classes and model files and is checked against a cached `/object_info` before submission. |
| Jobs | `asyncGeneration` with a `prompt_id` handle. Results are polled from `/history` within `budgetFor()`, then collected through `/view` into `film_assets`. |
| Lip-sync | LatentSync produces `video_synced` from `video_raw` and `audio_dialogue`, reachable from the page, from `node_gen_lipsync`, and from the orchestrator. |
| Sequences | Wan 2.2 FLF2V serves the sequence planner's legs, and the in-between strip where a leg has stations. |
| Finishing | `post` sub-types `upscale` (SeedVR2) and `interpolate` (RIFE), with factors derived from the delivery size. |
| Identity and previs | A character LoRA or PuLID reference, plus previs depth and pose as ControlNet on Wan VACE. |
| Ledger and cost | The true seed, sampler, steps, guidance, lora_ids, controlnets and model_hash are written. `gpu_seconds` is measured and priced at the instance rate. |
| Host | An AWS g6e or g6 instance that scales to zero, reached over an SSM port-forward, never a public port. Documented in `docs/comfyui-host.md`. |

## Constraints
- **The image house standard stays**: the adapter declares no `image` capability. Allowing an explicit per-project image pin is an open question, not part of this scope.
- **HTTP only, never vendored**: ComfyUI is GPL-3.0. Film Engine (MIT) calls it as a separate service and keeps none of its code in the repo.
- **No paid providers through Comfy Cloud**: partner nodes resell providers Film Engine already calls directly, outside the meter.
- **`comfy-mcp` is for discovery and authoring only**: no Film Engine tool proxies generation through it.
- **No new dependency** (ADR-002): poll `/history`, and do not add the `ws` package. Progress reaches the page as SSE (ADR-003).
- **The host is off by default**: an unreachable host is a 503 in words, a normal state (ADR-004). It is never a hang, and never a silent fallback to a paid provider.
- **ComfyUI has no authentication**: the host is never exposed on a public port.
- **Model licences are checked per model**: Wan 2.2 is Apache-2.0 and accepted. HunyuanVideo (MAU cap) and Flux-dev (non-commercial) are not used without a decision.
- **Measure before claiming**: no cost comparison with Seedance or Runway appears in the product until CUI-004 has measured one.
- **Custom nodes are unsandboxed Python**: only reviewed node packs at pinned commits are installed on the host.

## Task Breakdown

### Phase 1: Host and Measurement
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| CUI-001 | GPU host runbook | Write `docs/comfyui-host.md`: a g6e.xlarge (or g6.xlarge for FP8) instance running the yanwk/comfyui-boot cu126 image, models on EBS with snapshots, and access over an SSM port-forward with no public port. It also records the pinned custom-node allowlist and each model's licence (Wan 2.2 Apache-2.0). | M | None |
| CUI-002 | Scale-to-zero and wake | Stop the instance after an idle period, following the aws-samples reference. Add a start helper Film Engine can call when the first ComfyUI job is queued. Report cold-start and model-load time as numbers, not estimates. | M | CUI-001 |
| CUI-003 | Install the reviewed workflows on the host | Install the pinned node packs (Wan 2.2 FLF2V/VACE, LatentSync, SeedVR2, RIFE, IPAdapter/PuLID, ControlNet preprocessors) and their model files, and record each `/object_info` class the workflows need. | M | CUI-001 |
| CUI-004 | Measure cost per clip | Time one Wan FLF2V 5 s 720p clip, one LatentSync pass over a 10 s shot, and one SeedVR2 + RIFE pass on the host. Write the GPU seconds and the $ at the instance rate beside Seedance's measured $0.85 per 5 s 480p clip. This is the only source for any cost claim in this epic. | S | CUI-002, CUI-003 |

### Phase 2: Adapter Core
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| CUI-005 | Adapter skeleton, opt-in | Create `backend/lib/providers/comfyui.js`: keyless, a `base_url` connection field (supported by `backend/routes/providers.js`), capabilities `lipsync`, `video` and `post`, and never `image`, so the house standard is untouched. `available()` returns a CACHED probe of `/system_stats`, because `isProviderConfigured` calls it synchronously. Model it on `gridlight-adapter.js` and `fluidsynth.js`. | M | None |
| CUI-006 | Rate row so the server boots | Add a `comfyui:*` `self_hosted` row to `backend/lib/provider-pricing.js`. Without it `assertCoverage` refuses to boot the moment the adapter is autoloaded. Mark it `self_hosted`, because the GPU is priced by CUI-010, not per call. | S | CUI-005 |
| CUI-007 | Workflow contracts | Create `backend/lib/comfyui-workflows.js`: versioned API-format templates keyed by capability and workflow, each declaring its node classes, model files and input slots. Check them against a cached `/object_info` (the way `backend/lib/gridlight-video.js` reads its gateway's model list). A missing node or model is refused by name as `PRECONDITION`. | L | CUI-005 |
| CUI-008 | Async handle and collect | Set `asyncGeneration: true`. `POST /prompt` returns `prompt_id`, which is recorded through `onHandle` before polling. Poll `/history` within `budgetFor()`, fetch results through `/view`, and implement `collect()` so `backend/lib/generation-jobs.js` recovers a job the MCP host abandoned. Inputs go up through `/upload/image` with a unique name per job. Use `backend/lib/providers/bfl-image.js` as the model. | M | CUI-007 |
| CUI-009 | Errors in words | Map `node_errors`, `execution_error`, GPU out-of-memory, an unreachable host and a stopped instance to named refusals. None is retried if it is our fault, and none falls back to a paid provider. Relay progress as SSE when the route streams. | M | CUI-008 |
| CUI-010 | GPU seconds reach the budget | Measure each job's execution time from `/history`, write it to `gpu_seconds` instead of the hard-coded 0 in `backend/lib/usage-meter.js`, and price it at a `comfyui_gpu_usd_per_hour` setting so the 402 budget gate and the spend report see it. | M | CUI-008 |
| CUI-011 | Render ledger tells the truth | Write the true seed, sampler, steps, guidance, lora_ids, controlnets and model_hash from the submitted graph and `/object_info` into `render_ledger`. Locked mode then resubmits the recorded graph with the same seed. | M | CUI-008 |
| CUI-012 | Readiness and dry run | `backend/lib/e2e-preflight.js` reports a pinned ComfyUI host as blocked in words when it is unreachable or missing a workflow's node. The free dry run shows the exact graph that would be sent. Add a set-based `backend/tests/comfyui-adapter.test.js` against a fake ComfyUI server that iterates every registered workflow. | M | CUI-009, CUI-010, CUI-011 |

### Phase 3: Lip-sync
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| CUI-013 | LatentSync lip-sync workflow | Build a lipsync payload for the ComfyUI workflow from `video_raw` and the shot's `audio_dialogue` lines (mixed to one track), producing `video_synced`, measured and registered. The builder stays in `backend/lib/capability-payloads.js`, so preview and purchase match. | M | CUI-012 |
| CUI-014 | Lip-sync reachable everywhere | Make it reachable from `backend/routes/lipsync.js` (page and batch), from `node_gen_lipsync`, and from the orchestrator. Once a project pins `lipsync` to comfyui, preflight stops reporting lip-sync as finished-in-NLE. | M | CUI-013 |
| CUI-015 | Prove it on the thirty-second fixture | Run lip-sync on the fixture screenplay's speaking shot through MCP, then conform. Measure that the master's mouth region changed and that its audio is the dialogue, not silence. | S | CUI-014 |

### Phase 4: Sequences and Finishing
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| CUI-016 | Wan 2.2 FLF2V video | Add a video workflow that takes the first and last keyframes as hard boundary frames. Declare `maxKeyframes: 2` and a reference contract, and route the length and raster through the adapter's own snapping. `backend/lib/video-sequence.js` then plans legs against it unchanged. | L | CUI-012 |
| CUI-017 | In-between strips on Wan | Serve an in-between strip leg by leg (station to station) through the same workflow, and report stations beyond the ceiling. Keep the approval fingerprint gate. | M | CUI-016 |
| CUI-018 | SeedVR2 upscale | Add a `post` upscale sub-type whose factor is derived from the delivery size (the draft-to-4K rule), measured from the output file, with the unreachable-in-one-pass case named. | M | CUI-012 |
| CUI-019 | RIFE frame interpolation | Add a `post` interpolate sub-type from the generated rate to the project's `target_fps`, applied after upscale. Measure the output frame count against the length. | M | CUI-018 |
| CUI-020 | Compare generators includes ComfyUI | The Compare Generators tab and `spend_compare` list ComfyUI at the rate measured in CUI-004, marked self-hosted with its GPU rate, so a cheap row is a number, not a guess. | S | CUI-004, CUI-016 |

### Phase 5: Identity and Previs Geometry
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| CUI-021 | Character identity input | Feed a character's `lora_id` (a registered `lora_weights` asset) or its front plate as a PuLID/IPAdapter reference into Wan workflows. Stop emitting `<lora:…>` prompt text to providers that ignore it, and report which identity input travelled. | L | CUI-016 |
| CUI-022 | LoRA training decision recorded | Record whether LoRA training runs as a job on the host or outside and gets registered, and implement only the registration path in this epic. | S | CUI-021 |
| CUI-023 | Previs depth and pose as ControlNet | Render previs depth and figure pose for a shot's approved blocking, and send them as ControlNet inputs to Wan VACE. Applied blocking only, never staged, following the previs boundary. | L | CUI-016 |
| CUI-024 | Scheduling by model residency | Order ComfyUI jobs by model so that loading Wan, LatentSync and SeedVR2 is not repeated per shot, using the `MODEL_PROFILES` in `backend/lib/scheduling-engine.js`. | M | CUI-017, CUI-018 |

### Phase 6: Documentation and Proof
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| CUI-025 | Agent guide and comfy-mcp | Document in `docs/claude-desktop-guide.md` how to pin ComfyUI per capability, and how to attach Comfy.org's `comfy-mcp` beside Film Engine for discovery and authoring only, never for spending. | S | CUI-014 |
| CUI-026 | End-to-end film through ComfyUI | Take the thirty-second fixture from screenplay to master through MCP with ComfyUI serving lipsync, one sequence leg and the finishing pass. The budget gate shows GPU spend and every clip is measured. | M | CUI-015, CUI-019, CUI-020 |
| CUI-027 | CLAUDE.md and docs drift | Record the adapter, its contracts, its host and its tests in CLAUDE.md, so the docs-drift test holds the tree to it. | S | CUI-026 |

## Open Questions
1. **Images and the house standard**: should an explicit per-project pin be allowed to route `image` to ComfyUI, for LoRA or ControlNet frames? This epic keeps the house standard and declares no `image` capability.
2. **GPU host**: this epic assumes EC2 with scale-to-zero. RunPod (per-second billing, 20–60 s cold starts) and Modal (2–4 s cold starts, higher hourly rate) should be revisited once CUI-004's numbers exist.
3. **Model licences**: Wan 2.2 is Apache-2.0 and assumed. HunyuanVideo (Tencent licence, 100M MAU cap) and Flux-dev (non-commercial) stay out until approved.
4. **Spend to measure**: CUI-004 needs approval to run a GPU instance for about an hour, a few dollars.
5. **Custom-node allowlist**: who reviews a node pack before it is installed on the host, and how often are the pinned commits bumped?
6. **LoRA training**: in Film Engine as a host job, or outside and registered? See CUI-022.

## Success Metrics
- `backend/tests/comfyui-epic.test.js` and `backend/tests/comfyui-adapter.test.js` pass, and every registered workflow is checked against a fake `/object_info`.
- With the adapter off, every existing test passes unchanged and no project's resolution changes.
- Lip-sync on the thirty-second fixture produces a measured `video_synced` through MCP, and preflight reports lip-sync as ready rather than finished-in-NLE.
- A Wan FLF2V leg and a SeedVR2 + RIFE finish land as measured assets that the conform uses.
- Every ComfyUI generation writes a non-zero `gpu_seconds` and a render_ledger row with its real seed, sampler and model_hash, and locked mode reproduces a frame.
- The measured $ per clip from CUI-004 is recorded, and every cost comparison in the product cites it.
- The host is never reachable on a public port, and it is stopped when idle.
