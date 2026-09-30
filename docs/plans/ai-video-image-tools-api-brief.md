## Research Brief: AI video and image tools, API access and pricing

*Synthesis of [`ai-video-image-tools-api-research.md`](ai-video-image-tools-api-research.md), 2026-09-29. The subject is every image and video tool on [curiousrefuge.com/best-ai-tools](https://curiousrefuge.com/best-ai-tools#ai-video-tools): 21 tables, 115 entries, about 60 products. Every claim this brief makes about Film Engine's code is written as a table below and checked row by row by `backend/tests/ai-tools-api-brief.test.js`.*

### Executive Summary

Almost every tool on the page can be driven by API. Most of them are already one key away, because MuAPI, Film Engine's house provider, carries Seedance 2, Kling 3.0, Veo 3.1, Happy Horse, Hailuo 2.3, Wan 2.6, LTX, GPT Image 2, Seedream 5, Imagen 4 and the Topaz upscalers. What Film Engine lacks is the model entries, not the connection. The gaps that need a new vendor are narrow: Luma Ray 3.2, Topaz's newer video upscalers, Magnific, Recraft and HeyGen. One deadline is close: Nano Banana (Gemini 2.5 Flash Image) shuts down on 2026-10-02 and is still offered by three adapters.

### Key Themes

- **Connection is solved; the model list is not.**
  - Film Engine offers 4 MuAPI image models and 4 Seedance video tiers.
  - MuAPI's snapshot (checked 2026-08-31) carries 655 models, including every high-scoring video family on the page except Luma.
- **Flexibility has moved to "omni" models.**
  - Seedance 2.0 Omni: 9 images, 3 videos and 3 audio as references.
  - Gemini Omni Flash: any mix of inputs, edits by instruction.
  - Kling 3.0 / O3: element references with voice binding.
  - Happy Horse: 9 references plus lip-sync.
  - These take references, edit video, and generate synced audio in one call. Film Engine's role-based reference contracts (`lib/video-reference.js`) are the right shape to feed them.
- **Editing real footage is still one vendor.** Runway's Aleph 2 ($0.28/s) and Act-Two ($0.05/s) have no equivalent elsewhere. Both are already in the Runway adapter.
- **Drafting is cheap now.**

  | Model | Price per second |
  |---|---|
  | LTX 2.3 Fast | $0.03 |
  | Seedance 2.0 Mini | $0.04 |
  | Veo 3.1 Lite | $0.05 |

  All three are well under Seedance 2.5 at 1080p ($0.85/s). That makes "explore at draft quality, finish at delivery" affordable across a whole film.
- **Upscaling has a transparent leader.** Topaz publishes exact credit rates for Gigapixel, Bloom, Starlight Precise and Astra. MuAPI resells only the older Topaz video model.
- **The market moves weekly.** In the last six weeks:
  - OpenAI retired the Sora 2 API (09-24).
  - Runway retired Aleph v1 (07-30).
  - LTX retired its `ltx-2-*` model IDs (08-15).
  - MiniMax moved Hailuo 2.3 to legacy.
  - Google moved Imagen 4 to Vertex only.
  - Nano Banana ends on 10-02.

  A dated catalogue snapshot and a test against it are what keep the adapters honest.
- **Some tools must not be wired.**
  - Midjourney: its terms forbid automated access, and resellers break them.
  - Flow Studio, Canva and FaceApp: no API.
  - Firefly and DomoAI: enterprise contract only.
  - InsightFace (ComfyUI face swap): non-commercial licence.

#### Offered today

| Adapter | Model |
|---|---|
| runway | seedance2_5 |
| runway | veo3.1 |
| runway | veo3.1_fast |
| runway | happyhorse_1_0 |
| runway | hailuo3 |
| runway | gemini_omni_flash |
| runway | aleph2 |
| runway | gen4.5 |
| seedance | seedance-2.5-1080p |
| seedance | topaz-video-upscale |
| muapi | nano-banana-pro |
| muapi | nano-banana-2 |
| bfl | flux-2-pro |
| meshy | gpt-image-2 |
| google | gemini-3-pro-image |

### Top Ideas & Opportunities

1. **Offer MuAPI's catalogue, not four of its models.**
   - *What:* add the video and image models below to the MuAPI adapters (`lib/providers/seedance.js`, `lib/providers/muapi-image.js`), each with its field map probed free against MuAPI's validation, its rate-book row and its reference contract.
   - *Why:* the connection, credential, hosting (`upload_file`) and metering already exist, so each model is a registry entry plus a probe, not an integration.
   - *How it applies:* the video confirmation's model menu and the tiers can then offer Kling 3.0, Veo 3.1 Fast, LTX 2.3 and Wan 2.6 at their own prices, and drafting can use the cheapest.

2. **Retire Nano Banana before it breaks.**
   - *What:* remove the model from the three adapters that offer it before 2026-10-02: `nano-banana` on MuAPI and Meshy, `gemini_2.5_flash` on Runway. Meshy's draft tier (`lib/quality-tiers.js`) names it too.
   - *Why:* a project pinned to it will fail at generation, with an error that reads like a provider fault.
   - *How:* also migrate any `image_model` pin that names it to `nano-banana-2`.

3. **Finish on Topaz Starlight.**
   - *What:* a Topaz adapter (or fal) for Starlight Precise and Astra video upscaling.
   - *Why:* it scores highest on the page for video upscaling, and costs about $2–3 for 10 s to 4K at published rates.
   - *How:* it slots into the `post` capability beside the MuAPI upscalers just built, so the canvas "Upscale…" action offers it.

4. **Luma Ray 3.2 for keyframe-dense and HDR shots.**
   - *What:* a Luma adapter.
   - *Why:* up to 64 keyframes, Modify Video, and HDR/EXR export. No other model does this, and it matches the in-between strips (`lib/inbetweens.js`) that already plan dense stations.
   - *How:* a video adapter declaring `maxKeyframes: 64` and a reference contract.

5. **Lip-sync on footage that already exists.**
   - *What:* MuAPI's `sync-lipsync` ($0.04) and HeyGen translation ($0.025/s) as a real `lipsync` provider.
   - *Why:* `lipsync` is served by Gridlight alone today, and the preflight reports it "finished in the NLE". Recorded dialogue plus a clip could be synced in-engine instead.

6. **A reseller check in the rate book.** The same model is priced very differently by different routes:

   | Model | Route | Price |
   |---|---|---|
   | Nano Banana Pro | MuAPI | $0.12 |
   | Nano Banana Pro | Google | $0.134 |
   | Nano Banana Pro | fal | $0.15–0.30 |
   | Kling 3.0 | Replicate | about 2× list |

   The generator comparison (`lib/generator-costs.js`) could show the same model across routes, so the cheapest route is a visible choice.

#### MuAPI models not offered yet

| MuAPI model | What | List price (MuAPI, per call) |
|---|---|---|
| kling-v3.0-pro-image-to-video | Kling 3.0 image to video | $0.72 |
| kling-v3.0-4k-image-to-video | Kling 3.0 at 4K | $2.00 |
| kling-v3.0-omni-pro-image-to-video | Kling 3.0 Omni (references, audio) | $0.56 |
| kling-o3-image | Kling O3 image | $0.027 |
| veo3-fast-image-to-video | Veo 3 Fast | $0.60 |
| happy-horse-1-reference-to-video-1080p | Happy Horse with references | $2.10 |
| ltx-2.3-image-to-video | LTX 2.3, the cheapest draft | $0.104 |
| wan2.6-image-to-video | Wan 2.6 | $0.65 |
| minimax-hailuo-2.3-pro-i2v | Hailuo 2.3 Pro (legacy upstream) | $0.63 |
| bytedance-seedream-5.0-pro | Seedream 5.0 Pro image | $0.045 |
| z-image-turbo | Z-Image Turbo, the cheapest image | $0.007 |
| gpt-image-2-text-to-image | GPT Image 2 on MuAPI | $0.09 |
| google-imagen4 | Imagen 4 | $0.03 |
| sync-lipsync | Lip-sync onto existing footage | $0.04 |
| topaz-image-upscale | Topaz image upscale | $0.075 |

MuAPI lists prices without a unit. They read as per call, which is about a 5 s clip for video.

#### Not on MuAPI

| Family | Pattern checked against the snapshot | Where to get it |
|---|---|---|
| Luma Ray 3.2 | luma-ray\|ray-?3 | Luma API, fal |
| Recraft | recraft | Recraft API, fal |
| Magnific | magnific | Magnific API, Runway API |
| Pika | pika | Pika Dev API |
| Topaz Starlight | starlight | Topaz API, fal |
| Topaz Astra | astra | Topaz API |
| HeyGen avatars | heygen-(avatar\|photo) | HeyGen API, fal |

#### To retire

| Model | Shuts down |
|---|---|
| nano-banana | 2026-10-02 |

### Technical Approaches

- **Probe before paying.**
  - MuAPI and Runway both report their accepted fields in a 422 on a deliberately wrong-typed body, for free. The Seedance workflows, the four upscalers and the Seedance 2.5 audio field were all established this way.
  - Each new model gets the same probe, recorded as a dated fixture, and a test holds the adapter to it (the `muapi-models.test.js` pattern).
- **One adapter per vendor, models as data.**
  - A MuAPI model is an entry in a registry with its endpoint, field map, reference contract, `deliverableFrame` and price. That is exactly how `UPSCALERS` was added.
  - A new vendor is an adapter file, auto-loaded. It must declare the contract every adapter already declares: `promptLimit`, `maxReferenceImages`, `referenceMode`, `maxKeyframes`, `sizeControl`, `deliverableFrame`, `reportsProgress` and `cancel`.
- **Route by capability, not by vendor.** The capability layer (`resolve()`) already picks a provider per capability and per call, and the confirmation dialog already offers provider and model. A new model reaches the director with no new UI.
- **Everything through MCP.**
  - Every generation stays behind the existing tools (`video_generate`, `storyboard_regenerate`, `shot_upscale`, …) with their free previews.
  - The connected agent does the reasoning. No new tool may call a server-side LLM (`tests/mcp-no-server-llm.test.js`).
  - A new model is reachable by an agent the moment it is in the registry, because the tools read `modelIdsFor`.
- **Keep the snapshot fresh.** `tests/refresh-muapi-contract.js` re-reads MuAPI's catalogue. Re-running it monthly, with the test above, catches a model that disappears upstream (as Sora 2 did) before a director pays for a refusal.

### Open Questions

1. **Which vendors beyond MuAPI and Runway?** Topaz, Luma and HeyGen each need an account and a key. Which does the production actually want to pay for? fal reaches Luma, Topaz Starlight, Recraft and HeyGen with one key at roughly list price, at the cost of provenance being "fal" rather than the vendor.
2. **Should drafting default to a cheaper model than Seedance 2.5 at 480p?**
   - LTX 2.3 Fast ($0.03/s) and Veo 3.1 Lite ($0.05/s) are cheaper than Seedance 480p ($0.17/s).
   - Drafting was switched off by default today (migration 123), so this only matters once a project turns it on.
3. **Real faces.** Seedance refuses reference images of real human faces. If the production uses real actors' likenesses, Kling Omni or Happy Horse are the omni models to prefer. Which applies?
4. **Budget per finished minute.** At list prices a minute of Kling 3.0 at 1080p with audio is about $8.40. A minute of Seedance 2.5 at 1080p is about $51, and finishing it with Topaz to 4K adds about $12–18. Which quality tier does the first film target?
5. **Prices not confirmed.** BytePlus and Kling render their price pages in JavaScript, so those figures are second-hand. Also unconfirmed: Higgsfield, Leonardo, Magnific and Move AI per-model rates. Verify these in the vendor consoles before any budget is set against them.

### Recommended Direction

**Extend MuAPI first, add Topaz second, and retire Nano Banana now.**

1. **Now, before 2026-10-02:** remove the model from the three adapters (`nano-banana` on MuAPI and Meshy, `gemini_2.5_flash` on Runway) and from Meshy's draft tier, and migrate any pin to `nano-banana-2`.
2. **Next:** add the fifteen MuAPI models above to the MuAPI adapters, each probed for free, priced and contract-declared. Film Engine already holds the key, and this covers the high-scoring video and image tools on the page at or under list price. It gives the pipeline a cheap draft path (LTX 2.3), a flexible omni path (Kling 3.0 Omni) and a 4K path (Kling 3.0 4K), and changes nothing for a director who does not pick them.
3. **Then:** add a Topaz adapter for Starlight/Astra finishing. Final picture quality is where the page's scores separate most, and Topaz publishes prices that can be put in front of a director honestly.
4. **Defer** Luma, Magnific, Recraft and HeyGen until a shot or a decision needs them, and never wire Midjourney.

This serves the goal directly: a screenplay taken through every stage to a final movie, managed from Film Engine. Every stage from keyframe to finished master then has a generator to run on, reached through the MCP tools, priced before it spends.
