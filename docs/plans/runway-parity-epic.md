# Epic: Runway as the House Video Provider — Parity Through Film Engine's Own Adapter

*Planned from [`runway-parity-brief.md`](runway-parity-brief.md) and [`runway-parity-research.md`](runway-parity-research.md), 2026-09-25. **User direction, verbatim: "Follow brief: M1→M2→M3".** Held to itself and to the code by `backend/tests/runway-parity-epic.test.js`.*

## Overview

Film Engine already talks to Runway. `backend/lib/providers/runway.js` is 1,150 lines, and it has handles, collect, Aleph 2, the multi-shot recipe and 13 registered video models. But it reaches **6 of the 49 paths** in Runway's own API, and it declares one keyframe ceiling for every model. That ceiling is wrong for the default model (`gen4.5`), the draft tier (`gen4_turbo`) and the production tier (`hailuo3`): all three accept a first frame only. The adapter also builds reference packages it never sends. And two orchestrated pipeline stages, lip-sync and post, have no hosted provider at all. Runway serves both.

This epic makes a **Runway API org** the house video provider, **through Film Engine's own adapter**. Runway's generation MCP is not the route. The distinction is the goal's rabbit hole stated positively: reasoning stays on the MCP agent host, which is already the only LLM here, and generation stays in the provider registry. That way every asset lands in `film_assets`, every credit is metered against a project, and every paid call passes the free-preview confirmation first. Runway's MCP spends *web-plan* credits and returns media into a chat, which is exactly the path this architecture exists to avoid.

It delivers in the three milestones the user chose, in order:
- **M1, correctness.** Fix the defect and derive the registry from the spec rather than typing it beside it.
- **M2, the full request.** Uploads, the per-model request body, real cost, the account's limits, cancel, and a moderation cap.
- **M3, the two empty capabilities.** `post` and `lipsync`, plus an Aleph still preview.

When it ships, a screenplay can travel from keyframe to finished, finished-in-engine footage on one account, with nothing done outside Film Engine.

## Business Goals

- **Close the screenplay-to-final-movie gap on a hosted provider**: `lipsync` and `post` are the two orchestrated steps no hosted provider can run today. The acceptance criterion ("every stage… all managed from Film Engine") is not met while they are finished in the NLE by exemption.
- **Stop paying for what is not sent**: the role packages for `hailuo3` and `seedance2_5` are priced by `lib/video-cost.js` and dropped by `buildVideoRequest`. Every credit estimated should be a field in the request.
- **Make the default path work**: a first/last-frame sequence on default settings currently sends a frame position the model refuses.
- **Spend is measured, not estimated**: Runway returns `cost.credits` per task and the account's tier and balance. The meter and the run plan should read them instead of a hand-kept rate book that still carries a sunset model.
- **Protect the account**: moderated generations are billed and repeats can suspend an org. One provider's refusal must never be re-sent to that same provider.
- **Keep reasoning on MCP**: no task adds a server-side LLM call. The connected agent host remains the model, as `tests/mcp-no-server-llm.test.js` enforces.

## Current State

| Component | Current State |
|-----------|---------------|
| Runway adapter reach | Calls `image_to_video`, `text_to_video`, `video_to_video`, `text_to_image`, `recipes/multi_shot_video` and `tasks/{id}`: 6 of 49 spec paths |
| Keyframe ceiling | `MAX_KEYFRAMES = 2` for the whole adapter. The spec says 8 of 16 i2v models accept `last`, and `gen4.5`, `gen4_turbo` and `hailuo3` are first-only |
| Model registry | `RUNWAY_VIDEO_MODELS` is hand-typed with 13 entries. `grok_imagine_1_5`, `wan3`, `wan3_prime`, `gemini_omni_flash_1.1` and `h3_max` are missing. `runway-readiness.test.js` pins the stale 13 as "official" |
| Request body | Sends `model, promptText, ratio, duration, promptImage, seed`. Never sends `references`, `referenceVideos`, `referenceAudio`, `resolution`, `audio`, `outputFormat` or `contentModeration` |
| Large inputs | Anything over the 5MB data-URI ceiling is refused, naming `POST /v1/uploads` as unimplemented |
| Cost | `lib/provider-pricing.js` rows: `gen3a_turbo` (sunset 2026-07-30) is present, while `hailuo3`, the seedance family, `veo3.1` and the multi-shot recipe are absent. Nothing reads `task.cost` |
| Account limits | Not read. The run plan cannot know a new org is Tier 1 (1–2 concurrent) |
| Handles | `generate()` records a handle via `onHandle`, but `generateNativeSequence` passes none, so an abandoned multi-shot job is lost |
| Cancel | `DELETE /v1/tasks/{id}` is called only when a person cancels one job from the Production graph queue (`cancelJob`, added by PGN-012). A cancelled pipeline run still does not cancel its in-flight tasks, so it keeps billing them |
| Refusals | `lib/image-fallback.js` `isRefusal` walks *past* a refusal to the next provider, and nothing caps same-provider retries |
| `post` | Only `seedance` serves it, and only for upscale. Grade, face restore and composite are refused |
| `lipsync` | No hosted provider. Only the Gridlight gateway declares it, and Gridlight does not implement it |
| Aleph edit | `lib/video-edit.js` runs `aleph2` background replace behind a prompt preview. No picture of the result exists before 56+ credits are spent |

## Target State

| Component | Target State |
|-----------|---------------|
| Spec contract | A dated snapshot (`tests/fixtures/runway-openapi-snapshot.json`) refreshed by a script. Tests hold the adapter to it in both directions |
| Keyframe ceiling | Per model, derived from the spec. `lib/video-sequence.js` asks per model, and a first-only model degrades to a still per shot with the reason stated |
| Model registry | Every spec video model is registered or named as excluded with a reason. Policy fields (tier, status, surcharges) stay hand-kept |
| Request body | One builder reads a per-model field map. The role package, resolution, audio, output format and moderation travel where the model accepts them, and the free preview shows the same body |
| Large inputs | The adapter chooses URL, data URI or `runway://` upload by size and kind, cached per file identity for 24h |
| Cost | Every registered model has a rate row. `cost.credits` is recorded as measured, and estimates are marked as estimates |
| Account limits | `/v1/organization` is read, and the run plan serialises or refuses against the real concurrency and daily cap |
| Handles and cancel | Every Runway generation path records a handle, and a cancelled run cancels its in-flight tasks |
| Refusals | A `SAFETY.*` failure is never re-sent to the same provider. The fallback walks to other providers only |
| `post` | Runway serves upscale (`magnific_video_upscaler_creative`), frame rate (`enhance_frame_rate`) and HDR (`ruby`). The rest stay refused by name |
| `lipsync` | Runway `act_two` on `/v1/character_performance`, proven by one recorded paid probe |
| Aleph edit | The edit is shown as a still first (one image), then run with that still as keyframe 0 |

## Constraints

- **Our adapter, not Runway's MCP**: Runway's MCP bills web credits and returns media to a chat, so no task routes generation through it. It may be documented as a director's side tool and nothing more.
- **No server-side LLM**: nothing in this epic calls a model to reason. `tests/mcp-no-server-llm.test.js` must stay green.
- **An API org, not a web plan (assumption)**: web and API credits are separate and non-transferable. The brief assumed an API org and the user accepted the brief. This stays listed under Open Questions until the account is opened.
- **Voice stays on direct ElevenLabs (assumption)**: casting, previews and the voice catalogue are ElevenLabs endpoints, and Runway's `/v1/voices` is a different catalogue. This is also listed under Open Questions.
- **ProRes on finals only (assumption)**: `outputFormat: prores` costs +5 credits/s on every take. The draft-then-finish rule applies. Also listed under Open Questions.
- **One payload path**: every new field goes through `buildVideoRequest` and `describeVideoRequest` together. A preview that is built differently from the purchase is the previs-boundary defect.
- **Every paid path is confirmed first**: new spending surfaces (post, lipsync, Aleph preview) go through the shared confirmation, and `every-generate-button.test.js` discovers them.
- **Strictest default for the unknown**: a model the spec does not describe gets the most conservative ceilings (1 keyframe, the 1000-character prompt, no references). Over-sending is a rejection that costs a generation.
- **Nothing is fabricated from the spec**: a field the snapshot does not show for a model is not sent to that model.
- **Moderation is billed**: tests that exercise refusals run against a mock. The only paid calls in this epic are named probes (RWP-018, RWP-020).
- **Music, 3D, worlds and the LLM do not move**: Runway does not serve them via the API. Their providers are untouched.

## Task Breakdown

### Phase 1: Correctness (M1)
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| RWP-001 | Refresh script for the spec snapshot | `tests/refresh-runway-contract.js` regenerates `runway-openapi-snapshot.json` from `openapi.json` (operations, models per endpoint, last-frame support, promptText limits, reference limits, output formats, audio), dated. This is the MuAPI-contract precedent | M | None |
| RWP-002 | Per-model keyframe ceilings | Each registry entry declares `maxKeyframes` from the snapshot. `keyframesFor(adapter, model)` is the one rule, and `lib/video-sequence.js`, the sequence-plan preview and the in-between planner read it. A first-only model degrades to one still per shot with the reason stated. Fixes the live defect for `gen4.5`, `gen4_turbo` and `hailuo3` | M | RWP-001 |
| RWP-003 | Registry derived from the spec | Every spec video model is registered or listed in an exclusion map with a reason. Adds `grok_imagine_1_5`, `wan3`, `wan3_prime`, `gemini_omni_flash_1.1` and `h3_max` with durations, ratios and prompt limits. `runway-readiness.test.js` reads the snapshot instead of a typed list | M | RWP-001 |
| RWP-004 | Per-model prompt limits | `promptLimit` moves onto each model (1000 for gen4.5, 3500 for seedance2, 15000 for seedance2_5, 20000 for wan3), read by the motion compiler's fit. The adapter value becomes the strict default | S | RWP-001 |
| RWP-005 | The rate book matches the registry | Every registered model has a `runway:video` rate row with its source and date. `gen3a_turbo` is removed and named as sunset. The meter's multi-shot model names match rows | S | RWP-003 |
| RWP-006 | Handles on every Runway path | `generateNativeSequence` passes `onHandle`, so an abandoned multi-shot job is collectable. The check derives every call site that reaches the Runway adapter's `generate` and requires a handle | S | None |
| RWP-007 | Tiers name models that can do what they are asked | `video-tiers.js` draft and production are re-checked against per-model keyframes. A sequence on a first-only tier degrades or proposes a first+last model, named in the plan. The default two-frame model stays an open question and is not hardcoded here | S | RWP-002 |

### Phase 2: The full request (M2)
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| RWP-008 | `POST /v1/uploads` | The ephemeral upload (512B–200MB), returning `runway://`, cached by file identity (size and mtime) for 24h. The adapter chooses URL, data URI or upload by size and kind, and the existing oversize refusal becomes an upload | L | None |
| RWP-009 | Per-model request field map | `buildVideoRequest` reads which of `references`, `referenceVideos`, `referenceAudio`, `resolution`, `audio`, `negativePrompt` and `outputFormat` each model accepts, from the snapshot. The role package from `lib/video-reference.js` finally travels | L | RWP-001, RWP-003 |
| RWP-010 | Preview shows the whole body | `describeVideoRequest` and `video_preview` report every new field and each reference's role, from the same builder as the purchase. The previs-boundary test counts direct builder calls | M | RWP-009 |
| RWP-011 | ProRes and HDR on finals | `outputFormat`/`proresProfile` are set on a final or finishing pass only, never on a draft, with the surcharge shown in the estimate. The NLE export picks up the ProRes file | M | RWP-009 |
| RWP-012 | Measured cost | `task.cost.credits` on success (and `estimatedCost` while running) is recorded by the meter as measured, replacing the estimate for that event, and the spend report separates the two | M | RWP-005 |
| RWP-013 | Read the account | `GET /v1/organization` returns the tier, per-model concurrency, daily caps and balance. It is served on the free dry-run and settings, and the run plan serialises or refuses against it (a 402-style refusal, overridable) | M | None |
| RWP-014 | Cancel in-flight tasks | Cancelling a pipeline run or flow run calls `DELETE /v1/tasks/{id}` for every recorded pending Runway handle, through the adapter's `cancelJob` (built for one job by PGN-012). The handle is marked cancelled, not lost | M | RWP-006 |
| RWP-015 | Moderation cap | A `SAFETY.*` failure (and the adapter's refusal equivalents) is never re-sent to the same provider, in the image fallback and the video path. The walk continues to *other* providers, and the failure names the code | M | None |
| RWP-016 | Frame handles reachable by Runway | A handle URL must be HTTPS on a domain name (no IP, no redirect), or the adapter uses an upload instead. This is checked before the request, so it never surfaces as `ASSET.INVALID` after it | S | RWP-008 |

### Phase 3: The two empty capabilities (M3)
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| RWP-017 | Runway serves `post` | Adds `post` to the adapter: `upscale` becomes `magnific_video_upscaler_creative` (≤30s, 720p–4K), `frame_rate` becomes `enhance_frame_rate`, `hdr` becomes `ruby` on `/v1/video_to_hdr`. Face restore, grade and composite are refused by name. Priced, previewed, metered, and inputs travel via upload | L | RWP-008, RWP-012 |
| RWP-018 | Finishing pass reaches 4K | A 720p draft goes to 4K in one Runway upscale. The factor is derived from delivery size, and one paid probe is recorded with its measured raster | M | RWP-017 |
| RWP-019 | Runway serves `lipsync` | `act_two` on `/v1/character_performance`. The character is the shot's keyframe or clip and the reference is the dialogue take. `bodyControl` and `expressionIntensity` are cast settings, and the payload builder's PRECONDITION rules are unchanged | L | RWP-008, RWP-012 |
| RWP-020 | Act-Two probe, recorded as a verdict | One paid dialogue close-up through `act_two`, recorded as a file the next person reads (the `rbf-002` precedent), with a verdict on whether lipsync defaults to it | S | RWP-019 |
| RWP-021 | Aleph still preview | Before `video_background_replace` or any `aleph2` edit, the extracted first frame is refined with the edit instruction and shown in the confirmation (one image). On approval, `aleph2` runs with that still as keyframe 0. Reachable from the page and MCP | M | RWP-008 |
| RWP-022 | Surfaces and tools for everything new | Post, lipsync and the Aleph preview each get a page control through the shared confirmation and an MCP tool (the `ENTITY_ROUTES` and `every-generate-button` rules). The Claude Desktop guide gains them in pipeline order | M | RWP-017, RWP-019, RWP-021 |
| RWP-023 | End-to-end on one account | The thirty-second fixture runs screenplay to final master with every hosted stage resolving to Runway where the epic moved it, driven only through MCP tools. Spend is recorded from `cost.credits` and preflight is green with no NLE exemption for lipsync or post | M | RWP-002..RWP-022 |
| RWP-024 | Reshape the brief's gap claims | `runway-parity-brief.test.js` pins today's gaps and fails as each closes. When they close, its claims record what was built, so a document does not fail for succeeding | S | RWP-002, RWP-003, RWP-006, RWP-008, RWP-017, RWP-019 |

## Open Questions

1. **Which wallet: API org or web plan?** This epic *assumes* an API org, the brief's recommendation, accepted with the brief. It must be confirmed before RWP-018 and RWP-020 spend anything, and the Runway Builders programme (up to 500k credits) is worth applying for first.
2. **Default two-frame model.** Is it `h3_max` (5–8 credits/s, first and last frames) or `seedance2_5` (first and last frames, 30 references)? This is left open by the user, and RWP-007 deliberately does not hardcode it.
3. **Does voice stay on direct ElevenLabs?** This epic *assumes* yes, since casting and the catalogue live there. Runway's own `voices` catalogue (`/v1/voices`) is a different set, so casting would have to be redone against it. If voice moves to Runway, `text_to_speech`, `sound_effect`, `voice_dubbing` and `voice_isolation` become a follow-up epic.
4. **ProRes on finals only?** This epic *assumes* yes (RWP-011). If every take should arrive as ProRes, the surcharge applies to all drafts.
5. **Should lipsync default to Act-Two?** This is decided by RWP-020's recorded verdict, not in advance.
6. **Dubbing and voice isolation** (brief idea 10) are **not** in this epic. They are deliverables rather than pipeline stages, and they depend on question 3.

## Success Metrics

- `node --test backend/tests/runway-parity-epic.test.js` is green, and every task ID resolves.
- **The live defect is closed.** A sequence planned on `gen4.5` sends no `last` position, and a sequence on a first+last model sends both. Both are proven against the spec snapshot, over every registered model.
- **The registry is spec-complete.** Every spec video model is registered or excluded with a reason, and the drift check fails when Runway adds one.
- **Priced equals sent.** For every model with a reference contract, the preview body and the purchase body carry the same references, and the estimate counts only what travels.
- **Measured spend.** On the RWP-023 run, 100% of Runway events carry `cost.credits`, and the estimate-vs-measured difference is reported.
- **No lost work.** Every Runway call site records a handle, and a cancelled run leaves no Runway task running.
- **Zero same-provider retries after a refusal**, across the fallback and video paths, proven set-based over the refusal codes.
- **Preflight** reports `lipsync` and `post` as ready on a hosted provider, not exempted to the NLE.
- **RWP-023**: the thirty-second film is produced from screenplay to final master through MCP tools alone, on one Runway API org, with the total spend recorded.
