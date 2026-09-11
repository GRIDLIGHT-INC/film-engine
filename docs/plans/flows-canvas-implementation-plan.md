# Implementation Plan: Flows-style Visual Canvas

**Status:** Design — approved for review, not for implementation
**Date:** 2026-08-13
**Depends on:** [`flows-canvas-research.md`](./flows-canvas-research.md), [`flows-canvas-node-taxonomy.json`](./flows-canvas-node-taxonomy.json)
**Machine-readable interfaces:** [`flows-canvas-interfaces.json`](./flows-canvas-interfaces.json) — conformance enforced by `backend/tests/flows-canvas-plan.test.js`

---

## 1. What this plan covers

Turn Film Engine's hard-coded 9-step pipeline into a **user-authorable, typed-port media dataflow graph** with a visual canvas, matching the three claims Artlist Flows makes: build your own flow, start from a template, run in parallel.

**The set this touches, derived from code:**

| Set | Count | Source |
|---|---|---|
| Node types requiring an executor binding | 23 | `flows-canvas-node-taxonomy.json` |
| Provider capabilities to route per-node | 11 | `lib/providers/base.js:35` |
| Pipeline steps to preserve behavior for | 9 | `lib/pipeline-engine.js:11-21` |
| Route modules that construct provider payloads | 8 | `grep -l "resolveGenerator\|\.generate('" routes/*.js` |
| New modules | 12 | this plan |
| Modified modules | 4 | this plan |
| New migrations | 3 | this plan |
| New routes | 14 | this plan |

---

## 2. Two defects found while designing, both in the critical path

These are not incidental. Phase 0 exists because of them, and neither should wait on canvas work.

### Defect 1 — the orchestrator generates from an empty prompt

`routes/pipeline.js:122` builds its payload as:

```js
const payload = { shot_id: shot.id, scene_id: scene.id, project_id: scene.project_id, step: stepId };
const result = await resolveGenerator(capability, config).generate(capability, payload);
```

while `routes/storyboard.js:581` builds the real thing:

```js
const basePrompt = buildStoryboardPrompt(sceneCard, matchedChars, matchedLocation, project.style_preset);
const imagePayload = applyConsistencyToImagePayload({ prompt: basePrompt.prompt, ... }, consistencyContext);
```

The orchestrated pipeline never calls a single prompt builder and never applies consistency context. Every `POST /shots/:id/pipeline/run` sends four ids to `/image` and hopes.

### Defect 2 — storyboard generation bypasses the provider layer entirely

`routes/storyboard.js:97`:

```js
const response = await fetch(`${GRIDLIGHT_URL}/image`, { method: 'POST', headers, body: JSON.stringify(payload) });
```

No `resolve('image', ...)`. A project whose `provider_config` sets `image: 'runway'` or `image: 'openai'` still gets Gridlight for every storyboard — on the most visible path in the product. The provider layer's per-project routing is real everywhere except the place users meet it first.

**Both fixes converge on the same refactor**, which is also exactly what the node executor needs. Hence phase 0.

---

## 3. The central design decision: what an edge carries

Everything else follows from this.

Today, data moves between pipeline steps **implicitly through the database**: the video step knows to look up the keyframe asset because the code says so. That is why `executeStep` can get away with a four-key payload, and why it is impossible to say "use *this* image, not the one on the shot row."

In a Flows-style graph, an edge **carries a typed value**:

```js
{ type: 'image', value: { assetId, url, path }, meta: { branchId, providerId } }
```

Eight port types (`text, image, video, audio, model3d, subject, timeline, any`) and one rule: an edge is legal only when the source port type is assignable to the target port type, with `any` assignable both ways. Validation is **server-side** in `validateGraph()`; the canvas refusing to draw a bad edge is a convenience, not the guarantee.

The `subject` port is the one no general-purpose canvas has. It carries a consistency profile — LoRA/TI tokens, locked reference images, role-ranked refs — so character identity flows down the graph as data instead of being re-pasted into each prompt. This is the differentiator, and it is why `lib/consistency-context.js` moves *into* the shared payload builder in phase 0 rather than staying per-route.

**Explicitly rejected:** NeonCore's model, where edges are untyped `dependsOn` arrows and results cross as concatenated text (`workflow-executor-v2.ts:389`). Correct for chaining LLM agents; cannot express "this video port *and* that audio port feed lipsync." We take its persistence shape (position on the row, `executorType`/`executorConfig`, per-node `status`/`result`, and `routingNote`) and add typing on top.

---

## 4. Module architecture

```
backend/
├── lib/
│   ├── capability-payloads.js      NEW  ph0  one payload path for all 11 capabilities
│   ├── flow-graph.js               NEW  ph1  pure graph algebra (validate, cycles, topo, ports)
│   ├── flow-seed.js                NEW  ph1  PIPELINE_STEPS -> built-in flow rows
│   ├── flow-executor.js            NEW  ph2  runFlow / executeNode / resolveNodeInputs
│   ├── flow-templates.js           NEW  ph5  built-in templates as data
│   └── node-handlers/
│       ├── index.js                NEW  ph2  filename autoload registry (mirrors providers/)
│       ├── input.js                NEW  ph2  in.prompt, in.asset, in.subject, in.scene
│       ├── generate.js             NEW  ph2  all 10 gen.* nodes, one generic execute()
│       ├── transform.js            NEW  ph2  tf.mix, tf.stitch, tf.encode
│       ├── control.js              NEW  ph3  tf.fanout, tf.select
│       └── output.js               NEW  ph2  out.assembly, out.asset, out.timeline
├── routes/
│   ├── flows.js                    NEW  ph1  handleFlows(req, res, parts, query)
│   ├── pipeline.js                 MOD  ph0  executeStep -> buildCapabilityPayload
│   └── storyboard.js               MOD  ph0  callImageGen -> resolveGenerator('image')
├── db/migrations/
│   ├── 054_flow_graphs.sql         NEW  ph1  film_flows, film_flow_nodes, film_flow_edges
│   ├── 055_flow_runs.sql           NEW  ph2  film_flow_runs, film_flow_node_runs
│   └── 056_flow_branches.sql       NEW  ph3  film_flow_branches
└── server.js                       MOD  ph1  dispatch + seedBuiltinFlows()

src/index.html                      MOD  ph4  data-page="flows" + FlowCanvas (SVG)
```

Three structural choices, each following a pattern the codebase already uses:

1. **`lib/` holds the logic, `routes/` holds the HTTP.** Same split as `pipeline-engine.js` ↔ `routes/pipeline.js`. A flow can be run from a route, a batch job, or a test with no server.
2. **Node handlers autoload by filename**, exactly like `lib/providers/index.js:31-44`. Adding a node type is one new file, never an edit to a central switch — the property that keeps provider work conflict-free.
3. **One `handleFlows(req, res, parts, query)` export**, dispatched from `server.js` by `parts[1]`, per [ADR-002](../adr/002-vanilla-http-no-framework.md). No framework, no middleware.

### Key interfaces

```js
// lib/capability-payloads.js  (phase 0)
buildCapabilityPayload(capability, ctx) -> { payload, meta }
  // ctx = { project, scene, shot, sceneCard, overrides }
  // dispatches through CAPABILITY_BUILDERS, then applies consistency context
loadShotContext(shotId) -> ctx
persistCapabilityResult(capability, result, ctx) -> { assetId, path, url }

// lib/flow-graph.js  (phase 1) — pure
validateGraph(graph) -> { ok, errors: [{ code, nodeId?, edgeId?, message }] }
detectCycles(graph)  -> string[][]        // node id cycles
topoSort(graph)      -> string[]
nextNodes(graph, completedIds, skipIds) -> node[]   // mirrors getNextSteps()
portsCompatible(fromType, toType) -> boolean
graphFingerprint(graph) -> string          // for render_ledger

// lib/flow-executor.js  (phase 2)
executeNode(node, inputs, ctx) -> { ok, outputs: { [port]: { type, value } }, error?, providerId? }
resolveNodeInputs(graph, nodeId, outputsSoFar) -> { [port]: { type, value } }
runFlow(flowId, ctx, opts) -> runId
runFlowStream(flowId, ctx, res, callbacks)
cancelFlowRun(runId)

// lib/node-handlers/index.js  (phase 2)
handlerFor(nodeType) -> { execute(node, inputs, ctx), inputs, outputs, capability? }
```

`executeNode` is deliberately the same shape as today's `executeStep` — capability in, provider result out. The change is that inputs arrive as an argument instead of being re-read from the DB.

---

## 5. Schema

Full sketches in the manifest. Three decisions worth arguing here:

**`film_flows.project_id` is NULLABLE.** A null project means a library flow — "save it once, reuse it across every project," which is the literal claim in the screenshot. Project-scoped and library flows are the same table because a flow is promoted to the library by clearing a column, not by being copied.

**`film_flow_edges` carries `UNIQUE(flow_id, to_node, to_port)`.** Fan-*in* to a single port is impossible at the schema level, so the executor never has to arbitrate between two competing values for one input. Fan-*out* from a source port is unconstrained, which is what branching needs.

**`film_flow_runs.graph_snapshot` stores the graph as run.** This is the reproducibility fix. `render_ledger` already captures seed/sampler/steps, but a ledger entry pointing at a *mutable* flow silently stops meaning anything the moment someone edits that flow. The snapshot plus `graphFingerprint()` makes "recreate this exactly" survive editing.

`film_flow_node_runs.routing_note` is borrowed verbatim from NeonCore's `WorkflowStep`: when a provider falls back, the node ran *correctly* somewhere unexpected. Recording that in `error` would paint a working node red and train users to ignore red.

---

## 6. Phasing

Each phase is independently shippable and independently revertible, with a stated exit criterion. **Nothing before phase 4 requires any UI work**, which is the point: the valuable half is the executor.

| Ph | Name | Exit criterion |
|---|---|---|
| 0 | Shared payload builders | For every capability, `routes/pipeline.js` and the matching per-domain route produce a byte-identical payload for the same shot — asserted by a set-based test iterating `STEP_CAPABILITY`. No route builds a provider payload inline. |
| 1 | Graph as data | `buildStepPlan()` output for the seeded built-in flow is deep-equal to the output derived from `PIPELINE_STEPS`. The DB graph provably reproduces the constant. |
| 2 | Typed-port executor | All 23 taxonomy nodes resolve to a registered handler at runtime; port validation rejects an incompatible edge server-side. |
| 3 | Fan-out and select | A `fanout(n=3)` feeding a generator yields 3 node-runs sharing a branch key, and the budget guard refuses the run when projected cost exceeds the project limit. |
| 4 | Canvas UI | A flow can be authored, saved, run, and watched from the SPA, with no new build step and `index.html` still deployable as a single file. |
| 5 | Built-in templates | Every declared template instantiates into a graph passing `validateGraph()` with zero errors. |

**Phase 1's exit criterion is the load-bearing one.** Seeding the built-in flow by *deriving* it from `PIPELINE_STEPS` (`pipelineStepsAsGraph()`) rather than transcribing it means the equivalence test stays true as the constant evolves — and it makes phase 1 a provable no-op for existing behavior rather than a rewrite users have to trust.

### Phase 4 — canvas scope

Hand-rolled SVG, ~900–1,200 lines added to `index.html`. Interaction set, deliberately small: pan/zoom, drag nodes, draw bezier edges between typed ports, marquee select, delete, and per-node status painting. Status comes off the existing SSE stream — `runFlowStream` emits the same event shape the pipeline already streams, so "watch it run" is nearly free.

Rejected: React Flow (MIT, excellent, [12.7M weekly downloads](https://reactflow.dev/)) — it requires React, and `gridlight.json` pins `"build": {"target": "single-html"}` against a 17,091-line zero-build SPA. Rejected: Drawflow/LiteGraph/Rete — inlineable, but Drawflow is effectively unmaintained, LiteGraph's Canvas2D aesthetic fights the Gridlight style guide, and Rete v2 is a plugin framework heavier than the need.

### Phase 5 — templates

Mirroring the Artlist template shelf in Film Engine's domain: multi-model video (one prompt → three `gen.video` nodes on different providers → `tf.select`), character sheet (`in.subject` → `tf.fanout` over four views → `gen.image` ×4 → `out.asset`), scene-to-shots, dialogue-to-lipsync. The character sheet template collapses today's bespoke `POST /characters/:id/refsheet/generate` into four nodes.

---

## 7. Risks

1. **Cost.** Fan-out over 200 shots × 4 variants is 800 generations. `film_cost_entries` and the budget forecast exist; the phase-3 exit criterion makes the budget guard a *gate*, not a follow-up.
2. **Cycles.** `getNextSteps()` is safe today only because `PIPELINE_STEPS` is hand-verified acyclic. `detectCycles()` runs on save *and* before every run — a user-authored loop would otherwise hang the executor with no timeout.
3. **Phase 0 blast radius.** It touches the payload path of every generation route. Mitigation: the exit criterion is byte-identical payloads, so it is a provable refactor. It must land alone, not bundled with phase 1.
4. **Canvas vs. pipeline page.** The canvas is added *beside* the pipeline page, not in place of it. Linear is better for "run the standard thing on 200 shots"; the graph is better for "design a look." Forcing everyone through a graph is how these tools lose the users who just want the default.
5. **`index.html` size.** Already ~17k lines; +1.2k more. At some point the zero-build choice needs a fresh ADR — a legitimate future decision, not a blocker now.

---

## 8. Open questions for review

1. **Should phase 0 ship on its own PR before anything else is greenlit?** Recommendation: yes. Both defects are live bugs today and the fix stands alone.
2. **Do library-scoped flows (`project_id IS NULL`) need per-user ownership?** Not today — Film Engine is single-user — but the column is cheaper to add now than to backfill.
3. **Does `tf.select` block the whole run or just its branch?** Plan assumes whole-run `paused`, matching the existing pipeline status machine. Per-branch pausing is strictly more useful and strictly more complex.
4. **Should the built-in flow be editable via "duplicate to edit"?** Plan makes `is_builtin` immutable and expects the UI to offer duplication. Cheap, and it keeps the phase-1 equivalence guarantee true forever.
