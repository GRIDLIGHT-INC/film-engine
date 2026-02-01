# Gridlight Epic Roadmap — Recommended Implementation Order

## Overview

14 epics, **~724 tasks** total. This document defines the recommended build order based on dependency chains, value delivered per epic, and what's already in progress.

---

## Recommended Order

### Tier 1: Foundation (build first — unblocks everything)

| # | Epic | Tasks | Rationale |
|---|------|-------|-----------|
| 1 | **Image Generation** | 29 | Already 60-70% done on GRD-32. Highest ROI — finish what's started. Validates the Python agent pattern all other generation epics follow. Unblocks storyboards (Film), multi-view images (3D). |
| 2 | **Model Flexibility (HF/GGUF)** | 24 | Self-contained, no dependencies. Improves the core product immediately — users can pick models. Informs how generation agents register model capabilities. |
| 3 | **Desktop Experience** | 95 | **Nearly complete.** Tauri app is fully operational with settings, updates, rollback, marketplace login, service management. Remaining work is feature pages (Film, Music, 3D, model picker) that come with each respective epic. |

### Tier 2: Generation Pipeline (the creative engines)

| # | Epic | Tasks | Rationale |
|---|------|-------|-----------|
| 4 | **Voice-TTS** | 52 | Gateway plumbing already exists. Low VRAM (2-4 GB). Standalone value (read-aloud, accessibility). Unblocks Film Engine Phase 4 (dialogue). |
| 5 | **Music Generation** | 67 | Independent of other generation epics. Standalone value (music production). Unblocks Film Engine Phase 7 (adapters). |
| 6 | **Film Engine** | 86 | The big one — but by now Image Gen, Voice-TTS, and Music Gen are done, so you can build the full pipeline. Start with MVP (33 tasks: project management, storyboard, ledger) while generation agents mature. |

### Tier 3: Scale & Distribution

| # | Epic | Tasks | Rationale |
|---|------|-------|-----------|
| 7 | **Distributed Model Inference** | 21 | By this point you have multiple GPU-hungry agents competing for VRAM. This solves resource contention and enables 70B+ models. Move earlier if you hit VRAM walls sooner. |
| 8 | **3D Generation** | 49 | Depends on Image Gen (done by now). Adds 3D character assets for film characters and game-ready meshes. |

### Tier 4: Enterprise & Platform

| # | Epic | Tasks | Rationale |
|---|------|-------|-----------|
| 9 | **Security & Multi-Tenancy** | 59 | Enterprise prerequisite. TLS, JWT auth, RBAC, multi-tenant isolation, audit logging, HA clustering. Progressive — dev mode stays simple. Build before offering Gridlight to enterprise customers. |
| 10 | **Observability & Ops** | 61 | Enterprise operations. Prometheus metrics, OpenTelemetry tracing, alerting engine, SLO tracking, fleet management. Depends on Security epic for fleet mTLS. |
| 11 | **Long-term LoRA Layers** | 57 | Knowledge distillation from DBs into LoRA adapters. Requires stable RAG pipeline and good training data accumulation. Best after the platform has been running and collecting data for a while. |

### Tier 5: Distribution & Ecosystem

| # | Epic | Tasks | Rationale |
|---|------|-------|-----------|
| 12 | **Marketplace Mobile API** | 32 | Django backend exists, just needs REST API layer. Enables mobile and desktop marketplace integration. |
| 13 | **Mobile App** | 53 | Depends on Marketplace API. Last because desktop is the primary creative tool — mobile is consumption/monitoring. |
| 14 | **MCP Integration** | 39 | Additive, backward-compatible. Connects to external tools (GitHub, Slack, etc.). Nice-to-have, not on the critical path for creative production. |

---

## Parallel Tracks

You don't have to do these purely sequentially. After Tier 1, multiple tracks can run in parallel:

```
Track A (Creative):    Voice-TTS → Music Gen → Film Engine → 3D Gen
Track B (Platform):    Desktop Experience → Marketplace API → Mobile App
Track C (Infra):       Distributed Inference (when VRAM becomes the bottleneck)
                       MCP Integration (whenever convenient)
Track D (Enterprise):  Security & Tenancy → Observability & Ops → LoRA Layers
```

**Track D note**: Security is the foundation for enterprise features. Observability depends on Security for fleet mTLS. LoRA Layers is independent but benefits from data accumulated during Tracks A-C.

---

## Dependency Graph

```
                    Image Generation (1) ──────┬──→ Film Engine Phase 3 (Storyboard)
                         |                     ├──→ Film Engine Phase 5 (Video)
                         |                     └──→ 3D Generation (8)
                         |
Model Flexibility (2) ──→ Desktop Experience (3) ──→ All feature pages
                         |
              Voice-TTS (4) ──→ Film Engine Phase 4 (Voice/Dialogue)
                         |
        Music Generation (5) ──→ Film Engine Phase 7 (Music adapters)
                         |
              Film Engine (6) ──→ Full production pipeline
                         |
Distributed Inference (7) ──→ Multi-GPU scaling for all agents
                         |
          3D Generation (8) ──→ Film character 3D assets
                         |
 Security & Tenancy (9) ──┬──→ Observability & Ops (10) (fleet mTLS)
                          └──→ Enterprise deployments
                         |
Observability & Ops (10) ──→ Fleet management, SLO tracking
                         |
  Long-term LoRA (11) ──→ Knowledge distillation (benefits from data accumulation)
                         |
   Marketplace API (12) ──→ Mobile App (13)
                         |
       MCP Integration (14) ──→ External tool ecosystem
```

---

## Epic Summary Table

| # | Epic | Tasks | Status | Dependencies |
|---|------|-------|--------|-------------|
| 1 | Image Generation | 29 | 60-70% done (GRD-32) | None |
| 2 | Model Flexibility | 24 | Ready | None |
| 3 | Desktop Experience | 95 | **Nearly complete** | None (benefits from 1, 2) |
| 4 | Voice-TTS | 52 | Scoped | None |
| 5 | Music Generation | 67 | Scoped | None |
| 6 | Film Engine | 86 | Scoped | 1 (storyboard), 4 (voice), 5 (music) |
| 7 | Distributed Inference | 21 | Scoped | None (infra) |
| 8 | 3D Generation | 49 | Scoped | 1 (multi-view images) |
| 9 | Security & Multi-Tenancy | 59 | Scoped | None |
| 10 | Observability & Ops | 61 | Scoped | 9 (fleet mTLS) |
| 11 | Long-term LoRA Layers | 57 | Scoped | None (benefits from data accumulation) |
| 12 | Marketplace API | 32 | Django backend exists | None |
| 13 | Mobile App | 53 | Scoped | 12 (API) |
| 14 | MCP Integration | 39 | Scoped | None |
| | **Total** | **724** | | |

---

## Notes

- **Film Engine MVP (33 tasks)** can start immediately — Phases 1A + 1B + 2 + 8 have no generation dependencies. Only Phase 3+ needs Image Gen done first.
- **Distributed Inference** can move to Tier 2 if VRAM contention becomes a blocker while building generation agents.
- **Desktop Experience** is large (95 tasks) but modular — build the shell/nav/settings first, add feature pages (Film, Music, 3D) as those epics complete.
- Each generation epic (Voice, Music, 3D) establishes the same agent pattern: FastAPI scaffold → model integration → gateway endpoints → Docker → tests.
- **Security & Tenancy** uses progressive security — dev mode stays simple (dev-token, plain HTTP). Enterprise features opt-in via env vars.
- **Observability & Ops** is self-contained for single instances but depends on Security for fleet management (mTLS between gateways).
- **Long-term LoRA Layers** benefits from letting the platform run and accumulate training data before attempting knowledge distillation. Start after the RAG pipeline and agent ecosystem are mature.
- **Track D (Enterprise)** can start in parallel with Tracks A-C at any time. Security Phase 1 (TLS) is a good early win.

## Created
2026-01-31
