# Audit — World Engine spec against the codebase it lands in

Step 1 of the spec's own implementation order, and the precondition its
instruction §74 sets: *"Do not rebuild the existing World Engine screen
wholesale. First inspect the current architecture… Reuse existing systems
wherever appropriate."*

Companion to [`feasibility.md`](feasibility.md), which answered *can Marble do
this* and was written before the spike ran. This answers *what does the spec
collide with*, and it reaches one conclusion that changes the build order.

---

## 0. Verdict

**Build it. Three of the five MVPs are substantially already here, and the one
genuinely new dependency — Marble — is wired, credentialed and verified against
the live API.**

**But do not follow §9 (`npm install three @sparkjsdev/spark`).** It is the one
instruction in the spec that cannot be executed in this codebase, and taking it
literally would reverse [ADR-002](../adr/002-vanilla-http-no-framework.md), add a
bundler to a single-file app, and create the second surface this project has
already paid for three times. §4 below is the evidence and the alternative.

The spec's own §73 acceptance test is reachable without Spark, because **every
cinematographic quantity in it is computed from the collider mesh, not from the
splat.** The splat is the visual skin. That is the finding that reorders the
plan.

---

## 1. What already exists (the reuse inventory)

This is larger than the spec assumes. Measured: **3,072 lines** of previs
backend, **~3,130 lines** of previs frontend, **105 `previs*` functions** live on
the page, and **284 test cases across 17 files** already gating it.

| Spec asks for | Already exists | Where |
|---|---|---|
| §15 CinemaCamera w/ sensor, focal, aperture, focus | `camera_json` + full optics | `lib/previs-camera.js` |
| §16 Sensor presets *with real dimensions* | **6 sensors**, each with its own circle of confusion | `previs-camera.js:34` |
| §17 Lens presets | **18 primes** (12–200mm) | `LENS_KIT`, `previs-camera.js:46` |
| §16 FOV from sensor+focal | `fieldOfView()` — the exact formula the spec states | `previs-camera.js:92` |
| §44 Focus & DOF | `depthOfField()`, `hyperfocalDistance()` | `previs-camera.js:156,196` |
| §19 Dolly/truck/pedestal/pan/tilt/roll | **18 movements**, 12 distinct transforms | `previs-blocking.js:92` |
| §20 Rig presets w/ constraints | **9 rigs** with `affords` + height ranges | `previs-blocking.js:41` |
| §27 Camera move legs + easing | `moves_json`, `legTimings`, 4 easings | `previs-blocking.js:483,571` |
| §27 Keyframes | `camera_keys_json` (migration 082) | authored keys, sampled path |
| §11 Coordinate system | **glTF: +Y up, −Z forward, metres** — already canonical | `previs-blocking.js:10` |
| §14 Blocking assets w/ transform | `subjects_json`, 5 primitives | `previs-primitives.js:42` |
| §13 Card / Proxy / Mesh | `imageplane` / `human`+`cube`+`sphere` / `mesh` | all three exist |
| §21 Orbit / aim / fly, F-to-frame | `previsBindStage`, `frameAll()` | `previs-pick.js:217` |
| §24 Subject occupancy | `frameCoverage()` + projected bbox | `previs-camera.js:111` |
| §7 Async job architecture | `film_generation_jobs`, handle-before-poll | migration 101 |
| §3 Provider abstraction | `SpatialWorldProvider` ≡ the adapter registry | `providers/worldlabs.js` |
| §61 Server-side key only | `WLT-Api-Key` never leaves the server | verified |
| §53 Undo/redo | **absent** | — |
| §54 Autosave | **absent** — explicit Save only | — |
| §12 Scale calibration | **absent** | — |
| §38 World versioning | **absent** | — |

The spec's MVP 2 (cinematography) is largely **done**. MVP 4 (motion) is largely
**done**. What is genuinely missing is the World itself, calibration, versioning,
and the directing layer.

---

## 2. Five places the spec collides with this codebase

**These are conflicts of fact, not taste.** Each needs a decision before code.

### 2a. There is no React, no bundler, and no npm on the frontend

The spec (§63–65) specifies React components and `npm install`. Measured: no
root `package.json`, no `node_modules`, `build.target: single-html`, backend has
**two** dependencies and **zero** devDependencies. The page is one 2.5 MB HTML
file with **6 script tags**, **0 `<script type="module">`**, **0 import maps**.

Introducing React for one page is precisely the *second surface* failure this
codebase has recorded three times (the plate pointer, the frame pointer,
`effectiveCamera`). **Recommendation: build in the existing vanilla surface.**

### 2b. A World serves many shots; `film_previs_blocking` is one row per shot

`shot_id TEXT NOT NULL UNIQUE` (migration 058:15). That is correct for blocking
and wrong for worlds. **This is additive, not a conflict**: worlds belong in new
tables, and the shot's pin is one new column. Nothing existing needs rewriting.

### 2c. `camera_json` holds one camera, and the spec wants many per world

Same shape as 2b, same resolution. A `SpatialShot` is the existing blocking row
plus a world-version pin.

### 2d. The "4×4 matrix pipeline" in the comments does not exist

Three separate comments claim one. `previsProject` is cross-products plus a
perspective divide, written **twice** (server `previs-pick.js:48`, client
`index.html:16000`) and held equal by test. Any plan that says *"reuse the
matrix pipeline"* is planning against a comment.

**A real divergence found during this audit:** the server projection carries a
near-vertical fallback (`|forward.y| > 0.999` → reference `[0,0,1]`); the
client's forward projection **does not**, though the client's *inverse* does.
A top-down camera degenerates on the client only. Worth fixing in phase 1 —
the spec's §21 asks for a TOP view preset, which is exactly that case.

### 2e. `fromCard` discards its own azimuth solve

`routes/previs.js:1092` computes `solution.position`/`rotation`, then `:1122`
persists a hardcoded `position: [0, heightM, distanceM], rotation: [0,0,0]`.
Only `distanceM` survives. Pre-existing, unrelated to this spec, and it will
look like a World Engine bug the moment worlds make seeding matter.

---

## 3. The Marble contract, verified against the live API

Every line below was read from the running service, not documentation. The 422
validation path answers for free — it refuses before it bills.

| Endpoint | Status | Contract |
|---|---|---|
| `POST /marble/v1/worlds:generate` | 422 | requires `world_prompt` |
| `POST /marble/v1/media-assets:prepare_upload` | 422 | requires `file_name`, `kind` ∈ {`image`,`video`} |
| `GET /marble/v1/operations/{id}` | 404 | exists |
| **`GET /marble/v1/worlds`** | **404** | **no list endpoint** |

`world_prompt.type` ∈ **`text`, `image`, `multi-image`, `video`** — exactly the
four §4 names. `model` ∈ **`marble-1.0-draft`, `marble-1.0`, `marble-1.1`,
`marble-1.1-plus`** — exactly what the adapter declares.

**The absence of a list endpoint is load-bearing:** Film Engine must be the
system of record for worlds. A world that exists at Marble and not in our
database is unreachable and unfindable.

### What a real world actually returns

From our own world (`06be9e1f…`, the spike, 250 credits / $0.20 / 37 s):

```
assets.mesh.collider_mesh_url    1.4 MB GLB          ✓
assets.mesh.hq_mesh_url          null   ← draft only
assets.mesh.full_res_mesh_url    null   ← draft only
assets.splats.spz_urls.100k      1.17 MB
assets.splats.spz_urls.500k      5.50 MB
assets.splats.spz_urls.full_res  25.00 MB
assets.imagery.pano_url          PNG 2304 × 1152, ratio 2.00
assets.thumbnail_url             ✓
assets.caption                   ✓ (auto-generated)
```

Three findings the spec does not state:

- **Mesh quality is a function of tier.** On draft, only the collider exists.
  §8's `SpatialWorldAsset` should model `hq_mesh_url` as nullable.
- **The splat tiers map exactly onto §10's LOD strategy** (100k → 500k → full).
- **The panorama is equirectangular at exactly 2:1.** three.js r149 can
  sphere-map it today, with no new dependency. This is the cheapest possible
  "the world looks like somewhere" and it is free.

**URLs carry no signature or expiry** — they are plain CDN paths, fetchable
without the key. §8's caution still stands (copy what we depend on), but there
is no expiry clock to race.

---

## 4. The renderer decision — why not Spark, and what instead

This is the spec's §9, and the only instruction that cannot be followed.

### The measurements

| Fact | Value | Source |
|---|---|---|
| Spark 2.1.0 build formats | **ESM + CJS only, no UMD/IIFE** | npm registry |
| Spark peer dependency | **`three >= 0.180.0`** | npm registry |
| Spark dist size | **5.0 MB minified** (+ worker files) | jsdelivr |
| three **0.149** (inlined today) | ships `build/three.js` **UMD** | npm registry |
| three **0.160** | ships UMD, but prints *"deprecated with r150+, will be removed with r160"* | fetched |
| three **0.180** | **`three.cjs` + `three.module.js` only — no UMD** | jsdelivr file list |

**The chain is closed:** Spark needs three ≥ 0.180; three ≥ 0.180 ships no UMD;
this page loads everything as classic scripts. Adopting Spark therefore forces
*either* an ESM migration of the whole page *or* two three.js versions coexisting
in one document.

The inlined r149 is **607,988 characters on a single line** — 594 KB, ~24% of the
page. Spark plus three 0.180 would add roughly **6.3 MB**, tripling the file.

### What the splat is actually needed for

Nothing cinematographic. Every quantity the spec's acceptance test (§73) turns on
is computed from geometry:

| §73 needs | Comes from |
|---|---|
| camera placement, height, tilt | camera transform |
| subject distance (§25) | collider mesh + blocking |
| ground snap, camera-inside-geometry (§34) | **collider mesh** |
| subject occupancy (§24) | projected bbox + FOV |
| framing, lens, DOF | optics — already built |
| **"is the world pretty"** | **splat** |

**Proven in this audit:** the real Marble collider parses with the *existing*
`glb-parser` — **28,717 vertices, 53,841 triangles, extent 39.6 × 9.0 × 47.9**,
decimating cleanly to the stage's 20,000 budget. A street, not a bubble.

### Recommendation

**Phase the renderer, and gate splats behind `WORLD_SPLATS`.**

1. **Now — geometry truth, zero new dependencies.** Collider mesh in the
   existing canvas-2D stage (wireframe) and the existing three r149 WebGL pane
   (solid), plus the equirect panorama as a sphere-mapped backdrop. This
   delivers a real navigable world and every measurement the directing layer
   needs.
2. **Later, deliberately — splats.** Two routes stay open and neither needs a
   bundler: `@spz-loader/core` ships a **UMD** build that decodes SPZ, which can
   feed a point/instanced-quad shader on r149; or `@mkkellogg/gaussian-splats-3d`
   ships a **UMD** build (needs three ≥ 0.160, an 11-revision jump rather than
   31). Both deserve their own ADR and their own measurement.

This is not a reduction of the spec — it is the spec's own §72 ("those are
traps") and §74 ("reuse existing systems") applied to §9.

**Honest statement of the substitution:** §67's MVP 1 lists "Spark viewer".
Phase 1 substitutes collider mesh + panorama and ships splats behind a flag. If
the world feels wrong without splats, that judgement can be made on a working
world rather than predicted.

---

## 5. What is genuinely new (and must be built)

Nothing here has an existing equivalent to reuse:

- `worlds`, `world_versions`, `world_assets`, `world_sources` tables (§52) —
  next migration is **102**
- **Scale calibration** (§12) — Marble promises no unit; the spike reported
  extent as *uncalibrated* deliberately. Without this, focal lengths and subject
  distances are meaningless numbers.
- **World versioning + shot pinning** (§38, §56) — never overwrite, never
  auto-migrate
- **World lock** (§55)
- Cinematography AI proposals (§31), Explore Shot (§33), 180°/screen direction
  (§36–37), Match Reference (§29), Generation Plate (§45)
- Undo/redo (§53) and autosave (§54) — previs today has an explicit Save and a
  staged badge, no undo stack

### One reuse the spec does not notice

**A Generation Plate is an anchor.** `KIND_RANK` is
`{anchor: 0, character: 1, location: 2, prop: 3, style: 4}` — the shot anchor
already ranks first, already leads the prompt, already replaces the plates it
makes redundant, and already shortens locked contracts. A generation plate is
*the same semantic role with a different source*: previs geometry instead of a
previous frame. §45–47 should be built on that mechanism, not beside it.

---

## 6. Revised phase plan

Mapped to the spec's MVPs, reordered by what this codebase already has.

| Phase | Contents | Spec |
|---|---|---|
| **1** | `worlds`/`world_versions`/`world_assets`/`world_sources`; generate via the wired adapter; async job reuse; asset ingestion + local copy; **collider mesh in the stage**; panorama backdrop; scale calibration; shot pins a version; world lock | MVP 1 (§67) |
| **2** | World Engine screen from the handoff: camera view hero, lens/operate/blocking panels, overlays, occupancy, measurements | MVP 2 (§68) |
| **3** | Direct the Shot, Explore Shot ×6, 180°/screen direction, camera compare | MVP 3 (§69) |
| **4** | Timeline UI over the **existing** legs/keys/easing model, camera path drawing | MVP 4 (§70) |
| **5** | Generation Plate (as an anchor), depth/masks, image + video bridge | MVP 5 (§71) |
| **6** | Match Reference (§30 V1 manual-assist only), shot complexity, export | §29, §49, §50 |

Behind flags throughout (§66): `WORLD_ENGINE`, `MARBLE_GENERATION`,
`CINEMATOGRAPHY_AI`, `REFERENCE_MATCH`, `CAMERA_EXPLORE`, `WORLD_SPLATS`.

---

## 7. Risks

1. **Scale calibration is load-bearing and unsolved.** Marble promises no unit.
   Until §12 lands, every distance and lens number on the screen is decorative.
   It belongs in phase 1, not later.
2. **284 existing previs tests will constrain every change.** That is a feature
   — but the parity tests string-extract functions out of `index.html` with
   regexes, so renaming a previs function can break a test in a way that reads
   as a feature regression. Expect to update them deliberately.
3. **The page is 2.5 MB.** Every addition is weighed against a file the browser
   parses on every load. The panorama-as-backdrop choice matters here.
4. **A draft world has no hq mesh.** If collider fidelity proves too coarse for
   framing, the cost per world goes from $0.20 to ~$1.28 (marble-1.0) and the
   iterate-cheaply argument weakens.
5. **`GET /worlds` does not exist.** If our database loses a world row, the
   world is unreachable. Ingestion must be durable before generation is exposed.

---

## Sources

Live API probes against `api.worldlabs.ai` (2026-09-04), the npm registry and
jsdelivr file listings for `three` and `@sparkjsdev/spark`, the real world
`06be9e1f-9c68-4717-84d5-95395597a7c5` generated by `backend/spike-world.js`,
and a full read of `backend/lib/previs-*.js`, `backend/routes/previs.js`,
`backend/lib/glb-parser.js`, migrations 058–101, and `src/index.html`.
