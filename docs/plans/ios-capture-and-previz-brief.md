# Research Brief: iOS Capture and Previz Finalization

*Compiled 2026-09-07 from the Deep Research pass. Every claim about this codebase
is held to the source by `backend/tests/ios-previz-brief.test.js` — a plan whose
facts have drifted is worse than no plan.*

Covers four asks: an iOS app that shoots footage into video shots; changing a
shot's background while keeping the actor; finishing the previz console to the
design; and why the Glass Harbour diner environment plate looks wrong.

---

## Executive Summary

Three of the four asks are blocked by a missing **control**, not a missing
capability: the previz console's two headline panels have a complete, routed,
MCP-exposed backend that the page never calls, four feature flags for it are
switched **on** and read by nothing, and the iOS app already declares camera
permission it never wired. The diner plate is not a prompting problem — it is an
input-format problem, and the fix for it *is* the iOS capture ask, which makes
those two asks one piece of work rather than two. Only one thing here is a
genuine capability gap: replacing a background in real footage has no provider
path at all, because no video-to-video model is registered.

---

## Key Themes

- **Wiring, not building.** `cinematography.js` already holds
  `buildBrief`, `exploreBrief`, `validateProposal`, `applyProposal`,
  `acceptCandidates` and `compareCameras`, routed at
  `/film/shots/:id/direct[/explore]` with four MCP tools. `src/index.html`
  contains **zero** occurrences of `camera/propose`, `camera/explore` or
  `cinematography`.

- **Declared and unread — the repo's own recurring failure.** Five world-engine
  sub-flags exist in `app-settings.js` (`marble_generation`,
  `cinematography_ai`, `reference_match`, `camera_explore`, `world_splats`);
  four are `true` on the live install; **none of the five appears anywhere in the
  page**. Only `world_engine` is wired. This is the shape already paid for by
  `NEVER_WRITES`, `scope`, `describeResolution` and `voice_id`.

- **Green tests that cannot see the problem.** `world-console.test.js` passes 14
  tests, every one of them behavioural — overlays toggle, FOV is derived, no demo
  strings ship. None asserts region **presence or placement**. That is precisely
  the gap that let the character, location and prop sheets ship visibly wrong
  against 70 passing tests. Any task here needs a placement test or it will ship
  green and wrong again.

- **The plate problem is an input-format problem.** Marble's own documentation
  calls a 360° panorama *"maximum control over world layout and the most accurate
  spatial representation"*, and the indoor-reconstruction literature agrees:
  360-GS optimises from **four indoor panoramas** under room-layout priors, and
  LighthouseGS targets phone-rotated panorama captures. The engine is instead
  asking a ratio-only, edit-mode image model for unrelated perspective frames of
  a room described in 3,855 characters of explicit layout.

- **Every hard limit found is a size or a URL.** Aleph needs a fetchable public
  URL and 2–30 s. Seedance `images_list` refuses data URIs. Marble caps video at
  100 MB. `body-limit.js` sets `FILE_LIMIT = 150 * 1024 * 1024` of **base64**,
  about 112 MB of file, against ~400 MB/min for iPhone 4K60.

- **"Isolated by the shot" is already the spine.** `film_previs_blocking` is
  `UNIQUE(shot_id)`, worlds pin per shot, the anchor is one-per-project set
  explicitly, and `frame-handles.js` mints *scoped*, expiring handles. A
  shot-scoped capture session inherits all of it.

---

## Top Ideas & Opportunities

**1. Wire the console's absent regions to the backend that already exists.**
*What:* Build the seven design regions the page does not render — Header bar,
Left rail (Shots), **Direct the Shot**, **Explore Shot**, Camera Operate,
Secondary strip, Advanced strip — against `cinematography.js`, and read the four
live flags.
*Why:* Direct the Shot (intention → camera consequence) and Explore Shot (six
cameras, one world, with Compare) are the design's own headline concepts. Both
have working server logic and no way in.
*How:* No new backend. `camera_propose` supplies the deltas for the seven
intention presets; `camera_explore_brief` / `camera_explore_accept` supply the
A–F tiles; `compareCameras` is Compare mode, already written and never called.

**2. Ship the two-line change that may deliver most of the footage ask.**
*What:* Add `NSMicrophoneUsageDescription` to the iOS `Info.plist` (**done 2026-09-07, ICP-001**) and a
`capture` attribute to `mediaUploadControl` / `uploadControl`.
*Why:* The Video Shots page **already** renders
`mediaUploadControl('video','video','shot', …)`, and the WKWebView ships
`src/index.html` byte-identical, so clip upload to a shot works from the phone
today. `NSCameraUsageDescription` is already declared. The only reason video
capture does not work is that iOS terminates an app that starts it without the
microphone key — which matches the WKWebView crash reports exactly.
*How:* One plist key, one attribute, then re-sync the bundled copy. This should
be sized and tried **before** any native capture work is estimated.

**3. Capture the real space instead of imagining it.**
*What:* Shoot the location on the phone — a 360 panorama, a short orbit video, or
a LiDAR scan — and feed it to the world, rather than generating a location plate.
*Why:* This is the fix for the diner *and* the environment-into-previz ask at the
same time. No diffusion model has to invent a room it was told about in prose.
*How:* Closer than it looks — `routes/worlds.js` already passes `body.video`
through to `generateVersion`, and the Marble adapter already handles video and
panorama prompts. What is missing is a settable `is_pano`, a capture-shaped
import target, and a size policy.

**4. Register a video-to-video model so "keep the actor, change the background"
becomes possible at all.**
*What:* Add Runway **Aleph 2.0** (`aleph2`, `video_to_video`) to
`RUNWAY_VIDEO_MODELS` with a rate-book row and a budget gate.
*Why:* It is documented for exactly this — *"replace the background of footage
with a new environment … while preserving your subject and foreground
elements"* — and it is in an API this engine already speaks. Today
`RUNWAY_VIDEO_MODELS` holds **11** ids, all image/text→video, and `aleph`
appears **nowhere in the repo**.
*How:* `inputs.video` (public URL, 2–30 s, ≤1080p), `positivePrompt` ≤1000 chars
describing only what changes, `inputs.frameImages` up to 5 pinned to
`first`/`last`/timestamp. `frame-handles.js` already solves the public-URL
requirement.

**5. Use the shot as the unit of a capture session.**
*What:* Select a shot in the app; every photo, clip and scan lands against that
shot.
*Why:* It is what was asked for, and it is already how the engine is shaped.
*How:* Reuse `film_previs_blocking`'s per-shot uniqueness, the per-shot world
pin, and scoped frame handles. Camera choice explored on the phone writes back
through the same `previs/apply` path a staged angle already uses.

**6. Render the world panel with the renderer the design names.**
*What:* Spark (`sparkjsdev/spark`) for the Spatial World panel.
*Why:* The design explicitly names World Labs' Spark / three.js as the intended
path, and `world_splats` is the one sub-flag currently `false`.
*How:* Not a drop-in. `gridlight.json` pins `build.target: single-html`, the page
is 2.6 MB with three.js r149 vendored inline, and Spark 2.0 is ESM expecting a
modern three. This deserves its own ADR, as the original Three.js decision did.

---

## Technical Approaches

### Why the diner plate looks wrong — three causes, all live

| # | Cause | Evidence |
|---|---|---|
| 1 | **The resolution floor cannot be honoured.** | `reference-plates.js` declares `LOCATION_MIN_EDGE = 2048`; meshy is `sizeControl: 'ratio-only'` with `maxImagePixels` long edge **1376**. Measured 2026-09-07, all three diner plates are **1376×768** on a project set to 2048×1080. |
| 2 | **The extra views are un-anchored.** | meshy is `referenceMode: 'edit'`, so by the documented rule a new view **drops every reference and is generated from words alone**. The east and south plates carry `style_applied: true` and no `anchored` field — three independently imagined diners, not three sides of one room. |
| 3 | **A flat frame cannot encode a room.** | The description is 3,855 characters of explicit layout. The stored refine instruction on the default plate is itself the evidence: it exists because the model painted the harbour as a **mural on the glass** instead of a real exterior seen through it. |

**Truncation is ruled out.** meshy's `promptLimit` is 16000, so the description
plus the style preset fits comfortably. This is worth stating because it is the
intuitive first guess and it is wrong.

**Remedies, in order of leverage.** (a) Move location plates to a provider that
reaches the floor — `google-image` and `muapi-image` are 3840, `bfl-image` is
`exact`. (b) Stop generating extra views on an edit-mode provider. (c) Replace
the plate with a captured or reconstructed world for interiors.

### Marble input contract (from World Labs' documentation)

| Input | Note | Time |
|---|---|---|
| Text | — | ~30 s to panorama |
| Single image | — | ~30 s |
| **Panorama** | *"maximum control over world layout and the most accurate spatial representation"* | ~30 s |
| Multi-image | Front/Back/Left/Right or Auto Layout; the adapter caps at 4 with a compass→azimuth map | ~2 min |
| **Video** | *"short video clips (under 100 MB)"* | ~2 min |

Full world ~5 min; high-quality mesh ~**1 hour**. Also new: **Atlas**
(2026-09-01) turns prompts, photos and clips into 3D worlds *and* camera-
controlled video up to 1440p — worth watching, since it would collapse world and
video generation into one vendor.

### The two capture products are complements, not alternatives

| | Marble (video / panorama) | RoomPlan · LiDAR |
|---|---|---|
| Output | Gaussian splat, photographic | Parametric geometry, USDZ; third-party scanners export GLB |
| Geometry | Statistical | Exact |
| Scale | **None** until something is measured (`world-scale.js` already records this) | Metric |
| Texture | Real | None |
| Best for | The look | Blocking, and calibrating Marble's scale |

`lib/glb-parser.js` and the `three-d-model` import target already ingest GLB, so
the LiDAR path reaches the existing grey-box stage with no new parser.

### The alternative to Aleph was already probed here, and it lost

`docs/plans/rbf-001-video-edit-probe.md` measured Seedance `video-edit`:
`images_list` acts as **style references composited into the scene, not
keyframes**; it **refuses data URIs**; it enforces a ≈854×480 source floor;
`duration` is **ignored**; and it **bills by source length and bills failed
jobs**. That probe overran its estimate **4.7×** at $3.205. Aleph costs
28 credits/s with a 56-credit minimum — $0.28/s, $1.40 for a 5 s attempt — which
is expensive but predictable.

### Reaching the Mac

`NSBonjourServices` is absent, so the LAN address is typed by hand. Planning
caveat: `NSNetService` — the only API that *resolves* a discovered service to an
IP — is deprecated, and its `NWBrowser` replacement discovers but does not
resolve. Zero-config discovery is real work, not a checkbox.

---

## Open Questions

1. **Marble, RoomPlan, or both — and which answers which question?** The brief's
   position is "both, for different jobs", but this is a scope decision.
2. **Is the previz work a wiring epic or a redesign?** The evidence says wiring:
   7 of 14 regions absent over a backend that is already built. Confirm before
   tasks are written.
3. **Capture size policy.** What resolution and duration may a phone capture be,
   given a ~112 MB body ceiling, a 100 MB Marble cap and a 2–30 s Aleph window?
   And does the engine gain a raw-binary upload path to remove base64 inflation?
4. **Two unverified provider contracts.** The Marble adapter's own comment flags
   `world_prompt.video.video_prompt` as verified from a 422 but **recorded it nowhere** (corrected 2026-09-07: the brief first read this as *guessed*, which mis-read the comment; the defect was that nobody could re-check it — now snapshotted, ICP-004), and Aleph's field-level
   schema here came from an aggregator's docs rather than
   `docs.dev.runwayml.com`. Both need confirming before an adapter entry ships.
5. **Spark and the single-HTML constraint.** Accept an ADR, defer splats, or keep
   the hand-rolled renderer?
6. **Aleph's cost gate.** At $0.28/s with a 56-credit floor, does a background
   replacement need its own confirmation and budget refusal?
7. **The MCP database split.** The API reads its DB from `FILM_DATA_DIR`
   (currently a `gridlight-profiles/_attic/…` path) while the MCP server has no
   such env and falls back to `~/.gridlight/film-engine/data`. The two hold
   different projects. Which is canonical is the user's call, and it bears
   directly on the goal's "use MCPs wherever we can".

---

## Recommended Direction

**Sequence the previz asks as one piece of work, in this order: capture first,
then plates, then the console.** The instinct to treat "the diner looks weird"
and "let me shoot an environment with my phone" as two features is the single
most expensive mistake available here — the second is the fix for the first, and
doing plates first means paying to improve pictures that capture would replace.

Concretely, in dependency order:

1. **The two-line iOS capture unblock** (mic key + `capture` attribute). Smallest
   possible change, on the path everything else needs, and it may satisfy most of
   the footage ask before any native work is scoped.
2. **A capture-shaped import target and a size policy**, settable `is_pano`, and
   a decision on raw-binary upload. This is the foundation for both the
   environment-into-previz ask and better plates.
3. **Register Aleph** as the `video_to_video` path with its rate-book row and
   budget gate, and explicitly retire the Seedance `video-edit` route on the
   recorded RBF-001 evidence rather than leaving it as a tempting alternative.
4. **Wire the console's seven absent regions** to the backend that already
   exists, and make the four live flags actually reach the page. **Every task
   here carries a placement test** — asserting a region renders, and in which
   column — because the existing suite is green and blind to exactly this.
5. **Defer Spark** behind an ADR. `world_splats` is already `false`; leaving it
   false costs nothing today and buying a bundler costs the single-HTML
   architecture.

The one thing worth saying plainly: item 4 is the ask that was phrased as a
complaint, and it is the *least* blocking of the five. Items 1–3 are what stand
between this engine and footage a director can actually re-shoot.
