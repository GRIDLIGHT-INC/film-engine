# Epic: More generators behind one key, and a finish worth delivering

*Planned 2026-09-29 from [`ai-video-image-tools-api-brief.md`](ai-video-image-tools-api-brief.md), which summarises [`ai-video-image-tools-api-research.md`](ai-video-image-tools-api-research.md). User direction, verbatim: "Follow the recommendation". Held to the brief and to the code by `backend/tests/ai-tools-epic.test.js`.*

## Overview

The research found that almost every well-scored image and video tool can be driven by API, and that MuAPI, Film Engine's house provider, already carries most of them. What Film Engine lacks is the model entries, not the connection. It offers four MuAPI image models and the four Seedance 2.5 tiers, out of a catalogue of 655. This epic turns that catalogue into choices a director (and an agent) can make: Kling 3.0 with its omni and 4K variants, Veo 3 Fast, Happy Horse with references, Hailuo 2.3 Pro, Wan 2.6, LTX 2.3 as the cheapest draft, five more image models, lip-sync onto existing footage, and a frame and plate upscaler.

It also does two things with a date or a quality bar attached. Gemini 2.5 Flash Image ("Nano Banana") shuts down on 2026-10-02. Three adapters still offer it, and Meshy's draft tier names it, so it is retired first. Final picture quality is where the tools separate most, so a Topaz adapter adds Starlight Precise and Astra video finishing, with published prices, to the Upscale action built last week.

It serves the goal directly: a screenplay taken through every stage to a final movie, managed from Film Engine. Every new model is reached through the same funnel: `resolve()`, the meter, the budget gate, the free preview, the one confirmation, and the MCP tools. The end-to-end proof runs that path from a screenplay to a measured master.

## Business Goals
- **Nothing breaks on 2026-10-02**: no adapter, tier, price row or project pin points at a model that has shut down.
- **Choice at every price point**: a director can pick a draft model at a few cents a second, an omni model that takes references and audio, and a 4K model, each priced before it spends.
- **Lip-sync in the engine**: recorded or generated dialogue synced onto a clip without leaving Film Engine. Today `lipsync` has no hosted provider and the preflight reports it as finished in the NLE.
- **A delivery-grade finish**: video upscaled to the delivery size by the best-scoring upscaler, at a published price.
- **Agent parity**: every new model and action reachable over MCP the moment it is registered, with the reasoning staying in the connected agent.

## Current State
| Component | Current State |
|-----------|---------------|
| MuAPI video (`lib/providers/seedance.js`) | Seedance 2.5 at four tiers, video-edit tiers and four upscalers. The builder is Seedance-specific (workflow field maps) |
| MuAPI image (`lib/providers/muapi-image.js`) | `nano-banana-pro`, `nano-banana-2`, `nano-banana-2-lite`, `nano-banana` |
| Runway (`lib/providers/runway.js`) | 12 video models including Veo 3.1, Happy Horse 1.0, Hailuo 3, Seedance 2/2.5, Gemini Omni Flash; image includes `gemini_2.5_flash` |
| Meshy (`lib/providers/meshy.js`) | image list includes `nano-banana`; its draft tier in `lib/quality-tiers.js` is `nano-banana` |
| Rate book (`lib/provider-pricing.js`) | rows for `nano-banana` (MuAPI, Meshy) and `gemini_2.5_flash` (Runway) |
| Lip-sync | `lipsync` capability declared; only Gridlight serves it, and it is off by default; preflight reports "finished in the NLE" |
| Upscale | `post` on MuAPI: Seedance 4K finish, Topaz video upscale (older model), AI video upscaler (+Pro), FLUX.3; no frame or plate upscale |
| Topaz Starlight / Astra | not reachable (not on MuAPI) |
| MuAPI catalogue snapshot | `tests/fixtures/muapi-contract.json`, 655 models, checked 2026-08-31 |
| Brief claims | pinned by `tests/ai-tools-api-brief.test.js` |

## Target State
| Component | Target State |
|-----------|---------------|
| Retired model | Gone from every adapter, tier and rate row; any pin migrated to `nano-banana-2` and reported |
| MuAPI video | A generic model registry beside Seedance: each model with endpoint, probed field map, reference contract, `deliverableFrame`, hosting, meter and price |
| Video models offered | Kling 3.0 Pro, 4K and Omni; Veo 3 Fast; Happy Horse with references; Hailuo 2.3 Pro; Wan 2.6; LTX 2.3 (also the draft floor) |
| Image models offered | Seedream 5.0 Pro, Z-Image Turbo, GPT Image 2 on MuAPI, Imagen 4, Kling O3 image, plus the Nano Banana models that remain |
| Lip-sync | MuAPI serves `lipsync`: a shot's clip plus its dialogue in, a synced version out and selected |
| Frame and plate upscale | A frame or plate upscaled to the project resolution as a new version |
| Topaz | A `topaz` adapter serving Starlight Precise and Astra (video) and Gigapixel and Bloom (image), with published prices |
| Surfaces | Confirmation menus, the generator comparison, the canvas Upscale action and every MCP tool schema list the new models from `modelIdsFor` |
| Proof | A screenplay taken to a measured final master through MCP alone, on the new models |

## Constraints
- **Deadline**: Gemini 2.5 Flash Image shuts down on 2026-10-02, so its retirement ships first and on its own.
- **Probe before paying**: every new endpoint's accepted fields are read from a free validation refusal and recorded as a dated fixture, never assumed from a vendor page.
- **No server-side LLM**: no new tool or route may hand reasoning to a server-side LLM (`tests/mcp-no-server-llm.test.js`). The connected agent is the model.
- **One funnel**: every generation goes through `resolve()`, the meter, the budget gate and the one confirmation; no call site obtains an adapter elsewhere (`tests/ai-spend.test.js`).
- **Defaults do not move**: the house image standard (Nano Banana Pro at the project resolution) and each project's pinned providers stay as they are. New models are choices.
- **Deferred**: Luma Ray 3.2, Magnific, Recraft, HeyGen and Pika are out of scope until a shot or a decision needs them.
- **Never**: Midjourney is never wired; its terms forbid automated access and every reseller breaks them.
- **Real faces**: Seedance refuses reference images of real human faces; the omni alternatives (Kling Omni, Happy Horse) must say which they accept.
- **Price units**: MuAPI lists prices without a unit. Each price is confirmed with MuAPI's free cost-estimate endpoint before its rate row is trusted.

## Task Breakdown

### Phase 1: Retire the model that shuts down on 2026-10-02
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| AIT-001 | Retire Gemini 2.5 Flash Image | Remove `nano-banana` from lib/providers/muapi-image.js and lib/providers/meshy.js, and `gemini_2.5_flash` from lib/providers/runway.js. Replace Meshy's draft tier in lib/quality-tiers.js with a model that stays. Drop the retired rows in lib/provider-pricing.js. At boot, migrate any project `image_model` pin or app default that names it to `nano-banana-2`, and report each migration. A set-based test scans lib/ for the retired ids, so a new reference fails. | S | None |

### Phase 2: MuAPI's catalogue as choices
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| AIT-002 | Probe the fifteen endpoints | For each of the fifteen MuAPI endpoints in the brief's table, send a deliberately wrong-typed body and record the accepted fields, required fields and enums from MuAPI's free 422 as a dated fixture (`tests/fixtures/muapi-model-fields.json`). Refresh the catalogue snapshot with `tests/refresh-muapi-contract.js`. Confirm each price with MuAPI's free cost-estimate endpoint. No generation is bought. | M | None |
| AIT-003 | A MuAPI video model registry | Add a generic registry to the MuAPI adapter (lib/providers/seedance.js) beside the Seedance tiers. Each entry declares its endpoint, a field map read from the AIT-002 fixture, a reference contract (images, videos, audio, keyframes), `deliverableFrame`, duration limits and meter. Pictures and audio are hosted with `upload_file` as Seedance's are. `modelsByCapability.video` lists the entries; `describeVideoRequest`, `lib/video-cost.js` and the rate book price them. | L | AIT-002 |
| AIT-004 | Kling 3.0: pro, 4K and omni | Register `kling-v3.0-pro-image-to-video`, `kling-v3.0-4k-image-to-video` and `kling-v3.0-omni-pro-image-to-video` from the fixture. The omni entry declares element references and audio in its reference contract, so the shot's plates and recorded dialogue reach it. The 4K entry's `deliverableFrame` reaches 3840. Tested against the fixture: every field the builder sends is one MuAPI accepts. | M | AIT-003 |
| AIT-005 | Veo 3 Fast, Happy Horse, Hailuo and Wan | Register `veo3-fast-image-to-video`, `happy-horse-1-reference-to-video-1080p` (1 to 9 references), `minimax-hailuo-2.3-pro-i2v` (marked legacy upstream in its description) and `wan2.6-image-to-video`, each with its field map, reference contract, frame and price. | M | AIT-003 |
| AIT-006 | LTX 2.3 as the draft floor | Register `ltx-2.3-image-to-video` and make it the draft choice in `lib/draft-video.js` when a project turns drafting on and has not pinned a model. The draft note says what it costs against the delivery model. Drafting stays off by default. | S | AIT-003 |
| AIT-007 | Five more image models | Add `bytedance-seedream-5.0-pro`, `z-image-turbo`, `gpt-image-2-text-to-image`, `google-imagen4` and `kling-o3-image` to lib/providers/muapi-image.js, with their edit twins where MuAPI has one. Each gets its reference limit, `sizeControl`, prompt limit and rate row. The house image standard is unchanged; a chosen model wins. | M | AIT-002 |
| AIT-008 | Lip-sync onto existing footage | The MuAPI adapter serves `lipsync` through `sync-lipsync`: the shot's selected clip and its dialogue lines are hosted and sent, and the result is a synced version that becomes the selected clip, keeping its sound. It gets a free preview, the one confirmation and an MCP tool. The preflight stops reporting lip-sync as NLE-only when this provider is configured. | M | AIT-003 |
| AIT-009 | Upscale a frame or a plate | `topaz-image-upscale` upscales a storyboard frame or a reference plate to the project's resolution as a new version, archived and selectable like any other. It has a free preview with its price, the one confirmation, an action on the frame and plate viewers and the canvas, and an MCP tool. | M | AIT-002 |

### Phase 3: Finishing on Topaz
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| AIT-010 | A Topaz adapter | Add lib/providers/topaz.js serving `post` (Starlight Precise and Astra video upscaling) and image upscaling (Gigapixel and Bloom). Its API key is entered once for the machine, and its fields are probed free. It follows the async job handle and collect path, declares progress and cancel honestly, and prices from Topaz's published credit rates with source and date. `deliverableFrame` sizes the upscale to the delivery resolution. | L | None |
| AIT-011 | Topaz on the canvas and in the confirmation | The canvas Upscale action and the Video Shots Upscale button offer Topaz Starlight and Astra beside the MuAPI upscalers, each with its price. The frame and plate upscale offers Gigapixel and Bloom. `shot_upscale` and its preview list them. | M | AIT-010, AIT-009 |

### Phase 4: Surfaces, proof and records
| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| AIT-012 | Every new model on every surface | A set-based test over `modelIdsFor` for every adapter and capability. Each model is offered in the confirmation's model menu, priced in the generator comparison (with the same model shown across routes, so the cheapest route is visible), shown in the production graph's drawer, and listed by the MCP tool schemas that take a model. | M | AIT-004, AIT-005, AIT-006, AIT-007, AIT-008, AIT-009, AIT-011 |
| AIT-013 | Keep the brief and the catalogue honest | Move the models this epic registers from the brief's not-offered table to its offered table, so its test keeps passing. Add a test that fails when a registered MuAPI model disappears from the catalogue snapshot. Document the monthly refresh. | S | AIT-012 |
| AIT-014 | End-to-end proof to a final movie | Through MCP tools only, and with no server-side LLM: write a screenplay, break it into shots, generate frames on a new image model, and generate clips on a new omni video model with a cheap draft first. Then lip-sync recorded dialogue, finish on Topaz, conform, and measure the final movie for length, picture size and sound. Stubbed providers run in CI; one opt-in paid smoke per new family runs by hand with its cost recorded. | L | AIT-012 |
| AIT-015 | Guides and records | Update docs/claude-desktop-guide.md with the new tools and models, CLAUDE.md with a section and the new tests, and the Word production guide (scripts/make-canvas-guide.py) for the new Upscale and lip-sync actions. | S | AIT-014 |

## Open Questions
1. **Topaz account.** Topaz's API needs a key and a credit plan ($0.08 to $0.12 a credit depending on plan). Which plan? If no account is wanted, fal serves Starlight at about the same price with one key, at the cost of provenance reading "fal".
2. **Meshy's draft tier.** When `nano-banana` goes, should Meshy's draft tier become `nano-banana-2` or should the draft tier move off Meshy entirely, given Meshy returns about one megapixel whatever is asked?
3. **Real faces.** Which omni model is preferred for shots referencing a real actor's likeness, given Seedance refuses them: Kling 3.0 Omni or Happy Horse?
4. **Hailuo 2.3.** MiniMax has moved it to legacy upstream. Register it for its price and quality, or skip it in favour of Hailuo 3, already on Runway?
5. **The target cost per finished minute** for the first film, which decides the default model in the production tier.

## Success Metrics
- On 2026-10-02 no adapter, tier, price row or project references the retired model, and the scan test proves it.
- All fifteen MuAPI models are offered, each with a probed field map, a price confirmed by MuAPI's estimate, and a reference contract; `tests/ai-tools-api-brief.test.js` shows them as offered.
- A lip-synced clip and a Topaz-finished clip are produced in-engine, each priced before it spent.
- The end-to-end proof takes a screenplay to a measured final movie through MCP alone, green in CI.
- No new tool calls a server-side LLM, and every generation is metered and attributed.
