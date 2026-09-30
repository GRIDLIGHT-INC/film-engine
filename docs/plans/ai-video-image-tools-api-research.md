# AI video and image tools: API access, flexibility and pricing

*Research, 2026-09-29. Subject: every video and image tool on [curiousrefuge.com/best-ai-tools](https://curiousrefuge.com/best-ai-tools#ai-video-tools). Can Film Engine connect to each through an API, which are the most flexible, and what they cost.*

## Scope

The page draws its tool lists in the browser from Elfsight "pricing table" widgets, so the tool names and scores were read from the widgets' own data (`core.service.elfsight.com/p/boot`, one widget per section), not from the rendered page. Seven image and video tables were in scope. The language, music and voice sections were out of scope.

| Section | Tables | Entries |
|---|---|---|
| AI Video Tools | Image to Video (25), Lip Syncing (7), Performance Control (1) | 33 |
| AI Image Tools | Text to Image | 19 |
| AI Image Editing | Object Removal (5), Background Removal (4), Outpainting (3), Facial Expression (2) | 14 |
| AI VFX | Inpainting (3), Object Removal (4), Face Swap (2), Background Removal (1), Performance Capture (2) | 12 |
| AI Consistency | Products (5), Characters (6), Styles (4) | 15 |
| AI Quality Enhancement | Image (7), Video (3), Creative Image (3), Creative Video (2) | 15 |
| AI Tool Aggregators | Aggregators | 7 |
| **Total** | 21 tables | **115 entries**, about 60 distinct products |

Every product was researched: 10 video-generator families, 13 video/lip-sync/VFX/performance tools, 24 image tools, 7 upscaler families, 7 page aggregators and 9 API aggregators. Prices were checked on 2026-09-29 against vendor documentation first and resellers second. Where only a secondary source had a figure, it is marked as such; where nothing was found, the row says so and names where we looked.

## Key Ideas & Themes

1. **Almost everything worth using has an API, and most of it is already one key away.** Of the top-scoring tools, only Midjourney (image and video), Autodesk Flow Studio, Canva and FaceApp have no API at all. Adobe Firefly, DomoAI and Synthesia's dubbing are enterprise-only. Everything else is reachable, and MuAPI, Film Engine's house provider, already carries most of it: Seedance 2, Kling 3.0 (including 4K and Omni), Veo 3.1, Happy Horse, Hailuo 2.3, Wan 2.6, LTX-2, Sora 2, Nano Banana Pro/2, GPT Image 2, Flux 2, Seedream 5, Imagen 4, Z-Image, Reve, Ideogram, Runway Act-Two and Aleph, lip-sync models, and the Topaz upscalers.

2. **The real gaps in MuAPI are narrow.** Luma Ray 3.2 is missing (Luma's own API, or fal). So are Magnific (its own API, or Runway's API, which resells its upscalers), Topaz's newer Starlight and Astra video upscalers (Topaz direct or fal), Recraft (its own API or fal), and HeyGen lip-sync translation (HeyGen or fal).

3. **The most flexible video models:**
   - **Seedance 2.0 Omni:** up to 9 images, 3 videos and 3 audio as references, native audio with lip-sync, edit, extend and first/last frame, 4–15 s, up to 4K. It refuses reference images of real human faces.
   - **Gemini Omni Flash:** any mix of text, image, audio and video in; conversational video editing; extends to 40 s.
   - **Kling 3.0 / O3:** element references with voice binding, multi-shot, video editing, 4K.
   - **Luma Ray 3.2:** up to 64 keyframes, Modify Video, HDR with EXR export. No audio.
   - **Happy Horse 1.x:** 1–9 references, video editing, lip-sync in 7 languages.
   - **Runway API (Aleph 2 and Act-Two):** edits real footage in context and transfers a performance from a driving video.

4. **The most flexible image models:** Nano Banana Pro (1K/2K/4K, up to 14 references, multi-turn editing, seed) and Nano Banana 2 (the same, cheaper). GPT Image 2 is the only true custom 4K with mask inpainting and the best text rendering, but has no seed. Seedream 5.0 takes up to 14 references. FLUX.2 takes 10 references with exact hex colours but tops out at 4 MP.

5. **Value, per second of video, at official list price:**

   | Model | Price per second |
   |---|---|
   | Veo 3.1 Lite (720p) | $0.05 |
   | Veo 3.1 Fast | $0.10 |
   | Gemini Omni Flash, 360p draft | $0.03 |
   | LTX 2.3 Fast | from $0.03; cheapest 4K at $0.24–0.39 |
   | Seedance 2.0 Mini | $0.04 |
   | Seedance 2.0 (480–720p) | ≈$0.07–0.15 |
   | Kling 3.0, 720p no audio | $0.084 |
   | Kling 3.0, 1080p with audio | $0.14 |
   | Pika 2.5 | $0.04 |
   | Runway Act-Two | $0.05 |
   | Runway Gen-4.5 | $0.12 |
   | Runway Aleph 2 | $0.28, the priciest, and the one that edits real footage |

   For images at 2K, Seedream 5.0 Lite ($0.035), Kling O3 ($0.028) and Luma UNI-1 ($0.04) are cheapest. For Nano Banana, MuAPI is the cheapest source found at every resolution (Pro $0.12, 2 $0.09).

6. **Upscaling:** Topaz direct is the most transparent. It publishes credit rates and covers Gigapixel, Bloom, Starlight Precise and Astra with one key; Starlight 10 s to 4K costs about $2–3. fal resells Starlight at $2.60 per 10 s at 4K. Magnific is reachable through its own API (formerly the Freepik API) or through Runway's API.

7. **Aggregators trade coverage against provenance.**
   - **fal.ai:** the widest coverage, mostly at list price.
   - **MuAPI:** the largest catalogue (about 760 models), often under list price. Its model list and cost estimates are free to read.
   - **Replicate:** similar coverage, but about 2× list price for Kling.
   - **Runway API:** resells Veo, Seedance, Hailuo, Gemini, GPT Image and Magnific at $0.01 per credit, and adds Aleph and Act-Two, which only Runway has.
   - **Magnific API:** one key for its own upscalers plus Veo, Kling, Seedance and Nano Banana. Its prices are behind pages that would not load.

8. **Things that change decisions this week:**
   - **Retired:** the OpenAI Sora 2 API (2026-09-24, no replacement) and Runway's Gen-4 Aleph v1 (2026-07-30).
   - **Shutting down:** Nano Banana, Gemini 2.5 Flash Image, **on 2026-10-02**.
   - **Legacy or moved:** Hailuo 2.3 and 02 are "Legacy" at MiniMax, which has moved to H3. Imagen 4 is now on Vertex AI only. The `ltx-2-*` model IDs retired on 2026-08-15; use 2.3 or 2.5.

9. **Terms to respect.** Midjourney is reachable only through resellers that break its terms of service, so do not wire it. InsightFace, which ComfyUI uses for face swap, is licensed for non-commercial use only. Seedance refuses real-face references. MuAPI publishes its prices with no unit; they read as per clip (about 5 s).

## Recommendation, for the epic step

| Need | Route | Why |
|---|---|---|
| Default video and image | **MuAPI** (already wired) | Widest catalogue, often under list price; one key already configured |
| Expose more MuAPI models | Extend the Seedance/MuAPI adapter's model registry: Kling 3.0 / O3 / Omni, Veo 3.1 Lite/Fast, Happy Horse, LTX 2.3, Wan 2.6, Seedream 5.0, Z-Image, GPT Image 2, Imagen 4 | Endpoints exist; each needs its field map probed free, as Seedance's was |
| Footage editing and performance | **Runway API** (already wired) | Aleph 2 and Act-Two exist nowhere else; already has an adapter |
| Keyframe-heavy and HDR finishing | **Luma API** (new adapter), or fal | Ray 3.2 has 64 keyframes and EXR; not on MuAPI |
| Video finishing (upscale) | **Topaz direct** (new), or fal | Starlight/Astra with published rates; MuAPI has only the older Topaz video model |
| Lip-sync on existing footage | **HeyGen** (new) or MuAPI's sync/ltx lip-sync | $0.025/s translation-with-lip-sync |
| Retire | Nano Banana (2.5 Flash Image) model id | Shuts down 2026-10-02 |
| Do not wire | Midjourney, Flow Studio, Canva, FaceApp; Firefly/DomoAI unless an enterprise contract exists | No API, or its terms forbid automated access |

## Local Findings

What Film Engine already reaches, read from the code on 2026-09-29 (`providers.list()` and `modelIdsFor`), and what earlier research in `docs/plans` already decided.

**Provider adapters** (`backend/lib/providers/`):

| Adapter | Capabilities | Models it offers today |
|---|---|---|
| `runway.js` | video, image | video: `aleph2`, `gen4.5`, `gen4_turbo`, `veo3.1`, `veo3.1_fast`, `happyhorse_1_0`, `hailuo3`, `seedance2_5`, `seedance2`, `seedance2_fast`, `seedance2_mini`, `gemini_omni_flash`; image: `gen4_image`, `gen4_image_turbo`, `gemini_2.5_flash` |
| `seedance.js` (MuAPI) | video, post | Seedance 2.5 at 480p/720p/1080p/4K; post: Seedance video-edit tiers, `topaz-video-upscale`, `ai-video-upscaler`, `ai-video-upscaler-pro`, `flux-3-video-upscaler` |
| `muapi-image.js` | image | `nano-banana-pro`, `nano-banana-2`, `nano-banana-2-lite`, `nano-banana` |
| `google-image.js` | image | `gemini-3.1-flash-image`, `gemini-3-pro-image`, `gemini-3.1-flash-lite-image` |
| `bfl-image.js` | image | `flux-2-klein`, `flux-2-flex`, `flux-2-pro`, `flux-2-max` |
| `openai-image.js` | llm, image | `gpt-image-1` |
| `meshy.js` | model3d, image | `nano-banana-pro`, `nano-banana-2`, `nano-banana`, `gpt-image-2` |
| `gridlight-adapter.js` | all, off by default | `flux2-dev` (self-hosted) |
| `worldlabs.js`, `elevenlabs.js`, `anthropic.js`, `fluidsynth.js` | world, audio, llm, music | not image/video |

**MuAPI catalogue snapshot** (`backend/tests/fixtures/muapi-contract.json`, checked 2026-08-31, 655 models, list price per call), against the page's families:

| Family | Count | Examples |
|---|---|---|
| seedance | 137 | `seedance-2-i2v-480p` $0.60 … `seedance-2-image-to-video` $1.25 |
| kling | 45 | `kling-v3.0-pro/standard/4k/omni-*`, `kling-v3-turbo-*`, `kling-v2.6-pro-*` (+ motion control), `kling-v2.5-turbo-*`, `kling-o3-image(-edit)` |
| veo | 15 | `veo3-fast` $0.60, `veo3` $2.50, `veo3.1-4k-video` $0.60, `veo-4-*` $3 |
| wan | 46 | includes `wan2.6-image-to-video`, `wan2.6-text-to-video`, `wan2.6-image-edit` |
| ltx | 13 | `ltx-2-19b-*` $0.60, `ltx-2-pro/fast-*` $0.46, `ltx-2.3-image-to-video` $0.104, lip-sync |
| hailuo / minimax | 9 / 23 | `minimax-hailuo-2.3-pro/standard/fast`, `minimax-h3-*` |
| happy-horse | 16 | 720p $0.90, 1080p $1.80, reference and video-edit variants |
| sora | 7 | `openai-sora-2-*` (retired upstream on 2026-09-24) |
| midjourney | 3 | `midjourney-v7`, `v8`, `niji` at $0.10 (terms of service forbid this) |
| flux / seedream / imagen / gpt-image / nano-banana | 47 / 10 / 3 / 4 / 9 | FLUX.2 dev/flex/klein, Seedream 5.0 Pro, Imagen 4 (all tiers), GPT Image 2 $0.09, Nano Banana Pro $0.12 |
| z-image / reve / ideogram / hunyuan / vidu | 9 / 2 / 3 / 5 / 18 | |
| runway (resold) | 5 | `runway-act-two-*`, `runway-aleph-v2v` |
| upscalers | 7 | `topaz-image-upscale`, `topaz-video-upscale`, `ai-video-upscaler(-pro)`, `seedvr2-image-upscale`, `flux-3-video-upscaler` |
| lip-sync | 6 | `sync-lipsync`, `creatify-lipsync`, `veed-lipsync`, `ltx-2(.3)-lipsync`, `volcengine-video-to-video-lip-sync` |
| missing | | Luma (only `luma-flash-reframe`), Recraft, Magnific, Pika, HeyGen generation (only translate) |

**Prior decisions in `docs/plans`:**
- `multi-provider-pipeline.md`: Midjourney is "NO adapter, manual import only (ToS forbids automated access)". fal and Replicate were rated "YES as aggregator/fallback, not provenance source". Luma Agents was "YES" but was never built. Artlist was removed and replaced by Runway on 2026-07-29.
- `runway-parity-brief.md`: Runway's API has 65 operations and the adapter reaches 6 of its 49 paths. Magnific video upscale, frame-rate enhancement and HDR are reachable through it and not wired.
- `comfyui-research-brief.md`: closed on 2026-09-28. Gridlight on AWS is the open-weight runtime. Comfy Cloud partner nodes resell Runway, Seedance and Kling outside Film Engine's meter.
- `CLAUDE.md` rules that apply to any new adapter:
  - it declares `promptLimit`, `maxReferenceImages`, `referenceMode`, `maxKeyframes`, `sizeControl` and `deliverableFrame`;
  - it has a rate-book row with a source and a checked date;
  - its fields are probed for free before anything is bought.

## Web Findings

Source-by-source findings from the four research passes, unedited, each with its own source list (title, URL, key insight).

### AI video models: API availability, price and flexibility (researched 2026-09-29)

Scope: the video models ranked on curiousrefuge.com/best-ai-tools. That page renders client-side and WebFetch could not read the scores, so they are taken from the brief as given.

#### How to read the prices
- **Official** means the vendor's own page. Where the vendor page was JS-only and unreadable (BytePlus ModelArk pricing, Kling dev pricing), the figure comes from a dated third-party write-up that quotes it, and it is marked *(secondary)*.
- **MuAPI** figures come from the repo's own snapshot of `https://api.muapi.ai/api/v1/models` (checked 2026-08-31, `backend/tests/fixtures/muapi-contract.json`). The catalogue `cost` has no unit. Cross-checked against `lib/providers/seedance.js`: Seedance 2.5 480p lists 0.85, which is 5 s × $0.17/s. So a MuAPI figure below is **the price of a default ~5 s clip**, and some models may default to other lengths. Treat these as indicative.
- fal.ai prices were read from each model page on 2026-09-29.

---

#### 1. ByteDance Seedance 2.0 (8.4), Seedance 2.0 Omni (lip sync 8, inpainting 8.5, removal 8), Seedance 1.5 Pro (7.3)

| Item | Finding |
|---|---|
| Official API | **Yes.** BytePlus ModelArk ("Dreamina-Seedance-2.0", with 2.0 Fast and 2.0 Mini) internationally, and Volcengine Ark in China (needs real-name verification and RMB). Docs: https://docs.byteplus.com/en/docs/ModelArk/2291680 (2.0 tutorial), https://docs.byteplus.com/en/docs/ModelArk/1520757 (create task), pricing https://docs.byteplus.com/docs/ModelArk/1099320. Billing is by tokens: (input video s + output s) × W × H × fps / 1024. |
| Official price | *(secondary; anikuku.com, verified 2026-09-04, citing ModelArk)*<br>2.0: 480p $0.07/s · 720p $0.15/s · 1080p $0.37/s · 4K $0.78/s<br>2.0 Fast: 480p $0.06 · 720p $0.12<br>2.0 Mini: 480p $0.04 · 720p $0.08<br>Resource-pack token rates: 720p $7/M tokens without video input, $4.3/M with; 1080p $7.7/$4.3→4.7; Fast $5.6/$3.3.<br>Volcengine: ¥70/M tokens without video, ¥42/M with.<br>1.5 Pro: $2.40/M video tokens with audio, $1.20/M without, which is about $0.023/s at 480p up to $0.47/s at 4K with audio (OpenRouter).<br>The sources disagree by a few cents, so check the live console before budgeting. |
| Third-party hosts | **fal.ai** (https://fal.ai/models/bytedance/seedance-2.0/image-to-video):<br>• Standard $0.3024/s i2v and $0.3034/s t2v at 720p; $0.682/s at 1080p<br>• Fast $0.2419/s (720p max)<br>• Mini ~$0.043/s 480p, ~$0.093/s 720p<br>• Audio included; 1.5 Pro 720p 5 s with audio ≈ $0.26<br>**Replicate** (https://replicate.com/bytedance/seedance-2.0): billed per output second; 480p/720p listed.<br>**MuAPI** (per ~5 s clip):<br>• seedance-2 t2v/i2v $0.75, 480p $0.60<br>• first-last-frame $1.25, omni-reference $1.50, omni-reference without video $1.25, video-edit $1.50, extend $1.05, mini $0.20<br>• "vip" 1080p $3.375 and 4K $6.75<br>• v1.5-pro $0.34, fast $0.26<br>Also on Atlas Cloud, WaveSpeed, Segmind, Kie.ai, PiAPI, OpenRouter ($7/M tokens). |
| Cheapest found | 2.0 Mini at ~$0.04/s at 480p (BytePlus, fal). For full 2.0: ~$0.07/s at 480p official, or MuAPI's 480p i2v at ~$0.12/s ($0.60 per 5 s). |
| Inputs | Text; first frame; first + last frame; **omni-reference with up to 9 images, 3 videos and 3 audio files** (@Image1 / @Video1 / @Audio1 tagging); video edit and extend. Native joint audio and video, with dialogue in quotes lip-synced at phoneme level across 8+ languages. The audio references are what make lip-sync to supplied dialogue possible, which is how the "Omni" lip-sync, inpainting and removal scores are reached. |
| Output | 4–15 s; 480p/720p/1080p (2.0), 4K on BytePlus 2.0 ("vip" on MuAPI); fal Fast caps at 720p. Aspect ratios: 21:9, 16:9, 4:3, 1:1, 3:4, 9:16, auto. Seed is supported. 1.5 Pro: 4–12 s, up to 1080p, start and end frame, `camera_fixed`. |
| Notable | **Refuses reference images containing real human faces** (HTTP 400 `InputImageSensitiveContentDetected.PrivacyInformation`). The workarounds are virtual avatars, AI-generated portraits, or asset-id authorisation. Setting `aspect_ratio` on a first+last-frame request returns a 400. Result URLs expire after ~24 h. Failed jobs are not billed. Seedance 2.5 (up to 30 s, 50 references) exists above 2.0. |

#### 2. Kuaishou Kling 3.0 (8.1), Kling 3.0 Omni (lip sync 6, inpainting 8, removal 7.5), Kling 2.6 (7.6), Kling 2.5 Turbo (7.4)

| Item | Finding |
|---|---|
| Official API | **Yes.** Kling AI Developer Platform (https://kling.ai/dev, pricing https://kling.ai/dev/pricing). It uses prepaid resource-unit packages billed separately from the consumer app:<br>• trial $9.80 for 100 units, 30 days<br>• $700 for 5,000 units ($0.14/unit, 180 days, 20 concurrent)<br>• up to $7,560 for 60,000 units ($0.126/unit) |
| Official price | *(secondary; costbench.com, verified 2026-08-18; atlascloud 2026-07-14)* Kling 3.0 and 3.0 Omni, per second:<br>• 720p std: 0.6 u ($0.084) without audio, 0.8 u ($0.112) with audio, 0.9 u ($0.126) with video input<br>• 1080p pro: 0.8 u ($0.112), 1.0 u ($0.14), 1.2 u ($0.168)<br>• 4K: 3.0 u ($0.42)<br>Motion control: 720p $0.126/s, 1080p $0.168/s. Avatar: 720p $0.056/s, 1080p $0.112/s.<br>Legacy 1.5/2.1 std is 2 units per 5 s ($0.28). 2.6 and 2.5 Turbo official unit rates: **not found** (the page is JS-rendered). |
| Third-party hosts | **fal.ai**:<br>• v3 Standard $0.084/s without audio, $0.126 with, $0.154 with voice control<br>• v3 Pro i2v $0.112 / $0.168 / $0.196 (https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video)<br>• O3 (3.0 Omni) Pro reference-to-video $0.112/s without audio, $0.14/s with (https://fal.ai/models/fal-ai/kling-video/o3/pro/reference-to-video)<br>• 2.6 Pro $0.07/s without audio, $0.14 with, $0.168 with voice<br>• 2.5 Turbo Pro $0.35 per 5 s plus $0.07/s after that<br>**MuAPI** (per clip):<br>• v3.0 std/pro $0.72, 3.0 4K $2.00<br>• 3.0 Omni std $0.42, pro $0.56, 4K $2.68<br>• 3.0 Turbo std $0.56, pro $0.70<br>• 2.6 pro $0.90, 2.5 Turbo std $0.28, pro $0.45<br>• O1 video-edit $1.09 (fast $0.585)<br>• motion control from $0.10<br>Also on PiAPI, Atlas Cloud, Renderful (2.5 Turbo / 2.6 at $0.31 per 5 s). |
| Cheapest found | 3.0: $0.084/s at 720p without audio (official and fal). 2.5 Turbo: $0.28 per 5 s std on MuAPI (~$0.056/s). 2.6: $0.07/s without audio on fal. |
| Inputs | 3.0: text; start image; end image; **elements** (character/object references as @Element, with voice binding to video elements); multi-prompt / multi-shot; negative prompt; cfg. Native audio in Chinese and English, other languages auto-translated. 3.0 Omni (O-series): multiple reference images, video reference, start/end frame, **video editing** (O1 / O3 edit). 2.6: 5 s or 10 s, native audio with lip-synced dialogue, voice control. 2.5 Turbo: start and end (tail) frame, 5 s or 10 s, no native audio. |
| Output | 3.0: 3–15 s; 720p std, 1080p pro, 4K tier; aspect ratio taken from the start image. Motion control transfers motion from a reference video. |
| Notable | API units are separate from app credits. Concurrency is capped by package (5 on trial, 20 on standard). |

#### 3. Luma Ray 3.2 (7.7), Ray 3 (7.0)

| Item | Finding |
|---|---|
| Official API | **Yes, Ray 3.2**, through the Luma Agents API (https://docs.agents.lumalabs.ai/guides/model, pricing https://docs.agents.lumalabs.ai/guides/pricing). Two tiers: Build (usage-based) and Scale (dedicated capacity with SLAs). **Ray 3 / Ray 3.14**: not documented on the current API (only ray-3.2 is listed; Ray 3.14 is in the creative app). Treat Ray 3 as not available by API. |
| Official price (Ray 3.2, SDR) | 360p draft $0.06 per 5 s / $0.18 per 10 s · 540p $0.15 / $0.45 · 720p $0.30 / $0.90 · 1080p $1.20 / $3.60.<br>HDR (5 s only): 720p $0.60, 1080p $2.40. HDR + EXR: $0.90 / $3.60.<br>Extend: one 5 s block at the generation rate.<br>Reframe: $0.03–0.36/s.<br>Video edit: 720p $1.08 per 5 s, 1080p $2.16 per 5 s; HDR ×2, HDR+EXR ×3. |
| Third-party hosts | fal.ai (https://fal.ai/models/luma/agent/ray/v3.2/image-to-video and video-to-video) at the same prices; Replicate (https://replicate.com/luma/ray-3.2); Runware; MuAPI has only `luma-flash-reframe` ($0.35). |
| Cheapest found | Official 540p at $0.03/s; 360p draft at $0.012/s. |
| Inputs | Text; start frame and/or end frame; **multi-keyframe (up to 64 anchors in the API)**; video edit (Modify Video V2: restyle, relight, environment and product swap, character transformation, motion transfer); reframe; extend; seamless loop. **No native audio.** |
| Output | 540p/720p/1080p (360p draft); 5 s or 10 s per generation (Modify up to 20 s); aspect ratios 9:16, 3:4, 1:1, 4:3, 16:9, 21:9. Native HDR in 16-bit with EXR export (ACES2065-1). |
| Notable | The only model here with HDR/EXR delivery. Failed generations are refunded. |

#### 4. Alibaba Happy Horse 1.0 (7.63)

| Item | Finding |
|---|---|
| Official API | **Yes.** Alibaba Cloud Model Studio (Bailian): `happyhorse-1.0-t2v/-i2v`, reference-to-video and video-edit. Docs: https://www.alibabacloud.com/help/en/model-studio/happyhorse-text-to-video-api-reference, …/happyhorse-reference-to-video-api-reference, …/happyhorse-video-edit-api-reference. |
| Official price | *(secondary; invideo / atlascloud, Aug 2026)* ¥0.9/s at 720p (~$0.125) and ¥1.6/s at 1080p (~$0.22). Failed generations are not billed. |
| Third-party hosts | **fal.ai** (official partner; https://fal.ai/models/alibaba/happy-horse/image-to-video):<br>• 1.0: 720p $0.14/s, 1080p $0.28/s; video-edit $0.56/s at 1080p<br>• 1.1: $0.18/s at 1080p<br>**MuAPI** (per clip):<br>• 1.0 720p $0.90, 1080p $1.80<br>• 1.1 720p $0.70, 1080p $0.90<br>Also on WaveSpeed, Atlas Cloud, PoYo. |
| Cheapest found | 1.0 at ~$0.125/s at 720p (official). 1.1 at $0.18/s at 1080p (fal). |
| Inputs | Text; image; **reference-to-video with 1–9 reference images**; video edit (video plus reference image, for style transfer and local replacement). Native joint audio and Foley, **multilingual lip-sync** (EN, ZH, Cantonese, JA, KO, DE, FR). Seed is supported. |
| Output | 3–15 s; 720p/1080p; 16:9, 9:16, 1:1, 4:3, 3:4; 24 fps; prompt up to 2,500 characters. |
| Notable | Was #1 on the Artificial Analysis Video Arena for t2v and i2v. |

#### 5. MiniMax Hailuo 2.3 (7.5), Hailuo 02 ("Hailuo 2", 5.4)

| Item | Finding |
|---|---|
| Official API | **Yes, but both are now "Legacy Models"** on the MiniMax platform (https://platform.minimax.io/docs/guides/pricing-paygo). The current model is **MiniMax H3**. |
| Official price (pay-as-you-go, per video) | Hailuo 2.3: 768p 6 s $0.28 · 768p 10 s $0.56 · 1080p 6 s $0.49.<br>2.3 Fast: $0.19 / $0.32 / $0.33.<br>Hailuo 02: same as 2.3, plus 512p 6 s $0.10 and 512p 10 s $0.15.<br>Packages: $1,000 for 3,760 points (~$0.27/point); 2.3 at 768p 6 s = 1 point.<br>For comparison, H3: 768p $0.08/s, 2K $0.13/s; H3-Max 480p $0.05/s. |
| Third-party hosts | **fal.ai**: 2.3 Pro i2v $0.49 per video at 1080p (https://fal.ai/models/fal-ai/minimax/hailuo-2.3/pro/image-to-video).<br>**MuAPI** (per clip):<br>• 2.3 std $0.36, pro $0.63, fast $0.24<br>• 02 std i2v $0.15, pro $0.60<br>• H3 $1.00, H3 open $0.26 |
| Cheapest found | 2.3 Fast at 768p 6 s for $0.19 (official, ~$0.032/s). 02 at 512p 6 s for $0.10 (official, ~$0.017/s). |
| Inputs | Text; first frame (i2v); end frame on 02 (not confirmed for 2.3); prompt optimizer; camera-movement commands in brackets in the prompt. **No native audio** (fal shows audio in its prompt example but documents no audio parameter). |
| Output | 6 s at 768p or 1080p, or 10 s at 768p; 24 fps. |
| Notable | Legacy status means it may be withdrawn. H3 is what gets updated. |

#### 6. Google Veo 3.1 (7.2), Veo 3.1 Fast (6.9), "Gemini Omni" (lip sync 7.5, removal 7.5)

| Item | Finding |
|---|---|
| Official API | **Yes.** Gemini API (https://ai.google.dev/gemini-api/docs/video) and Vertex AI / Gemini Enterprise Agent Platform (https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate). **Gemini Omni Flash** (GA to developers 2026-06-30; 1.1 preview 2026-08-27) is on the Gemini API and Vertex, and Google now recommends it as the default video model. |
| Official price (https://ai.google.dev/gemini-api/docs/pricing, audio included) | Veo 3.1: 720p/1080p $0.40/s · 4K $0.60/s.<br>Veo 3.1 Fast: 720p $0.10/s · 1080p $0.12/s · 4K $0.30/s.<br>Veo 3.1 Lite: 720p $0.05/s · 1080p $0.08/s.<br>Gemini Omni Flash: $17.50 per 1M video-output tokens, which is ≈ 360p $0.03/s · 720p $0.10/s · 1080p $0.15/s · 4K $0.30/s. No free tier, no batch discount. |
| Third-party hosts | **fal.ai** Veo 3.1 (https://fal.ai/models/fal-ai/veo3.1/reference-to-video): $0.20/s without audio, $0.40/s with (720p/1080p); 4K $0.40 / $0.60. The audio-off option makes it cheaper than Google direct.<br>**MuAPI** (per clip): veo3.1 $2.50, fast $0.60, lite $0.30, reference-to-video $0.60, extend $0.60; gemini-omni t2v/i2v $1.50, video-edit $2.40; omni-flash-1.1 $0.80, reference $1.28. |
| Cheapest found | Veo 3.1 Lite at $0.05/s at 720p (Google). Veo 3.1 Fast at $0.10/s. Omni Flash 360p draft at ~$0.03/s. |
| Inputs | Veo 3.1: text; image; **first + last frame interpolation**; **up to 3 reference images**; **video extension**; negative prompt; seed; native audio (dialogue, SFX). Gemini Omni: any-to-any (text, image, audio, video in), **conversational video editing** (the source of its removal score), scene extension in 10 s steps up to 40 s, first/last frame, a 3 s video reference for character consistency, 4K upscale, 360p draft mode. |
| Output | Veo 3.1: 4, 6 or 8 s; 720p/1080p/4K (4K and 8 s have constraints); 16:9 and 9:16; 24 fps. |
| Notable | SynthID watermark on every output. Person generation is restricted by region (EU/UK stricter). Billed only on success. |

#### 7. Alibaba Wan 2.6 (6.7)

| Item | Finding |
|---|---|
| Official API | **Yes.** Alibaba Cloud Model Studio: `wan2.6-t2v`, `wan2.6-i2v` (+ `-flash`), `wan2.6-r2v` (reference-to-video). Docs: https://www.alibabacloud.com/help/en/model-studio/legacy-image-to-video-api-reference/. Now under "legacy" beside Wan 2.7 and 3.0. Singapore region for international use. |
| Official price | *(secondary; therundown.ai / evolink, Aug 2026)* International: 720p $0.10/s, 1080p $0.15/s (evolink quotes $0.1019/s). Flash is cheaper, especially without sound. Billed per successful second. New Singapore accounts get a 50 s free quota. |
| Third-party hosts | **fal.ai**: $0.10/s at 720p, $0.15/s at 1080p (https://fal.ai/models/wan/v2.6/image-to-video).<br>**MuAPI** (per clip): wan2.6 t2v/i2v $0.65; wan2.7 $0.10 (including reference, edit and extend); wan3.0 $0.50.<br>Also on OpenRouter, EvoLink (~$0.071/s; Flash $0.021–0.069/s), Atlas Cloud. |
| Cheapest found | EvoLink Flash from ~$0.021/s. Wan 2.7 on MuAPI at $0.10 per clip is the newer and cheaper option. |
| Inputs | Text; first frame; reference video (r2v); **audio input (`audio_url`: WAV/MP3, 3–30 s) that drives the video, including lip-sync**, or generated background audio; **multi-shot** (`shot_type`); negative prompt; seed; prompt_extend. |
| Output | 2–15 s; 720p/1080p; 30 fps. |
| Notable | Open-weight lineage (Wan 2.1 and 2.2 are open; 2.6 is API-only). |

#### 8. Lightricks LTX-2 (6.2)

| Item | Finding |
|---|---|
| Official API | **Yes.** LTX API (https://docs.ltx.io, pricing https://docs.ltx.io/pricing). **The `ltx-2-fast` and `ltx-2-pro` IDs were retired on 2026-08-15.** Use `ltx-2-3-*` or `ltx-2-5-*`. The weights are open (LTX-2 19B, LTX-2.3) and can be self-hosted. |
| Official price (per output second, 720p → 4K) | ltx-2-3-fast $0.03–0.24 · ltx-2-3-pro $0.04–0.32 · ltx-2-5-fast $0.09 (720p) / $0.13 (1080p) / $0.19 (1440p) / $0.30 (4K) · ltx-2-5-pro $0.12 / $0.17 / $0.25 / $0.39.<br>Audio-to-video (2-3-pro) $0.06–0.34/s. Retake (edit) and extend (2-3-pro) $0.10/s. HDR upscale $0.20–0.80/s. Reframe $0.10–0.20/s. No request fees. |
| Third-party hosts | **MuAPI** (per clip): ltx-2-19b $0.60, ltx-2-fast/pro $0.46, **ltx-2.3 $0.104** (t2v/i2v/extend), ltx-2.3-lipsync $0.26, ltx-2.5 $0.65. Also fal, WaveSpeed and Replicate (open weights). |
| Cheapest found | ltx-2-3-fast at $0.03/s at 720p (official). Self-hosting is free apart from GPU. |
| Inputs | Text; image; **audio-to-video (lip-sync)**; retake (regenerate a section of a video); extend; native audio out. |
| Output | Up to 4K (2160p), up to 50 fps on Pro. Portrait and landscape are priced the same. |
| Notable | The only open-weights model in the list with native audio. The cheapest 4K. |

#### 9. Moonvalley Marey (3.2)

| Item | Finding |
|---|---|
| Official API | **Waitlist only** ("PUBLIC API waitlist", https://www.moonvalley.com/api). Enterprise access through "Partner with us". Also usable through ComfyUI. |
| Third-party hosts | **fal.ai** (official partner): Marey Realism v1.5, t2v and i2v (https://fal.ai/models/moonvalley/marey/i2v) plus motion-transfer (v2v). Other fal endpoints (pose transfer, camera control) are referenced but not verified here. |
| Price | fal: **$1.50 per 5 s, $3.00 per 10 s ($0.30/s)**. Official direct: not found. |
| Inputs | Text (50+ word prompts recommended); first-frame image; motion transfer (video to video); seed; negative prompt; dimensions. No native audio. |
| Output | 5 s or 10 s; 1080p. |
| Notable | **Trained only on licensed data and marketed as "commercially safe".** Its lowest score is on quality, but it is the strongest rights story here. |

#### 10. OpenAI Sora 2 ("Disqualified") and Sora 1 (1.6)

| Item | Finding |
|---|---|
| Official API | **No: shut down.** OpenAI notified developers on 2026-03-24, and the Videos API with `sora-2`, `sora-2-pro` and every snapshot was **removed on 2026-09-24** with no replacement listed (https://developers.openai.com/api/docs/deprecations). The consumer Sora app closed 2026-04-26. |
| Third-party hosts | MuAPI's 2026-08-31 catalogue still listed openai-sora-2 ($0.80), sora-2-pro ($2.40) and openai-sora ($0.50). These almost certainly proxied OpenAI and are now dead. Not usable. |
| Notable | Do not build on it. |

---

#### Sources
1. Gemini API pricing, https://ai.google.dev/gemini-api/docs/pricing: Veo 3.1, Fast and Lite per-second rates, audio included; Omni Flash at $17.50/M video tokens.
2. Gemini API video docs, https://ai.google.dev/gemini-api/docs/video: Veo 3.1 inputs; Google recommends Omni Flash as the default.
3. Vertex AI reference-image docs, https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/use-reference-images-to-guide-video-generation: up to 3 reference images; 4/6/8 s; 720p/1080p/4K.
4. eesel / atlascloud on Gemini Omni Flash pricing (https://www.eesel.ai/blog/gemini-omni-1-1-flash-pricing): per-resolution list prices, launch dates, 40 s extension.
5. fal Veo 3.1, https://fal.ai/models/fal-ai/veo3.1/reference-to-video: $0.20 without audio, $0.40 with.
6. OpenAI deprecations, https://developers.openai.com/api/docs/deprecations: Sora 2 removed 2026-09-24, no replacement.
7. fal Seedance 2.0, https://fal.ai/models/bytedance/seedance-2.0/image-to-video: per-second tiers, parameters, token formula.
8. Replicate Seedance 2.0, https://replicate.com/bytedance/seedance-2.0: 9 images, 3 videos and 3 audio files; native audio; lip sync.
9. anikuku, https://anikuku.com/blog/seedance-2-api-pricing-guide-2026: BytePlus per-second table (verified 2026-09-04).
10. cellcog, https://cellcog.ai/blog/seedance-2-5-pricing/: ModelArk token basis, Volcengine ¥ rates, reseller comparison (2026-08-22).
11. ofox, https://ofox.ai/blog/seedance-api-guide-tiers-pricing-2026/: failure modes (aspect-ratio 400, 24 h URLs, cannot cancel).
12. aividpipeline / laozhang, https://aividpipeline.com/blog/seedance-real-human-face-rules-2026: the real-face refusal and its error code.
13. OpenRouter Seedance 1.5 Pro, https://openrouter.ai/bytedance/seedance-1-5-pro: token rates with and without audio. fal 1.5 Pro: https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video.
14. costbench, https://costbench.com/software/ai-media-apis/kling-api/: Kling official units and packages (2026-08-18). atlascloud, https://www.atlascloud.ai/blog/tips/kling-ai-api-pricing: corroborates.
15. fal Kling v3 Pro, O3 reference, 2.6 Pro and 2.5 Turbo pages (fal.ai/models/fal-ai/kling-video/...): per-second prices and parameters.
16. Luma Agents pricing, https://docs.agents.lumalabs.ai/guides/pricing: full Ray 3.2 price sheet. Models page: https://docs.agents.lumalabs.ai/guides/model. Launch post: https://lumalabs.ai/news/introducing-ray-3-2.
17. MiniMax pay-as-you-go, https://platform.minimax.io/docs/guides/pricing-paygo: legacy Hailuo 2.3/02 per-video prices; H3 per second. Packages: https://platform.minimax.io/docs/guides/pricing-video.
18. fal Hailuo 2.3 Pro, https://fal.ai/models/fal-ai/minimax/hailuo-2.3/pro/image-to-video: $0.49 per video.
19. Alibaba wan2.6 i2v API reference, https://www.alibabacloud.com/help/en/model-studio/legacy-image-to-video-api-reference/: audio_url, shot_type, 2–15 s, seed.
20. fal Wan 2.6, https://fal.ai/models/wan/v2.6/image-to-video: $0.10/$0.15 per second. evolink, https://evolink.ai/blog/wan-api-pricing-guide: official reference rate $0.1019/s.
21. LTX pricing, https://docs.ltx.io/pricing: every model and endpoint rate; ltx-2 IDs retired 2026-08-15.
22. fal Happy Horse, https://fal.ai/models/alibaba/happy-horse/image-to-video: $0.14/$0.28 per second; lip-sync languages. Alibaba HappyHorse API refs: https://www.alibabacloud.com/help/en/model-studio/happyhorse-reference-to-video-api-reference.
23. Moonvalley API page, https://www.moonvalley.com/api: public API is waitlist-only. fal Marey, https://fal.ai/models/moonvalley/marey/i2v: $1.50 per 5 s.
24. MuAPI catalogue snapshot (repo, `backend/tests/fixtures/muapi-contract.json`, source https://api.muapi.ai/api/v1/models, 2026-08-31): unitless per-clip costs for every model above.

Not found: official Kling 2.6 / 2.5 Turbo unit rates; readable BytePlus pricing page (JS-rendered, so secondary sources were used); official Marey direct pricing; Ray 3 (non-3.2) API pricing.

### Research B: AI video, lip-sync, VFX and performance tools (curiousrefuge scores)

Researched 2026-09-29. Prices are as the page showed on that date. "Not found" means the price does not appear on any page listed under "Looked". Where a figure comes from a third-party blog rather than the vendor, the table says so.

---

#### 1. Runway: Gen-4.5 (6.2), Gen-4 (4.3), Aleph / Aleph 2.0 (inpaint 7.5, removal 6), Act-Two (lip sync 5, performance 5), background removal (6)

| | |
|---|---|
| Official API | **Yes, self-serve.** Runway Dev API, docs.dev.runwayml.com, base `api.dev.runwayml.com/v1`. Endpoints: image_to_video, text_to_video, video_to_video (Aleph 2), character_performance (Act-Two), video upscale, SDR→HDR, frame-rate, TTS/STS/dubbing, avatars, workflows, and a Model Router. |
| Third-party hosts | MuAPI (muapi.ai/runway): text-to-video $0.09/request, image-to-video $0.15/request, Act-Two i2v $0.07/request, Act-Two v2v $0.30/request, Aleph v2v $0.20/request (clip length not stated). Pixazo: Gen-4.5 $0.12/s, Aleph 2 $0.336/s. WaveSpeed: Gen-4 Aleph $0.18/s (older model). Replicate: runwayml/aleph-2 (early access, price not shown on page). Also RunComfy, Runware, AIMLAPI, CometAPI, Freepik API, EachLabs. **fal.ai does not list Runway.** useapi.net is an unofficial web-app proxy. |
| API price (official, $0.01/credit) | Gen-4.5: 12 cr/s = **$0.12/s**. gen4_turbo: 5 cr/s = $0.05/s. **Aleph 2.0 (`aleph2`): 28 cr/s = $0.28/s, minimum 56 cr ($0.56) per generation.** Act-Two: 5 cr/s = **$0.05/s**. ProRes/PNG output +5 cr/s. 10-bit/HDR +20 cr/s (+40 at 4K). Video upscale $0.007–0.012/frame. Also resells wan3 (5–20 cr/s), seedance2/2_5, grok_imagine, gemini_omni_flash. |
| Subscription (app) | Free $0 (125 one-time credits); Standard $12/mo annual ($15 monthly), 625 cr; Pro $28 ($35), 2,250 cr; Max $76 ($95), 9,500 cr. App rates: Gen-4.5 60 cr/5 s, Aleph 2.0 140 cr/5 s. **App credits do not buy API usage**, which is billed separately. |
| Flexibility | Gen-4.5: text or image input, 2–10 s (5 and 10 s on hosts), several ratios, professional output formats. **Aleph 2 (video-to-video): input clip 2–30 s at ≤30 fps and under 16 MB (Replicate), output keeps the input resolution up to 1080p, up to 5 keyframe images placed at first, last or a timestamp.** Edits include add/remove objects, relight, restyle, change the environment, and multi-shot consistency. This is the strongest general in-context edit and removal API in the set. Act-Two: driving performance video 3–30 s plus a character image or video; controls body_control, expression_intensity 1–5, ratio, seed. It covers face and body transfer and is also the lip-sync path, since the driver's mouth is transferred. **Gen-4 (non-turbo) video: not offered in the API**; only gen4_turbo is. Gen-4 Aleph (v1) was deprecated on 30 July 2026 and replaced by aleph2. **Background removal / green screen: an app tool only, with no API endpoint found.** |
| Automation | Async tasks with polling. Usage tiers 1–5: concurrency 1–2 → 20, daily generations 50–200 → 25–30k, monthly spend caps $100 → $100k. Tiers rise automatically with spend. No requests-per-minute limit; tasks over the concurrency limit are queued as THROTTLED. |
| Terms | Paid output is commercial and unwatermarked. The API tier caps limit volume at first. |

#### 2. Midjourney Video (5.0)

| | |
|---|---|
| Official API | **No.** Available only through a subscription in the web app or Discord. |
| Third-party | No reliable host found. PiAPI says it does not serve Midjourney; useapi.net has dropped Midjourney. Unofficial proxies automate a user's account and break Midjourney's ToS, so they are a ban risk. |
| Price | Basic $10, Standard $30, Pro $60, Mega $120 per month (20% off annual). Fast GPU hours: 3.3 / 15 / 30 / 60. Video costs about 8× an image job. SD batch of 4 = 8 GPU-min (1 video = 2 min); HD batch of 4 = 26 GPU-min. Unlimited Relax SD video only on Pro and Mega. |
| Flexibility | Image-to-video (animate a start frame), 480p SD or 720p HD (HD in Fast mode only). A 5 s clip can be extended 4 s at a time, up to 21 s. No reference video, no audio, no editing ops. **Not automatable.** |
| Terms | A company with more than $1M in gross revenue must be on Pro or Mega. Stealth mode on Pro and Mega only. |

#### 3. Adobe Firefly Video (4.2)

| | |
|---|---|
| Official API | **Enterprise only.** Firefly Services API (developer.adobe.com/firefly-services/docs/firefly-api/api/), video via `generateVideoV3`. No self-serve signup; access is through an Adobe Sales contract. There is also a Translate & Lip Sync API (enterprise). |
| Third-party | None found. Firefly's own app instead *hosts* partner models (Kling 3.0, Runway Gen-4.5, Veo 3.1, Sora 2, Ray3.14…). |
| Price | **API: no public rate card.** The only figure found is a community report of about $1,000/mo minimum commitment (sudomock blog, unverified). Consumer plans: $9.99/mo (2,000 credits) to Premium $199.99/mo (50,000 credits, unlimited Firefly Video model). About 50 credits per 5 s Standard clip (third-party). |
| Flexibility | Text or image (keyframes) to video, 5 s clips, 1080p, camera controls. |
| Terms | Adobe's "commercially safe" positioning (trained on licensed data) is the main selling point, and IP indemnity is available at enterprise level. |

#### 4. Higgsfield (3.7 video; 7.4 aggregator)

| | |
|---|---|
| Official API | **Yes, self-serve.** "Open Higgsfield" at cloud.higgsfield.ai, docs.higgsfield.ai. One key covers 82 catalogue entries as of 22 Sep 2026: 66 video (Seedance, Kling, Wan, Happy Horse, Cinema Studio, MiniMax, LTX, PixVerse, Grok, Genjutsu motion transfer) and 16 image (Soul 2, Soul Cinema, Soul ID training, DoP, Recraft, Qwen, Ideogram, Z-Image). |
| Third-party | Not needed; it is itself an aggregator. |
| Price | Pay-as-you-go USD balance, $5 minimum top-up, per-second video pricing, failed requests free, automatic volume discounts. **The per-model rate table (open.higgsfield.ai/pricing) renders client-side, so exact rates were not found.** Third-party test figures (MindStudio, 18 Sep 2026): Seedance 2.5 with audio about $3.23/clip, Kling 3.0 about $0.60, MiniMax about $1.10, video-only $0.20–1.60/clip. Subscription: Basic $9/mo (120 cr), Pro $23 annual / $29 monthly (300 cr), Max $59 / $79 (900 cr). |
| Flexibility | Breadth is the value, plus Higgsfield's own camera-move presets (DoP), character-consistency Soul ID, and Genjutsu (motion transfer from a video to a reference image). Async with webhooks. |
| Terms | The API is separate from the web plans. |

#### 5. Pika Labs (1.5 video; lip sync 3.5)

| | |
|---|---|
| Official API | **Yes, self-serve.** Pika Dev (dev.pika.art, catalog at `api.dev.pika.art/catalog/apis`). It has become an aggregator: it sells Pika's own models plus Kling, Veo, Seedance, Hailuo, FLUX 3 Video, HappyHorse, ElevenLabs, Sync and more. |
| Third-party | fal.ai: Pika v2.2 t2v/i2v $0.20 per 5 s at 720p, $0.45 at 1080p; Pikaframes $0.04/s at 720p, $0.06/s at 1080p (5 s minimum); Pikascenes also listed. |
| API price (Pika catalog) | Pika 2.5 t2v/i2v: **$0.04/s at 720p, $0.09/s at 1080p**. Pika 2.5 Keyframe $0.04/$0.06 per s. **Pikadditions $0.03/request, Pikaswaps $0.03/request**, Pikaffects $0.05/request. Lip sync in the catalog is resold third-party: Sync lipsync-2 $3.15/min, lipsync-2-pro $5.229/min, sync-3 $8.379/min, Kling lipsync $0.012/s, Kling Avatar v2 $0.045–0.09/s. **Pikaformance (Pika's own lip sync) is not in the API catalog.** |
| Subscription | Free (80 cr); Standard $8/mo annual (~$10 monthly) with 700 cr; Pro $28 (~$35) with 2,300 cr; Fancy $76 (~$95) with 6,000 cr. 1080p 5 s = 40 cr. Pikaformance 3 cr/s (third-party blogs). |
| Flexibility | Text/image to video, keyframe interpolation, insert an object into real video (Pikadditions), swap an object in a region (Pikaswaps), effects. Cheap per call; quality is scored low. |
| Terms | **App commercial use on Pro and Fancy only.** |

#### 6. Leonardo (2.25 video; 5.8 aggregator)

| | |
|---|---|
| Official API | **Yes, self-serve.** Leonardo Production API (docs.leonardo.ai), `POST /api/rest/v1/generations-text-to-video` and image-to-video. Models: Motion 2.0, Motion 2.0 Fast (`MOTION2FAST`), plus hosted partner video models. |
| Third-party | WaveSpeed: leonardoai/motion-2.0 "starts at $0.30 per run". |
| Price | The API is now pay-as-you-go (balances never expire, auto top-up, custom deals at volume). **The official per-model video cost sits behind a logged-in pricing calculator: not found.** Older API plan figures ($9 = 3,500 cr, $49 = 25k, $299 = 200k) come from third-party pages and may be retired. leonardo.ai/pricing returned 403. |
| Flexibility | Text/image to video, frame interpolation, "elements" (LoRA-like style). No video editing and no lip sync. |
| Terms | Paid output is commercial. |

#### 7. Domo AI (1.5)

| | |
|---|---|
| Official API | **Enterprise only.** DomoAI Enterprise API (domoapi.com/api). Routes: text-to-video, image-to-video, template-to-video, talking-avatar, video-to-video (anime/illustration restyle, with prompt, duration and callback), plus upscale and background removal/replace. |
| Third-party | None found. |
| Price | **API: quote only, not found.** App: Basic $9/mo annual ($13 monthly) with 600 cr ($0.015/cr); Standard $29/$42 with 2,200 cr (unlimited Relax); Pro $99/$142 with 8,000 cr (20–30 s clips, 60 s avatars); Team $142/seat with 24k cr. |
| Flexibility | Strength is stylising real footage (video-to-anime), which a style pass could use. Its generation models are mostly resold (Seedance 2.5, GPT Image). |
| Terms | Paid plans are watermark-free. Concurrency, retention and error billing are all in the enterprise contract. |

#### 8. HeyGen AI Studio (lip sync 7)

| | |
|---|---|
| Official API | **Yes, self-serve.** developers.heygen.com, `api.heygen.com` with the `X-Api-Key` header. Also a CLI and an MCP server. Products: Video Agent, Avatar video (Avatar III/IV/V), Photo Avatar (Avatar IV from one photo), Video Translation with lip sync (Speed/Precision, 30+ languages), TTS, voice clone, HyperFrames. v1/v2 supported until 31 Oct 2026. |
| Third-party | fal.ai: Digital Twin v3/v4, Video Agent, Precision Translate, Speed Translate, Avatar IV image-to-video (price not on the announcement page). |
| API price (official enterprise page, 1 credit = $0.50 self-serve) | Photo Avatar (Avatar IV) 0.1 cr/s = **$0.05/s ($3/min)**. Digital Twin / Studio Avatar (Avatar III) 0.0167 cr/s = **$0.0083/s ($0.50/min)**. **Translation Speed with lip sync 0.05 cr/s = $0.025/s ($1.50/min); Precision with lip sync 0.1 cr/s = $0.05/s ($3/min)**; Speed audio-only $0.025/s. Video Agent 0.0667 cr/s = $0.033/s. HyperFrames $0.05/min at 1080p30, $0.15/min at 4K60. Pay-as-you-go wallet from $5; credits expire after 12 months; no free API credits since Feb 2026. |
| Flexibility | **Lip-syncs an existing video to new audio or a new language** (translation), animates avatars from a photo, 10 concurrent videos, webhooks. Built for talking heads, not cinematic performance. |
| Terms | The API is separate from the web plans. Rate limits answer 429. |

#### 9. Synthesia (lip sync 8.7)

| | |
|---|---|
| Official API | **Yes, but plan-gated.** docs.synthesia.io, covering the Video API, Upload API (V2) and Dubbing API. API access starts at the **Creator** plan. The **Dubbing API (lip-sync of your own footage) is an Enterprise paid add-on.** |
| Third-party | None found. |
| Price | Starter $18/mo annual ($29 monthly), 120 min/yr; **Creator $64/mo annual ($89 monthly), 360 min/yr, API included**; Enterprise custom (unlimited minutes, higher API rate limits). Lip-synced dubbing uses 2× credits. No per-second API rate is published. |
| Flexibility | Avatar presenter videos (180+ stock avatars, personal avatars), dubbing of any uploaded video (mp4/mov/webm, ≤5 GB, ≤2.5 h, ≤4K) in 160+ languages. Highest lip-sync score, but corporate presenter style; the feature that suits a film (dubbing real footage) is enterprise-only. |
| Terms | Strict content moderation, and avatar consent rules for custom avatars. |

#### 10. Akool (face swap 6.5)

| | |
|---|---|
| Official API | **Yes.** AKOOL Open API (akool.com/openapi): face swap (image and video), talking photo, talking avatar, lip sync, video translation, streaming avatar, image generation. |
| Third-party | WaveSpeed (Akool video face swap, "$0.05 per video second, 10 s minimum" per a third-party citation; the WaveSpeed doc URL now 404s). |
| Price | API credit costs (akool.com/api-pricing): **video face swap 10 cr / 10 s (1 cr/s)**, image face swap 4 cr, **LipSync API 10 cr / 10 s**, talking photo 10 cr / 5 s, talking avatar 5 cr / 10 s at 1080p (10 at 4K), translation 1 cr / 5 s (promo). Plan prices on that page rendered as $0; third-party figures give Pro Max $59/mo with 1,200 cr (~$0.049/cr) and Business $249/mo with 6,000 cr (~$0.042/cr), so **face swap ≈ $0.04–0.05/s**. Enterprise custom. API concurrency: Pro Max 3, Business 5, Enterprise 10. |
| Flexibility | Face swap onto existing footage (multi-face), lip sync to audio, translation. Async with webhooks. |
| Terms | Subscription credits expire at renewal. Face swap needs consent under the ToS. |

#### 11. ComfyUI (face swap 6)

| | |
|---|---|
| Official API | Open source and self-hostable (free, GPL). **Comfy Cloud** (comfy.org/pricing) includes API access on every paid plan. **API Nodes** inside ComfyUI call partner models (Runway, Kling, Veo, etc.) billed in Comfy credits. |
| Cloud hosts | Comfy Cloud: Standard $20/mo ($192/yr), 50,400 cr/yr; Creator $35 ($336/yr), 88,800 cr/yr, custom models; Pro $100 ($960/yr), 253,200 cr/yr, 1 h max workflow; Team $200–2,500. Billed per active GPU-second (~0.266 cr/s) on RTX 6000 Pro 96 GB; 30 min max run below Pro. **RunComfy Serverless API**: per-second billing, $0.99/h (T4/A4000) to $7.49/h (H100) pay-as-you-go, Pro 20–30% off ($5.99/h H100); cold start and keep-warm are billed, queue time is not. **Comfy Deploy**: open source plus hosted pay-as-you-go; **no durable public price table found.** Also comfy.icu, RunPod and Modal (DIY). |
| Flexibility | **Maximum.** Any open model or workflow: face swap (ReActor/InsightFace; licence caveats), Wan/LTX/HunyuanVideo, lip sync (LatentSync, MuseTalk), mattes (SAM2, BiRefNet), relight, upscale. Workflows are exported as API JSON. Film Engine already has a ComfyUI epic. |
| Terms | Model licences vary: InsightFace is non-commercial, and some checkpoints restrict commercial use. |

#### 12. Move AI (performance capture 7.25)

| | |
|---|---|
| Official API | **Yes.** Move API (developers.move.ai). Price per second = base_rate × fps × resolution × camera multipliers (the pricing page now 404s, so base rates were not found). Move One (single-camera app) and Move Pro / Genesis (multi-camera, enterprise quote; GPU about $3k plus cameras). |
| Third-party | None. |
| Price | Move One: Starter $18/mo (60 cr), Standard $48 (180 cr), Plus $225 (240 cr), Advanced $490 (700 cr), plus VAT. Free: 30 one-time cr. **Gen 1: 1 cr per person per second; Gen 2: 2 cr per person per second** (Gen 2 on Advanced and above). Extra credits $0.0067 each (third-party citation). Paid users can record 60 s clips. |
| Flexibility | Output is FBX/BVH skeletal animation from ordinary video (single or multi-camera). It produces no rendered video, so it feeds Blender/Unreal/previs rigs, not a generator directly. |
| Terms | Purchased credits need an active subscription. |

#### 13. Autodesk Flow Studio (formerly Wonder Studio) (performance capture 7)

| | |
|---|---|
| Official API | **No public API found.** It is a web app, with exports to Maya, Blender, Unreal and USD. |
| Third-party | None. |
| Price | Free $0 (300 cr, 720p watermarked); Lite $10 monthly / $7 annual (2,100 cr, 1080p); Standard $45 / $30 (6,000 cr, 4K, MetaHuman); Pro $95 / $64 (12,000 cr, Character Pass exports); Enterprise (48,000 cr, AI data opt-out). **AI mocap 10 cr/s; Live Action / Animation 20 cr/s** (as of Apr 2026, third-party); Wonder 3D 20 cr per generation. Credits do not roll over. |
| Flexibility | Live Action puts a CG character into a plate, replacing the actor with automatic lighting and compositing, and outputs clean plate, alpha, camera track and mocap passes. Supports up to 7 performers on Enterprise. The render passes are its unique strength. |
| Terms | Opting out of AI training is Enterprise-only. |

---

#### Summary matrix

| Product | API | Cheapest usable API rate found | Best for |
|---|---|---|---|
| Runway Gen-4.5 | Yes, self-serve | $0.12/s | High-quality i2v/t2v |
| Runway Aleph 2 | Yes | $0.28/s (min $0.56) | In-context edit, removal, relight of real footage, 2–30 s |
| Runway Act-Two | Yes | $0.05/s | Performance transfer and lip sync from a driving video |
| Midjourney Video | No | n/a | Look exploration only |
| Firefly Video | Enterprise | not published | Commercially safe |
| Higgsfield | Yes (aggregator) | not found officially (~$0.20–3.23/clip) | Model breadth |
| Pika | Yes (aggregator) | $0.04/s 720p; $0.03 per additions/swaps call | Cheap object insert and swap |
| Leonardo | Yes | not found (~$0.30/run via WaveSpeed) | Low priority |
| Domo AI | Enterprise | not published | Anime restyle |
| HeyGen | Yes, self-serve | Avatar III $0.0083/s; lip-sync translate $0.025–0.05/s | Lip-sync of existing footage |
| Synthesia | Creator plan+, dubbing Enterprise | $64/mo annual for 360 min/yr | Presenter avatars |
| Akool | Yes | ~$0.04–0.05/s face swap and lip sync | Face swap |
| ComfyUI | Self-host / Comfy Cloud / RunComfy | GPU time ($0.99–7.49/h) | Anything open source |
| Move AI | Yes (Move API) | 1–2 cr per person per second | Mocap to FBX |
| Flow Studio | No | 10–20 cr/s in the app | CG character into a plate, with passes |

---

#### Sources

1. Runway Dev API Pricing: https://docs.dev.runwayml.com/guides/pricing/ ($0.01/credit; gen4.5 12 cr/s, gen4_turbo 5, act_two 5, aleph2 28 cr/s with 56 min; ProRes and HDR surcharges; video upscale per frame).
2. Runway Dev Models: https://docs.dev.runwayml.com/guides/models/ (aleph2, gen4.5, magnific upscalers, ruby HDR, enhance_frame_rate).
3. Runway Dev API reference: https://docs.dev.runwayml.com/api/ (endpoint list: video_to_video, character performance, upscale, avatars, recipes, router).
4. Runway Dev Usage Tiers: https://docs.dev.runwayml.com/usage/tiers/ (tiers 1–5; concurrency, daily limits and spend caps; no RPM limit).
5. Runway app pricing: https://runway.com/pricing (Standard/Pro/Max plans; Aleph 2.0 140 cr/5 s in the app).
6. MuAPI Runway: https://muapi.ai/runway (per-request prices for t2v, i2v, Act-Two, Aleph).
7. Pixazo Runway: https://www.pixazo.ai/models/runway (Gen-4.5 $0.12/s, Aleph 2 $0.336/s).
8. Replicate Aleph 2: https://replicate.com/runwayml/aleph-2 (2–30 s input under 16 MB, 5 keyframes, early access).
9. Aleph 2 search synthesis (atlascloud, runware, therundown): Gen-4 Aleph deprecated 30 Jul 2026; ≤30 fps; resolution kept up to 1080p.
10. Act-Two input docs (useapi, eachlabs, Runway help): driving video 3–30 s, character image or video, body_control, expression_intensity 1–5.
11. Apiframe "Best Runway API providers 2026": https://apiframe.ai/blog/best-runway-api-providers-2026 (fal does not list Runway; WaveSpeed Aleph $0.18/s).
12. Midjourney pricing (eesel, techjacksolutions, toolcolumn): https://www.eesel.ai/blog/midjourney-pricing (no official API; video GPU-minutes; 21 s max; $1M revenue rule).
13. Midjourney API alternatives: https://www.myarchitectai.com/blog/midjourney-apis (PiAPI and useapi no longer serve Midjourney).
14. Firefly API reference: https://developer.adobe.com/firefly-services/docs/firefly-api/api/ (generateVideoV3; enterprise contract).
15. Firefly API pricing blog: https://sudomock.com/blog/adobe-firefly-api-pricing-2026 (no public rate card; ~$1k/mo commitment reported).
16. Higgsfield API: https://higgsfield.ai/blog/higgsfield-api and https://docs.higgsfield.ai/docs/models.md (82 models; $5 minimum pay-as-you-go).
17. MindStudio Higgsfield pricing: https://www.mindstudio.ai/blog/higgsfield-api-pricing-pay-per-use (per-clip test costs, 18 Sep 2026).
18. Higgsfield plans (creatify, layer3labs): Basic $9, Pro $23/$29, Max $59/$79.
19. Pika Dev catalog: https://api.dev.pika.art/catalog/apis (Pika 2.5 $0.04–0.09/s; Pikadditions and Pikaswaps $0.03; resold Sync lip sync).
20. Pika on fal: https://fal.ai/models/fal-ai/pika/v2.2/image-to-video (v2.2 $0.20 per 5 s at 720p).
21. Pika app pricing (eesel, flowith): Standard/Pro/Fancy; Pikaformance 3 cr/s; commercial use Pro and Fancy only.
22. Leonardo PAYG FAQ: https://docs.leonardo.ai/docs/pricing-and-plans-faq (pay-as-you-go, calculator behind login).
23. Leonardo text-to-video docs: https://docs.leonardo.ai/docs/generate-with-motion-2-motion-2-fast-using-text-prompts
24. WaveSpeed Leonardo Motion 2.0: https://wavespeed.ai/models/leonardoai/motion-2.0 (from $0.30/run).
25. DomoAI Enterprise API: https://domoapi.com/api/ (quote only; v2v restyle, background removal).
26. DomoAI pricing: https://www.domoai.app/pricing
27. HeyGen enterprise pricing: https://developers.heygen.com/docs/enterprise-pricing (credit rates; 1 cr = $0.50).
28. HeyGen API pricing explained: https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained (pay-as-you-go, 12-month expiry, 10 concurrent).
29. HeyGen quick start: https://developers.heygen.com/docs/quick-start
30. fal HeyGen: https://blog.fal.ai/heygen-models-are-now-available-on-fal
31. Synthesia pricing: https://www.synthesia.io/pricing (API from Creator).
32. Synthesia dubbing: https://docs.synthesia.io/docs/video-dubbing (Dubbing API; Enterprise add-on; lip sync 2× credits).
33. Akool API pricing: https://akool.com/api-pricing (credits per feature; concurrency).
34. Akool plan prices (vidmetoo, playcut): Pro Max $59 / 1,200 cr, Business $249 / 6,000 cr.
35. Comfy Cloud pricing: https://comfy.org/pricing/ and blog https://blog.comfy.org/p/comfy-cloud-new-features-and-pricing
36. RunComfy billing: https://docs.runcomfy.com/serverless/about-billing
37. Move One pricing: https://docs.move.ai/knowledge/move-one-pricing (Gen1 1 cr/p/s, Gen2 2 cr/p/s).
38. Move AI Genesis: https://www.therundown.ai/tools/move-ai (enterprise quote).
39. Autodesk Flow Studio pricing guide (28 Sep 2026): https://blogs.autodesk.com/media-and-entertainment/2026/09/28/autodesk-flow-studio-pricing-and-subscription-guide/
40. Flow Studio credit rates (search synthesis): AI mocap 10 cr/s, Live Action 20 cr/s.

**Pages that failed:** open.higgsfield.ai/pricing (renders client-side), higgsfield.ai/pricing (metadata only), leonardo.ai/pricing and leonardo.ai/api (403), docs.midjourney.com (403), developers.move.ai/docs/pricing (404), docs.move.ai pricing-plans-credits (404), the Firefly video guide URL (404), and the WaveSpeed Akool doc (404).

### Research C: AI image generation, editing and consistency tools (API availability, pricing, flexibility)

Researched 2026-09-29. Scope: the image tools on curiousrefuge.com/best-ai-tools (scores are given in brackets). Every price below has a source, listed at the bottom. If a price could not be found, the entry says **not found** and names where I looked. Prices are USD per output image unless stated otherwise.

Tags used in the tables:
- **[official]** means the vendor's own page or docs.
- **[3P]** means a third-party host's own page.
- **[secondary]** means a blog or aggregator summarising someone else's price. Treat these as lower confidence.

---

#### 1. GPT Image 2 / "ChatGPT Images 2.0" (OpenAI) [8.92; object removal 8.7; consistent products 7.5, characters 7, styles 8]

| | |
|---|---|
| Official API | **Yes.** Model `gpt-image-2` on the Images API (`/v1/images/generations`, `/v1/images/edits`) and the Responses API. Docs: developers.openai.com/api/docs/guides/image-generation. OpenAI's docs now also list `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare`, which have extra quality levels (xhigh, max). GPT Image 1 is deprecated from 2026-10-23. |
| Token rates [official, via WaveSpeed] | Text input $5.00/1M. Image input $8.00/1M (cached $2.00). Image output $30.00/1M. Batch API is about 50% of these. |
| Per image [official calculator, CostGoat 2026-09-05] | 1024²: low $0.005–0.006, medium $0.053, high $0.211. 1024×1536: low $0.005, medium $0.041, high $0.165. |
| 4K [3P fal] | 1920×1080: low $0.005, medium $0.040, high $0.158. **3840×2160: low $0.012, medium $0.101, high $0.401.** |
| Resellers | fal.ai uses the same prices as OpenAI. Replicate (teamday, 2026-09-23) charges low $0.012, medium $0.047, **high $0.128**, which is the cheapest high tier found. Runway API `gpt_image_2` costs 1–41 credits ($0.01–0.41). MuAPI lists it as "custom quote". apimodels.app claims "from $0.025" [unverified]. |
| Resolution | Custom sizes up to **3840 px on an edge and 8.29 MP total (true 4K)**. Width and height must be multiples of 16, the aspect ratio must fall between 1:3 and 3:1, and the image must be at least 655,360 px. |
| References / editing | Takes several input images. Supports mask inpainting and outpainting (fal). Every reference is processed at high fidelity, so edit-heavy work costs about 2–3× the baseline (WaveSpeed). |
| Other controls | Transparent background (PNG/WebP). `n` for batches. Text rendering is best in class, including CJK. **A seed parameter is not documented.** |
| Terms | C2PA metadata is attached. The output belongs to the user under OpenAI's terms. |

#### 2. Nano Banana 2: Gemini 3.1 Flash Image (Google) [8.82; bg removal 8.7; consistent characters 8]

| | |
|---|---|
| Official API | **Yes.** Model `gemini-3.1-flash-image` on the Gemini API and Vertex AI. Docs: ai.google.dev/gemini-api/docs/image-generation. |
| Official price [ai.google.dev pricing] | Output costs $60/1M image tokens. That works out to **0.5K $0.045, 1K $0.067, 2K $0.101, 4K $0.151**. Batch costs about 50% of standard ($30/1M). There is also a "Nano Banana 2 Lite" (3.1 Flash Lite Image) at about $0.0336 per 1K image. |
| fal.ai | 1K $0.08, 2K $0.12 (×1.5), 4K $0.16 (×2), 512px $0.06. Web search adds $0.015 and high thinking adds $0.002. |
| MuAPI [MuAPI blog 2026-07-18] | **1K $0.06, 2K $0.09, 4K $0.12.** This is the cheapest source found, below Google's own list price. |
| Others | Replicate $0.067 (1K). Runway API `gemini_image3.1_flash` costs 5–16 credits ($0.05–0.16) depending on resolution. |
| Flexibility | 512 / 1K / **2K / 4K**. Aspect ratios 1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. Up to **14 reference images**: 10 objects, 4 characters, 3 styles (Google); fal says consistency holds for up to 5 people. Multi-turn editing, seed, 1–4 images per request (fal). Web-search grounding. Strong text rendering. |
| Terms | Every output carries a SynthID watermark. |

#### 3. Nano Banana Pro: Gemini 3 Pro Image (Google) [8.80]

| | |
|---|---|
| Official API | **Yes.** Model `gemini-3-pro-image` on the Gemini API and Vertex AI. |
| Official price | Output costs $120/1M image tokens: **1K/2K $0.134, 4K $0.24**. Batch/Flex costs $60/1M (half). |
| fal.ai | 1K/2K $0.15, 4K $0.30 ("4K costs double"). |
| MuAPI | **$0.12/image** on the playground page, with 1K/2K/4K selectable. A secondary source says 4K is also discounted there ("4K at $0.134"). Whether MuAPI charges more for 4K is **unconfirmed**. |
| Others | Replicate $0.15 (teamday). Runway API `gemini_image3_pro` costs 20 credits ($0.20) at 1K/2K and 40 credits ($0.40) at 4K. |
| Flexibility | 1K / 2K / **4K**. Aspect ratios from 21:9 to 1:1 and the portrait inverses. Google's docs give reference limits of up to 6 objects, 5 characters and 3 styles (14 total is commonly cited). Reasoning ("thinking"), multi-turn editing, seed, search grounding. Best-in-class infographics and text. |
| Terms | SynthID watermark. fal notes a visible watermark for non-Ultra consumer users; API output carries none. |

#### 4. Nano Banana: Gemini 2.5 Flash Image (Google) [8.77]

| | |
|---|---|
| Official API | Yes, `gemini-2.5-flash-image`. It is **deprecated and shuts down on 2026-10-02.** |
| Price | Standard $0.039/image. Batch $0.0195. Priority $0.0702. Runway API charges 5 credits ($0.05). MuAPI serves it too (no current price captured). |
| Flexibility | About 1 MP (1K) only. Multi-image fusion, SynthID. **Do not build on this model.** |

#### 5. FLUX.2 (Black Forest Labs) [8.78]

| | |
|---|---|
| Official API | **Yes.** BFL API at api.bfl.ai. Docs: docs.bfl.ai/flux_2/flux2_overview. Variants are klein 4B/9B, pro, flex and max. [dev] and klein 9B have open weights under a **non-commercial** licence; klein 4B is Apache 2.0. |
| Official price [docs.bfl.ai] | Billed per megapixel: the first MP costs a flat rate and each additional MP adds to it. **klein 4B from $0.014** (overview: $0.014 + $0.001/MP). klein 9B from $0.015. **pro from $0.03 (T2I) and from $0.045 (edit).** flex from $0.05–0.06/MP. max from $0.07/MP. |
| fal.ai | FLUX.2 [pro]: **$0.03 for the first MP plus $0.015 per extra MP**, counting input and output MP together and rounding up. For example, a 2048×1152 image (2.4 MP) costs about $0.06. [dev] $0.012/MP. [klein] $0.005/MP. [flex] $0.05/MP. |
| Replicate | pro about $0.03. dev $0.014/MP. **klein 4B $0.001/MP**, the cheapest found. |
| MuAPI | FLUX.2 Pro **$0.032**, a single tier. |
| Flexibility | Output up to **4 MP (about 2048×2048); no native 4K**. Up to 8–10 reference images, addressed with `@`. JSON structured prompts, exact hex colours, good typography. [max] has web grounding. Seed is supported. |

#### 6. FLUX.1 Kontext [pro]/[max] (BFL) [object removal 8.7; consistency 5.5]

| | |
|---|---|
| Official API | Yes, on the BFL API. |
| Price | [pro] **$0.04** (4 credits). [max] **$0.08**. Fill [pro] costs $0.05. The price is the same on fal ($0.04). MuAPI charges $0.02–0.06 across dev, pro and max. |
| Flexibility | About 1 MP. Instruction-based local and global editing from one input image; multi-image is experimental. Seed, guidance. Low consistency score, and superseded by FLUX.2 for multi-reference work. |

#### 7. Luma UNI-1 / UNI-1.1 [8.68]

| | |
|---|---|
| Official API | **Yes, since 2026-05-13.** Models `uni-1` and `uni-1-max`. Docs: lumalabs.ai/api and docs.agents.lumalabs.ai/guides/pricing. |
| Price [official, via The Decoder] | `uni-1` **$0.0404/image**. `uni-1-max` **$0.10/image**. Both output a **2048 px** image. Each reference image adds **$0.003** (up to 9). Failed generations are refunded. Provisioned throughput costs $2,100–3,800 per unit per month, with an 8-unit minimum. |
| Third party | Venice.ai lists it. AWS availability is "planned, no date". **No fal, Replicate or MuAPI listing found.** |
| Flexibility | 2K only. Up to 9 reference images. Generation plus editing. An autoregressive model that "thinks" before drawing. |

#### 8. Midjourney v8.1 / v7 [8.63 / 8.62; outpainting 8.25; moodboards 7.5]

| | |
|---|---|
| Official API | **No public API.** The ToS forbid automated access. There is an Enterprise-only API behind an application process (reported late 2025). V8 came out 2026-03-17 with native 2K HD, and V8.1 became the default on 2026-06-10. |
| Third party (unofficial) | MuAPI charges **$0.10 per run, which returns 4 images ($0.025/image)**, for V7, V8 and Niji. It accepts a reference image, stylize, chaos, weird, seed and aspect ratio. Apiframe and PiAPI also offer it (not priced here). |
| Official consumer price | Subscriptions start at $10/month. |
| Terms risk | **High.** Third-party APIs automate accounts in breach of Midjourney's ToS and can be shut off. Not suitable as a production dependency. |

#### 9. Recraft V4 / V4.1 [8.56]

| | |
|---|---|
| Official API | **Yes.** external.api.recraft.ai. 1,000 units cost $1. |
| Official price [recraft.ai/pricing?tab=api] | V4.1 **$0.035**. V4.1 Pro **$0.21**. V4.1 Flash **$0.007**. V4.1 Vector $0.088. Pro Vector $0.33. Image-to-image, inpaint, replace background and generate background $0.044 each. Background removal $0.011. Creative upscale $0.25. Vector operations cost twice the raster price. Older V4 prices from secondary sources: $0.04 raster, $0.25 Pro, $0.08 vector. |
| Third party | fal $0.04. Replicate $0.04. OpenRouter lists the V4 variants. |
| Flexibility | Native **SVG vector** output, which is unique on this list. Style creation. Brand colours. Inpaint. Max resolution: Pro is the high-resolution tier; **exact pixel limit not confirmed.** |

#### 10. Ideogram 3.0 / V4 [8.51]

| | |
|---|---|
| Official API | **Yes.** developer.ideogram.ai. The pricing page loads dynamically and could not be read directly. |
| Price [secondary: puter and Kie, Jun–Sep 2026] | 3.0: Turbo **$0.03**, Default $0.06, Quality $0.09. With a **character reference**: $0.10 / $0.15 / $0.20. V4: Turbo $0.03, Default $0.06, Quality $0.10. fal lists V4 at $0.0075–0.025/MP (teamday). |
| Third party | fal, Replicate, MuAPI (3.0 at **$0.02**, the cheapest found), WaveSpeed (Ideogram Character). V4 has open weights for non-commercial use on Hugging Face. |
| Flexibility | Best-in-class typography. Endpoints for edit (mask), remix, reframe (outpaint), replace background and upscale. Character reference. Default rate limit is 10 in-flight requests. |

#### 11. Imagen 4 (Google) [8.49]

| | |
|---|---|
| Official API | **Vertex AI only.** It was **removed from the Gemini API on Aug 17, 2026** (teamday). |
| Price | Fast **$0.02**, Standard $0.04, Ultra $0.06 per image. MuAPI charges Ultra $0.06. |
| Flexibility | Standard and Ultra go up to 2K (2048²). Up to 4 images per call. No multi-reference editing (that is Nano Banana's job). SynthID. |

#### 12. Z-Image / Z-Image Turbo (Alibaba Tongyi-MAI) [8.49]

| | |
|---|---|
| Official API | Open weights (6B). Alibaba DashScope/Model Studio hosting was **not confirmed**. |
| Third party | fal: **$0.005/MP** for T2I, $0.0085/MP with LoRA, $0.0065/MP with ControlNet, $0.01/MP with ControlNet plus LoRA. Prompt expansion adds $0.0025. PiAPI, Lumenfall and Replicate host it too. The awesome-ai-image-models list puts it at about $0.007/image. |
| Flexibility | Up to **4 MP**. 1–4 images per request. Seed. Image-to-image, ControlNet, LoRA. Strong bilingual text (per model card). Commercial use is permitted on fal. |

#### 13. Seedream 5.0 / 5.0 Lite (ByteDance) [8.44; consistency 6–6.5]

| | |
|---|---|
| Official API | **Yes.** BytePlus ModelArk (international) and Volcano Engine (China). Docs: docs.byteplus.com/en/docs/ModelArk/1541523. |
| Official price | Lite **$0.035**. Pro **$0.045**. 5.0 Flash **$0.018** (BytePlus, via teamday). |
| Third party | fal: Lite $0.035, Pro $0.0675 (marked tentative). Replicate: Lite $0.035, Pro $0.045. MuAPI: Pro **$0.045 (1K) / $0.09 (2K)**; secondary says Pro reaches $0.06. EmpirioLabs: Pro $0.075 up to 2.61 MP, $0.15 above. Runway API: `seedream5_lite` 4 credits ($0.04); `seedream5_pro` 5 credits ($0.05) at 1K and 9 credits ($0.09) at 2K. |
| Flexibility | Lite goes up to **3072×3072** and returns 1–6 images per call (fal). Pro is native 2K with 4K via its pipeline and batches of 4. Reference images: **Lite up to 14, Pro up to 10**. Web search, a reasoning pass, multilingual text (Pro). Content filter can be disabled. |

#### 14. Soul (Higgsfield) [8.25]

| | |
|---|---|
| Official API | **Yes.** The Higgsfield API is pay-per-generation in USD with no subscription. Docs: open.higgsfield.ai and the Help Center "What is the Higgsfield API". |
| Price | Soul Standard: **$0.0938 at 720p, $0.1875 at 1080p** (official playground). Soul 2 and Soul Cinema: "**$0.0032/image**" (official blog); a secondary source puts Soul 2 at 1K at $0.009. The Soul 2 figure is a "from" price and looks anomalously low, so **verify it before relying on it.** |
| Flexibility | 720p/1080p (Standard). Aspect ratios, batch size, seed, style presets, character reference (Soul ID). The API also resells Seedance, Kling, Wan, MiniMax, Recraft, Ideogram and Grok. |

#### 15. Reve (Reve Image 2.x) [8.29]

| | |
|---|---|
| Official API | **Yes.** api.reve.com, bought in credits: $10 buys 7,500 credits (about $1.33 per 1,000). |
| Price [secondary: eesel, launch 2026-07-09] | v2 Create or Edit: 150 credits (**about $0.20**). v2 Analyze or Render: about $0.11. Legacy Create: 18 credits (**about $0.024**). Legacy Edit: about $0.04. Fast Edit or Remix: **about $0.007**. Daily ceiling $1,000. |
| Third party | MuAPI **$0.032**. Atlas Cloud, AIMLAPI, eachlabs and Pixazo list it; Reve 1.0 from $0.04. |
| Flexibility | Native **4K** (v2). Layout-first planning. Reference images through the API. Create, edit and remix modes. |

#### 16. Kling Image (Kling O3 / Omni 3 image) [8.25]

| | |
|---|---|
| Official API | Kling developer platform (kling.ai/dev). The pricing page requires a login, so the **official per-image price was not found**. |
| Third party | fal `fal-ai/kling-image/o3`: **$0.028 per image at 1K/2K, $0.056 at 4K**. PoYo and MindStudio also host it. |
| Flexibility | 1K/2K/**4K**. Aspect ratios, several images per call, character/element reference images, seed, image-to-image. |

#### 17. Leonardo Lucid Origin [8.20]

| | |
|---|---|
| Official API | **Yes.** Leonardo Production API, pay-as-you-go, with $5 of free credit. |
| Price | **Not found.** Leonardo does not publish per-model API rates (checked leonardo.ai/pricing and /api, eesel, and Puter, which lists "N/A"). Secondary sources estimate about $0.01–0.014/image on a token basis. Unlimited relaxed generation on paid app plans does not apply to the API. |
| Flexibility | Full HD (about 1080p) renders. Good text. Leonardo's platform adds Character Reference, Style Reference, Canvas inpaint and outpaint, and an upscaler (not re-verified per model). |

#### 18. Runway image (Gen-4 Image) [7.96]

| | |
|---|---|
| Official API | **Yes.** Runway API with `gen4_image`, `gen4_image_turbo` and `muse_image`. Credits cost $0.01, with a $10 minimum. |
| Price [docs.dev.runwayml.com] | gen4_image **5 credits ($0.05) at 720p, 8 ($0.08) at 1080p**. Turbo **2 credits ($0.02)**. muse_image 1 credit ($0.01). |
| Also resells | grok_imagine_image_2 (4–8 credits), seedream5_pro (5/9), seedream5_lite (4), gemini_image3_pro (20/40), gemini_image3.1_flash (5–16), gpt_image_2 (1–41), gpt_image_2_5 (1–76 plus reference fees), gemini_2.5_flash (5). |
| Flexibility | Maximum 1080p (1920×1080). Up to **3 tagged references** (`@tag`). **No inpainting.** Seed is supported. |

#### 19. Stable Diffusion (Stability AI) [5.5]

| | |
|---|---|
| Official API | **Yes.** platform.stability.ai. 1 credit costs $0.01 and new accounts get 25 free credits. |
| Price [secondary: Fastio, puter; the official page did not render] | SD 3.5 Large **6.5 credits ($0.065)**. Stable Image Ultra **8 credits ($0.08)**. Core about $0.03 (not re-verified). Edit endpoints (inpaint, outpaint, erase, search & replace, remove background, upscale) are listed; **their per-call prices were not captured.** |
| Third party | Open weights are served by fal, Replicate and others. |
| Flexibility | About 1 MP. Full editing suite: inpaint, outpaint, erase, search & replace. Seed. LoRA/ControlNet with open weights. Stability's community licence is free under $1M annual revenue. |

#### 20. Krea / Krea 2 [outpainting 7.5, styles 7]

| | |
|---|---|
| Official API | **Yes.** api.krea.ai. Billed in dollars per generation, separately from app subscriptions. |
| Price [official Krea blog] | Krea 2 Medium **$0.030** ($0.035 with style references, $0.040 with a moodboard). Large **$0.060** ($0.065 / $0.070). |
| Flexibility | **1K only.** Aspect ratios 1:1, 4:3, 3:2, 16:9, 2.35:1, 4:5, 2:3, 9:16. Several style references with individual strengths. One moodboard per generation. Creativity dial. Async jobs with webhooks. The Krea API also serves third-party models and upscalers; the pricing page failed to load (header overflow), so those prices were **not found**. |

#### 21. Photoshop / Adobe Firefly [8/10]

| | |
|---|---|
| Official API | **Enterprise only.** Firefly Services (Firefly API v2 plus the Photoshop API) at developer.adobe.com/firefly-services. |
| Price | **No public rate card.** Metered in "operations" under an Enterprise contract, with the rate card private in the Admin Console (Adobe shared-credit terms, effective 2026-04-09). Community reports put it at about $0.02–0.10/image with a starting commitment of about $1,000/month. The v1 API was about $0.15 per call and reaches end of life on 2026-07-31. |
| Flexibility | Generative Fill and Expand, reference images, style and structure references, Photoshop API edits (remove background, masks, actions). |
| Terms | Adobe's indemnified and commercially safe positioning is the main selling point. |

#### 22. Canva (Magic Media) [6.5]

| | |
|---|---|
| Official API | **No.** The Canva Connect API covers assets, designs, autofill, export and similar, with **no text-to-image endpoint**. Magic Media is available in the editor only. |
| Price | Not applicable: subscription only. |

#### 23. GFPGAN (face restoration) [7.25]

| | |
|---|---|
| Official API | Open source from TencentARC (Apache 2.0). No vendor API. |
| Third party | Replicate `tencentarc/gfpgan`: **about $0.0035 per run** (285 runs per $1). Synexa also hosts it. |
| Flexibility | Face restoration and upscaling (v1.3/1.4, scale 2–4×). Not generative editing. |

#### 24. FaceApp [5]

| | |
|---|---|
| Official API | **No public API found.** A consumer mobile app only. **Not usable in a pipeline.** |

---

#### Cross-cutting comparison

**Most flexible (resolution, references, editing, text):**
1. **Nano Banana Pro:** 4K, up to 14 references (6 objects / 5 people / 3 styles), multi-turn editing, seed, grounding, text.
2. **Nano Banana 2:** the same feature set at lower cost, plus 512px. 4K.
3. **GPT Image 2:** true custom 4K up to 3840 px, mask inpaint and outpaint, transparency, best text. No seed, and edits are expensive.
4. **Seedream 5.0:** up to 14 references on Lite, batches of 4–6, 3K on Lite and 4K on Pro, cheap.
5. **FLUX.2:** up to 10 references, hex colours, JSON prompts, but capped at 4 MP.

**Price at about 2K (cheapest source found):**

| Model | Price | Source |
|---|---|---|
| Z-Image Turbo, 4 MP | about $0.02 | fal, $0.005/MP |
| Kling O3 | $0.028 | fal |
| Seedream 5.0 Lite, up to 3K | $0.035 | BytePlus, fal, Replicate |
| Luma UNI-1, 2048 px | $0.0404 | Luma |
| FLUX.2 pro, about 2.4 MP | about $0.06 | fal |
| Nano Banana 2 | **$0.09** | MuAPI (Google list price $0.101) |
| Seedream 5.0 Pro | $0.09 | MuAPI and Runway |
| Nano Banana Pro | $0.12 | MuAPI (Google list price $0.134) |
| GPT Image 2 at 1920×1080 | $0.04 medium, $0.158 high | fal |

**Price at 4K:**

| Model | Price | Source |
|---|---|---|
| Kling O3 | $0.056 | fal |
| Nano Banana 2 | **$0.12** | MuAPI (Google $0.151, fal $0.16) |
| Nano Banana Pro | $0.12–0.134 | MuAPI (unconfirmed whether 4K costs extra); Google $0.24, fal $0.30, Runway $0.40 |
| GPT Image 2 at 3840×2160 | $0.101 medium, $0.401 high | fal |
| Reve v2 | about $0.20 | Reve |
| FLUX.2 | not available (4 MP cap) | |
| Seedream 5.0 Pro | about $0.15 above 2.61 MP | EmpirioLabs |

**No usable API:** Midjourney (unofficial resellers only, and the ToS forbid it), Canva, FaceApp. Adobe Firefly is enterprise only with no public price. Leonardo's per-model prices are not published.

---

#### Sources

1. **Gemini Developer API pricing** — https://ai.google.dev/gemini-api/docs/pricing
   Gives Nano Banana 2 per-resolution prices, Pro at $0.134 (1K/2K) and $0.24 (4K), and the 2.5 Flash Image deprecation on 2026-10-02.
2. **Gemini image generation docs** — https://ai.google.dev/gemini-api/docs/image-generation
   Gives reference-image limits, aspect ratios and seed support.
3. **OpenAI pricing** — https://developers.openai.com/api/docs/pricing
   Token-billed; points to the calculator for per-image figures.
4. **OpenAI image generation guide** — https://developers.openai.com/api/docs/guides/image-generation
   Custom sizes up to 3840 px and 8.29 MP, masks, transparency, `n`.
5. **CostGoat OpenAI image pricing (2026-09-05)** — https://costgoat.com/pricing/openai-images
   Per-image table: gpt-image-2 high $0.211 at 1024².
6. **WaveSpeed: GPT Image 2 pricing** — https://wavespeed.ai/blog/posts/gpt-image-2-pricing-2026/
   Token rates $5 / $8 / $30 per 1M; edits cost 2–3×.
7. **fal GPT Image 2** — https://fal.ai/models/openai/gpt-image-2
   4K high $0.401, medium $0.101.
8. **fal Nano Banana Pro** — https://fal.ai/models/fal-ai/nano-banana-pro
   $0.15, doubled at 4K.
9. **fal Nano Banana 2** — https://fal.ai/models/fal-ai/nano-banana-2
   $0.08 base with ×1.5 (2K) and ×2 (4K) multipliers; 14 references.
10. **MuAPI: best AI image APIs (2026-07-18)** — https://muapi.ai/blog/best-ai-image-generation-apis-2026
    Nano Banana 2 $0.06/0.09/0.12, Seedream Pro $0.045/0.09, FLUX.2 Pro $0.032, Ideogram $0.02, Reve $0.032.
11. **MuAPI Nano Banana Pro playground** — https://muapi.ai/playground/nano-banana-pro
    $0.12/image.
12. **MuAPI Midjourney** — https://muapi.ai/midjourney
    $0.10 per run of 4 images.
13. **Midjourney has no official API** — https://unifically.com/blogs/midjourney-api
    ToS forbid automation; enterprise-gated.
14. **Teamday AI API pricing comparison (2026-09-23)** — https://www.teamday.ai/blog/ai-api-pricing-comparison-2026
    Cross-provider table: Replicate gpt-image-2 high $0.128, Imagen 4 removed from the Gemini API, Seedream prices.
15. **BFL pricing docs** — https://docs.bfl.ai/quick_start/pricing
    FLUX.2 per-MP floors; Kontext pro $0.04 and max $0.08.
16. **BFL FLUX.2 overview** — https://docs.bfl.ai/flux_2/flux2_overview
    Up to 4 MP, 8–10 references, variant licences.
17. **fal FLUX.2 pro** — https://fal.ai/models/fal-ai/flux-2-pro
    $0.03 for the first MP plus $0.015 per extra MP, input included.
18. **fal FLUX.1 Kontext pro** — https://fal.ai/models/fal-ai/flux-pro/kontext
    $0.04.
19. **The Decoder: Luma Uni-1.1 API** — https://the-decoder.com/luma-opens-uni-1-1-image-model-api-at-prices-and-quality-matching-openai-and-google/
    $0.0404 / $0.10, 2048 px, $0.003 per reference (up to 9).
20. **Recraft API pricing** — https://www.recraft.ai/pricing?tab=api
    V4.1 $0.035, Pro $0.21, Flash $0.007, vector and editing prices.
21. **Puter: Ideogram API pricing** — https://developer.puter.com/tutorials/ideogram-api-pricing/
    3.0 at $0.03/$0.06/$0.09; character reference $0.10–0.20.
22. **Kie: Ideogram V4 pricing** — https://kie.ai/blog/ideogram-v4-pricing
    V4 at $0.03/$0.06/$0.10.
23. **fal Z-Image Turbo** — https://fal.ai/models/fal-ai/z-image/turbo
    $0.005/MP, up to 4 MP.
24. **fal Seedream 5.0 Lite** — https://fal.ai/models/fal-ai/bytedance/seedream/v5/lite/text-to-image
    $0.035, up to 3072², 1–6 images.
25. **Seedream 5.0 Pro guides** — https://apiframe.ai/models/seedream-5-pro and https://promptslove.com/blog/seedream-5-pro-the-complete-guide/
    Pro takes 10 references and Lite 14; Pro goes to 4K.
26. **Higgsfield Soul Standard** — https://open.higgsfield.ai/models/higgsfield-ai/soul/standard/playground
    $0.0938 at 720p, $0.1875 at 1080p.
27. **Higgsfield API blog** — https://higgsfield.ai/blog/higgsfield-api
    Soul 2 / Soul Cinema "$0.0032/image"; resold models.
28. **eesel: Reve 2.1 pricing** — https://www.eesel.ai/blog/reve-2-1-pricing
    Credit prices per endpoint; 4K.
29. **fal Kling Image O3** — https://fal.ai/models/fal-ai/kling-image/o3/text-to-image
    $0.028 at 1K/2K, $0.056 at 4K.
30. **eesel: Leonardo pricing** — https://www.eesel.ai/blog/leonardo-ai-pricing
    Per-model API rates not published.
31. **Runway API pricing** — https://docs.dev.runwayml.com/guides/pricing/
    gen4_image 5/8 credits, turbo 2, resold third-party models.
32. **Stability pricing** — https://platform.stability.ai/pricing and https://fast.io/resources/stability-ai-review-2026/
    SD 3.5 Large 6.5 credits, Ultra 8.
33. **Krea 2 API launch** — https://www.krea.ai/blog/krea-2-api-launch
    Medium $0.03 and Large $0.06, 1K only, style references and moodboards.
34. **Adobe Firefly API pricing** — https://sudomock.com/blog/adobe-firefly-api-pricing-2026
    Enterprise contract only; no public rate card.
35. **Canva Connect API** — https://morphed.app/blog/canva-ai-image-generator
    No text-to-image API endpoint.
36. **Replicate GFPGAN** — https://replicate.com/tencentarc/gfpgan
    About $0.0035 per run.
37. **awesome-ai-image-models (Aug 2026)** — https://github.com/Anil-matcha/awesome-ai-image-models
    Which resellers serve which models.

### Research D: Upscalers, aggregators and multi-model API hubs

Checked 2026-09-29. Prices are from the vendor's own docs or pricing endpoint unless a row says "secondary". Where a price could not be found, the row says **not found** and names where I looked. The curiousrefuge.com/best-ai-tools page renders its tool list client-side, and WebFetch returned only the section headings. The tool names and scores below are the ones given in the brief, not re-read from the page.

Currency notes:
- Topaz sells API credits at **$0.12** (Starter), **$0.10** (Developer, $50/mo for 500) and **$0.08** (Scale, $240/mo for 3,000). Source: topazlabs.com/api.
- Magnific (formerly the Freepik API) prices in EUR in its docs.
- Runway API: 1 credit = $0.01.
- Kie.ai: 1 credit = $0.005 (secondary source).

---

#### Part 1: Quality-enhancement tools

##### 1a. Image upscaling

| Tool (CR score) | Official API? | Docs | Price (official) | Max output / factors | Third-party hosts (price) |
|---|---|---|---|---|---|
| **Magnific** Precision (7.93) | Yes: Magnific API (ex-Freepik API), `POST /v1/ai/image-upscaler-precision` and `/image-upscaler-precision-v2` | docs.magnific.com/api-reference/image-upscaler-precision-v2/overview | Billed by output pixel area. Doc examples: 1280x720→2560x1440 (2x) **€0.10**; 1920x1080→3840x2160 (2x) **€0.20**; 1280x720→5120x2880 (4x) **€0.40**; 640x480 8x **€0.50** | V1: 2/4/8/16x. V2: any integer **2–16x**, flavors `sublime`/`photo`/`photo_denoiser`, plus sharpen, smart_grain, ultra_detail | **Runway API** `magnific_precision_upscaler_v2`: 25 credits (**$0.25**) per image, **$1.50** when output is over 4096px |
| **Nano Banana 2** (7.89) | Yes: Gemini API `gemini-3.1-flash-image`. It is an image model used for re-rendering, not a dedicated upscaler | ai.google.dev/gemini-api/docs/pricing | **$0.045** (512), **$0.067** (1K), **$0.101** (2K), **$0.151** (4K) per image; batch −50% | 4K (4096px) max. No factor parameter: you ask for an output size | Replicate $0.067/$0.101/$0.151 (same as Google); Runway 7/11/16 credits = $0.07/$0.11/$0.16 (1K/2K/4K); MuAPI `nano-banana-2` 4K estimate $0.12; Krea, Leonardo, Magnific, fal, WaveSpeed ($0.063 discounted) |
| **Crystal** (Clarity AI) (7.75) | No first-party developer API found. clarityai.co/pricing rendered no API rates. Distributed through partners | fal.ai/models/clarityai/crystal-upscaler | **fal: $0.016/MP of output** (4MP = $0.064, 16MP = $0.256) | 1x–**200x** (fal); "up to 10K" (Lumenfall, secondary). Portrait/face specialist | fal (above); WaveSpeed; Segmind; Replicate (via Lumenfall routing). Crystal **video** on fal: $0.10/MP/s ×FPS multiplier (2440x1440, 4s, 30fps = $1.40) |
| **Topaz Gigapixel** (7.29) | Yes: Topaz Labs API, `api.topazlabs.com/image/v1/...` | developer.topazlabs.com/getting-started/model-pricing | **1 credit per 24 MP of output** = **$0.0033–$0.005/MP** ($0.08–$0.12 per 24MP image) | Standard 2 up to **1024 MP**; Standard Max 384 MP; up to 4x on some models (docs "ask" answer); topazlabs.com/api quotes up to 512 MP | **Replicate** `topazlabs/image-upscale`: **$0.05** up to 24MP, $0.10 to 48MP, $0.20 at 96MP, $0.82 at 512MP (cheaper than Topaz's own Starter rate); **fal**: $0.08 up to 24MP ... $1.36 at 512MP; **MuAPI** `topaz-image-upscale` from $0.075, `topaz-upscale-image-precision` $0.11 (2x estimate); **Krea** Topaz up to 22K, ~$0.10/image headline; **Kie.ai** `topaz/image-upscale` (price not found) |
| **Photoshop / Firefly Upscaler** (7.18) | Yes: Firefly Services `POST /v1/images/upsample-async` (firefly-api.adobe.io), OAuth S2S plus x-api-key | developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/upscale/ | **Not found**: Firefly Services is an enterprise contract with a private rate card (checked the dev docs and pricing pages) | **2x, 3x, 4x, 6x**; max output **6K** | none found |
| **Krea** (6.39) | Yes: Krea API, `POST /generate/enhance/...` | krea.ai/docs/api-reference/image-enhance/krea-enhance.md | Headline "Topaz upscaling **$0.10/image**" (krea.ai/features/api). Per-enhancer prices are **not in the docs** pages | Krea Enhance max **8K**; Krea Legacy 4K; resells Topaz (22K), Topaz Generative (16K), Bloom / Bloom 2 (10K), Wonder 3.5 (16K) | n/a (Krea is itself a host) |
| **Enhancor** (6.5) | Unclear. The site says "API access" and "workflows become REST endpoints" (workflows.enhancor.ai), but no public API pricing page | enhancor.ai | **Not found**. Only app plans: $9 / $19 / $35 per month (secondary, saasworthy) | "up to 4K" upscaler (vendor copy) | none found |

##### 1b. Video upscaling

| Tool (CR score) | Official API? | Price (official) | Max / options | Third-party hosts |
|---|---|---|---|---|
| **Topaz Starlight Precise** (7.85) | Yes: `https://api.topazlabs.com/video/`, model `slp-2.6` (Precise 2.6; 2.5 and older are deprecated). Also Starlight Fast 2/3, HQ, Mini | **26.04 frames/credit at 1080p, 11.92 frames/credit at 4K**. For 10s@30fps (300 frames) that is ~11.5 credits (**$0.92–$1.38**) at 1080p and ~25.2 credits (**$2.01–$3.02**) at 4K | Up to **4K** | **fal** `topaz/upscale/video/generative`: **$1.20/10s** to 1080p, **$2.60/10s** at 4K (30fps; ×2 at 60fps); Starlight Fast 2 $0.60/$1.30. **Magnific API** `video-upscaler-topaz` (`starlight_precise_2_5` or `starlight_fast_2`; 720p/1k/2k/4k; apollo/chronos interpolation), price not published. **MuAPI** `topaz-upscale-video-generative` (estimate $1.82 on a dummy URL; the real price depends on the probed clip). **Krea** Starlight / Starlight 2.5 (max 4K, price not in docs) |
| **Magnific Precision** video (7) | Yes: `POST /v1/ai/video-upscaler-precision` (diffusion, faithful, strength 0–100) | Billed per frame by output resolution. Per-frame € rate **not found** (docs point to /pricing, which gives no numbers; the magnific.com credits page returns 403) | 720p / 1k / 2k / **4k**, fps_boost | none found for Precision specifically |
| **Krea** video (6.25) | Yes: Krea video-enhance endpoints: Topaz Video (max **8K**), Starlight, Starlight 2.5, Astra, Astra 2, Hyperion 2.5 (SDR→HDR), SeedVR2, Flux Upscale, Ruby | **Not found** in the API reference pages (they carry no price table) | 4K–8K by model | n/a |

##### 1c. Creative image upscaling

| Tool | API | Price | Notes |
|---|---|---|---|
| **Magnific Creative** (7.5) | `POST /v1/ai/image-upscaler` | Same per-pixel table as Precision (€0.10 for 2x 720p, €0.40 for 4x 720p, €0.50 for 8x VGA) | 2/4/8/16x, prompt-guided, creativity / HDR / resemblance / fractality controls |
| **Topaz Bloom** (7) | Topaz API `image/v1/enhance-gen/async`, "Bloom 2", "Bloom 1 Creative/Realism" | **1 credit per 2 MP of output**. A 24MP output = 12 credits = **$0.96–$1.44** | Up to 8x (docs), creativity 1–9. Hosts: Krea (Bloom / Bloom 2, max 10K); MuAPI `topaz-upscale-image-creative` (4x estimate **$1.01**) |
| **Krea** (7) | Krea Enhance ("cheap creative enhancer", max 8K) | not found per call | |

##### 1d. Creative video upscaling

| Tool | API | Price | Notes |
|---|---|---|---|
| **Topaz Astra** (7) | Topaz API, model `ast-2` (Astra 2; Astra 1 deprecated) | **10 frames/credit at 1080p, 6 at 4K**. For 10s@30fps that is 30 credits (**$2.40–$3.60**) at 1080p and 50 credits (**$4.00–$6.00**) at 4K. The pricing overview says "Astra ~40 credits per 10s 1080p" (older figure) | Prompt guidance, creativity and sharpness controls. Hosts: Krea (Astra / Astra 2), MuAPI `topaz-upscale-video-creative` (dummy estimate $3.50) |
| **Magnific Creative** video (7) | `POST /v1/ai/video-upscaler` (Standard) and `/turbo` | Direct € per frame **not found**. **Runway resells it** as `magnific_video_upscaler_creative`: **$0.007/frame** (720p/1k), **$0.009** (2k), **$0.012** (4k). 10s@30fps at 4K = **$3.60** | Creativity 0–100, flavors vivid/natural, fps_boost, up to 4K |

**Cheapest faithful baselines for comparison:** SeedVR2 on fal at **$0.001/MP of video data** (1080p × 121 frames ≈ $0.25); fal Topaz Proteus ≈ $0.20/10s at 1080p (secondary). Replicate `topazlabs/video-upscale` is Proteus-class, not Starlight: **$0.093 per 5s** for 720p→1080p/30 and **$0.373 per 5s** for →4K/30.

---

#### Part 2: Aggregators on the page

| Aggregator (score) | API reaching underlying models? | Models via API | Pricing model |
|---|---|---|---|
| **Magnific** (8.4) (ex-Freepik) | **Yes**: api.magnific.com, `x-magnific-api-key`, async task plus `webhook_url`; also an MCP server | Video: Veo 3.1 / Fast / Lite, Kling 2.1–2.6, **Kling 3 / 3 Omni / 3 Turbo / Kling 4K**, **Seedance 2 Pro (to 4K) / Fast / Mini, Seedance 2.5 Pro**, Hailuo 02 and **2.3**, Wan 2.2/2.5/**2.6**/2.7, LTX-2 Pro/Fast, Runway Gen-4 Turbo / **Gen-4.5** / Act-Two, PixVerse, OmniHuman, HappyHorse. Image: Mystic, **Nano Banana Pro**, Gemini 2.5 Flash Image, **GPT Image 2 / 2.5**, **Flux 2** Pro/Turbo/Flex/Klein, **Seedream 4/4.5/5 Lite/5 Pro**. Upscale: Creative, Precision v1/v2, Video Upscaler (Standard/Turbo), Video Precision, **Video Topaz (Starlight)**, Skin Enhancer | Credits deducted per call. API is **always** credit-based even on "Unlimited" app plans. Per-credit € and per-model credits: **not found** (the magnific.com credits page and freepik.com/api/pricing both return 403) |
| **Krea** (8.2) | **Yes**: api.krea.ai, prepaid USD balance separate from app compute units, async job plus webhook | Veo 2/3/3.1/Fast, **Kling 2.5/2.6/3.0/o1**, **Seedance Pro, 2.0, 2.0 Fast, 2.0 Mini, 2.5**, Hailuo 02/2.3/2.3 Fast, Wan 2.1–3.0, **LTX-2.3 / 2.5**, Ray 2, Runway Gen-4/4.5, Sora 2; images: Nano Banana / 2 / Pro, ChatGPT Image / GPT Image 2.5, Flux, Seedream 4/5, Luma UNI-1; Topaz image and video enhancers | Fixed USD per generation. Examples: **Seedance 2.0** $0.1348/s (480p) · $0.3034/s (720p) · $0.6826/s (1080p) without video ref; **Kling 3.0** $0.112/s pro, $0.168/s pro+audio, $0.42/s 4K; **Veo 3.1** $0.20/s without audio ($1.60 per 8s) |
| **Higgsfield** (7.4) | **Yes**: cloud.higgsfield.ai, Python/TS SDK, 20 concurrent, async plus webhooks | 50+ models: Seedance (incl. 2.5), Kling (2.5/2.6/3.0), Wan, MiniMax, LTX, PixVerse, Recraft, Ideogram, Grok, plus own Soul 2 / Soul Cinema / DoP | PAYG USD, failed jobs refunded, balance expires after 1 year. Soul 2 **$0.0032/image**; Kling 2.5 **$0.042/s**; Wan 3.0 **$0.20/s**; Kling 3.0 10s **$1.12** (secondary). Upscalers via API: **not found** |
| **Runway** (6.8) | **Yes**: api.dev.runwayml.com, $0.01/credit, async tasks | Own: Gen-4.5, Gen-4 Turbo, Aleph 2, Act-Two, Gen-4 Image, Ruby (HDR). Resold: **Veo 3.1 / Fast**, **Seedance 2 (to 4K) / 2 Fast / 2 Mini / 2.5**, **Hailuo 3 / H3 Max**, Wan 3 / 3 Prime, Grok Imagine 1.5, HappyHorse, Gemini Omni Flash; images **Nano Banana Pro** (gemini_image3_pro), **Nano Banana 2**, **GPT Image 2 / 2.5**, Seedream 5; upscale **Magnific Precision v2 (image)**, **Magnific Creative video**; ElevenLabs | Credits per second or image (full table in Part 3). **No Kling, Luma, LTX or Flux 2** |
| **Leonardo** (5.8) | **Yes**: REST API with PAYG in USD (docs.leonardo.ai) | Veo 3.1 / Fast / Lite, **Kling 2.1/2.5/2.6/3.0/3.0 Turbo/O1/O3**, **Seedance 2.0 / Fast**, Hailuo 03, **Wan 2.6/2.7/3.0**, LTX-2 Fast, Gemini Omni; images Nano Banana / 2 / Pro, GPT Image 1.5/2/2.5, **FLUX.2 Pro**, Seedream 4/4.5/5 Pro; own Pro Upscaler Precise/Creative | PAYG dollars (docs "PAYG guide" and pricing calculator); per-model $: **not found** in llms.txt pages. App plans: token bundles ($12/$30/$60 per month) |
| **Adobe Boards / Firefly** (5.6) | Firefly Services API documents **Adobe's own** endpoints (generate, expand, fill, upscale). Partner models (Veo, Flux 2, Nano Banana Pro/2, GPT Image, Runway, Luma, Kling) are documented for the **Firefly app and Boards**; I did **not** confirm them in the public API reference | Adobe Firefly models; upscale 2/3/4/6x | Enterprise contract, rate card private: **not found** |
| **Artlist** (4.4) | **No public generation API.** An **Artlist MCP** (remote, OAuth, Claude/ChatGPT/VS Code) generates images, video, voiceover and music on an Artlist account using credits. The Enterprise API covers the **music catalogue** (search/download) only | Toolkit: Veo 3.1, Sora 2, Kling family incl. 3.0, Seedance 2.0, Hailuo 2.3, Nano Banana, Lyria 3 Pro | Subscription credit pool; no per-call API price |

---

#### Part 3: One-key API aggregators

Model coverage (✓ = listed in the vendor's own catalogue/docs; — = not found; ~ = an adjacent version only):

| | Seedance 2.0 | Kling 3.0 | Veo 3.1 | Luma Ray 3 | Hailuo 2.3 | Wan 2.6 | LTX-2 | Nano Banana Pro / 2 | GPT Image | Flux 2 | Seedream | Topaz | Magnific | Crystal |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **fal.ai** | ✓ | ✓ | ✓ | ✓ (Ray 3.2) | ✓ | ✓ | ✓ | ✓ / ✓ | ✓ | ✓ | ✓ | ✓ img + Starlight video | — | ✓ img + video |
| **Replicate** | ✓ | ✓ (v3, v3-omni) | ✓ | ✓ (ray-3.2) | ✓ | ~ (2.5, 2.7) | ✓ (ltx-2-pro) | ✓ / ✓ | ✓ (gpt-image-2) | ✓ | not verified | ✓ image + video (Proteus-class) | — | via Lumenfall routing (secondary) |
| **MuAPI** | ✓ (144 variants) | ✓ (+4K, Omni, Turbo) | ✓ (+Lite, 4K, extend) | — (only luma-flash-reframe) | ✓ (+H3) | ✓ | ✓ (2, 2.3, 2.5) | ✓ / ✓ | ✓ (1.5, 2, 2.5) | ✓ | ✓ (v3–5 Pro) | ✓ image precision/creative/generative + video precision/creative/generative | — | — |
| **WaveSpeed** | ✓ | listed in nav | listed | — | not found | ✓ (nav) | not found | ✓ / ✓ | ✓ (GPT Image 2) | not found | ✓ (5.0 Flash/Pro) | not found | — | ✓ (image + video) |
| **Runway API** | ✓ (2, Fast, Mini, 2.5) | — | ✓ | — | ~ (Hailuo 3 / H3) | ~ (Wan 3) | — | ✓ / ✓ | ✓ | — | ✓ (5 Pro/Lite) | — | ✓ (Precision v2 image, Creative video) | — |
| **Together AI** | ✓ ($0.16/video, unit as stated) | ~ (Kling 2.1) | ~ (Veo 2) | — | ~ (Hailuo 02) | ~ (Wan 2.6 Image) | — | ✓ Pro (**$0.134**, the Google price) | ✓ (GPT Image 2 $0.053) | ✓ (FLUX.2 dev/flex/pro/max) | ✓ (3.0/4.0) | — | — | — |
| **Magnific (ex-Freepik) API** | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ Pro / (2.5 Flash) | ✓ | ✓ | ✓ | ✓ (Starlight video) | ✓ native | — |
| **Kie.ai** | ✓ (2, Fast, Mini, 2.5) | ✓ (3.0, Turbo, Omni) | ✓ (incl. 1080p/4K get) | — | ✓ | ✓ | not found | ✓ / ✓ | ✓ | ✓ | ✓ | ✓ image + video | — | — |
| **Krea API** | ✓ | ✓ | ✓ | ~ (Ray 2) | ✓ | ~ (2.5, 3.0) | ✓ (2.3, 2.5) | ✓ / ✓ | ✓ | ~ (Flux, Kontext) | ✓ | ✓ image + video | — | — |
| **Higgsfield API** | ✓ | ✓ | not found | — | ✓ (MiniMax) | ✓ | ✓ | not found | not found | not found | not found | not found | — | — |
| **Leonardo API** | ✓ | ✓ | ✓ | — | ~ (Hailuo 03) | ✓ | ✓ (LTX-2 Fast) | ✓ / ✓ | ✓ | ✓ | ✓ | — | — | — |

##### Price examples (USD) against the official list price

| Model | Official | fal | Replicate | MuAPI (live /models + estimate-cost) | Krea | Runway | Other |
|---|---|---|---|---|---|---|---|
| **Veo 3.1** (1080p, audio) | Google **$0.40/s** (no audio $0.20; Fast $0.12 at 1080p; Lite $0.08 at 1080p) | **$0.40/s** (no audio $0.20; 4K $0.60) | **$0.40/s** / $0.20 | 8s = **$2.50** (≈$0.31/s); fast $0.60, lite $0.30 | $0.20/s without audio ($1.60 per 8s) | 40 cr/s audio = **$0.40/s**; 20 without | Kie Veo 3 Fast **$0.30 per 8s** (secondary) |
| **Kling 3.0 Pro** | Kling dev **$0.112/s** without audio, **$0.168/s** with, 4K $0.42 (secondary, from kling.ai/dev/pricing) | $0.112 / $0.168 (/$0.196 voice) | $0.224 / **$0.336** (≈2× official) | 10s + audio **$1.60** | $0.112 / $0.168 | — | Kie std **~$0.07/s** (secondary); Higgsfield 10s **$1.12** (secondary) |
| **Seedance 2.0** 1080p | BytePlus $0.04–0.78/s range (secondary; 2.5 at $10.70/M tokens) | $0.3024/s standard; $0.2419/s fast | **$0.45/s** without video in; $0.55 with; 4K $1.25 | 5s = **$1.25**, 10s = $2.50 (**$0.25/s**) | $0.6826/s without ref | 40 cr/s = **$0.40/s**; 4K **$1.50/s** | WaveSpeed $0.54 per base run (discounted); Kie ~$0.057/s (secondary) |
| **Hailuo 2.3** | not checked | Pro 1080p **$0.49/video** | 768P 6s $0.28, 10s $0.56; 1080P 6s $0.49 | pro $0.63, std $0.36, fast $0.24 | listed | — | |
| **Wan 2.6** | not checked | $0.10/s 720p, $0.15/s 1080p | — | from $0.65 per base run | — | — | Together Wan 2.6 *Image* $0.03 |
| **LTX-2 Pro** | not checked | $0.06/s 1080p, $0.12 1440p, **$0.24 4K** | same ($0.06/$0.12/$0.24) | 6s = $0.46 | listed | — | |
| **Luma Ray 3.2** | Luma API (not priced here) | 5s: $0.15 (540p), $0.30 (720p), **$1.20 (1080p)** | same (1080p 10s $3.60) | not carried | Ray 2 only | — | |
| **Nano Banana Pro** | Google **$0.134** (1K/2K), **$0.24** (4K) | **$0.15**, 4K **$0.30** (+12–25%) | page not parsed | $0.12, 4K est. **$0.18** (below official) | ~$0.15 | 20 cr = $0.20; 4K $0.40 | Together **$0.134**; WaveSpeed $0.126 (discounted) |
| **Nano Banana 2** | $0.067 / $0.101 / $0.151 | — | **identical to Google** | $0.06, 4K est. $0.12 | listed | $0.07 / $0.11 / $0.16 | WaveSpeed $0.063 |
| **GPT Image 2** | not checked | listed | low $0.012 · med $0.047 · high $0.128 | $0.09 | listed | 1–41 cr ($0.01–$0.41) | Together $0.053; WaveSpeed $0.057 |
| **Flux 2 Pro** | not checked | listed | **$0.015/run + $0.015/MP in and out** | $0.032 edit; dev $0.015 | — | — | Together $0.03 |
| **Topaz image (Gigapixel)** | $0.08–0.12 per 24MP | $0.08 per ≤24MP | **$0.05 per ≤24MP** | $0.075–0.11 | ~$0.10 | — | |
| **Topaz Starlight Precise** 10s/30fps | $0.92–1.38 (1080p), $2.01–3.02 (4K) | **$1.20 / $2.60** | not carried (Proteus-class only) | est. $1.82 (dummy URL) | not priced | — | Magnific-hosted (not priced) |

##### API style

| Aggregator | Style | Key facts |
|---|---|---|
| fal.ai | Queue (submit → request_id → status/result) plus webhooks; sync `run` for fast models; Python/JS SDKs | Pricing on each model page, usually per second or per MP |
| Replicate | Async predictions, poll or webhook; `Prefer: wait` for sync up to 60s | Official models are billed per output (a `billingConfig` on each model page), the rest per GPU second |
| MuAPI | Async: POST `/api/v1/{model}` → request id → poll result; **free `POST /api/v1/models/{m}/estimate-cost` with no key**, and a public `GET /api/v1/models` catalogue with `cost` and `input_fields` (760 models on 2026-09-29) | Prices are base costs, `dynamic_pricing: true` |
| WaveSpeed | Async task plus polling/webhook (`/api/v3/...`, Bearer key; the catalogue needs a key) | Frequently shows "discounted" prices; tiered accounts |
| Runway API | Async tasks (`POST /v1/...` → task id → `GET /v1/tasks/:id`) | $0.01/credit, per-second/per-image table published in full |
| Together AI | Async video jobs (create → id → poll); images are sync | Prices "per video" / "per image" |
| Magnific API | Async task_id, poll, or `webhook_url` | EUR, credit-based |
| Kie.ai | Async `createTask` → recordId, `callBackUrl` webhooks, `/common-api/get-account-credits` | Credits (1 = $0.005, secondary); result URLs expire in ~24h |
| Krea | Async job id, poll or webhook | Fixed USD per generation, prepaid API balance |

##### Markup verdict
- **At list price (no markup):** Replicate and fal for Veo 3.1 and LTX-2; Replicate for Nano Banana 2; Together for Nano Banana Pro; Runway for Veo 3.1; fal and Krea for Kling 3.0.
- **Marked up:** fal Nano Banana Pro (+12% at 1K/2K, +25% at 4K); Replicate Kling 3.0 (~2× the Kling dev list); Runway Nano Banana Pro ($0.20 against $0.134) and its Magnific image upscale ($0.25–1.50 against €0.10–0.50 direct).
- **Below list (subsidised or discounted):** MuAPI (Nano Banana Pro $0.12 against $0.134; Veo 3.1 8s $2.50 against $3.20 official with audio); WaveSpeed "discounted" prices; Kie.ai (Veo 3 Fast $0.30/8s, Kling std $0.07/s; secondary sources, and Kie markets itself as undercutting official endpoints). Below-list resellers carry reliability, ToS and data-residency risk. Verify before relying on them.

---

#### Sources (title, URL, key insight)

1. Topaz Labs API model pricing: https://developer.topazlabs.com/getting-started/model-pricing. Credits per MP (Gigapixel 24, Wonder 4, Bloom 2) and per 10s video (Proteus 4, Starlight 6/12, Astra 40).
2. Topaz Starlight Precise 2.6: https://developer.topazlabs.com/video-models/starlight/starlight-precise-2.6.md. 26.04 frames/credit at 1080p, 11.92 at 4K, model `slp-2.6`, up to 4K.
3. Topaz Astra 2: https://developer.topazlabs.com/video-models/astra/astra-2.md. 10 frames/credit at 1080p, 6 at 4K, `ast-2`.
4. Topaz Bloom 2: https://developer.topazlabs.com/image-models/bloom/bloom-2-new-and-improved.md. `enhance-gen/async`, creativity 1–9.
5. Topaz API landing: https://www.topazlabs.com/api. $0.12 / $0.10 / $0.08 per credit tiers; Krea and Weavy as integrators.
6. Topaz docs llms.txt: https://developer.topazlabs.com/llms.txt. Full model roster (Starlight Fast 3, HQ, Precise 2.6, Astra 2, Wonder 3.5).
7. Magnific API docs index and sitemap: https://docs.magnific.com/llms.txt, https://docs.magnific.com/sitemap.xml. The ex-Freepik API now carries Veo 3.1, Kling 3, Seedance 2/2.5, Nano Banana Pro, GPT Image 2.5 and Flux 2, plus video-upscaler-topaz.
8. Magnific Upscaler Precision / Creative: https://docs.magnific.com/api-reference/image-upscaler-precision/image-upscaler. € per-output-area examples; 2/4/8/16x.
9. Magnific Precision V2: https://docs.magnific.com/api-reference/image-upscaler-precision-v2/overview. 2–16x, flavors.
10. Magnific Video Upscaler / Precision / Topaz: https://docs.magnific.com/api-reference/video/video-upscaler/overview (and /video-upscaler-precision, /video-upscaler-topaz). Per-frame billing, to 4K, Starlight Precise 2.5 / Fast 2.
11. Magnific pricing: https://docs.magnific.com/pricing. The API is always credit-based; per-model numbers sit behind a 403 page.
12. Runway API pricing: https://docs.dev.runwayml.com/guides/pricing/. $0.01/credit; resells Veo 3.1, Seedance, Hailuo 3, Nano Banana, GPT Image 2 and Magnific upscalers ($0.007–0.012/frame video; $0.25/$1.50 image).
13. Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing. Nano Banana 2 $0.045–0.151; Nano Banana Pro $0.134/$0.24; Veo 3.1 $0.40/s (Fast and Lite tiers).
14. Adobe Firefly Upscale guide: https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/upscale/. 2/3/4/6x, 6K max, no public price.
15. Krea API features: https://www.krea.ai/features/api. Models and headline prices ($0.10 Topaz upscale).
16. Krea docs llms.txt and model pages: https://www.krea.ai/docs/llms.txt, https://www.krea.ai/docs/api-reference/video/kling-30.md. Seedance 2.0 / Kling 3.0 / Veo 3.1 fixed USD tables; enhancer max resolutions.
17. fal Topaz video generative: https://fal.ai/models/topaz/upscale/video/generative. $1.20/$2.60 per 10s (Starlight Precise 2.6).
18. fal Topaz image: https://fal.ai/models/fal-ai/topaz/upscale/image. $0.08 per 24MP up to $1.36 at 512MP.
19. fal Crystal: https://fal.ai/models/clarityai/crystal-upscaler. $0.016/MP, 1–200x.
20. fal model pages: https://fal.ai/models/bytedance/seedance-2.0/image-to-video, https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video, https://fal.ai/models/fal-ai/veo3.1/image-to-video, https://fal.ai/models/fal-ai/nano-banana-pro, https://fal.ai/models/fal-ai/ltx-2/image-to-video, https://fal.ai/models/wan/v2.6/image-to-video, https://fal.ai/models/fal-ai/minimax/hailuo-2.3/pro/image-to-video, https://fal.ai/models/fal-ai/seedvr/upscale/video. Prices in the Part 3 table.
21. Replicate model pages (the embedded `billingConfig` was read): https://replicate.com/topazlabs/image-upscale, /topazlabs/video-upscale, /google/veo-3.1, /bytedance/seedance-2.0, /kwaivgi/kling-v3-video, /luma/ray-3.2, /google/nano-banana-2, /minimax/hailuo-2.3, /lightricks/ltx-2-pro, /openai/gpt-image-2, /black-forest-labs/flux-2-pro.
22. MuAPI live catalogue: https://api.muapi.ai/api/v1/models plus `/models/{m}/estimate-cost`. 760 models with cost and input fields; public estimate endpoint.
23. Together AI pricing: https://www.together.ai/pricing. Seedance 2.0 / 2.5, FLUX.2, Nano Banana Pro at $0.134, GPT Image 2.
24. WaveSpeed models: https://wavespeed.ai/models. Seedance 2.0 at $0.54 (discounted), Nano Banana Pro $0.126, NB2 $0.063, Seedream 5.
25. Kie.ai docs: https://docs.kie.ai/llms.txt. Seedance 2 / 2.5, Kling 3.0, Veo 3.1, Hailuo 2.3, Wan 2.6, Topaz image and video upscale, callBackUrl.
26. Kie pricing (secondary): https://www.bitdoze.com/kie-ai-video-generation/. 1 credit = $0.005; Kling 3.0 std ~$0.07/s; Seedance 2.0 ~$0.057/s.
27. Higgsfield API: https://higgsfield.ai/blog/higgsfield-api. 50+ models, PAYG, webhooks, Kling 2.5 $0.042/s.
28. Leonardo API docs: https://docs.leonardo.ai/llms.txt. Veo 3.1, Kling 3.0, Seedance 2.0, Wan 2.6, LTX-2, Nano Banana Pro/2, FLUX.2 Pro via REST; PAYG.
29. Artlist MCP: https://help.artlist.io/hc/en-us/articles/38948588333469. MCP only for generation; the Enterprise API is the music catalogue.
30. Kling dev pricing (secondary summary): https://kling.ai/dev/pricing, via costbench and magichour. Kling 3.0 $0.112 / $0.168 / $0.42 per second.
31. BytePlus Seedance (secondary): https://anikuku.com/blog/seedance-2-api-pricing-guide-2026. Official $0.04–0.78/s range.

