# Test specification — World Engine / Spatial Previs

Step 3. Defines **what must be proven** before any of `plan.md` is written.
No implementation code, no test code — this is the acceptance contract the
next step turns into `backend/tests/*.test.js`.

Companions: [`audit.md`](audit.md) (what the spec collides with),
[`plan.md`](plan.md) (what gets built, and the nine decisions).

---

## 0. Conventions

Every case below states five things: **scenario**, **inputs**, **expected**,
**what failure means**, and — where the case covers a family — the **denominator
it is derived from**. Cases that guard a decision also name the **mutation that
must fail them**, because a guard that cannot fail is worse than none: it reads
as coverage.

Four house rules this codebase already enforces, restated because they bind here:

1. **Denominators are derived, never typed.** A list written into a test is only
   as complete as the afternoon it was written; the item added next is exactly
   the one that gets missed. Every set below names the registry it reads.
2. **No test may open the real database** (`test-isolation.test.js`). Fixtures
   use `helpers.createTestDir` / `createTestProject` / `testApi`.
3. **A check must be bounded by structure, not by a character window.** This
   file records four separate failures of that kind; scans bound by brace depth
   or by section, never by `[\s\S]{0,600}`.
4. **A scan must assert it found something** before asserting anything about it.
   A refactor that removes a pattern silently drops the denominator to zero and
   the check goes green across the whole codebase.

**Terminology:** *free* means the route resolves no provider and writes no cost
entry. *Spends* means it reaches `providers.resolve` and bills.

---

## 1. The complete set

Derived from code and from the design handoff, with the source of each count.

| Set | Count | Derived from |
|---|---|---|
| Architectural decisions to guard | **9** | `plan.md` §2, D1–D9 |
| New tables | **4** | `plan.md` §3 |
| Columns added to `film_previs_blocking` | **2** | `plan.md` D1 |
| New modules | **7** | `plan.md` §4 New table |
| HTTP routes | **17** | `plan.md` §5 |
| MCP tools | **12** | `plan.md` §6 |
| Marble asset kinds | **6** | live world payload |
| Marble prompt types | **4** | API 422: `text,image,multi-image,video` |
| Marble models | **4** | `worldlabs.MODELS` |
| Compass azimuths | **5** | `worldlabs.AZIMUTH` |
| Calibration sources | **5** | `world-scale.CALIBRATION_SOURCES` |
| Reference kinds after the plate | **6** | `KIND_RANK` + `plate` |
| Feature flags | **6** | `plan.md` D9 |
| Composition overlays | **11** | design README ("Eleven toggle rows") |
| Lens buttons | **12** | design README lens row |
| Director intents | **7** | design README intent table |
| Explore candidates | **6** | design README A–F |
| Camera validation checks | **6** | `camera-validate.CHECKS` |
| Proposal fields | **11** | `cinematography.PROPOSAL_FIELDS` |
| Easings (+ hold) | **4 + 1** | `previs-blocking.EASINGS` |
| Error states | **13** | spec §60 |
| Existing registries held in lockstep | **5** | `KIND_RANK`/`KIND_SOURCE`, `MEDIA_KINDS`, `SETTINGS`, `NAV_FLOW`, `asset_type` CHECK |

**Existing sets that must not move:** 18 movements, 9 rigs, 18 shot types,
6 sensors, 18 lenses, 10 apertures, 5 primitives, 8 media kinds, 4 nav groups.

**Total specified cases: 102**, across 9 decision guards, 6 phases, 13 error
states and 9 regression guards.

---

## 2. Decision guards — the nine that must never quietly stop being true

These are cross-cutting. Each belongs in the phase that first makes it real, but
all nine are listed together because each is a claim the plan makes about the
whole feature.

### WE-D1.1 — Deleting a world does not delete authored blocking
- **Scenario:** a shot has previs blocking and is pinned to a world version; the world is deleted.
- **Inputs:** world W with version V; blocking row for shot S with `world_version_id = V`.
- **Expected:** W, its versions, assets and sources are gone; the blocking row for S **still exists**, with `world_version_id IS NULL`.
- **Failure means:** a director loses hand-authored camera work as a side effect of tidying up a world — the `film_refsheet_jobs` trap of migration 067, repeated.
- **Mutation:** change the FK to `ON DELETE CASCADE` → must fail.

### WE-D1.2 — There is no second camera store
- **Scenario:** derived scan over the new schema.
- **Inputs:** migration 102 SQL.
- **Expected:** no new table declares a column matching `focal`, `sensor`, `aperture`, `position`, `rotation`. The camera lives only in `film_previs_blocking.camera_json`.
- **Failure means:** two answers to *where is the camera for this shot* — the failure this codebase has recorded three times.
- **Mutation:** add `focal_length` to `film_world_versions` → must fail.

### WE-D2.1 — World generation writes `film_generation_jobs`, and no second job table exists
- **Scenario:** a world generation is submitted.
- **Inputs:** a stubbed provider that returns an operation id then completes.
- **Expected:** exactly one row in `film_generation_jobs` with `capability='world'`, `provider='worldlabs'`, and `request_id` set **before** the first poll. No table named `%world_generation_job%` exists.
- **Failure means:** an abandoned world is unrecoverable — the exact failure migration 101 exists to close — or a second answer to *what is running*.
- **Mutation:** move the handle write to after the poll loop → must fail.

### WE-D3.1 — The page gains no ESM, no import map, and no Spark
- **Scenario:** derived scan of `src/index.html`.
- **Inputs:** the built page.
- **Expected:** `<script type="module">` count 0; `type="importmap"` count 0; zero occurrences of `sparkjsdev`, `SplatMesh`, `SparkRenderer`. `THREE.REVISION === '149'`.
- **Failure means:** ADR-002 has been reversed silently, and the iOS custom-scheme path is at risk.
- **Mutation:** add one `<script type="module">` → must fail.

### WE-D3.2 — Splat assets are recorded but never fetched while `WORLD_SPLATS` is off
- **Scenario:** ingest a world with the flag off.
- **Inputs:** provider payload carrying all three `spz_urls`.
- **Expected:** three `film_world_assets` rows of kind `splat_*` with `remote_url` set and `asset_id IS NULL`; **zero** bytes downloaded for them.
- **Failure means:** 25 MB per world fetched for a renderer that cannot display it.

### WE-D4.1 — With `WORLD_ENGINE` off, the previs page is byte-identical
- **Scenario:** render the previs page markup with the flag off.
- **Inputs:** the page's own render path.
- **Expected:** output identical to the pre-change baseline, byte for byte. `nav-flow.phaseOf('previs') === 'plan'` and the page id `previs` still resolves in `PAGE_RELOAD`.
- **Failure means:** the incremental-shipping guarantee is gone; a half-built console is live on a working install.
- **Mutation:** render one new panel unconditionally → must fail.

### WE-D5.1 — No World Engine module reaches a server-side LLM
- **Scenario:** derived scan over the feature's own modules.
- **Inputs:** the 7 new modules plus `routes/worlds.js`, read from source.
- **Expected:** none requires `lib/llm-client.js`, directly or one call level down. `tests/mcp-no-server-llm.test.js` continues to pass with the new tools in the registry.
- **Failure means:** the pipeline asks the user for a second API key to answer a question the connected model has already read, and fails with a billing error the model cannot act on. **This is the goal's stated rabbit hole.**
- **Mutation:** add `require('../llm-client')` to `lib/cinematography.js` → must fail.

### WE-D5.2 — `cinematography_brief` returns facts and no conclusion
- **Scenario:** call the brief for a shot with a world and blocking.
- **Inputs:** any intent.
- **Expected:** the payload carries world bounds, blocking, current camera, occupancy, axis, screen direction, continuity and the intent vocabulary. It carries **no** proposed camera: no `focalLengthMm`, no `cameraHeightM`, no `changes` key.
- **Failure means:** the engine is making the creative judgement the director and the model are supposed to make, and doing it invisibly.
- **Mutation:** add a computed `changes` block to the brief → must fail.

### WE-D6.1 — A NULL scale factor never reads as 1.0
- **Scenario:** an uncalibrated version is read three ways.
- **Inputs:** version with `scale_factor IS NULL`.
- **Expected:** `toMetres(v, null) === null`; `describeScale()` returns `APPROXIMATE SCALE`; the geometry response reports `scale: null`, not `1`.
- **Failure means:** an unmeasured world reports confident metre distances, and a wrong number reaches a lens calculation looking deliberate.
- **Mutation:** `factor || 1` anywhere in the read path → must fail.

### WE-D6.2 — Calibrating twice does not compound
- **Scenario:** calibrate a version, then recalibrate with different inputs.
- **Inputs:** first `{knownMeters: 1.68, measuredUnits: 2.042}`, then `{knownMeters: 2.0, measuredUnits: 2.042}`.
- **Expected:** the second factor is computed from the **stored geometry**, not from the already-scaled result; the stored collider bytes are unchanged between the two calls (compare file hash).
- **Failure means:** a mesh scaled twice is indistinguishable from one scaled once, and recalibration silently corrupts every distance.

### WE-D7.1 — Inserting `plate` at rank 0 leaves existing relative order unchanged
- **Scenario:** compare kind ordering before and after.
- **Inputs:** `KIND_RANK` before `{anchor,character,location,prop,style}` and after `{plate,anchor,character,location,prop,style}`.
- **Expected:** sorting the five pre-existing kinds by the new ranks yields the identical sequence.
- **Failure means:** every project without a generation plate silently changes which references it sends.
- **Mutation:** renumber so `location` and `style` swap → must fail.

### WE-D7.2 — `KIND_SOURCE` covers every kind, and `plate` is not an entity
- **Scenario:** derived over `KIND_RANK`.
- **Expected:** every kind has a `KIND_SOURCE`; `KIND_SOURCE.plate === 'previs'`.
- **Failure means:** a test deriving "every subject kind" from `KIND_RANK` demands a table and a plate generator for a previs render — the failure that map exists to prevent.

### WE-D8.1 — World assets use the established escape hatch
- **Scenario:** ingest a world.
- **Inputs:** the six asset kinds.
- **Expected:** every registered `film_assets` row has `asset_type='other'` with `metadata.kind` in the six-kind vocabulary. Nothing attempts an `asset_type` the CHECK refuses.
- **Failure means:** a successful, paid generation fails at the insert — the exact failure `ASSET_TYPE`'s comment records.

### WE-D8.2 — Collider, panorama and thumbnail are copied locally
- **Scenario:** ingest, then make the remote unreachable.
- **Inputs:** ingest against a stub, then point `remote_url` at a dead host.
- **Expected:** collider geometry and the panorama still serve from local storage.
- **Failure means:** `GET /marble/v1/worlds` is 404, so a world we cannot re-fetch and cannot list is permanently lost — a paid asset with no path back.

### WE-D8.3 — Re-ingesting replaces rather than accumulates
- **Scenario:** ingest the same version twice.
- **Expected:** exactly six `film_world_assets` rows, not twelve. `UNIQUE(world_version_id, kind)` holds.
- **Failure means:** the six-rows-for-three-files bug that plate views already paid for once.

### WE-D9.1 — All six flags exist, default off, and are refused when misspelled
- **Scenario:** derived over the flag set.
- **Inputs:** `GET /film/settings`; then `PUT` with `WORLD_ENGIN` (typo).
- **Expected:** all six keys present with `default: false`; the typo is **reported as unknown**, not silently ignored.
- **Failure means:** a feature ships on by default on a live install, or a director sets a flag that reaches nothing.

---

## 3. Phase 1 — the world exists (MVP 1)

Target file: `backend/tests/world-engine.test.js`.

### WE-1.1 — The migration applies and declares exactly what the plan says
- **Scenario:** run migrations on a fresh test database.
- **Inputs:** empty DB.
- **Expected:** the 4 tables exist; `film_previs_blocking` gains `world_version_id` and `world_pinned_at`; `UNIQUE(world_id, version)` and `UNIQUE(world_version_id, kind)` are present.
- **Failure means:** the schema and the plan disagree from day one.
- **Set-based over:** the 4 tables and their declared columns, read from the migration.

### WE-1.2 — A version is never overwritten
- **Scenario:** create a world, then improve it twice.
- **Inputs:** three generations against one world.
- **Expected:** versions 1, 2, 3 all present; `parent_version_id` chains 3→2→1; version 1's assets and bounds are unchanged after 2 and 3 exist.
- **Failure means:** the spec's central promise — *worlds are never overwritten* — is false, and a shot pinned to v1 now renders a different place.
- **Mutation:** make `newVersion` UPDATE instead of INSERT → must fail.

### WE-1.3 — Deleting a world cascades its children
- **Expected:** versions, assets and sources for that world are gone; other worlds untouched.
- **Failure means:** orphan rows accumulate, and an asset points at a version nothing can resolve.

### WE-1.4 — All six Marble asset kinds are ingested
- **Set-based over:** the 6 kinds in the `film_world_assets` CHECK.
- **Inputs:** the real payload shape (collider, pano, thumbnail, spz 100k/500k/full).
- **Expected:** one row per kind; each carries either `asset_id` (copied) or `remote_url` (recorded).
- **Failure means:** an ingest that handles the collider and silently drops the panorama looks like a working ingest.

### WE-1.5 — A draft world with null mesh URLs ingests cleanly
- **Scenario:** `marble-1.0-draft` returns `hq_mesh_url: null` and `full_res_mesh_url: null` — **measured on the real API**.
- **Expected:** ingest succeeds; the absent kinds simply have no row; no null-URL row is written and nothing throws.
- **Failure means:** the cheapest and most-used tier cannot be ingested at all.

### WE-1.6 — All four prompt types build a valid request
- **Set-based over:** the 4 types from the API's own 422 (`text`, `image`, `multi-image`, `video`).
- **Expected:** each produces the documented body shape; `multi-image` carries ordered azimuths and slices to `MAX_INPUT_IMAGES` (4), **reporting what it dropped**.
- **Failure means:** a prompt type that reaches the provider malformed buys a refusal, or images are dropped in silence.

### WE-1.7 — All four models are selectable and an unknown one is refused locally
- **Set-based over:** `worldlabs.MODELS` (4).
- **Expected:** each is accepted; `marble-9` is refused **before** the request is sent, naming the four legal values.
- **Failure means:** a typo costs a round trip and returns a provider error that reads like a credential problem.

### WE-1.8 — The five compass azimuths map as documented
- **Set-based over:** `worldlabs.AZIMUTH` (5, including the view-less default).
- **Expected:** north 0, east 90, south 180, west 270, `''` 0.
- **Failure means:** every world is built facing the wrong way, silently, because every world still generates.

### WE-1.9 — All five calibration sources produce a factor
- **Set-based over:** `CALIBRATION_SOURCES` (5).
- **Inputs:** e.g. `{source: 'character_height', knownMeters: 1.68, measuredUnits: 2.042}`.
- **Expected:** `factor ≈ 0.8227`; stored with its source and both operands so it can be re-derived.
- **Failure means:** a calibration nobody can audit or reproduce.

### WE-1.10 — Calibration refuses degenerate input
- **Inputs:** `measuredUnits` of 0, negative, `NaN`, and absurd (1e9).
- **Expected:** refused with a reason; **not** clamped, and no factor stored.
- **Failure means:** a division by zero becomes `Infinity` metres and every distance on the screen is nonsense.

### WE-1.11 — Geometry applies scale on read, and the stored file never changes
- **Scenario:** read geometry uncalibrated, calibrate, read again.
- **Expected:** the second read's bounds are the first scaled by the factor; the collider file's hash is identical across both.
- **Failure means:** D6 is violated — recalibration corrupts rather than corrects.

### WE-1.12 — The real collider parses and decimates to the stage budget
- **Inputs:** a GLB fixture with more than 20,000 triangles.
- **Expected:** parses via the existing `glb-parser`; `decimate(g, 20000).triangles.length === 20000`; **bounds unchanged** by decimation.
- **Failure means:** placement and scale move with the triangle budget — the property `decimate` deliberately preserves.

### WE-1.13 — A world that cannot be parsed is refused by name
- **Inputs:** a GLB declaring `KHR_draco_mesh_compression`; a truncated file; a non-GLB.
- **Expected:** three distinct, actionable messages — never a generic *invalid GLB*.
- **Failure means:** an unreadable file and a corrupt one are indistinguishable, which is the diagnosis that already cost one import.

### WE-1.14 — Pinning is explicit and never automatic
- **Scenario:** shot pinned to v1; v2 is created.
- **Expected:** the shot still resolves v1; the response *reports* that v2 exists; nothing migrated.
- **Failure means:** a director's approved shot silently re-renders in a world they have not seen — spec §56's central rule.
- **Mutation:** repoint the pin on `newVersion` → must fail.

### WE-1.15 — World lock refuses exactly the right set
- **Set-based over:** the locked/allowed operations in spec §55.
- **Expected:** locked ⇒ regenerate, scale change and base-world replacement are **refused**; creating cameras, editing shots, blocking and generation plates still **succeed**. Unlock is an explicit action.
- **Failure means:** either a lock that protects nothing, or one that freezes the work it was meant to protect and gets switched off.

### WE-1.16 — The plan endpoint is free and prices through the same path as the run
- **Scenario:** call `…/plan`, then generate.
- **Expected:** `plan` resolves no provider and writes no cost entry; its quoted credits equal what the run bills for the same model.
- **Failure means:** the number in the confirmation is not the number charged — the failure every other pre-spend surface here exists to prevent.

### WE-1.17 — A generation abandoned mid-poll is recoverable, not lost
- **Scenario:** provider accepts, then the call is torn down at the timeout.
- **Expected:** result is `pending` with the operation id, **not** `failed`; the job row is collectable; collecting is idempotent and free.
- **Failure means:** a paid world exists at the provider with nowhere to be delivered, reported as a network fault.

### WE-1.18 — `/film/worlds…` is dispatched before the project catch-alls
- **Scenario:** request every one of the 17 routes.
- **Expected:** each reaches its handler; none is swallowed by `/film/projects/:id/*` or `/film/shots/:id/*`.
- **Failure means:** a handler that exists and is never reached looks exactly like a missing feature — the `/film/locations/:id` trap that already cost once.
- **Set-based over:** the 17 routes in `plan.md` §5.

### WE-1.19 — Every phase-1 MCP tool dispatches, and only `world_generate` spends
- **Set-based over:** the 8 phase-1 tools.
- **Expected:** each resolves to a route that dispatches; `world_generate` is named in the guide's *What costs money* section; the other seven are not.
- **Failure means:** a tool that is listed, described and schema'd but dies on dispatch — the `plate_generate` failure, repeated.

### WE-1.20 — The client projection carries the near-vertical fallback
- **Scenario:** project a point with the camera looking straight down.
- **Inputs:** eye `[0, 10, 0]`, target `[0, 0, 0]` — `|forward.y| > 0.999`.
- **Expected:** a finite screen point, matching the server's `previs-pick.projectPoint` for the same inputs.
- **Failure means:** the TOP view preset the design asks for degenerates on the client only, while the server and the client's own inverse both handle it. *(audit §2d)*

### WE-1.21 — `fromCard` persists the camera it solved
- **Scenario:** seed a stage from a card whose azimuth is non-zero.
- **Expected:** the stored `camera_json` carries the solved position **and** rotation; a saved pose in the card survives.
- **Failure means:** the azimuth solve is computed and discarded, and seeding always faces one way. *(audit §2e)*

---

## 4. Phase 2 — the console (MVP 2)

Target file: `backend/tests/world-console.test.js`. Assertions **execute** the
render functions where the markup is built at runtime — a grep reports a working
page as broken and a broken one as working.

### WE-2.1 — All eleven overlays render, toggle independently, and update the count
- **Set-based over:** the 11 overlays, derived from the design table.
- **Expected:** each has a toggle; toggling one changes only that overlay; the button's count equals the number on. Thirds and Horizon default **on**, the other nine off.
- **Failure means:** an overlay that is listed and draws nothing is a control that lies.

### WE-2.2 — All twelve lens buttons set the focal length
- **Set-based over:** the 12 lens values.
- **Expected:** each sets `focalLengthMm` and re-derives FOV through `previs-camera.fieldOfView` — not a lookup table.
- **Failure means:** a lens button that changes the label and not the frame — a control that reports a choice it never made.

### WE-2.3 — Keep Position vs Maintain Size behave oppositely
- **Scenario:** change the lens under each mode.
- **Expected:** *Keep Position* — occupancy tracks the lens (`clamp(round(58 × lens / 18), 14, 88)`) and the camera does not move. *Maintain Size* — occupancy is **pinned at the value in effect when the mode was engaged** and the camera dollies instead.
- **Failure means:** the design records this as wrong in its first pass; getting it wrong again makes the mode meaningless.

### WE-2.4 — Occupancy is computed from geometry, not from the demo formula
- **Scenario:** two subjects of different real sizes at the same distance.
- **Expected:** occupancy comes from the projected bounding box against the delivered frame; the `58 × lens / 18` relation is the *design's demo data*, and must not appear in the shipped calculation.
- **Failure means:** the console shows plausible numbers that describe nothing.

### WE-2.5 — Every panel value is live, not demo data
- **Set-based over:** the design's named demo strings (`Maple Street`, `Maya`, `Dragon`, `Sedan`, `25.7m`, `4.1m`, `WLD-031`).
- **Expected:** none appears in the shipped page.
- **Failure means:** a screenshot-perfect console wired to nothing — the failure the home-page work already caught once.

### WE-2.6 — The frame is the project's aspect
- **Set-based over:** 2.39:1, 1.85:1, 16:9, 4:3.
- **Expected:** the frame element's ratio follows the project setting, not a constant.
- **Failure means:** the board and the footage are different shapes — the aspect mismatch this engine already fixed once at project level.

### WE-2.7 — `GEOMETRIC PLATE — NOT FINAL` is present
- **Expected:** the exact string renders in the frame.
- **Failure means:** the user reads a deliberately ugly geometric render as a failed final image.

### WE-2.8 — Both modals stack above the console
- **Set-based over:** Match Reference and Create Spatial World.
- **Expected:** each is opened through `showModal` and paints above the page (`restackModals` assigns depth).
- **Failure means:** the confirmation-behind-the-sheet bug, repeated on the two modals that gate spending.

### WE-2.9 — Measurements read from the world, not from the card
- **Expected:** camera→subject and subject→subject distances derive from blocking and the calibrated world; uncalibrated ⇒ shown as approximate.
- **Failure means:** a distance that describes the scene card rather than the world, presented with the authority of a measurement.

### WE-2.10 — With the flag off nothing above renders
- **Expected:** the old previs screen, byte-identical (see WE-D4.1).
- **Failure means:** a half-built console is live on a working install, which is what the flag exists to prevent.

---

## 5. Phase 3 — directing (MVP 3)

Target file: `backend/tests/cinematography.test.js`.

### WE-3.1 — All seven intents produce a brief
- **Set-based over:** the 7 intents.
- **Expected:** each yields a brief naming the intent and its **bias description**; none returns camera numbers.
- **Failure means:** the engine encoding the creative rule the model should apply.

### WE-3.2 — All six validation checks reject a crafted candidate
- **Set-based over:** `CHECKS` (6): inside geometry, subject behind camera, clipping, impossible focus, occluded, line crossed.
- **Inputs:** one deliberately invalid camera per check.
- **Expected:** each is rejected, naming *that* check.
- **Failure means:** a validator catching five of six is indistinguishable from one that works, and the sixth ships a camera inside a wall.

### WE-3.3 — A valid camera passes all six
- **Scenario:** a camera that is outside geometry, in front of its subject, focusable and on the correct side of the axis.
- **Expected:** `validateCamera` returns `ok: true` with an empty `failures` array.
- **Failure means:** an over-strict validator rejects every candidate and Explore Shot returns nothing.

### WE-3.4 — `validateProposal` accepts only the eleven declared fields
- **Set-based over:** `PROPOSAL_FIELDS` (11).
- **Expected:** each is accepted; an undeclared field (`worldGeometry`, `wardrobe`, `blocking`) is **refused with its name**.
- **Failure means:** spec §32 — the AI silently changing what it must not touch.

### WE-3.5 — `applyProposal` never mutates its input
- **Expected:** the original camera object is unchanged; a new one is returned.
- **Failure means:** undo becomes impossible, and a rejected proposal has already been applied.

### WE-3.6 — Explore returns six *valid* candidates
- **Expected:** six; each passes all six checks; rejects are regenerated rather than returned; if six valid cannot be produced, the shortfall is **named** rather than padded.
- **Failure means:** a coverage grid containing cameras that cannot be shot.

### WE-3.7 — `sideOfAxis` answers three ways
- **Set-based over:** `A`, `B`, `ON_AXIS`.
- **Expected:** a camera exactly on the axis is `ON_AXIS`, not arbitrarily A or B.
- **Failure means:** the degenerate case is silently assigned a side, and the 180° warning fires or stays quiet at random.

### WE-3.8 — Crossing the line warns and does not block
- **Expected:** a warning naming the prior shot; the save still succeeds unless strict mode is on.
- **Failure means:** a hard block on a legitimate creative choice gets the whole continuity system switched off.

### WE-3.9 — Screen direction reversal is reported against a named shot
- **Expected:** *"reverses Maya's screen direction from 2A"* — the shot is named, not counted.
- **Failure means:** a count sends the director to the database to find out which shot it meant.

### WE-3.10 — Camera compare reports both cameras on the same axes
- **Scenario:** two saved cameras selected for comparison.
- **Set-based over:** the 5 compared axes — lens, height, distance, tilt, occupancy.
- **Expected:** every axis is reported for **both** cameras, computed the same way for each.
- **Failure means:** a comparison where one column is derived differently from the other is worse than no comparison, because the difference reads as the cameras differing.

### WE-3.11 — No module in this phase requires the LLM client
- **Scenario:** derived scan over this phase's modules, following one call level.
- **Expected:** neither `lib/cinematography.js` nor `lib/camera-validate.js` nor the routes reaching them require `lib/llm-client.js`.
- **Failure means:** see WE-D5.1 — **this is the goal's stated rabbit hole, and this phase is where it would be broken.**

### WE-3.12 — The brief/propose pair is reachable over MCP
- **Expected:** `cinematography_brief` and `camera_propose` dispatch; neither spends.
- **Failure means:** the directing layer is reachable only from the page, so the connected model — which is the model here — cannot drive it.

---

## 6. Phase 4 — motion (MVP 4)

Target file: `backend/tests/world-timeline.test.js`.

### WE-4.1 — All four easings plus hold are offered and applied
- **Set-based over:** `EASINGS` (4) + `hold`.
- **Expected:** each is selectable and changes the sampled path.
- **Failure means:** an easing chip that reaches nothing.

### WE-4.2 — The timeline drives the existing model, not a second one
- **Expected:** edits write `moves_json` / `camera_keys_json`; no new movement store is introduced.
- **Failure means:** two answers to *what move does this shot have*.

### WE-4.3 — Authored keys round-trip through the UI unchanged
- **Inputs:** keys authored, saved, reloaded.
- **Expected:** identical times, poses and focal lengths; rotations still stored in degrees.
- **Failure means:** a radian/degree confusion at the boundary silently rewrites every authored move.

### WE-4.4 — The path is drawn and a keyframe click seeks
- **Expected:** the spatial pane draws the sampled path with keyframe markers; clicking one sets the playhead.
- **Failure means:** a move that can be authored and not seen, which is how a wrong path survives to generation.

### WE-4.5 — Play move plays the *interpolated* path
- **Expected:** intermediate positions between keys, not snapping — the fix `previsPose` already records.
- **Failure means:** how densely a path was sampled becomes visible in the shot, which is a storage decision leaking into the film.

### WE-4.6 — Concurrent legs compose deltas
- **Expected:** a dolly-with-pan composes both; it does not chain, which would zoom a camera that had already moved.
- **Failure means:** a dolly-zoom comes out as a different shot than the one staged.

---

## 7. Phase 5 — the generation bridge (MVP 5)

Target file: `backend/tests/generation-plate.test.js`.

### WE-5.1 — The plate reaches the payload through **all four** entry points
- **Set-based over:** the per-domain route, the orchestrator, the flow canvas, and per-shot regenerate.
- **Expected:** each attaches the plate.
- **Failure means:** three paths condition on geometry and one silently does not — the divergence `shot-references.js` was created to end.

### WE-5.2 — Differential: attaching a plate changes what the provider receives
- **Inputs:** the same shot with and without a plate.
- **Expected:** the payloads differ, and the plate is first in the reference list.
- **Failure means:** a plate that is gathered, stored, billed for and never sent — the `image_urls` failure MuAPI already cost.

### WE-5.3 — Relative order of the five existing kinds is unchanged
- **Scenario:** the same shot, with no plate, before and after the kind is added.
- **Expected:** an identical reference list, in an identical order (see WE-D7.1).
- **Failure means:** every project that never renders a plate silently changes what it sends.

### WE-5.4 — The plate is named in the prompt unambiguously
- **Expected:** the prompt names *the first reference image* as the geometric plate, so a provider that cannot read tags still knows which picture it is.
- **Failure means:** on an untaggable provider the model is handed several pictures with no way to tell which one fixes the geometry.

### WE-5.5 — Plate size follows the project aspect and delivery raster
- **Set-based over:** the four plate sizes in spec §46.
- **Expected:** the rendered plate matches the shot's aspect; a vertical shot is rendered vertical, not cropped.
- **Failure means:** a 9:16 deliverable is centre-cropped from a landscape plate, keeping 32% of its width — the loss `native` exists to prevent.

### WE-5.6 — Depth and masks are produced and registered
- **Expected:** each is a separate asset, linked to the plate record.
- **Failure means:** the depth and mask outputs the bridge promises are produced and unreachable.

### WE-5.7 — A plate records the world version and blocking it came from
- **Expected:** `worldVersionId` and a blocking snapshot; a plate whose world version was deleted reports as detached, not stale.
- **Failure means:** a plate that cannot be traced to the geometry that produced it is not reproducible.

### WE-5.8 — The video prompt carries the camera move as prose
- **Expected:** the move is described in words (*"dollies backward 2.4 metres over four seconds while tilting up 13 degrees"*), and the structured path still travels where the provider accepts one.
- **Failure means:** the camera move is staged, approved, and then not asked for — the clip ignores it and it reads as the model failing.

### WE-5.9 — A plate is not fingerprinted as a keyframe
- **Expected:** the plate does not mark the shot's keyframe stale; it is a distinct artefact kind.
- **Failure means:** rendering a plate tells the director every frame is out of date.

### WE-5.10 — Rendering a plate is free
- **Expected:** no provider resolved, no cost entry; it is a local render.
- **Failure means:** the free step that precedes every paid generation quietly becomes billable.

---

## 8. Phase 6 — the remainder

Target file: `backend/tests/reference-match.test.js`.

### WE-6.1 — Match Reference V1 is manual-assist only
- **Expected:** the solve consumes user-marked horizon and subject box; it performs **no** automatic detection and claims none.
- **Failure means:** a confidence number attached to a computation that never ran.

### WE-6.2 — Confidence is always shown with the solve
- **Expected:** every solve carries a confidence; applying it is a deliberate act.
- **Failure means:** an approximation is presented as a measurement and applied without anyone choosing to.

### WE-6.3 — Apply writes only camera fields
- **Set-based over:** the applied set (lens, height, tilt, roll, framing mode, pinned occupancy).
- **Expected:** blocking and world are untouched.
- **Failure means:** a reference match silently restages the scene — spec §32's rule, broken by the feature most likely to break it.

### WE-6.4 — Shot complexity returns one of three grades
- **Set-based over:** LOW / MEDIUM / HIGH, and the seven inputs in spec §49.
- **Expected:** each input changes the grade at some threshold; HIGH carries the split suggestion.
- **Failure means:** an input declared to matter that moves nothing, which is a score nobody should act on.

### WE-6.5 — Every export target produces a file that names its world version
- **Set-based over:** the 7 export outputs in spec §50.
- **Expected:** each is produced and carries the world id and version it came from.
- **Failure means:** an export handed to another department cannot be traced back to the geometry it describes, which makes it unreproducible.

---

## 9. Error paths — spec §60

One case each. **Expected in every case:** a message a director can act on, the
raw provider error logged server-side and never surfaced, and — where money was
spent — the spend still recorded.

| ID | State | What the user must be told |
|---|---|---|
| WE-E1 | World generation failed | which stage, and whether it was billed |
| WE-E2 | Rate limited | that it is temporary, and when to retry |
| WE-E3 | Insufficient credits | the balance and the cost of what was attempted |
| WE-E4 | Upload failed | which file, and the size limit if that was it |
| WE-E5 | Unsupported file | the accepted types, from the API's own `kind` enum |
| WE-E6 | World asset unavailable | which asset, and that the world is still usable without it |
| WE-E7 | Splat load failed | that geometry is unaffected |
| WE-E8 | WebGL unsupported | that the wireframe stage still works |
| WE-E9 | Scale uncalibrated | that distances are approximate, with the way to fix it |
| WE-E10 | Missing collider | that blocking and measurement are unavailable for this version |
| WE-E11 | Camera inside geometry | which surface, and the nearest valid position |
| WE-E12 | Subject outside frame | which subject |
| WE-E13 | Generation plate failed | whether anything was billed |

**Failure means (all thirteen):** the user sees a raw API error and cannot tell
a dead network from an empty account — the *"Backend offline"* misdiagnosis this
codebase has now paid for three separate times.

---

## 10. Regression guards — what must not move

Set-based over the registries listed in §1. Each asserts a count **and** the
membership, because a count alone passes when one item is swapped for another.

| ID | Guard |
|---|---|
| WE-R1 | 18 movements, unchanged ids |
| WE-R2 | 9 rigs, unchanged affordances |
| WE-R3 | 18 shot types across the 3 axes |
| WE-R4 | 6 sensors with their exact mm dimensions and per-sensor CoC |
| WE-R5 | 18 lenses, 10 apertures |
| WE-R6 | 5 primitives |
| WE-R7 | 8 media kinds — a world is **not** one of them |
| WE-R8 | 4 nav groups; `previs` still in `plan` |
| WE-R9 | The 284 existing previs test cases still pass |

---

## 11. Deliberately not tested, and why

Stated so each is a decision rather than a gap.

- **Splat rendering fidelity.** Behind `WORLD_SPLATS` and not built; testing it now would test a stub.
- **Marble reconstruction quality.** The provider's job, not ours. We test that we *send* the right request and *ingest* what comes back.
- **Automatic horizon / vanishing-point detection.** Explicitly V2 in spec §30; V1 is manual-assist, and WE-6.1 asserts it claims nothing more.
- **Absolute world scale correctness.** Marble promises no unit; we test that calibration is applied consistently and that uncalibrated is *reported*, not that a world is truly 39.6 m wide.
- **Rendered-pixel comparison of the console.** No jsdom and no bundler under ADR-002. Layout facts are measured once in a real browser and recorded as numbers; the tests assert the preconditions that make source equivalent to runtime.
- **Photoreal final output.** The image model's job. The bridge tests assert the plate *reaches* the provider and constrains geometry.

---

## 12. Acceptance criteria for the feature

Done, when all of the following hold:

1. All **96** cases pass.
2. Every set-based case derives its denominator from a registry, and **asserts it found a non-empty set** before asserting anything about it.
3. Every decision guard in §2 has been **mutation-proven** — made to fail on the defect it guards, then restored.
4. `node --test backend/tests/*.test.js` introduces **zero** new failures against the pre-existing baseline.
5. With all six flags off, the app is byte-identical to today.
6. The spec's §73 scenario runs end to end: one storyboard image → world → blocking → 18mm at 0.42m → *More heroic* → six alternatives → animate → save → plate → image generation, with perspective, angle, placement and scale preserved.
