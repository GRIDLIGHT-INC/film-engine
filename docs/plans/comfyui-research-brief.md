# Research Brief: ComfyUI and Film Engine — integrate, not replace

> **Status: closed 2026-09-28.** Jira GRD-4503 and its 27 tasks were marked Done and archived. Gridlight on AWS (GRD-4391) is the open-weight runtime, so a separate ComfyUI provider would duplicate it. The gaps named here belong in Gridlight agents; the editor ideas moved to [`production-graph-nodes-epic.md`](production-graph-nodes-epic.md).


*2026-09-28. Compiled from [`comfyui-integration-research.md`](comfyui-integration-research.md), which holds the sources, URLs and file citations. The facts below were re-checked against the code on the same day.*

### Executive Summary
ComfyUI is a node-graph runtime for open-weight diffusion models. Film Engine is a production system: screenplay, shots, continuity, spend and assembly. They are not substitutes.

ComfyUI earns a place as **one more provider behind Film Engine's single funnel**. That brings it under the meter, the budget gate, fingerprints, the job handles that survive the 60-second MCP window, and the asset registry. It fills gaps the current roster cannot:
- a real lip-sync provider;
- keyframe-to-keyframe video on Apache-licensed Wan 2.2;
- temporal upscaling and frame interpolation;
- LoRA, PuLID and ControlNet identity control;
- exact, reproducible renders.

It must run on an NVIDIA GPU host (AWS), because this Intel/AMD Mac Pro cannot run current PyTorch.

### Key Themes
- **Provider, not platform.** ComfyUI graphs live *inside* one `gen.*` call. The director never sees them (the Krita AI Diffusion pattern). This also keeps the GPL-3.0 boundary clean, because it is reached over HTTP and never vendored.
- **Most of what Comfy.org sells, Film Engine already has.**
  - Comfy Cloud partner nodes resell Runway, Seedance, Kling, ElevenLabs and Meshy with a credit markup, outside Film Engine's meter.
  - Flux Kontext overlaps recompose/refine. TTS overlaps ElevenLabs. The graph editor overlaps the flows canvas at a finer grain.
- **The value is open-weight, locally controlled generation.** That means Wan, LatentSync, SeedVR2 and RIFE, with fixed seeds, LoRAs and ControlNet. No hosted provider exposes those controls.
- **Fragility, not compute, is the real cost.** A workflow only works with its exact custom nodes and model files. It has to be treated as a versioned contract checked against `/object_info`, the way `gridlight-video.js` already checks the gateway's model list.
- **Compute is elastic and remote.**
  - AWS g6/g5 (24GB): Wan FP8 fits, about $0.8–1.0/h on demand.
  - AWS g6e (48GB): about $1.86/h.
  - Scale to zero when idle. ComfyUI has no authentication, so reach it only over SSM or a private network.
- **MCP stays the reasoning path.** Comfy.org's official `comfy-mcp` is useful for authoring and discovery beside Film Engine's own server. Production generation still goes through Film Engine's adapter, reached by the existing `node_gen_*` and `video_generate` tools with no new tool.

### Top Ideas & Opportunities
1. **Lip-sync that actually runs** (LatentSync, or MuseTalk for speed).
   - *Why:* `lipsync` is served by **Gridlight only** (`gridlight-adapter.js:43`), so the pipeline's lip-sync stage has no working provider.
   - *Apply:* a `comfyui` adapter serving `lipsync`, taking `video_raw` plus `audio_dialogue` and producing `video_synced`. This closes a stage in the screenplay-to-final-film acceptance criterion.
2. **Wan 2.2 first/last-frame video between approved keyframes.**
   - *Why:* it is the same job `lib/video-sequence.js` buys from Runway and Seedance, but Apache-2.0 and billed as GPU time.
   - *Apply:* `video` capability with `maxKeyframes: 2`. The in-betweens strip and the sequence planner feed it unchanged.
3. **A local finishing pass** (SeedVR2 upscale, then RIFE/FILM interpolation).
   - *Why:* a 480p draft can reach 4K without paying the provider's 4K rate. The `post` capability today is served only by Seedance and Gridlight.
   - *Apply:* `post` sub-types `upscale` and `interpolate` through the adapter.
4. **Previs geometry into the video model.**
   - *Why:* camera and blocking reach providers only as words today, while previs already produces depth and pose.
   - *Apply:* depth and OpenPose ControlNet on Wan/VACE, fed from the previs stage (the RunComfy 3D-movie-pipeline precedent).
5. **Identity through a character LoRA or PuLID.**
   - *Why:* `film_characters.lora_id` exists and **no provider reads it**. The `<lora:…>` text in prompts is ignored everywhere.
   - *Apply:* a character's LoRA or PuLID reference fed to the ComfyUI graph as the identity input. The consistency plan in `consistency-system.md` becomes real.
6. **A render ledger that tells the truth.**
   - *Why:* `render_ledger` has columns for seed, sampler, LoRAs and ControlNets. The sampler is either unwritten or hard-coded to `euler_a`.
   - *Apply:* the adapter records the true seed, sampler, steps, CFG, model hash, LoRAs and ControlNets. The "locked" mode, which recreates a render exactly, becomes a fact.
7. **GPU cost visible to the budget gate.**
   - *Why:* self-hosted calls write no cost entry, and `usage-meter.js` hard-codes `gpu_seconds = 0`. A GPU that bills by the hour would be invisible.
   - *Apply:* meter GPU seconds per job and price them at the instance's own rate.

### Technical Approaches
- **The adapter.** `backend/lib/providers/comfyui.js` is autoloaded, so there is no registry edit.
  - Opt-in like Gridlight: `requiresKey: false`, with a `base_url` connection field.
  - `available()` returns a **cached** probe of `/system_stats`, because `isProviderConfigured` calls it synchronously.
  - `asyncGeneration: true`. `POST /prompt` returns `prompt_id`, which becomes the job handle (`onHandle`). Results come from polling `/history/{id}` under `budgetFor()`, and `collect()` then fetches files through `/view`.
  - Poll rather than open a websocket, because ADR-002 rules out a `ws` dependency. Progress is relayed as SSE (ADR-003).
- **Workflows are contracts.**
  - Versioned API-format templates live in the repo, one per capability or workflow, each declaring the node classes and model files it needs.
  - Before submitting, the adapter checks `/object_info` (cached, as `gridlight-video.fetchCapabilities` does). A missing node or model is refused by name as a `PRECONDITION`, never left to hang.
  - A set-based test holds every template's declared requirements to the nodes it actually references.
- **Payload.** The payload builders fill template "slots": prompt, seed, keyframes uploaded through `/upload/image`, audio, LoRA and ControlNet inputs. `capability-payloads.js` remains the single path, so preview and purchase stay the same payload.
- **Registries a new adapter must satisfy.**
  - A `comfyui:*` row in `provider-pricing.js`, or `assertCoverage` refuses to boot.
  - `PREFERRED_WHEN_CONFIGURED` is left alone, because ComfyUI should be reached by an explicit pin.
  - Readiness and preflight report the host as unreachable in words, following the ADR-004 "the GPU box is off" precedent.
- **Host.** Follow `aws-samples/cost-effective-aws-deployment-of-comfyui`: ECS on EC2 or a single instance, scale to zero when idle, models on EBS with snapshots or in S3, SSM port-forward, and no public port.
  - Image: `yanwk/comfyui-boot:cu126-slim`, or ai-dock, which adds authentication and S3 output.
  - A start/stop helper lets Film Engine wake the box on the first ComfyUI job.
- **Cost.** The adapter reports its wall-clock GPU time. A new `gpu_rate_usd_per_hour` setting prices it into `film_cost_entries`, so the 402 gate sees it.
- **Discovery over MCP.** Document attaching `comfy-mcp` beside Film Engine in `docs/claude-desktop-guide.md`, for finding templates, models and nodes. Film Engine gains no tool that proxies generation through comfy-mcp.

### Open Questions
1. **Images.** Should ComfyUI be allowed to generate images? The house standard (`providers/index.js:264-276`, `image-fallback.js:141-146`) overrides every non-Nano-Banana pin today. Options:
   - (a) keep ComfyUI to video, lipsync and post, with no conflict;
   - (b) allow an explicit per-project pin to override the standard for LoRA/ControlNet work.
2. **GPU host.** EC2 scale-to-zero (cheapest when used steadily, slow cold start) vs RunPod (from $0.34/h, per-second billing) vs Modal (2–4 s cold starts at a higher hourly rate).
3. **Model licences.** Wan 2.2 (Apache-2.0) is safe. HunyuanVideo is capped at 100M MAU under the Tencent licence. Flux-dev is non-commercial. Which may production use?
4. **Real cost per second.** No source gives a measured $/s. One Wan FLF2V 5 s 720p clip must be timed on a g6e before anything claims to beat Seedance ($0.85 per 5 s clip at 480p).
5. **Custom-node trust.** Custom nodes are unsandboxed Python. Should the host be pinned to an allowlist of reviewed node packs at fixed commits?
6. **LoRA training.** Should training a character LoRA happen in Film Engine (a job on the GPU host), or outside it and simply be registered?

### Recommended Direction
**Integrate ComfyUI as an opt-in, self-hosted provider for the capabilities the roster lacks. Do not adopt it as a second front end, and do not route paid providers through Comfy Cloud.**

Order of work:
1. **Stand up a g6e (or g6) host with scale-to-zero, and measure one Wan FLF2V clip and one LatentSync pass.** This gives real speed and $/s before any code commits to them.
2. **Build the adapter core and one contract**: health probe, `/object_info` check, the async handle, upload and collect, the rate row, GPU-seconds metering and the ledger fields.
3. **Lip-sync first.** It is the only pipeline stage with *no* working provider, so it moves the screenplay-to-final-film acceptance criterion directly.
4. **Then Wan FLF2V for sequences, then the SeedVR2/RIFE finishing pass.** Both reuse existing planners unchanged.
5. **Leave the image house standard in place** until the user decides question 1.
6. **Identity (LoRA/PuLID) and previs ControlNet come last.** They are the most valuable long-term and the most fragile.

**Why this direction:**
- It adds capability where Film Engine is weakest without duplicating what already works.
- It keeps every spend visible to the budget gate.
- It respects the MCP-first rule: reasoning stays in the connected agent, and generation stays in the metered funnel.
- It is reversible: an unconfigured adapter changes nothing for any existing project.
