# Epic: Ship and Test Film Engine

## Overview

Film Engine can already do almost everything between a screenplay and a finished
film, and cannot currently do the last step of it. 43 route modules, 59
migrations, 9 orchestrated pipeline steps and 1330 passing tests carry a project
from a Fountain upload through scene breakdown, shot cards, previs blocking,
storyboard keyframes, video, dialogue, music, SFX and ambient. Then the
orchestrator reaches its final step, `assembly`, and returns
`{ ok: true, message: 'Assembly step: use export endpoints to finalize' }`
(`routes/pipeline.js:180`). The run reports complete. No film exists. The
acceptance criterion for this epic — a screenplay taken through every stage to a
final movie, all managed from Film Engine — fails on that one line and on the
three stages the preflight honestly marks as leaving the building.

The second thing this epic settles is where the reasoning happens. Three routes
perform AI queries — `routes/breakdown.js`, `routes/screenplay-ai.js`,
`routes/text-convert.js` — and all three go through `callProjectLLM`, which
resolves the `llm` capability to the Anthropic adapter and spends an
`ANTHROPIC_API_KEY`. The MCP server exposes 52 tools and none of them is one of
those three, so an agent host connected to Film Engine can run generation, fill
character records and generate storyboards, but cannot break down a screenplay
without Film Engine separately paying for inference. The reasoning the host
already has is locked out of the one part of the pipeline that is pure
reasoning.

This epic closes both: make the tail of the pipeline produce an actual master,
and make every AI query reachable over MCP so the host's own model does the
thinking. It delivers a demonstrated end-to-end run on
`backend/tests/fixtures/thirty-second.fountain` — screenplay in, watchable file
out — with the run reproducible from the ledger and provable by a test that
iterates the stage registry rather than one happy path.

## Business Goals

- **A screenplay becomes a movie without leaving Film Engine**: today the last three stages (lipsync, post, mix) and the final conform are handoffs to Premiere. The product claim is end-to-end; the code stops one file short.
- **The demo is a real run, not a described one**: a 30-second fixture screenplay exists precisely to exercise every step at the lowest cost. Shipping means that run is executed, its output played, and its cost recorded — not that the steps exist.
- **AI queries ride the agent host's subscription**: an MCP-connected host (Claude Desktop, claude.ai) should do breakdown, screenplay assistance and prose conversion, keeping assets in `film_assets` rather than in a chat, and removing `ANTHROPIC_API_KEY` from the critical path.
- **A blocked run says what to fix**: `preflight.js` already exits non-zero and names the gap per stage. Every new stage this epic adds must be visible to it, or the gate stops meaning anything.
- **Spend stays bounded and attributable**: the budget gate refuses a run at HTTP 402 before anything generates. A whole-film conform is the largest single spend in the product and must be projected under the same gate.

## Current State

| Component | Current State |
|-----------|---------------|
| Pipeline orchestrator | 9 `PIPELINE_STEPS`; 8 map to a capability in `STEP_CAPABILITY`; `assembly` maps to `null` and returns a message telling the caller to go use the export endpoints |
| Final movie artifact | None. No route concatenates shot videos into one file. QA's `video_master` check counts per-shot `final`/`synced` assets and passes on shot 1 of N |
| Capabilities | 11 in `CAPABILITIES`. 10 have at least one adapter; `stock` has **zero** — nothing writes `license_source = 'licensed_catalog'` that the music-rights routes are built around |
| Provider adapters | 6 files in `lib/providers/`: anthropic, elevenlabs, gridlight, meshy, openai-image, runway |
| Single-provider capabilities | `lipsync` and `post` resolve to Gridlight only, and Gridlight implements neither `/lipsync` nor `/postprocess` in the deployment under test |
| E2E preflight | 15 stages. 3 (`lipsync`, `post`, `mix`) are `HANDOFF` — reported as NLE work, not blocked, unless `--in-engine` is passed |
| MCP surface | 52 tools: 23 `node_*`, 15 flow routes, 12 production routes, 2 batch. Generated from the registries, tested in both directions |
| AI query routes | 3 (`breakdown`, `screenplay-ai`, `text-convert`), all through the single choke point `callProjectLLM`. **None has an MCP tool.** |
| LLM provider | `PREFERRED_WHEN_CONFIGURED.llm = 'anthropic'`, requiring an API key. Gridlight's `/chat/intelligent` 500s without a vector store |
| Previs → generation | Blocking reaches both the video payload and the storyboard payload; round-trip via `/previs/apply`. Uncommitted in the working tree, with 2 new test files |
| Test suite | 1330 tests, 180 suites, 0 failures, ~8.1s |
| Export | FCPXML 1.11, CMX 3600 EDL, Premiere XML, FDX. `AUDIO_LANES` proven to land in both XML formats |

## Target State

| Component | Target State |
|-----------|---------------|
| Pipeline orchestrator | `assembly` is a real step: it conforms the shot masters and the mixed audio into one project-level file and registers it |
| Final movie artifact | A `video_master` asset per project, produced by a project-scoped conform route, playable, and referenced by the QA rubric as a single artifact rather than a count |
| QA `video_master` check | Passes only when the project-level master exists — a per-shot count can no longer satisfy it |
| E2E preflight | Stage list grows to include the conform; `--in-engine` remains the strict mode and the default keeps the three honest NLE handoffs |
| AI query routes | All 3 exposed as MCP tools (`breakdown_run`, `screenplay_ai`, `text_to_screenplay`), dispatched through the same in-process route shim as `PRODUCTION_TOOLS` |
| LLM without a key | An MCP-host-served path for `llm` so a connected agent's own model answers, with the Anthropic adapter as the fallback when no host is attached |
| MCP registry test | `mcp-tools.test.js` extended to assert every route that performs an AI query has a tool — the same set-based check that already covers node types and flow routes |
| `stock` capability | Either an adapter, or removed from `CAPABILITIES` and from the rights model. A capability with no provider is a claim the preflight cannot check |
| `lipsync` / `post` | At least one adapter each beyond Gridlight, or the handoff documented as permanent and the `--in-engine` mode marked unreachable |
| Proof of shipping | `thirty-second.fountain` run end-to-end, master file produced, cost recorded in the ledger, run reproducible from `graph_snapshot` |

## Constraints

- **One backend dependency**: `better-sqlite3` and nothing else. ADR-002 rules out frameworks, and the MCP server is hand-rolled JSON-RPC for the same reason. A conform step must not smuggle in a media library through the front door.
- **No bundler**: `gridlight.json` pins `build.target: single-html`. Any UI for the conform lives in the existing SPA with hand-rolled rendering, as the flows canvas and previs viewer already do.
- **FFmpeg is not in-process**: concatenating video is real work with real dependencies. It is either a Gridlight endpoint, a provider capability, or an explicitly-declared external binary — and whichever is chosen must be visible to `preflight.js` so a missing one blocks rather than surprises.
- **SQLite CHECK constraints cannot be widened in place**: migration 042 recorded this. A new asset type is a table rebuild or a `metadata.kind` tag, as the 3D path already does.
- **The MCP direction is fixed**: hosts are MCP *clients*; no Claude or ChatGPT MCP server exposes inference. "Use MCP for AI queries" therefore means exposing our reasoning-shaped routes as tools the host calls, not calling out to a host for completions.
- **Budget gate precedes generation**: `lib/flow-cost.js` refuses at HTTP 402 before anything spends. A project-level conform must be projected, not discovered on the ledger.
- **The byte-identical guarantee**: `tests/fixtures/video-payload-golden.json` pins 54 payloads captured before previs phase 3. Regenerating it deletes the guarantee; unblocked shots must stay byte-identical.
- **Provider refusal is non-deterministic**: the same prompt passes and fails minutes apart, which is why `lib/image-fallback.js` walks providers rather than retrying one. Any new generative stage inherits that expectation.

## Task Breakdown

### Phase 1: Close the Pipeline Tail

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| SHIP-001 | Conform contract | Decide and record (ADR) how shot masters become one file: Gridlight endpoint, new capability, or declared external binary. Must be checkable by `preflight.js`. | M | None |
| SHIP-002 | Project master route | `POST /projects/:id/conform` — ordered shot masters + mixed audio → one file, registered as the project's `video_master`. Ordering comes from the timeline, not insertion order. | L | SHIP-001 |
| SHIP-003 | `assembly` stops lying | Replace the `use export endpoints to finalize` return with a real call to the conform, and let a failed conform fail the run — matching `persistStepResult`'s existing stance that a complete run with no output is the worse outcome. | M | SHIP-002 |
| SHIP-004 | QA rubric follows | `video_master` passes on the project master, not on a per-shot count. Same for `audio_master` against the project mix. | S | SHIP-002 |
| SHIP-005 | Preflight covers the conform | Add the stage to `e2e-preflight.js` so a missing conform dependency blocks a run instead of surfacing at the end of one. Extend `e2e-readiness.test.js`, which is already set-based over the stage list. | S | SHIP-001 |
| SHIP-006 | Conform cost projection | Teach `lib/flow-cost.js` the conform so a whole-film run is projected under the existing 402 gate. | S | SHIP-002 |

### Phase 2: AI Queries Over MCP

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| SHIP-010 | Set-based tool gap test | Extend `mcp-tools.test.js` to iterate the routes that call `callProjectLLM`/`streamProjectLLM` and fail for any without a tool. Write it first; it fails 3/3 today. | S | None |
| SHIP-011 | `breakdown_run` tool | Expose the screenplay breakdown through the existing in-process route shim. SSE variant omitted for the documented `SSE_EXCEPTION` reason. | M | SHIP-010 |
| SHIP-012 | `screenplay_ai` tool | Expose the writing assistant's four modes as one tool with a mode argument, mirroring the route's own validation. | M | SHIP-010 |
| SHIP-013 | `text_to_screenplay` tool | Expose prose→Fountain conversion and its preview form. | S | SHIP-010 |
| SHIP-014 | Host-served `llm` | An adapter that answers `llm` from the connected MCP host where one is attached, falling back to Anthropic otherwise, so a key-less install can still break down a screenplay. | L | SHIP-011 |
| SHIP-015 | Preflight reports the LLM path | The readiness brief should say *which* path answers `llm` — host, Anthropic, or nothing — since "configured" currently cannot distinguish them. | S | SHIP-014 |

### Phase 3: Prove It End-to-End

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| SHIP-020 | Land the previs→storyboard work | Commit the working-tree changes (previs reaches the image payload, `reference-capability` and `previs-storyboard` tests) so the run under test is the committed one. | S | None |
| SHIP-021 | Live 30-second run | Execute `thirty-second.fountain` through every stage with real providers. Record per-stage cost, duration and failures. | L | Phase 1, SHIP-020 |
| SHIP-022 | Watch the output | Play the master. Confirm shot order, audio sync, and that the ambient bed was tiled rather than played once and left dry. | M | SHIP-021 |
| SHIP-023 | Reproduce from the ledger | Re-run from `graph_snapshot` + render ledger and diff against the first run — the reproducibility claim, exercised. | M | SHIP-021 |
| SHIP-024 | Agent-driven run | Repeat SHIP-021 driven entirely through MCP tools from an agent host, with no `ANTHROPIC_API_KEY` set. This is the rabbit-hole criterion, tested rather than asserted. | L | Phase 2, SHIP-021 |

### Phase 4: Close the Honest Gaps

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| SHIP-030 | Resolve `stock` | Ship a licensed-catalog source adapter, or remove `stock` from `CAPABILITIES` and unwind the rights model's dependency on it. A capability with no provider cannot be preflighted. | M | None |
| SHIP-031 | Second `lipsync` provider | Add an adapter so `lipsync` is not a single point of failure that does not implement its own endpoint. | M | SHIP-021 |
| SHIP-032 | Second `post` provider | Same for `post` — or mark the NLE handoff permanent and make `--in-engine` say so rather than reporting blocked. | M | SHIP-021 |
| SHIP-033 | Failure walk for new stages | Ensure the conform and any new generative stage report the whole provider walk on failure, as `image-fallback` does, rather than only the first refusal. | S | SHIP-002 |

## Open Questions

1. **Where does the conform run?** Gridlight endpoint, a new `conform` capability with adapters, or a declared local FFmpeg? This decides SHIP-001 and everything downstream, and it is the only question in this epic that changes the architecture rather than the code.
2. **Is `--in-engine` a goal or a diagnostic?** If lipsync/post/mix are permanently NLE work, the acceptance criterion "all managed from film engine" means *orchestrated from* rather than *executed in* — and that should be stated rather than left to the preflight's tone.
3. **Does the host-served `llm` adapter belong in `lib/providers/`?** It is not a provider in the same sense — it has no endpoint and no credential, and it only exists while a host is attached. Autoloading it beside the others may be the wrong shape.
4. **What happens to a run when the host disconnects mid-breakdown?** The SSE paths already treat client disconnect as cancellation; an MCP-served LLM has the same failure with different plumbing.
5. **Should `stock` be removed rather than filled?** Removing a capability is a migration and a rights-model change; filling it is an adapter and a licensing relationship. The cheaper answer is not obviously the right one.
6. **Does the project master need per-shot conform, or only the whole film?** A director reviewing a scene wants a scene cut, which is the same code with a different range — but it is scope, not a freebie.

## Success Metrics

- `node backend/preflight.js <project> --in-engine` exits 0 with no stage marked blocked, on a project configured the way the demo runs.
- `thirty-second.fountain` produces one playable master file registered as the project's `video_master`, with correct shot order and synced audio, and the run is watched by a human before it is called done.
- The same run, driven from an MCP agent host with `ANTHROPIC_API_KEY` unset, reaches the same master — proving the reasoning came from the host.
- `mcp-tools.test.js` fails if any route performing an AI query lacks a tool; it passes with all AI-query routes covered (3/3 today, and any added later).
- The QA rubric's `video_master` check cannot pass on a partially generated project.
- Full suite stays green: currently 1330 tests / 180 suites / 0 failures, and grows with each phase's set-based test rather than staying flat.
- Projected cost for a whole-film run is reported before it starts, and the 402 gate refuses a run that exceeds `budget_total`.
