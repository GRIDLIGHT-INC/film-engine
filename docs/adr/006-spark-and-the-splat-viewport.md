# ADR-006: Spark and the Splat Viewport (Deferred)

## Status
Accepted

## Context
The World Engine previz console has a **Spatial World** panel. The design handoff
draws it as an SVG diagram and says plainly what it stands in for: *"In the real
product these are live renderers — the spatial world is a Gaussian-splat
viewport (World Labs' Spark / three.js is the intended path for a web app)."*

World Labs Marble already returns a splat for every world it builds, and the
`world_splats` flag exists to fetch and render one. It has always defaulted
**false**, with the reason on the flag itself: *"Off records the splat URLs and
fetches nothing — full_res is 25 MB per world."*

Three facts about this codebase decide whether that flag can be turned on.

`gridlight.json` pins `build.target: single-html`. There is no bundler and no
devDependencies, which is ADR-002 taken to its conclusion: the whole front end
is one file that a browser opens. Anything a page needs is *in* that file.

That file is **2.9 MB**, and it is that size because of the last time this
question was asked. The previs stage needed to show whether a generated `.glb`
was actually the character, a flat projection could not answer it, and three.js
**r149** plus GLTFLoader were vendored inline — GLTFLoader mechanically
converted from ESM to a classic script, the way three's own `examples/js` build
used to. That worked, and the page grew by two megabytes.

Spark is World Labs' own renderer for their own splats, which makes it the
obvious candidate. Spark 2.0 is **ESM and expects a modern three**; r149 is not
one. So adopting it is not one change but two — a new library *and* an upgrade
of the three.js already vendored, both converted by hand into a single HTML file
with no build step to catch what the conversion broke.

## Decision
**Do not render Gaussian splats.** `world_splats` stays `false`, no splat
renderer is vendored, and the Spatial World panel keeps reporting the geometry
the world already gives us: its extent, its scale state, and each staged
subject's distance from the camera. The panel says so on its own face rather
than looking unfinished.

This is deferral, not rejection. The flag stays because the decision is expected
to be revisited, and the URLs are still recorded so that turning it on later is
a rendering change rather than a re-generation.

## Rationale
- **The panel already answers its question.** Spatial World exists to say where
  things stand relative to the camera. Marble's collider mesh, measured on a
  real world in the spike, is **53,841 triangles across 39.6 × 9.0 × 47.9 world
  units** — a street, and it parses with the `glb-parser` already here and
  decimates to the stage's **20,000**-triangle budget. A splat would make that
  panel prettier; it would not let it answer something it currently cannot.
- **The design agrees about the panel's rank.** It calls for keeping *"the size
  (a supporting panel, not a competitor to the camera frame)"*. The hero of the
  screen is the camera frame, and the generation plate that comes off it. Two
  megabytes of renderer for the supporting panel is the wrong place to spend the
  page.
- **The cost is paid by everyone, including projects with no world.** In a
  single-html build the bytes ship to every visitor on every load, whether or
  not a world exists — unlike the 25 MB per world, which is at least paid only
  by someone using one.
- **Two conversions, no build step to catch a mistake.** Vendoring Spark 2.0
  means hand-converting an ESM library *and* replacing r149 under the GLTFLoader
  conversion that is already load-bearing. A subtly wrong conversion produces a
  page that loads and a viewport that does not, and there is no bundler here to
  fail loudly.
- **Nothing downstream is waiting on it.** The generation plate is deliberately
  a *geometric* plate — the pipeline hands geometry to an image model and lets
  it own the look. A photoreal viewport would improve what a director sees while
  blocking; it would not change a single byte of what gets generated.

## Consequences
- Spatial World is a readout, not a viewport. A director judges framing from the
  camera pane and the generated plate, and uses this panel for where things are.
- Occlusion cannot be judged from the panel. The stage painter has no occlusion
  and its texture mapping is affine per triangle, so flying behind a wall may
  show through it — a stated limit, already recorded for the previs stage.
- The 25 MB per world is never fetched, so a project with six worlds costs
  nothing extra at rest.
- `world_splats` is a flag that does nothing today. That is deliberate and is
  the one cost worth naming: a declared-and-unread flag is a shape this codebase
  has paid for repeatedly. It is wired through `WORLD_FLAG_REGIONS` to the
  Spatial World region like every other sub-flag, so switching it off hides the
  panel — it gates a region that exists, rather than gating nothing.

## What would change the answer
- **The build target stops being `single-html`.** With a bundler, Spark is a
  dependency rather than a vendoring exercise and most of this reasoning goes
  away.
- **three.js is upgraded for another reason.** Half the cost here is that r149
  cannot load Spark 2.0. If something else forces the upgrade, the remaining
  question is only Spark's own weight.
- **Spark ships a classic-script build**, or a version that runs against the
  three already vendored. That removes the second conversion entirely.
- **The collider mesh proves insufficient for judging occlusion.** If directors
  find they cannot tell what is behind what from a 20,000-triangle wireframe,
  the panel stops answering its question and the trade changes.
- **A director reports they cannot judge a camera without it.** The claim above
  is that the camera pane and the plate are enough. That is a claim about use,
  and use is what would refute it.
