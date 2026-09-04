# Feasibility — Marble as the previs environment backend

**Question asked:** before building anything, is the World Engine overhaul
possible?

**Answer:** yes, and cheaper and less invasive than the proposal assumes — but
the proposal's centre of gravity is in the wrong place, and there is one
unknown that must be answered by a spike before any of it is committed to.

Every figure below is either quoted from World Labs' own documentation or
measured in this repository. Where something is undocumented it is named as
undocumented rather than estimated.

---

## 1. The finding that changes the plan

**A generated world ships a collider-mesh GLB at no extra credit cost.**

The quickstart lists what comes back with every world, included:

| artefact | detail |
|---|---|
| Gaussian splats (SPZ) | 100k, 500k and full resolution |
| **Collider mesh (GLB)** | for physics; 100–200k triangles |
| Panorama | equirectangular 2560×1280 PNG |
| Thumbnail + caption | auto-generated |

Film Engine already parses GLB, decimates it server-side and draws it in the
previs stage:

```
backend/lib/glb-parser.js      278 lines   positions, indices, node transforms
backend/routes/threed.js       GET /models/:assetId/geometry  → decimated
```

The parser's own ceiling is `accessor.count * per <= 5_000_000`, and a
200k-triangle mesh is comfortably inside it. The stage then decimates to a
budget of **2,500 triangles by default, 20,000 maximum** — which is the right
order for a grey-box previs stage that deliberately strips materials.

**So v1 needs no Gaussian splats, no Spark, no second three.js.** The world
arrives as geometry the existing renderer already draws. Splats become a later,
optional pane for looks, not a prerequisite for the spatial benefit.

---

## 2. Two exact fits nobody designed for

### 2a. Compass plates are Direction Control inputs

Marble's multi-image **Direction Control** mode takes **up to 4 images**, each
tagged `Front` / `Back` / `Left` / `Right`.

Film Engine's compass sweep produces **exactly four plates of one location** —
the anchor plate plus east, south and west, each a quarter turn from it — at a
single project aspect ratio. Auto Layout additionally requires "exactly the same
width-to-height ratio", which generated plates already share by construction.

So the input Marble's richest image mode wants is a thing this engine already
generates, already stores per location, and already names by direction.

### 2b. The orientation plan is the text half of the same thing

`orientation_plan` is already a first-class location field:

```
{ north, east, south, west, interior: [three room zones], marker }
```

It exists because "a plate carries no information about what is behind its own
camera". That is the same problem Marble solves geometrically — and the plan is
a ready-made text prompt to accompany the four images.

---

## 3. What it costs

Quoted from World Labs' API pricing: **$1.00 per 1,250 credits**, minimum
purchase $5.

| operation | credits | USD |
|---|---:|---:|
| Draft world (`marble-1.0-draft`), image | 150 | **$0.12** |
| Draft world, multi-image or video | 250 | **$0.20** |
| Standard world (`marble-1.1`), image | 1,500 | **$1.20** |
| Standard world, multi-image or video | 1,600 | **$1.28** |
| `marble-1.1-plus` | 1,500–3,100 | $1.20–**$2.48** |
| HQ mesh export | 3,500 | $2.80 |
| PLY splat export | — | free |

**For scale, measured in this library:** one storyboard frame costs about
**$0.15**, and shot 2B alone has **28 of them**. A draft world is cheaper than a
single frame; the 28 re-rolls on one shot would have paid for **three standard
worlds**.

That is the strongest commercial argument here and it does not depend on any
claim about quality.

---

## 4. What it costs in time, and why that is already solved

Generation is **~5 minutes** (`POST /marble/v1/worlds:generate`, then poll
`/marble/v1/operations/{id}` until `done`). HQ mesh export takes **up to an
hour**, rate-limited to 4/hour.

Five minutes is far past the MCP host's 60-second abort — which is precisely the
case this engine already solved. `meshy.js` writes its task id through
`onHandle` **before** polling, and `generation_pending` / `generation_collect`
recover a job the host abandoned. A Marble adapter inherits that whole mechanism
by following the same shape; it needs no new pattern.

Rate limits are **~3 world starts per minute and 60 per hour** on the default
tier (30/min standard or 90/min draft on an approved higher tier), per account
rather than per key, enforced on starts rather than concurrency.

---

## 5. The one genuinely awkward dependency

**Spark is ESM-only.** Distribution is `spark.module.js`; there is no UMD or
IIFE build, and its own examples pin `three@0.180`.

This page is `build.target: single-html`, is **2.4 MB**, and already vendors
**three.js r149** inline — converted from ESM to a classic script by the same
mechanical transform three's own `examples/js` build used to perform.

So embedding Spark means either:

- an **import map**, which works natively with no bundler but puts a CDN
  dependency inside a file whose entire purpose is being one file; or
- inlining Spark **and a second, much newer three.js**, adding megabytes to a
  page already at 2.4 MB and running two three versions side by side.

Neither is impossible. Both are avoidable in v1, because of §1.

---

## 6. THE BLOCKING UNKNOWN: how big is a world?

World extent is **not documented anywhere**. The models page lists four ids and
no dimensions; the "bigger and better worlds" post describes **"room-sized
worlds"** as a starting point, with a separate `Compose` tool for connecting
several into larger environments.

This is the question the whole overhaul turns on, and no amount of reading
settles it:

> Can a camera fly from the anchor plate's viewpoint to a **reverse angle** —
> the thing 2AA needs — and still find geometry there?

If yes, this replaces hand-staging outright. If a world is a bubble around its
input viewpoint, then Marble gives a better-looking stage and **not** the
reverse-angle continuity that is the actual prize.

**A $0.20 draft world answers it definitively.** Nothing else should be built
before that.

---

## 7. What the proposal gets wrong

**The expensive part is the schema, not Marble.** `WORLD` as a first-class
entity between scene and shot means a new table, shot→world pinning, world
versioning, and consequences for project bundles, backups, staleness
fingerprints and the running order. That is most of the work and the API helps
with none of it.

**"Match Reference Composition" is not a Marble feature.** Estimating vanishing
points, camera height and FOV from a Framed Ink page is a computer-vision
project of its own. Valuable, entirely separable, and it would sink a v1.

**The real bottleneck is adoption, not fidelity.** Measured in this library:

| | |
|---|---|
| shots | **70** |
| shots ever blocked in previs | **2** |
| shots whose prompt therefore carries spatial locks | **2** |

The spatial half of the video prompt is empty on 68 shots not because previs
renders badly but because blocking is work nobody does. If a world does not
change that number, the spatial locks stay blank and the overhaul buys nothing
where it matters.

That is also the strongest argument *for* it: a world you can fly a camera
through, generated from plates you already have for twelve cents, is a far lower
bar than placing boxes by hand.

---

## 8. Unknowns that need answering, in priority order

| # | Unknown | How to settle it | Blocking? |
|---|---|---|---|
| 1 | World extent — is a reverse angle reachable? | One $0.20 draft world from a real location plate | **YES** |
| 2 | Is the collider mesh usable geometry, or a crude hull? | Same spike: load it through `glb-parser` and look | **YES** |
| 3 | Do generated plates work as input, or does it want photographs? | Same spike — the docs give resolution (1024 long side), aspect (16:9→9:16), 20 MB, png/jpg/webp, and say nothing about illustration vs photo | **YES** |
| 4 | Commercial use and ownership of generated worlds | Read the ToS; the API FAQ does not cover it | before shipping |
| 5 | Asset URL permanence — are world artefacts hosted or must we copy them? | API reference / a live call | before shipping |
| 6 | Does a 200k collider mesh decimate to something readable at 20k? | Measure in the existing stage | design |

Unknowns 1–3 are answered by **the same single spike**, for about twenty cents.

---

## 9. Recommended shape, if the spike passes

**Phase 0 — the spike (hours, $0.20).** One draft world from one real location's
plates. Load the collider mesh through the existing `glb-parser` and
`/models/:assetId/geometry`. Answer unknowns 1–3. Decide.

**Phase 1 — a provider, not a rewrite.** A `worldlabs` adapter beside `meshy`:
async, `onHandle` before polling, its own entry in the rate book so a world is
metered like every other spend. A `world` capability. Worlds generated from a
location's existing compass plates plus its orientation plan. No UI beyond a
button.

**Phase 2 — worlds are things.** The schema work: a world table, versions, shots
pinned to a version. This is the expensive phase and it is entirely internal.

**Phase 3 — the stage becomes the world.** The collider mesh replaces the empty
grid in the previs stage that already exists. `stagingPhrase` then fills for
every shot in that location rather than for two.

**Phase 4+, only if earned.** Splats via Spark, coverage exploration, camera
match, lighting, export. Each is separable and none blocks the others.

---

## 10. Verdict

**Feasible, and unusually well matched to what this engine already has** — a GLB
pipeline, direction-tagged plates, an orientation plan, an async-handle pattern,
a rate book, and a spatial phrase already wired into the video prompt.

**Not feasible to commit to before the spike.** World extent is undocumented and
decides whether this is a continuity system or a prettier backdrop.

**And the thing to build first is not the world.** It is the twenty-cent
question about whether a camera can turn around inside one.

---

### Sources

- [Announcing the World API](https://www.worldlabs.ai/blog/announcing-the-world-api)
- [API quickstart](https://docs.worldlabs.ai/api/index.md) — endpoints, included artefacts
- [API pricing](https://docs.worldlabs.ai/api/pricing.md) — credits and USD
- [Rate limits](https://docs.worldlabs.ai/api/rate-limits.md)
- [Export file specs](https://docs.worldlabs.ai/marble/export/specs.md) — splat counts, mesh triangles
- [Prompt guidelines](https://docs.worldlabs.ai/marble/create/prompt-guides/index.md) — image input specs
- [Multi-image prompt guide](https://docs.worldlabs.ai/marble/create/prompt-guides/multi-image-prompt.md) — Direction Control, Auto Layout
- [Generating bigger and better worlds](https://www.worldlabs.ai/blog/bigger-better-worlds) — "room-sized worlds", Spark
- [Spark](https://sparkjs.dev/) and [sparkjsdev/spark](https://github.com/sparkjsdev/spark) — ESM-only, three@0.180
