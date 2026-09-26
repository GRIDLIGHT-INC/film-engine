# Runway Parity: Research

*Deep research step, 2026-09-25. The subject: every tool Runway offers for film generation, measured against Film Engine's own generation tooling. First pass: what would bring feature parity. Second pass: what connections are needed to generate everything on a Runway account through Film Engine.*

**How this was sourced.** API facts come from Runway's machine-readable OpenAPI spec (`https://docs.dev.runwayml.com/openapi.json`, 644KB, `info.version 2024-11-06`), downloaded and **parsed programmatically** on this date. They were then compared model by model against `backend/lib/providers/runway.js` (see *Verification* at the end). App facts come from runway.com product pages and its changelog. Anything not confirmed from a primary source is marked **[unverified]**. `runwayml.com` now 308-redirects to `runway.com`.

---

## Web Findings

| # | Source | URL | Key insight | How it relates |
|---|---|---|---|---|
| 1 | Runway Dev OpenAPI spec | https://docs.dev.runwayml.com/openapi.json | **65 `/v1` operations** in 13 groups. `X-Runway-Version: 2024-11-06` is required and Bearer auth is used. Request bodies are discriminated unions keyed on `model`. | This is the denominator. Our adapter calls **6** of the 65. |
| 2 | Models guide | https://docs.dev.runwayml.com/guides/models/ | The model-to-endpoint mapping. Professional output formats (ProRes, PNG sequence, 10-bit) exist on Gen-4.5 and Aleph 2 only; HDR and EXR on Gen-4.5 only. | We never request an `outputFormat`, so every clip arrives as 8-bit mp4 even though the NLE handoff wants ProRes. |
| 3 | API pricing | https://docs.dev.runwayml.com/guides/pricing/ | Priced at $0.01 per credit. Video models run from 5 to 40 credits per second, with a +5/s surcharge for ProRes or PNG and +20 to 40/s for HDR. Voice (TTS) is 1 credit per 50 characters, SFX 1 per second, dubbing 1 per 2 seconds, isolation 1 per 6 seconds. Multi-shot costs 13 or 17 per second. | Our `provider-pricing.js` is missing hailuo3, the seedance family, veo3.1 and multi-shot, and the meter names the multi-shot rows `multi_shot_video_720p`/`_1080p`, which no rate row matches. |
| 4 | Usage tiers | https://docs.dev.runwayml.com/usage/tiers/ | Five tiers: concurrency 1–2 up to 20, daily caps 50 up to 30k, monthly spend caps $100 up to $100k. Tiers upgrade automatically at $50, $100, $1k and $5k purchased. Excess work goes to `THROTTLED`, and the daily cap returns 429. | A new account is Tier 1, **1–2 concurrent**, so a 60-shot batch serialises. The run plan has to know this. |
| 5 | AI context primer / llms.txt | https://docs.dev.runwayml.com/ai-context.md | The SDKs are `@runwayml/sdk` and `runwayml`. Inputs that do not match the ratio are **centre-cropped automatically**. | A silent crop is a board/footage shape mismatch, which aspect-consistency exists to prevent. |
| 6 | Inputs and uploads | https://docs.dev.runwayml.com/assets/uploads.md | Image limits are 16MB by URL, 5MB as a data URI and 200MB by upload. Video limits are 32/16/200MB. `POST /v1/uploads` returns `{uploadUrl, fields, runwayUri}`. A `runway://` URI lasts 24h. URLs must be HTTPS on a domain name (not an IP) and must not redirect. | We refuse anything over 5MB as unimplemented, and a LAN or IP frame handle cannot be fetched by Runway. |
| 7 | Task failures and moderation | https://docs.dev.runwayml.com/errors/task-failures.md | `SAFETY.INPUT.*` failures are **not refunded**. Moderated generations cost the same as successful ones, and **repeated moderations can suspend the account.** | Our image-fallback chain retries past refusals. Against Runway, a retry loop risks the account. |
| 8 | API changelog | https://docs.dev.runwayml.com/api-details/api_changelog.md | **`gen4_aleph` and `gen3a_turbo` were sunset on 2026-07-30.** Tasks have returned `estimatedCost` and `cost.credits` since 2026-07-30. Added since: Hailuo 3 (08-05), HDR/ProRes on Gen-4.5 (08-20), WAN 3 (08-26), H3 Max (09-03), GPT Image 2.5 (09-08), Enhance Frame Rate (09-17). | The actual cost per task can replace estimates in the meter. `gen3a_turbo` is still a rate row in our book. |
| 9 | Runway Dev MCP | https://docs.dev.runwayml.com/guides/mcp.md | `https://dev.runwayml.com/mcp`, OAuth. It looks up tasks, manages routers and reads docs. It **does not generate**. | This is a developer tool, not a pipeline surface. |
| 10 | Runway generation MCP | https://runway.com/news/mcp | `https://mcp.runwayml.com/mcp`, with OAuth and no key. It **bills web-plan credits** and exposes Gen-4.5, Seedance, Aleph 2, image models, workflows and brand kits. It is on the Pro and Max plans. | See Key Idea 7. It meets the *use MCPs* rule for **reasoning**, but it moves spend and assets outside `film_assets`. |
| 11 | Legacy API-key MCP server | https://github.com/runwayml/runway-api-mcp-server | Eight tools (`generateVideo`, `generateImage`, `upscaleVideo`, `editVideo`, `generateAudio`, `getTask`, `cancelTask`, `runway_listModels`). It spends API credits. | This is a subset of what our own adapter already does. |
| 12 | Consumer pricing | https://runway.com/pricing | Free, Standard ($12), Pro ($28, 2,250 credits), Max ($76, 9,500 credits, HDR/ProRes, rollover) and Team. The MCP needs Pro or Max. | Web and API credits are two separate wallets. |
| 13 | API FAQ | https://help.runwayml.com/hc/en-us/articles/21668552945171-Runway-API-FAQs (via a search snippet; the direct fetch returned 403) | Web and API credits are **separate and non-transferable**. The API portal is dev.runway.com, the minimum purchase is $10, and autobilling is available. | *Having an account* means buying an **API** org, not a web plan. |
| 14 | App changelog | https://runway.com/changelog | Workflows (Oct 2025); Agent (May 2026) and Agent 2.0; Studio timeline (Jun 2026); Characters (Mar 2026); SAM3 segmentation (Jul 2026); Premiere, After Effects and Resolve plugins (Sep 2026); Enhance Frame Rate. | Most of the *filmmaker* surface is app-only. |
| 15 | Product page and Apps | https://runway.com/product | Apps: Remove from Video, Reshoot Product, Add Dialogue (lip sync), Add Performance, Change Backdrop, Change Time of Day, Relight. Also the Multi-Shot app. | Each App is an Aleph or Act-Two recipe. Film Engine already does *Change Backdrop* (`video_background_replace`). |
| 16 | Aleph 2.0 + Edit Studio | https://runway.com/news/introducing-aleph-2-and-edit-studio | Edit one frame and the edit propagates, for clips up to 30s at 1080p. The edit is previewed as an image before generating. | Our `lib/video-edit.js` already uses `aleph2`. The preview-as-image step is not built. |
| 17 | Gen-4.5 | https://runway.com/research/introducing-runway-gen-4.5 | Ranked #1 on Artificial Analysis T2V. HDR and ACEScg EXR output were added via the API. Keyframes beyond the first frame in the app are **[unverified]**. | The **API is first-frame only** (verified below). |
| 18 | Runway Agent | https://runway.com/news/introducing-runway-agent, https://runway.com/news/introducing-agent-2 | Conversational concept to beats to multi-shot video with dialogue, music and a timeline. **App-only, with no API.** | This is Film Engine's own thesis, done inside Runway. The API equivalent is the `multi_shot_video` recipe. |
| 19 | Characters / GWM-1 | https://runway.com/news/introducing-runway-characters | Real-time avatars from one image, via `/v1/avatars`, `/v1/avatar_videos` and `/v1/realtime_sessions`. | This is conversational video, not film. It is low relevance except as a talking-head lip-sync path. |
| 20 | GWM Worlds 2 | https://runway.com/research/introducing-gwm-worlds-2 | Explorable real-time worlds. A research preview, **not in the API**. | This is comparable to our `world` capability (World Labs Marble), but not reachable. |
| 21 | Ruby | https://runway.com/product/ruby | SDR to HDR (HDR10, HLG, PQ ProRes, EXR, ACEScg), for inputs ≤30s and under 4K. | A candidate for the `post` capability, which has no real provider. |
| 22 | Media Router | https://runway.com/news/introducing-runway-media-router | Routes by cost, latency or quality, with `dryRun` returning the routing decision and estimated cost. Capacity fallback was added 2026-07-30. | This overlaps our tiers and the router that `video-attempt.js` defers. `dryRun` is a free estimate. |
| 23 | Runway Builders | https://runway.com/product/builders | Up to 500k free API credits and Tier 5 limits for startups. | Relevant to the account decision (Gridlight). |
| 24 | Act-Two help | https://help.runwayml.com/hc/en-us/articles/42311337895827-Performance-Capture-with-Act-Two | Act-Two is now an App and supports multi-character dialogue. The claim that lip sync now runs to 45s is **[unverified]**. | `/v1/character_performance` is the closest hosted lip-sync provider. |
| 25 | Film industry context | https://runway.com/news/hundred-film-fund, https://aif.runwayml.com/, https://variety.com/2026/film/news/lionsgate-equity-stake-runway-ai-franchises-for-ai-show-1236775590/ | Hundred Film Fund, AIF 2026 with Lionsgate, and Lionsgate's equity stake. | Runway is positioning as a studio pipeline; the Agent and Studio are the competitive surface. |

### The API surface, by group (from the parsed spec)

| Group | Operations | Models | Film Engine today |
|---|---|---|---|
| Video | `image_to_video`, `text_to_video`, `video_to_video` | i2v: 16 models, t2v: 15, v2v: 8 | **Called.** The registry holds 13 models. |
| Image | `text_to_image` (plus references) | 12 models | **Called** with `gen4_image`, `gen4_image_turbo` and `gemini_2.5_flash`. |
| Upscale / FPS / HDR | `image_upscale`, `video_upscale`, `video_to_hdr` | magnific ×2, `enhance_frame_rate`, `ruby` | Not called. `post` has no real provider. |
| Performance | `character_performance` | `act_two` | Not called. `lipsync` has no hosted provider. |
| Audio | `sound_effect`, `text_to_speech`, `speech_to_speech`, `voice_dubbing`, `voice_isolation` | Eleven v3/multilingual/STS/dubbing/isolation, `seed_audio` | Not called. We reach ElevenLabs directly instead. |
| Voices | `/v1/voices` CRUD + preview | — | Not called. |
| Recipes | `multi_shot_video`, plus 6 product/ad recipes | — | `multi_shot_video` is **called** (`generate-native`). The ad recipes are not called. |
| Workflows | list, get, run, invocation | — | Not called. |
| Router | `/v1/routers`, `/v1/generate/{video,image,audio}` | — | Not called. |
| Uploads | `POST /v1/uploads` | — | **Not called.** Anything over 5MB is refused. |
| Tasks | `GET` / `DELETE /v1/tasks/{id}` | — | GET is called. **DELETE (cancel) is not.** |
| Organization | `/v1/organization`, `/usage`, `/webapp/*` | — | Not called, so there is no balance or tier read. |
| Avatars / realtime | avatars, avatar_videos, realtime_sessions, documents | `gwm1_avatars` | Not called. Low relevance. |

---

## Local Findings

All paths are under `/Users/mannyhenri/code/film-engine/backend/`.

**The Runway adapter: `lib/providers/runway.js` (1150 lines)**

*Endpoints it calls:*
- `image_to_video`, `text_to_video`
- `video_to_video` (`aleph2`; up to 5 keyframes, videoUri as https/`runway:`/data URI, local paths refused)
- `text_to_image` (up to 3 tagged `referenceImages`)
- `recipes/multi_shot_video` (`version: '2026-06'`)
- `GET /tasks/:id`, plus a `health-probe`

*Protocol:*
- `X-Runway-Version: 2024-11-06` and Bearer auth.
- Polls every 3s against a 300s budget, retrying 429/502/503.
- `asyncGeneration` with `onHandle` then `collect(taskId)`: this is the generation-handles work.

*Registry and declarations:*
- `RUNWAY_VIDEO_MODELS` holds 13 entries: `aleph2`, `gen4.5` (the default), `gen4_turbo`, `veo3.1[_fast]`, `happyhorse_1_0`, `hailuo3`, `seedance2_5`, `seedance2[_fast|_mini]`, `gemini_omni_flash`. Each has an endpoint, durations, ratios and credits.
- The adapter-wide declarations are `promptLimit 1000`, `maxReferenceImages 3`, `referenceMode 'condition'`, `sizeControl 'snapped'`, `maxImagePixels 1920×1080` and **`MAX_KEYFRAMES = 2`** (L35).

*Gaps in the adapter:*
- **`POST /v1/uploads` is not implemented.** A frame over 5MB is refused with the remedy named (L556–578).
- `buildVideoRequest` never sends `resolution`, `references`, `referenceVideos`, `referenceAudio`, `audio`, `outputFormat` or `contentModeration`. Only the first reference travels, as `promptImage` (L510–545). So the role package that `lib/video-reference.js` builds for hailuo3 and seedance2_5 is **priced and never sent.**
- `generateNativeSequence` (`routes/sequences.js` L858–898) passes **no `onHandle`**, so an abandoned multi-shot job cannot be collected.

**The Runway neighbours**

*Video, beside the adapter:*
- `lib/video-edit.js`: Aleph 2 background replace, as plan → budget → host → generate → register.
- `lib/video-tiers.js`: draft uses `gen4_turbo`, production uses `hailuo3`, hero has no default.
- `lib/video-cost.js`: local estimate from the registry.
- `lib/video-reference.js`: role contracts. hailuo3 takes 9 images, 3 videos and 3 audio; seedance2_5 takes 30/10/10 plus `inbetween`; everything else is KEYFRAME_ONLY.
- `lib/motion-prompt.js`: the shared motion compiler.
- `lib/video-sequence.js`: N shots become N−1 segments, capped by the adapter's `maxKeyframes`.
- `lib/inbetweens.js` and `lib/inbetween-run.js`.
- `lib/repair-plan.js`, `lib/repair-run.js`, `lib/repair-bridge.js`.
- `lib/draft-video.js`: Runway's floor is 720p.
- `lib/video-attempt.js`: attempt records for the unbuilt router.
- `lib/frame-handles.js`: an opaque fetchable URL for a local frame.

*Pricing and tests:*
- `lib/provider-pricing.js` L365–403 has `runway:video`/`runway:image` rows. It still carries `gen3a_turbo` (sunset), and it lacks the seedance family, hailuo3, veo3.1 and multi-shot.
- Tests: `providers-runway` (27), `runway-readiness` (5; `OFFICIAL_IMAGE_TO_VIDEO` pins the 13-model set), `runway-verdict`, `aleph-adapter` (11), `aleph-contract` (9, against `fixtures/aleph-contract.json`) and `aleph-pricing` (10). There is also `smoke-runway.js`, a live and paid smoke test.

**The other providers**

| Provider | Capabilities |
|---|---|
| `anthropic` | llm |
| `bfl-image` | image |
| `elevenlabs` | voice, sfx, ambient, music |
| `fluidsynth` | music (local) |
| `google-image` | image |
| `gridlight-adapter` | all but world; the default |
| `meshy` | model3d, image |
| `muapi-image` | image |
| `openai-image` | llm, image |
| `runway` | video, image |
| `seedance` via MuAPI | video, and post limited to **upscale** |
| `worldlabs` | world |

`CAPABILITIES` is `lib/providers/base.js` L42: llm, image, video, music, voice, sfx, ambient, lipsync, post, model3d, world. **`lipsync` has no hosted provider**; only Gridlight is declared, and Gridlight does not implement it. **`post` covers upscale only**, via Seedance; grade, face restore and composite have no provider.

**The MCP surface (`lib/mcp-tools.js`) that reaches video**
- Video: `video_preview` (free), `video_generate`, `video_background_preview`, `video_background_replace`.
- Sequences: the `sequence_*` tools, including `sequence_generate_native`, the Runway recipe.
- In-betweens: the `sequence_*inbetweens*` and `sequence_station_*` tools.
- Repair and takes: `repair_plan`, `repair_run`, `take_candidates`.
- Handles: `generation_pending`, `generation_collect`.
- `node_gen_video`, `node_gen_post`, `node_gen_lipsync`, and `spend_rates`.

The connected agent host is the LLM (`tests/mcp-no-server-llm.test.js`), and no tool calls a server-side model.

**Prior plans:** `docs/plans/pipeline-readiness-brief.md`, `docs/plans/multi-provider-pipeline.md`, `docs/plans/e2e-first-film.md` (≈$2.04 first film), `docs/plans/redo-between-frames-*` (Aleph 2 was chosen over Seedance video-edit), `docs/plans/provider-integration-fixes.md`. There is no standalone Runway readiness doc. The verdict lives in `tests/runway-verdict.test.js`.

---

## Key Ideas & Themes

1. **A live defect: the keyframe ceiling is per adapter, and the truth is per model.** `MAX_KEYFRAMES = 2` is declared for the whole Runway adapter, and the comment above it says the ceiling is *"documented for image_to_video"*. The parsed spec says `promptImage` accepts `last` on **only 8 of 16** i2v models: veo3.1, veo3.1_fast, the seedance2 family, seedance2_5, gemini_omni_flash_1.1 and h3_max. **`gen4.5` (our default), `gen4_turbo` (the draft tier) and `hailuo3` (the production tier) are first-frame only.** So `planSequence` over the default tier builds first/last segments that the endpoint's schema refuses. This is the same class of bug as `maxReferenceImages` and `promptLimit`: a ceiling that is the model's fact, declared as the adapter's.
2. **The model registry is 5 models behind.** The spec has `grok_imagine_1_5`, `wan3`, `wan3_prime`, `gemini_omni_flash_1.1` and `h3_max`, and our registry has none of them. `h3_max` (5–8 credits/s, first and last frames) is the cheapest two-keyframe model on the account. `runway-readiness.test.js` pins our 13 as the "official" set, so it passes on a stale list.
3. **We send a small fraction of each request.** The role package (`references`, `referenceVideos`, `referenceAudio`), `resolution`, `audio`, `outputFormat`, `negativePrompt` and `contentModeration` are all in the schema, and `buildVideoRequest` sends none of them. hailuo3 and seedance2_5 are priced with references and receive a single `promptImage`. That is the *declared and never consumed* pattern this codebase keeps paying for.
4. **The 58 operations we do not call fall into 4 clusters that matter for film:**
   - **Uploads:** without them nothing over 5MB and no local video travels, which blocks v2v on real footage.
   - **Finishing:** `video_upscale` (magnific, `enhance_frame_rate`) and `video_to_hdr` (ruby) would give `post` its first real provider.
   - **Performance:** `character_performance` (`act_two`) would give `lipsync` its first hosted provider.
   - **Audio:** TTS, SFX, dubbing and isolation, all ElevenLabs models billed on Runway credits.

   Everything else (avatars, ad recipes, the router) is low film value.
5. **Deliverable quality is a request field, not a post pass.** `outputFormat: prores` (+5/s) or `hdr10`/EXR (+20–40/s) on Gen-4.5 and Aleph 2 makes the NLE handoff professional at generation time. We receive 8-bit mp4 and convert.
6. **The cost and the account can be read, not guessed.** Tasks return `estimatedCost` and `cost.credits`, and `/v1/organization` returns the balance, tier, per-model concurrency and daily caps. Today the meter estimates from a hand-kept rate book, and the run plan cannot know it is on Tier 1 (1–2 concurrent, 50–200 per day). Reading both closes the drift between the estimate and the actual cost.
7. **Two Runway MCPs, and neither is our pipeline.** The goal's rule is *use MCPs for AI queries*. That rule is about **reasoning**, and Film Engine already meets it: the agent host is the LLM. Runway's generation MCP is a second agent-to-generator path that bills **web-plan** credits and returns media to the chat, not to `film_assets`. That is exactly the "assets in a chat" failure the MCP-server architecture avoids. The correct connection is Film Engine's own adapter against the **API**, which is a separate wallet.
8. **Moderation changes the fallback rule on Runway.** Moderated generations are charged, `SAFETY.INPUT` is not refunded, and repeats can suspend the account. On other providers `image-fallback` treats a refusal as a condition to route around. On a Runway-only account it needs a cap: a refusal must not be re-sent to Runway.
9. **Runway's filmmaker surface is mostly app-only, and Film Engine already owns the equivalents.**

   | Runway (app only) | Film Engine equivalent |
   |---|---|
   | Agent | the MCP agent host |
   | Studio timeline | playback and conform |
   | Workflows | flows canvas |
   | Characters/References | plates, anchor and consistency |
   | Camera Control | previs and motion compiler |
   | Multi-shot | sequences plus `generate-native` |
   | Edit Studio | recompose/refine plus video-edit |

   Real parity gaps are few: **frame-edit preview before an Aleph run**, **SAM3 segmentation** (API-less), **frame-rate enhance**, **HDR**, **performance capture** and **dubbing/localisation**.
10. **The account decision: one wallet or two.** Generating everything on Runway means the API org replaces MuAPI/Seedance (Seedance 2/2.5 are on Runway), direct ElevenLabs (voice, SFX, dubbing and isolation via Runway), and Meshy/Google/BFL for images (gen4_image, GPT Image 2, Nano Banana Pro and Seedream on Runway). Runway does **not** serve music (Lyria is app-only, and `seed_audio` is speech/SFX), 3D (model3d), worlds, or the LLM. Those stay on ElevenLabs/FluidSynth, Meshy, World Labs and the MCP host.

### For the next step (synthesis)
- **Parity pass:**
  - Per-model keyframe ceilings (a defect).
  - Registry sync with the spec, derived from `openapi.json`.
  - The full request body (references, resolution, audio, outputFormat).
  - `/v1/uploads`.
  - A `post` provider (video_upscale, enhance_frame_rate, ruby).
  - A `lipsync` provider (act_two).
  - Aleph frame-edit preview.
  - Task cancel.
- **Connections pass (Runway-only account):**
  - An API org key.
  - Reading the organization for tier and balance.
  - Consuming `task.cost`.
  - Uploads for local media.
  - HTTPS frame handles on a domain (not an IP).
  - Runway as the resolver default for video, image, voice and sfx, plus post and lipsync.
  - A moderation cap in the fallback chain.
  - Pricing rows for every registry model.
  - An `onHandle` on `generate-native`.
  - Explicitly **not** Runway's MCP as the pipeline.

---

## Verification

`node scratchpad/runway-parity.js scratchpad/runway-openapi.json` parsed the live spec and compared it with `lib/providers/runway.js`:

```
spec version 2024-11-06 | /v1 operations 65
/v1/image_to_video -> gen4.5, gen4_turbo, veo3.1, veo3.1_fast, hailuo3, happyhorse_1_0, seedance2, seedance2_fast, seedance2_mini, gemini_omni_flash, seedance2_5, grok_imagine_1_5, wan3, gemini_omni_flash_1.1, wan3_prime, h3_max
OURS not in spec video endpoints: none
SPEC video models we lack: grok_imagine_1_5, wan3, gemini_omni_flash_1.1, wan3_prime, h3_max
image_to_video last-frame support: gen4.5 first-only, gen4_turbo first-only, hailuo3 first-only, … (8 of 16 accept last)
endpoints adapter calls: 6 | spec operations not called: 58
```
