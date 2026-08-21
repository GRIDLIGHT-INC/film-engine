# Epic: Production Management Parity for AI Film Production

## Overview

Film Engine matches or beats StudioBinder on everything creative — screenwriting, breakdown, shot
lists, storyboards, blocking — and owns an axis StudioBinder has no counterpart for: generation,
3D previs with real optics, provider routing, render reproducibility, cost gating and an agent
surface. A 42-feature audit against StudioBinder's own product pages scored **8 HAVE, 7 PARTIAL,
27 MISSING**, and every missing item is production-management connective tissue: schedule, tasks,
reports, contacts, sharing, identity. Scheduling is missing 5 of 5; collaboration 4 of 5.

This epic builds that tissue in the order that makes the pipeline *correct* first and *complete*
second. The lead feature is not on StudioBinder's list by name. Their real claim is **propagation**
— edit a scene and the breakdown, schedule and call sheets update. Our version is stronger and
entirely absent: edit a scene and the scene card, plates and generated frames stay silently valid.
We have already paid for that once. A clip-art character plate survived its own fix by fourteen
hours, was cached, and poisoned every frame referencing it; the only signal was a director looking
at eight frames and feeling something was off. At feature length that defect is unreviewable, and
it spends money on every wrong frame.

The epic delivers, in four phases: a dependency graph that marks derived artefacts stale when
their inputs change (P1), a run plan that orders generation into costed batches and the two
reports that fall out of repaired presence data (P2), the look-development and markup surfaces
that close the creative loop (P3), and identity only if it is asked for (P4). It explicitly does
**not** deliver the film itself — `assembly` remains a no-op, tracked separately as SHIP-001..006.

## Business Goals

- **Stop spending on stale output**: a derived artefact whose inputs changed must say so before a
  provider is called, not after the invoice.
- **Make the board trustworthy at feature length**: 8 shots can be eyeballed; 1,500 cannot. The
  system, not the director, has to notice a poisoned plate.
- **Give AI production a real scheduling story**: order shots into batches that minimise model
  swaps and plate re-generation, with cost projected before the run rather than discovered on the
  ledger.
- **Close the creative loop**: decide a look before generating, and mark up a frame after — the
  two ends of the iteration cycle that currently have no surface.
- **Keep every new capability agent-reachable**: the rabbit-hole note, and the reason entity
  creation was impossible for an agent until this week.
- **Reach parity without importing irrelevance**: weather lookup and call-sheet SMS are not AI
  production; naming them out of scope is a deliverable, not an omission.

## Current State

| Component | Current State |
|---|---|
| Derived-artefact staleness | **None.** No artefact records what it was generated from (`grep -rl input_fingerprint` → 0 files). Editing a scene card, a description or a plate leaves every downstream frame valid-looking. Two hashing mechanisms exist and neither does this: `graphFingerprint` identifies a flow graph, and `film_previs_blocking.approved_fingerprint` (migration 062) detects a restaged previs approval. The second is the right shape and the wrong scope |
| Generated artefact kinds | 12: the 8 orchestrated capabilities in `STEP_CAPABILITY` (image, video, voice, lipsync, music, sfx, ambient, post) + 3 plate kinds (character sheet, location plate, prop plate) + the scene card itself |
| Generation job tracking | 12 `*_jobs` tables; `film_assets` with 22 types. Jobs record status and output path, never inputs |
| Scene/character presence | **Broken and partly dead.** `film_scene_characters` and `film_scene_props` have **0 INSERT sites and 0 rows**. Presence lives in `film_scenes.characters_present`, populated from **dialogue cues only** — on Wingfall it reads `["MAYA"], [], ["MAYA"]`, so the DRAGON appears in no scene |
| Shooting schedule | Absent. `lib/scheduling-engine.js` is **GPU model-residency and VRAM batching** (`MODEL_PROFILES`), not a stripboard; there is no shoot-day or strip concept |
| Cost control | `lib/flow-cost.js` projects per-capability cost; runs refused at HTTP 402 above `budget_total`. Not wired to any batch/plan abstraction |
| Reports | None as artefacts. No sides, no DOOD, no breakdown summary, no elements list |
| Look development | Absent. `style_preset` is a free-text project column with no validation — it carried the subject noun "anatomical beast" and put a creature in an establishing shot the card describes as "Empty, ordinary, still." |
| Storyboard markup | Absent. Panels are generated images; no arrows, text or shapes, and no panel grouping |
| Shot creation from script | Manual or agent-driven. `film_script_elements` stores element-level data; nothing turns a selected line into a shot |
| Identity | **No user, team, auth or session table exists.** Single-operator by construction |
| Agent surface | 64 MCP tools, dispatched through an in-process route shim (`callRoute`), generated from the registries |
| Final film | `assembly` returns `{ok:true, message:'Assembly step: use export endpoints to finalize'}`. Nothing concatenates shots. Tracked as SHIP-001..006, **not this epic** |

## Target State

| Component | Target State |
|---|---|
| Derived-artefact staleness | Every one of the 12 generated kinds records an input fingerprint; changing an input marks descendants stale; generation refuses a stale-input run unless overridden, mirroring the existing 402 budget gate's override shape |
| Staleness visibility | Stale artefacts are visible in the UI and reported over MCP, so a director sees the state before generating rather than after |
| Presence data | Populated from action **and** dialogue, reusing `actionIntroducedCharacters()`; the dead tables are either written to or dropped, decided once |
| Reports | Sides (per-character dialogue packet) and DOOD (who appears where) generated from repaired presence, exported as artefacts |
| Run plan | Shots ordered into costed batches over `MODEL_PROFILES`, projected by `flow-cost.js`, refusable by the 402 gate, with alternates under a ceiling |
| Look development | A board where references are gathered and a style decided before generating; its output *is* the style preset and the plate set. Style presets validated to carry look, not subjects |
| Storyboard markup | Arrows, text and shapes over a generated frame, grouped by scene/location/batch, exportable |
| Shot from script | Select a line of action or dialogue → a shot exists, with presence captured from the same selection |
| Identity | Unbuilt unless asked for. Named out of scope in this epic rather than left as implicit debt |
| Agent surface | Every route added by this epic is MCP-reachable, asserted by the existing set-based registry test |

## Constraints

- **One backend dependency**: `better-sqlite3` and nothing else (ADR-002). No mail, no SMS, no
  scheduler library, no image library. Anything needing them is out of scope or agent-delivered.
- **No bundler**: `gridlight.json` pins `build.target: single-html`. Boards and markup are
  hand-rolled canvas/SVG in the existing SPA, as previs and the flows canvas already are.
- **SQLite CHECK constraints cannot be widened in place** (migration 042 recorded this). New
  artefact kinds use a `metadata.kind` discriminator or a table rebuild.
- **Byte-identical guarantee**: `tests/fixtures/video-payload-golden.json` pins 54 payloads.
  Unblocked shots must keep generating identically; regenerating that fixture deletes the guarantee.
- **Every new route MCP-reachable by default**, dispatched through `callRoute` rather than
  reimplemented — one validator, one set of bugs.
- **Set-based tests over registries**, not examples. Every failure this epic responds to was
  partial: locations plated well while characters produced clip art; description reached the
  storyboard panel while dialogue did not.
- **Additive migrations only**: existing projects must keep loading and generating unchanged. A
  shot with no fingerprint is not "stale", it is outside the workflow.
- **No new sequencer without retiring one**: `PIPELINE_STEPS` and the flows engine already order
  work. A third is a design failure, not a feature.
- **Identity is deferred by decision**, not by oversight. P4 is conditional.

## Task Breakdown

### Phase 1: The Dependency Graph (correctness first)

| Task | Title | Description | Size | Dependencies |
|---|---|---|---|---|
| PAR-001 | Fingerprint contract | Define what an input fingerprint covers per artefact kind and where it is stored. Generalise `blockingFingerprint()`: sha256 over the inputs that change the output, deliberately excluding derived fields (the sampled path is excluded from previs approval for exactly this reason). ADR. | M | None |
| PAR-002 | Fingerprint storage migration | Additive columns (`input_fingerprint`, `generated_at`) on `film_assets` and the 12 `*_jobs` tables, NULL-defaulted so existing rows are outside the workflow rather than retroactively stale. | S | PAR-001 |
| PAR-003 | Record fingerprints on generate | Every one of the 12 generated kinds writes its fingerprint at persist time. Set-based test iterating `STEP_CAPABILITY` + the 3 plate kinds; a kind that generates without recording fails. | L | PAR-002 |
| PAR-004 | Staleness resolver | `isStale(artefact)` — recompute the fingerprint from current inputs and compare. Pure function, no I/O, mirroring the `pipeline-engine` / `routes` split. | M | PAR-003 |
| PAR-005 | Descendant propagation | Editing a scene card, character, location, prop or style preset marks descendants stale transitively (card → keyframe → video → lipsync → post). Derived from `PIPELINE_STEPS.depends`, not a second hand-written graph. | L | PAR-004 |
| PAR-006 | Stale gate on generation | Generation reports stale inputs and refuses, overridable via `ignore_stale` — same shape as `ignore_budget` and `ignore_approval`. A never-fingerprinted artefact is never gated. | M | PAR-005 |
| PAR-007 | Staleness over MCP + UI | A `staleness_report` tool and a visible badge per shot/board, so the state is seen before spending. | M | PAR-006 |
| PAR-008 | Presence repair | Populate scene presence from action **and** dialogue via `actionIntroducedCharacters()`; decide and execute the dead-table question (write to `film_scene_characters`/`film_scene_props` or drop them). Set-based over characters *and* props. | M | None |

### Phase 2: The Run Plan and the Reports It Enables

| Task | Title | Description | Size | Dependencies |
|---|---|---|---|---|
| PAR-010 | Batch/strip data model | A "strip" groups shots into one generation batch. Decide first whether it sits **above** the pipeline orchestrator or replaces it — no third sequencer. | M | PAR-001 |
| PAR-011 | Batch ordering | Order strips to minimise model swaps and plate re-generation, over `MODEL_PROFILES`. Skips artefacts that are fresh, which is why P1 comes first. | L | PAR-010, PAR-004 |
| PAR-012 | Costed plan + 402 gate | Project each strip's cost via `flow-cost.js`; refuse a plan exceeding `budget_total` before anything generates. | M | PAR-011 |
| PAR-013 | Alternate plans | Two or more orderings under a ceiling, comparable side by side. | M | PAR-012 |
| PAR-014 | Sides report | Per-character dialogue packet from repaired presence; exported as an artefact. Drives voice-generation review. | S | PAR-008 |
| PAR-015 | DOOD report | Which character appears in which shots → refsheet/voice needs and per-character spend. | S | PAR-008 |
| PAR-016 | Breakdown summary + elements list | The two remaining named StudioBinder reports, over the same presence data. | M | PAR-008 |
| PAR-017 | Run notification | Report batch completion, cost and failures. No mail/SMS dependency exists, so delivery is over MCP to the agent host — the reinterpreted call sheet. | S | PAR-012 |

### Phase 3: Closing the Creative Loop

| Task | Title | Description | Size | Dependencies |
|---|---|---|---|---|
| PAR-020 | Mood board | Gather references and decide a look before generating. Extends `film_continuity_refs`; the board's output is the style preset and plate set. | L | None |
| PAR-021 | Style preset validation | Reject or warn on subject nouns in `style_preset` — the "anatomical beast" defect, caught at the source rather than in eight frames. | S | PAR-020 |
| PAR-022 | Shot tagger | Select a line of action or dialogue → a shot exists, capturing presence from the same selection. Uses `film_script_elements`. | L | PAR-008 |
| PAR-023 | Storyboard annotation | Arrows, text and shapes over a generated frame. Hand-rolled canvas; no library. | L | None |
| PAR-024 | Panel grouping | Group panels by scene, location or batch; export the board with notes. | M | PAR-023 |
| PAR-025 | Camera/lighting setup grouping | Group shots into setups by plate/style/seed reuse — the AI reading of a camera setup. | M | PAR-011 |
| PAR-026 | Annotation → regeneration | **Built.** Noted markup reaches the next prompt; `annotation_feedback` defaults to off, so no existing board changes. Answers Open Question 3. | L | PAR-023 |

### Phase 4: Identity and Sharing *(conditional — build only if asked for)*

| Task | Title | Description | Size | Dependencies |
|---|---|---|---|---|
| PAR-030 | User/role schema | Owner/Admin/Member. Greenfield: no auth layer exists. | L | Decision |
| PAR-031 | View-only share links | Show a client a board or a cut without an account. | M | PAR-030 |
| PAR-032 | Comments on frames and boards | Extends existing screenplay comments and shot notes to visual artefacts. | M | PAR-030 |
| PAR-033 | Activity feed | Run and spend audit trail, partly latent in `render_ledger`. | M | PAR-030 |

## Open Questions

1. **Does the run plan sit above the pipeline orchestrator or replace it?** `PIPELINE_STEPS` and
   the flows engine already sequence work. A strip abstraction that becomes a third sequencer is
   a design failure. Blocks PAR-010 and therefore all of Phase 2.
2. **What is a "shooting day" in AI production?** A budget window, a provider session, a
   wall-clock batch, or purely a grouping device? Blocks the PAR-010 data model.
3. **Should annotation drive re-generation or only inform it?** *Answered: both, and the
   project chooses.* Noted markup composes into the prompt when `annotation_feedback` is on;
   default off, so every existing board is byte-identical and adoption is a decision rather
   than something that happened to a director overnight. Geometry alone stays notation —
   a shape says where and never what — and the marks it cannot use are named rather than
   dropped. PAR-026 exists and is built.
4. **Retire or populate the dead presence tables?** `film_scene_characters` and
   `film_scene_props` have zero writers and zero rows. Blocks the second half of PAR-008.
5. **What exactly does a fingerprint cover?** Too broad and every edit invalidates everything;
   too narrow and the plate defect recurs. Named as PAR-001 but genuinely unresolved.
6. **Are contracts, SSO, whitelabel and mobile out of scope?** Weather/hospitals is confirmed out.
   These four were candidates and remain unruled — naming them beats scoring them missing forever.
7. **How does this epic interleave with SHIP-001..006?** The user chose parity phasing but was
   never asked to trade it against the conform. None of the 42 parity features produce a film, and
   the acceptance criterion is a film. This needs an explicit answer, not an assumption.

## Success Metrics

- Editing a character description, a style preset or a scene card marks every downstream artefact
  stale — proven by a set-based test iterating all 12 generated kinds, not by one example.
- A generation run against stale inputs is refused with a named reason and an override, and a
  project that predates fingerprinting generates byte-identically (golden fixture unchanged).
- The Wingfall plate defect is reproducible as a test: regenerate the plate builder, and every
  frame that referenced the old plate reports stale.
- Scene presence includes non-speaking characters — the DRAGON appears in the scenes it is in —
  asserted over characters *and* props.
- Sides and DOOD generate for a project with no manual data entry.
- A run plan reports projected cost before generating and is refused at HTTP 402 above budget.
- A style preset containing a subject noun is rejected or warned at the point of entry.
- Every route added by this epic appears in the MCP tool list, asserted by the existing
  registry test in both directions.
- Full suite green and growing: 1,350 tests today, each phase adding set-based coverage.
- **Not a metric for this epic:** a finished film. That is SHIP-001..006, and this epic must not
  be read as delivering it.
