# ComfyUI and Film Engine — research

> **Status: closed 2026-09-28.** Jira GRD-4503 and its 27 tasks were marked Done and archived. Gridlight on AWS (GRD-4391) is the open-weight runtime, so a separate ComfyUI provider would duplicate it. The gaps named here belong in Gridlight agents; the editor ideas moved to [`production-graph-nodes-epic.md`](production-graph-nodes-epic.md).


*2026-09-28. Deep-research step 1: web and local findings. The synthesis, review and epic come after.*

**The question.** How does ComfyUI work? Where does it duplicate Film Engine? Where would using the two together raise productivity? Constraint from the goal: AI reasoning goes through MCP wherever it can.

**The short answer.** ComfyUI is not a competitor to Film Engine. It is a **local, open-weight generation backend** — a second kind of provider. Film Engine is the production system: screenplay, shots, continuity, spend, assembly. ComfyUI is a node-graph executor for diffusion models. It overlaps with Film Engine in exactly two places:
- the flows canvas, where both are typed DAGs;
- the paid providers it resells through Comfy Cloud "partner nodes".

Its real value is that it covers four things Film Engine cannot do today:
- lip-sync (today Gridlight is the only lip-sync provider);
- keyframe-to-keyframe video on Apache-licensed Wan 2.2, billed as GPU time rather than per second of output;
- temporal upscaling and frame interpolation;
- LoRA, IPAdapter, PuLID and ControlNet identity control.

It has to run on an NVIDIA box. This Mac Pro (Intel Xeon, AMD Vega II) cannot run it seriously. The user has confirmed an AWS instance can be spun up on demand.

---

## Web Findings

### How ComfyUI works
| Source | Key insight |
|---|---|
| [Workflow API format — docs.comfy.org](https://docs.comfy.org/development/api-development/workflow-api-format) | There are **two JSON formats**. The UI "Save" format carries positions and links. The **API format** is `{node_id: {class_type, inputs}}`, and it is the only one `/prompt` accepts. A UI export will not queue without conversion. |
| [Comfy-Org/ComfyUI — DeepWiki](https://deepwiki.com/Comfy-Org/ComfyUI), [Technical deep dive — Medium](https://medium.com/@mucahitceylan/comfyui-a-technical-deep-dive-into-the-ultimate-stable-diffusion-workflow-engine-df1a7db3f7f5) | An aiohttp `PromptServer` plus a `PromptExecutor` run the graph in topological order. **Per-node caching** hashes each node's inputs and recomputes only what is downstream of a change. Film Engine instead fingerprints the whole assembled payload per artefact. |
| [ComfyUI-Manager](https://github.com/comfy-org/ComfyUI-Manager) | The custom-node "app store", with a CLI (`comfy node install`). Custom nodes are unsandboxed Python, break often on core updates, and a workflow that needs a missing node fails validation (`node_errors`). |
| [Comfy Desktop releases](https://github.com/Comfy-Org/desktop/releases) | Relaunched June 2026 with isolated installs (each with its own Python and PyTorch), snapshots and one-click updates. It is a way to install ComfyUI, not a way to integrate with it. |

### The server API
[ComfyUI server routes — docs.comfy.org](https://docs.comfy.org/development/comfyui-server/comms_routes) (authoritative):
- `POST /prompt` returns `{prompt_id, number}`, or a 400 with `{error, node_errors}`.
- `GET /history/{prompt_id}` returns the outputs.
- `GET /view?filename&subfolder&type` returns a file.
- `POST /upload/image` and `POST /upload/mask` accept media.
- `GET /object_info[/{class}]` returns the node library, which tells you what an install can actually run.
- `GET /queue` shows the queue and `POST /interrupt` stops a run.
- The websocket `/ws?clientId=` carries `status`, `execution_start`, `executing`, `progress`, `executed`, `execution_cached` and `execution_error`.
- There is **no authentication.**

### Comfy.org platform and MCP
| Source | Key insight |
|---|---|
| [Comfy MCP — docs.comfy.org](https://docs.comfy.org/agent-tools/mcp), [comfy.org/mcp](https://comfy.org/mcp/) | **An official MCP server exists (`comfy-mcp`).** The local connection is open source; the cloud connection is `https://cloud.comfy.org/mcp` with OAuth or an API key. It has tools for templates, model and node search, workflow submission, `partner_generate`, job status and batches. Clients include Claude Desktop and Claude Code. It is in public beta, and cloud outputs need a separate download step. |
| [Partner node pricing — docs.comfy.org](https://docs.comfy.org/tutorials/partner-nodes/pricing) | Comfy Cloud resells Runway, Kling, Veo, Luma, Seedance, LTX, Hailuo, Wan, Flux, Meshy, Tripo, Hunyuan3D and ElevenLabs as credit-billed "API nodes". **This is nearly the same roster Film Engine already calls directly**, but with a markup and outside Film Engine's meter and budget gate. |

### Video and film capabilities
| Source | Key insight |
|---|---|
| [Wan 2.2 — GitHub](https://github.com/Wan-Video/Wan2.2), [Wan 2.2 tutorial](https://docs.comfy.org/tutorials/video/wan/wan2_2), [FLF2V workflow](https://comfy.org/workflows/video_wan2_2_14B_flf2v-7016f027bcf1/) | Wan 2.2 is **Apache-2.0**. `WanFirstLastFrameToVideo` fixes the first and last frames as hard boundary conditions, which is the same job `lib/video-sequence.js` does with Runway and Seedance first/last keyframes. |
| [LTX 2.3 vs Hunyuan vs Wan — ltxworkflow](https://ltxworkflow.com/blog/ltx-2-3-vs-hunyuanvideo-vs-wan2-2-comparison-2026), [LTX blog](https://ltx.io/blog/best-open-source-video-generation-models) | HunyuanVideo 1.5 (8.3B, about 14GB with offload) is under the **Tencent Community License**, which caps commercial use at 100M MAU. LTX 2.3 generates audio and video jointly and is 3–4× faster. AnimateDiff is legacy. |
| [Consistent characters — RunComfy](https://learn.runcomfy.com/create-consistent-characters-with-controlnet-ipadapter) | The community has settled on PuLID or IPAdapter for identity, ControlNet for pose and structure, and a LoRA for a recurring character. |
| [LatentSync wrapper](https://github.com/ShmuelRonen/ComfyUI-LatentSyncWrapper), [Wav2Lip](https://github.com/ShmuelRonen/ComfyUI_wav2lip) | Local lip-sync, with MuseTalk as a third option. **Film Engine has no working lip-sync provider.** |
| [SeedVR2](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler), [Frame interpolation (RIFE/FILM)](https://github.com/Fannovel16/ComfyUI-Frame-Interpolation) | Temporally stable video upscaling, plus interpolation: RIFE in general, FILM for large motion. Upscale first, then interpolate. |
| [TTS-Audio-Suite](https://github.com/diodiogod/TTS-Audio-Suite), [Flux Kontext](https://comfyui.org/en/flux-kontext-ai-image-editing-workflow) | Local TTS, and natural-language image editing. Both overlap with ElevenLabs and with Film Engine's recompose/refine. |

### Hardware
| Source | Key insight |
|---|---|
| [PyTorch macOS x86 deprecation](https://dev-discuss.pytorch.org/t/pytorch-macos-x86-builds-deprecation-starting-january-2024/1690), [pytorch#114602](https://github.com/pytorch/pytorch/issues/114602) | **There are no Intel-Mac PyTorch wheels after 2.2.** Current Wan, Flux and SeedVR2 nodes assume PyTorch 2.4 or later. |
| [Apple Metal PyTorch](https://developer.apple.com/metal/pytorch), [PyTorch forums](https://discuss.pytorch.org/t/mps-support-for-intel-macs-with-metal-3-compatible-amd-graphics-cards/164041) | MPS nominally supports AMD GPUs, but only on the frozen 2.2 stack. |
| [MPS lowvram PR](https://github.com/Comfy-Org/ComfyUI/pull/15998), [workflowlab.dev](https://www.workflowlab.dev/deploy/comfyui-mac-apple-silicon-mps-speed) | Even Apple Silicon is 3–5× slower than NVIDIA. A 6-step HunyuanVideo clip took about 16 minutes on an M3 Pro. |

**Verdict on this machine:** it cannot seriously run the video models. It should use an AWS instance.

### AWS and hosted GPUs
| Source | Key insight |
|---|---|
| [aws-samples/cost-effective-aws-deployment-of-comfyui](https://github.com/aws-samples/cost-effective-aws-deployment-of-comfyui) | AWS's reference setup: ECS on EC2 with a default **g6e.2xlarge (L40S)**. It **scales to zero** after 60 minutes idle and supports spot. AWS estimates about $80/month at 2 h/day on spot. Models live on an EBS volume, with no automatic snapshots. Access goes through an ALB with Cognito and WAF. |
| [comfyui-on-amazon-sagemaker](https://github.com/aws-samples/comfyui-on-amazon-sagemaker), [SageMaker Processing blog](https://aws.amazon.com/blogs/machine-learning/running-comfyui-workflows-on-amazon-sagemaker-ai-processing-jobs/) | Endpoint and batch patterns. These suit a render farm better than per-shot calls. |
| [YanWenKun/ComfyUI-Docker](https://github.com/YanWenKun/ComfyUI-Docker), [ai-dock/comfyui](https://github.com/ai-dock/comfyui) | Maintained images (`cu126-slim`). ai-dock adds authentication and S3 output upload through environment variables. |
| [DevZero g5](https://www.devzero.io/instances/aws/g5.xlarge) / [g6](https://www.devzero.io/instances/aws/g6.xlarge) / [g6e](https://www.devzero.io/instances/aws/g6e.xlarge), [DoiT spot](https://compute.doit.com/spot/us-east-1/g5.xlarge), [Holori](https://calculator.holori.com/aws/ec2/g6.xlarge) | On-demand in us-east-1: g5.xlarge (A10G, 24GB) **$1.006/h**, g6.xlarge (L4, 24GB) **$0.805/h**, g6e.xlarge (L40S, 48GB) **$1.861/h**. Spot runs roughly 40–70% below that. |
| [willitrunai](https://willitrunai.com/blog/wan-2-2-vram-requirements), [localaimaster](https://localaimaster.com/blog/wan-vram-requirements-by-gpu) | Wan 2.2 14B at FP16 needs 54–80GB. The official FP8 checkpoints fit **24GB**. 24GB is the entry point; 48GB is comfortable. |
| [RunPod pricing](https://www.runpod.io/pricing), [Modal via computeprices](https://computeprices.com/providers/modal), [Spheron](https://www.spheron.network/blog/runpod-h100-pricing-2026/) | RunPod: 4090 at $0.34–0.74/h, L40S at $1.09/h, per-second billing, 20–60 s serverless cold start. Modal: L40S at about $1.95/h with 2–4 s cold starts. |

**No sourced cost per generated second of video was found.** One unverified guess puts a 5 s 720p Wan clip at about 3 GPU-minutes, which would be about $0.09 on a g6e, against $0.85 for a 480p Seedance clip. **That has to be measured before it drives any decision.**

### Integration precedents
| Source | Key insight |
|---|---|
| [Krita AI Diffusion](https://github.com/Acly/krita-ai-diffusion) | One `Connection` interface covers managed-local, external and cloud ComfyUI. The app turns the user's intent into a ComfyUI graph, and **the user never sees that graph**. This is the right shape for Film Engine. |
| [comfy-pack / BentoML](https://www.bentoml.com/blog/comfy-pack-serving-comfyui-workflows-as-apis) | A workflow is worthless without its exact nodes and models, so comfy-pack bundles them. This is the same class of problem as fingerprint drift. |
| [ComfyDeploy](https://www.comfydeploy.com/), [ViewComfy](https://www.viewcomfy.com/), [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) | Each turns a workflow into a versioned, typed API. ComfyUI sits behind them as an implementation detail. |
| [SaladTechnologies/comfyui-api](https://github.com/SaladTechnologies/comfyui-api) | Resolves input URLs and base64 before handing the job to ComfyUI, returns results synchronously or through a webhook or S3, and scales on queue depth. It is a template for the adapter. |
| [Series Entertainment case study — blog.comfy.org](https://blog.comfy.org/p/case-study-how-series-entertainment) | Four pipelines for Netflix titles, with claims of "180× faster" and 15+ minutes of finished video a week. It is vendor-published, so treat the numbers as marketing. |
| [3D movie pipeline — RunComfy](https://www.runcomfy.com/comfyui-workflows/3d-movie-pipeline-in-comfyui-ai-3d-scene-to-video-workflow), [AIMovieStudiov2](https://github.com/Heroesjouney/AIMovieStudiov2) | Previs passes (depth, clay renders) turned into video through ControlNet, and a small open project that tries to be Film Engine built ComfyUI-first. |

### Licensing
[ComfyUI LICENSE](https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE), [discussion #3804](https://github.com/Comfy-Org/ComfyUI/discussions/3804):
- ComfyUI's core is **GPL-3.0**. Calling it over HTTP as an unmodified, separate service does not make Film Engine a derivative work. That reading comes from community discussion, not a legal ruling. Embedding or forking ComfyUI would change it.
- Film Engine is MIT. **Never vendor ComfyUI's code into the repo.**
- Each model's licence applies on its own terms, separately from ComfyUI's:

| Model | Licence |
|---|---|
| Wan 2.2 | Apache-2.0 |
| HunyuanVideo | Tencent Community License, 100M MAU cap |
| Flux-dev | non-commercial |

---

## Local Findings

**No ComfyUI prior art.** The string `comfy` appears nowhere in the repo, apart from this document.

### The adapter slot ComfyUI would use
- **Autoload.** `backend/lib/providers/index.js` (lines 26–44) registers any `*.js` in the providers directory that exports `adapter`, so adding `comfyui.js` needs **no edit to the registry**.
- **Interface.** `backend/lib/providers/base.js` (lines 1–31) documents the adapter interface. `CAPABILITIES` (line 42) has 11 entries.
- **ComfyUI would serve the existing `image`, `video`, `lipsync` and `post` capabilities**, so none of the twelve capability registries needs to change.

### Two adapters to model it on
- **`backend/lib/providers/gridlight-adapter.js` — an opt-in local gateway.**
  - `requiresKey: false`.
  - It is switched on by `localGatewayEnabled()` (`index.js` lines 204–227).
  - Its video path is `lib/gridlight-video.js`: it reads the gateway's model list from `GET /media/capabilities`, caches it for a minute, and runs one video at a time (`serialised()`).
  - That model-list reader is the template for reading ComfyUI's `/object_info`, and the one-at-a-time queue fits ComfyUI, which also runs a single queue.
- **`backend/lib/providers/fluidsynth.js` — a keyless local executable.**
  - Its `available()` is synchronous and returns `{ok, reasons, fixes}`.
  - `isProviderConfigured` (`index.js` lines 450–488) calls `available()` synchronously. **A ComfyUI adapter must therefore cache its health probe**, or be switched on by a setting.
  - For a `base_url`, the `connection.fields` hook exists in `routes/providers.js` and no adapter uses it yet.

### Async jobs survive the 60-second MCP window
- `backend/lib/generation-jobs.js` has `budgetFor`, `collect` and `pending`.
- `withJobRecording_` (`providers/index.js` lines 667–744) wraps any adapter declared async.
- ComfyUI's `prompt_id` becomes the job handle, and `/history` plus `/view` is how the result is collected.
- The model to follow is `backend/lib/providers/bfl-image.js` (lines 117–190).

### Metering
- `backend/lib/provider-pricing.js` has a check at load (`assertCoverage`, line 686) that **refuses to boot** if any adapter and capability pair has no price.
- A ComfyUI adapter therefore needs a `comfyui:*` row marked `self_hosted` at $0, like `gridlight:*` and `fluidsynth:music`.
- `film_cost_entries.gpu_seconds` exists (migration `037_budget_tracking.sql`) and nothing fills it automatically. That column is where the real cost of an AWS GPU belongs.

### The one blocker: the image house standard
- In `backend/lib/providers/index.js` (lines 264–276), when resolving an image provider, the **house standard (Nano Banana Pro through MuAPI, then Google, then Meshy) overrides every project pin**. So a project pinned to `comfyui` for images is ignored whenever one of those three has a key.
- `backend/lib/image-fallback.js` (lines 141–146) filters the fallback chain down to those standard vendors in the same way.
- **Video, lip-sync and post are not constrained**, so ComfyUI can be used there with no conflict with the house rule.

### The flows engine versus a ComfyUI graph
- `backend/lib/flow-node-types.js` has **23 node types** and 8 port types.
- One Film Engine node is **one whole capability call**. ComfyUI's nodes are much finer: a model loader, a sampler, a VAE decode, a LoRA, a ControlNet.
- **A ComfyUI workflow belongs *inside* one `gen.*` node**, as the provider's private graph. It should not appear on Film Engine's canvas.
- No change to the MCP tools is needed. `node_gen_video` with `config.provider: 'comfyui'` already reaches it (`lib/mcp-tools.js`, line 5298).

### A ledger that is waiting to be filled
- The table is created in `backend/db/migrations/011_render_ledger.sql`. It has columns for seed, sampler, steps, guidance, `lora_ids`, `controlnets` and `model_hash`.
- `routes/storyboard.js` (`logToRenderLedger`) never writes sampler, ControlNets or the model hash.
- `routes/video-gen.js` hard-codes the sampler as `'euler_a'`.
- **ComfyUI would be the first real source of these fields.** The "locked" mode, which recreates a render exactly, only becomes meaningful with a seed-exact local model.

### LoRA leftovers
- `backend/lib/storyboard-prompt.js` (lines 570–574) and `routes/characters.js` emit A1111-style `<lora:id:0.8>` text into prompts.
- `backend/lib/video-prompt.js` sets `lora_ids`.
- Neither ComfyUI nor any current provider reads either one. The columns `film_characters.lora_id` and `ti_token` come from migration `005`.

### Existing plans already ask for this
- `docs/plans/consistency-system.md` proposes DreamBooth/LoRA training, IP-Adapter and ControlNet (OpenPose, Depth, Canny). None of it is built.
- `lib/scheduling-engine.js` already has `MODEL_PROFILES`, which records VRAM and load time for GPU residency. It was written for this situation.

### Architecture decisions
- **ADR-002 (no frameworks).** There is **no `ws` package**. Poll `/history`, or use Node's global `WebSocket` (Node 22 or later).
- **ADR-003.** Progress to the page goes over SSE.
- **ADR-004.** The Gridlight proxy pattern: a service URL from the environment, and a 503 when the box is off, which is a normal state.
- **ADR-007.** ffmpeg is the precedent for a declared local executor.

---

## Key Ideas & Themes

1. **ComfyUI is a provider, not a competitor.**
   - It plugs in as `lib/providers/comfyui.js`, reached over HTTP: `/prompt`, then `/history`, then `/view`.
   - Film Engine keeps the screenplay, continuity, the budget gate, the meter, fingerprints and the conform.
   - The director never sees a ComfyUI graph (the Krita pattern).
   - This also keeps the GPL boundary clean.
2. **Where they duplicate.**
   - Comfy Cloud partner nodes resell Runway, Seedance, Kling, ElevenLabs and Meshy. Film Engine already calls them directly, with metering and budget gates. **Do not route paid providers through Comfy Cloud.**
   - Flux Kontext overlaps recompose/refine, and TTS overlaps ElevenLabs.
   - ComfyUI's graph editor overlaps the flows canvas, at a much finer grain.
3. **Where the two together are a real step up in productivity.**
   1. **Lip-sync.** LatentSync or MuseTalk would give Film Engine its first working lip-sync provider, closing a known pipeline gap.
   2. **Keyframe-to-keyframe video on Wan 2.2 with FLF2V.**
      - It does the same job as `video-sequence.js`, under Apache-2.0, billed as GPU time.
      - Previs depth and pose passes can feed ControlNet directly. Today camera motion reaches the model only as words.
   3. **A finishing pass.** SeedVR2 upscaling plus RIFE interpolation after the 480p draft, instead of a paid 4K pass.
   4. **Identity.** A LoRA or PuLID per character would make the dormant `lora_id` column and the ledger's LoRA and ControlNet columns real.
   5. **Reproducibility.** An exact seed and sampler turn the render ledger's "locked" mode from a promise into a fact.
4. **MCP.** Comfy.org ships an official `comfy-mcp`, and Claude Desktop can attach it beside Film Engine's server.
   - Use it for **discovery and authoring**: searching templates, models and nodes, and building a workflow.
   - Do **not** use it to generate production shots. It bypasses Film Engine's meter, budget gate and asset registry.
   - Generation goes through Film Engine's adapter, so the existing `node_gen_*` and `video_generate` tools cover it with no new tool.
5. **Compute lives on AWS, not this Mac.**
   - Intel-Mac PyTorch is frozen at 2.2 and the GPUs are AMD.
   - Use a g6.xlarge or g5.xlarge (24GB, Wan FP8) for about $0.8–1.0/h, or a g6e.xlarge (48GB) for $1.86/h. Spot costs less.
   - Follow the AWS sample: scale to zero when idle, keep models on EBS or S3, and reach the box through an SSM port-forward or a private security group. ComfyUI has no authentication, so it must never be exposed publicly.
   - A cold start with multi-GB models is the main source of delay.
   - Record `gpu_seconds` so the budget gate sees the real cost of the instance.
6. **Fragility is the real cost.** A workflow is only valid together with its exact custom nodes and model files. Treat each workflow like a provider contract:
   - version the workflow template in the repo;
   - check `/object_info` before submitting, the way `gridlight-video.js` does;
   - refuse a missing node by name as a `PRECONDITION`, rather than hanging.
7. **The decisions a person must make before the epic.**
   - Whether ComfyUI may generate images at all, which means relaxing the house standard or keeping it for video, lip-sync and post only.
   - Which GPU host to use: EC2 scale-to-zero, RunPod or Modal.
   - Which licences to accept: HunyuanVideo's MAU cap, and Flux-dev being non-commercial.
   - Measure one Wan clip on a g6e for its real cost per second before claiming it saves money.
