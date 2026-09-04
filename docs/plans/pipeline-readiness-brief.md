# Research Brief: End-to-End Pipeline Readiness

**Status:** Research brief — input to epic planning
**Date:** 2026-08-16
**Judged against:** *"Write a screenplay, then take it through every stage of the pipeline until a final movie, all managed from Film Engine."*
**Conformance:** `backend/tests/readiness-brief.test.js` iterates `CAPABILITIES`, the adapter registry and `stages()` against this document.

---

## Executive Summary

Film Engine can take a screenplay to a finished shot today: **11 of 15 stages ready, 3 deliberately handed to the NLE, 1 blocked**. The single blocker is video generation, which needs a **`RUNWAY_API_KEY`** — the one thing no amount of engineering here can supply.

The research also found why a *fresh* project would have failed completely rather than partially. `PREFERRED_WHEN_CONFIGURED` in `lib/providers/index.js` was consulted on every provider resolve, was documented, and was an empty object — so a project created with no `provider_config` pointed all eleven capabilities at a local Gridlight service, running or not, with credentialed hosted adapters sitting unused in the registry beside it. The only symptom was a connection refused at generation time, one capability at a time. That is fixed, and the fallback now applies only where nothing else can genuinely serve the capability.

Verbatim, from `node backend/preflight.js --all`:

```
BLOCKED Neon Requiem
        11 ready, 3 in the NLE, 0 skipped, 1 blocked, of 15
        · Video Generation: Gridlight at http://localhost:8080 is not answering (ECONNREFUSED)
BLOCKED From the Mist
        11 ready, 3 in the NLE, 0 skipped, 1 blocked, of 15
        · Video Generation: 'runway' has no credential
```

Before the provider fix the same command reported **5 ready, 7 blocked**.

The stated rabbit hole — *use MCPs wherever we can for AI queries* — resolves against us in a useful way: MCP is a protocol for **agent** tool access, not for server-to-server calls. Film Engine's provider calls are programmatic REST and should stay that way. The correct MCP use is the one already shipped: **38 tools exposing the pipeline to agents**.

---

## Key Themes

- **Silent fallback is the dominant failure mode.** Three variants surfaced in one session: deleted `artlist-*` providers resolving cleanly to a fallback, an empty preference table, and a project config that resolved without erroring. *Resolution succeeding is not evidence that anything works.*
- **Tests can encode the bug.** `providers.test.js` asserted that all eleven capabilities default to `gridlight` — the exact behaviour that was broken. It read as coverage. (Precedent: an earlier test pinned `trackCount === 3` and hid a dropped audio lane.)
- **The gaps are concentrated, not diffuse.** Ten capabilities have a hosted adapter. `lipsync`, `post` and `stock` do not — and Gridlight, the nominal fallback, implements none of the first two.
- **MCP is for agents, not for plumbing.** Every source agrees MCP wraps REST for autonomous tool discovery; it does not replace REST for code that already knows which endpoint it wants.
- **Vendor claims need checking at the source.** A GitHub repo and several summaries advertise Runway Act-Two and lip-sync "via API". That documentation belongs to a **third-party reseller**, not Runway.
- **A readiness check that audits one project is a readiness check that lies.** `preflight.js` silently picked the most-recently-updated project, so a seeded demo reported 7 blocked stages while the configured project reported 1.

---

## Top Ideas & Opportunities

1. **Close the lip-sync gap with Runway `character_performance`.**
   *What:* `POST /v1/character_performance` is an official Runway endpoint with SDK bindings (`client.characterPerformance.create`), on the same async create-then-poll pattern `lib/providers/runway.js` already implements for `image_to_video`.
   *Why it matters:* `lipsync` is one of only three capabilities with no hosted adapter, and it is the one a dialogue scene actually needs.
   *How it applies:* extend the Runway adapter's `capabilities` from `['video','image']` to include `lipsync`, mapping our `video_raw` + `audio_dialogue` inputs onto its request shape.

2. **Make the fallback honest everywhere, not just at resolve time.**
   *What:* `defaultProviderConfig()` now writes real choices into new projects.
   *Why it matters:* an empty column showed the user nothing in Provider Settings while generation quietly used something else.
   *How it applies:* the same idea belongs in `demo-project.js`, which still creates its project without one.

4. **Ship the preflight as a gate, not a report.**
   *What:* `node backend/preflight.js --all` exits non-zero when any project is blocked.
   *Why it matters:* it can sit in front of a batch run or a CI job rather than being something someone remembers to read.

5. **Treat the NLE handoff as a product decision with a stated boundary.**
   *What:* `lipsync`, `post` and the audio mix are finished in Premiere against the four exported audio lanes.
   *Why it matters:* it is defensible and currently invisible — the preflight reports it, `CLAUDE.md` explains it, nothing in the UI does.

6. **Use the previs frame as a composition reference, not an `init_image`.**
   *What:* previs exports a still and a `.webm` animatic, registered as assets with the lens, rig and movement that produced them.
   *Why it matters:* a grey-box render fed to a video model produces grey boxes. Its value is structural conditioning and matching a storyboard to a blocked framing.

---

## Technical Approaches

**Provider resolution (implemented).** Order is per-project `provider_config` → `PROVIDER_<CAP>` env → `PREFERRED_WHEN_CONFIGURED` → `gridlight`. The preference applies only when `isProviderConfigured()` is true, so it can never swap a reachable local service for an unusable hosted one, and an explicit project choice still wins — including choosing Gridlight back.

Current resolution with the credentials on this machine:

| Capability | Resolves to | Note |
|---|---|---|
| `llm` | `anthropic` | keyed — Claude Opus 5 via the Messages API |
| `image` | `muapi` → `google` → `meshy` → `bfl` → `openai` | preference is an ordered walk; `muapi` leads when keyed — one MuAPI account key reaches the Nano Banana models (and the Seedance video ones), so a single credential covers what would otherwise be two. `google` reaches the same Gemini image models directly; `bfl` (FLUX.2) and `openai` follow |
| `video` | `seedance` → `runway` | `seedance` (Seedance 2.5, via MuAPI) leads when keyed — its omni-reference workflow takes 30 reference images where Runway's gen4.5 takes two |
| `voice`, `music`, `sfx`, `ambient` | `elevenlabs` | keyed |
| `model3d` | `meshy` | keyed |
| `lipsync`, `post` | `gridlight` | no hosted adapter; handed to the NLE |
| `world` | `worldlabs` | keyed — World Labs Marble, spatial worlds for previs. Draft (`marble-1.0-draft`) is the default and costs 250 credits ≈ $0.20; a standard world is 1,600 ≈ $1.28. Async like `meshy`: the operation id is written through `onHandle` before polling, so a world the host abandons is collectable. Verified live — a two-plate draft world returned in 37s and its collider mesh parsed with the existing `glb-parser` at 53,841 triangles across 39.6 × 9.0 × 47.9 world units |
| `stock` | — | no adapter at all; nothing writes `licensed_catalog` |

**Quality tiers.** Image generation is chosen as **Draft / Standard / Precision** rather than by provider name, resolved by `lib/quality-tiers.js` inside `resolveId()` so every path inherits it. Draft routes to FLUX.2 Klein, Standard to Nano Banana 2 (`google`), Precision to Nano Banana Pro; each tier names an ordered fallback so a tier whose preferred provider holds no key still generates rather than failing at spend time. An explicit per-project provider, and an explicit `image_model`, both outrank the table.

**MCP.** Discovery is `tools/list` → `tools/call`; no integration code on the agent side. Film Engine's server is hand-rolled JSON-RPC over stdio, exposing 38 tools generated from the node-type registry and the flows router, so a new node type becomes a tool without anyone remembering. Nothing declares `kind: 'mcp'` as a *provider* transport, and per this research nothing should — that shape stays wired for a vendor that offers only MCP.

**Verification.** `lib/e2e-preflight.js` derives its generating stages from `PIPELINE_STEPS` and `STEP_CAPABILITY` rather than listing them, so a tenth pipeline step cannot appear unaudited.

---

## Open Questions

1. **Does `character_performance` actually satisfy our `lipsync` contract?** Runway's own *Characters* documentation describes real-time WebRTC avatars — `gwm1_avatars`, five-minute sessions — which is **not** batch lip-sync-this-clip. The `character_performance` endpoint is confirmed official and separate, but its inputs, duration limits and output shape need reading against the API reference before any adapter work. The Act-Two/lip-sync endpoint lists circulating on `github.com/useapi/runway-api` are a **third-party reseller's** wrapper, not Runway's API, and must not be built against.
2. **Should `post` be closed locally instead of in the NLE?** Upscale, face restore and grade are ffmpeg-shaped work. ffmpeg is not installed on this machine and is not a dependency of the backend, which currently has exactly one.
3. **Is `stock` worth keeping as a capability?** It has no adapter, and the music-rights routes are built around a `license_source` nothing ever writes.
4. **Does `solveShot` frame against the sensor or the delivered frame?** It uses the sensor, so a close-up solved for 0.45 m of subject delivers 0.25 m once a 2.39:1 extraction is taken. The viewer shows both numbers; changing the solver would change a phase-1 exit criterion, so it is a decision rather than a bug.
5. **Where should the NLE handoff be visible to a user?** It is correct, documented and currently invisible outside the preflight.

---

## Recommended Direction

**Run the 30-second test first, then close lip-sync.**

The pipeline is one credential away from end-to-end. Supplying `RUNWAY_API_KEY` and driving `backend/tests/fixtures/thirty-second.fountain` through will surface real integration problems that no amount of further analysis will.

**Carried forward from the research step, unchanged:** no live paid generation has been run — the pipeline has been *proven ready*, it has **not been run**, because video is blocked on a credential only you hold and I did not spend money without asking. The `character_performance` adapter is **not built**, deliberately: its request shape still needs verifying against the real API reference, and building on the reseller's documented shape is precisely the trap this research avoided. `lipsync`, `post` and the audio mix remain handed to **Premiere** via the four-lane NLE export.

Then take `character_performance`, in this order, because each step de-risks the next:

1. Read the Runway API reference for its real request shape — **not** the reseller's.
2. Extend `lib/providers/runway.js` to declare `lipsync`, reusing the existing task-create-and-poll path.
3. Add it to `PREFERRED_WHEN_CONFIGURED` so a new project picks it up with no setup.
4. Re-run `preflight --all`; the expected result is 12 ready, 2 handed off, 0 blocked.

That reduces the NLE handoff from three stages to two, and leaves `post` and the audio mix as a deliberate finishing decision rather than a gap — which is a defensible place to stand.

---

## Sources

- [MCP vs REST APIs: Which One Should Developers Use in 2026? — PublicAPI](https://publicapi.dev/article/mcp-vs-rest-public-apis-2026)
- [Model Context Protocol: Complete 2026 Guide — SitePoint](https://www.sitepoint.com/model-context-protocol-mcp/)
- [Integrating Image Processing APIs with MCP — deep-image.ai](https://deep-image.ai/blog/model-context-protocol-mcp-image-processing-api/)
- [The 12 Best AI Tools for Filmmakers in 2026 — Storyflow](https://storyflow.so/blog/best-ai-tools-for-filmmakers-2026)
- [Best 18 AI Filmmaking Tools in 2026 — Frameo](https://frameo.ai/blog/ai-filmmaking-tool-overview-features/)
- [Runway Characters — Core Concepts (official)](https://docs.dev.runwayml.com/characters/concepts/) — real-time WebRTC avatars, *not* batch lip-sync
- [Runway API SDKs (official)](https://docs.dev.runwayml.com/api-details/sdks/) — confirms `POST /v1/character_performance`
- [useapi/runway-api — GitHub](https://github.com/useapi/runway-api) — **third-party reseller**, not Runway; its endpoint list is not authoritative
