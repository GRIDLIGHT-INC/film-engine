# Research Brief: Runway Feature Parity, and Generating Everything on Runway Through Film Engine

*Synthesis of [`runway-parity-research.md`](runway-parity-research.md), 2026-09-25. Every factual claim below about the code or the API is pinned by `backend/tests/runway-parity-brief.test.js`. The test reads it from the adapter, the provider registry and a dated snapshot of Runway's own OpenAPI spec (`backend/tests/fixtures/runway-openapi-snapshot.json`), so a claim the code has outgrown fails rather than going stale.*

### Executive Summary

Runway's API has **65 operations**, and Film Engine's Runway adapter reaches **6 of the 49 paths** they sit on. The model registry trails the spec by **5 video models**. And the adapter declares a two-frame keyframe ceiling for *every* model, while only **8 of 16** image-to-video models accept a last frame. Those that do not include the default (`gen4.5`), the draft tier (`gen4_turbo`) or the production tier (`hailuo3`). So the gap to parity is mostly **plumbing to an account we would already pay for**, not new product: uploads, the full request body, finishing, and performance capture. The one live defect is the keyframe ceiling.

### Key Themes

- **Ceilings belong to the model, not the provider.** This is the fourth time this codebase has met this: `promptLimit`, `maxReferenceImages`, `sizeControl`, and now `maxKeyframes`. Runway's spec is a discriminated union keyed on `model`, so every limit in it is per model.
- **Declared and never consumed, again.** `lib/video-reference.js` builds role packages for `hailuo3` (9 images, 3 videos, 3 audio) and `seedance2_5` (30/10/10), and `lib/video-cost.js` prices them. `buildVideoRequest` sends only the first as `promptImage`. The references are paid for in the estimate and absent from the request.
- **Runway's filmmaker surface is mostly app-only, and Film Engine already owns the equivalents.**

  | Runway app | Film Engine |
  |---|---|
  | Agent | agent host over MCP |
  | Studio timeline | playback and conform |
  | Workflows | flows canvas |
  | References / Characters | plates, anchor and consistency |
  | Camera Control | previs and the motion compiler |
  | Multi-shot | sequences and `generate-native` |

- **Two capabilities have no real hosted provider, and Runway has one for each.** `lipsync` is served only by the Gridlight gateway, which does not implement it; Runway has `act_two` on `character_performance`. `post` is served by Seedance for upscale only; Runway has `video_upscale`, `enhance_frame_rate` and `video_to_hdr`.
- **An account is a wallet decision.** Web-plan and API credits are separate and non-transferable. Runway's generation MCP spends *web* credits and returns media to the chat. Film Engine's pipeline needs an *API* org.
- **Moderation costs money on Runway.** A moderated generation is charged, `SAFETY.INPUT.*` is not refunded, and repeats can suspend the account. The image fallback chain's *"a refusal is a condition to route around"* rule is correct across providers and dangerous within one.

### Top Ideas & Opportunities

1. **Per-model keyframe ceilings (a defect).**
   - *What:* move `maxKeyframes` onto each `RUNWAY_VIDEO_MODELS` entry, derived from the spec's `promptImage` shape, with the adapter answering per model.
   - *Why:* the default and draft tiers are first-frame only. `planSequence` builds first/last segments for them that the endpoint refuses, so a sequence on default settings fails, or worse, generates from the first frame alone and reads as a bad take.
   - *How:* a `keyframesFor(model)` beside `modelsFor(adapter, capability)`, read by `lib/video-sequence.js` and the sequence-plan preview. A plan on a first-only model degrades to a still per shot, with the reason stated. The degrade rule already exists for Gridlight.
2. **A registry derived from the spec, not typed beside it.**
   - *What:* derive the model set, durations, ratios and prompt limits from a dated `openapi.json` snapshot refreshed by a script. This is the `refresh-muapi-contract.js` precedent.
   - *Why:* `runway-readiness.test.js` pins our 13 models as "official", so it passes on a stale list. `h3_max`, the cheapest model that takes a first *and* a last frame (5–8 credits/s), is invisible.
   - *How:* keep the hand-kept fields that are policy (tier, status, surcharges) and assert every spec model is either registered or named as excluded with a reason.
3. **Send the whole request.**
   - *What:* `references`, `referenceVideos`, `referenceAudio`, `resolution`, `audio`, `negativePrompt`, `outputFormat`/`proresProfile` and `contentModeration`, per model, where the spec allows each.
   - *Why:* the role packages become real. ProRes at generation time (+5 credits/s) makes the NLE handoff professional without a transcode, and `audio: false` on veo3.1 halves its rate.
   - *How:* one `buildVideoRequest` that reads a per-model field map, with the dry-run preview showing exactly what travels.
4. **`POST /v1/uploads`.**
   - *What:* ephemeral `runway://` URIs, 200MB, 24h.
   - *Why:* data URIs cap at 5MB for images and 16MB for video, and a frame handle must be HTTPS on a domain name (not an IP) or Runway cannot fetch it. Uploads unblock Aleph edits on real footage and large 2K plates.
   - *How:* an upload step inside the adapter, cached per file identity for 24h. The refusal it replaces already names this remedy.
5. **Runway as the first hosted `post` provider.**
   - *What:* `video_upscale` (magnific, ≤30s), `enhance_frame_rate` (24–120fps, ≤300s) and `video_to_hdr` (`ruby`).
   - *Why:* finishing is currently "done in the NLE" by exemption, and a 480p or 720p draft cannot reach 4K here. These make the finishing pass a real, metered step.
   - *How:* add `post` to the adapter's capabilities, and map `POST_SUBTYPES` (upscale, frame-rate, hdr) to models. Grade, face restore and composite stay refused by name, as Seedance already does.
6. **Runway as the first hosted `lipsync` provider.**
   - *What:* `character_performance` with `act_two`, a character image or video plus a driving reference video.
   - *Why:* lipsync is the one orchestrated step that no configured provider can run.
   - *How:* the driving video is the dialogue take; `bodyControl` and `expressionIntensity` are cast settings. Priced at 5 credits/s.
7. **Read the account and the actual cost.**
   - *What:* `GET /v1/organization` returns the tier, per-model concurrency, daily caps and balance. Tasks return `estimatedCost` while running and `cost.credits` on completion.
   - *Why:* the run plan cannot know a new org is Tier 1 (1–2 concurrent, 50–200 per day), and the meter estimates from a hand-kept book that already carries a sunset model (`gen3a_turbo`).
   - *How:* the run plan checks the concurrency and daily cap before it refuses or serialises, and the meter records `cost.credits` as measured, not estimated.
8. **Cancel, collect, and a moderation cap.**
   - *What:* `DELETE /v1/tasks/{id}`, an `onHandle` on `generate-native`, and a per-provider refusal cap.
   - *Why:* an abandoned multi-shot job currently cannot be collected. A cancelled pipeline run keeps billing its in-flight tasks. And retrying a refused prompt on the same provider is billed and risks suspension.
   - *How:* the cap belongs in `lib/image-fallback.js` and the video path. A `SAFETY.*` failure is never re-sent to the same provider.
9. **Aleph frame-edit preview (a product parity gap).**
   - *What:* Runway's Edit Studio shows the edit as a still before the video runs.
   - *Why:* an Aleph run costs 28 credits/s with a 56 minimum, while a still preview costs one image. This is the same *show before spend* rule the rest of the engine keeps.
   - *How:* refine the extracted first frame with the edit instruction, show it in the existing confirmation, then run `aleph2` with that frame as keyframe 0.
10. **Dubbing and voice isolation** (`voice_dubbing`, `voice_isolation`).
    - *What:* localisation and dialogue clean-up.
    - *Why:* these are deliverables Film Engine has no path to.
    - *How:* both are ElevenLabs models. On a Runway-only account they bill Runway credits, and otherwise the ElevenLabs adapter could call them directly.

### Technical Approaches

- **Spec-derived contracts.** A committed snapshot (`tests/fixtures/runway-openapi-snapshot.json`) holds the operations, the models per endpoint and last-frame support, with the source and date. A refresh script regenerates it from `openapi.json`, and tests hold the adapter to it in both directions. The same pattern already exists as `aleph-contract.json` and the MuAPI catalogue snapshot.
- **Per-model capability fields on the registry entry.** `maxKeyframes`, `promptLimit` (1000 for gen4.5, 3500 for seedance2, 15000 for seedance2_5, 20000 for wan3), `references` limits, `outputFormats` and `audio`. Adapter-level fields become the *strictest* default for an unknown model, which is the existing asymmetry.
- **One request builder, one preview.** `describeVideoRequest` already shows the sanitized outbound body. Every new field lands in the builder, so the free preview and the purchase cannot diverge (the previs-boundary rule).
- **Uploads as a transport, not a feature.** The adapter decides whether an input travels as a URL, a data URI or `runway://` from the input's size and kind, and callers never choose.
- **The account as a resolver default, not a code path.** "Generate everything on Runway" is `PREFERRED_WHEN_CONFIGURED` plus per-project `provider_config` naming `runway` for video, image, voice, sfx, post and lipsync. Resolution already reports `explicit` versus fallback, so nothing silently lands elsewhere.
- **Not Runway's MCP as the pipeline.** Runway's MCP stays useful as a director's side tool. The pipeline goes through Film Engine's adapter, so assets land in `film_assets`, spend is metered, and the agent host keeps being the only LLM. This keeps the *use MCPs for AI queries* rule: reasoning over MCP, generation through our registry.

### Open Questions

1. **Which wallet?** An API org at $0.01/credit with tier-based limits (the Builders programme offers up to 500k free credits), or a Max web plan whose credits only the MCP can spend? The brief assumes an API org, and it needs a decision.
2. **How far should "everything on Runway" go?**
   - Runway serves voice and SFX (ElevenLabs models) and images (gen4_image, GPT Image 2, Nano Banana Pro, Seedream).
   - It does **not** serve music (Lyria is app-only), 3D, worlds or the LLM.
   - Should voice move off the direct ElevenLabs key, which today carries casting, previews and the voice catalogue? Those catalogue features are ElevenLabs endpoints, and Runway's `/v1/voices` is a different catalogue.
3. **Which default tier after the keyframe fix?** With `gen4.5` first-frame only, is the sequence path's default `h3_max` (cheap, two frames) or `seedance2_5` (two frames and 30 references)?
4. **Is ProRes at generation worth +5 credits/s on every take, or only on the final?** The draft-then-finish rule suggests the final only.
5. **Is Act-Two good enough as lipsync for dialogue close-ups?** This needs one paid probe, recorded as a verdict (the `rbf-002` precedent).
6. **Three claims remain [unverified]:** Gen-4.5 keyframes beyond the first frame in the app, 45s lip sync, and web-app speech-to-speech pricing. None blocks the recommended direction.

### Recommended Direction

**Open a Runway API org and make it the house video provider through Film Engine's own adapter, in three milestones.**

1. **Correctness first.**
   - Fix the per-model keyframe ceiling.
   - Derive the registry from the spec snapshot.
   - Add the 5 missing models and retire `gen3a_turbo` from the rate book.
   - Put `onHandle` on `generate-native`.
2. **The full request.**
   - Uploads.
   - References, resolution, audio and outputFormat, per model.
   - Reading `cost.credits` and `/v1/organization`.
   - The moderation cap and task cancel.
3. **Close the two empty capabilities.**
   - `post` via upscale, frame rate and HDR.
   - `lipsync` via `act_two`.
   - The Aleph frame-edit preview.

The rationale: milestone 1 fixes a defect that fails today's default sequence path and costs nothing. Milestone 2 turns spend we already estimate into requests that carry what we priced. Milestone 3 is the only work that adds capability, and it closes exactly the two pipeline stages the screenplay-to-final-movie goal cannot currently run on a hosted provider. Music, 3D, worlds and the LLM stay where they are, and the LLM stays on the MCP host.
