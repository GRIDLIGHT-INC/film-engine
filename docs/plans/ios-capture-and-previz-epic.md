# Epic: iOS Capture and Previz Finalization

*Derived from `docs/plans/ios-capture-and-previz-brief.md` and the user's
direction of 2026-09-07: **follow the brief's order**. Every claim here is held
to the source by `backend/tests/ios-previz-epic.test.js`.*

## Overview

This epic closes four asks that arrived as separate complaints and turn out to be
one dependency chain. A director wants to shoot footage on a phone and drop it
into a video shot; to change a shot's background while keeping the actor; to have
the previz console actually match the design it was built from; and to know why
the Glass Harbour diner environment plate looks wrong. Measured against the code,
three of those four are blocked by a missing **control** rather than a missing
capability — the work is mostly wiring things that already exist and are
unreachable.

The single structural insight is that **capture comes before plates**. The diner
plate is not a prompting failure; it is an input-format failure — a ratio-only,
edit-mode image model being asked for unrelated perspective frames of a room
described in 3,855 characters of layout. The fix is to photograph the real space
rather than to describe it better, which is the same work as the
shoot-an-environment-into-previz ask. Doing plates first means paying to improve
pictures that capture would replace, so the sequence is deliberate and not merely
convenient.

What it delivers: a phone that can shoot into a shot; a captured or reconstructed
environment that replaces an invented one; the first video-to-video model this
engine has ever had, making background replacement possible at all; and a previz
console that renders the design instead of half of it. It explicitly does **not**
deliver a Gaussian-splat viewport — that is deferred behind an ADR, because
buying a bundler costs the single-HTML architecture and `world_splats` is already
switched off.

## Business Goals

- **Footage a director can actually re-shoot**: get real, phone-shot material
  into the pipeline and back out changed, which is the shortest path to the
  stated acceptance criterion of taking a screenplay through every stage.
- **Stop paying for pictures that will be replaced**: sequence capture ahead of
  plate work so the diner class of spend happens once, not twice.
- **Make built capability reachable**: `cinematography.js` and four live feature
  flags are complete, routed, MCP-exposed and invisible. Reachability is cheaper
  than any new feature in this epic.
- **Close the only genuine capability gap**: register a video-to-video model so
  "keep the actor, change the background" stops being impossible.
- **Do not ship green and wrong again**: every console task carries a placement
  assertion, because the existing suite is structurally blind to the exact defect
  being fixed.
- **Keep the agent path first-class**: every capability added here gets an MCP
  tool, per the goal's standing note to use MCP wherever AI queries happen.

## Current State

| Component | Current State |
|-----------|---------------|
| Previz console regions | **7 of 14** design regions render; Header bar, Left rail, Direct the Shot, Explore Shot, Camera Operate and both strips are absent |
| `cinematography.js` | Complete — `buildBrief`, `exploreBrief`, `validateProposal`, `applyProposal`, `acceptCandidates`, `compareCameras`; routed; 4 MCP tools; **0 page calls** |
| World sub-flags | 5 declared in `app-settings.js`, 4 set `true` on the live install, **0 read by the page** |
| `world-console.test.js` | 14 tests, all behavioural; asserts no region presence or placement |
| Location plates | **Since 2026-09-07 (ICP-008) a location plate leads with a provider that can be told a size and reach the floor, and a demotion is reported.** Previously generated on meshy — `ratio-only`, long edge **1376** against a declared `LOCATION_MIN_EDGE = 2048`; extra views un-anchored because meshy is `referenceMode: 'edit'` — **since 2026-09-07 (ICP-009) the free plan warns before spending, names the provider and the remedy, and every stored view records whether it was anchored** |
| Video models | `RUNWAY_VIDEO_MODELS` holds 11 ids, all image/text→video; no video-to-video path exists; `aleph` appears nowhere in the repo |
| iOS app | WKWebView shipping `src/index.html` byte-identical; `NSCameraUsageDescription` declared; `NSMicrophoneUsageDescription` **declared 2026-09-07 by ICP-001** (was absent, which terminated the app on video capture); ~~no `capture` attribute on either upload control~~ **both armed 2026-09-07 by ICP-002**, additively so the photo library stays reachable |
| Capture ingestion | `MEDIA_IMPORTS` has **18 targets including `world-capture` (added 2026-09-07 by ICP-005)**, accepting a panorama, an orbit clip or a scan under one target; `routes/worlds.js` accepts `body.video`, and `is_pano` is **settable end to end since 2026-09-07 (ICP-006)** against the domain ICP-004 recorded |
| Provider contracts | Marble's video field is **verified and recorded 2026-09-07 by ICP-004** (`fixtures/marble-contract.json`; it had been asserted in a comment with nothing written down, and this epic first mis-read that as *guessed*); Aleph's schema is still known only from an aggregator's docs |
| Upload ceiling | `FILE_LIMIT = 150 * 1024 * 1024`; **since 2026-09-07 (ICP-007) a raw binary upload uses all 150 MB**, while the base64 path still admits about 112 MB. Marble binds a clip lower still, at 100 MB |

## Target State

| Component | Target State |
|-----------|---------------|
| Previz console regions | All 14 design regions render, in the columns and at the widths the handoff specifies |
| `cinematography.js` | Reached from the page — intention presets drive `camera_propose`; the A–F tiles and Compare drive `camera_explore_*` and `compareCameras` |
| World sub-flags | All five read by the page; a flag turned off hides its region |
| Console test suite | Carries placement assertions derived from the design's own headings, so a region moving or vanishing fails |
| Location plates | Generated on a provider that reaches the 2048 floor; extra views no longer generated un-anchored on an edit-mode provider |
| Video models | `aleph2` registered as `video_to_video` with a rate-book row and a budget gate; background replacement reachable from the page and over MCP |
| iOS app | Microphone declared, both upload controls armed for capture, bundled copy re-synced and parity-tested |
| Capture ingestion | A capture-shaped import target; `is_pano` settable end-to-end; a stated size policy inside every ceiling |
| Provider contracts | Both verified against first-party sources before any adapter entry ships |
| The diner | Its environment comes from a captured or reconstructed world rather than an invented plate |

## Constraints

- **Capture comes before plates.** The environment ask is the fix for the plate
  ask. Reordering these means paying twice for the same pictures.
- **Every console task carries a placement assertion.** `world-console.test.js`
  is green at 14 tests and cannot see whether a region renders or where. A
  behavioural test here passes through the entire fix — the identical gap that
  let three subject sheets ship visibly wrong against 70 passing tests.
- **The two unverified provider contracts are prerequisites, not details.** The
  Marble adapter asserted its video field with nothing recorded (closed by ICP-004); Aleph's schema
  came from an aggregator. RBF-001 already measured what an unverified provider
  assumption costs: 4.7× over estimate, $3.205, and failed jobs still billed.
- **Size ceilings bound every capture task.** ~112 MB of file after base64
  inflation against a 150 MB body limit; Marble caps video at 100 MB; Aleph
  accepts 2–30 s at up to 1080p. An iPhone 4K60 clip breaches most of these at
  about 400 MB per minute.
- **A provider must be able to fetch what it is sent.** Aleph needs a public URL
  and Seedance refuses data URIs. `frame-handles.js` already solves this; nothing
  new should be invented for it.
- **Aleph is expensive and priced per second of source.** 28 credits/s with a
  56-credit minimum, $0.28/s — $1.40 for a 5 s attempt. It needs a confirmation
  and a budget refusal like every other paid path.
- **`build.target: single-html`, no bundler.** The page is 2.6 MB with three.js
  r149 vendored inline. Spark 2.0 is ESM expecting a modern three, so it is an
  architectural decision rather than a dependency.
- **The iOS bundle is a copy and must not drift.** `ios-app.test.js` fails if
  `ios/FilmEngine/Web/index.html` differs from `src/index.html` by one byte.
- **Nothing spends without a preview.** Every paid path added here goes through
  the existing confirmation, showing the prompt, the provider and the cost.
- **MCP parity.** Anything a person can do here, an agent can do.

## Task Breakdown

### Phase 1: Capture Unblock

The smallest possible change on the critical path. It may satisfy most of the
footage ask before any native capture work is scoped, because the Video Shots
page already renders a clip upload and the phone already runs the real page.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| ICP-001 | Declare microphone usage | Add NSMicrophoneUsageDescription to ios/FilmEngine/Info.plist. iOS terminates an app that begins video capture without it, which is why selecting Record Video from a web file input crashes rather than failing. | S | None |
| ICP-002 | Arm the upload controls for capture | Add a capture attribute to mediaUploadControl and uploadControl, derived from the accept type rather than hardcoded per call site, then re-sync ios/FilmEngine/Web/index.html so the parity guard stays green. | S | ICP-001 |
| ICP-003 | Prove capture on a real device | Shoot a photo and a clip on the phone into a real shot, and confirm each lands as an asset row, serves over its route and plays back. A simulator cannot exercise the camera path this unblocks. | S | ICP-002 |

### Phase 2: Capture Plumbing and the Plate Fix

Where the environment ask and the diner ask become one piece of work.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| ICP-004 | Verify the Marble input contract | Probe the World API for the real field names and limits for video and panorama input. The adapter's own comment flags world_prompt.video.video_prompt as guessed, and everything downstream is built on it. | S | None |
| ICP-005 | Register a capture import target | Add a capture-shaped entry to MEDIA_IMPORTS covering a panorama, an orbit clip and a scan, with its kind, extensions and asset type derived from the registry rather than typed at each call site. | M | ICP-004 |
| ICP-006 | Make is_pano settable end to end | Accept is_pano on the world generate route, honour it in the adapter, and expose it on the MCP tool. Marble calls panorama the most accurate spatial representation and today nothing can ask for one. | S | ICP-004 |
| ICP-007 | Capture size policy and raw binary upload | State the resolution and duration a capture may be, given roughly 112 MB of file after base64 inflation, a 100 MB Marble cap and a 2-30 s Aleph window, and add a raw binary upload path so a clip need not inflate. | M | ICP-005 |
| ICP-008 | Move location plates off a ratio-only provider | Route location plate generation to a provider that reaches the 2048 long edge, and make the resolution floor report honestly when it cannot be honoured rather than silently delivering less. | M | None |
| ICP-009 | Stop generating un-anchored extra views | Refuse or warn when a second view of a location is requested on an edit-mode provider, since it drops every reference and invents a different room. Name the remedy in the refusal. | M | ICP-008 |
| ICP-010 | Build the diner from a real capture | Shoot the diner as a panorama and as an orbit clip, generate a world from each, and record which input produced a usable stage. This is the acceptance evidence for the whole phase. | M | ICP-005, ICP-006, ICP-007 |

### Phase 3: Video to Video

The one genuine capability gap in this epic.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| ICP-011 | Verify the Aleph contract first party | Confirm the video_to_video request schema, duration window, reference-image handling and credit rate against Runway's own developer documentation rather than the aggregator docs the research used. | S | None |
| ICP-012 | Register aleph2 as a video-to-video model | Add aleph2 to RUNWAY_VIDEO_MODELS with its operation, duration bounds and reference contract, and teach the adapter a video_to_video path it has never had. Source video travels by frame handle, never as a data URI. | M | ICP-011 |
| ICP-013 | Price Aleph and gate the spend | Add a rate-book row at 28 credits per second with the 56-credit minimum, and wire the budget gate so an over-budget background replacement is refused before it bills. | S | ICP-012 |
| ICP-014 | Background replacement on the shot | Offer background replacement on the Video Shots page and as an MCP tool, going through the existing pre-spend confirmation showing the prompt, the provider and the projected cost. | M | ICP-012, ICP-013 |
| ICP-015 | Retire the Seedance video-edit route | Remove or explicitly mark the Seedance video-edit path on the recorded RBF-001 evidence, so it stops reading as a cheaper alternative to a route that was measured to bill failed jobs by source length. | S | ICP-012 |

### Phase 4: The Previz Console

Wiring, not building. No new backend is required by any task in this phase.

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| ICP-016 | A placement test for the console | Derive the region set from the design handoff's own headings and assert each renders and in which column, before any region is built. Written first, and watched fail at 7 of 14. | M | None |
| ICP-017 | Make the four live flags reach the page | Read marble_generation, cinematography_ai, reference_match and camera_explore in the console, so a flag turned off hides its region instead of being declared and ignored. | S | ICP-016 |
| ICP-018 | Direct the Shot panel | Build the intention presets and the proposed-camera delta readout against camera_propose, with Apply writing lens, height and tilt back to the shot. The engine hands over facts and the model proposes; nothing here decides. | L | ICP-016, ICP-017 |
| ICP-019 | Explore Shot panel with Compare | Build the six-camera coverage tiles against camera_explore_brief and camera_explore_accept, plus Compare mode over the already-written compareCameras, which has never been called. | L | ICP-016, ICP-017 |
| ICP-020 | The remaining five regions | Build the Header bar, the Left rail of shots, Camera Operate, the secondary strip and the collapsed advanced strip, each fed from real state rather than the design's demo data. | L | ICP-016 |
| ICP-021 | Layout fidelity to the design | Match the handoff's own geometry — the fixed rail width, the fixed right column, the centre column flex ratio and the page padding — and assert them from the design file so a change to it fails the test. | M | ICP-018, ICP-019, ICP-020 |

### Phase 5: Deferred by Decision

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| ICP-022 | ADR for Spark and the splat viewport | Record the decision on rendering the Spatial World panel with Spark, weighing a Gaussian-splat viewport against the single-html build target and the vendored three.js r149, and state what would change the answer. | S | None |

## Open Questions

1. **Marble, RoomPlan, or both — and which answers which question?** The brief's
   position is both, for different jobs: Marble for the look, RoomPlan and LiDAR
   for exact metric geometry and for calibrating Marble's absent scale. ICP-010
   assumes Marble only. If RoomPlan is wanted, it is a further task and `GLB`
   already imports.
2. **Capture size policy.** ICP-007 must land on specific numbers. Is a raw
   binary upload path in scope now, or is a stated resolution and duration cap
   enough for this epic?
3. **Does Spark get built at all?** ICP-022 records the decision and does not
   make it. `world_splats` stays false either way until it is answered.
4. **Does Aleph need its own cost gate beyond the standard one?** At $0.28 per
   second of *source* with a 56-credit floor, a careless 30 s input costs $8.40.
   The standard budget refusal may not be enough friction.
5. **The MCP database split.** The API reads `FILM_DATA_DIR`, currently a
   `gridlight-profiles/_attic/…` path, while the MCP server has no such env and
   falls back to `~/.gridlight/film-engine/data`. The two hold different
   projects, so an agent and the page disagree about what exists. Unresolved, and
   it bears directly on the goal's standing note about using MCP wherever
   possible.
6. **Do ICP-008 and ICP-009 survive ICP-010?** If a captured world replaces the
   invented plate for interiors, the plate remedies may matter only for exteriors
   — which would shrink Phase 2 rather than grow it.

## Success Metrics

- A clip shot on the phone appears on its shot in the Video Shots page, plays
  back, and reaches the timeline — demonstrated on a real device, not a simulator.
- The diner has an environment built from a real capture, and the director judges
  it usable as a previs stage. This is the acceptance evidence for Phase 2 and
  the answer to the original complaint.
- A location plate generated after Phase 2 measures at or above the 2048 long
  edge, or reports honestly why it cannot.
- A background is replaced on a real shot while the actor is preserved, through
  the pre-spend confirmation, for a cost that matches what was projected.
- The console renders 14 of 14 design regions, in the columns the handoff
  specifies, and the placement test fails when a region is moved or removed —
  proven by mutation, not merely observed green.
- Turning off any of the five world sub-flags hides its region.
- Every capability added is reachable over MCP as well as from the page.
- `node --test --test-concurrency=4 backend/tests/*.test.js` is green, including
  the iOS bundle-parity guard and the docs-drift guard.
