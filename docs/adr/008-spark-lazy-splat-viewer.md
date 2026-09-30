# ADR-008: Render Splats in Previs, Loaded Lazily (Supersedes ADR-006)

## Status
Accepted. Supersedes ADR-006.

## Context
ADR-006 deferred Gaussian splats and listed what would change that answer. One
of those conditions has now happened: a director said they **cannot judge a
camera** from the collider mesh alone. The grey geometry shows where walls and
counters are. It does not show whether a frame looks like the diner.

Every Marble world already records its splats (the 100k, 500k and full-resolution
tiers) and, for most worlds, a 360° panorama. `lib/world-assets.js` stores their
URLs. Until now nothing drew them.

ADR-006 rejected splats because of three constraints. None of them has changed:

- `gridlight.json` still pins `build.target: single-html`. The page is one file,
  now **3.1 MB**, and every visitor downloads all of it.
- The page vendors three.js **r149** as a classic script for the GLB stage and
  GLTFLoader. Spark needs a modern three.
- The backend deliberately has only two dependencies, and no devDependencies.

The decision below keeps all three constraints and still renders splats.

## Decision
**Render the world's splats in the Previs console, from one ES module that is
loaded only when a Look, 360° or Explore thumbnail is shown.**

- `scripts/build-splat-viewer.sh` bundles **three 0.180.0** and
  **@sparkjsdev/spark 2.2.0** with esbuild into `src/vendor/splat-viewer.js`,
  which is **3.2 MB**. It exports `THREE`, `SparkRenderer` and `SplatMesh`.
  The tools are installed in a temporary folder. The output file is committed.
  `package.json` does not change.
- The page loads the module with `import('./vendor/splat-viewer.js')`. If that
  fails, it loads `GET /film/vendor/splat-viewer.js` from the API. The page's
  own **r149** is not touched, and the two copies of three never interact.
- `world_splats` and `previs_console` are **on by default** for every
  project: a director should see the set, not a grey mesh, without finding a
  switch. Previs opens on **Look** when the world version has splats, so
  opening a shot with a world downloads its full splat once (the browser
  caches it). A project or version with no splats downloads nothing and opens
  on Geometry. Turning `world_splats` off fetches nothing and disables the
  splat modes with a reason.
  `GET /film/world-versions/:vid/splats` lists the tiers, preferring a local
  copy over the CDN.
- Look uses exactly the painter's pose: staged position × scale factor, aim,
  vertical FOV for the lens, and the Marble y-down flip. Look and Geometry show
  the same shot.
- The **generation plate stays geometric**. Look is a preview for the director.
  Generation still receives the plate the painter draws, and the view says so
  on screen.

## Rationale
- **The trigger ADR-006 named has happened.** A deferral that ignores its own
  condition for revisiting has become a rejection.
- **The single-html page does not grow by the renderer.** The 3.2 MB module
  and the splat are paid only by someone who opens Previs on a world that has
  splats. A project with no world never downloads either, which removes
  ADR-006's main cost objection.
- **No hand conversion.** ADR-006 feared hand-converting ESM libraries into a
  classic script with nothing to catch mistakes. esbuild does the bundling, and
  the page imports the result as a module. The r149 conversion that the GLB
  stage depends on is left alone.
- **Pixels change, bytes sent do not.** Generation receives the same plate as
  before, so no generated output shifts.

## Consequences
- The repo commits a 3.2 MB built file. To change a version, edit the pins in
  the script and re-run it. Never edit the output by hand.
- **Durability:** until a world's splats are copied locally, Look depends on
  `cdn.marble.worldlabs.ai` still serving them. The endpoint prefers a local
  copy for this reason.
- A splat is a lot to download: the full tier is about 25 MB per world. Look
  and 360° load the full tier, because that is where a director judges the set;
  Explore thumbnails use the smallest tier.
- The page now includes code that references `SparkRenderer` and `SplatMesh`.
  The classes themselves live only in the module.
- ADR-006's Spatial World readout remains the console's view when
  `previs_console` is off.

## What would change the answer
- The build target stops being `single-html`, so a bundler could include the
  renderer in the page itself.
- The page's own three is upgraded from r149 to a release Spark supports, so a
  single copy of three could serve both the GLB stage and the splats.
- World Labs stops serving `.spz` splats, or Spark stops supporting them, so the
  renderer has nothing to draw.
- The generation plate starts using the splat render instead of geometry. That
  would be a change to what gets generated, and it needs its own ADR.
- Splats start downloading for projects or versions that have none to show,
  or anywhere outside Previs. On-by-default is cheap only because the cost is
  limited to a director opening a world.
