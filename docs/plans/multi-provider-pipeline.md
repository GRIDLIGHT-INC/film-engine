# Multi-Provider AI Film Pipeline — Integration Plan

**Authors:** Claude (codebase audit + architecture) & codex (provider/API research) — NeonCore confer task.
**Status:** FINAL — agreed by Claude + codex. Scope confirmed by user: Phase 1+2+3 now, Artlist (catalog + MCP) as Phase 4.
**Goal:** Make Film Engine a fully operational, provider-pluggable pipeline: write a screenplay → generate images, video, music, SFX, dialogue → hand off to Premiere/final — using best-in-class pro providers (ChatGPT/gpt-image for images, Artlist for both licensed music/SFX/footage **and** generative image/video via its MCP, ElevenLabs for dialogue, plus alternatives), not just Gridlight.

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
| **Artlist Catalog API** | music, sfx, stock/footage **(licensed source)** | Y (enterprise) | **OAuth2 client-credentials** (mgr-issued, ~1h token) | catalog search/list/download — **not generation** | **SOURCE/LICENSE** → maps to `film_music_cues.license_*` | partner-gated; 20 songs/page; filters query/category/vocal/duration/BPM | **YES — licensed music/SFX/footage** |
| **Artlist MCP / AI Toolkit** | **generative** image + video (100+ models) | Y — **MCP** (not REST) | **OAuth custom connector** → `https://mcp.artlist.io/mcp` | MCP tools; text/image/audio/video-to-video | **generator (aggregator)**; models incl. Sora 2 Pro, Kling 3.0, Veo 3.1, Seedance, Imagen 4 Ultra, FLUX.2 Pro, Nano Banana | any **paid Artlist plan with AI credits** (no separate billing) | **YES — one connection covering many image/video models (user pick)** |
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

**Recommended default stack:** images → **OpenAI gpt-image** (user pick) — *and/or* **Artlist MCP** for image+video (one connection, 100+ models); video → **Artlist MCP** (Sora 2 Pro/Kling 3.0/Veo 3.1/Seedance) or **Runway/Luma** direct; dialogue → **ElevenLabs** (user pick); music → **Artlist catalog** (licensed) split from **ElevenLabs/Suno** (generated) — never conflated; SFX/ambient → **ElevenLabs SFX** or **Artlist** catalog; lipsync/avatar → existing lipsync + **HeyGen/Hedra**; post/upscale → **Topaz/Runway**. Alts: Firefly/BFL/Ideogram/Stability (image), fal/Replicate (aggregators).

**Three structural consequences:**
1. **Providers come in three kinds** (see §3): *Generators* (REST prompt→asset), *Sources/Licensors* (query→licensed asset — Artlist Catalog, Epidemic), and *MCP-client* generators (Artlist MCP / AI Toolkit). Keep licensed vs generated distinct in the data model (`licensed_catalog` vs `generated`).
2. **Artlist is now BOTH** a licensed catalog (REST) **and** a generative image/video aggregator (MCP) — the user can lean on Artlist for a lot: licensed music/SFX/footage *and* generated image/video across 100+ models.
3. **Dialogue is generative-only → ElevenLabs** (Artlist MCP emphasizes image+video; music/voiceover MCP coverage is TBD — see §3.6).

---

## 3. Architecture — the Provider Adapter layer

Generalize `gridlight-client.js` into a **provider registry** with a small adapter interface. Gridlight becomes one adapter among many; nothing else in the app changes shape.

### 3.1 Three adapter kinds
```
GeneratorAdapter   prompt/payload → NEW asset      (OpenAI, Runway, Luma, ElevenLabs, Suno, Stability, Gridlight)
SourceAdapter      query → EXISTING licensed asset (Artlist Catalog API, Epidemic Sound)
McpClientAdapter   MCP tool call → NEW asset        (Artlist MCP / AI Toolkit — backend connects as an MCP client)
```
The `McpClientAdapter` is a **GeneratorAdapter whose transport is MCP** rather than a bespoke REST call — it normalizes MCP tool results into the same `{ asset }` shape, so downstream (jobs, `film_assets`, provenance, SSE) is identical.

### 3.2 Interface (backend/lib/providers/*)
```js
// Common
{ id, kind: 'generator'|'source'|'mcp', capabilities: ['image'|'video'|'music'|'voice'|'sfx'|'stock'],
  auth: {type:'key'|'oauth'}, health(), estimateCost?(payload),
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

### 3.6 Artlist: two connections (catalog REST + generative MCP)
Artlist is **both** a licensed catalog *and* a generative aggregator — wire both:
- **Catalog** (`developer.artlist.io`, OAuth2 client-credentials) → `SourceAdapter` for licensed music/SFX/footage, writing `license_*`. Programmatic REST.
- **AI Toolkit** (`https://mcp.artlist.io/mcp`) → `McpClientAdapter` exposing **100+ generative image/video models** (Sora 2 Pro, Kling 3.0, Veo 3.1, Seedance, Imagen 4 Ultra, FLUX.2 Pro, Nano Banana). **Strategic upside:** one Artlist connection covers many image/video models the user would otherwise integrate individually (Runway/Luma/Sora/Kling/Veo/FLUX), with generation billed via Artlist AI credits — a real simplification of the provider matrix.

**Integration reality (be honest):** the Artlist MCP is designed for MCP *clients* (Claude desktop/browser today; ChatGPT/Cursor "next"). For Film Engine's backend to drive it autonomously it must act as an **MCP client** to the remote server over Streamable-HTTP with **OAuth** — the authorization is interactive (user approves once in a browser), so we run the OAuth flow once, store the refresh token server-side, and the backend reuses it. This is more involved than an API key and warrants a short spike. Two things to verify during the spike: (1) whether the MCP exposes **music/voiceover** tools (the launch emphasizes image+video; music+voiceover exist in the AI Toolkit web product) and (2) exact tool schemas + async/polling behavior for long video jobs. Near-term, this same MCP can be connected to *this* Claude environment as a custom connector to drive Artlist generation during authoring/testing while the backend adapter is built.

### 3.7 Secrets & safety
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
      ├─ Storyboard image   → resolve('image')   → OpenAI gpt-image  OR  Artlist MCP (Imagen4/FLUX.2/Nano Banana)
      ├─ Video (per shot)    → resolve('video')   → Artlist MCP (Sora2Pro/Kling3/Veo3.1/Seedance)  OR  Runway/Luma
      ├─ Dialogue            → resolve('voice')   → ElevenLabs
      ├─ Music (per scene)   → resolve('music')   → Artlist catalog (license) OR Suno/Stability (gen)
      ├─ SFX / Ambient       → resolve('sfx')     → Artlist catalog (license) OR ElevenLabs (gen)
      ├─ Lip-sync            → resolve('lipsync') → Gridlight lipsync; HeyGen/Hedra for avatar/talking-head shots
      ├─ Post                → resolve('post')    → upscale/grade; Topaz (upscale/interpolate) or Runway upscale
      └─ Assembly            → NLE export  →  Premiere Package / FCPXML / EDL / Resolve
```
The `PIPELINE_STEPS` DAG already encodes this order and dependencies; each step just needs to call `resolve(capability, settings)` instead of a hardcoded Gridlight endpoint. So **the end-to-end flow the user asked for already exists structurally** — it becomes multi-provider the moment the adapter layer lands.

---

## 6. Delivery plan (user chose Phase 1+2+3; each phase testable with the mock-gateway harness)

**Phase 1 — Adapter layer refactor** *(chosen)*. Extract `providers/` registry + interface (Generator/Source/McpClient); make Gridlight `GridlightAdapter`; migration `044` (asset provenance columns); route `resolve()` in domain routes + `executeStep`. **No behavior change** (Gridlight stays default). Regression-tested by the existing 555-test suite. Also ship the **Provider Settings** panel now so keys have a home — the user will enter **OpenAI + ElevenLabs** keys there (server-side; SPA never sees them).

**Phase 2 — OpenAI image adapter** *(chosen; key in hand)*. `providers/openai-image.js` (`gpt-image-1`), wire storyboard/refsheet/reference-image. `providers/openai-image.test.js` (mock).

**Phase 3 — ElevenLabs voice + SFX adapter** *(chosen; key in hand)*. Dialogue is the must-have; SFX bonus. Streaming TTS → SSE path. Mock test.

**Phase 4 — Artlist (both connections)** *(user asked to add)*:
- 4a. **Artlist Catalog** `SourceAdapter` (OAuth2 client-credentials) — search/license/attach + write `license_*`; "Source from Artlist" UI.
- 4b. **Artlist MCP** `McpClientAdapter` — backend MCP client to `https://mcp.artlist.io/mcp` (OAuth once → stored refresh token). Short **spike first** to confirm tool schemas + music/voiceover coverage (§3.6). Gives generative image+video across 100+ models via one connection.

**Phase 5 — Remaining pro providers as needed** — Runway/Luma direct video (if not going through Artlist MCP), Topaz post, HeyGen/Hedra avatar.

**Phase 6 — UX surfaces** — Music generation page; Video Shots per-card actions + **provider selector**; **Premiere Package** export.

---

## 7. Honest caveats (must tell the user)
- **Midjourney: cannot be integrated** — no official API and its ToS forbids automation. Use FLUX/SD3/Firefly/Ideogram/Imagen for "MJ-grade" images that *do* have APIs, or keep MJ as manual import.
- **Artlist has two surfaces:** (a) the **Catalog API** (`developer.artlist.io`, OAuth2 client-credentials, partner-gated) for *licensed* music/SFX/footage; and (b) the **AI Toolkit via MCP** (`mcp.artlist.io/mcp`, OAuth, any paid plan with AI credits) for *generative* image+video across 100+ models. The MCP is **agent-oriented** — Film Engine's backend must act as an **MCP client with a stored OAuth token**, which is more involved than an API key and needs a short spike (verify music/voiceover tool coverage + async job behavior).
- **Suno**: generative music API exists but **commercial-rights terms need review** before shipping monetizable output.
- **Sora**: video API docs exist, but **account access/entitlement should be verified** before making it a default provider — treat as a later add.
- **Cost**: every provider is metered per generation. Wire per-provider budget caps into the existing cost tracker.
- **Keys**: per-provider secrets are **server-side only**; the SPA never holds them.

---

## 8. Immediate next step (agreed scope)
Build **Phase 1 → 2 → 3** as chosen: adapter layer (Gridlight default, zero behavior change, +Provider Settings panel for server-side keys) → **OpenAI gpt-image** → **ElevenLabs voice/SFX**. The user has OpenAI + ElevenLabs keys and will enter them in Settings. Then **Phase 4** adds Artlist — start with the Catalog `SourceAdapter` (straightforward REST), and run the **Artlist MCP spike** in parallel to de-risk the MCP-client path before wiring it as a generator. Each phase stays green against the existing 555-test suite + new per-adapter mock tests.

## 9. Provider setup checklist (for the user)
- **OpenAI**: API key → Settings (have it ✅).
- **ElevenLabs**: `xi-api-key` → Settings (have it ✅). Paid plan required for commercial use.
- **Artlist**: a **paid Artlist plan with AI credits** for the MCP (image/video generation); separately, an **Artlist Enterprise** account + client-credentials for the licensed Catalog API. Confirm which you have — the MCP (paid+credits) is broadly available; the Catalog API is partner/enterprise-gated.
