# Research: A Flows-style Visual Canvas for Film Engine

**Status:** Research / recommendation — no implementation committed
**Date:** 2026-08-13
**Question:** Artlist Flows ships a node-based AI creative canvas. What would it take to build the equivalent in Film Engine, and should we reuse NeonCore's canvas?

---

## 1. What Artlist Flows actually is

From the three product screenshots and the surrounding landscape, Flows is a **node-based media dataflow canvas**. Three claims carry the product:

| Screenshot | Claim | What it implies technically |
|---|---|---|
| "Build AI flows and create at scale" | Custom workflows or pre-built flows, run as many times as you need | The graph is a **reusable template**, decoupled from any one asset |
| "Build your own flow" | Connect prompts, models, and assets on a visual canvas. Save it once, reuse it across every project | Graph is **portable across projects**; nodes are typed (T = text, image, video badges visible on the node handles) |
| "Start from a template" | Ready-made flows: multi-model video, image, character sheets | A **template library**, and multi-model means the model is a node parameter, not a global setting |
| "Run in parallel" | One click generates your entire campaign. Every output, every variant, at the same time | **Fan-out is a first-class primitive**, not a for-loop the user writes |

The canvas toolbar in the hero shot shows: select, hand/pan, text, image, zoom %, and a **Stop Flow** button — i.e. the graph is a live execution surface, not just a diagram.

This is a category, not a one-off. [ElevenLabs Flows](https://elevenlabs.io/flows), [Higgsfield Canvas](https://higgsfield.ai/canvas-intro), [Runway Workflows](https://alternativeto.net/news/2025/10/runway-launches-node-based-workflows-for-building-custom-ai-creative-pipelines), and [Flowy](https://tryflowy.ai/) all shipped the same shape in the last year. Artlist's own positioning ([$260M ARR, repositioning around AI](https://www.prnewswire.com/news-releases/finishing-2025-at-260m-arr-artlist-unveils-the-future-of-ai-video-production-with-a-full-scale-ai-ecosystem-302668327.html)) frames Flows as the on-ramp to Artlist Studio.

**The insight worth stealing:** these products all discovered that a fixed pipeline is a ceiling. The value isn't the pretty graph — it's that the user, not the vendor, decides the topology.

---

## 2. What Film Engine already has

Film Engine is further along than it looks. The relevant machinery:

### 2.1 A dependency-resolved DAG already exists

`backend/lib/pipeline-engine.js:11-21` defines the 9-step graph:

```js
{ id: 'keyframe', depends: [],                              scope: 'shot'  },
{ id: 'video',    depends: ['keyframe'],                    scope: 'shot'  },
{ id: 'voice',    depends: [],                              scope: 'shot'  },
{ id: 'lipsync',  depends: ['video', 'voice'],              scope: 'shot'  },
{ id: 'music',    depends: [],                              scope: 'scene' },
{ id: 'sfx',      depends: [],                              scope: 'shot'  },
{ id: 'ambient',  depends: [],                              scope: 'scene' },
{ id: 'post',     depends: ['lipsync'],                     scope: 'shot'  },
{ id: 'assembly', depends: ['post','music','sfx','ambient'], scope: 'shot' },
```

with `getNextSteps()`, `canRunStep()`, `buildStepPlan()`, retry backoff, and `autoSkipSteps()`. This is a real topological executor — it is just **hard-coded and unauthorable**. There is no table, no API, and no UI that lets a user change `depends`.

### 2.2 The step executor is already generic

`backend/routes/pipeline.js:107-133`:

```js
const capability = STEP_CAPABILITY[stepId];
const result = await resolveGenerator(capability, config).generate(capability, payload);
```

Step → capability → provider adapter. Nothing in that line cares that there are exactly nine steps. **A node executor is a rename of this function**, not a rewrite.

### 2.3 A pluggable provider layer

`lib/providers/base.js:35` declares 11 capabilities — `llm, image, video, music, voice, sfx, ambient, lipsync, post, model3d, stock` — resolved per-project → env → default, with adapters auto-loaded by filename (`providers/index.js:31-44`). Runway, ElevenLabs, OpenAI, Meshy, and Gridlight adapters ship today. **"Multi-model" — Flows' headline — is already solved at the backend.** It just isn't exposed per-node.

### 2.4 Pure, node-shaped transform libraries

`lib/audio-mixer.js`, `lib/video-stitcher.js`, `lib/storyboard-prompt.js`, `lib/video-prompt.js`, `lib/music-prompt.js`, `lib/dialogue-builder.js`, `lib/threed-prompt.js` are all pure functions with unit tests. These drop into a node executor unchanged.

### 2.5 Run persistence with a status machine

`film_pipeline_runs` (migration 026) already stores `status ∈ {pending, running, paused, complete, failed, cancelled}`, `steps_completed/remaining/failed` as JSON, `progress_pct`, and `params`. Pause/resume/cancel routes exist. The **Stop Flow** button in the Artlist hero has a backend already.

---

## 3. The four real gaps

Everything above is a foundation. The gaps are specific:

### Gap 1 — Data flows through the database, not through edges *(the hard one)*

In Flows, an edge **carries a value**: this image is the init_image for that video node. In Film Engine, `executeStep` sends:

```js
const payload = { shot_id: shot.id, scene_id: scene.id, project_id: scene.project_id, step: stepId };
```

That's it. The adapter is expected to go re-read the DB. There is no channel for "the output of node A is the input of node B."

**This also surfaces a latent defect worth fixing regardless of any canvas work.** `routes/storyboard.js:581` builds its image payload through `buildStoryboardPrompt(sceneCard, matchedChars, matchedLocation, project.style_preset)`. `routes/pipeline.js:122` does not — it ships the four-key stub above straight to `/image`. **The orchestrated pipeline bypasses every prompt builder the per-domain routes use.** Whatever the canvas decision, the fix is the same: extract payload construction into per-capability builders that both the routes and the executor call.

### Gap 2 — The graph is not data

`PIPELINE_STEPS` is a module-level constant. To be authorable it needs to become rows: a `film_flows` table (the template) and `film_flow_nodes` / `film_flow_edges` (the topology), with `film_pipeline_runs` gaining a `flow_id`.

### Gap 3 — No fan-out primitive

"Run in parallel" means one node produces N branches and everything downstream runs N times. `buildStepPlan()` returns a flat list — there's no notion of a branch. Film Engine has the *storage* for variants (`film_takes`, `film_shot_versions`, the A/B compare endpoint) but no executor concept that produces them from one graph.

### Gap 4 — No canvas UI, and a build constraint that shapes the answer

```
$ grep -cE "<canvas|drag.*node|reactflow" src/index.html
0
```

The frontend is a **single 17,091-line vanilla HTML file** with 32 sidebar pages routed by `navigateTo(page)`. There is no bundler, no `package.json` at the repo root, no framework. And `gridlight.json` pins the deployment:

```json
"build": { "target": "single-html", "minify": true }
```

The Gridlight app runtime wants one HTML file. This is the constraint that decides the UI approach.

---

## 4. Should we reuse NeonCore's canvas?

Short answer: **borrow the data model, not the component.**

NeonCore ships `dashboard/src/components/WorkflowCanvasEditor.tsx` — 3,732 lines on `@xyflow/react` v12 (React Flow), React 19, Vite, Tailwind. It is a genuinely mature canvas. Two problems:

**Problem 1 — the stack is incompatible.** React Flow [requires React](https://reactflow.dev/); there is no vanilla build (the team ships Svelte Flow as the alternative). Lifting the component means adopting React + Vite + Tailwind + TypeScript into a repo whose entire ethos is zero-build ([ADR-002](../adr/002-vanilla-http-no-framework.md): "the entire backend has exactly one npm dependency"), and whose deploy target is a single minified HTML file. You *can* bundle React Flow into one HTML — but you'd be introducing a build system to a project that has deliberately never had one.

**Problem 2 — and this matters more — the graph semantics are wrong for media.** NeonCore's `WorkflowStep` (`packages/client/src/types.ts:519-547`) has `dependsOn: string[]`, `positionX/positionY`, `executorType/executorId/executorConfig`. Its edges are **untyped dependency arrows**, and data crosses them as concatenated text:

```ts
// server/src/lib/workflow-executor-v2.ts:389
function gatherDependencyContext(step: WorkflowStep): string {
  for (const depId of step.dependsOn) {
    const depRow = db.prepare('SELECT name, result FROM workflow_steps WHERE id = ?').get(depId);
    parts.push(`[Output from previous step: "${depRow.name}"]\n${truncated}`);
```

That is exactly right for chaining LLM agents. It cannot express *"this video port and that audio port feed the lipsync node."* A media canvas needs **typed ports** — image, video, audio, text, subject — because the whole point is that lipsync takes one of each and a mismatch is a wiring error the UI should refuse to draw.

**What to take from NeonCore:** the persistence shape is close to ideal and battle-tested — node position stored on the row, `executorType`/`executorConfig` as the generic dispatch pair, per-node `status`/`result`/`error`, run-level pause/resume, and a `routingNote` field for "this ran somewhere other than where you pinned it" (a lesson Film Engine will need the moment a provider falls back). Copy that schema; add typed ports on top.

---

## 5. Options compared

| # | Approach | Effort | Fits single-html | Style control | Maintenance risk | Verdict |
|---|---|---|---|---|---|---|
| A | Embed NeonCore's dashboard canvas cross-app | Low upfront, high integration | No — separate Vite app | N/A | Two apps to keep in sync; wrong domain model | **Reject** |
| B | Adopt React + React Flow inside Film Engine | High — introduces a build system | Only via a new bundler step | Excellent | MIT, 12.7M weekly downloads, very healthy | **Reject on ADR grounds**; revisit only if the SPA is ever rebuilt |
| C | Inline a vanilla node lib ([Drawflow](https://npmtrends.com/drawflow-vs-litegraph.js-vs-rete), LiteGraph, [Rete.js](https://www.libhunt.com/compare-rete-vs-Drawflow)) | Medium | Yes — single JS+CSS file | Poor-to-fair; nodes are HTML strings or Canvas2D | Drawflow ~19k weekly downloads but effectively unmaintained; LiteGraph ~1.8k and blueprint-styled; Rete v2 is a plugin framework (heavier than needed) | **Fallback** |
| D | Hand-rolled SVG canvas in `index.html` | Medium — ~900-1,200 lines | Yes, natively | Full — matches the Gridlight style guide | Ours to maintain, but the interaction set is small | **Recommended** |
| E | No canvas — make the DAG editable as a list/form | Low | Yes | N/A | None | **Recommended as Phase 0** |

The interaction surface a media flow actually needs is modest: drag nodes, draw bezier edges between typed ports, pan/zoom, marquee-select, delete, and paint per-node status. That's a known ~1,000-line problem in SVG, and the SPA is already 17k lines of hand-rolled vanilla — option D is *in character* for this codebase in a way React Flow is not.

---

## 6. Recommendation

**Split the problem, and do the backend first.** The canvas is the visible part; the executor is the valuable part. A flow graph that's data, with a generic node executor and typed ports, is worth shipping **even with today's list UI** — and it is the prerequisite for every version of the canvas.

### Phase 0 — Fix the payload bypass *(do this regardless)*
Extract per-capability payload builders so `routes/pipeline.js` and the per-domain routes construct identical payloads. Today the orchestrated pipeline ships a four-key stub while `routes/storyboard.js` builds a real prompt. This is a correctness fix that happens to be the exact refactor a node executor requires.

### Phase 1 — Graph as data
`film_flows` / `film_flow_nodes` / `film_flow_edges`; `film_pipeline_runs.flow_id`. Seed one built-in flow that reproduces the current 9-step DAG **exactly**, so `PIPELINE_STEPS` becomes a seeded row set rather than a constant and existing behavior is provably unchanged.

### Phase 2 — Typed-port executor
Generalize `executeStep` → `executeNode(node, inputs)`. Edges carry `{type, value}`. Port-type compatibility is validated server-side (the UI refusing to draw a bad edge is a convenience, not the guarantee).

### Phase 3 — Fan-out and select
`tf.fanout` (N seeds / prompts / providers) and `tf.select` (human gate). Wire the outputs into the existing `film_takes` / A/B compare surface rather than inventing a parallel variant store.

### Phase 4 — The canvas
Hand-rolled SVG, new `data-page="flows"` sidebar entry. Node status painted live off the existing SSE stream — the pipeline already streams step events, so the "watch it run" behavior comes nearly free.

### Phase 5 — Templates
Ship the flows Artlist ships: multi-model video, character sheet (Film Engine already has `POST /characters/:id/refsheet/generate` — it becomes a 4-node flow), scene-to-shot, dialogue-to-lipsync.

**Film Engine's differentiator over a generic canvas:** the `in.subject` node. Artlist's canvas has prompts and assets; Film Engine has *characters* with LoRA tokens, consistency profiles, and reference sheets. Identity as a typed port that flows down the graph is something a general-purpose creative canvas structurally cannot offer, and it's the exact problem — character consistency across shots — that AI film production actually has.

---

## 7. Proposed node palette — 20/20 coverage

Full definitions in [`flows-canvas-node-taxonomy.json`](./flows-canvas-node-taxonomy.json). 23 nodes covering **all 11 provider capabilities and all 9 pipeline steps**, verified mechanically:

- **Inputs (5):** Prompt, Asset, Subject Reference, Scene/Shot, Licensed Catalog*
- **Generators (9):** Text/LLM, Image, Video, Voice, Music, SFX, Ambient, Lip-Sync, Post, 3D Model
- **Transforms (5):** Audio Mix, Stitch, Encode, Variants (fan-out), Select/Compare
- **Outputs (3):** Assembly, Save Asset, Export

The provider-backed input set contains only capabilities with a real adapter; a licensed-catalog node can return when a source adapter ships.

The coverage claim is enforced by `backend/tests/flows-node-taxonomy.test.js`, which **iterates the live registries** rather than asserting examples. Add a capability to `CAPABILITIES` or a step to `PIPELINE_STEPS` and the test fails until the taxonomy grows with it.

---

## 8. Risks and open questions

1. **Cost blowup.** "Run in parallel" over a 200-shot feature at 4 variants each is 800 generations. `film_cost_entries` and the budget forecast exist — fan-out must be gated by the budget limit before it ships, not after.
2. **Reproducibility.** `render_ledger` captures seed/sampler/steps per render. A flow run must write the graph *version* into the ledger, or "recreate this exactly" silently breaks the moment someone edits the flow.
3. **Cycle detection.** `getNextSteps()` is safe today only because `PIPELINE_STEPS` is hand-verified acyclic. User-authored graphs need real cycle detection on save, or a flow with a loop hangs the executor.
4. **Does the canvas replace the pipeline page, or sit beside it?** Recommendation: beside it. The linear pipeline view is better for "run the standard thing on 200 shots"; the canvas is better for "design a look." Forcing everyone through a graph is how these tools lose the users who just want the default.
5. **Single-html size budget.** `index.html` is already ~17k lines. A canvas adds ~1,000 more. At some point the zero-build choice needs revisiting — that's a legitimate future ADR, not a reason to block this work.

---

## Sources

- [ElevenLabs — Introducing Flows, the AI creative canvas](https://elevenlabs.io/blog/introducing-flows-in-elevencreative)
- [ElevenLabs Flows](https://elevenlabs.io/flows)
- [Higgsfield AI Canvas](https://higgsfield.ai/canvas-intro)
- [Runway launches node-based Workflows](https://alternativeto.net/news/2025/10/runway-launches-node-based-workflows-for-building-custom-ai-creative-pipelines)
- [Flowy — node-based AI canvas](https://tryflowy.ai/)
- [React Flow / xyflow](https://reactflow.dev/)
- [drawflow vs litegraph.js vs rete — npm trends](https://npmtrends.com/drawflow-vs-litegraph.js-vs-rete)
- [Rete.js vs Drawflow — LibHunt](https://www.libhunt.com/compare-rete-vs-Drawflow)
- [Artlist unveils full-scale AI ecosystem at $260M ARR](https://www.prnewswire.com/news-releases/finishing-2025-at-260m-arr-artlist-unveils-the-future-of-ai-video-production-with-a-full-scale-ai-ecosystem-302668327.html)
- [Artlist blog — AI video production launch](https://artlist.io/blog/artlist-nyc-ai-video-production-launch/)
