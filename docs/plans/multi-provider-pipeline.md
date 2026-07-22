# Multi-Provider AI Film Pipeline — Integration Plan

**Authors:** Claude (codebase audit + architecture) & codex (provider/API research) — NeonCore confer task.
**Goal:** Make Film Engine a fully operational, provider-pluggable pipeline: write a screenplay → generate images, video, music, SFX, dialogue → hand off to Premiere/final — using best-in-class pro providers (ChatGPT/gpt-image for images, Artlist for licensed music/SFX/footage, plus generative alternatives), not just Gridlight.

---

## 1. Where we are today (audit)

Film Engine **already implements the whole screenplay→final backbone against a single provider (Gridlight):**
- Screenplay editor + AI writing → **Breakdown** (LLM) → **Scenes/Shots** + Scene Cards → **Storyboard** images → **Video** → **Voice/dialogue** → **Lip-sync** → **Music/SFX/Ambient** → **Post** → **Assembly** → **NLE export** (FCPXML/EDL/Premiere/FDX) + **project bundle**.
- **Pipeline orchestrator** (`lib/pipeline-engine.js`): a typed 9-step DAG — `keyframe → video → voice → lipsync → music → sfx → ambient → post → assembly` with `{id, name, depends, scope, handler}`. This is the screenplay→final spine, and it is already provider-agnostic in shape.
- **Asset registry** (`film_assets`) + per-domain job tables + **licensing fields** already on `film_music_cues` (`license_status/type/holder/cost/expiry/territory`) and `/music-rights` routes + UI.

**The single constraint:** every domain route — and the pipeline's `executeStep` — calls `callGridlight(endpoint, payload)` / `relayGridlightSSE` against one `GRIDLIGHT_URL`, using hardcoded path constants (`/image`, `/video`, `/music`, `/voice`, `/lipsync`, `/postprocess`, `/audio/mix`, `/video/stitch`, `/3d/*`). So "the provider" is implicitly Gridlight-only, selected by one base URL.

**Therefore the work is not "build a pipeline" — it's "generalize the provider seam"** plus a few UX surfaces. Everything valuable (queue, 429 retry, SSE relay + client-disconnect hardening, jobs, asset registry, licensing, NLE export, budget tracking) is reused.

---

## 2. Provider Landscape (codex research)

> `Y` connectable, `N` not integrable. Source URLs inline. Full grid researched and verified by codex.

| Provider | Capability | API? | Auth | Sync/Async | Rights / Licensing | Rough Cost / Limits | Default? |
|---|---|---:|---|---|---|---|---|
| **OpenAI / ChatGPT** | image, image-edit, video, speech | Y | Bearer key | Images sync; **video async** create→poll→download | store prompt/model/provenance in `film_assets`; C2PA/safety per docs | per-image by quality/size; tiered IPM; video pricing per account | **YES — images (user pick)**; video if Sora entitled |
| **Artlist Enterprise** | music, sfx, stock/footage **(source)** | Y (enterprise) | **OAuth2 client-credentials** (mgr-issued, ~1h token) | catalog search/list/download — **not generation** | **SOURCE/LICENSE**, not generator → maps to `film_music_cues.license_*` | partner-gated; 20 songs/page, filters query/category/vocal/duration/BPM | **YES — licensed music/SFX/footage** |
| **Midjourney** | image | **N** (compliant) | web/Discord only | manual UI only | **ToS forbids automated access** | subscription | **NO adapter — manual import only** |
| **Runway** | video, image, audio, upscale | Y | key `RUNWAYML_API_SECRET` | async task/queue → job status | plan-dependent; store provenance | tiered concurrency; Gen-4.5 12 cr/s, 2–10s, 720p | **YES — primary video** |
| **Luma Agents** | image, video, edit, reframe | Y | Bearer `LUMA_AGENTS_API_KEY` | POST `/v1/generations`→poll→**presigned URLs (expire)** | download into `film_assets` immediately | account/model dependent | YES — video alt/fallback |
| Adobe Firefly Services | image, edit, upscale, video | Y | `x-api-key` + IMS OAuth | async + upload storage | enterprise/commercial workflow positioning; verify plan terms | plan-dependent | optional (enterprise workflow) |
| Google Vertex / Gemini | image (Imagen), video (Veo), TTS | Y | GCP IAM / Gemini key | Veo long-running op + GCS; Gemini TTS streams | download from GCS; Gemini TTS preview | GCP quotas/pricing | optional (Google shops) |
| **ElevenLabs** | voice, clone, SFX, music, dubbing | Y | `xi-api-key` | TTS HTTP-stream + WS; SFX direct; dubbing jobs | **paid plan for commercial**; clone needs consent | ~75ms infer; SFX 0.5–30s; dub concurrency 5/100 | **YES — dialogue + SFX** |
| Suno | music, lyrics, stems, extend | Y | Bearer key | async task + poll/callback | **generative; commercial rights review** | V4/V4.5/V5; account-dependent | optional (generated music) |
| Udio | music | **N** | — | manual only | no public API | — | NO adapter now |
| Stability AI | image, edit/upscale/control, audio-to-audio | Y | Bearer key | REST v2beta (+some async) | store provenance/safety | **150 req/10s→429**; Core 3 cr/gen | optional image/audio fallback |
| Ideogram | image, remix, typography/logos | Y | `Api-Key` | sync, **ephemeral URLs** | download immediately | 10 inflight default; v4 2K | optional (title cards/signage) |
| BFL / FLUX | image | Y | `x-key` | submit→poll | MJ-grade alt | account credits | optional image/keyframe |
| **fal.ai** | image/video/audio/music/3D **aggregator** | Y | fal key | queue; model-specific | **pin exact model + capture license/provenance** | model-specific | YES as aggregator/fallback (not provenance source of truth) |
| Replicate | image/video/audio **aggregator** | Y | Bearer `REPLICATE_API_TOKEN` | predictions create/get; `urls.stream` | vet model license; store version | model/hardware pricing | optional (experimental/open) |
| Pika | video | Y (via fal) | fal key / dev acct | async | prefer official `pika.art/api` (via fal) | fal pricing | optional video style |
| Kling | image, video | Y | Kling key / aggregators | async | 4K commercial | account/model | optional video |
| Hedra | avatar/video/audio aggregator | Y | `X-API-Key` (paid) | async | store underlying model | credits; low default limits | optional (avatar/fallback) |
| **HeyGen** | avatar video, lipsync, translate | Y | `X-Api-Key` | async + `callback_url` | twin/voice consent controls | PAYG from ~$5; by seconds | optional (avatar/dialogue shots + lipsync fallback) |
| **Topaz** | post/upscale/interpolate/denoise | Y | `X-API-Key` | async workflow create→upload→status→download | **not a generator** | per-credit tiers | **YES — post/upscale** |

Sources (codex): OpenAI [gpt-image](https://developers.openai.com/api/docs/models/gpt-image-1)/[videos](https://platform.openai.com/docs/api-reference/videos) · Artlist [dev portal](https://developer.artlist.io/welcome)/[auth](https://developer.artlist.io/authentication)/[song search](https://developer.artlist.io/search/song/song-controller-get-songs) · Midjourney [ToS](https://docs.midjourney.com/docs/terms-of-service) · [Runway](https://docs.dev.runwayml.com/guides/setup/) · [Luma](https://docs.agents.lumalabs.ai/) · [Firefly](https://developer.adobe.com/firefly-services/docs/firefly-api/api/) · Vertex [Imagen](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/image/overview)/[Veo](https://cloud.google.com/vertex-ai/generative-ai/docs/video/generate-videos-from-text)/[Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation) · ElevenLabs [TTS](https://elevenlabs.io/docs/overview/capabilities/text-to-speech)/[SFX](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)/[music](https://elevenlabs.io/docs/overview/capabilities/music) · [Suno](https://docs.sunoapi.org/) · [Udio](https://help.udio.com/en/articles/10756277-udio-public-api) · [Stability](https://platform.stability.ai/docs/api-reference) · [Ideogram](https://developer.ideogram.ai/) · [BFL/FLUX](https://help.bfl.ai/articles/8446125349-quickstart-guide) · [fal.ai](https://fal.ai/docs/documentation/model-apis/overview) · [Replicate](https://replicate.com/docs/reference/http/) · [Pika](https://pika.art/api) · [Kling](https://kling.ai/document-api/quickStart%2FproductIntroduction%2Foverview) · [Hedra](https://www.hedra.com/docs/pages/developer/getting_started/quickstart) · [HeyGen](https://developers.heygen.com/) · [Topaz](https://developer.topazlabs.com/video-api/introduction)

**Recommended default stack (codex):** images → **OpenAI gpt-image** (user pick), alt Firefly/BFL/Ideogram/Stability; video → **Runway or Luma** primary, Sora if entitled, fal/Replicate for breadth; music → **Artlist** (licensed) split from **ElevenLabs Music/Suno** (generated) — never conflated; SFX/ambient → **ElevenLabs SFX** or **Artlist** catalog; dialogue → **ElevenLabs** (Gemini/OpenAI TTS fallback); lipsync/avatar → existing lipsync + **HeyGen/Hedra**; post/upscale → **Topaz/Runway**.

**Two structural consequences:**
1. **Providers come in two kinds** (see §3): *Generators* (prompt → new asset) vs *Sources/Licensors* (query → licensed existing asset). Artlist is a **Source**, not a generator — keep them separate in the data model (`generated_music` vs `licensed_catalog`).
2. **"Artlist for the rest" splits by capability:** music/SFX/ambient/stock-footage → Artlist (licensed) **or** Suno/ElevenLabs/Stability (generative); **dialogue is generative-only → ElevenLabs.**

---

## 3. Architecture — the Provider Adapter layer

Generalize `gridlight-client.js` into a **provider registry** with a small adapter interface. Gridlight becomes one adapter among many; nothing else in the app changes shape.

### 3.1 Two adapter kinds
```
GeneratorAdapter   prompt/payload → NEW asset      (OpenAI, Runway, Luma, ElevenLabs, Suno, Stability, Gridlight)
SourceAdapter      query → EXISTING licensed asset (Artlist Enterprise, Epidemic Sound)
```

### 3.2 Interface (backend/lib/providers/*)
```js
// Common
{ id, kind: 'generator'|'source', capabilities: ['image'|'video'|'music'|'voice'|'sfx'|'stock'],
  auth: {type:'key'|'oauth'}, capabilities(), health(), estimateCost?(payload),
  validateProjectPolicy(payload, projectSettings) }   // gate rights/territory/budget before spend

// GeneratorAdapter — normalizes provider-specific request/response into our shape,
// reusing the shared queue / 429-retry / SSE-relay / client-disconnect helpers.
submit(capability, payload) → { jobRef }               // async providers (Runway/Luma/Sora/Suno/…)
poll(jobRef) → { status, output? }                     // provider queue status → film_*_jobs status
stream?(capability, payload, res)                       // SSE/WS providers (ElevenLabs TTS, some video)
downloadOutput(output) → { buffer, mime }              // ALWAYS pull bytes into film_assets (see 3.6)
cancel?(jobRef)

// SourceAdapter (Artlist/Epidemic)
search(capability, query) → [{ providerAssetId, title, preview, license }]
license(providerAssetId, opts) → { downloadUrl|buffer, license:{type,holder,cost,expiry,territory} }
```

### 3.3 Registry + resolution
- `providers/index.js`: registry keyed by id; `resolve(capability, projectSettings)` returns the configured adapter.
- **Config precedence:** per-project setting → env default → Gridlight fallback. e.g. `{ image:'openai', video:'runway', voice:'elevenlabs', music:'artlist', sfx:'artlist', ambient:'artlist' }`.
- Domain routes stop importing `_ENDPOINT` constants and instead call `resolve('image', settings).generate(...)`. `pipeline.executeStep` does the same, so the whole DAG becomes multi-provider with one change.

### 3.4 Asset provenance & the expiring-URL rule (data model)
Two hard requirements surfaced by the research:
1. **Presigned output URLs expire** (Luma, Ideogram, others). The adapter must **`downloadOutput()` bytes into `film_assets` immediately** — never store a provider URL as the asset of record.
2. **Every asset needs provenance/rights columns** (migration `044`, additive): `provider`, `provider_model`, `provider_job_id`, `license_source` (`generated` | `licensed_catalog`), `license_status`, `prompt_hash`, `input_refs` (JSON of source assets), `rights_notes`, `expires_at`. Generated assets set `license_source='generated'`; Artlist/Epidemic set `licensed_catalog` + map onto the existing `film_music_cues.license_*` fields. This keeps `generated_music` and `licensed_catalog` distinct (never conflated) and makes rights auditable at export.

### 3.5 What is preserved (do not rebuild)
Queue/semaphore, 429 retry, SSE relay + disconnect guard, per-domain job tables + `render_ledger`, `film_assets` registry, `film_music_cues` licensing fields, budget/cost tracking, NLE export. Async providers map naturally onto the existing `film_*_jobs` + polling (same pattern already built for 3D async handoff); streaming TTS maps onto the SSE path; most video is poll/download.

### 3.6 Secrets & safety
Per-provider API keys/OAuth secrets live **server-side only** (env / secure store), never in the SPA — consistent with the existing security posture (SPA never holds `GRIDLIGHT_API_KEY`). Project settings pick the provider per domain, but the frontend never sees provider credentials. Add per-provider budget caps (repo already tracks cost per generation), enforced via `validateProjectPolicy()` before spend.

---

## 4. The three UI questions — detailed answers

**Q1 — Music generation UI: build it (mirrors Video Shots / 3D).**
- A **Music** page under Media with three generate surfaces: per-scene **Score**, per-scene **Ambient**, per-shot **SFX**, plus **Generate All** (batch SSE). Backend already exists (`/scenes/:id/music/generate[/stream]`, `/scenes/:id/ambient/generate`, `/shots/:id/sfx/generate`, `/projects/:id/music/batch/stream`) — and we just fixed the latent bugs that made it 500.
- Add a **"Source from Artlist"** mode: search catalog → preview → license → attach, writing the `license_*` fields (Source adapter). Music Cues page stays for metadata/rights.

**Q2 — Video Shots per-card: add a few pro actions, keep the spine.**
- Keep **generate → preview → Premiere** as the primary flow.
- Add per-card: **Stitch** (shots >5s, backend `/video/stitch` exists), **Lip-sync** (when the shot has dialogue), **Post** (upscale/face-restore/color-grade), and a **provider selector** (which video model). All back-ends already exist; this surfaces them.

**Q3 — Send to Premiere: offer a portable package, not just the XML.**
- The exporter embeds **absolute local paths**: Premiere xmeml `<pathurl>file:///{file_path}</pathurl>`, FCPXML `src="{file_path}"`. So the current download-only XML **resolves media only on the machine running the server** (paths point into `~/.gridlight/film-engine/data/...`).
- **Recommendation:** add a **"Premiere Package"** = a `.zip`/folder containing the XML with **relative** pathurls + a `media/` folder of the rendered `.mp4`/`.wav`s — reusing the existing **project-bundle** (`.tar.gz`) machinery. Offer both: **Quick XML** (same-machine editing) and **Portable Package** (hand to an editor on another box). This is the real "send them to the editing suite" experience.

---

## 5. End-to-end: screenplay → final (with providers mapped)

```
Screenplay editor ──► Breakdown (LLM) ──► Scenes + Shots + Scene Cards
      │
      ├─ Storyboard image   → resolve('image')   → OpenAI gpt-image
      ├─ Video (per shot)    → resolve('video')   → Runway / Luma
      ├─ Dialogue            → resolve('voice')   → ElevenLabs
      ├─ Music (per scene)   → resolve('music')   → Artlist (license) OR Suno/Stability (gen)
      ├─ SFX / Ambient       → resolve('sfx')     → Artlist (license) OR ElevenLabs (gen)
      ├─ Lip-sync            → resolve('lipsync') → Gridlight lipsync; HeyGen/Hedra for avatar/talking-head shots
      ├─ Post                → resolve('post')    → upscale/grade; Topaz (upscale/interpolate) or Runway upscale
      └─ Assembly            → NLE export  →  Premiere Package / FCPXML / EDL / Resolve
```
The `PIPELINE_STEPS` DAG already encodes this order and dependencies; each step just needs to call `resolve(capability, settings)` instead of a hardcoded Gridlight endpoint. So **the end-to-end flow the user asked for already exists structurally** — it becomes multi-provider the moment the adapter layer lands.

---

## 6. Delivery plan (phased, each testable with the mock-gateway harness)

1. **Adapter layer refactor** — extract `providers/` registry + interface; make Gridlight `GridlightAdapter`; route `resolve()` in domain routes + `executeStep`. **No behavior change** (Gridlight stays the default). Regression-tested by the existing 555-test suite.
2. **OpenAI image adapter** — highest-value, cleanest API; wire storyboard/refsheet/reference-image to it. Add `providers/openai-image.test.js` (mock).
3. **ElevenLabs voice + SFX adapter** — dialogue is the pro must-have; SFX as bonus.
4. **Runway / Luma video adapter** — async/poll; reuse the async job-handoff pattern already built for 3D.
5. **Artlist Source adapter** — OAuth client-credentials; search/license/attach + write `license_*`; new "Source from Artlist" UI mode.
6. **UX surfaces** — Music generation page; Video Shots per-card actions + provider selector; **Premiere Package**; a **Provider Settings** panel (per-project provider choice + key status, keys entered server-side).

---

## 7. Honest caveats (must tell the user)
- **Midjourney: cannot be integrated** — no official API and its ToS forbids automation. Use FLUX/SD3/Firefly/Ideogram/Imagen for "MJ-grade" images that *do* have APIs, or keep MJ as manual import.
- **Artlist is licensed catalog, not generative**, and its Enterprise API is **OAuth/partner-gated** — needs an Artlist Enterprise account + client credentials; verify the tier grants API search/stream/download.
- **Suno**: generative music API exists but **commercial-rights terms need review** before shipping monetizable output.
- **Sora**: video API docs exist, but **account access/entitlement should be verified** before making it a default provider — treat as a later add.
- **Cost**: every provider is metered per generation. Wire per-provider budget caps into the existing cost tracker.
- **Keys**: per-provider secrets are **server-side only**; the SPA never holds them.

---

## 8. Immediate next step
Land **Phase 1 (adapter layer, Gridlight as default, zero behavior change)** — it's the unlock for everything else and is fully covered by the existing test suite. Then Phase 2 (OpenAI images) + Phase 3 (ElevenLabs voice) deliver the first visible multi-provider wins on the user's stated priorities.
