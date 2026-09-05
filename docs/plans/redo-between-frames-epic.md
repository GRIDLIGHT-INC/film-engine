# Epic: Redo the video between two chosen frames

Date: 2026-09-05 · Slug: `RBF`
Brief: `docs/plans/redo-between-frames-brief.md` · Research: `docs/plans/redo-between-frames-research.md`
User direction: **"Probe first, then build A"**

---

## Overview

A director watching the cut finds a fault: a hand passes through a table, a
figure drifts, two seconds of a five-second shot are wrong. Today the only
remedy is to re-roll the whole shot and lose everything that was right about it.
This epic lets them mark an in-point and an out-point — inside one clip, or
across two — and regenerate only what lies between, then put it back.

The generation is already solved. `lib/video-sequence.js` generates between two
approved stills and `lib/inbetweens.js` densifies a shot into ordered stations;
Seedance's `first-last-frame` workflow takes exactly the two pictures this needs.
What is missing is plumbing that involves no model at all: taking the two stills
out of *finished footage* at a timestamp, cutting a range out of a clip and
substituting a new one in, and a surface to mark while watching.

It delivers a repair operation rather than a re-roll, which changes what a
generated film costs to finish. The unit of correction stops being the shot and
becomes the second.

---

## Business Goals

- **Fix a fault without losing the take.** The frames either side of a mistake
  were paid for and are often exactly right. Re-rolling the shot discards them.
- **Make the cost of a correction proportional to its size.** A two-second fault
  should not cost a five-second generation — subject to the 4-second floor,
  which this epic surfaces rather than hides.
- **Keep the repair inside Film Engine.** The acceptance criterion for the whole
  product is screenplay to finished film *managed from Film Engine*; a fix that
  requires an external NLE breaks that.
- **Do not introduce a second way to describe a range.** A marked in/out is two
  stations. Reusing the existing model inherits approval and staleness instead
  of re-deriving them.
- **Never spend without showing the cost first.** Marking is free; the plan is
  free; only the generation is not.

---

## Current State

| Component | Current State |
|-----------|---------------|
| Generate between two stills | **Shipped** — `lib/video-sequence.js`, N shots → N−1 segments, each pinned to a first and last frame |
| Densify a shot into stations | **Shipped** — `lib/inbetweens.js`, `lib/inbetween-run.js`, with approval and chain semantics |
| Provider first/last frame | **Shipped** — `seedance-2.5-first-last-frame`, `images_list` ordered `[start, end]` |
| Extract a frame at a timestamp | **Shipped once** — `lib/ffmpeg.js` `extractFrame`, reached by `routes/characters.js`, `lib/review-proxy.js` and `lib/mcp-tools.js`. Was three copies; RBF-003 promoted them, which carried review-proxy's past-the-end retry to the two sites that were silently losing frames |
| Join whole clips | **Shipped** — `buildConcatArgs` / `stitchClips` in `lib/ffmpeg.js` |
| Cut a range out of a clip | **Shipped** — `lib/ffmpeg.js` `buildTrimArgs`, `planSplice`, `spliceClip`, joining through the one existing concat. RBF-004 |
| Mark in / mark out | **Shipped** — `pbMarkIn` / `pbMarkOut` on the existing scrubber, with the length against the floor and the cost from the free plan route. RBF-007 |
| Source clip's model / resolution | **Columns exist, values do not** — measured 2026-09-05: all 5 video assets carry no `provider_model` and no `width`/`height`, including the 3 generated in-engine |
| Colour matching a repair | **Shipped but unapplied** — `post/color-match` exists per shot and per project |

## Target State

| Component | Target State |
|-----------|---------------|
| Marked range | Two timestamps, in one clip or across two, expressed as stations on the existing model |
| Frame extraction | One shared helper, used by all callers |
| Trim and splice | `buildTrimArgs` and a substitution-splice helper beside `buildConcatArgs` |
| Planner | **Shipped** — `lib/repair-plan.js` `planRepair`: SYNCHRONOUS, so it cannot have awaited a provider. Refusals derived as a superset of the splice's own. RBF-006 |
| Generation | `first-last-frame` with the two extracted stills. **Not** `video-edit`: RBF-001 measured its `images_list` as style references, so it cannot substitute a section |
| Encoding parameters | **Shipped** — `lib/ffmpeg.js` `inspectMedia`, read from the FILE (`ffmpeg -i`; there is no ffprobe and adding one is a new dependency). RBF-005 |
| Surface | **Shipped** — RBF-007. Cross-clip marks are REPORTED rather than planned: `planRepair` takes one source, so a range spanning a cut is two repairs |
| Refusals | A sub-floor range is refused with both remedies named |

---

## Constraints

- **4-second minimum generation** (`MIN_DURATION = 4`, ceiling 30). A shorter
  fault cannot be regenerated at its own length. This is the constraint that
  shapes the surface, and it is invisible today until a request is refused.
- **No provider-side time range.** Seedance `video-edit` / `video-extend` take a
  whole clip plus a prompt; the vendor documents no start/end. Trim and splice
  are ours.
- **`images_list` means two different things per workflow.** On
  `first-last-frame` it is **ordered keyframes** — `[0]` the frame it starts on,
  `[1]` the frame it ends on; reversed, the move runs backwards and reads as a
  model fault. On `video-edit` it is **style references**: RBF-001 sent a red
  START card and a blue END card and got both composited into the scene
  simultaneously, for the whole clip. One field name, two contracts.
- **Frames must be fetchable by the provider.** `images_list` refuses data URIs
  (`URL scheme should be 'http' or 'https'`), and Film Engine serves media on
  **localhost only**. Nothing in this plan can hand the provider a frame until
  something exposes one at a URL MuAPI can reach. **Shipped by RBF-011:**
  `lib/frame-handles.js` mints an OPAQUE, scoped, expiring handle served at
  `GET /film/frame-handle/:id`. With `FILM_ENGINE_PUBLIC_URL` unset it REFUSES
  and names the remedy rather than handing out a localhost URL, because a
  provider-side fetch failure reads as a credential fault.
- **`video-edit` has a minimum source size.** `video pixel count ... must be
  greater than or equal to 407696` (≈854×480). A 640×360 source is refused, and
  the refusal is billed.
- **Cost is per second**: $0.17 at 480p, $0.34 at 720p, $0.85 at 1080p, $1.70 at
  4K. On `first-last-frame` that prices the clip requested. On `video-edit` it
  does **not**: RBF-001 measured billing against the **source** clip's length,
  `duration` ignored entirely, and a failed request billed anyway. The epic's
  own $0.68 estimate was wrong for that reason — the measured spend was
  **$3.205, 4.7×** — so any `video-edit` costing must price the clip handed in,
  never the clip wanted back.
- **The seam is the risk.** Mismatched model, resolution, frame rate or codec
  produces a visible join. Constant frame rate is materially easier than
  variable.
- **The row cannot supply the encoding parameters.** `provider_model`, `width`
  and `height` are empty on every existing video asset, so the repair must probe
  the file — which is also the only thing that works for imported footage, and
  imported footage is exactly what a director is most likely to be fixing.
- **ADR-002.** No new runtime dependency; ffmpeg is already vendored.
- **Free means free.** A planner that spends cannot be raised speculatively.

---

## Task Breakdown

### Phase 1: Answer the question that resizes the rest

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| RBF-001 | Probe `video-edit` with `images_list` | Send one 480p generation to `seedance-2.5-video-edit` carrying `video_url` plus two stills in `images_list`, and inspect the result: are the stills honoured as start and end keyframes, or treated as style references? Record the answer with the request and the output. Roughly $0.68. | S | None |
| RBF-002 | Record the verdict and branch the plan | Write the probe's answer into the epic and the brief, and state which downstream tasks shrink. **Done:** the verdict is `style-references`, so the antecedent failed — the within-a-clip case still needs the splice, RBF-004 and RBF-006 do not shrink, and the probe's own findings added RBF-011. | S | RBF-001 |

**What RBF-001 decided about the tasks below.** Approach B is dead: the
provider will not substitute a middle section for us, so **the splice is ours**.
**RBF-004 does not shrink** and **RBF-006 does not shrink** — both are required
in full, for the within-a-clip case as well as the cross-clip one. Nothing was
removed by the probe; one task was added.

### Phase 2: The plumbing that involves no model

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| RBF-003 | One frame-extraction helper | Promote `-ss <t> -i clip -frames:v 1` from its three call sites into a single shared helper that returns a path and a reason on failure, and route all three through it. Three copies is how one acquires a fix the others do not. | M | None |
| RBF-004 | `buildTrimArgs` and a substitution splice | Add a trim/segment builder and a `head + new + tail` splice beside `buildConcatArgs`, re-encoding consistently. Test by producing real files and reading back their durations — asserting an argument array proves nothing about whether the output plays. | L | RBF-002 |
| RBF-011 | Expose a frame at a URL the provider can fetch | Serve an extracted frame at an http(s) URL MuAPI can reach, since `images_list` refuses data URIs and Film Engine binds localhost. Discovered by RBF-001, scheduled by nothing before it. Must not open the whole media tree to the internet: a scoped, expiring handle for the frames of one plan, and a stated answer for the operator who is not reachable from outside at all. | M | RBF-002 |
| RBF-005 | Probe the source clip's real parameters | Read width, height, frame rate and codec from the FILE with ffprobe, since the columns are empty and imported footage never had them. Returns a reason rather than throwing when the file is unreadable. | M | RBF-003 |

### Phase 3: The decision surface

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| RBF-006 | Pure repair planner | Marks in, plan out: which frames are extracted, what will be generated, at what duration and resolution, and what it will cost. Spends nothing and refuses a sub-floor range with both remedies named. Mirrors the planner/executor split in `lib/video-sequence.js`. | L | RBF-004, RBF-005 |
| RBF-007 | Mark in / mark out in playback | Two marks on the existing scrubber, in one clip or across two, showing the marked length against the 4-second floor and the projected cost before anything is spent. | M | RBF-006 |
| RBF-008 | Execute the repair | **Done** — `lib/repair-run.js`. Seven stages, each naming itself on failure; the budget gate sits BEFORE the generator; extracted frames live in the data tree because only stored media is mintable, and are removed on both paths; the result is a new file and a new version row. | L | RBF-006, RBF-011 |

### Phase 4: Reach and proof

| Task | Title | Description | Size | Dependencies |
|------|-------|-------------|------|--------------|
| RBF-009 | MCP tools for the repair | **Done** — `repair_plan` (free, GET) and `repair_run` (SPENDS, POST) at **263 tools**. The denominator is derived from the ROUTES the server dispatches, so a repair route with no tool fails rather than being invisible. Also wired the real first-last-frame generator, without which `repair_run` would have been listed and incapable. | M | RBF-006, RBF-008 |
| RBF-010 | Prove it on real footage | Run a repair end to end on a real clip in a real project, at 480p, and record the before/after plus the actual spend. Measure whether the seam needs `post/color-match`. | M | RBF-008 |

---

## Open Questions

1. ~~**Does `video-edit`'s `images_list` act as keyframes or style references?**~~
   **Answered by RBF-001 (2026-09-05): style references.** Both stills are
   composited into the scene at once and for the whole clip, not honoured as a
   start and an end frame. The within-a-clip case therefore still needs the
   splice. Evidence: `docs/plans/rbf-001-video-edit-probe.md`.
2. **Is there an undocumented time-range parameter?** Cannot be proven either
   way: FastAPI silently drops unknown fields, so the absence of documentation
   is weaker evidence than a refusal would be.
3. **Under the 4-second floor — widen the marks, or generate 4s and trim back?**
   Still open; the user chose the sequencing option, not this one. Widening
   changes what the director marked; trimming pays for discarded footage. The
   surface must do one, and it must say which.
4. **Does a repaired middle need colour matching?** Unknown until measured on
   real footage — RBF-010. `post/color-match` exists if the answer is yes.
5. **Where does a marked range live** — two stations on the existing model, or
   a new table? Stations inherit approval and staleness; a table would re-derive
   them.
6. **Does the repair replace the clip or add a version?** The epic assumes a new
   version (RBF-008), on the rule that generation is a coin flip already paid
   for. Worth confirming before it is built.

---

## Success Metrics

- A director marks two points in a real clip and gets a repaired clip back,
  without leaving Film Engine.
- The plan is raised, read and the cost seen **before** any spend, every time.
- A range under 4 seconds is refused with both remedies named — never silently
  widened and never sent to be rejected by the provider.
- The repaired section carries the source clip's real resolution and frame rate,
  read from the file.
- The previous take survives the repair and can be restored.
- A repair is drivable from an agent over MCP, not only from the page.
- Measured on real footage: the seam is acceptable, or `post/color-match` is
  shown to be required and applied.
